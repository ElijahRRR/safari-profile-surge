// safari_udp_quic_handling 的逐协议覆盖（纯函数）。每一项都来自测量，不写死“未测”：
// - http3_quic / http2：入口运行中 Safari 的 UDP 记录与 H3 测试主机回落的 TCP 记录；
// - ipv4 / http1：VERIFY_ONLY 下检测请求经 SFE-ROUTE、测试页在各模式下的回显；
// - ipv6：测试页轮询 IPv6 检测主机，Surge 中 Safari 对该主机的记录在 BLOCKED/VERIFY_ONLY 下被拒绝、ACTIVE 下经 SFE-ROUTE；
// - websocket：测试页 WebSocket 从 BLOCKED 到 VERIFY_ONLY 结束都建立不了，之后（ACTIVE）重新建立且首条消息经过目标节点；
// - extension_page_fetch：入口运行不直接测量。扩展页面请求与测试页请求出自同一 Safari 进程、访问同一检测主机，Surge 记录
//   无法区分；扩展「重新检测」在 P0 中由服务执行（独立节点预检，或服务读回不是 ACTIVE 时拒绝），不经过 Safari 入口，
//   不能作为证据。只能由归属测试的扩展步骤（扩展页面自己请求检测服务、按进程路径归属）补足。
// 入口运行中没有直接观察到的非 UDP 项，只在同一进程路径、结论为通过的 safari_process_attribution 中
// 该项为 pass/limitation 时，记为 limitation 并写明来源（入口规则按进程路径匹配，归属证明该协议来自同一路径）；
// 否则为 not_tested 并写明缺什么。

import type { KnownEntryMode, ProtocolCoverage, ProtocolCoverageItem } from '@sfe/contract';
import type { Verdict } from '../results.js';
import type { Outcome } from './entry-window.js';

/** 入口运行中一个模式的观察窗口：from 为该模式读回确认的时刻（切换在此之前已生效），to 为停留结束。 */
export interface ModeWindow {
  mode: KnownEntryMode;
  from: number;
  to: number;
}

/** 测试页上报的事件（时间为页面自己的时钟）。 */
export interface PageEventAt {
  t: number;
  kind: string;
  ok: boolean;
  via?: string | null;
}

/**
 * 测试页 WebSocket 的测量。
 * - 阻断期：从 BLOCKED 确认后 settleMs 起，到 VERIFY_ONLY 结束（含两者之间的切换）；期间成功建立即不通过。
 *   开头留 settleMs：握手在切换生效前已开始的连接可能稍后才报告建立。
 * - ACTIVE：VERIFY_ONLY 结束之后到 ACTIVE 结束之间建立的连接，取其首条消息经过的节点。不加稳定时间：VERIFY_ONLY 下
 *   REJECT 让测试页每 2 秒重试一次，ACTIVE 生效后的第一次重试通常就在读回确认后 2 秒内建立，并且之后一直保持，
 *   加稳定时间会把唯一一次建立滤掉。切换途中建立的连接也算在内（经过的节点不对同样不通过）。
 */
export function websocketEvidence(windows: readonly ModeWindow[], events: readonly PageEventAt[], settleMs: number): UdpCoverageInput['websocket'] {
  const w = (mode: KnownEntryMode): ModeWindow | undefined => windows.find((x) => x.mode === mode);
  const blocked = w('BLOCKED');
  const verify = w('VERIFY_ONLY');
  const active = w('ACTIVE');
  const firstBlocked = blocked ?? verify;
  const lastBlocked = verify ?? blocked;
  const opensWhileBlocked = firstBlocked && lastBlocked ? events.filter((e) => e.kind === 'ws_open' && e.ok && e.t >= firstBlocked.from + settleMs && e.t <= lastBlocked.to).length : 0;
  const activeFrom = verify?.to ?? active?.from;
  const activeVias =
    active && activeFrom !== undefined ? events.filter((e) => e.kind === 'ws_first' && e.t > activeFrom && e.t <= active.to).map((e) => e.via ?? null) : [];
  return { opensWhileBlocked, activeVias };
}

export interface UdpCoverageInput {
  /** VERIFY_ONLY 与 ACTIVE 下 Safari 的 UDP 记录数与其中被拒绝的数量。 */
  udp: { total: number; rejected: number };
  /** 操作员在 H3 测试页看到的协议。 */
  h3Observed: string | null;
  /** ACTIVE 下 H3 测试主机的 TCP 记录数与其中经 SFE-ROUTE 的数量。 */
  h3Tcp: { total: number; routed: number };
  /** VERIFY_ONLY 下检测服务（IPv4）请求经 SFE-ROUTE 的记录数。 */
  verifyRouted: number;
  /** 测试页 HTTP/1.1 回显：BLOCKED/VERIFY_ONLY 下全部失败、ACTIVE 下成功且经过目标节点（null：没有上报）。 */
  echoExpect: boolean | null;
  /** Safari 对 IPv6 检测主机的记录（按所在模式）与 NORMAL 下测试页 IPv6 检测的结果。 */
  ipv6: { records: ReadonlyArray<{ mode: KnownEntryMode; outcome: Outcome | null }>; normalPage: { total: number; ok: number } };
  /** 测试页 WebSocket（见 websocketEvidence）：阻断期成功建立的次数；VERIFY_ONLY 之后每次建立的首条消息经过的节点。 */
  websocket: { opensWhileBlocked: number; activeVias: ReadonlyArray<string | null> };
  /** ACTIVE 下应经过的测试节点（回显的 via）。 */
  expectedVia: string;
  /** 本次入口运行的进程路径摘要。 */
  processPathsDigest: string | null;
  /** 同一运行目录中的 safari_process_attribution 结果。 */
  attribution: { verdict: Verdict; processPathsDigest: string | null; coverage: ProtocolCoverage | undefined } | null;
}

type Entry = NonNullable<ProtocolCoverage[ProtocolCoverageItem]>;

/** 入口运行中没有直接观察到的项：只能由同一进程路径、结论为通过的归属结果补足（记为 limitation 并写明来源）。 */
function fromAttribution(input: UdpCoverageInput, item: ProtocolCoverageItem, missing: string): Entry {
  const a = input.attribution;
  if (!a) return { result: 'not_tested', note: `${missing}；也没有 safari_process_attribution 结果` };
  if (a.verdict !== 'pass') return { result: 'not_tested', note: `${missing}；safari_process_attribution 结论不是通过，不能借用` };
  if (a.processPathsDigest === null || a.processPathsDigest !== input.processPathsDigest) return { result: 'not_tested', note: `${missing}；safari_process_attribution 的进程路径与本次入口运行不同` };
  const c = a.coverage?.[item];
  if (!c || (c.result !== 'pass' && c.result !== 'limitation')) return { result: 'not_tested', note: `${missing}；归属测试中该项为 ${c?.result ?? 'not_tested'}` };
  return { result: 'limitation', note: `${missing}；由 safari_process_attribution 覆盖（同一进程路径，归属 ${c.result}${c.note ? `：${c.note}` : ''}），入口规则按进程路径匹配` };
}

export function udpQuicCoverage(input: UdpCoverageInput): ProtocolCoverage {
  const out: ProtocolCoverage = {};
  // HTTP/3（QUIC）与回落的 HTTP/2：本能力的核心，只接受直接测量。
  out.http3_quic =
    input.udp.total === 0
      ? { result: 'not_tested', note: input.h3Observed === 'http/3' ? '页面显示 HTTP/3 但 Surge 没有 Safari 的 UDP 记录' : 'Safari 没有发起 QUIC' }
      : { result: input.udp.rejected === input.udp.total && input.h3Observed !== 'http/3' ? 'pass' : 'fail', note: `UDP ${input.udp.rejected}/${input.udp.total} 条被拒绝；页面 ${input.h3Observed ?? '未记录'}` };
  out.http2 =
    input.h3Tcp.total === 0
      ? { result: 'not_tested', note: 'ACTIVE 下没有 H3 测试主机的 TCP 记录' }
      : { result: input.h3Tcp.routed === input.h3Tcp.total ? 'pass' : 'fail', note: `回落 TCP ${input.h3Tcp.routed}/${input.h3Tcp.total} 条经 SFE-ROUTE` };
  out.ipv4 = input.verifyRouted > 0 ? { result: 'pass', note: 'VERIFY_ONLY 下 IPv4 检测请求经 SFE-ROUTE，UDP 未放行' } : fromAttribution(input, 'ipv4', 'VERIFY_ONLY 下没有经 SFE-ROUTE 的 IPv4 检测请求');
  out.http1 =
    input.echoExpect === true
      ? { result: 'pass', note: 'HTTP/1.1 回显在 ACTIVE 下经 SFE-ROUTE，BLOCKED/VERIFY_ONLY 下被拒绝' }
      : input.echoExpect === false
        ? { result: 'fail', note: '测试页 HTTP/1.1 回显与各模式的预期不符' }
        : fromAttribution(input, 'http1', '测试页没有上报回显');

  // IPv6：BLOCKED/VERIFY_ONLY 下必须被拒绝，ACTIVE 下必须经 SFE-ROUTE，且 ACTIVE 下至少有一条。
  const v6 = input.ipv6.records.filter((r) => r.mode !== 'NORMAL');
  const v6Bad = v6.filter((r) => (r.mode === 'ACTIVE' ? r.outcome !== 'route' : r.outcome !== 'reject') && r.outcome !== null);
  const v6Active = v6.filter((r) => r.mode === 'ACTIVE' && r.outcome === 'route');
  const v6Blocked = v6.filter((r) => r.mode !== 'ACTIVE' && r.outcome === 'reject');
  const noIpv6 = v6.length === 0 && input.ipv6.normalPage.total > 0 && input.ipv6.normalPage.ok === 0;
  if (v6Bad.length > 0) out.ipv6 = { result: 'fail', note: `IPv6 检测请求 ${v6Bad.length} 条结果与模式不符（BLOCKED/VERIFY_ONLY 应拒绝，ACTIVE 应经 SFE-ROUTE）` };
  else if (v6Active.length > 0) out.ipv6 = { result: 'pass', note: `IPv6 检测请求 ACTIVE 下 ${v6Active.length} 条经 SFE-ROUTE，BLOCKED/VERIFY_ONLY 下 ${v6Blocked.length} 条被拒绝` };
  else if (noIpv6) out.ipv6 = { result: 'limitation', note: `测试网络没有 IPv6 连通（NORMAL 下 IPv6 检测 ${input.ipv6.normalPage.total} 次全部失败），IPv6 入口处理未能验证` };
  else out.ipv6 = fromAttribution(input, 'ipv6', 'ACTIVE 下没有 Safari 的 IPv6 检测记录');

  // WebSocket：BLOCKED/VERIFY_ONLY 下建立即不通过；ACTIVE 下建立且首条消息经过目标节点为通过。
  const ws = input.websocket;
  if (ws.opensWhileBlocked > 0) out.websocket = { result: 'fail', note: `BLOCKED/VERIFY_ONLY 下 Safari 测试页仍建立了 ${ws.opensWhileBlocked} 次 WebSocket` };
  else if (ws.activeVias.length > 0) {
    const ok = ws.activeVias.every((v) => v === input.expectedVia);
    out.websocket = { result: ok ? 'pass' : 'fail', note: `ACTIVE 下 WebSocket 建立 ${ws.activeVias.length} 次，经过 ${[...new Set(ws.activeVias.map((v) => v ?? '未知'))].join('、')}` };
  } else out.websocket = fromAttribution(input, 'websocket', 'VERIFY_ONLY 结束后测试页没有建立新的 WebSocket（或没有收到首条消息）');

  // 扩展页面请求：入口运行中与测试页请求无法区分，只能由归属测试的扩展步骤补足（见文件开头）。
  out.extension_page_fetch = fromAttribution(input, 'extension_page_fetch', '入口运行不直接测量扩展页面请求（与测试页同一进程、同一检测主机，Surge 记录无法区分）');

  out.webrtc = { result: 'limitation', note: '本命令未测 WebRTC' };
  out.dns = { result: 'limitation', note: 'DNS 由系统解析，不按 Safari 进程归属' };
  out.system_services = { result: 'limitation', note: '系统服务不在 Safari 进程入口覆盖内' };
  return out;
}
