// 导入文件只在浏览器内读取，转成 base64 或 JSON 记录后发给本机服务；不发往其他地方，不落盘。

import type { ImportFormat } from '@sfe/contract';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function importFormatOf(name: string): ImportFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'json') return 'json';
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** JSON 导入：顶层数组，或 { records: [...] }。 */
export function parseJsonRecords(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error('读取文件失败：不是有效的 JSON');
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)) return (parsed as { records: unknown[] }).records;
  throw new Error('读取文件失败：JSON 顶层应为记录数组，或包含 records 数组');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 让浏览器保存一段文本（用于导入模板；请求需要带 Authorization，所以不能用普通链接）。 */
export function saveText(text: string, filename: string, type = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
