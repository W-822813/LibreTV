import { describe, expect, it, vi } from 'vitest';
import { parseM3u8Playlist } from './m3u8-parse';
import { isProxiedUri, rewriteM3u8, stripLeadAdGroup } from './m3u8';

const BASE = 'https://cdn.example.com/live/index.m3u8';

describe('rewriteM3u8', () => {
  it('把分片、嵌套播放列表、key、map 全部改写为代理地址（查询串形式）', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'https://cdn.example.com/live/720p.m3u8',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4"',
      '/relative/seg1.ts',
      'seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = rewriteM3u8(input, BASE);

    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/720p.m3u8'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/key.bin'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/init.mp4'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/relative/seg1.ts'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/seg2.ts'));
    // 非地址行保持不变
    expect(out).toContain('#EXTM3U');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('直播前缀改写为 /api/live/stream?url= 形式', () => {
    const out = rewriteM3u8('https://cdn.example.com/live/seg1.ts', BASE, 0, '/api/live/stream?url=');
    expect(out).toBe('/api/live/stream?url=' + encodeURIComponent('https://cdn.example.com/live/seg1.ts'));
  });

  it('已是代理地址的行（新旧两种形式）不重复改写', () => {
    const legacy = '/api/proxy/' + encodeURIComponent('https://x.com/a.ts');
    expect(rewriteM3u8(legacy, BASE)).toBe(legacy);
    const modern = '/api/proxy?url=' + encodeURIComponent('https://x.com/a.ts');
    expect(rewriteM3u8(modern, BASE)).toBe(modern);
    const legacyLive = '/api/live/stream/' + encodeURIComponent('https://x.com/live.m3u8');
    expect(rewriteM3u8(legacyLive, BASE, 0, '/api/live/stream?url=')).toBe(legacyLive);
  });

  it('超过递归深度限制时原样返回', () => {
    const input = 'https://a.ts';
    expect(rewriteM3u8(input, BASE, 6)).toBe(input);
  });
});

describe('isProxiedUri', () => {
  it('新旧两种代理形式均识别', () => {
    expect(isProxiedUri('/api/proxy/' + encodeURIComponent('https://x.com/a.ts'))).toBe(true);
    expect(isProxiedUri('/api/proxy?url=' + encodeURIComponent('https://x.com/a.ts'))).toBe(true);
    expect(isProxiedUri('/api/live/stream?url=' + encodeURIComponent('https://x.com/live.m3u8'))).toBe(true);
    expect(isProxiedUri('https://cdn.example.com/seg1.ts')).toBe(false);
    expect(isProxiedUri('/relative/seg1.ts')).toBe(false);
  });
});

describe('stripLeadAdGroup', () => {
  /** 按 dytt 实测结构造播放列表：片头广告段（首个 DISCONTINUITY 段）+ 若干正片段 */
  function dyttLike(adCount: number, adDur = 4): string {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8', '#EXT-X-DISCONTINUITY'];
    for (let i = 0; i < adCount; i++) lines.push(`#EXTINF:${adDur},`, `ad${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie0.ts');
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie1.ts', '#EXT-X-ENDLIST');
    return lines.join('\n');
  }

  it('dytt 结构：整段剔除片头广告分片，正片与后续 DISCONTINUITY 保留', () => {
    const out = stripLeadAdGroup(dyttLike(3));
    expect(out).not.toContain('ad0.ts');
    expect(out).not.toContain('ad2.ts');
    expect(out).toContain('movie0.ts');
    expect(out).toContain('movie1.ts');
    // 正片段之间的 DISCONTINUITY 必须保留（删标记会破坏时间轴，见 dytt 实测）
    expect(out.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    // 正片前导的 DISCONTINUITY（无前文，失去意义）被清掉
    const firstSeg = out.indexOf('movie0.ts');
    expect(out.slice(0, firstSeg)).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('段时长超过 90s / 分片数超过 20 时不动', () => {
    expect(stripLeadAdGroup(dyttLike(30))).toBe(dyttLike(30)); // 120s
    expect(stripLeadAdGroup(dyttLike(21, 1))).toBe(dyttLike(21, 1)); // 21 片
  });

  it('首个分片之前没有 DISCONTINUITY 时不动', () => {
    const input = ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'b.ts'].join('\n');
    expect(stripLeadAdGroup(input)).toBe(input);
  });

  it('片头段之后没有更多分段时不动（无法与正片区分）', () => {
    const input = ['#EXTM3U', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join('\n');
    expect(stripLeadAdGroup(input)).toBe(input);
  });

  it('段内 KEY/MAP 保留（正片可能复用解密配置）', () => {
    const lines = dyttLike(2).split('\n');
    lines.splice(2, 0, '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"');
    const out = stripLeadAdGroup(lines.join('\n'));
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    expect(out).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(out).not.toContain('ad0.ts');
  });

  it('空内容返回空串', () => {
    expect(stripLeadAdGroup('')).toBe('');
  });
});

describe('parseM3u8Playlist · 片头广告剔除', () => {
  it('默认剔除广告段：分片与 totalDuration 均不含广告', async () => {
    const lines = ['#EXTM3U', '#EXT-X-DISCONTINUITY'];
    for (let i = 0; i < 3; i++) lines.push('#EXTINF:5,', `ad${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie0.ts', '#EXTINF:4,', 'movie1.ts', '#EXT-X-ENDLIST');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines.join('\n'), { status: 200 })));

    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8');
    expect(parsed.segments.map((s) => s.url)).toEqual([
      'https://cdn.example.com/movie0.ts',
      'https://cdn.example.com/movie1.ts',
    ]);
    expect(parsed.totalDuration).toBe(8);
  });

  it('stripLeadAd=false 保留全部分片', async () => {
    const lines = ['#EXTM3U', '#EXT-X-DISCONTINUITY', '#EXTINF:5,', 'ad.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie.ts'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines.join('\n'), { status: 200 })));

    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8', 0, undefined, { stripLeadAd: false });
    expect(parsed.segments).toHaveLength(2);
  });
});
