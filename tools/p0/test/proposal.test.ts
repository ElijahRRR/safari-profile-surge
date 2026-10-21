import { GATING_COVERAGE_ITEMS, type CapabilityContext, type CapabilityKey, type ProtocolCoverage } from '@sfe/contract';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { udpQuicCoverage } from '../src/analysis/udp-coverage.js';
import { PROPOSAL_SUMMARY_MAX_CHARS } from '../src/constants.js';
import { processPathsDigest } from '../src/context.js';
import { P0Error } from '../src/errors.js';
import { ALL_COVERAGE_ITEMS, buildProposal, completeCoverage, type ProposalInput } from '../src/proposal.js';
import { check, type CapabilityResult } from '../src/results.js';

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari';

const CTX: CapabilityContext = {
  surgeVersion: '6.5.0',
  surgeBuild: '10960',
  macosBuild: '24A335',
  safariVersion: '18.0',
  entryStrategy: null,
  processPathsDigest: processPathsDigest([SAFARI]),
  workingProfileId: null,
  autoReload: 'off',
  takeoverMode: 'enhanced',
  signingIdentity: null,
  adapterMechanism: '{"listRules":"cli"}',
};

function result(key: CapabilityKey, over: Partial<CapabilityResult> = {}): CapabilityResult {
  return { key, command: 'test', at: '2026-10-21T10:00:00.000Z', verdict: 'pass', checks: [check('a', true)], summary: ['通过条件：x', '说明 203.0.113.5'], context: CTX, ...over };
}

function input(key: CapabilityKey, over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    key,
    status: 'supported',
    result: result(key),
    current: CTX,
    overrides: {},
    evidenceDigest: `hmac-sha256:${'a'.repeat(64)}`,
    runId: '20261021-100000-aaaaaa',
    requestId: 'p0-req-1',
    history: [],
    exists: () => true,
    ...over,
  };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(P0Error);
    return (e as P0Error).message;
  }
  throw new Error('expected refusal');
}

const PASS_COVERAGE: ProtocolCoverage = Object.fromEntries(GATING_COVERAGE_ITEMS.map((i) => [i, { result: 'pass', note: null }]));

describe('buildProposal', () => {
  it('builds a supported proposal with context, redacted summary and digest', () => {
    const req = buildProposal(input('independent_node_preflight'));
    expect(req).toMatchObject({ request_id: 'p0-req-1', key: 'independent_node_preflight', proposed_status: 'supported', evidence_digest: `hmac-sha256:${'a'.repeat(64)}` });
    expect(req.context).toEqual(CTX);
    expect(req.summary).toContain('P0 运行 20261021-100000-aaaaaa');
    expect(req.summary).not.toContain('203.0.113.5');
    expect(req.protocol_coverage).toBeUndefined();
  });

  it('requires a measured result', () => {
    expect(refusal(() => buildProposal(input('independent_node_preflight', { result: null })))).toContain('没有');
  });

  it('refuses supported unless the verdict is pass, and unsupported when it is', () => {
    expect(refusal(() => buildProposal(input('independent_node_preflight', { result: result('independent_node_preflight', { verdict: 'incomplete' }) })))).toContain('不能提议支持');
    expect(refusal(() => buildProposal(input('independent_node_preflight', { status: 'unsupported' })))).toContain('不能提议不支持');
    const req = buildProposal(input('independent_node_preflight', { status: 'unsupported', result: result('independent_node_preflight', { verdict: 'fail' }) }));
    expect(req.proposed_status).toBe('unsupported');
  });

  it('refuses when dependency context drifted since measurement', () => {
    const msg = refusal(() => buildProposal(input('independent_node_preflight', { current: { ...CTX, surgeBuild: '11000' } })));
    expect(msg).toContain('surgeBuild');
  });

  it('ignores drift in fields the capability does not depend on', () => {
    expect(() => buildProposal(input('independent_node_preflight', { current: { ...CTX, safariVersion: '19.0' } }))).not.toThrow();
  });

  it('requires explicit working-profile any for profile-dependent keys', () => {
    expect(refusal(() => buildProposal(input('targeted_resource_refresh')))).toContain('--working-profile any');
    const req = buildProposal(input('targeted_resource_refresh', { overrides: { workingProfileId: 'any' } }));
    expect(req.context.workingProfileId).toBe('any');
    expect(req.summary).toContain('工作配置身份记为 any');
  });

  it('allows auto-reload any only when both settings passed', () => {
    const base = { overrides: { workingProfileId: 'any' as const, autoReload: 'any' as const } };
    const off = result('auto_reload_atomic_replace', { declaredAutoReload: 'off' });
    expect(refusal(() => buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [off] })))).toContain('开、关两种设置');
    const on = result('auto_reload_atomic_replace', { declaredAutoReload: 'on', context: { ...CTX, autoReload: 'on' } });
    const req = buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [on, off] }));
    expect(req.context.autoReload).toBe('any');
  });

  it('a run where atomic replace reloaded is not evidence for auto-reload any', () => {
    const base = { overrides: { workingProfileId: 'any' as const, autoReload: 'any' as const } };
    const off = result('auto_reload_atomic_replace', { declaredAutoReload: 'off' });
    const onReloaded = result('auto_reload_atomic_replace', { declaredAutoReload: 'on', verdict: 'fail', checks: [check('原子替换不触发重新读取', false)] });
    expect(refusal(() => buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [onReloaded, off] })))).toContain('自动重载开');
    // 该设置下只能如实提议不支持。
    const req = buildProposal(input('auto_reload_atomic_replace', { status: 'unsupported', result: onReloaded, overrides: { workingProfileId: 'any', autoReload: 'on' }, history: [onReloaded, off] }));
    expect(req).toMatchObject({ proposed_status: 'unsupported', context: { autoReload: 'on' } });
  });

  it('auto-reload any is refused when a later run under the same setting contradicts an earlier pass', () => {
    // 先用较短的 --wait 在“开”下得到通过，再用较长的等待观察到原子替换触发重新读取：较早的通过不能抵消较新的失败。
    const base = { overrides: { workingProfileId: 'any' as const, autoReload: 'any' as const } };
    const onPass = result('auto_reload_atomic_replace', { declaredAutoReload: 'on', at: '2026-10-21T09:00:00.000Z' });
    const onFail = result('auto_reload_atomic_replace', { declaredAutoReload: 'on', at: '2026-10-21T09:30:00.000Z', verdict: 'fail', checks: [check('原子替换不触发重新读取', false)] });
    const off = result('auto_reload_atomic_replace', { declaredAutoReload: 'off', at: '2026-10-21T10:00:00.000Z' });
    const msg = refusal(() => buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [onPass, onFail, off] })));
    expect(msg).toContain('证据有矛盾');
    expect(msg).toContain('自动重载开：另有不通过的测量（测量于 2026-10-21T09:30:00.000Z）');
    // 顺序反过来（先失败、后来没看到）同样拒绝：矛盾时以更严格的结论为准。
    const onPassLater = { ...onPass, at: '2026-10-21T09:45:00.000Z' };
    expect(refusal(() => buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [onFail, onPassLater, off] })))).toContain('证据有矛盾');
    // 其他上下文不同的相反结论不是本上下文的证据，不构成矛盾；没有矛盾时摘要写明每个取值用作证据的测量。
    const onFailOldBuild = { ...onFail, context: { ...CTX, surgeBuild: '10000' } };
    const req = buildProposal(input('auto_reload_atomic_replace', { ...base, result: off, history: [onPass, onFailOldBuild, off] }));
    expect(req.context.autoReload).toBe('any');
    expect(req.summary).toContain('--auto-reload any 的证据');
    expect(req.summary).toContain('自动重载开 1 次（最近 2026-10-21T09:00:00.000Z）');
    // takeover any 同样拒绝矛盾。
    const runs = (['enhanced', 'system_proxy', 'both'] as const).map((m) => result('connection_continuity', { context: { ...CTX, takeoverMode: m } }));
    const bothFail = result('connection_continuity', { verdict: 'fail', context: { ...CTX, takeoverMode: 'both' } });
    expect(refusal(() => buildProposal(input('connection_continuity', { overrides: { workingProfileId: 'any', takeoverMode: 'any' }, result: runs[0]!, history: [...runs, bothFail] })))).toContain('both：另有不通过的测量');
  });

  it('auto-reload and takeover declarations need evidence for every capability that depends on them', () => {
    const entryCtx = { ...CTX, entryStrategy: 'ruleset_resource' as const };
    const entry = result('runtime_entry_modes', { context: entryCtx, entryStrategy: 'ruleset_resource' });
    const base = { current: entryCtx, result: entry, history: [entry] };
    // 测量时为 off / enhanced：声明相反的值或 any 都没有证据。
    expect(refusal(() => buildProposal(input('runtime_entry_modes', { ...base, overrides: { autoReload: 'on' } })))).toContain('不一致');
    expect(refusal(() => buildProposal(input('runtime_entry_modes', { ...base, overrides: { autoReload: 'any' } })))).toContain('开、关两种设置');
    expect(refusal(() => buildProposal(input('runtime_entry_modes', { ...base, overrides: { takeoverMode: 'any' } })))).toContain('system_proxy、both');
    expect(refusal(() => buildProposal(input('runtime_entry_modes', { ...base, overrides: { takeoverMode: 'system_proxy' } })))).toContain('接管方式与测量时不一致');
    // 与测量相同的声明可以。
    expect(buildProposal(input('runtime_entry_modes', { ...base, overrides: { autoReload: 'off', takeoverMode: 'enhanced' } })).context).toMatchObject({ autoReload: 'off', takeoverMode: 'enhanced' });
    // 测量时读不到时不能声明具体值。
    const unread = result('connection_continuity', { context: { ...CTX, autoReload: null } });
    expect(refusal(() => buildProposal(input('connection_continuity', { current: { ...CTX, autoReload: null }, result: unread, history: [unread], overrides: { workingProfileId: 'any', autoReload: 'on' } })))).toContain('没有记录自动重载设置');
  });

  it('auto-reload any for other capabilities needs that capability measured under both settings', () => {
    const offRun = result('targeted_resource_refresh', { declaredAutoReload: 'off' });
    const base = { overrides: { workingProfileId: 'any' as const, autoReload: 'any' as const }, result: offRun };
    expect(refusal(() => buildProposal(input('targeted_resource_refresh', { ...base, history: [offRun] })))).toContain('缺少：自动重载开');
    // 另一项能力（auto_reload_atomic_replace）在开时通过不能替代本能力的证据。
    const otherKey = result('auto_reload_atomic_replace', { declaredAutoReload: 'on' });
    expect(refusal(() => buildProposal(input('targeted_resource_refresh', { ...base, history: [offRun, otherKey] })))).toContain('缺少：自动重载开');
    // 开时的测量来自不同的 Surge 构建：不算证据。
    const onOld = result('targeted_resource_refresh', { declaredAutoReload: 'on', context: { ...CTX, surgeBuild: '10000' } });
    expect(refusal(() => buildProposal(input('targeted_resource_refresh', { ...base, history: [offRun, onOld] })))).toContain('缺少：自动重载开');
    const on = result('targeted_resource_refresh', { declaredAutoReload: 'on' });
    expect(buildProposal(input('targeted_resource_refresh', { ...base, history: [offRun, on] })).context.autoReload).toBe('any');
  });

  it('takeover any needs passing measurements under enhanced, system_proxy and both', () => {
    const runs = (['enhanced', 'system_proxy', 'both'] as const).map((m) => result('connection_continuity', { context: { ...CTX, takeoverMode: m } }));
    const base = { overrides: { workingProfileId: 'any' as const, takeoverMode: 'any' as const }, result: runs[0]! };
    expect(refusal(() => buildProposal(input('connection_continuity', { ...base, history: runs.slice(0, 2) })))).toContain('缺少：both');
    expect(buildProposal(input('connection_continuity', { ...base, history: runs })).context.takeoverMode).toBe('any');
  });

  it('refuses a declared signing identity different from the measured one', () => {
    const r = result('native_bridge_ipc', { context: { ...CTX, signingIdentity: 'ABCDE12345' } });
    expect(refusal(() => buildProposal(input('native_bridge_ipc', { result: r, current: { ...CTX, signingIdentity: 'ABCDE12345' }, overrides: { signingIdentity: 'ZZZZZ99999' } })))).toContain('签名身份');
  });

  it('caps the summary at the service limit', () => {
    const long = Array.from({ length: 200 }, (_, i) => `时段 ${i}：短请求 60/60，延迟 p50 12 ms / p95 30 ms，流最大间隔 1000 ms，流重置 0，WebSocket 重置 0，经过 p0-plain`);
    const req = buildProposal(input('independent_node_preflight', { result: result('independent_node_preflight', { summary: long }) }));
    expect(req.summary.length).toBeLessThanOrEqual(PROPOSAL_SUMMARY_MAX_CHARS);
    expect(req.summary.endsWith('…')).toBe(true);
  });

  it('uses the same summary limit as the service validation', () => {
    const src = readFileSync(new URL('../../../service/src/engine/admin-ops.ts', import.meta.url), 'utf8');
    expect(src).toContain(`req.summary.length > ${PROPOSAL_SUMMARY_MAX_CHARS}`);
  });

  it('refuses a declared auto-reload value different from the measured one', () => {
    const r = result('auto_reload_atomic_replace', { declaredAutoReload: 'off' });
    expect(refusal(() => buildProposal(input('auto_reload_atomic_replace', { result: r, overrides: { workingProfileId: 'any', autoReload: 'on' } })))).toContain('不一致');
  });

  it('requires a signing identity for native capabilities', () => {
    expect(refusal(() => buildProposal(input('native_bridge_ipc')))).toContain('签名身份');
    const req = buildProposal(input('native_bridge_ipc', { overrides: { signingIdentity: 'ABCDE12345' } }));
    expect(req.context.signingIdentity).toBe('ABCDE12345');
  });

  it('attribution proposals carry full coverage and validated process paths', () => {
    const r = result('safari_process_attribution', { coverage: PASS_COVERAGE, processPaths: [SAFARI] });
    const req = buildProposal(input('safari_process_attribution', { result: r }));
    expect(Object.keys(req.protocol_coverage!).sort()).toEqual([...ALL_COVERAGE_ITEMS].sort());
    expect(req.protocol_coverage!.dns).toEqual({ result: 'not_tested', note: null });
    expect(req.safari_process_paths).toEqual([SAFARI]);
  });

  it('refuses supported attribution with missing gating coverage or generic WebKit paths', () => {
    const partial = { ...PASS_COVERAGE, http3_quic: { result: 'not_tested' as const, note: null } };
    expect(refusal(() => buildProposal(input('safari_process_attribution', { result: result('safari_process_attribution', { coverage: partial, processPaths: [SAFARI] }) })))).toContain('http3_quic');
    const generic = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking';
    expect(refusal(() => buildProposal(input('safari_process_attribution', { result: result('safari_process_attribution', { coverage: PASS_COVERAGE, processPaths: [generic] }) })))).toContain('WebKit');
  });

  it('accepts limitations with notes as gating coverage', () => {
    const lim = { ...PASS_COVERAGE, ipv6: { result: 'limitation' as const, note: '测试网络没有 IPv6' } };
    const req = buildProposal(input('safari_udp_quic_handling', { result: result('safari_udp_quic_handling', { coverage: lim, entryStrategy: 'ruleset_resource' }) }));
    expect(req.protocol_coverage!.ipv6!.result).toBe('limitation');
  });

  it('UDP/QUIC proposals built from entry-measured coverage can be supported', () => {
    const coverage = udpQuicCoverage({
      udp: { total: 2, rejected: 2 },
      h3Observed: 'http/2',
      h3Tcp: { total: 1, routed: 1 },
      verifyRouted: 3,
      echoExpect: true,
      ipv6: { records: [{ mode: 'ACTIVE', outcome: 'route' }], normalPage: { total: 2, ok: 2 } },
      websocket: { opensWhileBlocked: 0, activeVias: ['p0-a'] },
      expectedVia: 'p0-a',
      processPathsDigest: CTX.processPathsDigest,
      // 扩展页面请求只能由同一进程路径、通过的归属结果补足。
      attribution: { verdict: 'pass', processPathsDigest: CTX.processPathsDigest, coverage: { extension_page_fetch: { result: 'pass', note: null } } },
    });
    const r = result('safari_udp_quic_handling', { coverage, entryStrategy: 'ruleset_resource' });
    const req = buildProposal(input('safari_udp_quic_handling', { result: r }));
    expect(req.protocol_coverage!.websocket!.result).toBe('pass');
    expect(req.protocol_coverage!.extension_page_fetch!.result).toBe('limitation');
  });

  it('unsupported attribution still carries coverage', () => {
    const r = result('safari_process_attribution', { verdict: 'fail', coverage: { ipv4: { result: 'fail', note: 'x' } }, processPaths: [] });
    const req = buildProposal(input('safari_process_attribution', { status: 'unsupported', result: r }));
    expect(req.protocol_coverage!.ipv4!.result).toBe('fail');
    expect(req.safari_process_paths).toBeUndefined();
  });

  it('runtime_entry_modes proposals must carry the strategy', () => {
    const ctx = { ...CTX, entryStrategy: 'ruleset_resource' as const };
    expect(refusal(() => buildProposal(input('runtime_entry_modes', { current: ctx, result: result('runtime_entry_modes', { context: ctx }) })))).toContain('入口策略');
    const req = buildProposal(input('runtime_entry_modes', { current: ctx, result: result('runtime_entry_modes', { context: ctx, entryStrategy: 'ruleset_resource' }) }));
    expect(req.entry_strategy).toBe('ruleset_resource');
  });

  it('includes the operator note redacted', () => {
    const req = buildProposal(input('independent_node_preflight', { note: '出口 198.51.100.7 正常' }));
    expect(req.summary).toContain('操作员说明：出口 <ip> 正常');
  });
});

describe('completeCoverage', () => {
  it('fills every item', () => {
    expect(Object.keys(completeCoverage(undefined))).toHaveLength(ALL_COVERAGE_ITEMS.length);
  });
});
