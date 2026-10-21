import { ENTRY_MODE_BITS } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import { analyzeAttribution, type AttributionInput, type AttributionRecord } from '../src/analysis/attribution.js';
import { analyzeContinuity, formatPeriod, percentile, type Sample } from '../src/analysis/continuity.js';
import { analyzeEntryWindow, candidateBits, expectedOutcome, outcomeOf, type EntryTimeline } from '../src/analysis/entry-window.js';
import { compareSignals, type ReloadSignals } from '../src/analysis/reload.js';
import { planEntryTransition } from '../src/deps.js';

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
  const s = (over: Partial<ReloadSignals> = {}): ReloadSignals => ({ at: 'x', canaryLoaded: false, surgeStart: 'S@1', tempRules: ['r1'], profileName: 'SFE-P0-测试', ...over });

  it('reports no reload only when the canary was definitely not read', () => {
    expect(compareSignals(s(), s())).toEqual({ reloaded: false, reasons: [] });
    expect(compareSignals(s(), s({ canaryLoaded: null })).reloaded).toBeNull();
  });

  it('detects canary reads, restarts, lost temp rules and profile changes', () => {
    expect(compareSignals(s(), s({ canaryLoaded: true })).reasons).toHaveLength(1);
    expect(compareSignals(s(), s({ surgeStart: 'S@2' })).reasons[0]).toContain('重启');
    expect(compareSignals(s(), s({ tempRules: [] })).reasons[0]).toContain('临时规则');
    expect(compareSignals(s(), s({ profileName: '其他' })).reloaded).toBe(true);
  });
});
