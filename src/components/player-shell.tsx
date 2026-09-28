'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 */

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onRequestSwitchSource,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 持有最新回调，避免重建播放器
  const cbs = useRef({ onTimeUpdate, onEnded, onPause, getRestorePosition, onRequestSwitchSource });
  cbs.current = { onTimeUpdate, onEnded, onPause, getRestorePosition, onRequestSwitchSource };
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setShowPoster(true);

    // 换集时清理函数在「新回调已挂到 ref 上」之后才执行，
    // 卸载前保存进度必须用本次挂载（本集）的回调，否则会把上一集的
    // 播放位置写进新集数的进度记录，导致换集后从上一集的时间点继续播放
    const mountCbs = { onTimeUpdate, onEnded, onPause, getRestorePosition };

    let lastSave = 0;
    let lastPrefetchEnsure = 0;
    let playbackStarted = false;
    let ended = false;
    // 本集的恢复策略实例：跨直连/代理两级重建共享计数，换集随 effect 重建
    const recovery = new PlaybackRecovery();

    const showHint = (text: string) => {
      setHint(text);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setHint(''), 2500);
    };

    // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!episodeKey;
    const hlsConfig: Partial<HlsConfig> = {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: adFilter }) as unknown as HlsConfig['loader'],
    };

    /**
     * 初始化 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
     * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
     */
    // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
    const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
      if (!episodeKey) return;
      getVideoPrefetcher().ensure({
        m3u8Url: mediaUrl,
        currentTime,
        episodeKey,
        horizonSeconds,
        onProgress: (stats) => {
          // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
          if (stats.state === 'done' && nextUrl && nextEpisodeKey) {
            getNextEpisodePrefetcher().ensure({
              m3u8Url: nextUrl,
              currentTime: 0,
              episodeKey: nextEpisodeKey,
              horizonSeconds: 420,
            });
          }
        },
      });
    };

    const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
      hlsRef.current?.destroy();
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;

      hls.loadSource(mediaUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        recovery.markHealthy();
        video.play().catch(() => {});
      });
      // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
      hls.on(Hls.Events.FRAG_LOADED, () => recovery.markHealthy());

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        const decision = recovery.onFatal(data.type, data.details);
        switch (decision.action) {
          case 'ignore':
            break;
          case 'retry': {
            // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
            // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
            if (
              allowProxyFallback &&
              !mediaUrl.startsWith('/api/proxy') &&
              (decision.attempt >= 2 || data.details === 'manifestLoadError')
            ) {
              showHint('直连失败，改用代理重试...');
              setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
              return;
            }
            showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
            recovery.schedule(decision.delayMs, () => hls.startLoad());
            break;
          }
          case 'recover-media': {
            showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
            if (decision.swapAudio) hls.swapAudioCodec?.();
            hls.recoverMediaError();
            break;
          }
          case 'switch-source': {
            // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
            // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
            const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
            if (playbackStarted) {
              showHint(message);
              cbs.current.onRequestSwitchSource?.(decision.reason);
            } else {
              setError(`视频加载失败，${message}，请尝试其他视频源`);
            }
            break;
          }
        }
      });
    };

    const art = new Artplayer({
      container: containerRef.current,
      url,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;
    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = title;
      } catch { /* 忽略 */ }
    });

    art.on('ready', () => {
      // 进度恢复
      const restore = async () => {
        const saved = (await cbs.current.getRestorePosition?.()) ?? 0;
        const duration = art.duration || 0;
        if (saved > 10 && duration > 0 && saved < duration - 2) {
          art.currentTime = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
      };
      restore();
    });

    art.on('video:playing', () => {
      playbackStarted = true;
      setShowPoster(false);
      setError('');
    });
    art.on('video:error', () => {
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        cbs.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsure > 30_000) {
        lastPrefetchEnsure = now;
        ensurePrefetch(url, art.currentTime);
      }
    });
    art.on('video:seeked', () => {
      ensurePrefetch(url, art.currentTime);
    });
    art.on('video:pause', () => {
      cbs.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      ensurePrefetch(url, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
      ended = true;
      cbs.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
        e.preventDefault();
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });

    // 双击全屏由 ArtPlayer 原生 DBCLICK_FULLSCREEN 处理（video:dblclick 不在其事件代理列表中，监听无效）

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        cbs.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 注意用 mountCbs（本集回调）而非 cbs.current（已是下一集的回调）；
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!ended) {
        try {
          mountCbs.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recovery.dispose();
      getVideoPrefetcher().stop();
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}
    </div>
  );
}
