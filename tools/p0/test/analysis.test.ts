import { ENTRY_MODE_BITS, type ProtocolCoverage } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { analyzeAttribution, type AttributionInput, type AttributionRecord } from '../src/analysis/attribution.js';
import { analyzeContinuity, formatPeriod, percentile, summarizePeriods, type Sample } from '../src/analysis/continuity.js';
import { analyzeEntryWindow, candidateBits, expectedOutcome, outcomeOf, type EntryTimeline } from '../src/analysis/entry-window.js';
import { compareSignals, type ReloadSignals } from '../src/analysis/reload.js';
import { classOf, isEntryRule, judgeMatchMatrix, matchProbes, outcomeOfPolicy, type MatchRecord } from '../src/analysis/rule-match.js';
import { udpQuicCoverage, websocketEvidence, type ModeWindow, type UdpCoverageInput } from '../src/analysis/udp-coverage.js';
import { coverageAllowsSupported, planEntryTransition } from '../src/deps.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VERIFY = 'api.ipify.org';

describe('entry window analysis', () => {
  it('classifies outcomes by policy', () => {
    expect(outcomeOf('REJECT')).toBe('reject');
    expect(outcomeOf('reject-drop')).toBe('reject');
    expect(outcomeOf('SFE-ROUTE')).toBe('route');
    expect(outcomeOf('DIRECT')).toBe('pass');
    expect(outcomeOf('Daily')).toBe('pass');
    expect(outcomeOf(null)).toBeNull();
  });

  it('derives expected outcomes per mode', () => {
    const b = ENTRY_MODE_BITS;
    expect(expectedOutcome(b.NORMAL, 'tcp', false)).toBe('pass');
    expect(expectedOutcome(b.BLOCKED, 'tcp', true)).toBe('reject');
    expect(expectedOutcome(b.VERIFY_ONLY, 'tcp', true)).toBe('route');
    expect(expectedOutcome(b.VERIFY_ONLY, 'tcp', false)).toBe('reject');
    expect(expectedOutcome(b.VERIFY_ONLY, 'udp', true)).toBe('reject');
    expect(expectedOutcome(b.ACTIVE, 'tcp', false)).toBe('route');
    expect(expectedOutcome(b.ACTIVE, 'udp', false)).toBe('reject');
  });

  function timelineFor(): EntryTimeline {
    // NORMAL → BLOCKED，每步 10 ms 写入窗口，从 t=1000 开始。
    const steps = planEntryTransition('NORMAL', 'BLOCKED');
    let t = 1000;
    let before = ENTRY_MODE_BITS.NORMAL;
    return {
      initial: before,
      steps: steps.map((s) => {
        const step = { from: t, to: t + 10, before, after: s.bits };
        before = s.bits;
        t += 10;
        return step;
      }),
    };
  }

  it('accepts either adjacent state inside a write window', () => {
    const tl = timelineFor();
    expect(candidateBits(tl, 1005, 0)).toHaveLength(2);
    expect(candidateBits(tl, 5000, 0)).toEqual([ENTRY_MODE_BITS.BLOCKED]);
    expect(candidateBits(tl, 10, 0)).toEqual([ENTRY_MODE_BITS.NORMAL]);
  });

  it('flags a pass after BLOCKED is confirmed and ignores other apps', () => {
    const tl = timelineFor();
    const r = analyzeEntryWindow(
      tl,
      [
        { at: 900, processPath: SAFARI, host: 'a.example.test', protocol: 'tcp', policy: 'DIRECT' },
        { at: 1005, processPath: SAFARI, host: 'a.example.test', protocol: 'tcp', policy: 'DIRECT' },
        { at: 4000, processPath: SAFARI, host: 'a.example.test', protocol: 'tcp', policy: 'REJECT' },
        { at: 4100, processPath: SAFARI, host: 'a.example.test', protocol: 'tcp', policy: 'DIRECT' },
        { at: 4200, processPath: CHROME, host: 'a.example.test', protocol: 'tcp', policy: 'DIRECT' },
        { at: 4300, processPath: SAFARI, host: 'a.example.test', protocol: 'tcp', policy: null },
      ],
      { processPaths: [SAFARI], verifyHost: VERIFY, graceMs: 0, from: 0, to: 10_000 },
    );
    expect(r.checked).toBe(4);
    expect(r.unclassified).toBe(1);
    expect(r.violations).toEqual([{ at: 4100, target: 'other', protocol: 'tcp', outcome: 'pass', allowed: ['reject'] }]);
  });

  it('flags non-verify routing during VERIFY_ONLY and UDP passes', () => {
    const tl: EntryTimeline = { initial: ENTRY_MODE_BITS.VERIFY_ONLY, steps: [] };
    const r = analyzeEntryWindow(
      tl,
      [
        { at: 1, processPath: SAFARI, host: VERIFY, protocol: 'tcp', policy: 'SFE-ROUTE' },
        { at: 2, processPath: SAFARI, host: 'shop.example.test', protocol: 'tcp', policy: 'SFE-ROUTE' },
        { at: 3, processPath: SAFARI, host: VERIFY, protocol: 'udp', policy: 'DIRECT' },
      ],
      { processPaths: [SAFARI], verifyHost: VERIFY, from: 0, to: 10 },
    );
    expect(r.violations.map((v) => [v.target, v.protocol, v.outcome])).toEqual([
      ['other', 'tcp', 'route'],
      ['verify', 'udp', 'pass'],
    ]);
  });

  it('every planned transition is violation free when Surge follows the bits', () => {
    for (const from of ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'] as const) {
      for (const to of ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'] as const) {
        const steps = planEntryTransition(from, to);
        let before = ENTRY_MODE_BITS[from];
        const tl: EntryTimeline = { initial: before, steps: [] };
        const reqs = [];
        let t = 100;
        for (const s of steps) {
          tl.steps.push({ from: t, to: t + 10, before, after: s.bits });
          for (const host of [VERIFY, 'x.example.test']) {
            for (const protocol of ['tcp', 'udp'] as const) {
              const out = expectedOutcome(s.bits, protocol, host === VERIFY);
              reqs.push({ at: t + 50, processPath: SAFARI, host, protocol, policy: out === 'reject' ? 'REJECT' : out === 'route' ? 'SFE-ROUTE' : 'DIRECT' });
            }
          }
          before = s.bits;
          t += 100;
        }
        expect(analyzeEntryWindow(tl, reqs, { processPaths: [SAFARI], verifyHost: VERIFY, graceMs: 0, from: 0, to: t }).violations).toEqual([]);
      }
    }
  });
});

describe('attribution analysis', () => {
  const hosts = { echo: 'echo.p0.example.test', ipv4: VERIFY, ipv6: 'api6.ipify.org', h3: 'cloudflare-quic.com', verify: [VERIFY, 'api64.ipify.org'], stun: 'stun.l.google.com' };
  const rec = (app: AttributionRecord['app'], processPath: string, host: string | null, protocol: 'tcp' | 'udp' = 'tcp'): AttributionRecord => ({ app, processPath, host, protocol, policy: 'DIRECT' });
  const base = (records: AttributionRecord[], over: Partial<AttributionInput> = {}): AttributionInput => ({
    records,
    hosts,
    pageEvents: [
      { app: 'safari', kind: 'ipv4', ok: true, ipVersion: 4 },
      { app: 'safari', kind: 'ipv6', ok: true, ipVersion: 6 },
      { app: 'safari', kind: 'ws_open', ok: true },
    ],
    h3Observed: 'http/3',
    skipped: [],
    exists: () => true,
    ...over,
  });

  const full = [
    rec('safari', SAFARI, hosts.echo),
    rec('safari', SAFARI, VERIFY),
    rec('safari', SAFARI, hosts.ipv6),
    rec('safari', SAFARI, hosts.h3),
    rec('safari', SAFARI, hosts.h3, 'udp'),
    rec('safari-extension', SAFARI, VERIFY),
    rec('chrome', CHROME, hosts.echo),
    rec('chrome', CHROME, VERIFY),
    rec('other', '/Applications/Mail.app/Contents/MacOS/Mail', hosts.echo),
  ];

  it('proposes Safari-only paths with full gating coverage', () => {
    const r = analyzeAttribution(base(full));
    expect(r.candidates).toEqual([SAFARI]);
    expect(r.conflicts).toEqual([]);
    expect(r.checks.every((c) => c.ok === true)).toBe(true);
    for (const item of ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch'] as const) expect(r.coverage[item]?.result).toBe('pass');
    expect(r.coverage.dns?.result).toBe('limitation');
  });

  it('excludes paths shared with Chrome or other WebKit apps', () => {
    const shared = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
    const r = analyzeAttribution(base([...full, rec('safari', shared, hosts.echo), rec('other', shared, hosts.echo)]));
    expect(r.conflicts).toEqual([shared]);
    expect(r.candidates).toEqual([SAFARI]);
    expect(r.coverage.http1?.result).toBe('fail');
    expect(r.checks.find((c) => c.name.includes('其他 WebKit'))?.ok).toBe(false);
  });

  it('rejects generic WebKit framework paths through the service validation', () => {
    const generic = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
    const r = analyzeAttribution(base(full.map((x) => (x.app.startsWith('safari') ? { ...x, processPath: generic } : x))));
    expect(r.candidates).toEqual([generic]);
    expect(r.invalid.length).toBeGreaterThan(0);
    expect(r.checks.find((c) => c.name.includes('服务校验'))?.ok).toBe(false);
  });

  it('marks QUIC as failed when the page used HTTP/3 but Surge saw no Safari UDP', () => {
    const r = analyzeAttribution(base(full.filter((x) => x.protocol !== 'udp')));
    expect(r.coverage.http3_quic?.result).toBe('fail');
  });

  it('records missing IPv6 connectivity as a limitation', () => {
    const r = analyzeAttribution(
      base(full.filter((x) => x.host !== hosts.ipv6), { pageEvents: [{ app: 'safari', kind: 'ipv6', ok: false }, { app: 'safari', kind: 'ipv4', ok: true, ipVersion: 4 }, { app: 'safari', kind: 'ws_open', ok: true }] }),
    );
    expect(r.coverage.ipv6).toEqual({ result: 'limitation', note: expect.stringContaining('IPv6') });
  });

  it('leaves Chrome check incomplete when the Chrome step was skipped', () => {
    const r = analyzeAttribution(base(full.filter((x) => x.app !== 'chrome'), { skipped: ['chrome'] }));
    expect(r.checks.find((c) => c.name.includes('Chrome'))?.ok).toBeNull();
  });

  it('control checks need test-host records from the control app, not background WebKit traffic', () => {
    // 其他 WebKit 应用没有访问测试主机，只有同一时间窗内的 Safari/WebKit 后台请求（主机记为 null）。
    const webkitBg = '/System/Volumes/Preboot/Cryptexes/App/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
    const r = analyzeAttribution(base([...full.filter((x) => x.app !== 'other'), rec('other', webkitBg, null)]));
    const other = r.checks.find((c) => c.name.includes('其他 WebKit'))!;
    expect(other.ok).toBeNull();
    expect(other.note).toContain('没有测试主机记录');
    expect(r.checks.find((c) => c.name.includes('Chrome'))?.ok).toBe(true);
    const chromeOnlyBg = analyzeAttribution(base([...full.filter((x) => x.app !== 'chrome'), rec('chrome', SAFARI, null)]));
    expect(chromeOnlyBg.checks.find((c) => c.name.includes('Chrome'))?.ok).toBeNull();
  });

  it('ignores non-test hosts but reports other Safari-related processes', () => {
    const svc = '/System/Library/PrivateFrameworks/SafariSafeBrowsing.framework/com.apple.Safari.SafeBrowsing.Service';
    const r = analyzeAttribution(base([...full, rec('safari', svc, null)]));
    expect(r.candidates).toEqual([SAFARI]);
    expect(r.otherSafariRelated).toEqual([svc]);
  });
});

describe('continuity analysis', () => {
  const samples = (): Sample[] => {
    const out: Sample[] = [];
    for (let t = 0; t < 100; t += 1) out.push({ t: t * 1000, kind: 'short', ok: !(t >= 60 && t < 63), ms: 10 + (t % 5), via: 'p0-plain' });
    for (let t = 0; t < 100; t += 1) if (t < 60 || t > 64) out.push({ t: t * 1000 + 500, kind: 'stream', ok: true, via: 'p0-plain' });
    out.push({ t: 60_500, kind: 'stream_end', ok: false, reason: 'reset' });
    out.push({ t: 99_900, kind: 'ws_close', ok: false, expected: true });
    return out;
  };

  it('splits periods by events and measures impact and recovery', () => {
    const r = analyzeContinuity(samples(), [{ t: 30_000, label: 'refresh', source: 'action' }, { t: 59_500, label: 'reload', source: 'operator' }], { start: 0, end: 100_000 });
    expect(r.periods.map((p) => p.label)).toEqual(['对照（未执行变更）', 'refresh', 'reload']);
    expect(r.periods[0]!.shortOk).toBe(30);
    expect(r.periods[1]!.streamResets).toBe(0);
    expect(r.periods[2]!.streamResets).toBe(1);
    expect(r.periods[2]!.wsResets).toBe(0);
    expect(r.periods[2]!.maxStreamGapMs).toBe(6000);
    const reload = r.impacts.find((i) => i.label === 'reload')!;
    expect(reload.failedShorts).toBe(3);
    expect(reload.recoveryMs).toBe(3500);
    expect(r.impacts.find((i) => i.label === 'refresh')!.recoveryMs).toBe(0);
    expect(formatPeriod(r.periods[0]!)).toContain('短请求 30/30');
  });

  it('computes percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });
});

describe('reload signals', () => {
  const s = (over: Partial<ReloadSignals> = {}): ReloadSignals => ({
    at: 'x',
    profileCanaryLoaded: false,
    surgeStart: 'S@1',
    engineUptimeSeconds: 100,
    tempRules: ['r1'],
    profileName: 'SFE-P0-测试',
    ...over,
  });

  it('reports no reload only when the profile canary was definitely not read', () => {
    expect(compareSignals(s(), s({ engineUptimeSeconds: 130 }))).toEqual({ reloaded: false, reasons: [], processRestarted: false, engineRestarted: false });
    expect(compareSignals(s(), s({ profileCanaryLoaded: null })).reloaded).toBeNull();
  });

  it('detects profile canary reads, process and engine restarts, lost temp rules and profile changes', () => {
    expect(compareSignals(s(), s({ profileCanaryLoaded: true })).reasons).toEqual(['配置 canary 已被重新读取（发生了配置重载）']);
    const proc = compareSignals(s(), s({ surgeStart: 'S@2' }));
    expect(proc.reasons[0]).toContain('重启');
    expect(proc.processRestarted).toBe(true);
    expect(compareSignals(s(), s({ tempRules: [] })).reasons[0]).toContain('临时规则');
    expect(compareSignals(s(), s({ profileName: '其他' })).reloaded).toBe(true);
  });

  it('an engine-only restart (6.9+ reload may escalate to it) shows as falling uptime with the same process start', () => {
    const c = compareSignals(s(), s({ engineUptimeSeconds: 3, tempRules: [] }));
    expect(c).toMatchObject({ reloaded: true, processRestarted: false, engineRestarted: true });
    expect(c.reasons).toContain('引擎运行时长回落（引擎重启）');
    // 运行时长读不到时不判定重启（未知），也不当作“未重载”的证据之外的结论
    expect(compareSignals(s(), s({ engineUptimeSeconds: null })).engineRestarted).toBeNull();
  });
});

describe('rule match matrix', () => {
  const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const probes = matchProbes({ processPaths: [SAFARI], controlPaths: [CHROME, SAFARI], verifyHost: 'api.ipify.org', otherHosts: ['echo.p0.example.test'] });
  const rec = (mode: MatchRecord['mode'], p: (typeof probes)[number], rule: string | null, policy: string | null): MatchRecord => ({ ...p, mode, rule, policy, error: rule === null ? 'SURGE_COMMAND_FAILED' : null });
  const udp = `AND,((PROCESS-NAME,${SAFARI}),(PROTOCOL,UDP)),REJECT`;
  const active = `AND,((PROCESS-NAME,${SAFARI}),(NOT,((PROTOCOL,UDP)))),SFE-ROUTE`;

  it('probes Safari and each control path (never a Safari path as control) × verify/other host × TCP/UDP/QUIC; QUIC counts as UDP', () => {
    expect(probes).toHaveLength(12);
    expect(probes.filter((p) => !p.safari).every((p) => p.processPath === CHROME)).toBe(true);
    expect(classOf({ protocol: 'QUIC', verify: true })).toBe('udpVerify');
    expect(classOf({ protocol: 'TCP', verify: false })).toBe('tcpOther');
    expect(isEntryRule('RULE-SET,sfe-entry-udp.list,REJECT', [SAFARI])).toBe(true);
    expect(isEntryRule('FINAL,DIRECT', [SAFARI])).toBe(false);
    expect(outcomeOfPolicy('REJECT-DROP')).toBe('reject');
    expect(outcomeOfPolicy('SFE-N-P0-A')).toBe('route');
    expect(outcomeOfPolicy('DIRECT')).toBe('pass');
  });

  it('ACTIVE: UDP and QUIC rejected by our rule, TCP routed by our rule, Chrome untouched → no mismatch', () => {
    const records = probes.map((p) => (p.safari ? rec('ACTIVE', p, p.protocol === 'TCP' ? active : udp, p.protocol === 'TCP' ? 'SFE-ROUTE' : 'REJECT') : rec('ACTIVE', p, 'FINAL,DIRECT', 'DIRECT')));
    const j = judgeMatchMatrix(records, [SAFARI]);
    expect(j).toEqual({ safari: { total: 6, mismatches: [] }, control: { total: 6, hits: [] }, errors: 0 });
  });

  it('flags QUIC that escapes the UDP rule, a pass where a rule is expected, a Chrome hit and failed reads', () => {
    const records = probes.map((p) => {
      if (!p.safari) return rec('ACTIVE', p, p.verify && p.protocol === 'TCP' ? active : 'FINAL,DIRECT', p.verify && p.protocol === 'TCP' ? 'SFE-ROUTE' : 'DIRECT');
      if (p.protocol === 'QUIC') return rec('ACTIVE', p, 'FINAL,DIRECT', 'DIRECT');
      if (p.protocol === 'UDP' && !p.verify) return rec('ACTIVE', p, null, null);
      return rec('ACTIVE', p, p.protocol === 'TCP' ? active : udp, p.protocol === 'TCP' ? 'SFE-ROUTE' : 'REJECT');
    });
    const j = judgeMatchMatrix(records, [SAFARI]);
    expect(j.safari.mismatches).toHaveLength(2);
    expect(j.safari.mismatches[0]).toContain('QUIC');
    expect(j.control.hits).toHaveLength(1);
    expect(j.errors).toBe(1);
  });

  it('an IP-literal other host (documentation address) is probed like any other host and judged by the same mode semantics', () => {
    const withIp = matchProbes({ processPaths: [SAFARI], controlPaths: [CHROME], verifyHost: 'api.ipify.org', otherHosts: ['echo.p0.example.test', '192.0.2.1'] });
    expect(withIp).toHaveLength(18);
    const ipTcp = withIp.find((p) => p.safari && p.host === '192.0.2.1' && p.protocol === 'TCP')!;
    expect(ipTcp.verify).toBe(false);
    const blockOther = `AND,((PROCESS-NAME,${SAFARI}),(NOT,((DOMAIN,api.ipify.org)))),REJECT`;
    // VERIFY_ONLY：其他主机 TCP 必须被本应用规则拒绝；走到用户规则（FINAL）是不符，备注带出主机
    expect(judgeMatchMatrix([rec('VERIFY_ONLY', ipTcp, blockOther, 'REJECT')], [SAFARI]).safari.mismatches).toEqual([]);
    const bad = judgeMatchMatrix([rec('VERIFY_ONLY', ipTcp, 'FINAL,DIRECT', 'DIRECT')], [SAFARI]).safari.mismatches;
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('其他主机 192.0.2.1');
  });

  it('NORMAL: Safari must not hit an entry rule', () => {
    const p = probes[0]!;
    expect(judgeMatchMatrix([rec('NORMAL', p, 'FINAL,DIRECT', 'DIRECT')], [SAFARI]).safari.mismatches).toEqual([]);
    expect(judgeMatchMatrix([rec('NORMAL', p, 'RULE-SET,sfe-entry-block.list,REJECT', 'REJECT')], [SAFARI]).safari.mismatches).toHaveLength(1);
  });
});

describe('UDP/QUIC coverage', () => {
  const DIGEST = 'sha256:aaaa';
  const measured = (over: Partial<UdpCoverageInput> = {}): UdpCoverageInput => ({
    udp: { total: 3, rejected: 3 },
    h3Observed: 'http/2',
    h3Tcp: { total: 2, routed: 2 },
    verifyRouted: 4,
    echoExpect: true,
    ipv6: { records: [{ mode: 'BLOCKED', outcome: 'reject' }, { mode: 'ACTIVE', outcome: 'route' }], normalPage: { total: 3, ok: 3 } },
    websocket: { opensWhileBlocked: 0, activeVias: ['p0-a'] },
    expectedVia: 'p0-a',
    processPathsDigest: DIGEST,
    attribution: null,
    ...over,
  });
  const attrPass = (coverage: ProtocolCoverage): UdpCoverageInput['attribution'] => ({ verdict: 'pass', processPathsDigest: DIGEST, coverage });

  it('measures every gating item it can observe from the entry run (nothing is hard-coded as not tested)', () => {
    const c = udpQuicCoverage(measured());
    for (const item of ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket'] as const) expect(c[item]?.result).toBe('pass');
    // 扩展页面请求在入口运行中与测试页请求无法区分：没有归属结果时如实为 not_tested，并写明缺什么。
    expect(c.extension_page_fetch).toEqual({ result: 'not_tested', note: expect.stringContaining('入口运行不直接测量扩展页面请求') });
    const withAttr = udpQuicCoverage(measured({ attribution: attrPass({ extension_page_fetch: { result: 'pass', note: null } }) }));
    expect(withAttr.extension_page_fetch?.result).toBe('limitation');
    expect(coverageAllowsSupported(withAttr).ok).toBe(true);
  });

  it('takes extension page fetch only from the attribution measurement, never from an operator reading of the popup', () => {
    // 弹窗「重新检测」在 P0 中由服务执行，BLOCKED 与 VERIFY_ONLY 下显示相同：它不是扩展页面请求，输入里不再有这一项。
    expect(Object.keys(measured())).not.toContain('extension');
    const failedAttr = udpQuicCoverage(measured({ attribution: attrPass({ extension_page_fetch: { result: 'fail', note: '有记录来自非候选进程' } }) }));
    expect(failedAttr.extension_page_fetch).toEqual({ result: 'not_tested', note: expect.stringContaining('归属测试中该项为 fail') });
    const ok = udpQuicCoverage(measured({ attribution: attrPass({ extension_page_fetch: { result: 'pass', note: null } }) }));
    expect(ok.extension_page_fetch?.note).toContain('由 safari_process_attribution 覆盖');
  });

  it('fails items whose measurement contradicts the mode', () => {
    const c = udpQuicCoverage(
      measured({
        ipv6: { records: [{ mode: 'VERIFY_ONLY', outcome: 'pass' }], normalPage: { total: 1, ok: 1 } },
        websocket: { opensWhileBlocked: 1, activeVias: [] },
      }),
    );
    expect(c.ipv6?.result).toBe('fail');
    expect(c.websocket?.result).toBe('fail');
    expect(udpQuicCoverage(measured({ websocket: { opensWhileBlocked: 0, activeVias: ['p0-plain'] } })).websocket?.result).toBe('fail');
  });

  it('records missing IPv6 connectivity as a measured limitation', () => {
    const c = udpQuicCoverage(measured({ ipv6: { records: [], normalPage: { total: 4, ok: 0 } } }));
    expect(c.ipv6).toEqual({ result: 'limitation', note: expect.stringContaining('没有 IPv6 连通') });
  });

  it('falls back only to a passed attribution with the same process paths, as a sourced limitation', () => {
    const unobserved = { ipv6: { records: [], normalPage: { total: 0, ok: 0 } }, websocket: { opensWhileBlocked: 0, activeVias: [] } };
    const attrCoverage = { ipv6: { result: 'pass' as const, note: null }, websocket: { result: 'pass' as const, note: null }, extension_page_fetch: { result: 'limitation' as const, note: '扩展步骤只测了准备页' } };
    const none = udpQuicCoverage(measured(unobserved));
    for (const item of ['ipv6', 'websocket', 'extension_page_fetch'] as const) {
      expect(none[item]?.result).toBe('not_tested');
      expect(none[item]?.note).toBeTruthy();
    }
    const other = udpQuicCoverage(measured({ ...unobserved, attribution: { verdict: 'pass', processPathsDigest: 'sha256:bbbb', coverage: attrCoverage } }));
    expect(other.websocket?.result).toBe('not_tested');
    const failed = udpQuicCoverage(measured({ ...unobserved, attribution: { verdict: 'incomplete', processPathsDigest: DIGEST, coverage: attrCoverage } }));
    expect(failed.websocket?.result).toBe('not_tested');
    const same = udpQuicCoverage(measured({ ...unobserved, attribution: { verdict: 'pass', processPathsDigest: DIGEST, coverage: attrCoverage } }));
    for (const item of ['ipv6', 'websocket', 'extension_page_fetch'] as const) {
      expect(same[item]?.result).toBe('limitation');
      expect(same[item]?.note).toContain('由 safari_process_attribution 覆盖');
    }
    expect(same.extension_page_fetch?.note).toContain('扩展步骤只测了准备页');
    expect(coverageAllowsSupported(same).ok).toBe(true);
  });

  it('never borrows the UDP/QUIC items themselves from attribution', () => {
    const attrCoverage = { http3_quic: { result: 'pass' as const, note: null }, http2: { result: 'pass' as const, note: null } };
    const c = udpQuicCoverage(measured({ udp: { total: 0, rejected: 0 }, h3Tcp: { total: 0, routed: 0 }, attribution: { verdict: 'pass', processPathsDigest: DIGEST, coverage: attrCoverage } }));
    expect(c.http3_quic?.result).toBe('not_tested');
    expect(c.http2?.result).toBe('not_tested');
  });

  describe('WebSocket windows', () => {
    // 真实时序：读回确认（from）在切换生效之后；VERIFY_ONLY 下 REJECT 让测试页每 2 秒重试，ACTIVE 生效后的第一次重试
    // 就在确认后 2 秒内建立，并一直保持到 ACTIVE 结束。
    const windows: ModeWindow[] = [
      { mode: 'BLOCKED', from: 10_000, to: 30_000 },
      { mode: 'VERIFY_ONLY', from: 31_000, to: 51_000 },
      { mode: 'ACTIVE', from: 52_000, to: 72_000 },
      { mode: 'NORMAL', from: 73_000, to: 93_000 },
    ];
    const SETTLE = 2000;

    it('counts the first ACTIVE open even when it lands right after the readback confirmation', () => {
      const events = [
        { t: 52_300, kind: 'ws_open', ok: true },
        { t: 52_350, kind: 'ws_first', ok: true, via: 'p0-a' },
      ];
      const ev = websocketEvidence(windows, events, SETTLE);
      expect(ev).toEqual({ opensWhileBlocked: 0, activeVias: ['p0-a'] });
      expect(udpQuicCoverage(measured({ websocket: ev })).websocket?.result).toBe('pass');
      // 切换到 ACTIVE 途中（确认之前）建立、经过错误节点的连接同样被发现。
      const during = [
        { t: 51_900, kind: 'ws_open', ok: true },
        { t: 51_950, kind: 'ws_first', ok: true, via: 'p0-plain' },
      ];
      const bad = websocketEvidence(windows, during, SETTLE);
      expect(bad.activeVias).toEqual(['p0-plain']);
      expect(udpQuicCoverage(measured({ websocket: bad })).websocket?.result).toBe('fail');
    });

    it('treats every successful open from BLOCKED (after settling) through the end of VERIFY_ONLY as a violation', () => {
      const events = [
        { t: 10_500, kind: 'ws_open', ok: true }, // 切换前已开始握手：留稳定时间
        { t: 30_500, kind: 'ws_open', ok: true }, // BLOCKED → VERIFY_ONLY 切换途中
        { t: 40_000, kind: 'ws_open', ok: false },
        { t: 80_000, kind: 'ws_open', ok: true }, // NORMAL 下按原规则
        { t: 80_050, kind: 'ws_first', ok: true, via: 'p0-plain' },
      ];
      expect(websocketEvidence(windows, events, SETTLE)).toEqual({ opensWhileBlocked: 1, activeVias: [] });
    });

    it('has no ACTIVE measurement when the sequence stopped before ACTIVE', () => {
      const events = [{ t: 51_950, kind: 'ws_first', ok: true, via: 'p0-a' }];
      expect(websocketEvidence(windows.slice(0, 2), events, SETTLE)).toEqual({ opensWhileBlocked: 0, activeVias: [] });
    });
  });
});

describe('continuity summary', () => {
  it('keeps the baseline and every impacted period, and folds clean periods into one line', () => {
    const samples: Sample[] = [];
    for (let t = 0; t < 400; t++) samples.push({ t: t * 1000, kind: 'short', ok: t !== 205, ms: 10, via: 'p0-plain' });
    const events = Array.from({ length: 36 }, (_, i) => ({ t: 40_000 + i * 10_000, label: `refresh:resource_refresh`, source: 'action' as const }));
    const { periods } = analyzeContinuity(samples, events, { start: 0, end: 400_000 });
    const lines = summarizePeriods(periods);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('对照');
    expect(lines[1]).toContain('短请求 9/10');
    expect(lines[2]).toContain('其余 35 个时段');
  });
});
