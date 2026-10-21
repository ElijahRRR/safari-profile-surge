// Safari 精确进程归属的分析（纯函数）。输入是各引导步骤时间窗内 Surge 记录到的测试相关请求与测试页上报，
// 输出候选路径（只在 Safari 步骤中出现、从未在 Chrome/其他 WebKit 应用步骤中出现）与逐协议覆盖。
// 候选路径还必须通过服务的同一套校验（绝对路径、存在、无通配、非系统通用 WebKit 框架路径）。

import { GATING_COVERAGE_ITEMS, type FieldError, type ProtocolCoverage, type ProtocolCoverageItem } from '@sfe/contract';
import { coverageAllowsSupported, validateSafariProcessPaths } from '../deps.js';
import { check, type CheckItem } from '../results.js';

export type AttributionApp = 'safari' | 'safari-extension' | 'chrome' | 'other';

export interface AttributionRecord {
  app: AttributionApp;
  processPath: string | null;
  /** 测试相关主机；其他主机记为 null（不保存浏览记录）。 */
  host: string | null;
  protocol: 'tcp' | 'udp' | null;
  policy: string | null;
}

export interface PageEvent {
  app: string;
  kind: string;
  ok: boolean;
  ipVersion?: number | null;
  srflx?: number;
}

export interface AttributionHosts {
  echo: string;
  ipv4: string;
  ipv6: string;
  h3: string;
  /** 扩展准备页请求的检测服务主机。 */
  verify: readonly string[];
  stun: string;
}

export interface AttributionInput {
  records: readonly AttributionRecord[];
  hosts: AttributionHosts;
  pageEvents: readonly PageEvent[];
  /** 操作员在 HTTP/3 测试页看到的协议（http/3、http/2）；未测为 null。 */
  h3Observed: string | null;
  /** 跳过的步骤。 */
  skipped: readonly AttributionApp[];
  exists?: (path: string) => boolean;
}

export interface AttributionResult {
  perApp: Record<AttributionApp, string[]>;
  candidates: string[];
  conflicts: string[];
  invalid: FieldError[];
  /** Safari 步骤中出现、但不是候选的 Safari/WebKit 相关进程（系统服务等）。 */
  otherSafariRelated: string[];
  coverage: ProtocolCoverage;
  checks: CheckItem[];
}

const APPS: readonly AttributionApp[] = ['safari', 'safari-extension', 'chrome', 'other'];

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function analyzeAttribution(input: AttributionInput): AttributionResult {
  const h = (s: string): string => s.toLowerCase();
  const testHosts = new Set([input.hosts.echo, input.hosts.ipv4, input.hosts.ipv6, input.hosts.h3, input.hosts.stun, ...input.hosts.verify].map(h));
  const perApp = Object.fromEntries(APPS.map((a) => [a, [] as string[]])) as Record<AttributionApp, string[]>;
  for (const app of APPS) {
    perApp[app] = uniq(
      input.records.filter((r) => r.app === app && r.processPath !== null && r.host !== null && testHosts.has(h(r.host))).map((r) => r.processPath!),
    );
  }
  const safariPaths = uniq([...perApp.safari, ...perApp['safari-extension']]);
  const foreign = new Set([...perApp.chrome, ...perApp.other]);
  const conflicts = safariPaths.filter((p) => foreign.has(p));
  const candidates = safariPaths.filter((p) => !foreign.has(p));
  const invalid = candidates.length > 0 ? validateSafariProcessPaths(candidates, input.exists ? { exists: input.exists } : {}) : [];
  const otherSafariRelated = uniq(
    input.records
      .filter((r) => (r.app === 'safari' || r.app === 'safari-extension') && r.processPath !== null && !candidates.includes(r.processPath) && /safari|webkit/i.test(r.processPath))
      .map((r) => r.processPath!),
  );

  const safariRecs = (host: string, proto?: 'tcp' | 'udp', apps: readonly AttributionApp[] = ['safari']): AttributionRecord[] =>
    input.records.filter((r) => apps.includes(r.app) && r.host !== null && h(r.host) === h(host) && (proto === undefined || r.protocol === proto));
  const allCandidates = (recs: readonly AttributionRecord[]): boolean => recs.length > 0 && recs.every((r) => r.processPath !== null && candidates.includes(r.processPath));
  const page = (app: string, kind: string): PageEvent[] => input.pageEvents.filter((e) => e.app === app && e.kind === kind);

  const coverage: ProtocolCoverage = {};
  const set = (item: ProtocolCoverageItem, result: 'pass' | 'fail' | 'limitation' | 'not_tested', note: string | null): void => {
    coverage[item] = { result, note };
  };
  const fromRecords = (item: ProtocolCoverageItem, recs: AttributionRecord[], label: string): void => {
    if (recs.length === 0) set(item, 'not_tested', `Surge 中没有 Safari ${label} 的记录`);
    else if (allCandidates(recs)) set(item, 'pass', `${recs.length} 条记录均来自候选路径`);
    else set(item, 'fail', `${label} 有记录来自非候选进程`);
  };

  // IPv4：检测服务（只有 IPv4）
  const v4 = safariRecs(input.hosts.ipv4, 'tcp');
  fromRecords('ipv4', v4, 'IPv4 检测');
  if (coverage.ipv4?.result === 'pass' && !page('safari', 'ipv4').some((e) => e.ok && e.ipVersion === 4)) set('ipv4', 'not_tested', '测试页未报告 IPv4 成功');
  // IPv6：只有 IPv6 的检测主机；没有 IPv6 连通时写成限制。
  const v6 = safariRecs(input.hosts.ipv6, 'tcp');
  const v6Page = page('safari', 'ipv6');
  if (v6.length === 0 && v6Page.length > 0 && v6Page.every((e) => !e.ok)) set('ipv6', 'limitation', '测试网络没有 IPv6 连通，IPv6 归属未能验证');
  else fromRecords('ipv6', v6, 'IPv6 检测');
  fromRecords('http1', safariRecs(input.hosts.echo, 'tcp'), 'HTTP/1.1 回显');
  fromRecords('http2', safariRecs(input.hosts.h3, 'tcp'), 'HTTP/2（H3 测试主机首个 TCP 连接）');
  const quic = safariRecs(input.hosts.h3, 'udp');
  if (quic.length > 0) fromRecords('http3_quic', quic, 'HTTP/3 QUIC');
  else if (input.h3Observed === 'http/3') set('http3_quic', 'fail', '页面显示 HTTP/3，但 Surge 中没有 Safari 的 UDP 记录：QUIC 流量未经 Surge 或归属其他进程');
  else set('http3_quic', 'not_tested', 'Safari 没有使用 HTTP/3（页面未显示 http/3）');
  const wsOk = page('safari', 'ws_open').some((e) => e.ok);
  if (!wsOk) set('websocket', 'not_tested', '测试页未报告 WebSocket 连接');
  else fromRecords('websocket', safariRecs(input.hosts.echo, 'tcp'), 'WebSocket（回显主机）');
  if (input.skipped.includes('safari-extension')) set('extension_page_fetch', 'not_tested', '扩展步骤已跳过');
  else {
    const ext = input.records.filter((r) => r.app === 'safari-extension' && r.host !== null && input.hosts.verify.map(h).includes(h(r.host)));
    fromRecords('extension_page_fetch', ext, '扩展页面检测请求');
  }
  // 不作为门槛的项：只记录。
  const stun = safariRecs(input.hosts.stun, 'udp');
  if (stun.length > 0) set('webrtc', allCandidates(stun) ? 'pass' : 'limitation', allCandidates(stun) ? 'STUN UDP 来自候选路径' : 'STUN UDP 有记录来自非候选进程');
  else set('webrtc', 'limitation', page('safari', 'webrtc').length > 0 ? 'WebRTC 的 UDP 未出现在 Surge 记录中（可能不经 Surge）' : 'WebRTC 未测试');
  set('dns', 'limitation', 'DNS 由系统 mDNSResponder 解析，不按 Safari 进程归属');
  set('system_services', 'limitation', otherSafariRelated.length > 0 ? `Safari 步骤中另有 ${otherSafariRelated.length} 个 Safari/WebKit 相关系统进程，不在入口规则覆盖内` : '未观察到其他 Safari 相关系统进程');

  const chromeSeen = input.records.some((r) => r.app === 'chrome');
  const otherSeen = input.records.some((r) => r.app === 'other');
  const gating = coverageAllowsSupported(coverage);
  const checks: CheckItem[] = [
    check('找到 Safari 进程路径', candidates.length > 0, candidates.length > 0 ? `${candidates.length} 个候选` : '没有只属于 Safari 的路径'),
    check('Chrome 不命中候选路径', input.skipped.includes('chrome') || !chromeSeen ? null : !perApp.chrome.some((p) => safariPaths.includes(p)), chromeSeen ? '' : 'Chrome 步骤没有记录'),
    check('其他 WebKit 应用不命中候选路径', input.skipped.includes('other') || !otherSeen ? null : !perApp.other.some((p) => safariPaths.includes(p)), otherSeen ? '' : '其他 WebKit 应用步骤没有记录'),
    check('候选路径通过服务校验', candidates.length === 0 ? null : invalid.length === 0, invalid.map((e) => e.message).join('；')),
    check('门槛协议逐项通过或写明限制', gating.ok ? true : GATING_COVERAGE_ITEMS.some((i) => coverage[i]?.result === 'fail') ? false : null, gating.ok ? '' : `未完成：${gating.missing.join('、')}`),
  ];
  return { perApp, candidates, conflicts, invalid, otherSafariRelated, coverage, checks };
}
