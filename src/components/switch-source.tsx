'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SourceConfig, SearchResultItem } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { qualityKey, qualityLabel } from '@/lib/quality';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';

/**
 * 换源面板：跨源按标题搜索 → 匹配同名/同前缀资源 → 并发测速（详情接口耗时）→ 按速度排序展示。
 * 切换时保留当前集数索引（旧版 switchToResource 逻辑的去 DOM 化重写）。
 */

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  ok?: boolean;
  episodes?: number;
  /** 测速失败原因：失败源点开后至少能知道是超时、还是源站直接拒绝 */
  error?: string;
}

/** 候选条目的稳定标识：选中态必须绑它，绑数组下标会在测速结果重排后指错源 */
const candidateKey = (c: Candidate) => `${c.source.key}_${c.result.vodId}`;

const isCurrentCandidate = (c: Candidate, sourceKey: string, vodId: string) =>
  c.source.key === sourceKey && String(c.result.vodId) === String(vodId);

export function SwitchSourceModal({
  currentTitle,
  currentSourceKey,
  currentVodId,
  currentIndex,
  onClose,
}: {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'testing' | 'done'>('searching');
  /** 封面加载失败记录（按卡片 key）；失败后降级为占位图标，避免破图 */
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  /** 当前选中的候选：存稳定 key 而不是下标，测速重排后仍然指向同一个源 */
  const [selectedKey, setSelectedKey] = useState('');
  /** 正在单独重测的候选 key：失败源给一次重试机会，失败原因不能只是死路 */
  const [retestingKey, setRetestingKey] = useState('');
  /** 重测的在途请求：换片重搜/关闭面板时中止，避免卸载后 setState */
  const retestAbortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  /** Tab 栏左右是否还有内容：没有渐隐提示，用户不知道右边还藏着源 */
  const [tabEdges, setTabEdges] = useState({ left: false, right: false });

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(true, panelRef);

  const sources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索/测速与 React key 撞车
    const seen = new Set<string>();
    return store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => {
        if (!s || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [store]);

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动；Esc 关闭（与其它弹窗一致）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 关闭弹窗时中止在途请求：否则 N 个源的搜索 + N 个详情测速会继续占用网络与后端
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      // 1) 并行搜索所有选中源
      setPhase('searching');
      try {
        const { list } = await api.search(currentTitle, sources, store.yellowFilter, { signal: controller.signal });
        if (cancelled) return;

        // 匹配口径：优先完全同名，其次名称以标题开头（兼容「小偷 HD」「小偷[电影解说]」这类修饰名）。
        // 都没有则不展示该源——不再兜底取搜索第一条，避免把搜到的其他影片（如搜「小偷」
        // 命中的《宝贝 小偷与大盗》）误当成换源目标。
        const title = currentTitle.trim();
        const matched: Candidate[] = [];
        for (const s of sources) {
          const hits = list.filter((r) => r.sourceKey === s.key);
          const exact =
            hits.find((r) => (r.name || '').trim() === title) ??
            hits.find((r) => (r.name || '').trim().startsWith(title));
          if (exact) matched.push({ source: s, result: exact });
        }

        // 2) 并发测速（详情接口耗时）并获取集数
        setPhase('testing');
        await Promise.all(
          matched.map(async (c) => {
            const r = await api.detailSpeed(c.result.vodId, c.source, controller.signal);
            if (cancelled) return;
            c.ok = r.ok;
            c.ms = r.ms;
            c.episodes = r.detail?.episodes.length ?? 0;
            c.error = r.ok ? undefined : r.error;
          })
        );
        if (cancelled) return;
        setCandidates(matched);
        setPhase('done');
      } catch (err) {
        // 主动中止不算失败，不提示
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (!cancelled && !aborted) {
          toast(err instanceof Error ? err.message : '换源搜索失败', 'error');
          setPhase('done');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // 换片重搜 / 关闭面板时，单独发起的重测也要跟着停
      retestAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle, store.yellowFilter]);

  const { qualities, probing, progress, probe, retry } = useQualityProbe(sources);

  // 测速完成后补探画质：用户正是在这里比较来源，「快」和「清楚」要能一起看。
  // 只探测速成功的候选——详情接口都打不通的源，再花 8s 探 m3u8 没有意义。
  useEffect(() => {
    if (phase !== 'done') return;
    const targets = candidates.filter((c) => c.ok).map((c) => c.result);
    if (targets.length > 0) probe(targets);
  }, [phase, candidates, probe]);

  const sorted = useMemo(() => [...candidates].sort((a, b) => {
    const aCurrent = isCurrentCandidate(a, currentSourceKey, currentVodId);
    const bCurrent = isCurrentCandidate(b, currentSourceKey, currentVodId);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const msA = a.ok ? a.ms ?? 99_999 : 99_999;
    const msB = b.ok ? b.ms ?? 99_999 : 99_999;
    return msA - msB;
  }), [candidates, currentSourceKey, currentVodId]);

  /**
   * 面板展示的源：优先用户点过的那个；还没点过时先落到「第一个可切换的源」——
   * 打开面板的目的就是换源，默认停在「当前播放中」等于让用户多点一次。
   */
  const selected =
    sorted.find((c) => candidateKey(c) === selectedKey) ??
    sorted.find((c) => !isCurrentCandidate(c, currentSourceKey, currentVodId) && c.ok) ??
    sorted[0];
  const selectedCandidateKey = selected ? candidateKey(selected) : '';

  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const update = () =>
      setTabEdges({
        left: el.scrollLeft > 4,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [sorted.length]);

  // 默认选中项常落在可视区外：滚进视野，否则高亮等于不存在
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    const active = bar.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    bar.scrollTo({ left: active.offsetLeft - (bar.clientWidth - active.clientWidth) / 2, behavior: 'smooth' });
  }, [selectedCandidateKey]);

  const retest = async (c: Candidate) => {
    const key = candidateKey(c);
    setRetestingKey(key);
    retestAbortRef.current?.abort();
    const controller = new AbortController();
    retestAbortRef.current = controller;
    try {
      const r = await api.detailSpeed(c.result.vodId, c.source, controller.signal);
      if (controller.signal.aborted) return;
      setCandidates((prev) =>
        prev.map((x) =>
          candidateKey(x) === key
            ? { ...x, ok: r.ok, ms: r.ms, episodes: r.detail?.episodes.length ?? 0, error: r.ok ? undefined : r.error }
            : x
        )
      );
      // 重测成功说明源只是刚才抖了一下：强制补一次画质，否则会撞上失败冷却（2 分钟内不再探）
      if (r.ok) retry([c.result]);
    } finally {
      if (retestAbortRef.current === controller) {
        retestAbortRef.current = null;
        setRetestingKey('');
      }
    }
  };

  const switchTo = (c: Candidate) => {
    if (!c.episodes) {
      toast('该源无可用播放资源', 'warning');
      return;
    }
    const targetIndex = currentIndex < c.episodes ? currentIndex : 0;
    onClose(); // 先关闭面板，避免路由参数变化后弹窗残留旧数据
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || currentTitle,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center bg-black/80 sm:py-10 sm:px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-t-2xl sm:rounded-xl w-full max-w-3xl shadow-2xl p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))] sm:pb-5 max-h-[92vh] sm:max-h-[85vh] flex flex-col overflow-hidden animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`换源：${currentTitle}`}
      >
        <div className="sm:hidden mx-auto mb-3 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />
        {/* 标题固定在滚动区之外：比 sticky 更省事，也不会有背景覆盖不到 padding 的缝隙 */}
        <div className="shrink-0 mb-4 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>
              {currentTitle}
            </h2>
            <p className="text-xs text-faint">
              {phase === 'searching'
                ? '正在搜索各资源...'
                : phase === 'testing'
                  ? '正在测试各资源速率...'
                  : `共 ${sorted.length} 个来源 · ${sorted.filter((c) => c.ok).length} 个可用`}
            </p>
            {phase === 'done' && progress.total > 0 && (
              <p className="text-xs text-faint tabular-nums mt-0.5">
                {progress.done < progress.total
                  ? `画质探测中 ${progress.done}/${progress.total}`
                  : progress.known > 0
                    ? `画质已探到 ${progress.known}/${progress.total}`
                    : // 一个都没探到不等于失败：多为单码率/直链，说清楚省得用户以为坏了
                      '源站未提供画质'}
              </p>
            )}
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容区独占剩余高度并自己滚动：标题与拖拽条始终可见，不随内容滚走 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {phase !== 'done' ? (
          <LoadingState label={phase === 'searching' ? '搜索各资源中...' : '测速中...'} />
        ) : sorted.length === 0 ? (
          <EmptyState variant="plain" title="其他点播源未找到同名资源" />
        ) : (
          <>
            {/* 横向 Tab：源多时比网格省纵向空间，手机上可直接滑动 */}
            <div className="relative">
              <div
                ref={tabBarRef}
                className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin"
                role="tablist"
                aria-label="选择播放源"
              >
                {sorted.map((c) => {
                  const isCurrent = isCurrentCandidate(c, currentSourceKey, currentVodId);
                  const key = candidateKey(c);
                  const active = selected === c;
                  const qLabel = qualityLabel(qualities[qualityKey(c.source.key, c.result.vodId)]?.height);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      data-active={active}
                      aria-selected={active}
                      className={cn(
                        'shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                        active ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-chip text-muted hover:bg-hover'
                      )}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="max-w-[8rem] truncate font-medium">{c.source.name}</span>
                      {isCurrent && <span className="text-[10px] opacity-80">当前</span>}
                      {qLabel && <span className="text-[10px] tabular-nums opacity-70">{qLabel}</span>}
                      {c.ok ? (
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            (c.ms ?? 0) > 2000 ? 'bg-warning-solid' : 'bg-success-solid'
                          )}
                          title={`${c.ms}ms`}
                        />
                      ) : (
                        <span className="text-[10px] text-danger">失败</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* 左右渐隐：提示这一栏还能横向滑 */}
              {tabEdges.left && (
                <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-raised to-transparent" />
              )}
              {tabEdges.right && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-raised to-transparent" />
              )}
            </div>

            {/* 选中源详情：封面降到缩略图，只留速度/集数两项真正要比的数据 */}
            {selected && (() => {
              const c = selected;
              const isCurrent = isCurrentCandidate(c, currentSourceKey, currentVodId);
              const key = candidateKey(c);
              const coverFailed = imgFailed[key] ?? false;
              const qKey = qualityKey(c.source.key, c.result.vodId);
              return (
                <div className="mt-3 flex items-start gap-3 p-3 bg-card rounded-lg">
                  <div className="shrink-0 w-20 aspect-[2/3] rounded-md overflow-hidden bg-chip">
                    {c.result.pic && !coverFailed ? (
                      <SmartImage
                        url={c.result.pic}
                        mode={store.imageProxyMode}
                        customProxy={store.customImageProxy}
                        alt={c.result.name}
                        className="w-full h-full object-cover"
                        onExhausted={() => setImgFailed((prev) => ({ ...prev, [key]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint">
                        <Icon name="link" className="w-5 h-5" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-semibold text-content truncate" title={c.source.name}>
                        {c.source.name}
                      </h3>
                      <QualityBadge entry={qualities[qKey]} loading={probing[qKey]} onRetry={() => retry([c.result])} />
                      {isCurrent && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">播放中</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:max-w-[16rem]">
                      <div className="rounded-md bg-chip px-2 py-1.5">
                        <div className="text-[10px] text-faint">速度</div>
                        <div
                          className={cn(
                            'text-xs font-medium tabular-nums',
                            !c.ok ? 'text-danger' : (c.ms ?? 0) > 2000 ? 'text-warning' : 'text-success'
                          )}
                        >
                          {c.ok ? `${c.ms}ms` : '不可用'}
                        </div>
                      </div>
                      <div className="rounded-md bg-chip px-2 py-1.5">
                        <div className="text-[10px] text-faint">集数</div>
                        <div className="text-xs font-medium text-content">
                          {c.episodes ? `${c.episodes} 集` : '无资源'}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {isCurrent ? (
                        <span className="text-xs text-accent">当前正在播放</span>
                      ) : (
                        <>
                          <button type="button" className="btn-primary btn-sm" disabled={!c.episodes} onClick={() => switchTo(c)}>
                            切换到此源
                          </button>
                          {/* 测速失败但拿得到集数：允许点。详情接口偶发超时很常见，别把能播的源挡在外面 */}
                          {!c.ok && !!c.episodes && <span className="text-xs text-warning">测速未通过，仍可尝试</span>}
                        </>
                      )}
                      {!c.ok && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={retestingKey === key}
                          onClick={() => void retest(c)}
                        >
                          {retestingKey === key ? '重测中...' : '重新测速'}
                        </button>
                      )}
                    </div>
                    {!c.ok && c.error && (
                      <p className="mt-1 text-[11px] text-faint line-clamp-1" title={c.error}>
                        {c.error}
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
