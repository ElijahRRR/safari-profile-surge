import { GATING_COVERAGE_ITEMS, type CapabilityContext, type CapabilityKey, type ProtocolCoverage } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
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
    autoReloadPassed: { on: false, off: true },
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
    expect(refusal(() => buildProposal(input('auto_reload_atomic_replace', base)))).toContain('开、关两种设置');
    const req = buildProposal(input('auto_reload_atomic_replace', { ...base, autoReloadPassed: { on: true, off: true } }));
    expect(req.context.autoReload).toBe('any');
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
