// 连接连续性时间线分析（纯函数）：按标记事件把运行切成若干时段，逐段统计短请求成功率与延迟、
// 长连接流的最大间隔与重置、WebSocket 重置、经过的测试节点；对每个事件给出影响（重置、失败数、恢复时间）。
// 第一个事件之前的时段是未执行变更的对照。

export interface Sample {
  t: number;
  kind: 'short' | 'stream' | 'stream_end' | 'ws_open' | 'ws_msg' | 'ws_close' | 'public';
  ok: boolean;
  ms?: number;
  via?: string | null;
  /** 由工具主动结束（运行结束时）的连接不算重置。 */
  expected?: boolean;
  /** 连接结束原因（ended、reset、closed_by_server 等）。 */
  reason?: string;
}

export interface MarkedEvent {
  t: number;
  label: string;
  source: 'operator' | 'action';
}

export interface PeriodMetrics {
  label: string;
  from: number;
  to: number;
  shortTotal: number;
  shortOk: number;
  p50: number | null;
  p95: number | null;
  maxStreamGapMs: number | null;
  streamResets: number;
  wsResets: number;
  vias: string[];
  publicTotal: number;
  publicOk: number;
}

export interface EventImpact {
  label: string;
  t: number;
  failedShorts: number;
  streamResets: number;
  wsResets: number;
  /** 事件后第一次短请求失败到之后第一次成功的时间；没有失败为 0。 */
  recoveryMs: number | null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function metrics(label: string, from: number, to: number, samples: readonly Sample[]): PeriodMetrics {
  const inRange = samples.filter((s) => s.t >= from && s.t < to);
  const shorts = inRange.filter((s) => s.kind === 'short');
  const lat = shorts.filter((s) => s.ok && typeof s.ms === 'number').map((s) => s.ms!);
  // 流的间隔：本时段内相邻两行（含上一时段最后一行）之间的最长时间。
  const streamTimes = samples.filter((s) => s.kind === 'stream' && s.t < to).map((s) => s.t);
  let maxGap: number | null = null;
  for (let i = 1; i < streamTimes.length; i++) {
    if (streamTimes[i]! < from) continue;
    const gap = streamTimes[i]! - streamTimes[i - 1]!;
    maxGap = maxGap === null ? gap : Math.max(maxGap, gap);
  }
  const vias = [...new Set(inRange.filter((s) => s.via !== undefined && s.via !== null).map((s) => s.via!))].sort();
  const publics = inRange.filter((s) => s.kind === 'public');
  return {
    label,
    from,
    to,
    shortTotal: shorts.length,
    shortOk: shorts.filter((s) => s.ok).length,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    maxStreamGapMs: maxGap,
    streamResets: inRange.filter((s) => s.kind === 'stream_end' && !s.expected).length,
    wsResets: inRange.filter((s) => s.kind === 'ws_close' && !s.expected).length,
    vias,
    publicTotal: publics.length,
    publicOk: publics.filter((s) => s.ok).length,
  };
}

export function analyzeContinuity(
  samples: readonly Sample[],
  events: readonly MarkedEvent[],
  range: { start: number; end: number },
): { periods: PeriodMetrics[]; impacts: EventImpact[] } {
  const evs = [...events].filter((e) => e.t >= range.start && e.t <= range.end).sort((a, b) => a.t - b.t);
  const bounds = [range.start, ...evs.map((e) => e.t), range.end];
  const labels = ['对照（未执行变更）', ...evs.map((e) => e.label)];
  const periods = labels.map((label, i) => metrics(label, bounds[i]!, bounds[i + 1]!, samples));
  const impacts = evs.map((e, i): EventImpact => {
    const p = periods[i + 1]!;
    const shorts = samples.filter((s) => s.kind === 'short' && s.t >= p.from && s.t < p.to);
    const firstFail = shorts.find((s) => !s.ok);
    let recoveryMs: number | null = 0;
    if (firstFail) {
      const lastFailIdx = shorts.map((s) => s.ok).lastIndexOf(false);
      const after = shorts.slice(lastFailIdx + 1).find((s) => s.ok);
      recoveryMs = after ? after.t - e.t : null;
    }
    return { label: e.label, t: e.t, failedShorts: shorts.filter((s) => !s.ok).length, streamResets: p.streamResets, wsResets: p.wsResets, recoveryMs };
  });
  return { periods, impacts };
}

export function formatPeriod(p: PeriodMetrics): string {
  const rate = p.shortTotal === 0 ? '无' : `${p.shortOk}/${p.shortTotal}`;
  return `${p.label}：短请求 ${rate}，延迟 p50 ${p.p50 ?? '-'} ms / p95 ${p.p95 ?? '-'} ms，流最大间隔 ${p.maxStreamGapMs ?? '-'} ms，流重置 ${p.streamResets}，WebSocket 重置 ${p.wsResets}，经过 ${p.vias.join('、') || '-'}`;
}
