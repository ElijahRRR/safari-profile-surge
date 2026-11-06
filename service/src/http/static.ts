// 静态文件（网页构建产物与演示用扩展页面）。路径先解码再逐段校验：拒绝 NUL、反斜杠、
// 以点开头的段（含 . 与 .. 与隐藏文件），再用 realpath 确认最终文件仍在根目录内（防符号链接逃逸）。

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, isAbsolute, sep } from 'node:path';
import { IMMUTABLE, isHashedAssetPath, mimeTypeFor } from './headers.js';

export type StaticResolution = { kind: 'file'; path: string; size: number } | { kind: 'bad_request' } | { kind: 'not_found' };

/** 把 URL 路径（仍是百分号编码形式）解析为根目录内的真实文件。 */
export async function resolveStaticPath(root: string, encodedPath: string): Promise<StaticResolution> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return { kind: 'bad_request' };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return { kind: 'not_found' };
  if (!decoded.startsWith('/')) decoded = `/${decoded}`;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s.startsWith('.'))) return { kind: 'not_found' };
  if (decoded.endsWith('/')) segments.push('index.html');

  const candidate = join(root, ...segments);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'not_found' };

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(candidate);
  } catch {
    return { kind: 'not_found' };
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return { kind: 'not_found' };
  try {
    const st = await stat(realFile);
    if (!st.isFile()) return { kind: 'not_found' };
    return { kind: 'file', path: realFile, size: st.size };
  } catch {
    return { kind: 'not_found' };
  }
}

/** 返回实际状态码。调用方已设置安全头（含 no-store）；只有带哈希的 /assets/ 文件改为长期缓存。 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  encodedPath: string,
  cacheKeyPath: string | null,
): Promise<number> {
  const r = await resolveStaticPath(root, encodedPath);
  if (r.kind !== 'file') {
    const status = r.kind === 'bad_request' ? 400 : 404;
    sendPlain(res, status, status === 400 ? '请求失败：路径格式不正确' : '未找到');
    return status;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', mimeTypeFor(r.path));
  res.setHeader('Content-Length', String(r.size));
  if (cacheKeyPath !== null && isHashedAssetPath(cacheKeyPath)) res.setHeader('Cache-Control', IMMUTABLE);
  if (req.method === 'HEAD') {
    res.end();
    return 200;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(r.path);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
  return 200;
}

export function sendPlain(res: ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}
