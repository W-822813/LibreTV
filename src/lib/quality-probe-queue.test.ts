import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProbeQueue } from './quality-probe-queue';
import type { QualityProbeItem, QualityProbeResult, SourceConfig } from './types';

const source = (key: string): SourceConfig => ({ key, name: key, url: `https://${key}.example.com/api.php/provide/vod` });

const items = (count: number): QualityProbeItem[] =>
  Array.from({ length: count }, (_, i) => ({ source: source('s1'), id: `vod-${i}` }));

type RunArgs = [QualityProbeItem[], (result: QualityProbeResult) => void, AbortSignal];

/** 手动控制批次完成时机，便于观察并发窗口 */
function manualRun() {
  const calls: QualityProbeItem[][] = [];
  const gates: Array<() => void> = [];
  const rejects: Array<(reason: string) => void> = [];
  const run = vi.fn((...args: RunArgs) => {
    const [batch, onResult] = args;
    calls.push(batch);
    return new Promise<void>((resolve, reject) => {
      gates.push(() => {
        for (const item of batch) {
          onResult({ sourceKey: item.source.key, vodId: item.id, height: 1080 });
        }
        resolve();
      });
      rejects.push((reason) => reject(new Error(reason)));
    });
  });
  return { run, calls, gates, rejects };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createProbeQueue', () => {
  it('同时在飞不超过 concurrency，单批不超过 batchSize', async () => {
    const { run, calls, gates } = manualRun();
    const queue = createProbeQueue({ run, concurrency: 2, batchSize: 8, coalesceMs: 50 });

    const done = queue.push(items(20));
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(2); // 只放了 2 个请求出去
    expect(calls[0]).toHaveLength(8); // 批大小封顶
    expect(calls[1]).toHaveLength(8);

    gates.forEach((gate) => gate());
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(3); // 剩余 4 条合成最后一批
    expect(calls[2]).toHaveLength(4);

    gates.forEach((gate) => gate());
    await expect(done).resolves.toMatchObject({ 's1:vod-0': { height: 1080 } });
  });

  it('同 key 重复入队只发一次请求，双方共享结果', async () => {
    const { run, calls, gates } = manualRun();
    const queue = createProbeQueue({ run, coalesceMs: 50 });
    const [item] = items(1);

    const first = queue.push([item]);
    const second = queue.push([{ ...item }]);
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);

    gates[0]();
    await expect(first).resolves.toEqual({ 's1:vod-0': { sourceKey: 's1', vodId: 'vod-0', height: 1080 } });
    await expect(second).resolves.toEqual({ 's1:vod-0': { sourceKey: 's1', vodId: 'vod-0', height: 1080 } });
  });

  it('单批失败只影响该批，队列继续工作', async () => {
    const { run, calls, gates, rejects } = manualRun();
    const queue = createProbeQueue({ run, concurrency: 1, batchSize: 2, coalesceMs: 50 });

    const failing = queue.push(items(2));
    await vi.advanceTimersByTimeAsync(50);
    rejects[0]('boom');

    await expect(failing).resolves.toMatchObject({
      's1:vod-0': { error: '探测失败' },
      's1:vod-1': { error: '探测失败' },
    });

    const next = queue.push([{ source: source('s2'), id: 'other' }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(2); // 队列没被前一批的异常卡死
    gates[1]();
    await expect(next).resolves.toMatchObject({ 's2:other': { height: 1080 } });
  });

  it('服务端提前关流（未回结果）也收尾，调用方不会一直挂起', async () => {
    const run = vi.fn(async () => {
      /* 直接 resolve，不回调任何结果：模拟服务端中途断流 */
    });
    const queue = createProbeQueue({ run, coalesceMs: 50 });

    const done = queue.push(items(2));
    await vi.advanceTimersByTimeAsync(50);

    await expect(done).resolves.toMatchObject({
      's1:vod-0': { error: '探测已取消' },
      's1:vod-1': { error: '探测已取消' },
    });
  });

  it('cancel 对尚未发出的键生效：立即返回取消结论且不发请求', async () => {
    const { run } = manualRun();
    const queue = createProbeQueue({ run, coalesceMs: 50 });

    const done = queue.push(items(1));
    queue.cancel(['s1:vod-0']);

    await expect(done).resolves.toMatchObject({ 's1:vod-0': { error: '探测已取消' } });
    await vi.advanceTimersByTimeAsync(60);
    expect(run).not.toHaveBeenCalled();
  });

  it('看门狗：批次挂起时按「探测超时」收尾并释放并发槽位', async () => {
    // 永不 resolve 的 run：模拟服务端崩溃导致 NDJSON 流挂起
    const run = vi.fn(() => new Promise<void>(() => {}));
    // timeoutMs 有 1s 下限（防误配 0），测试用最小值
    const queue = createProbeQueue({ run, concurrency: 1, timeoutMs: 1_000, coalesceMs: 50 });

    const first = queue.push(items(1));
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(first).resolves.toMatchObject({ 's1:vod-0': { error: '探测超时' } });

    // 槽位已释放：新批次能正常调度（否则整个队列永久停摆）
    const second = queue.push([{ source: source('s1'), id: 'vod-9' }]);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toMatchObject({ 's1:vod-9': { error: '探测超时' } });
  });

  it('onStart 只在批次真正发出时回调一次，排队期间不回调', async () => {
    const { run, gates } = manualRun();
    const queue = createProbeQueue({ run, coalesceMs: 50 });
    const onStart = vi.fn();

    const done = queue.push(items(3), onStart);
    expect(onStart).not.toHaveBeenCalled(); // 入队即回调会让 UI 谎称「探测中」

    await vi.advanceTimersByTimeAsync(50);
    expect(onStart).toHaveBeenCalledTimes(1); // 三个键共用一个回调，只触发一次

    gates[0]();
    await expect(done).resolves.toMatchObject({ 's1:vod-0': { height: 1080 } });
  });

  it('同一键被两处入队：两边的 onStart 都通知，但只发一次请求', async () => {
    const { run, calls, gates } = manualRun();
    const queue = createProbeQueue({ run, coalesceMs: 50 });
    const first = vi.fn();
    const second = vi.fn();

    const a = queue.push(items(1), first);
    const b = queue.push(items(1), second);
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    gates[0]();
    await Promise.all([a, b]);
  });

  it('批次发出前被 cancel：onStart 不会回调', async () => {
    const { run } = manualRun();
    const queue = createProbeQueue({ run, coalesceMs: 50 });
    const onStart = vi.fn();

    const done = queue.push(items(1), onStart);
    queue.cancel(['s1:vod-0']);
    await vi.advanceTimersByTimeAsync(60);

    expect(onStart).not.toHaveBeenCalled();
    await expect(done).resolves.toMatchObject({ 's1:vod-0': { error: '探测已取消' } });
  });

  it('空入队不产生请求', async () => {
    const run = vi.fn(async () => {});
    const queue = createProbeQueue({ run, coalesceMs: 50 });

    await expect(queue.push([])).resolves.toEqual({});
    await vi.advanceTimersByTimeAsync(60);
    expect(run).not.toHaveBeenCalled();
  });
});
