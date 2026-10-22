import { describe, expect, it } from 'vitest';
import {
  MAX_CONTINUOUS_STEP_SECONDS,
  MIN_SEGMENT_GAP_SECONDS,
  findActiveSegment,
  findCrossedEnding,
  migrateSkipMarks,
  resolveSegments,
  skipMarkKey,
  validateSegment,
  type SkipMark,
  type SkipSegment,
} from './skip-marks';

const mark = (...segments: SkipSegment[]): SkipMark => ({ segments, enabled: true, updatedAt: 0 });

describe('skipMarkKey', () => {
  it('空白、标点、大小写归一后指向同一个标记', () => {
    expect(skipMarkKey('摔跤吧！爸爸', 'a:1')).toBe(skipMarkKey(' 摔跤吧!爸爸 ', 'b:2'));
    expect(skipMarkKey('Hello, World!', 'a:1')).toBe(skipMarkKey('hello world', 'b:2'));
  });

  it('同剧换源共享标记：标题相同、兜底键不同也得到同一个键', () => {
    expect(skipMarkKey('庆余年', 'custom_0:123')).toBe(skipMarkKey('庆余年', 'sub_ab_1:456'));
  });

  it('标题缺失或为占位文案时退回 source:vod 兜底键', () => {
    expect(skipMarkKey(undefined, 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('', 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('未知视频', 'custom_0:123')).toBe('f:custom_0:123');
  });

  it('不同的剧不会互相串标记', () => {
    expect(skipMarkKey('庆余年', 'a')).not.toBe(skipMarkKey('庆余年2', 'a'));
  });
});

describe('migrateSkipMarks', () => {
  it('v3 的片头/片尾双标记转成 opening + ending', () => {
    const result = migrateSkipMarks({
      't:abc': { introEnd: 45, outroStart: 1200, updatedAt: 111 },
    });
    expect(result['t:abc']).toEqual({
      segments: [
        { type: 'opening', start: 0, end: 45 },
        { type: 'ending', start: 1200, end: -1 },
      ],
      enabled: true,
      updatedAt: 111,
    });
  });

  it('只有单边字段时只生成对应片段', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 45, updatedAt: 1 } })['t:a']?.segments).toEqual([
      { type: 'opening', start: 0, end: 45 },
    ]);
    expect(migrateSkipMarks({ 't:b': { outroStart: 1200, updatedAt: 1 } })['t:b']?.segments).toEqual([
      { type: 'ending', start: 1200, end: -1 },
    ]);
  });

  it('已是 segments 结构直接保留', () => {
    const segments = [{ type: 'middle', start: 100, end: 200 }] as SkipSegment[];
    expect(migrateSkipMarks({ 't:x': { segments, updatedAt: 2 } })['t:x']).toEqual({
      segments,
      enabled: true,
      updatedAt: 2,
    });
  });

  it('缺省 enabled 视为开启，显式 false 时保留', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 20 } })['t:a']?.enabled).toBe(true);
    expect(
      migrateSkipMarks({ 't:b': { segments: [], enabled: false, updatedAt: 1 } })['t:b']?.enabled
    ).toBe(false);
  });

  it('损坏条目丢弃，其余正常迁移', () => {
    const result = migrateSkipMarks({
      bad1: null,
      bad2: 'oops',
      bad3: 123,
      good: { introEnd: 30, updatedAt: 5 },
    });
    expect(Object.keys(result)).toEqual(['good']);
    expect(result.good?.segments).toEqual([{ type: 'opening', start: 0, end: 30 }]);
  });

  it('非对象输入返回空对象', () => {
    expect(migrateSkipMarks(undefined)).toEqual({});
    expect(migrateSkipMarks(null)).toEqual({});
    expect(migrateSkipMarks([])).toEqual({});
    expect(migrateSkipMarks('x')).toEqual({});
  });

  it('segments 里的损坏条目逐条剔除（面板会直接渲染原始列表）', () => {
    const result = migrateSkipMarks({
      't:a': {
        segments: [
          { type: 'middle', start: 100, end: 200 },
          { type: 'unknown', start: 1, end: 2 },
          { type: 'opening', start: 0, end: Number.NaN },
          null,
          'x',
        ],
        updatedAt: 1,
      },
    });
    expect(result['t:a']?.segments).toEqual([{ type: 'middle', start: 100, end: 200 }]);
  });

  it('缺失 updatedAt 时补当前时间', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 20 } })['t:a']?.updatedAt).toBeGreaterThan(0);
  });
});

describe('resolveSegments', () => {
  it('合法片段按 start 升序返回，ending 的 end 用时长填充', () => {
    expect(
      resolveSegments(
        mark(
          { type: 'ending', start: 1200, end: -1 },
          { type: 'opening', start: 0, end: 45 },
          { type: 'middle', start: 500, end: 530 }
        ),
        2400
      )
    ).toEqual([
      { type: 'opening', start: 0, end: 45 },
      { type: 'middle', start: 500, end: 530 },
      { type: 'ending', start: 1200, end: 2400 },
    ]);
  });

  it('空标记、时长缺失或非法时返回空列表', () => {
    expect(resolveSegments(undefined, 2400)).toEqual([]);
    expect(resolveSegments(mark(), 0)).toEqual([]);
    expect(resolveSegments(mark(), Number.NaN)).toEqual([]);
  });

  it('本剧总开关关闭时一律返回空列表（标记保留但不生效）', () => {
    expect(
      resolveSegments({ ...mark({ type: 'opening', start: 0, end: 45 }), enabled: false }, 2400)
    ).toEqual([]);
  });

  it('越界/过短的片段被逐项剔除', () => {
    // 片头 < 3s
    expect(resolveSegments(mark({ type: 'opening', start: 0, end: 2 }), 2400)).toEqual([]);
    // 片尾贴结尾
    expect(resolveSegments(mark({ type: 'ending', start: 2399, end: -1 }), 2400)).toEqual([]);
    // 中段终点贴结尾
    expect(resolveSegments(mark({ type: 'middle', start: 2300, end: 2400 }), 2400)).toEqual([]);
  });

  it('重叠或过近时保留靠前者、丢弃后者', () => {
    const a: SkipSegment = { type: 'middle', start: 100, end: 200 };
    const b: SkipSegment = { type: 'middle', start: 100 + MIN_SEGMENT_GAP_SECONDS - 1, end: 300 };
    expect(resolveSegments(mark(a, b), 2400)).toEqual([{ ...a }]);
  });

  it('损坏的持久化数据（负数/NaN/类型不对）不会抛错', () => {
    expect(
      resolveSegments(
        {
          segments: [{ type: 'middle', start: -5, end: Number.NaN } as unknown as SkipSegment],
          enabled: true,
          updatedAt: 0,
        },
        2400
      )
    ).toEqual([]);
  });
});

describe('findActiveSegment', () => {
  const segments = resolveSegments(mark({ type: 'opening', start: 0, end: 45 }), 2400);

  it('区间内命中，收尾余量内不命中', () => {
    expect(findActiveSegment(segments, 0)?.type).toBe('opening');
    expect(findActiveSegment(segments, 43.5)?.type).toBe('opening');
    expect(findActiveSegment(segments, 44.5)).toBeUndefined(); // 距末尾 0.5s
    expect(findActiveSegment(segments, 45)).toBeUndefined();
  });

  it('非法位置或空列表返回 undefined', () => {
    expect(findActiveSegment(segments, Number.NaN)).toBeUndefined();
    expect(findActiveSegment([], 10)).toBeUndefined();
  });
});

describe('findCrossedEnding', () => {
  const segments = resolveSegments(mark({ type: 'ending', start: 1200, end: -1 }), 2400);

  it('连续小步前进越过片尾起点才触发', () => {
    expect(findCrossedEnding(segments, 1199.5, 1200.25)).toBe(true);
    expect(findCrossedEnding(segments, 1200.2, 1201)).toBe(false); // 已经越过
    expect(findCrossedEnding(segments, 1199.5, 1199.9)).toBe(false); // 尚未到达
    expect(findCrossedEnding(segments, 1201, 1200.5)).toBe(false); // 倒退
  });

  it('大跨度拖动/进度恢复不触发自动结束', () => {
    expect(findCrossedEnding(segments, 0, 1300)).toBe(false);
    expect(findCrossedEnding(segments, 1190, 1200 + MAX_CONTINUOUS_STEP_SECONDS)).toBe(false);
  });

  it('无结尾片段或时间非法时为假', () => {
    const noEnding = resolveSegments(mark({ type: 'opening', start: 0, end: 45 }), 2400);
    expect(findCrossedEnding(noEnding, 1199, 1201)).toBe(false);
    expect(findCrossedEnding(segments, Number.NaN, 1201)).toBe(false);
  });
});

describe('validateSegment', () => {
  it('接受合理的片头/片尾/中段', () => {
    expect(validateSegment({ type: 'opening', start: 0, end: 30 }, 2400)).toBeNull();
    expect(validateSegment({ type: 'ending', start: 1200, end: -1 }, 2400)).toBeNull();
    expect(validateSegment({ type: 'middle', start: 500, end: 530 }, 2400)).toBeNull();
  });

  it('拒绝过短、非法与贴结尾的片段', () => {
    expect(validateSegment({ type: 'opening', start: 0, end: 2 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'middle', start: 500, end: 501 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'middle', start: Number.NaN, end: 500 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 2399, end: -1 }, 2400)).not.toBeNull();
  });

  it('opening 起点必须为 0，ending 无需指定终点', () => {
    expect(validateSegment({ type: 'opening', start: 5, end: 30 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 1200, end: 1300 }, 2400)).not.toBeNull();
  });

  it('与已有片段重叠或过近时拒绝，刚好够间隔时接受', () => {
    const existing = [{ type: 'middle', start: 500, end: 530 } as SkipSegment];
    expect(validateSegment({ type: 'middle', start: 520, end: 560 }, 2400, existing)).not.toBeNull();
    expect(
      validateSegment({ type: 'middle', start: 530 + MIN_SEGMENT_GAP_SECONDS - 1, end: 600 }, 2400, existing)
    ).not.toBeNull();
    expect(
      validateSegment({ type: 'middle', start: 530 + MIN_SEGMENT_GAP_SECONDS, end: 600 }, 2400, existing)
    ).toBeNull();
  });
});
