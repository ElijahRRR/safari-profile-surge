import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_GATES, GATING_COVERAGE_ITEMS, type CapabilityProposalView, type ProtocolCoverage } from '@sfe/contract';
import PendingDeployCard from '../src/components/PendingDeployCard.vue';
import CapabilitiesView from '../src/views/CapabilitiesView.vue';
import { coverageBlockReason, evaluateGate, staleReasonText } from '../src/lib/gates';
import { allSupported, byText, capabilities, click, environment, flush, mountWith, revision, snapshot, testContext, type Call } from './fixtures';

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

describe('publishing a selection', () => {
  // A 保存后正在部署（部署完成会自行离开列表），B 被有意留在待部署
  const envA = environment({
    proxy: { desired: revision(2), deployed: revision(1), active: null, lastVerified: null },
    facets: { input: 'valid', binding: 'bound', deployment: 'deploying', preflight: 'none', route: 'inactive' },
  });
  const envB = environment({
    id: 'env_2',
    code: 'E0002',
    displayName: 'US-买家02',
    proxy: { desired: revision(2), deployed: revision(1), active: null, lastVerified: null },
    facets: { input: 'valid', binding: 'bound', deployment: 'pending', preflight: 'none', route: 'inactive' },
  });
  const deployedA = environment({ proxy: { desired: revision(2), deployed: revision(2), active: null, lastVerified: null } });
  const accepted = { status: 202, body: { operation_id: 'op_7', environment_id: null, revision: null, duplicate: false } };

  async function mountCard() {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/deployments/publish' ? accepted : { status: 404 }),
      snapshot({ environments: [envA, envB], capabilities: capabilities(allSupported()) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    return { ctx, calls, m, button };
  }

  it('never falls back to publishing everything when the selected environments leave the list', async () => {
    const { ctx, calls, m, button } = await mountCard();
    click(document.body.querySelector('input[aria-label="选择 US-买家01 · E0001"]'));
    await flush();
    expect(button.textContent).toContain('发布所选（1）');
    ctx.store.applyEvent({ type: 'environment.updated', sequence: 11, environment: deployedA });
    await flush();
    expect(button.textContent).toContain('发布所选（0）');
    expect(button.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="selection-dropped"]')?.textContent).toContain('US-买家01 · E0001');
    click(button);
    await flush();
    expect(calls.some((c) => c.url === '/api/deployments/publish')).toBe(false);
    // 清除选择后才回到“发布全部待部署”，且需要再点一次
    click(document.body.querySelector('[data-test="clear-selection"]'));
    await flush();
    expect(button.textContent).toContain('发布全部待部署');
    expect(button.disabled).toBe(false);
    expect(calls.some((c) => c.url === '/api/deployments/publish')).toBe(false);
    m.unmount();
  });

  it('a click racing the list update asks again instead of sending', async () => {
    const { ctx, calls, m, button } = await mountCard();
    click(document.body.querySelector('input[aria-label="选择 US-买家01 · E0001"]'));
    await flush();
    // 同一轮里列表先变化、按钮随即被点击（界面还没来得及更新）
    ctx.store.applyEvent({ type: 'environment.updated', sequence: 11, environment: deployedA });
    click(button);
    await flush();
    expect(calls.some((c) => c.url === '/api/deployments/publish')).toBe(false);
    expect(ctx.toasts.items.map((t) => t.message)).toContain('所选环境中有的已不再待部署，已更新选择，请确认后重新发布');
    expect(button.textContent).toContain('发布所选（0）');
    m.unmount();
  });

  it('publishes only what is still selected when part of the selection leaves', async () => {
    const { ctx, calls, m, button } = await mountCard();
    click(document.body.querySelector('input[aria-label="全选"]'));
    await flush();
    expect(button.textContent).toContain('发布所选（2）');
    ctx.store.applyEvent({ type: 'environment.updated', sequence: 11, environment: deployedA });
    await flush();
    expect(button.textContent).toContain('发布所选（1）');
    click(button);
    await flush();
    expect(calls.find((c) => c.url === '/api/deployments/publish')?.body).toEqual({ request_id: expect.any(String), environment_ids: ['env_2'] });
    expect(byText('button', '发布全部待部署')).not.toBeNull();
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

describe('staleReasonText', () => {
  const ctx = proposal().context;
  const SURGE = { version: '6.5.0', build: '3000' };

  it('says the current Surge version cannot be read instead of claiming it changed', () => {
    const text = staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: ctx }, { version: null, build: null });
    expect(text).toBe('读不到当前的 Surge 版本、Surge 构建，依赖版本的能力按待验证处理');
    expect(text).not.toContain('已变化');
    expect(staleReasonText({ staleReasons: ['surgeBuild'], context: { ...ctx, surgeBuild: 'any' } }, { version: '6.5.0', build: null })).toBe('读不到当前的 Surge 构建，依赖版本的能力按待验证处理');
  });

  it('says the record has no version when it was measured without one', () => {
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: { ...ctx, surgeVersion: null, surgeBuild: null } }, SURGE)).toBe('验证记录缺少 Surge 版本、Surge 构建，需要重测');
  });

  it('keeps 已变化 for real changes and other fields, and combines reasons', () => {
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: { ...ctx, surgeVersion: '6.4.0', surgeBuild: '2000' } }, SURGE)).toBe('Surge 版本、Surge 构建已变化');
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild', 'safariVersion'], context: ctx }, { version: null, build: null })).toBe(
      '读不到当前的 Surge 版本、Surge 构建，依赖版本的能力按待验证处理；Safari 版本已变化',
    );
    expect(staleReasonText({ staleReasons: [], context: ctx }, SURGE)).toBe('');
    expect(staleReasonText({ staleReasons: ['surgeVersion'], context: ctx }, null)).toBe('Surge 版本与当前不一致');
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'macosBuild'], context: null }, SURGE)).toBe('没有验证上下文，需要重测');
  });
});

describe('capabilities page', () => {
  it('explains a stale reason caused by an unreadable Surge version without saying it changed', async () => {
    const caps = capabilities(allSupported()).map((c) =>
      c.key === 'policy_path_reread' ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['surgeVersion' as const, 'surgeBuild' as const], context: proposal().context } : c,
    );
    const base = snapshot();
    const { ctx } = testContext(() => ({ status: 404 }), snapshot({ capabilities: caps, surge: { ...base.surge, version: null, build: null } }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const reasons = Array.from(document.body.querySelectorAll('[data-test="stale-reason"]')).map((e) => e.textContent?.trim());
    expect(reasons).toEqual(['读不到当前的 Surge 版本、Surge 构建，依赖版本的能力按待验证处理']);
    expect(document.body.textContent).toContain('读不到运行中 Surge 的版本时，依赖版本的能力一律按待验证处理');
    m.unmount();
  });


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
