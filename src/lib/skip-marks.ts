import { normalizeTitle } from './cms-parser';

/**
 * 跳过片段：标记的归一化、校验与「当前是否命中」判定。
 *
 * 采集站的详情接口不提供片头片尾元数据（vod_play_url 只有分集地址），
 * 因此边界只能由用户手动标记一次、按剧名记住，后续各集与同名资源自动套用。
 *
 * 相比固定的「片头/片尾」两个标记，这里泛化为任意数量的跳过片段（SkipSegment），
 * 每个片段用位置归类：opening（开头/片头）、middle（中间）、ending（结尾/片尾）。
 * 本模块只做纯计算，播放器接入与 UI 见 player-shell.tsx / skip-mark-panel.tsx。
 */

/** 片段位置类型：开头 / 中间 / 结尾 */
export type SkipSegmentType = 'opening' | 'middle' | 'ending';

/** 一条跳过片段；时间单位为秒（播放时间轴，与广告过滤后的时间轴一致） */
export interface SkipSegment {
  type: SkipSegmentType;
  /** 片段起点；opening 恒为 0 */
  start: number;
  /** 片段终点；ending 用 -1 表示「到视频结尾」，运行时以实际时长填充 */
  end: number;
}

/** 一部剧的跳过标记；按归一化剧名持久化 */
export interface SkipMark {
  segments: SkipSegment[];
  /** 本剧总开关：关掉后保留标记但完全不生效（误标时不必删掉重标） */
  enabled: boolean;
  /** 最近一次修改时间（epoch ms），便于后续做清理/展示 */
  updatedAt: number;
}

/** 三类片段在进度条色带与图例中的颜色（player-shell / skip-mark-panel 共用） */
export const SEGMENT_COLORS: Record<SkipSegmentType, string> = {
  opening: 'rgba(37,99,235,0.45)',
  middle: 'rgba(148,163,184,0.45)',
  ending: 'rgba(249,115,22,0.45)',
};

/** 三类片段的展示名（面板列表 / 进度条 tooltip 共用） */
export const SEGMENT_LABELS: Record<SkipSegmentType, string> = {
  opening: '片头',
  middle: '中段',
  ending: '片尾',
};

/** 某集经过时长校验后的有效片段；ending 的 end 已填充为实际时长 */
export interface ResolvedSegment {
  type: SkipSegmentType;
  start: number;
  end: number;
}

/** 跳过片段的最短时长：比这更短的区间没有跳过价值 */
export const MIN_SEGMENT_SECONDS = 3;
/** 相邻片段之间的最小间隔：贴太近说明某个标记错了 */
export const MIN_SEGMENT_GAP_SECONDS = 5;
/** 片段终点（ending 为起点）至少要比总时长提前的秒数，贴着结尾的片段没有跳过价值 */
export const END_GUARD_SECONDS = 2;
/** 命中提示的收尾余量：距片段末尾不足 1s 时不再打扰 */
export const PROMPT_GUARD_SECONDS = 1;
/** 两次 timeupdate 之间超过该秒数视为 seek，不使用「连续越过」判定 */
export const MAX_CONTINUOUS_STEP_SECONDS = 10;

/** 播放页在拿不到真实标题时使用的占位文案（watch/page.tsx 复用，避免双处硬编码） */
export const UNKNOWN_TITLE = '未知视频';

const SEGMENT_TYPES: ReadonlySet<string> = new Set<SkipSegmentType>(['opening', 'middle', 'ending']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 标记的存储键。
 * - 有标题时按归一化标题：同剧各集、换源后的同名资源共享同一份标记；
 * - 标题缺失/占位文案时退回 `${sourceKey}:${vodId}`，至少保证本源本片可用。
 * 前缀区分两类键，避免真实标题恰好长成兜底键的形态而串数据。
 */
export function skipMarkKey(title: string | undefined, fallback: string): string {
  const normalized = normalizeTitle(title ?? '');
  if (!normalized || normalized === normalizeTitle(UNKNOWN_TITLE)) {
    return `f:${fallback}`;
  }
  return `t:${normalized}`;
}

/**
 * 把持久化快照里的 skipMarks 归一化为当前结构（persist v3 → v4）。
 * - 已是 segments 结构的直接保留（按结构探测，兼容后续再升级）；
 * - 旧的 { introEnd, outroStart } 转成 opening + ending 两条；
 * - 损坏条目（null/非对象）直接丢弃，绝不能让恢复过程抛错。
 */
export function migrateSkipMarks(raw: unknown): Record<string, SkipMark> {
  const result: Record<string, SkipMark> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const mark = value as {
      segments?: unknown;
      enabled?: unknown;
      introEnd?: unknown;
      outroStart?: unknown;
      updatedAt?: unknown;
    };
    const updatedAt = typeof mark.updatedAt === 'number' ? mark.updatedAt : Date.now();
    // 缺省视为开启：v4 及更早的快照没有这个字段
    const enabled = mark.enabled !== false;

    if (Array.isArray(mark.segments)) {
      // 逐条校验结构：面板直接渲染 segments，损坏条目会显示成 NaN:NaN
      const valid = (mark.segments as unknown[]).flatMap((s): SkipSegment[] => {
        if (!s || typeof s !== 'object') return [];
        const seg = s as { type?: unknown; start?: unknown; end?: unknown };
        if (typeof seg.type !== 'string' || !SEGMENT_TYPES.has(seg.type)) return [];
        if (!isFiniteNumber(seg.start) || !isFiniteNumber(seg.end)) return [];
        return [{ type: seg.type as SkipSegmentType, start: seg.start, end: seg.end }];
      });
      result[key] = { segments: valid, enabled, updatedAt };
      continue;
    }

    const segments: SkipSegment[] = [];
    if (typeof mark.introEnd === 'number' && mark.introEnd > 0) {
      segments.push({ type: 'opening', start: 0, end: mark.introEnd });
    }
    if (typeof mark.outroStart === 'number' && mark.outroStart > 0) {
      segments.push({ type: 'ending', start: mark.outroStart, end: -1 });
    }
    result[key] = { segments, enabled, updatedAt };
  }
  return result;
}

/**
 * 把一条原始片段归一化成当前这集的有效区间；非法/越界/损坏时返回 null。
 *
 * 必须是「读取侧」校验：标记按剧共享，不同集/不同源的时长可能不同，
 * 旧标记完全可能越界；损坏的持久化数据也不应让播放报错。
 */
function normalizeSegment(seg: SkipSegment | undefined, duration: number): ResolvedSegment | null {
  if (!seg || !SEGMENT_TYPES.has(seg.type)) return null;
  if (!isFiniteNumber(seg.start) || seg.start < 0) return null;

  const start = seg.type === 'opening' ? 0 : seg.start;
  const end = seg.type === 'ending' ? duration : seg.end;

  if (!isFiniteNumber(end)) return null;
  if (end <= start) return null;
  if (end - start < MIN_SEGMENT_SECONDS) return null;

  if (seg.type === 'ending') {
    if (start > duration - END_GUARD_SECONDS) return null;
  } else if (end > duration - END_GUARD_SECONDS) {
    return null;
  }

  return { type: seg.type, start, end };
}

/**
 * 把持久化标记裁剪成当前这集可用的片段列表（按 start 升序、无重叠）。
 * ending 的 end 用实际时长填充；重叠或过近的片段保留靠前者、丢弃后者。
 */
export function resolveSegments(mark: SkipMark | undefined, duration: number): ResolvedSegment[] {
  if (!mark || !Array.isArray(mark.segments) || !isFiniteNumber(duration) || duration <= 0) return [];
  // 本剧总开关关闭：保留标记但一格都不生效（缺省视为开启，兼容旧快照）
  if (mark.enabled === false) return [];

  const resolved: ResolvedSegment[] = [];
  for (const seg of mark.segments) {
    const r = normalizeSegment(seg, duration);
    if (r) resolved.push(r);
  }
  resolved.sort((a, b) => a.start - b.start);

  const result: ResolvedSegment[] = [];
  for (const seg of resolved) {
    const last = result[result.length - 1];
    if (last && seg.start - last.end < MIN_SEGMENT_GAP_SECONDS) continue;
    result.push(seg);
  }
  return result;
}

/** 当前位置是否落在某个跳过片段内（用于显示「跳过」按钮与自动跳转） */
export function findActiveSegment(
  segments: ResolvedSegment[],
  position: number
): ResolvedSegment | undefined {
  if (!isFiniteNumber(position)) return undefined;
  return segments.find((s) => position >= s.start && position < s.end - PROMPT_GUARD_SECONDS);
}

/**
 * 是否在连续播放中越过了「结尾」片段的起点。
 * 只认小步前进：用户拖动进度条、刚写入标记、以及进度恢复造成的大跳变
 * 都不应触发自动结束；这些场景仍会显示按钮，由用户自己决定。
 */
export function findCrossedEnding(
  segments: ResolvedSegment[],
  previous: number,
  current: number
): boolean {
  if (!isFiniteNumber(previous) || !isFiniteNumber(current)) return false;
  const step = current - previous;
  if (!(step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS)) return false;
  return segments.some((s) => s.type === 'ending' && previous < s.start && current >= s.start);
}

/**
 * 校验一条待写入的片段；duration 未知（<=0）时只做相对校验。返回错误文案或 null。
 * existing 为当前已保存的片段（不含待写入这条）。
 */
export function validateSegment(
  segment: SkipSegment,
  duration: number,
  existing: SkipSegment[] = []
): string | null {
  if (!segment || !SEGMENT_TYPES.has(segment.type)) return '片段类型无效';
  if (!isFiniteNumber(segment.start) || segment.start < 0) return '片段起点无效';
  if (segment.type === 'opening' && segment.start !== 0) return '片头片段起点必须为 0';

  const start = segment.start;
  let end: number;
  if (segment.type === 'ending') {
    if (segment.end !== -1) return '片尾片段无需指定终点';
    end = isFiniteNumber(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  } else {
    if (!isFiniteNumber(segment.end)) return '片段终点无效';
    end = segment.end;
  }

  if (end - start < MIN_SEGMENT_SECONDS) {
    return `跳过片段至少需要 ${MIN_SEGMENT_SECONDS} 秒`;
  }
  if (isFiniteNumber(duration) && duration > 0) {
    if (segment.type === 'ending') {
      if (start > duration - END_GUARD_SECONDS) return '片尾开始不能贴近视频末尾';
    } else if (end > duration - END_GUARD_SECONDS) {
      return '片段终点不能贴近视频末尾';
    }
  }

  for (const other of existing) {
    if (!other || !SEGMENT_TYPES.has(other.type)) continue;
    const oStart = other.start;
    let oEnd: number;
    if (other.type === 'ending') {
      oEnd = isFiniteNumber(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    } else {
      oEnd = isFiniteNumber(other.end) ? other.end : other.start;
    }
    // 与已有片段的重叠/间隔判定：gap <= 0 为重叠，0 < gap < MIN_GAP 为过近
    const gap = Math.max(oStart - end, start - oEnd);
    if (gap < MIN_SEGMENT_GAP_SECONDS) {
      return gap <= 0 ? '片段与已有片段重叠' : `片段之间至少间隔 ${MIN_SEGMENT_GAP_SECONDS} 秒`;
    }
  }
  return null;
}
