// 占位图标生成：青绿圆角方块（EasyQuick gradient-primary）。正式标志尚未设计，见 README。
// 纯 TypeScript，无 Node 依赖：deflate 可注入（构建时用 zlib，测试可用无压缩的 stored 块）。

export type Deflate = (data: Uint8Array) => Uint8Array;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib 封装的无压缩 deflate（stored 块）。 */
export const storedDeflate: Deflate = (data) => {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(data);
  out[o++] = (ad >>> 24) & 0xff;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out;
};

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array, deflate: Deflate = storedDeflate): Uint8Array {
  if (rgba.length !== width * height * 4) throw new RangeError('pixel buffer size mismatch');
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // 过滤器：None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

const FROM = [0x14, 0xb8, 0xa6]; // primary-500
const TO = [0x0d, 0x94, 0x88]; // primary-600

/** 圆角方块像素（RGBA），4×4 超采样抗锯齿，135° 渐变。 */
export function renderRoundedSquare(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const margin = size * 0.06;
  const radius = size * 0.22;
  const lo = margin;
  const hi = size - margin;
  const inside = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, lo + radius), hi - radius);
    const cy = Math.min(Math.max(y, lo + radius), hi - radius);
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
      if (!hits) continue;
      const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
      const i = (y * size + x) * 4;
      px[i] = Math.round(FROM[0]! + (TO[0]! - FROM[0]!) * t);
      px[i + 1] = Math.round(FROM[1]! + (TO[1]! - FROM[1]!) * t);
      px[i + 2] = Math.round(FROM[2]! + (TO[2]! - FROM[2]!) * t);
      px[i + 3] = Math.round((255 * hits) / (S * S));
    }
  }
  return px;
}

export function iconPng(size: number, deflate: Deflate = storedDeflate): Uint8Array {
  return encodePng(size, size, renderRoundedSquare(size), deflate);
}
