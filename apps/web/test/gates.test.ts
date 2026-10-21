import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_GATES, GATING_COVERAGE_ITEMS, type CapabilityProposalView, type ProtocolCoverage } from '@sfe/contract';
import PendingDeployCard from '../src/components/PendingDeployCard.vue';
import CapabilitiesView from '../src/views/CapabilitiesView.vue';
import { coverageBlockReason, evaluateGate } from '../src/lib/gates';
import { allSupported, capabilities, click, environment, flush, mountWith, revision, snapshot, testContext, type Call } from './fixtures';

afterEach(() => {
  document.body.innerHTML = '';
});

const pendingEnv = environment({
  proxy: { desired: revision(2), deployed: revision(1), active: null, lastVerified: null },
  facets: { input: 'valid', binding: 'bound', deployment: 'blocked_by_capability', preflight: 'none', route: 'inactive' },
});

describe('evaluateGate', () => {
  it('lists every missing capability of the publish gate', () => {
    const r = evaluateGate(capabilities({ targeted_resource_refresh: 'supported' }), 'publish');
    expect(r.met).toBe(false);
    expect(r.missing.map((m) => m.key)).toEqual(CAPABILITY_GATES.publish.filter((k) => k !== 'targeted_resource_refresh'));
  });

  it('adds auto_reload_atomic_replace to activation under ruleset_resource', () => {
    const caps = capabilities({ ...allSupported(), auto_reload_atomic_replace: 'unverified' });
    expect(evaluateGate(caps, 'activate', 'temp_rule').met).toBe(true);
    expect(evaluateGate(caps, 'activate', 'ruleset_resource').missing.map((m) => m.key)).toEqual(['auto_reload_atomic_replace']);
  });

  it('maintenance write needs the reload impact measured (unsupported with a record is fine)', () => {
    const caps = capabilities({ auto_reload_atomic_replace: 'supported', same_profile_reload_impact: 'unsupported' });
    expect(evaluateGate(caps, 'maintenanceWrite').met).toBe(true);
    const unmeasured = capabilities({ auto_reload_atomic_replace: 'supported' });
    expect(evaluateGate(unmeasured, 'maintenanceWrite').missing).toEqual([expect.objectContaining({ key: 'same_profile_reload_impact', measured: true })]);
  });

  it('uses the effective status, not the recorded one', () => {
    const caps = capabilities(allSupported()).map((c) => (c.key === 'policy_path_reread' ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['surgeBuild' as const] } : c));
    expect(evaluateGate(caps, 'publish').missing.map((m) => m.key)).toEqual(['policy_path_reread']);
  });
});

describe('publish button', () => {
  it('is disabled with the missing capabilities listed and offers no override', async () => {
    const { ctx } = testContext(() => ({ status: 500 }), snapshot({ environments: [pendingEnv], capabilities: capabilities() }));
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.disabled).toBe(true);
    const gate = document.body.querySelector('[data-test="publish-gate"]')!;
    for (const key of CAPABILITY_GATES.publish) expect(gate.textContent).toContain(ctx.store.capabilities.value.find((c) => c.key === key)!.label);
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const forbidden of ['忽略', '仍然', '强制', '确认风险', '重载', '跳过检查']) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
    expect(document.body.querySelectorAll('button:not([disabled]).btn-primary')).toHaveLength(0);
    m.unmount();
  });

  it('publishes when the gate is met', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/deployments/publish' ? { status: 202, body: { operation_id: 'op_7', environment_id: null, revision: null, duplicate: false } } : { status: 404 }),
      snapshot({ environments: [pendingEnv], capabilities: capabilities(allSupported()) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.disabled).toBe(false);
    expect(document.body.querySelector('[data-test="publish-gate"]')).toBeNull();
    click(button);
    await flush();
    const call = calls.find((c) => c.url === '/api/deployments/publish');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ request_id: expect.stringMatching(/^web-/) });
    m.unmount();
  });
});

function coverage(result: 'pass' | 'limitation' | 'fail', note: string | null = null): ProtocolCoverage {
  return Object.fromEntries(GATING_COVERAGE_ITEMS.map((i) => [i, { result, note }]));
}

function proposal(over: Partial<CapabilityProposalView> = {}): CapabilityProposalView {
  return {
    id: 'prop_1',
    key: 'safari_process_attribution',
    proposedStatus: 'supported',
    context: {
      surgeVersion: '6.5.0',
      surgeBuild: '3000',
      macosBuild: '24A335',
      safariVersion: '18.0',
      entryStrategy: 'temp_rule',
      processPathsDigest: 'hmac:abcd',
      workingProfileId: 'wp_1',
      autoReload: 'off',
      takeoverMode: 'enhanced',
      signingIdentity: 'TEAMID1234',
      adapterMechanism: '{"listRules":"cli"}',
    },
    protocolCoverage: coverage('pass'),
    summary: 'Safari 与扩展页面请求按完整路径命中；Chrome 不命中。',
    evidenceDigest: 'hmac:0011',
    submittedAt: '2026-10-21T08:00:00.000Z',
    submittedBy: 'agent',
    ...over,
  };
}

describe('coverageBlockReason', () => {
  it('blocks confirming without coverage, or with a failed or unexplained gating item', () => {
    expect(coverageBlockReason(proposal({ protocolCoverage: null }))).toContain('缺少逐协议覆盖');
    expect(coverageBlockReason(proposal({ protocolCoverage: { ...coverage('pass'), ipv6: { result: 'fail', note: null } } }))).toContain('1 项');
    expect(coverageBlockReason(proposal({ protocolCoverage: { ...coverage('pass'), http3_quic: { result: 'limitation', note: null } } }))).not.toBeNull();
    expect(coverageBlockReason(proposal({ protocolCoverage: { ...coverage('pass'), http3_quic: { result: 'limitation', note: 'H3 已拒绝并回落 TCP' } } }))).toBeNull();
    const partial = coverage('pass');
    delete partial.websocket;
    expect(coverageBlockReason(proposal({ protocolCoverage: partial }))).not.toBeNull();
  });

  it('does not require coverage for other capabilities', () => {
    expect(coverageBlockReason(proposal({ key: 'policy_path_reread', protocolCoverage: null }))).toBeNull();
  });
});

describe('capabilities page', () => {
  it('shows pass criteria for every capability and disables 确认 with the reason when coverage is incomplete', async () => {
    const { ctx } = testContext(() => ({ status: 404 }), snapshot({ capabilityProposals: [proposal({ protocolCoverage: { ...coverage('pass'), ipv6: { result: 'not_tested', note: null } } })] }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    expect(document.body.querySelectorAll('[data-test="criteria"]')).toHaveLength(20);
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-test="confirm-proposal"]')!;
    expect(confirm.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="confirm-block"]')?.textContent).toContain('逐协议覆盖不完整');
    expect(document.body.querySelector('[data-test="coverage-table"]')?.textContent).toContain('未测试');
    m.unmount();
  });

  it('confirms a complete proposal through the web-only confirm request', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/capabilities' && c.method === 'POST' ? { status: 200, body: { ...capabilities()[0], status: 'supported', effectiveStatus: 'supported' } } : { status: 404 }),
      snapshot({ capabilityProposals: [proposal()] }),
    );
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-test="confirm-proposal"]')!;
    expect(confirm.disabled).toBe(false);
    click(confirm);
    await flush();
    expect(document.body.textContent).toContain('确定要确认此提议吗？');
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    const call = calls.find((c) => c.url === '/api/capabilities' && c.method === 'POST');
    expect(call?.body).toEqual({ request_id: expect.any(String), action: 'confirm', proposal_id: 'prop_1' });
    m.unmount();
  });

  it('cannot confirm in demo mode', async () => {
    const { ctx } = testContext(() => ({ status: 404 }), snapshot({ demoMode: true, capabilityProposals: [proposal()] }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="confirm-proposal"]')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('演示模式不能确认能力');
    m.unmount();
  });

  it('resets a capability to unverified with an optional note', async () => {
    const caps = capabilities({ policy_path_reread: 'supported' });
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/capabilities' && c.method === 'POST' ? { status: 200, body: { ...caps.find((x) => x.key === 'policy_path_reread'), status: 'unverified', effectiveStatus: 'unverified' } } : { status: 404 }),
      snapshot({ capabilities: caps }),
    );
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const resets = document.body.querySelectorAll('[data-test="reset-capability"]');
    expect(resets).toHaveLength(1);
    click(resets[0]);
    await flush();
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ request_id: expect.any(String), action: 'reset', key: 'policy_path_reread', note: null });
    m.unmount();
  });
});
