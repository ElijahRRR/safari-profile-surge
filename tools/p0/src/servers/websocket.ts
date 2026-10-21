// 最小 WebSocket（RFC 6455）帧编解码：P0 回显服务与“其他应用”长连接测试共用。只支持文本、ping/pong、close，
// 单帧上限 1 MiB；SHA-1 只用于协议规定的握手应答。

import { createHash, randomBytes } from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
const MAX_FRAME = 1024 * 1024;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

export function newClientKey(): string {
  return randomBytes(16).toString('base64');
}

export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const header: number[] = [0x80 | (opcode & 0x0f)];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) header.push(maskBit | len);
  else if (len < 65536) header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    header.push(maskBit | 127, 0, 0, 0, 0);
    header.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(header), payload]);
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ key[i % 4]!;
  return Buffer.concat([Buffer.from(header), key, body]);
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** 从缓冲中解出完整帧，返回剩余字节；帧过大时抛错。 */
export function decodeFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const hi = buf.readUInt32BE(p);
      const lo = buf.readUInt32BE(p + 4);
      if (hi !== 0) throw new Error('ws frame too large');
      len = lo;
      p += 8;
    }
    if (len > MAX_FRAME) throw new Error('ws frame too large');
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    let payload = Buffer.from(buf.subarray(p + maskLen, p + maskLen + len));
    if (masked) {
      const key = buf.subarray(p, p + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i]! ^ key[i % 4]!;
      payload = out;
    }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + maskLen + len;
  }
  return { frames, rest: Buffer.from(buf.subarray(off)) };
}
