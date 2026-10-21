// 原始证据摘要：对运行目录中的文件按相对路径排序，用运行密钥做 HMAC-SHA256（不对可能含秘密的
// 原始内容发出无密钥哈希）。密钥文件、提议输出与临时文件不计入。提议只带摘要；原始证据不离开本机。

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RUN_KEY_FILE, type RunDir } from './run-dir.js';

export interface EvidenceManifestEntry {
  path: string;
  size: number;
  hmac: string;
}

export interface EvidenceManifest {
  runId: string;
  digest: string;
  files: EvidenceManifestEntry[];
}

const EXCLUDED = [new RegExp(`^${RUN_KEY_FILE.replace('.', '\\.')}$`), /^proposals\//, /\.tmp-[0-9a-f]+$/];

export function isEvidenceFile(rel: string): boolean {
  return !EXCLUDED.some((r) => r.test(rel));
}

export function hmacHex(key: Buffer, ...parts: Array<string | Buffer>): string {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

/** 纯函数部分：给定（相对路径, 内容）列表计算清单与总摘要。 */
export function digestEntries(key: Buffer, entries: ReadonlyArray<{ path: string; content: Buffer }>): { digest: string; files: EvidenceManifestEntry[] } {
  const sorted = [...entries].filter((e) => isEvidenceFile(e.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = sorted.map((e) => ({ path: e.path, size: e.content.length, hmac: hmacHex(key, 'sfe-p0-file\0', e.path, '\0', e.content) }));
  const total = createHmac('sha256', key).update('sfe-p0-evidence\0');
  for (const f of files) total.update(`${f.path}\0${f.size}\0${f.hmac}\n`);
  return { digest: `hmac-sha256:${total.digest('hex')}`, files };
}

export function computeEvidenceManifest(dir: RunDir): EvidenceManifest {
  const key = dir.key();
  const entries = dir.listFiles().map((rel) => ({ path: rel, content: readFileSync(dir.file(rel)) }));
  const { digest, files } = digestEntries(key, entries);
  return { runId: dir.id, digest, files };
}

/** 对内容计算带运行密钥的摘要（本工具写入的配置目录文件用它判断是否被外部修改）。 */
export function fileDigest(key: Buffer, content: string | Buffer): string {
  return createHmac('sha256', key).update('sfe-file\0').update(content).digest('hex');
}
