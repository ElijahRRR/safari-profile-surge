import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  GATING_COVERAGE_ITEMS,
  type CapabilityKey,
  type CapabilityProposalView,
  type CapabilityStatus,
  type NodeResourceState,
  type ProtocolCoverage,
} from '@sfe/contract';
import PendingDeployCard from '../src/components/PendingDeployCard.vue';
import CapabilitiesView from '../src/views/CapabilitiesView.vue';
import { coverageBlockReason, evaluateGate, hostBlockReason, nodeResourcePublishBlocks, staleReasonText, versionBlockReason } from '../src/lib/gates';
import {
  allSupported,
  byText,
  capabilities,
  click,
  environment,
  flush,
  mountWith,
  nodeResource,
  revision,
  snapshot,
  snapshotWithNodeResource,
  testContext,
  type Call,
} from './fixtures';

afterEach(() => {
  document.body.innerHTML = '';
});

const pendingEnv = environment({
  proxy: { desired: revision(2), deployed: revision(1), active: null, lastVerified: null },
  facets: { input: 'valid', binding: 'bound', deployment: 'blocked_by_capability', preflight: 'none', route: 'inactive' },
});

describe('evaluateGate', () => {
  it('lists every missing capability of the publish gate', () => {
    const r = evaluateGate(capabilities({ loopback_resource_update: 'supported' }), 'publish');
    expect(r.met).toBe(false);
    expect(r.missing.map((m) => m.key)).toEqual(CAPABILITY_GATES.publish.filter((k) => k !== 'loopback_resource_update'));
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
    const caps = capabilities(allSupported()).map((c) => (c.key === 'loopback_resource_update' ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['surgeBuild' as const] } : c));
    expect(evaluateGate(caps, 'publish').missing.map((m) => m.key)).toEqual(['loopback_resource_update']);
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

  it('explains why new nodes stay pending while the loopback resource checks are unproven (D10)', async () => {
    const { ctx } = testContext(() => ({ status: 500 }), snapshot({ environments: [pendingEnv], capabilities: capabilities({ ...allSupported(), loopback_resource_auth: 'unverified' }) }));
    const m = await mountWith(PendingDeployCard, ctx);
    const note = document.body.querySelector('[data-test="node-resource-note"]')!;
    expect(note.textContent).toContain('127.0.0.1');
    expect(note.textContent).toContain('已保存，待部署');
    expect(note.textContent).toContain('Surge 或 Mac 重启后的行为尚待补测');
    // 旧的本地文件模型的说法不再出现，也不无条件承诺已部署的节点不受影响
    for (const stale of ['Local resources are skipped.', '本地 policy-path', '自动重新读取', '已部署的节点不受影响', 'sfe-nodes.list']) expect(note.textContent).not.toContain(stale);
    expect(document.body.querySelector('[data-test="policy-path-note"]')).toBeNull();
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!.disabled).toBe(true);
    m.unmount();
  });

  it('shows no loopback note when only other publish capabilities are missing', async () => {
    const { ctx } = testContext(() => ({ status: 500 }), snapshot({ environments: [pendingEnv], capabilities: capabilities({ ...allSupported(), connection_continuity: 'unverified' }) }));
    const m = await mountWith(PendingDeployCard, ctx);
    expect(document.body.querySelector('[data-test="publish-gate"]')).not.toBeNull();
    expect(document.body.querySelector('[data-test="node-resource-note"]')).toBeNull();
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

describe('publish preconditions on the local resource server (D10)', () => {
  const accepted = { status: 202, body: { operation_id: 'op_7', environment_id: null, revision: null, duplicate: false } };
  /** 页面上不能出现资源地址、端口或令牌的样子。 */
  function expectNoResourceSecrets() {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/127\.0\.0\.1:\d/);
    expect(text).not.toMatch(/[0-9a-f]{32,}/i);
    expect(text).not.toContain('/sfe-nodes.list');
  }

  it('lists the same park reasons as the service, failing closed on unknown states', () => {
    expect(nodeResourcePublishBlocks(undefined)).toEqual([]);
    expect(nodeResourcePublishBlocks(nodeResource())).toEqual([]);
    // 待重新同步不阻止发布：发布正是让 Surge 回到已提交版本的办法
    expect(nodeResourcePublishBlocks(nodeResource({ needsRefresh: true }))).toEqual([]);
    expect(nodeResourcePublishBlocks(null)).toEqual(['尚未初始化固定工作配置']);
    for (const state of ['not_listening', 'token_unavailable', 'legacy_line', 'not_installed'] as const) {
      expect(nodeResourcePublishBlocks(nodeResource({ state }))).toHaveLength(1);
    }
    expect(nodeResourcePublishBlocks(nodeResource({ state: 'not_listening' }))[0]).toContain('本机资源服务不可用');
    expect(nodeResourcePublishBlocks(nodeResource({ state: 'legacy_line' }))[0]).toContain('需要重新合并以改用本机资源服务');
    expect(nodeResourcePublishBlocks(nodeResource({ state: 'not_installed' }))[0]).toContain('需要重新合并');
    expect(nodeResourcePublishBlocks(nodeResource({ tokenSuspect: true }))).toEqual(['读取令牌可能已泄露：需要重新合并并更换本机资源地址']);
    expect(nodeResourcePublishBlocks(nodeResource({ state: 'not_listening', tokenSuspect: true }))).toHaveLength(2);
    expect(nodeResourcePublishBlocks(nodeResource({ state: 'future_state' as NodeResourceState }))).toEqual(['本机资源服务状态未知']);
  });

  it('enables publishing with exactly the D10 publish gate (auto_reload_atomic_replace and the other keys are not required)', async () => {
    expect(CAPABILITY_GATES.publish).not.toContain('auto_reload_atomic_replace');
    const only: Partial<Record<CapabilityKey, CapabilityStatus>> = Object.fromEntries(CAPABILITY_GATES.publish.map((k) => [k, 'supported']));
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/deployments/publish' ? accepted : { status: 404 }),
      snapshotWithNodeResource(nodeResource(), { environments: [pendingEnv], capabilities: capabilities(only) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.disabled).toBe(false);
    expect(document.body.querySelector('[data-test="publish-gate"]')).toBeNull();
    expect(document.body.querySelector('[data-test="node-resource-block"]')).toBeNull();
    click(button);
    await flush();
    expect(calls.find((c) => c.url === '/api/deployments/publish')?.body).toEqual({ request_id: expect.any(String) });
    m.unmount();
  });

  it.each([
    ['not_listening', '本机资源服务不可用'],
    ['token_unavailable', '读取令牌不可用'],
    ['legacy_line', '需要重新合并以改用本机资源服务'],
    ['not_installed', '需要重新合并'],
  ] as const)('is disabled with the reason while the resource server is %s, and offers no override', async (state, reason) => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/deployments/publish' ? accepted : { status: 404 }),
      snapshotWithNodeResource(nodeResource({ state }), { environments: [pendingEnv], capabilities: capabilities(allSupported()) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.disabled).toBe(true);
    const block = document.body.querySelector('[data-test="node-resource-block"]')!;
    expect(block.textContent).toContain(reason);
    expect(block.textContent).toContain('已保存，待部署');
    click(button);
    await flush();
    expect(calls.some((c) => c.url === '/api/deployments/publish')).toBe(false);
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const forbidden of ['忽略', '仍然', '强制', '重载', '跳过检查']) expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    expectNoResourceSecrets();
    m.unmount();
  });

  it('is disabled while the read token may have leaked, pointing at the address change', async () => {
    const { ctx } = testContext(() => ({ status: 404 }), snapshotWithNodeResource(nodeResource({ tokenSuspect: true }), { environments: [pendingEnv], capabilities: capabilities(allSupported()) }));
    const m = await mountWith(PendingDeployCard, ctx);
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="node-resource-block"]')?.textContent).toContain('更换本机资源地址');
    m.unmount();
  });

  it('is disabled before the working profile is initialised (nodeResource null), like the service', async () => {
    const { ctx } = testContext(() => ({ status: 404 }), snapshotWithNodeResource(null, { environments: [pendingEnv], capabilities: capabilities(allSupported()) }));
    const m = await mountWith(PendingDeployCard, ctx);
    expect(document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="node-resource-block"]')?.textContent).toContain('尚未初始化固定工作配置');
    m.unmount();
  });

  it('offers to re-sync the node resource when Surge may hold an uncommitted version and nothing is pending', async () => {
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/deployments/publish' ? accepted : { status: 404 }),
      snapshotWithNodeResource(nodeResource({ needsRefresh: true }), { environments: [environment()], capabilities: capabilities(allSupported()) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    expect(document.body.querySelector('[data-test="node-resource-refresh"]')?.textContent).toContain('单 key 更新并读回');
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.textContent).toContain('重新同步节点资源');
    expect(button.disabled).toBe(false);
    click(button);
    await flush();
    // 不带环境的发布：服务对本应用这一项资源执行一次单 key 更新并读回
    expect(calls.find((c) => c.url === '/api/deployments/publish')?.body).toEqual({ request_id: expect.any(String) });
    expect(ctx.toasts.items.map((t) => t.message).join('')).toContain('重新同步节点资源');
    m.unmount();
  });

  it('keeps the re-sync disabled while the publish gate is not met', async () => {
    const { ctx } = testContext(
      () => ({ status: 404 }),
      snapshotWithNodeResource(nodeResource({ needsRefresh: true }), { environments: [environment()], capabilities: capabilities({ ...allSupported(), loopback_publish_crash: 'unverified' }) }),
    );
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.textContent).toContain('重新同步节点资源');
    expect(button.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="node-resource-note"]')?.textContent).toContain('已保存，待部署');
    m.unmount();
  });

  it('nothing pending and nothing to re-sync keeps the button disabled', async () => {
    const { ctx } = testContext(() => ({ status: 404 }), snapshotWithNodeResource(nodeResource(), { environments: [environment()], capabilities: capabilities(allSupported()) }));
    const m = await mountWith(PendingDeployCard, ctx);
    const button = document.body.querySelector<HTMLButtonElement>('[data-test="publish-button"]')!;
    expect(button.textContent).toContain('发布全部待部署');
    expect(button.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="node-resource-refresh"]')).toBeNull();
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
      macosVersionExtra: 'none',
      macosRestartPending: 'no',
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
    expect(coverageBlockReason(proposal({ key: 'loopback_resource_update', protocolCoverage: null }))).toBeNull();
  });
});

describe('versionBlockReason', () => {
  it('blocks confirming a version-dependent proposal without a readable, well-formed Surge version and build', () => {
    const ctx = proposal().context;
    expect(versionBlockReason(proposal())).toBeNull();
    expect(versionBlockReason(proposal({ context: { ...ctx, surgeVersion: '6.5', surgeBuild: '1' } }))).toBeNull();
    expect(versionBlockReason(proposal({ context: { ...ctx, surgeVersion: null, surgeBuild: null } }))).toBe(
      '提议中的 Surge 版本、Surge 构建读不到或格式不正确，不能确认；请在能读取运行中 Surge 的版本后重测并重新提议（新的提议送达后这条提议自动移除）',
    );
    // 旧解析器从 CLI 交互模式输出中取到的地址、any、带说明的构建号
    expect(versionBlockReason(proposal({ context: { ...ctx, surgeVersion: '127.0.0.1' } }))).toContain('Surge 版本');
    expect(versionBlockReason(proposal({ context: { ...ctx, surgeVersion: 'any', surgeBuild: 'any' } }))).toContain('Surge 版本、Surge 构建');
    expect(versionBlockReason(proposal({ context: { ...ctx, surgeBuild: '10960 (beta)' } }))).toContain('Surge 构建');
  });

  it('does not check capabilities that do not depend on the Surge version', () => {
    const ctx = proposal().context;
    expect(versionBlockReason(proposal({ key: 'open_profile_by_id', context: { ...ctx, surgeVersion: null, surgeBuild: null } }))).toBeNull();
  });
});

describe('hostBlockReason (Background Security Improvement)', () => {
  const ctx = proposal().context;

  it('blocks confirming a process-attribution proposal measured while an improvement awaited a restart, or without the fields', () => {
    expect(hostBlockReason(proposal())).toBeNull();
    expect(hostBlockReason(proposal({ context: { ...ctx, macosVersionExtra: '(a)' } }))).toBeNull();
    expect(hostBlockReason(proposal({ context: { ...ctx, macosRestartPending: 'yes' } }))).toContain('请重启 Mac 后重测并重新提议');
    expect(hostBlockReason(proposal({ context: { ...ctx, macosRestartPending: null } }))).toContain('没有确认是否有待重启的后台安全改进');
    expect(hostBlockReason(proposal({ context: { ...ctx, macosVersionExtra: null } }))).toContain('后台安全改进版本读不到或为 any');
    expect(hostBlockReason(proposal({ context: { ...ctx, macosVersionExtra: 'any' } }))).toContain('后台安全改进版本读不到或为 any');
    // 早于该规则提交的提议没有这两个字段
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = ctx;
    expect(hostBlockReason(proposal({ context: legacy as typeof ctx }))).not.toBeNull();
  });

  it('does not check capabilities that do not depend on process attribution', () => {
    expect(hostBlockReason(proposal({ key: 'native_bridge_ipc', context: { ...ctx, macosRestartPending: 'yes', macosVersionExtra: null } }))).toBeNull();
  });
});

describe('staleReasonText', () => {
  const ctx = proposal().context;
  const SURGE = { version: '6.5.0', build: '3000' };

  it('says a restart is needed when a Background Security Improvement awaits one (or it cannot be told)', () => {
    expect(staleReasonText({ staleReasons: ['macosRestartPending'], context: ctx }, SURGE)).toBe(
      'Mac 有已安装、尚未重启生效的后台安全改进（或无法确认是否有）：Safari 可能已在使用新的 WebKit，进程归属按待验证处理，请重启 Mac',
    );
    expect(staleReasonText({ staleReasons: ['macosVersionExtra'], context: ctx }, SURGE)).toBe('后台安全改进版本已变化');
    // 旧记录没有这两个字段：需要重测，不是“已变化”或“请重启”
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = ctx;
    expect(staleReasonText({ staleReasons: ['macosVersionExtra', 'macosRestartPending'], context: legacy as typeof ctx }, SURGE)).toBe(
      '验证记录缺少 后台安全改进版本、后台安全改进待重启状态，需要重测',
    );
    expect(staleReasonText({ staleReasons: ['macosVersionExtra', 'macosRestartPending'], context: { ...ctx, macosVersionExtra: '(a)' } }, SURGE)).toBe(
      'Mac 有已安装、尚未重启生效的后台安全改进（或无法确认是否有）：Safari 可能已在使用新的 WebKit，进程归属按待验证处理，请重启 Mac；后台安全改进版本已变化',
    );
  });

  it('says the current Surge version cannot be read instead of claiming it changed', () => {
    const text = staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: ctx }, { version: null, build: null });
    expect(text).toBe('读不到当前的 Surge 版本、Surge 构建，依赖版本的能力按待验证处理');
    expect(text).not.toContain('已变化');
    expect(staleReasonText({ staleReasons: ['surgeBuild'], context: { ...ctx, surgeBuild: 'any' } }, { version: '6.5.0', build: null })).toBe('读不到当前的 Surge 构建，依赖版本的能力按待验证处理');
  });

  it('says the record has no version when it was measured without one', () => {
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: { ...ctx, surgeVersion: null, surgeBuild: null } }, SURGE)).toBe('验证记录缺少 Surge 版本、Surge 构建，需要重测');
    // 早于提议校验确认的记录（any 或旧解析器的 127.0.0.1）在读到版本时同样过期：不是“已变化”，而是没有具体版本
    expect(staleReasonText({ staleReasons: ['surgeVersion', 'surgeBuild'], context: { ...ctx, surgeVersion: 'any', surgeBuild: 'any' } }, SURGE)).toBe('验证记录缺少 Surge 版本、Surge 构建，需要重测');
    expect(staleReasonText({ staleReasons: ['surgeVersion'], context: { ...ctx, surgeVersion: '127.0.0.1' } }, SURGE)).toBe('验证记录缺少 Surge 版本，需要重测');
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
      c.key === 'loopback_resource_update' ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['surgeVersion' as const, 'surgeBuild' as const], context: proposal().context } : c,
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
    expect(document.body.querySelectorAll('[data-test="criteria"]')).toHaveLength(CAPABILITY_KEYS.length);
    // 不使用钥匙串：没有「原生桥读取钥匙串」这一项
    expect(document.body.textContent).not.toContain('钥匙串');
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

  it('disables 确认 with the reason for a pending proposal recorded without a usable Surge version', async () => {
    const legacy = proposal({ key: 'runtime_entry_modes', protocolCoverage: null, context: { ...proposal().context, surgeVersion: null, surgeBuild: null } });
    const { ctx, calls } = testContext(() => ({ status: 404 }), snapshot({ capabilityProposals: [legacy] }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-test="confirm-proposal"]')!;
    expect(confirm.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="confirm-block"]')?.textContent).toContain('读不到或格式不正确，不能确认');
    click(confirm);
    await flush();
    expect(calls.some((c) => c.url === '/api/capabilities' && c.method === 'POST')).toBe(false);
    m.unmount();
  });

  it('shows the restart-needed reason and disables 确认 for a proposal measured while an improvement awaited a restart', async () => {
    const caps = capabilities(allSupported()).map((c) =>
      c.key === 'safari_process_attribution' ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['macosRestartPending' as const], context: proposal().context } : c,
    );
    const pending = proposal({ context: { ...proposal().context, macosRestartPending: 'yes' } });
    const { ctx, calls } = testContext(() => ({ status: 404 }), snapshot({ capabilities: caps, capabilityProposals: [pending] }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const reasons = Array.from(document.body.querySelectorAll('[data-test="stale-reason"]')).map((e) => e.textContent?.trim());
    expect(reasons).toEqual(['Mac 有已安装、尚未重启生效的后台安全改进（或无法确认是否有）：Safari 可能已在使用新的 WebKit，进程归属按待验证处理，请重启 Mac']);
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-test="confirm-proposal"]')!;
    expect(confirm.disabled).toBe(true);
    expect(document.body.querySelector('[data-test="confirm-block"]')?.textContent).toContain('请重启 Mac 后重测并重新提议');
    click(confirm);
    await flush();
    expect(calls.some((c) => c.url === '/api/capabilities' && c.method === 'POST')).toBe(false);
    m.unmount();
  });

  it('details of a record from before the improvement fields existed say 未记录 and ask for a re-test', async () => {
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = proposal().context;
    const caps = capabilities(allSupported()).map((c) =>
      c.key === 'safari_process_attribution'
        ? { ...c, effectiveStatus: 'unverified' as const, staleReasons: ['macosVersionExtra' as const, 'macosRestartPending' as const], context: legacy as ReturnType<typeof proposal>['context'] }
        : c,
    );
    const { ctx } = testContext(() => ({ status: 404 }), snapshot({ capabilities: caps }));
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    click(document.body.querySelector('[aria-label="查看 Safari 精确进程归属 的详情"]'));
    await flush();
    expect(document.body.querySelector('[data-test="detail-stale-reason"]')?.textContent).toBe('过期原因：验证记录缺少 后台安全改进版本、后台安全改进待重启状态，需要重测');
    const dl = document.body.querySelector('.modal dl, dl')!;
    expect(dl.textContent).toContain('后台安全改进待重启状态');
    expect(dl.textContent).toContain('未记录');
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
    const caps = capabilities({ loopback_resource_update: 'supported' });
    const { ctx, calls } = testContext(
      (c: Call) => (c.url === '/api/capabilities' && c.method === 'POST' ? { status: 200, body: { ...caps.find((x) => x.key === 'loopback_resource_update'), status: 'unverified', effectiveStatus: 'unverified' } } : { status: 404 }),
      snapshot({ capabilities: caps }),
    );
    const m = await mountWith(CapabilitiesView, ctx, {}, '/capabilities');
    const resets = document.body.querySelectorAll('[data-test="reset-capability"]');
    expect(resets).toHaveLength(1);
    click(resets[0]);
    await flush();
    click(document.body.querySelector('.modal-footer [data-test="confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ request_id: expect.any(String), action: 'reset', key: 'loopback_resource_update', note: null });
    m.unmount();
  });
});
