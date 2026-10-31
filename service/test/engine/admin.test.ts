import { afterEach, describe, expect, test } from 'vitest';
import { SfeError, type ProposeCapabilityRequest, type ProtocolCoverage } from '@sfe/contract';
import { FAKE_SAFARI_PATH } from '../../src/surge/fake.js';
import { processPathsDigest } from '../../src/engine/capabilities.js';
import { ADMIN, AGENT, PROFILE_A, WEB, activeEnv, anyContext, createEnv, createHarness, rid, type Harness } from './harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function expectError(p: Promise<unknown>, code: string): Promise<SfeError> {
  try {
    await p;
  } catch (err) {
    expect((err as SfeError).code).toBe(code);
    return err as SfeError;
  }
  throw new Error(`expected ${code}`);
}

const FULL_COVERAGE: ProtocolCoverage = {
  ipv4: { result: 'pass', note: null },
  ipv6: { result: 'limitation', note: '本机网络无 IPv6，未覆盖' },
  http1: { result: 'pass', note: null },
  http2: { result: 'pass', note: null },
  http3_quic: { result: 'pass', note: 'H3 被拒绝并回落 TCP' },
  websocket: { result: 'pass', note: null },
  extension_page_fetch: { result: 'pass', note: null },
};

/** 测量时读到的 Surge 版本与构建（与 FakeSurge 默认值相同）：依赖版本的能力不能记为 null 或 any。其余字段不限。 */
function measuredContext() {
  return { ...anyContext(), surgeVersion: '6.10.0', surgeBuild: '12500' };
}

function proposal(patch: Partial<ProposeCapabilityRequest> = {}): ProposeCapabilityRequest {
  return {
    request_id: rid('prop'),
    key: 'connection_continuity',
    proposed_status: 'supported',
    context: measuredContext(),
    summary: '发布期间 Chrome 长连接保持（脱敏摘要）',
    evidence_digest: 'sha256:0123456789abcdef',
    ...patch,
  };
}

describe('capability proposals and confirmation', () => {
  test('only agent/admin can propose; only web can confirm', async () => {
    h = await createHarness({ capabilities: [] });
    await expectError(h.app.proposeCapability(proposal(), WEB), 'BAD_REQUEST');
    const { proposal_id } = await h.app.proposeCapability(proposal(), AGENT);
    expect(proposal_id).toMatch(/^prop_/);
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, ADMIN), 'BAD_REQUEST');
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, AGENT), 'BAD_REQUEST');
    const view = await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(view).toMatchObject({ key: 'connection_continuity', status: 'supported', effectiveStatus: 'supported', proposalId: proposal_id });
    // 已处理的提议不能再次确认
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB), 'NOT_FOUND');
    const reset = await h.app.confirmCapability({ request_id: rid(), action: 'reset', key: 'connection_continuity', note: '重新实测' }, WEB);
    expect(reset.status).toBe('unverified');
  });

  test('stale context → effective unverified with reasons', async () => {
    h = await createHarness({ capabilities: [] });
    const ctx = { ...measuredContext(), surgeVersion: '6.4.0', surgeBuild: '1' };
    const { proposal_id } = await h.app.proposeCapability(proposal({ context: ctx }), ADMIN);
    const view = await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(view.status).toBe('supported');
    expect(view.effectiveStatus).toBe('unverified');
    expect(view.staleReasons).toEqual(expect.arrayContaining(['surgeVersion', 'surgeBuild']));
  });

  test('version-dependent proposals need a readable, well-formed Surge version and build', async () => {
    h = await createHarness({ capabilities: [] });
    const cases: Array<[Record<string, string | null>, string[]]> = [
      [{ surgeVersion: null, surgeBuild: null }, ['context.surgeVersion', 'context.surgeBuild']],
      [{ surgeVersion: 'any', surgeBuild: 'any' }, ['context.surgeVersion', 'context.surgeBuild']],
      // 旧解析器把 surge-cli 交互模式输出中的地址当成版本
      [{ surgeVersion: '127.0.0.1', surgeBuild: null }, ['context.surgeVersion', 'context.surgeBuild']],
      [{ surgeVersion: '6.5.0', surgeBuild: 'any' }, ['context.surgeBuild']],
      [{ surgeVersion: '6.5.0', surgeBuild: '10960 (beta)' }, ['context.surgeBuild']],
      [{ surgeVersion: 'Surge 6.5', surgeBuild: '10960' }, ['context.surgeVersion']],
    ];
    for (const status of ['supported', 'unsupported'] as const) {
      for (const [patch, fields] of cases) {
        const err = await expectError(h.app.proposeCapability(proposal({ proposed_status: status, context: { ...measuredContext(), ...patch } }), AGENT), 'EVIDENCE_REQUIRED');
        expect(err.fieldErrors?.map((e) => e.field), JSON.stringify(patch)).toEqual(fields);
      }
    }
    expect(h.repos.proposals.list()).toEqual([]);
    // 两段版本号与任意位数的构建号都接受
    const ok = await h.app.proposeCapability(proposal({ context: { ...measuredContext(), surgeVersion: '6.5', surgeBuild: '1' } }), ADMIN);
    expect(ok.proposal_id).toMatch(/^prop_/);
  });

  test('confirming a pending proposal re-checks the version: one stored without a usable version is refused and dismissed before any setting or record changes', async () => {
    h = await createHarness();
    const newPath = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    // 早于提议校验写入的提议（a95e67d 的 P0 只警告就提交了读不到版本的提议；更早的解析器记录 127.0.0.1）
    const bad: Array<{ key: 'runtime_entry_modes' | 'safari_process_attribution'; surgeVersion: string | null; surgeBuild: string | null; fields: string[] }> = [
      { key: 'runtime_entry_modes', surgeVersion: null, surgeBuild: null, fields: ['context.surgeVersion', 'context.surgeBuild'] },
      { key: 'runtime_entry_modes', surgeVersion: '127.0.0.1', surgeBuild: null, fields: ['context.surgeVersion', 'context.surgeBuild'] },
      { key: 'runtime_entry_modes', surgeVersion: 'any', surgeBuild: 'any', fields: ['context.surgeVersion', 'context.surgeBuild'] },
      { key: 'safari_process_attribution', surgeVersion: '6.5.0', surgeBuild: null, fields: ['context.surgeBuild'] },
    ];
    const settingsBefore = h.repos.settings.getAll();
    const recordsBefore = JSON.stringify(h.repos.capabilities.list());
    expect(settingsBefore.entryStrategy).toBe('ruleset_resource');
    for (const [i, c] of bad.entries()) {
      const id = `prop_legacy${i}`;
      h.repos.proposals.insert({
        id,
        key: c.key,
        proposedStatus: 'supported',
        context: { ...anyContext(), surgeVersion: c.surgeVersion, surgeBuild: c.surgeBuild, processPathsDigest: processPathsDigest([newPath]) },
        summary: '旧提议（测试）',
        evidenceDigest: 'sha256:0123456789abcdef',
        submittedBy: 'agent',
        ...(c.key === 'runtime_entry_modes' ? { entryStrategy: 'temp_rule' as const } : { safariProcessPaths: [newPath], protocolCoverage: FULL_COVERAGE }),
      });
      expect((await h.app.snapshot(WEB)).capabilityProposals.map((p) => p.id)).toContain(id);
      const events = h.events.length;
      const err = await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: id }, WEB), 'EVIDENCE_REQUIRED');
      expect(err.fieldErrors?.map((e) => e.field), JSON.stringify(c)).toEqual(c.fields);
      // 这条提议永远不能确认：标为已驳回，不再出现在待确认列表中（网页收到能力更新）；再次确认为 NOT_FOUND
      expect(h.repos.proposals.get(id)).toMatchObject({ confirmedAt: null, rejectedAt: expect.any(String) });
      expect((await h.app.snapshot(WEB)).capabilityProposals.map((p) => p.id)).not.toContain(id);
      expect(h.events.slice(events).some((e) => e.type === 'capabilities.updated')).toBe(true);
      await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: id }, WEB), 'NOT_FOUND');
    }
    // 设置与全部能力记录（包括依赖入口策略或进程路径的其他能力）不变
    expect(h.repos.settings.getAll()).toEqual(settingsBefore);
    expect(JSON.stringify(h.repos.capabilities.list())).toBe(recordsBefore);
    // 同一形状、带读到的版本时照常确认
    h.repos.proposals.insert({
      id: 'prop_measured',
      key: 'runtime_entry_modes',
      proposedStatus: 'supported',
      context: measuredContext(),
      summary: '重测后的提议（测试）',
      evidenceDigest: 'sha256:0123456789abcdef',
      submittedBy: 'agent',
      entryStrategy: 'temp_rule',
    });
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: 'prop_measured' }, WEB);
    expect(h.repos.settings.get('entryStrategy')).toBe('temp_rule');
  });

  test('a new proposal for the same capability dismisses older pending proposals that can never be confirmed; other pending proposals stay', async () => {
    h = await createHarness({ capabilities: [] });
    const legacy = (id: string, key: 'connection_continuity' | 'loopback_resource_update', surgeVersion: string | null) =>
      h.repos.proposals.insert({
        id,
        key,
        proposedStatus: 'supported',
        context: { ...anyContext(), surgeVersion, surgeBuild: null },
        summary: '旧提议（测试）',
        evidenceDigest: 'sha256:0123456789abcdef',
        submittedBy: 'agent',
      });
    // 早于版本校验提交的提议（旧解析器记录 127.0.0.1；a95e67d 的 P0 提交读不到版本的提议）
    legacy('prop_legacy_a', 'connection_continuity', '127.0.0.1');
    legacy('prop_legacy_b', 'connection_continuity', null);
    legacy('prop_legacy_other', 'loopback_resource_update', null);
    const valid = await h.app.proposeCapability(proposal(), AGENT);
    const pending = () => h.repos.proposals.list({ pending: true }).map((p) => p.id).sort();
    expect(pending()).toEqual(['prop_legacy_other', valid.proposal_id].sort());
    expect(h.repos.proposals.get('prop_legacy_a')!.rejectedAt).not.toBeNull();
    expect(h.repos.proposals.get('prop_legacy_b')!.rejectedAt).not.toBeNull();
    // 能确认的较早提议不被作废（例如对同一能力分别实测的两个结论，由网页选择确认哪一个）
    const second = await h.app.proposeCapability(proposal({ proposed_status: 'unsupported' }), AGENT);
    expect(pending()).toEqual(['prop_legacy_other', valid.proposal_id, second.proposal_id].sort());
    expect((await h.app.snapshot(WEB)).capabilityProposals.map((p) => p.id).sort()).toEqual(pending());
    // 重测后的提议照常确认
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: valid.proposal_id }, WEB);
    expect((await h.app.listCapabilities()).find((c) => c.key === 'connection_continuity')).toMatchObject({ status: 'supported', effectiveStatus: 'supported' });
  });

  test('capabilities that do not depend on the Surge version accept a null version', async () => {
    h = await createHarness({ capabilities: [] });
    const { proposal_id } = await h.app.proposeCapability(proposal({ key: 'open_profile_by_id', context: { ...anyContext(), surgeVersion: null, surgeBuild: null } }), AGENT);
    const view = await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(view).toMatchObject({ key: 'open_profile_by_id', effectiveStatus: 'supported', staleReasons: [] });
  });

  test('attribution and UDP proposals need protocol coverage; supported needs every gating item', async () => {
    h = await createHarness({ capabilities: [] });
    await expectError(h.app.proposeCapability(proposal({ key: 'safari_udp_quic_handling' }), AGENT), 'EVIDENCE_REQUIRED');
    const partial = await h.app.proposeCapability(proposal({ key: 'safari_udp_quic_handling', protocol_coverage: { ipv4: { result: 'pass', note: null } } }), AGENT);
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: partial.proposal_id }, WEB), 'EVIDENCE_REQUIRED');
    const full = await h.app.proposeCapability(proposal({ key: 'safari_udp_quic_handling', protocol_coverage: FULL_COVERAGE }), AGENT);
    const v = await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: full.proposal_id }, WEB);
    expect(v.protocolCoverage).toEqual(FULL_COVERAGE);
  });

  test('process paths come only from a confirmed attribution proposal; confirming resets dependents; refused unless NORMAL', async () => {
    h = await createHarness();
    await expectError(h.app.proposeCapability(proposal({ key: 'safari_process_attribution', protocol_coverage: FULL_COVERAGE, safari_process_paths: ['Safari'] }), AGENT), 'EVIDENCE_REQUIRED');
    await expectError(
      h.app.proposeCapability(proposal({ key: 'safari_process_attribution', protocol_coverage: FULL_COVERAGE, safari_process_paths: ['/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/x'] }), AGENT),
      'EVIDENCE_REQUIRED',
    );
    const newPath = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
    const { proposal_id } = await h.app.proposeCapability(
      proposal({ key: 'safari_process_attribution', protocol_coverage: FULL_COVERAGE, safari_process_paths: [newPath], context: { ...measuredContext(), processPathsDigest: processPathsDigest([newPath]) } }),
      AGENT,
    );
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB), 'ENVIRONMENT_ACTIVE');
    expect(h.repos.settings.get('safariProcessPaths')).toEqual([FAKE_SAFARI_PATH]);
    const envId = h.repos.routeState.get().activeEnvironmentId!;
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(h.repos.settings.get('safariProcessPaths')).toEqual([newPath]);
    // 依赖进程路径的其他能力回到待验证
    const caps = await h.app.listCapabilities();
    expect(caps.find((c) => c.key === 'runtime_entry_modes')!.status).toBe('unverified');
    expect(caps.find((c) => c.key === 'safari_process_attribution')!.status).toBe('supported');
    expect(caps.find((c) => c.key === 'native_bridge_ipc')!.status).toBe('supported');
  });

  test('entry strategy comes only from a confirmed runtime_entry_modes proposal', async () => {
    h = await createHarness({ capabilities: [] });
    await expectError(h.app.proposeCapability(proposal({ key: 'runtime_entry_modes' }), AGENT), 'EVIDENCE_REQUIRED');
    const { proposal_id } = await h.app.proposeCapability(proposal({ key: 'runtime_entry_modes', entry_strategy: 'temp_rule' }), AGENT);
    await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(h.repos.settings.get('entryStrategy')).toBe('temp_rule');
    expect((await h.app.getSettings()).entryStrategy).toBe('temp_rule');
  });

  test('demo mode refuses to record capabilities', async () => {
    h = await createHarness();
    (h.app.engine.deps as { demo: boolean }).demo = true;
    await expectError(h.app.proposeCapability(proposal(), AGENT), 'BAD_REQUEST');
    await expectError(h.app.confirmCapability({ request_id: rid(), action: 'reset', key: 'connection_continuity', note: null }, WEB), 'BAD_REQUEST');
  });

  test('proposal request_id is idempotent', async () => {
    h = await createHarness();
    const p = proposal();
    const a = await h.app.proposeCapability(p, AGENT);
    const b = await h.app.proposeCapability(p, AGENT);
    expect(b).toEqual(a);
    await expectError(h.app.proposeCapability({ ...p, summary: '不同的摘要' }, AGENT), 'DUPLICATE_REQUEST_MISMATCH');
  });
});

describe('settings', () => {
  test('verify endpoint only changes in NORMAL and expires Safari probes', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    (h.app.engine.deps as { verifyEndpoints: unknown }).verifyEndpoints = [
      { id: 'ipify', url: 'https://verify.example.test/?format=json', host: 'verify.example.test', label: 'a' },
      { id: 'alt', url: 'https://verify2.example.test/', host: 'verify2.example.test', label: 'b' },
    ];
    await expectError(h.app.updateSettings({ request_id: rid(), verifyEndpointId: 'alt' }, WEB), 'ENVIRONMENT_ACTIVE');
    await expectError(h.app.updateSettings({ request_id: rid(), verifyEndpointId: 'nope' }, WEB), 'VALIDATION_FAILED');
    await h.app.enterNormal({ request_id: rid(), old_session_policy: 'closed_confirmed', confirmed_environment_id: envId }, WEB);
    await h.idle();
    const s = await h.app.updateSettings({ request_id: rid(), verifyEndpointId: 'alt' }, WEB);
    expect(s.verifyEndpointId).toBe('alt');
    expect(Date.parse(h.repos.probes.latest(envId, 'safari')!.expiresAt)).toBeLessThanOrEqual(h.clock.now().getTime());
  });

  test('timeouts validated; agent cannot change settings', async () => {
    h = await createHarness();
    await expectError(h.app.updateSettings({ request_id: rid(), safariVerifyTimeoutSec: 1 }, WEB), 'VALIDATION_FAILED');
    await expectError(h.app.updateSettings({ request_id: rid(), probeTtlSec: 600 }, AGENT), 'BAD_REQUEST');
    const s = await h.app.updateSettings({ request_id: rid(), probeTtlSec: 600, reconcileIntervalSec: 60 }, ADMIN);
    expect(s).toMatchObject({ probeTtlSec: 600, reconcileIntervalSec: 60 });
    // 入口策略与进程路径不能经设置接口修改
    const s2 = await h.app.updateSettings({ request_id: rid(), entryStrategy: 'temp_rule', safariProcessPaths: ['/x'] } as never, WEB);
    expect(s2.entryStrategy).toBe('ruleset_resource');
    expect(s2.safariProcessPaths).toEqual([FAKE_SAFARI_PATH]);
  });
});

describe('front proxies', () => {
  test('register accepts only real user proxy nodes', async () => {
    h = await createHarness();
    for (const name of ['Daily', 'DIRECT', 'REJECT', 'SFE-ROUTE', 'Missing-Node']) {
      await expectError(h.app.registerFrontProxy({ request_id: rid(), surgeName: name }, WEB), 'VALIDATION_FAILED');
    }
    await expectError(h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, AGENT), 'BAD_REQUEST');
    const f = await h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B', makeDefault: true }, ADMIN);
    expect(f).toMatchObject({ surgeName: 'Front-B', state: 'ok', isDefault: true });
    await expectError(h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, WEB), 'NAME_COLLISION');
    const policies = await h.app.surgePolicies();
    expect(policies.proxies).toEqual(expect.arrayContaining(['Front-A', 'Front-B']));
    expect(policies.proxies.some((p) => p.startsWith('SFE-'))).toBe(false);
  });

  test('retire only without dependents', async () => {
    h = await createHarness();
    await createEnv(h, 'US-Buyer-A', '203.0.113.10');
    await expectError(h.app.updateFrontProxy(h.frontId, { request_id: rid(), retire: true }, WEB), 'VALIDATION_FAILED');
    const b = await h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, WEB);
    const retired = await h.app.updateFrontProxy(b.id, { request_id: rid(), retire: true }, WEB);
    expect(retired.retired).toBe(true);
  });

  test('replace front: preview, stale digest, per-env conflicts, single publish', async () => {
    h = await createHarness();
    const a = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    const b = (await createEnv(h, 'US-Buyer-B', '203.0.113.11')).environment_id!;
    const front = await h.app.registerFrontProxy({ request_id: rid(), surgeName: 'Front-B' }, WEB);
    const preview = await h.app.replaceFrontPreview(h.frontId, { to_front_id: front.id, environment_ids: [a, b] }, WEB);
    expect(preview.items.map((i) => i.environment_id)).toEqual([a, b]);
    const revs = Object.fromEntries(preview.items.map((i) => [i.environment_id, i.revision]));
    // B 在预览之后被修改：只有 B 冲突
    const envB = h.repos.environments.get(b)!;
    await h.app.updateEnvironment(b, { request_id: rid(), expected_revision: envB.revision, changes: { displayName: 'US-Buyer-B2' } }, WEB);
    const deploymentsBefore = h.repos.deployments.list().length;
    const acc = await h.app.replaceFrontCommit(h.frontId, { request_id: rid(), to_front_id: front.id, environment_ids: [a, b], preview_digest: preview.preview_digest, expected_revisions: revs }, WEB);
    await h.idle();
    const op = h.repos.operations.get(acc.operation_id)!;
    expect((op.result as { items: Array<{ status: string }> }).items.map((i) => i.status)).toEqual(['replaced', 'revision_conflict']);
    expect(h.repos.deployments.list().length).toBe(deploymentsBefore + 1);
    expect(h.repos.proxyRevisions.get(a, 2)!.frontProxyId).toBe(front.id);
    expect(h.repos.proxyRevisions.maxRevision(b)).toBe(1);
    // 环境的前置已改变：旧预览过期
    await expectError(
      h.app.replaceFrontCommit(h.frontId, { request_id: rid(), to_front_id: front.id, environment_ids: [a], preview_digest: preview.preview_digest, expected_revisions: revs }, WEB),
      'PREVIEW_STALE',
    );
  });

  test('verify front: missing node marks state and expires the active probe', async () => {
    h = await createHarness();
    const { envId } = await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    const policies = await h.fake.listPolicies();
    h.fake.lieOnNext('listPolicies', { proxies: policies.proxies.filter((p) => p !== 'Front-A'), groups: policies.groups });
    const acc = await h.app.verifyFrontProxy(h.frontId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(acc.operation_id)!.error?.code).toBe('FRONT_PROXY_MISSING');
    expect(h.repos.frontProxies.get(h.frontId)!.state).toBe('missing');
    const ok = await h.app.verifyFrontProxy(h.frontId, { request_id: rid() }, WEB);
    await h.idle();
    expect(h.repos.operations.get(ok.operation_id)!.phase).toBe('COMPLETED');
    expect(Date.parse(h.repos.probes.latest(envId, 'safari')!.expiresAt)).toBeLessThanOrEqual(h.clock.now().getTime());
  });
});
