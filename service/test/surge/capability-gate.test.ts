import { describe, expect, test } from 'vitest';
import {
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CONTEXT_FIELDS,
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  CAPABILITY_PRIMITIVES,
  SfeError,
  type CapabilityContext,
  type CapabilityKey,
} from '@sfe/contract';
import {
  NEVER_NULL_FIELDS,
  computeCapabilityViews,
  contextFieldMatches,
  coverageAllowsSupported,
  createCapabilityGate,
  hostContextErrors,
  mechanismFingerprint,
  versionContextErrors,
  type CapabilityRecordInput,
} from '../../src/surge/capability-gate.js';

const MECH = JSON.stringify({
  selectGroupPolicy: 'http',
  getGroupSelection: 'http',
  getCurrentProfile: 'http',
  listRules: 'http',
  listTempRules: 'cli',
  addTempRule: 'cli',
  removeTempRule: 'cli',
  listExternalResources: 'cli',
  updateExternalResource: 'cli',
  getGroupMembers: 'http',
  testPolicy: 'http',
  getTakeoverState: 'http',
});

const CTX: CapabilityContext = {
  surgeVersion: '6.5.0',
  surgeBuild: '10960',
  macosBuild: '24A335',
  macosVersionExtra: 'none',
  macosRestartPending: 'no',
  safariVersion: '18.0',
  entryStrategy: 'ruleset_resource',
  processPathsDigest: 'pp-1',
  workingProfileId: 'wp-1',
  autoReload: 'off',
  takeoverMode: 'enhanced',
  signingIdentity: 'TEAM000001',
  adapterMechanism: MECH,
};

const record = (key: CapabilityKey, over: Partial<CapabilityRecordInput> = {}): CapabilityRecordInput => ({
  key,
  status: 'supported',
  context: { ...CTX },
  proposalId: 'prop_1',
  verifiedAt: '2026-10-21T00:00:00Z',
  note: null,
  ...over,
});

const ALT: Record<string, string> = {
  surgeVersion: '6.6.0',
  surgeBuild: '11000',
  macosBuild: '24B83',
  macosVersionExtra: '(a)',
  macosRestartPending: 'yes',
  safariVersion: '18.1',
  entryStrategy: 'temp_rule',
  processPathsDigest: 'pp-2',
  workingProfileId: 'wp-2',
  autoReload: 'on',
  takeoverMode: 'system_proxy',
  signingIdentity: 'TEAM000002',
  adapterMechanism: MECH.replace(/"http"/g, '"cli"'),
};

describe('computeCapabilityViews', () => {
  test('one view per capability key; missing records are unverified', () => {
    const views = computeCapabilityViews([], CTX);
    expect(views.map((v) => v.key)).toEqual([...CAPABILITY_KEYS]);
    expect(views.every((v) => v.effectiveStatus === 'unverified' && v.staleReasons.length === 0)).toBe(true);
  });

  test('matching context keeps the recorded status', () => {
    const v = computeCapabilityViews([record('runtime_entry_modes'), record('profile_batch_create', { status: 'unsupported' })], CTX);
    expect(v.find((x) => x.key === 'runtime_entry_modes')!.effectiveStatus).toBe('supported');
    expect(v.find((x) => x.key === 'profile_batch_create')!.effectiveStatus).toBe('unsupported');
  });

  test('a record without context is stale on all its dependencies', () => {
    const v = computeCapabilityViews([record('native_profile_id', { context: null })], CTX);
    const view = v.find((x) => x.key === 'native_profile_id')!;
    expect(view.effectiveStatus).toBe('unverified');
    expect(view.staleReasons).toEqual([...CAPABILITY_CONTEXT_DEPS.native_profile_id]);
  });

  // 每项能力 × 每个上下文字段：依赖的字段变化 → 过期；不依赖的字段变化 → 不影响。
  for (const key of CAPABILITY_KEYS) {
    for (const field of CAPABILITY_CONTEXT_FIELDS) {
      const depends = CAPABILITY_CONTEXT_DEPS[key].includes(field);
      test(`${key} with changed ${field} → ${depends ? 'stale' : 'unchanged'}`, () => {
        const current = { ...CTX, [field]: ALT[field] } as CapabilityContext;
        const view = computeCapabilityViews([record(key)], current).find((x) => x.key === key)!;
        if (depends && field === 'adapterMechanism' && mechanismFingerprint(key, JSON.parse(MECH)) === mechanismFingerprint(key, JSON.parse(ALT.adapterMechanism!))) {
          expect(view.effectiveStatus).toBe('supported');
          return;
        }
        expect(view.effectiveStatus).toBe(depends ? 'unverified' : 'supported');
        expect(view.staleReasons).toEqual(depends ? [field] : []);
      });
    }
  }

  test('unsupported records also become unverified when stale', () => {
    const view = computeCapabilityViews([record('open_profile_by_id', { status: 'unsupported' })], { ...CTX, macosBuild: '25A1' }).find((x) => x.key === 'open_profile_by_id')!;
    expect(view.key).toBe('open_profile_by_id');
    expect(view.effectiveStatus).toBe('unverified');
  });
});

describe('context comparison rules', () => {
  test("recorded 'any' matches everything including null", () => {
    expect(contextFieldMatches('auto_reload_atomic_replace', 'autoReload', 'any', 'on')).toBe(true);
    expect(contextFieldMatches('auto_reload_atomic_replace', 'autoReload', 'any', null)).toBe(true);
  });
  test('unreadable current value only matches a recorded null', () => {
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', null, null)).toBe(true);
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', 'enhanced', null)).toBe(false);
    expect(contextFieldMatches('runtime_entry_modes', 'takeoverMode', null, 'enhanced')).toBe(false);
  });
  test('stale reason lists the unreadable field', () => {
    const v = computeCapabilityViews([record('takeover_state_readable')], { ...CTX, surgeBuild: null }).find((x) => x.key === 'takeover_state_readable')!;
    expect(v.staleReasons).toEqual(['surgeBuild']);
  });
  test('adapterMechanism compares only the primitives the capability depends on', () => {
    const current = JSON.stringify({ ...JSON.parse(MECH), killRequest: 'http', listActiveRequests: 'cli' });
    expect(contextFieldMatches('runtime_entry_modes', 'adapterMechanism', MECH, current)).toBe(true);
    const changed = JSON.stringify({ ...JSON.parse(MECH), addTempRule: 'http' });
    expect(contextFieldMatches('runtime_entry_modes', 'adapterMechanism', MECH, changed)).toBe(false);
    expect(contextFieldMatches('independent_node_preflight', 'adapterMechanism', MECH, changed)).toBe(true);
  });
  test('the fingerprint tracks the primitives the product calls: matchRule is in it, updateExternalResource (local resources are skipped) is in none', () => {
    const full = JSON.parse(MECH) as Record<string, string>;
    const withMatch = JSON.stringify({ ...full, matchRule: 'cli', getAutoReloadSetting: 'unavailable' });
    // install.json 中 matchRule 改为 unavailable（或 http：HTTP 没有 rule match）→ 入口能力过期，激活在写入前被拒绝
    for (const m of ['unavailable', 'http']) {
      const changed = JSON.stringify({ ...JSON.parse(withMatch), matchRule: m });
      expect(contextFieldMatches('runtime_entry_modes', 'adapterMechanism', withMatch, changed), m).toBe(false);
      expect(contextFieldMatches('auto_reload_atomic_replace', 'adapterMechanism', withMatch, changed), m).toBe(false);
    }
    // updateExternalResource 的映射变化不影响任何能力（发布与入口从不调用它）
    const noUpdate = JSON.stringify({ ...JSON.parse(withMatch), updateExternalResource: 'unavailable' });
    for (const key of CAPABILITY_KEYS) expect(contextFieldMatches(key, 'adapterMechanism', withMatch, noUpdate), key).toBe(true);
    for (const prims of Object.values(CAPABILITY_PRIMITIVES)) expect(prims).not.toContain('updateExternalResource');
    // 发布写入前要求可读回的原语（publish.ts）都由发布门槛中的某项能力记录
    const publishPrims = new Set(CAPABILITY_GATES.publish.flatMap((k) => [...(CAPABILITY_PRIMITIVES[k] ?? [])]));
    for (const p of ['getGroupMembers', 'getGroupSelection', 'listExternalResources', 'selectGroupPolicy']) expect(publishPrims.has(p), p).toBe(true);
  });

  test('recorded fingerprint form compares equal to the full current map', () => {
    const recorded = mechanismFingerprint('takeover_state_readable', JSON.parse(MECH));
    expect(recorded).toBe('{"getTakeoverState":"http"}');
    expect(contextFieldMatches('takeover_state_readable', 'adapterMechanism', recorded, MECH)).toBe(true);
  });
  test('fingerprint is canonical and marks missing primitives unavailable', () => {
    expect(mechanismFingerprint('connection_continuity', { selectGroupPolicy: 'http' })).toBe('{"getGroupMembers":"unavailable","selectGroupPolicy":"http"}');
    expect(mechanismFingerprint('native_profile_id', { selectGroupPolicy: 'http' })).toBe('{}');
  });
});

// 读不到 Surge 版本时（例如 Surge 6.5 的 surge-cli --version 进入交互模式），依赖版本的能力一律待验证：
// 记录的 null 或 any 都不能匹配读不到的当前版本，记录的 null 也不匹配读到的版本；记录的 any 也不匹配读到的版本
// （早于提议校验确认的旧记录不能在升级后继续有效）。
describe('Surge version and build never match on null or any', () => {
  const VERSION_KEYS = CAPABILITY_KEYS.filter((k) => CAPABILITY_CONTEXT_DEPS[k].some((f) => NEVER_NULL_FIELDS.includes(f)));
  const NULL_VERSION = { surgeVersion: null, surgeBuild: null };

  test('NEVER_NULL_FIELDS are exactly the Surge version and build', () => {
    expect([...NEVER_NULL_FIELDS]).toEqual(['surgeVersion', 'surgeBuild']);
  });

  for (const field of ['surgeVersion', 'surgeBuild'] as const) {
    test(`${field}: null on either side does not match, recorded any or a malformed value never matches`, () => {
      const value = field === 'surgeVersion' ? '6.5.0' : '10960';
      expect(contextFieldMatches('runtime_entry_modes', field, null, null)).toBe(false);
      expect(contextFieldMatches('runtime_entry_modes', field, 'any', null)).toBe(false);
      expect(contextFieldMatches('runtime_entry_modes', field, value, null)).toBe(false);
      expect(contextFieldMatches('runtime_entry_modes', field, null, value)).toBe(false);
      // 具体值照常比较
      expect(contextFieldMatches('runtime_entry_modes', field, value, value)).toBe(true);
      expect(contextFieldMatches('runtime_entry_modes', field, value, field === 'surgeVersion' ? '6.6.0' : '11000')).toBe(false);
      // 记录为 any 不匹配读到的具体值（否则升级后不会过期）；格式不对的旧值即使与当前值相同也不匹配
      expect(contextFieldMatches('runtime_entry_modes', field, 'any', value)).toBe(false);
      expect(contextFieldMatches('runtime_entry_modes', field, '127.0.0.1', '127.0.0.1')).toBe(false);
      expect(contextFieldMatches('runtime_entry_modes', field, 'any', 'any')).toBe(false);
    });
  }

  test('other fields keep the old rule: null/null and any/null still match', () => {
    // macosVersionExtra 与 macosBuild 同一规则（提议另行拒绝 null 与 any，见 hostContextErrors）
    for (const field of ['takeoverMode', 'autoReload', 'macosBuild', 'macosVersionExtra', 'safariVersion', 'signingIdentity'] as const) {
      expect(contextFieldMatches('runtime_entry_modes', field, null, null)).toBe(true);
      expect(contextFieldMatches('runtime_entry_modes', field, 'any', null)).toBe(true);
    }
  });

  test('records with a null version are stale on surgeVersion and surgeBuild for every version-dependent capability, also after an upgrade', () => {
    expect(VERSION_KEYS.length).toBeGreaterThan(0);
    const recorded = CAPABILITY_KEYS.map((key) => record(key, { context: { ...CTX, ...NULL_VERSION } }));
    for (const current of [{ ...CTX, ...NULL_VERSION }, CTX, { ...CTX, surgeVersion: '6.10.0', surgeBuild: '11500' }]) {
      const views = computeCapabilityViews(recorded, current);
      for (const v of views) {
        if (VERSION_KEYS.includes(v.key)) {
          expect(v.effectiveStatus, v.key).toBe('unverified');
          expect(v.staleReasons, v.key).toEqual(['surgeVersion', 'surgeBuild']);
        } else {
          expect(v.effectiveStatus, v.key).toBe('supported');
        }
      }
    }
  });

  test('records with any as version (confirmed before the proposal rule) are stale whether or not the version can be read, also after an upgrade', () => {
    const recorded = CAPABILITY_KEYS.map((key) => record(key, { context: { ...CTX, surgeVersion: 'any', surgeBuild: 'any' } }));
    for (const current of [{ ...CTX, ...NULL_VERSION }, CTX, { ...CTX, surgeVersion: '6.6.0', surgeBuild: '11200' }]) {
      const views = computeCapabilityViews(recorded, current);
      for (const v of views) {
        if (VERSION_KEYS.includes(v.key)) {
          expect(v.effectiveStatus, v.key).toBe('unverified');
          expect(v.staleReasons, v.key).toEqual(['surgeVersion', 'surgeBuild'].filter((f) => CAPABILITY_CONTEXT_DEPS[v.key].includes(f as never)));
        } else {
          expect(v.effectiveStatus, v.key).toBe('supported');
        }
      }
    }
    // 只有构建号记为 any 时，只列构建号
    const anyBuild = computeCapabilityViews([record('runtime_entry_modes', { context: { ...CTX, surgeBuild: 'any' } })], CTX).find((v) => v.key === 'runtime_entry_modes')!;
    expect(anyBuild).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['surgeBuild'] });
  });

  test('a record holding 127.0.0.1 as version (pre-PR #5 parser) is stale even if the current value were the same string', () => {
    const v = computeCapabilityViews([record('takeover_state_readable', { context: { ...CTX, surgeVersion: '127.0.0.1' } })], { ...CTX, surgeVersion: '127.0.0.1' }).find(
      (x) => x.key === 'takeover_state_readable',
    )!;
    expect(v).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['surgeVersion'] });
  });

  test('an old record holding 127.0.0.1 as version (pre-PR #5 parser) is stale while the version cannot be read', () => {
    const v = computeCapabilityViews([record('takeover_state_readable', { context: { ...CTX, surgeVersion: '127.0.0.1', surgeBuild: null } })], { ...CTX, ...NULL_VERSION }).find(
      (x) => x.key === 'takeover_state_readable',
    )!;
    expect(v.effectiveStatus).toBe('unverified');
    expect(v.staleReasons).toEqual(['surgeVersion', 'surgeBuild']);
  });

  test('the gate refuses version-dependent capabilities with an unreadable version and keeps others', async () => {
    const g = createCapabilityGate({
      list: () => [record('runtime_entry_modes', { context: { ...CTX, ...NULL_VERSION } }), record('native_profile_id', { context: { ...CTX, ...NULL_VERSION } })],
      currentContext: async () => ({ ...CTX, ...NULL_VERSION }),
    });
    await expect(g.require(['native_profile_id'])).resolves.toBeUndefined();
    const err = (await g.require(['runtime_entry_modes', 'native_profile_id']).catch((e: unknown) => e)) as SfeError;
    expect(err.code).toBe('CAPABILITY_UNVERIFIED');
    expect(err.details).toEqual({ missing: [{ key: 'runtime_entry_modes', staleReasons: ['surgeVersion', 'surgeBuild'] }] });
  });
});

describe('versionContextErrors (proposal validation shared by service and P0)', () => {
  test('accepts well-formed version and build', () => {
    for (const surgeVersion of ['6.5', '6.5.0', '10.0.12', '999.999.999']) expect(versionContextErrors('runtime_entry_modes', { surgeVersion, surgeBuild: '10960' })).toEqual([]);
    for (const surgeBuild of ['1', '10960', '1234567890']) expect(versionContextErrors('runtime_entry_modes', { surgeVersion: '6.5.0', surgeBuild })).toEqual([]);
  });

  test('refuses null, any and malformed values for version-dependent capabilities', () => {
    const fields = (ctx: { surgeVersion: string | null; surgeBuild: string | null }) => versionContextErrors('external_node_underlying_proxy', ctx).map((e) => e.field);
    expect(fields({ surgeVersion: null, surgeBuild: null })).toEqual(['surgeVersion', 'surgeBuild']);
    expect(fields({ surgeVersion: 'any', surgeBuild: 'any' })).toEqual(['surgeVersion', 'surgeBuild']);
    for (const bad of ['127.0.0.1', '6', '192.0.2.1', '1234.5', '6.5.', 'v6.5.0', ' 6.5.0', '6.5.0 ', '', '6.5.0\n']) {
      expect(fields({ surgeVersion: bad, surgeBuild: '10960' }), JSON.stringify(bad)).toEqual(['surgeVersion']);
    }
    for (const bad of ['12345678901', '10960a', '-1', '1.0', '', ' 10960']) {
      expect(fields({ surgeVersion: '6.5.0', surgeBuild: bad }), JSON.stringify(bad)).toEqual(['surgeBuild']);
    }
    const [v, b] = versionContextErrors('external_node_underlying_proxy', { surgeVersion: null, surgeBuild: '127.0.0.1' });
    expect(v!.message).toContain('读不到');
    expect(b!.message).toContain('格式不正确');
    expect(versionContextErrors('external_node_underlying_proxy', { surgeVersion: 'any', surgeBuild: '1' })[0]!.message).toContain('不能记为 any');
  });

  test('does not check capabilities that do not depend on the Surge version', () => {
    const independent = CAPABILITY_KEYS.filter((k) => !CAPABILITY_CONTEXT_DEPS[k].includes('surgeVersion') && !CAPABILITY_CONTEXT_DEPS[k].includes('surgeBuild'));
    expect(independent).toContain('native_profile_id');
    for (const key of independent) expect(versionContextErrors(key, { surgeVersion: null, surgeBuild: 'any' })).toEqual([]);
  });
});

// 后台安全改进：装上后 Safari 重开即使用新加密卷宗中的 WebKit，系统其余部分要到重启后才用（Apple 平台安全指南）；
// 基础构建号可能不变（设备管理文档另记补充版本）。依赖进程归属的能力因此也依赖补充版本与待重启状态。
describe('Background Security Improvement context', () => {
  const ATTRIBUTION_KEYS = CAPABILITY_KEYS.filter((k) => CAPABILITY_CONTEXT_DEPS[k].includes('processPathsDigest') && CAPABILITY_CONTEXT_DEPS[k].includes('macosBuild'));

  test('every capability that depends on process paths and the macOS build also depends on both improvement fields; nothing else does', () => {
    expect(ATTRIBUTION_KEYS).toEqual(['safari_process_attribution', 'safari_udp_quic_handling', 'first_request_and_old_connections']);
    for (const key of CAPABILITY_KEYS) {
      const deps = CAPABILITY_CONTEXT_DEPS[key];
      const expected = ATTRIBUTION_KEYS.includes(key);
      expect(deps.includes('macosVersionExtra'), key).toBe(expected);
      expect(deps.includes('macosRestartPending'), key).toBe(expected);
    }
  });

  test("restart pending only matches 'no' recorded and 'no' current (no any, no null, no legacy record)", () => {
    const m = (r: string | null | undefined, c: string | null) => contextFieldMatches('safari_process_attribution', 'macosRestartPending', r as string | null, c);
    expect(m('no', 'no')).toBe(true);
    for (const [r, c] of [
      ['no', 'yes'],
      ['no', null],
      ['no', 'unknown'],
      ['yes', 'yes'],
      ['yes', 'no'],
      ['any', 'no'],
      ['any', 'yes'],
      [null, null],
      [null, 'no'],
      [undefined, 'no'],
      ['unknown', 'unknown'],
    ] as const) {
      expect(m(r, c), `${String(r)} vs ${String(c)}`).toBe(false);
    }
  });

  test('a staged improvement (restart pending) makes the attribution capabilities unverified and blocks activation', async () => {
    const records = CAPABILITY_KEYS.map((k) => record(k));
    const pending = { ...CTX, macosRestartPending: 'yes' as const };
    const views = computeCapabilityViews(records, pending);
    for (const v of views) {
      if (ATTRIBUTION_KEYS.includes(v.key)) expect(v, v.key).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['macosRestartPending'] });
      else expect(v.effectiveStatus, v.key).toBe('supported');
    }
    const err = await createCapabilityGate({ list: () => records, currentContext: async () => pending })
      .require(CAPABILITY_GATES.activate)
      .catch((e: unknown) => e);
    expect((err as SfeError).code).toBe('CAPABILITY_UNVERIFIED');
    expect((err as SfeError).details).toEqual({
      missing: [
        { key: 'safari_process_attribution', staleReasons: ['macosRestartPending'] },
        { key: 'safari_udp_quic_handling', staleReasons: ['macosRestartPending'] },
      ],
    });
  });

  test('an installed improvement with an unchanged base build expires attribution records via the supplemental version', () => {
    const views = computeCapabilityViews(CAPABILITY_KEYS.map((k) => record(k)), { ...CTX, macosVersionExtra: '(a)' });
    for (const v of views) {
      if (ATTRIBUTION_KEYS.includes(v.key)) expect(v.staleReasons, v.key).toEqual(['macosVersionExtra']);
      else expect(v.effectiveStatus, v.key).toBe('supported');
    }
  });

  test('records written before the fields existed are stale on both fields', () => {
    const { macosVersionExtra: _e, macosRestartPending: _p, ...legacy } = CTX;
    const v = computeCapabilityViews([record('safari_process_attribution', { context: legacy as CapabilityContext })], CTX)[0]!;
    expect(v).toMatchObject({ effectiveStatus: 'unverified', staleReasons: ['macosVersionExtra', 'macosRestartPending'] });
  });

  test('hostContextErrors (proposal validation shared by service, P0 and the web)', () => {
    const fields = (key: CapabilityKey, ctx: Partial<CapabilityContext> | null) => hostContextErrors(key, ctx).map((e) => e.field);
    expect(fields('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: 'no' })).toEqual([]);
    expect(fields('safari_process_attribution', { macosVersionExtra: '(a)', macosRestartPending: 'no' })).toEqual([]);
    expect(fields('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: 'yes' })).toEqual(['macosRestartPending']);
    expect(fields('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: 'unknown' })).toEqual(['macosRestartPending']);
    expect(fields('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: null })).toEqual(['macosRestartPending']);
    expect(fields('safari_process_attribution', { macosVersionExtra: null, macosRestartPending: 'no' })).toEqual(['macosVersionExtra']);
    expect(fields('safari_process_attribution', { macosVersionExtra: 'any', macosRestartPending: 'no' })).toEqual(['macosVersionExtra']);
    expect(fields('first_request_and_old_connections', {})).toEqual(['macosRestartPending', 'macosVersionExtra']);
    expect(fields('safari_udp_quic_handling', null)).toEqual(['macosRestartPending', 'macosVersionExtra']);
    expect(hostContextErrors('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: 'yes' })[0]!.message).toContain('请重启 Mac 后重测');
    expect(hostContextErrors('safari_process_attribution', { macosVersionExtra: 'none', macosRestartPending: null })[0]!.message).toContain('无法确认');
    for (const key of CAPABILITY_KEYS.filter((k) => !CAPABILITY_CONTEXT_DEPS[k].includes('macosRestartPending'))) {
      expect(fields(key, { macosVersionExtra: null, macosRestartPending: 'yes' }), key).toEqual([]);
    }
  });
});

describe('createCapabilityGate', () => {
  const gate = (records: CapabilityRecordInput[], ctx = CTX) => createCapabilityGate({ list: () => records, currentContext: async () => ctx });

  test('require passes when all keys are effectively supported', async () => {
    await expect(gate([record('runtime_entry_modes'), record('fixed_profile_no_switch')]).require(['runtime_entry_modes', 'fixed_profile_no_switch'])).resolves.toBeUndefined();
  });

  test('require throws CAPABILITY_UNVERIFIED with missing keys and stale reasons', async () => {
    const g = gate([record('runtime_entry_modes'), record('fixed_profile_no_switch')], { ...CTX, surgeBuild: '99999' });
    const err = await g.require(['runtime_entry_modes', 'native_bridge_ipc']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SfeError);
    expect((err as SfeError).code).toBe('CAPABILITY_UNVERIFIED');
    expect((err as SfeError).message).toMatch(/尚未通过实测$/);
    expect((err as SfeError).details).toEqual({
      missing: [
        { key: 'native_bridge_ipc', staleReasons: [] },
        { key: 'runtime_entry_modes', staleReasons: ['surgeBuild'] },
      ],
    });
  });

  test('missing returns keys that are not supported', async () => {
    expect(await gate([record('runtime_entry_modes')]).missing(['runtime_entry_modes', 'native_bridge_ipc'])).toEqual(['native_bridge_ipc']);
  });

  test('requireMeasured accepts supported or unsupported, refuses unverified', async () => {
    const g = gate([record('same_profile_reload_impact', { status: 'unsupported', note: '重置 3 条连接' })]);
    await expect(g.requireMeasured(['same_profile_reload_impact'])).resolves.toBeUndefined();
    await expect(gate([]).requireMeasured(['same_profile_reload_impact'])).rejects.toMatchObject({ code: 'CAPABILITY_UNVERIFIED' });
  });
});

describe('coverageAllowsSupported', () => {
  test('null coverage misses every gating item', () => {
    expect(coverageAllowsSupported(null)).toEqual({ ok: false, missing: ['ipv4', 'ipv6', 'http1', 'http2', 'http3_quic', 'websocket', 'extension_page_fetch'] });
  });
  test('pass or explained limitation is enough; dns/webrtc are not gating', () => {
    const pass = { result: 'pass' as const, note: null };
    expect(
      coverageAllowsSupported({
        ipv4: pass,
        ipv6: { result: 'limitation', note: '本机无 IPv6，未覆盖' },
        http1: pass,
        http2: pass,
        http3_quic: pass,
        websocket: pass,
        extension_page_fetch: pass,
        dns: { result: 'not_tested', note: null },
      }),
    ).toEqual({ ok: true, missing: [] });
  });
  test('fail, not_tested or limitation without note are missing', () => {
    const pass = { result: 'pass' as const, note: null };
    const r = coverageAllowsSupported({
      ipv4: pass,
      ipv6: { result: 'limitation', note: ' ' },
      http1: { result: 'fail', note: 'x' },
      http2: { result: 'not_tested', note: null },
      http3_quic: pass,
      websocket: pass,
    });
    expect(r).toEqual({ ok: false, missing: ['ipv6', 'http1', 'http2', 'extension_page_fetch'] });
  });
});
