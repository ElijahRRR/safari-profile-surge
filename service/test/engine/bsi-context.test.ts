// 后台安全改进（Background Security Improvement）与能力上下文：装上后 Safari 重开即使用新加密卷宗中的 WebKit，系统
// 其余部分要到重启后才用（Apple 平台安全指南），基础构建号可能不变（设备管理文档把补充版本单独记录）。依赖进程归属的
// 能力因此也依赖补充版本（sw_vers -productVersionExtra）与“待重启”状态；待重启或无法确认时一律待验证，提议拒绝。

import { afterEach, describe, expect, test } from 'vitest';
import { SfeError, type ActivateRequest, type CapabilityContext, type ProposeCapabilityRequest, type ProtocolCoverage } from '@sfe/contract';
import { STAGED_CRYPTEX_PATH, pathPresence, restartPendingFrom, versionExtraFromSwVers } from '../../src/engine/capabilities.js';
import { AGENT, PROFILE_A, WEB, activeEnv, anyContext, bind, createEnv, createHarness, entryWrites, rid, type Harness } from './harness.js';

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
  http3_quic: { result: 'pass', note: null },
  websocket: { result: 'pass', note: null },
  extension_page_fetch: { result: 'pass', note: null },
};

function measured(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return { ...anyContext(), surgeVersion: '6.10.0', surgeBuild: '12500', ...over };
}

function udpProposal(context: CapabilityContext): ProposeCapabilityRequest {
  return {
    request_id: rid('prop'),
    key: 'safari_udp_quic_handling',
    proposed_status: 'supported',
    context,
    summary: 'UDP/QUIC 处理（脱敏摘要）',
    evidence_digest: 'sha256:0123456789abcdef',
    protocol_coverage: FULL_COVERAGE,
  };
}

const view = async (key: string) => (await h.app.listCapabilities()).find((c) => c.key === key)!;
const WRITE_PRIMITIVES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];
const writes = () => ({ ...Object.fromEntries(WRITE_PRIMITIVES.map((k) => [k, h.fake.calls[k] ?? 0])), ...entryWrites(h.fake) });

describe('sw_vers -productVersionExtra (shared with P0)', () => {
  test('empty output with exit 0 means no improvement installed', () => {
    expect(versionExtraFromSwVers({ code: 0, stdout: '' })).toBe('none');
    expect(versionExtraFromSwVers({ code: 0, stdout: '\n' })).toBe('none');
  });
  test('the documented short forms are kept as read', () => {
    expect(versionExtraFromSwVers({ code: 0, stdout: '(a)\n' })).toBe('(a)');
    expect(versionExtraFromSwVers({ code: 0, stdout: 'b\n' })).toBe('b');
  });
  test('failures and unrecognised output are unreadable (null), never "none"', () => {
    expect(versionExtraFromSwVers({ code: 1, stdout: '' })).toBeNull();
    expect(versionExtraFromSwVers({ code: -1, stdout: '' })).toBeNull();
    expect(versionExtraFromSwVers({ code: 0, stdout: 'ProductName:\tmacOS\nProductVersion:\t26.1\n' })).toBeNull();
    expect(versionExtraFromSwVers({ code: 0, stdout: '(a' })).toBeNull();
    for (const reserved of ['none', 'any', 'unknown', 'demo', 'ANY']) expect(versionExtraFromSwVers({ code: 0, stdout: reserved })).toBeNull();
  });
});

describe('staged cryptex presence (shared with P0)', () => {
  const fail = (code: string) => async () => {
    throw Object.assign(new Error(code), { code });
  };
  test('present → restart pending; missing → not pending; any other error → cannot tell (null)', async () => {
    expect(await pathPresence(STAGED_CRYPTEX_PATH, async () => ({}))).toBe('present');
    expect(await pathPresence(STAGED_CRYPTEX_PATH, fail('ENOENT'))).toBe('absent');
    expect(await pathPresence(STAGED_CRYPTEX_PATH, fail('ENOTDIR'))).toBe('absent');
    expect(await pathPresence(STAGED_CRYPTEX_PATH, fail('EACCES'))).toBe('unknown');
    expect(await pathPresence(STAGED_CRYPTEX_PATH, fail('EPERM'))).toBe('unknown');
    expect(restartPendingFrom('present')).toBe('yes');
    expect(restartPendingFrom('absent')).toBe('no');
    expect(restartPendingFrom('unknown')).toBeNull();
  });
  test('the default checker uses lstat on real paths', async () => {
    expect(await pathPresence(process.cwd())).toBe('present');
    expect(await pathPresence('/nonexistent-sfe-test/Incoming')).toBe('absent');
  });
});

// 空闲且入口为 NORMAL 时周期对账不运行；刷新（与网页的「刷新」同一路径）总会重读本机事实
const refresh = async () => {
  await h.app.refreshSurge(WEB);
};

describe('capability views follow the host facts', () => {
  test('a restart-pending improvement makes process-attribution capabilities unverified; restart clears it', async () => {
    h = await createHarness();
    await refresh();
    expect((await view('safari_process_attribution')).effectiveStatus).toBe('supported');
    h.host.macosRestartPending = 'yes';
    await refresh();
    for (const key of ['safari_process_attribution', 'safari_udp_quic_handling', 'first_request_and_old_connections']) {
      expect(await view(key), key).toMatchObject({ status: 'supported', effectiveStatus: 'unverified', staleReasons: ['macosRestartPending'] });
    }
    // 不依赖进程归属的能力不受影响（包括同样依赖 macOS 构建的原生桥）
    expect((await view('runtime_entry_modes')).effectiveStatus).toBe('supported');
    expect((await view('native_bridge_ipc')).effectiveStatus).toBe('supported');
    h.host.macosRestartPending = 'no';
    await refresh();
    expect((await view('safari_process_attribution')).effectiveStatus).toBe('supported');
  });

  test('an installed improvement changes only the supplemental version: records measured before it expire', async () => {
    h = await createHarness();
    h.host.macosVersionExtra = '(a)';
    await refresh();
    expect(await view('safari_process_attribution')).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['macosVersionExtra'] });
    expect((await view('native_profile_id')).effectiveStatus).toBe('supported');
  });

  test('host facts that cannot be read (or throw) are unverified, never "no"', async () => {
    h = await createHarness();
    h.host.macosRestartPending = null;
    await refresh();
    expect((await view('safari_process_attribution')).staleReasons).toEqual(['macosRestartPending']);
    h.host.macosRestartPending = 'unknown';
    await refresh();
    expect((await view('safari_process_attribution')).staleReasons).toEqual(['macosRestartPending']);
  });

  test('records from before the fields existed are stale on both fields', async () => {
    h = await createHarness();
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = measured();
    h.repos.capabilities.upsert({ key: 'safari_process_attribution', status: 'supported', context: legacy as CapabilityContext, verifiedAt: h.clock.now().toISOString(), note: '旧记录' });
    await refresh();
    expect(await view('safari_process_attribution')).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['macosVersionExtra', 'macosRestartPending'] });
  });
});

describe('activation and reconcile fail closed while a restart is pending', () => {
  test('activation is refused before touching the route', async () => {
    h = await createHarness();
    const env = (await createEnv(h, 'US-Buyer-A', '203.0.113.10')).environment_id!;
    await bind(h, PROFILE_A, env);
    h.host.macosRestartPending = 'yes';
    const before = writes();
    const req: ActivateRequest = { request_id: rid('act'), old_session_policy: 'closed_confirmed', confirmed_environment_id: null };
    const a = await h.app.activate(env, req, WEB);
    await h.idle();
    const op = h.repos.operations.get(a.operation_id)!;
    expect(op.phase).toBe('FAILED');
    expect(op.error?.code).toBe('CAPABILITY_UNVERIFIED');
    expect((op.error?.details as { missing: Array<{ key: string; staleReasons: string[] }> }).missing).toContainEqual({ key: 'safari_process_attribution', staleReasons: ['macosRestartPending'] });
    expect(h.repos.routeState.get()).toMatchObject({ entryMode: 'NORMAL', activeEnvironmentId: null });
    expect(writes()).toEqual(before);
  });

  test('an improvement staged while ACTIVE → entry_unverified on the next reconcile, never written', async () => {
    h = await createHarness();
    await activeEnv(h, 'US-Buyer-A', '203.0.113.10', PROFILE_A);
    await h.app.runPeriodicReconcile();
    expect(h.repos.routeState.get().warnings).not.toContain('entry_unverified');
    h.host.macosRestartPending = 'yes';
    const before = writes();
    await h.app.runPeriodicReconcile();
    const route = h.repos.routeState.get();
    expect(route.warnings).toContain('entry_unverified');
    expect(route.phase).toBe('attention');
    expect(writes()).toEqual(before);
    expect((await h.app.ensureInControl()).ok).toBe(false);
  });
});

describe('proposals and confirmation', () => {
  test('a proposal measured while a restart is pending, or without a readable supplemental version, is refused', async () => {
    h = await createHarness({ capabilities: [] });
    const cases: Array<[Partial<CapabilityContext>, string]> = [
      [{ macosRestartPending: 'yes' }, 'context.macosRestartPending'],
      [{ macosRestartPending: null }, 'context.macosRestartPending'],
      [{ macosRestartPending: 'unknown' }, 'context.macosRestartPending'],
      [{ macosVersionExtra: null }, 'context.macosVersionExtra'],
      [{ macosVersionExtra: 'any' }, 'context.macosVersionExtra'],
    ];
    for (const [over, field] of cases) {
      const err = await expectError(h.app.proposeCapability(udpProposal(measured(over)), AGENT), 'EVIDENCE_REQUIRED');
      expect(err.fieldErrors?.map((e) => e.field), JSON.stringify(over)).toEqual([field]);
    }
    // 补充版本为具体值且没有待重启时照常接受并生效
    const { proposal_id } = await h.app.proposeCapability(udpProposal(measured({ macosVersionExtra: 'none', macosRestartPending: 'no' })), AGENT);
    const v = await h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id }, WEB);
    expect(v).toMatchObject({ key: 'safari_udp_quic_handling', effectiveStatus: 'supported' });
  });

  test('capabilities that do not depend on process attribution accept any host state', async () => {
    h = await createHarness({ capabilities: [] });
    const { proposal_id } = await h.app.proposeCapability(
      { ...udpProposal(measured({ macosRestartPending: 'yes', macosVersionExtra: null })), key: 'connection_continuity', protocol_coverage: undefined },
      AGENT,
    );
    expect(proposal_id).toMatch(/^prop_/);
  });

  test('a stored proposal without the host fields can never be confirmed: removed, records unchanged', async () => {
    h = await createHarness({ capabilities: [] });
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = measured();
    h.repos.proposals.insert({
      id: 'prop_legacy_bsi',
      key: 'safari_udp_quic_handling',
      proposedStatus: 'supported',
      context: legacy as CapabilityContext,
      summary: '旧提议（测试）',
      evidenceDigest: 'sha256:0123456789abcdef',
      submittedBy: 'agent',
      protocolCoverage: FULL_COVERAGE,
    });
    const recordsBefore = JSON.stringify(h.repos.capabilities.list());
    const err = await expectError(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: 'prop_legacy_bsi' }, WEB), 'EVIDENCE_REQUIRED');
    expect(err.fieldErrors?.map((e) => e.field)).toEqual(['context.macosRestartPending', 'context.macosVersionExtra']);
    expect(h.repos.proposals.get('prop_legacy_bsi')).toMatchObject({ confirmedAt: null, rejectedAt: expect.any(String) });
    expect(JSON.stringify(h.repos.capabilities.list())).toBe(recordsBefore);
  });
});
