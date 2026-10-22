// 连接连续性时间线分析（纯函数）：按标记事件把运行切成若干时段，逐段统计短请求成功率与延迟、
// 长连接流的最大间隔与重置、WebSocket 重置与重连失败、经过的测试节点；对每个事件给出影响（重置、失败数、恢复时间）。
// 第一个事件之前的时段是未执行变更的对照。同一配置重载另有整窗口评估（assessReload）：操作员的标记可能晚于
// 实际重载，因此整个观察窗口内的中断都计入，并且必须有重载确实发生的正面证据。

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
  /** WebSocket 打开失败（隧道或握手失败）的次数。 */
  wsOpenFailures: number;
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
  wsOpenFailures: number;
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
    wsOpenFailures: inRange.filter((s) => s.kind === 'ws_open' && !s.ok).length,
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
    return { label: e.label, t: e.t, failedShorts: shorts.filter((s) => !s.ok).length, streamResets: p.streamResets, wsResets: p.wsResets, wsOpenFailures: p.wsOpenFailures, recoveryMs };
  });
  return { periods, impacts };
}

export function formatPeriod(p: PeriodMetrics): string {
  const rate = p.shortTotal === 0 ? '无' : `${p.shortOk}/${p.shortTotal}`;
  const wsFail = p.wsOpenFailures > 0 ? `，WebSocket 重连失败 ${p.wsOpenFailures}` : '';
  return `${p.label}：短请求 ${rate}，延迟 p50 ${p.p50 ?? '-'} ms / p95 ${p.p95 ?? '-'} ms，流最大间隔 ${p.maxStreamGapMs ?? '-'} ms，流重置 ${p.streamResets}，WebSocket 重置 ${p.wsResets}${wsFail}，经过 ${p.vias.join('、') || '-'}`;
}

/** 时段是否有任何中断（重置、重连失败、短请求失败）。 */
export function periodImpacted(p: PeriodMetrics): boolean {
  return p.streamResets > 0 || p.wsResets > 0 || p.wsOpenFailures > 0 || p.shortOk < p.shortTotal;
}

/**
 * 提议摘要用的紧凑时段列表：对照时段与每个有中断的时段逐行列出，其余时段合并为一行，
 * 避免长时间运行（几十个动作）时被摘要长度上限截掉有影响的时段。
 */
export function summarizePeriods(periods: readonly PeriodMetrics[]): string[] {
  if (periods.length === 0) return [];
  const [baseline, ...rest] = periods;
  const impacted = rest.filter(periodImpacted);
  const clean = rest.filter((p) => !periodImpacted(p));
  const shorts = clean.reduce((n, p) => n + p.shortTotal, 0);
  return [
    formatPeriod(baseline!),
    ...impacted.map(formatPeriod),
    ...(clean.length > 0 ? [`其余 ${clean.length} 个时段没有重置、重连失败或短请求失败（短请求 ${shorts} 次）`] : []),
  ];
}

/** 中断样本：意外结束的流与 WebSocket、WebSocket 打开失败、失败的短请求。 */
function isImpact(s: Sample): boolean {
  return (s.kind === 'stream_end' && !s.expected) || (s.kind === 'ws_close' && !s.expected) || (s.kind === 'ws_open' && !s.ok) || (s.kind === 'short' && !s.ok);
}

/** 从第一次中断到各通道都恢复的时间：没有中断为 0；任一通道在窗口结束前未恢复为 null。 */
function recoveryAfter(samples: readonly Sample[], firstImpactAt: number | null): number | null {
  if (firstImpactAt === null) return 0;
  const channels: Array<{ fail: (s: Sample) => boolean; ok: (s: Sample) => boolean }> = [
    { fail: (s) => s.kind === 'short' && !s.ok, ok: (s) => s.kind === 'short' && s.ok },
    { fail: (s) => s.kind === 'stream_end' && !s.expected, ok: (s) => s.kind === 'stream' },
    { fail: (s) => (s.kind === 'ws_close' && !s.expected) || (s.kind === 'ws_open' && !s.ok), ok: (s) => s.kind === 'ws_open' && s.ok },
  ];
  let recoveredAt = firstImpactAt;
  for (const c of channels) {
    const fails = samples.filter(c.fail);
    if (fails.length === 0) continue;
    const lastFail = Math.max(...fails.map((s) => s.t));
    const back = samples.filter((s) => c.ok(s) && s.t > lastFail).map((s) => s.t);
    if (back.length === 0) return null;
    recoveredAt = Math.max(recoveredAt, Math.min(...back));
  }
  return recoveredAt - firstImpactAt;
}

export interface ReloadSignalEvidence {
  /** 配置 canary、引擎运行时长、临时规则或配置名信号判定发生了重新读取或重启。 */
  reloaded: boolean | null;
  /** Surge 进程启动时间变化：这是退出重开，不是同一配置重载。 */
  restarted: boolean;
  /**
   * 引擎运行时长回落（进程未变）：6.9.0 起 reload 在需要时“Automatically performs a full engine restart”，这是重载的影响，
   * 不是另一次重启。读不到运行时长为 null；旧调用方没有该字段。
   */
  engineRestarted?: boolean | null;
  reasons: string[];
}

export interface ReloadAssessment {
  marks: number[];
  /** 对照：观察开始到第一次重载标记前 leadMs。 */
  baseline: { from: number; to: number; shortTotal: number; issues: number };
  /** 整个观察窗口内的中断计数。 */
  window: { from: number; to: number; shortTotal: number; failedShorts: number; streamResets: number; wsResets: number; wsOpenFailures: number };
  firstImpactAt: number | null;
  recoveryMs: number | null;
  /** 观察期间除重载外的其他变更事件。 */
  otherEvents: string[];
  /** 对照至少 baselineMinMs 且没有任何中断；否则 null（无法归属）。 */
  baselineOk: boolean | null;
  /**
   * 确实发生了同一配置重载：信号判定重新读取（含升级为完整引擎重启），或第一次标记前 leadMs 之后出现中断；没有证据或
   * 检测到 Surge 进程重启为 null。
   */
  evidence: boolean | null;
  evidenceNote: string;
  /** 观察期间只有重载；有其他变更为 null。 */
  onlyReload: boolean | null;
  /** 其他应用不受影响；对照不干净、没有重载证据或混有其他变更时为 null（不能把“没有观察到”当作通过，也不能归属）。 */
  unaffected: boolean | null;
}

/**
 * 同一配置重载影响的整窗口评估。操作员在 Surge 菜单中重载与在终端输入标记之间有延迟，
 * 因此不按标记切段，而是把整个观察窗口内的中断都计入；第一次标记前 leadMs 之前必须是干净的对照。
 */
export function assessReload(
  samples: readonly Sample[],
  events: readonly MarkedEvent[],
  range: { start: number; end: number },
  opts: { leadMs: number; baselineMinMs: number; isReload: (label: string) => boolean; signals: ReloadSignalEvidence | null },
): ReloadAssessment {
  const inWindow = samples.filter((s) => s.t >= range.start && s.t <= range.end);
  const evs = events.filter((e) => e.t >= range.start && e.t <= range.end);
  const marks = evs.filter((e) => opts.isReload(e.label)).map((e) => e.t).sort((a, b) => a - b);
  const otherEvents = evs.filter((e) => !opts.isReload(e.label)).map((e) => e.label);
  const firstMark = marks[0] ?? null;
  const baselineTo = firstMark === null ? range.end : Math.max(range.start, firstMark - opts.leadMs);
  const base = inWindow.filter((s) => s.t < baselineTo);
  const baseShorts = base.filter((s) => s.kind === 'short').length;
  const baseIssues = base.filter(isImpact).length;
  const shorts = inWindow.filter((s) => s.kind === 'short');
  const impacts = inWindow.filter(isImpact);
  const firstImpactAt = impacts.length > 0 ? Math.min(...impacts.map((s) => s.t)) : null;
  const window = {
    from: range.start,
    to: range.end,
    shortTotal: shorts.length,
    failedShorts: shorts.filter((s) => !s.ok).length,
    streamResets: inWindow.filter((s) => s.kind === 'stream_end' && !s.expected).length,
    wsResets: inWindow.filter((s) => s.kind === 'ws_close' && !s.expected).length,
    wsOpenFailures: inWindow.filter((s) => s.kind === 'ws_open' && !s.ok).length,
  };
  const baselineOk = firstMark !== null && baselineTo - range.start >= opts.baselineMinMs && baseShorts > 0 && baseIssues === 0 ? true : null;
  const impactNearMark = firstMark !== null && impacts.some((s) => s.t >= baselineTo);
  const sig = opts.signals;
  let evidence: boolean | null = null;
  let evidenceNote: string;
  if (firstMark === null) evidenceNote = '没有重载标记';
  else if (sig?.restarted) evidenceNote = 'Surge 进程启动时间变化：这是重启，不是同一配置重载';
  else if (sig?.engineRestarted === true) {
    evidence = true;
    evidenceNote = `引擎运行时长回落：这次重载升级为完整引擎重启（全部连接关闭、临时规则清空）${sig.reasons.length > 0 ? `；${sig.reasons.join('、')}` : ''}`;
  } else if (sig?.reloaded === true) {
    evidence = true;
    evidenceNote = `重载信号：${sig.reasons.join('、')}`;
  } else if (impactNearMark) {
    evidence = true;
    evidenceNote = '标记附近出现连接中断';
  } else evidenceNote = sig === null ? '没有重载信号（未使用 --reload-test 布置配置 canary），也没有观察到中断：无法确认重载确实发生' : '重载信号未变化且没有观察到中断：无法确认重载确实发生';
  const impacted = impacts.length > 0;
  const onlyReload = otherEvents.length === 0 ? true : null;
  return {
    marks,
    baseline: { from: range.start, to: baselineTo, shortTotal: baseShorts, issues: baseIssues },
    window,
    firstImpactAt,
    recoveryMs: recoveryAfter(inWindow, firstImpactAt),
    otherEvents,
    baselineOk,
    evidence,
    evidenceNote,
    onlyReload,
    unaffected: baselineOk === true && evidence === true && onlyReload === true ? !impacted : null,
  };
}
