// 每次修改请求的唯一 request_id。同一次用户操作的重发（例如带上确认后再提交）沿用同一个值。

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `web-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
