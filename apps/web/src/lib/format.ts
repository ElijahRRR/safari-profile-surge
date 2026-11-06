// 展示格式：数字带千分位，时间带单位；中文与数字之间留半角空格。

const numberFormat = new Intl.NumberFormat('zh-CN');

export function formatNumber(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? numberFormat.format(n) : '—';
}

/** 「12 个」「1,284 个」 */
export function formatCount(n: number, unit = '个'): string {
  return `${formatNumber(n)} ${unit}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** 本地时间 2026-10-21 14:03:05。 */
export function formatDateTime(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatClock(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对时间：刚刚、12 秒前、3 分钟前、2 小时前、5 天前；未来时间写「x 秒后」。 */
export function formatRelative(iso: string | null | undefined, now: number): string {
  const t = parseTime(iso);
  if (t === null) return '—';
  const diff = Math.round((now - t) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  if (s < 5) return '刚刚';
  const suffix = future ? '后' : '前';
  if (s < 60) return `${s} 秒${suffix}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟${suffix}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时${suffix}`;
  return `${formatNumber(Math.floor(h / 24))} 天${suffix}`;
}

export function isExpired(expiresAt: string | null | undefined, now: number): boolean {
  const t = parseTime(expiresAt);
  return t === null ? true : t <= now;
}

/** 秒数：30 秒、5 分钟、1 小时 30 分钟。 */
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${formatNumber(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} 分钟 ${s} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${formatNumber(h)} 小时 ${rm} 分钟` : `${formatNumber(h)} 小时`;
}

/** 代理连接地址：IPv6 加方括号。 */
export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** 版本号显示为 v3（节点名中的版本即 v003）。 */
export function formatRevision(revision: number | null | undefined): string {
  return typeof revision === 'number' ? `v${revision}` : '—';
}
