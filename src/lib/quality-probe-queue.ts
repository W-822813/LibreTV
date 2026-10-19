import { qualityKey } from './quality';
import type { QualityProbeItem, QualityProbeResult } from './types';

/**
 * 客户端画质探测队列。
 *
 * 为什么需要它：搜索页上「单源卡片」会进入视口即探测，而一屏可能有十几张卡片。
 * 若每张卡各发一次请求，会瞬间把源站与服务端的 per-host 闸门打满
 * （服务端单请求并发 6 + 闸门是给「一次批量」设计的，挡不住 N 个请求同时涌入）。
 *
 * 策略：
 * - 同 key（源 + 影片）只跑一次，重复入队共享同一个结果 Promise；
 * - 50ms 合并窗口：同一批渲染周期入队的条目合成一个请求，减少往返；
 * - 最多 2 个请求在飞、每批最多 8 条：既能让首屏先亮，又不会形成请求风暴；
 * - 单个批次失败只影响该批条目，队列继续工作；
 * - 服务端提前关流时，未回结果的条目按「已取消」收尾，调用方不会永远挂起；
 * - 看门狗：单批超过 timeoutMs 无结果即按「探测超时」收尾并释放槽位，
 *   避免服务端挂起把 2 个并发槽永久占死（队列是全局单例，占死等于全站停摆）；
 * - onStart 在批次真正发出时回调：调用方据此显示的「探测中」不会在排队期间说谎。
 */

export interface ProbeQueueDeps {
  /** 执行一批探测（流式回调逐条结果）；由调用方注入，便于单测与复用 */
  run: (
    items: QualityProbeItem[],
    onResult: (result: QualityProbeResult) => void,
    signal: AbortSignal
  ) => Promise<void>;
  /** 同时进行的请求数，默认 2 */
  concurrency?: number;
  /** 单请求条目上限，默认 8 */
  batchSize?: number;
  /** 入队合并窗口（ms），默认 50 */
  coalesceMs?: number;
  /**
   * 单批看门狗（ms），默认 60_000。
   * 服务端每条目有 8s 死线，正常批次远快于此；但若服务端崩溃导致流挂起，
   * fetch 会一直 pending——队列只有 2 个槽位，一个挂起就废掉一半运力，
   * 两个挂起则全站单源探测停摆。超时后按「探测超时」收尾并释放槽位。
   */
  timeoutMs?: number;
}

export interface ProbeQueue {
  /**
   * 入队并等待这批键的结果（已完成的键不会被重复探测）。
   * `onStart` 在批次真正发出时回调一次，而不是入队瞬间——
   * 调用方据此显示「探测中」才准确：排队等待期间不该谎称正在探测。
   */
  push(items: QualityProbeItem[], onStart?: () => void): Promise<Record<string, QualityProbeResult>>;
  /** 放弃尚未发出的键；在飞的请求无法单独中止，其结果会被丢弃 */
  cancel(keys: string[]): void;
}

/** 已取消 / 未回结果时的占位结论：让 UI 走「未探到」而不是一直转圈 */
const cancelled = (item: QualityProbeItem): QualityProbeResult => ({
  sourceKey: item.source.key,
  vodId: item.id,
  error: '探测已取消',
});

export function createProbeQueue(deps: ProbeQueueDeps): ProbeQueue {
  const concurrency = Math.max(1, deps.concurrency ?? 2);
  const batchSize = Math.max(1, deps.batchSize ?? 8);
  const coalesceMs = Math.max(0, deps.coalesceMs ?? 50);
  const timeoutMs = Math.max(1_000, deps.timeoutMs ?? 60_000);

  /** 待发条目（key → item） */
  const pending = new Map<string, QualityProbeItem>();
  /** 在飞或已入队条目的归属信息：取消时要靠它构造结果 */
  const known = new Map<string, QualityProbeItem>();
  /** key → 等待结果的回调（重复入队共享） */
  const waiters = new Map<string, Array<(result: QualityProbeResult) => void>>();
  /** key → 批次发出时的回调（同一个 push 的多个键共用同一个回调；多方可共享同一次探测） */
  const startHooks = new Map<string, Array<() => void>>();

  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controllers = new Set<AbortController>();

  const settle = (key: string, result: QualityProbeResult) => {
    known.delete(key);
    startHooks.delete(key);
    const list = waiters.get(key);
    if (!list) return; // 被取消或已收尾：结果丢弃
    waiters.delete(key);
    for (const resolve of list) resolve(result);
  };

  const dispatch = () => {
    timer = null;
    while (active < concurrency && pending.size > 0) {
      const entries = [...pending.entries()].slice(0, batchSize);
      for (const [key] of entries) pending.delete(key);
      const items = entries.map(([, item]) => item);
      const keys = entries.map(([key]) => key);

      // 一个 push 的多个键共用同一个 onStart：去重后只回调一次；
      // 同一个键被两处同时入队时，两边的 onStart 都要通知到
      const hooks = new Set<() => void>();
      for (const key of keys) {
        const list = startHooks.get(key);
        if (!list) continue;
        startHooks.delete(key);
        for (const hook of list) hooks.add(hook);
      }
      for (const hook of hooks) hook();

      const controller = new AbortController();
      controllers.add(controller);
      active += 1;
      void (async () => {
        const answered = new Set<string>();
        try {
          const runPromise = deps.run(
            items,
            (result) => {
              answered.add(qualityKey(result.sourceKey, result.vodId));
              settle(qualityKey(result.sourceKey, result.vodId), result);
            },
            controller.signal
          );
          // 看门狗先于 run 结束时，run 还在后台跑：提前挂上 catch，避免 unhandled rejection
          runPromise.catch(() => {});
          let watchdog: ReturnType<typeof setTimeout> | null = null;
          try {
            await Promise.race([
              runPromise,
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(() => reject(new Error('探测超时')), timeoutMs);
              }),
            ]);
          } finally {
            if (watchdog !== null) clearTimeout(watchdog);
          }
          // 服务端提前关流 / 条目被过滤：没回结果的必须收尾，否则调用方永远 pending
          for (const [index, key] of keys.entries()) {
            if (answered.has(key)) continue;
            settle(key, { ...cancelled(items[index]) });
          }
        } catch (err) {
          const message = err instanceof Error && err.message === '探测超时' ? '探测超时' : '探测失败';
          for (const [index, key] of keys.entries()) {
            if (answered.has(key)) continue;
            settle(key, {
              sourceKey: items[index].source.key,
              vodId: items[index].id,
              error: message,
            });
          }
        } finally {
          controllers.delete(controller);
          active -= 1;
          if (pending.size > 0) schedule();
        }
      })();
    }
  };

  const schedule = () => {
    if (timer !== null) return;
    // 合并窗口：同一轮渲染里多张卡片入队 → 一个请求带走，省往返也省服务端闸门
    timer = setTimeout(dispatch, coalesceMs);
  };

  const waitFor = (key: string): Promise<QualityProbeResult> =>
    new Promise((resolve) => {
      const list = waiters.get(key);
      if (list) list.push(resolve);
      else waiters.set(key, [resolve]);
    });

  return {
    push(items, onStart) {
      const unique = new Map<string, QualityProbeItem>();
      for (const item of items) {
        const key = qualityKey(item.source.key, item.id);
        if (!unique.has(key)) unique.set(key, item);
      }

      const waits: Array<Promise<QualityProbeResult>> = [];
      for (const [key, item] of unique) {
        waits.push(waitFor(key));
        if (onStart) {
          const hooks = startHooks.get(key);
          if (hooks) hooks.push(onStart);
          else startHooks.set(key, [onStart]);
        }
        // 已在队列或在飞：只挂等待，不重复发请求
        if (pending.has(key) || known.has(key)) continue;
        pending.set(key, item);
        known.set(key, item);
      }
      if (pending.size > 0) schedule();

      return Promise.all(waits).then((results) => {
        const out: Record<string, QualityProbeResult> = {};
        for (const result of results) out[qualityKey(result.sourceKey, result.vodId)] = result;
        return out;
      });
    },

    cancel(keys) {
      for (const key of keys) {
        const item = known.get(key);
        pending.delete(key);
        startHooks.delete(key);
        if (!item) continue;
        settle(key, cancelled(item));
      }
    },
  };
}
