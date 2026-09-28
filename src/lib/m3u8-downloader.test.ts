import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSegment } from './m3u8-downloader';
import { parseM3u8Playlist } from './m3u8-parse';

const KEY = crypto.getRandomValues(new Uint8Array(16));
const asBuf = (v: Uint8Array): BufferSource => v.buffer as ArrayBuffer;
const PLAINTEXT = crypto.getRandomValues(new Uint8Array(188 * 3));

async function encryptForIv(plaintext: BufferSource, iv: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', asBuf(KEY), 'AES-CBC', false, ['encrypt']);
  return crypto.subtle.encrypt({ name: 'AES-CBC', iv: asBuf(iv) }, cryptoKey, plaintext);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decryptSegment', () => {
  it('显式 IV：密文往返还原明文', async () => {
    const cipher = await encryptForIv(PLAINTEXT, new Uint8Array(16).fill(0xab));
    const out = await decryptSegment(cipher, asBuf(KEY), 'ab'.repeat(16), 0, 0);
    expect(new Uint8Array(out)).toEqual(PLAINTEXT);
  });

  it('无 IV 属性：IV = mediaSequence + 分片序号（16 字节大端），逐分片递增', async () => {
    // 分片 0（媒体序列号 5 → IV=5）与分片 1（IV=6）用各自正确的 IV 加密
    const ivOf = (seq: number) => {
      const iv = new Uint8Array(16);
      iv[15] = seq;
      return iv;
    };
    const cipher0 = await encryptForIv(PLAINTEXT, ivOf(5));
    const cipher1 = await encryptForIv(PLAINTEXT, ivOf(6));

    const out0 = await decryptSegment(cipher0, asBuf(KEY), undefined, 5, 0);
    expect(new Uint8Array(out0)).toEqual(PLAINTEXT);
    const out1 = await decryptSegment(cipher1, asBuf(KEY), undefined, 5, 1);
    expect(new Uint8Array(out1)).toEqual(PLAINTEXT);
  });

  it('回归：旧实现恒用零向量 IV——对非零序列号分片解密必然失败', async () => {
    // 分片按正确 IV=6 加密；旧实现对无 IV 属性的 KEY 恒用零向量 → 解不出明文
    const cipher = await encryptForIv(PLAINTEXT, ivOf6());
    const zeroIv = '00'.repeat(16);
    const out = await decryptSegment(cipher, asBuf(KEY), zeroIv, 5, 1).catch(
      () => new ArrayBuffer(0)
    );
    const same =
      out.byteLength === PLAINTEXT.byteLength &&
      new Uint8Array(out).every((b, i) => b === PLAINTEXT[i]);
    expect(same).toBe(false);
  });
});

function ivOf6(): Uint8Array {
  const iv = new Uint8Array(16);
  iv[15] = 6;
  return iv;
}

describe('parseM3u8Playlist · mediaSequence 与 AES URI 绝对化', () => {
  it('解析 EXT-X-MEDIA-SEQUENCE，AES key 相对地址转绝对', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:15',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'seg0.ts',
      '#EXTINF:4,',
      'seg1.ts',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(playlist, { status: 200 }))
    );

    const parsed = await parseM3u8Playlist('https://cdn.example.com/live/index.m3u8');
    expect(parsed.mediaSequence).toBe(15);
    expect(parsed.aesConf?.uri).toBe('https://cdn.example.com/live/key.bin');
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].url).toBe('https://cdn.example.com/live/seg0.ts');
  });

  it('缺省 MEDIA-SEQUENCE 时为 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U\n#EXTINF:4,\nseg.ts', { status: 200 }))
    );
    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8');
    expect(parsed.mediaSequence).toBe(0);
  });
});
