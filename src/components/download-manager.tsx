'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { detectSavingCapability, pickSaveTarget } from '@/lib/download-saver';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 并发：全局最多同时进行 3 个任务，其余排队（waiting）；
 * - 断点：已下载分片写入 Cache Storage（网络层断点）；
 *   保存目标（FS Access / 内存）活不过页面刷新，恢复时由用户点击「继续」重新选择。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
  /** 恢复后需要用户重选保存位置时置 false */
  hasTarget: boolean;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'fs-access' | 'memory'>('memory');
  const running = useRef(new Map<string, RunningHandle>());

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  // —— 任务启动：选目标 → runDownloadJob ——
  const startTask = useCallback(
    async (entry: DownloadTaskEntry, hasTarget: boolean) => {
      if (running.current.has(entry.id)) return;
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause, hasTarget });
      await updateEntry(entry.id, { status: 'downloading' });

      const onProgress = (p: DownloadProgress) => {
        void updateEntry(entry.id, {
          finished: p.current,
          total: p.total,
          status: p.status === 'done' ? 'completed' : p.status === 'error' ? 'error' : 'downloading',
        });
      };

      const job = runDownloadJob({
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: abort.signal,
        pause,
        onProgress,
        // hasTarget=false（刷新恢复/排队恢复）时目标已在手势内由「继续」按钮选好
        target: (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget?.id === entry.id
          ? (globalThis as unknown as { __dlSaveTarget: { target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget.target
          : {
              // 目标已失效（页面刷新后句柄消亡）：显式报错引导用户点「继续」重选，
              // 绝不能静默空写——否则任务会显示完成却产出空文件
              kind: 'memory',
              write: async () => {
                throw new Error('保存位置已失效，请点击「继续」重新选择');
              },
              close: async () => {},
              abort: async () => {},
            },
      });

      void job
        .then(async () => {
          await updateEntry(entry.id, { status: 'completed' });
          void clearDownloadChunks(entry.id);
          toast(`《${entry.title}》下载完成`, 'success');
        })
        .catch(async (err: Error) => {
          if (abort.signal.aborted) return; // 用户取消：状态已在取消处理里写好
          await updateEntry(entry.id, { status: 'error' });
          toast(`《${entry.title}》下载失败：${err.message}`, 'error');
        })
        .finally(() => {
          running.current.delete(entry.id);
          scheduleNext();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, updateEntry]
  );

  // —— 全局并发调度 ——
  const scheduleNext = useCallback(() => {
    void (async () => {
      const runningCount = running.current.size;
      if (runningCount >= MAX_CONCURRENT_DOWNLOADS) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      const waiting = all.filter((t) => t.status === 'waiting' && !running.current.has(t.id));
      for (const t of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        const entry = t;
        // 队列恢复的任务没有保存目标：以内存目标启动（分片已在本地，写出快）
        void startTask(
          { ...entry, format: entry.format },
          (globalThis as { __dlSaveTarget?: { id: string } }).__dlSaveTarget?.id === entry.id
        );
      }
    })();
  }, [startTask]);

  // —— 事件：新增任务（用户手势内触发，可安全弹文件选择器） ——
  // 监听器必须常驻：播放页「下载本集」在抽屉关闭时也会派发事件，
  // 若仅 isOpen 时注册，事件会凭空丢失——toast 提示了入队，实际什么都没发生
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          status: 'waiting',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // 用户手势内预选保存目标（FS Access 弹窗必须在手势内）
        try {
          const target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
          (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget = {
            id,
            target,
          };
        } catch (err) {
          if (err instanceof Error && err.message.includes('取消')) {
            toast('已取消下载', 'info');
            return;
          }
        }
        await db.downloads.put(entry);
        refresh();
        scheduleNext();
        toast(`《${detail.title}》已加入下载队列`, 'success');
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
    };
  }, [refresh, scheduleNext, toast]);

  // 抽屉打开时：刷新保存能力与任务列表，并启动排队中的任务
  useEffect(() => {
    if (!isOpen) return;
    setCapability(detectSavingCapability());
    refresh();
    scheduleNext();
  }, [isOpen, refresh, scheduleNext]);

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && entry.status === 'downloading') {
      handle.pause.pause();
      await updateEntry(entry.id, { status: 'paused' });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      // 恢复：需要用户手势内重选保存目标（浏览器限制）
      try {
        const target = await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`);
        (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget = {
          id: entry.id,
          target,
        };
        if (running.current.has(entry.id)) return;
        await updateEntry(entry.id, { status: 'waiting' });
        scheduleNext();
      } catch (err) {
        if (err instanceof Error && err.message.includes('取消')) toast('已取消', 'info');
      }
      return;
    }
    void handle; // downloading 且无 handle：状态漂移，等待调度器自愈
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    running.current.get(entry.id)?.abort.abort();
    running.current.delete(entry.id);
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    // 终态（已完成/失败）删的是记录而非终止任务；文件已保存在用户选择的位置，不受影响
    toast(
      entry.status === 'completed' || entry.status === 'error'
        ? `《${entry.title}》已删除下载记录`
        : `《${entry.title}》已取消下载`,
      'info'
    );
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: '排队中',
    downloading: '下载中',
    paused: '已暂停',
    completed: '已完成',
    error: '失败',
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
      <div className="space-y-3">
        <p className="text-xs text-faint">
          保存能力：{capability === 'fs-access' ? '磁盘直写（边下边存）' : '内存聚合（完成后浏览器下载）'} ·
          同时进行 {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS} 个任务
        </p>
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载任务。在播放页点击「下载本集」开始。
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{t.title}</p>
                <p className="text-xs text-faint">
                  {t.format.toUpperCase()} · {statusLabel[t.status]}
                  {t.status === 'downloading' && t.total > 0 ? ` · ${t.finished}/${t.total} 分片` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {t.status === 'downloading' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  aria-label="删除下载任务"
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(t)}
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>
            </div>
            {(t.status === 'downloading' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}

/** 播放页等处调用：把一集加入下载队列（必须在用户手势内调用） */
export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

/** header 等处调用：打开下载管理器 */
export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

