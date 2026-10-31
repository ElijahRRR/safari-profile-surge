import { describe, expect, test } from 'vitest';
import {
  API_ROUTES,
  buildPath,
  classifySiteUrl,
  environmentCode,
  exitNodeName,
  frontNodeName,
  isSfeName,
  isTerminalPhase,
  maskLoginIdentifier,
  nodeTag,
  parseExitNodeName,
  shortProfileId,
  SfeError,
  httpStatusFor,
  SAFARI_MINIMUM_VERSION,
  safariBelowMinimum,
  CAPABILITY_CONTEXT_DEPS,
  CAPABILITY_CRITERIA,
  CAPABILITY_GATES,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CAPABILITY_PRIMITIVES,
  EMPTY_PLACEHOLDER_LINE,
  EMPTY_PLACEHOLDER_NODE,
  ERROR_CODES,
  HTTP_STATUS_BY_CODE,
  LEGACY_NODE_GROUP_LINE,
  NODE_RESOURCE_FILE,
  NODE_RESOURCE_HOST,
  RESOURCE_PORT_MAX,
  RESOURCE_PORT_MIN,
  RESOURCE_TOKEN_RE,
  ROUTE_GROUP_NAME,
  nodeResourceUrl,
  parseNodeResourceUrl,
  type RouteWarning,
  type LoginFillResponse,
  type LoginFillServiceResponse,
  type NativeResponseMap,
} from '../src/index.js';

describe('naming', () => {
  test('formats stable codes and versioned node names', () => {
    expect(environmentCode(1)).toBe('E0001');
    expect(environmentCode(12345)).toBe('E12345');
    expect(nodeTag('US', 1)).toBe('US01');
    expect(exitNodeName('E0001', 'US01', 3)).toBe('SFE-N-E0001-US01-v003');
    expect(exitNodeName('E0001', 'US01', 1234)).toBe('SFE-N-E0001-US01-v1234');
    expect(frontNodeName(1)).toBe('SFE-F-F0001');
  });

  test('round-trips exit node names', () => {
    expect(parseExitNodeName('SFE-N-E0001-US01-v018')).toEqual({ envCode: 'E0001', tag: 'US01', proxyRevision: 18 });
    expect(parseExitNodeName('SFE-ROUTE')).toBeNull();
    expect(parseExitNodeName('SFE-N-E0001-US01-v018 ')).toBeNull();
  });

  test('rejects invalid names and sequences', () => {
    expect(isSfeName('SFE-N-E0001-US01-v001')).toBe(true);
    expect(isSfeName('SFE-N 1')).toBe(false);
    expect(isSfeName('sfe-x')).toBe(false);
    expect(() => environmentCode(0)).toThrow();
    expect(() => exitNodeName('E0001', 'US01', 0)).toThrow();
    expect(() => exitNodeName('E 1', 'US01', 1)).toThrow();
  });
});

describe('loopback node resource (D10)', () => {
  const TOKEN = 'a'.repeat(64);
  const URL_OK = `http://127.0.0.1:20000/${TOKEN}/sfe-nodes.list`;

  test('constants', () => {
    expect(NODE_RESOURCE_HOST).toBe('127.0.0.1');
    expect(NODE_RESOURCE_FILE).toBe('sfe-nodes.list');
    expect(RESOURCE_PORT_MIN).toBe(20000);
    expect(RESOURCE_PORT_MAX).toBe(40000);
    // 低于 macOS 的临时端口范围（49152 起）
    expect(RESOURCE_PORT_MAX).toBeLessThanOrEqual(49152);
    expect(RESOURCE_TOKEN_RE.test(TOKEN)).toBe(true);
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)}\n`, '']) expect(RESOURCE_TOKEN_RE.test(bad), JSON.stringify(bad)).toBe(false);
    expect(LEGACY_NODE_GROUP_LINE).toBe(`${ROUTE_GROUP_NAME} = select, REJECT, policy-path=${NODE_RESOURCE_FILE}`);
    expect(EMPTY_PLACEHOLDER_NODE).toBe('SFE-EMPTY');
    expect(EMPTY_PLACEHOLDER_LINE).toBe('SFE-EMPTY = reject');
    // 占位节点符合 SFE 命名，但不是环境出口节点名（从不计为买家节点）
    expect(isSfeName(EMPTY_PLACEHOLDER_NODE)).toBe(true);
    expect(parseExitNodeName(EMPTY_PLACEHOLDER_NODE)).toBeNull();
  });

  test('nodeResourceUrl formats the loopback URL and validates only port 1-65535 and the token format', () => {
    expect(nodeResourceUrl(20000, TOKEN)).toBe(URL_OK);
    const hex = '0123456789abcdef'.repeat(4);
    expect(nodeResourceUrl(39999, hex)).toBe(`http://127.0.0.1:39999/${hex}/sfe-nodes.list`);
    // 范围检查在设置与维护中：1-65535 内范围外的端口照样格式化
    expect(nodeResourceUrl(1, TOKEN)).toBe(`http://127.0.0.1:1/${TOKEN}/sfe-nodes.list`);
    expect(nodeResourceUrl(65535, TOKEN)).toBe(`http://127.0.0.1:65535/${TOKEN}/sfe-nodes.list`);
    for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => nodeResourceUrl(port, TOKEN), String(port)).toThrow(RangeError);
    for (const token of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(62)}/x`, `${'a'.repeat(62)}%2f`, '']) {
      expect(() => nodeResourceUrl(20000, token)).toThrow(RangeError);
      // 错误信息不带出令牌
      try {
        nodeResourceUrl(20000, token);
      } catch (e) {
        if (token) expect((e as Error).message).not.toContain(token);
      }
    }
  });

  test('parseNodeResourceUrl is the strict inverse', () => {
    expect(parseNodeResourceUrl(URL_OK)).toEqual({ port: 20000, token: TOKEN });
    for (const port of [1, 20000, 31337, 39999, 65535]) {
      const hex = port.toString(16).padStart(64, '0');
      expect(parseNodeResourceUrl(nodeResourceUrl(port, hex))).toEqual({ port, token: hex });
    }
    const rejected = [
      // 令牌格式
      `http://127.0.0.1:20000/${'a'.repeat(63)}/sfe-nodes.list`,
      `http://127.0.0.1:20000/${'a'.repeat(65)}/sfe-nodes.list`,
      `http://127.0.0.1:20000/${'A'.repeat(64)}/sfe-nodes.list`,
      `http://127.0.0.1:20000/${'g'.repeat(64)}/sfe-nodes.list`,
      'http://127.0.0.1:20000/sfe-nodes.list',
      // 其他主机、协议或写法
      `http://localhost:20000/${TOKEN}/sfe-nodes.list`,
      `http://[::1]:20000/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.2:20000/${TOKEN}/sfe-nodes.list`,
      `http://192.0.2.1:20000/${TOKEN}/sfe-nodes.list`,
      `http://user@127.0.0.1:20000/${TOKEN}/sfe-nodes.list`,
      `https://127.0.0.1:20000/${TOKEN}/sfe-nodes.list`,
      `HTTP://127.0.0.1:20000/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1/${TOKEN}/sfe-nodes.list`,
      // 查询、片段、末尾斜杠、多余或不同的段
      `${URL_OK}?x=1`,
      `${URL_OK}#x`,
      `${URL_OK}/`,
      `http://127.0.0.1:20000/${TOKEN}/sfe-nodes.list/extra`,
      `http://127.0.0.1:20000/x/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:20000/${TOKEN}//sfe-nodes.list`,
      `http://127.0.0.1:20000//${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:20000/${TOKEN}/other.list`,
      `http://127.0.0.1:20000/${TOKEN}/sfe-nodes%2elist`,
      `http://127.0.0.1:20000/${TOKEN}/SFE-NODES.LIST`,
      // 端口不是数字、越界或有前导零
      `http://127.0.0.1:abc/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:0/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:65536/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:99999/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:020000/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:-1/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:+20000/${TOKEN}/sfe-nodes.list`,
      `http://127.0.0.1:2e4/${TOKEN}/sfe-nodes.list`,
      // 空白与换行
      ` ${URL_OK}`,
      `${URL_OK} `,
      `${URL_OK}\n`,
      '',
    ];
    for (const url of rejected) expect(parseNodeResourceUrl(url), url).toBeNull();
  });
});

describe('sites', () => {
  test('classifies only exact https www.amazon.com pages', () => {
    expect(classifySiteUrl('US', 'https://www.amazon.com/ap/signin?openid=x')).toBe('signin');
    expect(classifySiteUrl('US', 'https://www.amazon.com/ax/claim/intent')).toBe('signin');
    expect(classifySiteUrl('US', 'https://www.amazon.com/ap/mfa?x')).toBe('mfa');
    expect(classifySiteUrl('US', 'https://www.amazon.com/gp/css/order-history')).toBe('orders');
    expect(classifySiteUrl('US', 'https://www.amazon.com/dp/B000')).toBe('other');
    expect(classifySiteUrl('US', 'http://www.amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.com.evil.test/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.co.uk/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://user:pw@www.amazon.com/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'https://www.amazon.com:8443/ap/signin')).toBe('foreign');
    expect(classifySiteUrl('US', 'not a url')).toBe('foreign');
  });
});

describe('redaction helpers', () => {
  test('masks identifiers', () => {
    expect(maskLoginIdentifier('buyer01@example.test')).toBe('b*****1@example.test');
    expect(maskLoginIdentifier('ab@example.test')).toBe('a*@example.test');
    expect(maskLoginIdentifier('+15551234567')).toBe('******4567');
    expect(maskLoginIdentifier(null)).toBeNull();
    expect(shortProfileId('8F1B2C3D-AAAA-BBBB')).toBe('8F1B2C3D');
  });
});

describe('phases, errors, routes', () => {
  test('terminal phases', () => {
    expect(isTerminalPhase('ACTIVE_VERIFIED')).toBe(true);
    expect(isTerminalPhase('VERIFY_ONLY')).toBe(false);
    expect(isTerminalPhase('WAITING_DEPLOYMENT')).toBe(true);
  });

  test('RESOURCE_SERVER_UNAVAILABLE is a well-formed code (A-Z and _, as the Swift bridge requires) and maps to 503', () => {
    expect(ERROR_CODES).toContain('RESOURCE_SERVER_UNAVAILABLE');
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z_]{1,64}$/);
    expect(HTTP_STATUS_BY_CODE.RESOURCE_SERVER_UNAVAILABLE).toBe(503);
    expect(httpStatusFor('RESOURCE_SERVER_UNAVAILABLE')).toBe(503);
    const warning: RouteWarning = 'node_resource_unverified';
    expect(warning).toBe('node_resource_unverified');
  });

  test('errors serialize without extra fields', () => {
    const e = new SfeError('REVISION_CONFLICT', '保存环境失败：版本已变化', { details: { current: 18 } });
    expect(e.toBody()).toEqual({ code: 'REVISION_CONFLICT', message: '保存环境失败：版本已变化', details: { current: 18 } });
    expect(httpStatusFor('REVISION_CONFLICT')).toBe(409);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });

  test('route paths are unique and buildable', () => {
    const keys = Object.values(API_ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(buildPath(API_ROUTES.activate.path, { id: 'env_1' })).toBe('/api/environments/env_1/activate');
    expect(() => buildPath(API_ROUTES.activate.path)).toThrow();
  });
});

describe('safari minimum version', () => {
  // Safari 17.6 才修复 “background pages would stop responding after about 30 seconds”
  test('is 17.6', () => {
    expect(SAFARI_MINIMUM_VERSION).toBe('17.6');
  });

  test('compares dotted versions numerically and returns null when unreadable', () => {
    for (const v of ['17.0', '17.5', '17.5.1', '16.6', '17']) expect(safariBelowMinimum(v)).toBe(true);
    for (const v of ['17.6', '17.6.0', '17.6.1', '17.10', '18.0', '18.0.1', '26.0', ' 18.4 ']) expect(safariBelowMinimum(v)).toBe(false);
    for (const v of [null, '', 'unknown', 'demo', '17.x', '18.0 (20619.1.26)', '-17.0']) expect(safariBelowMinimum(v)).toBeNull();
  });
});

describe('capability keys after D10 (loopback node resource)', () => {
  const LOOPBACK = ['loopback_resource_update', 'loopback_resource_auth', 'loopback_resource_restart', 'loopback_publish_crash'] as const;

  test('the local policy-path keys are gone and the four loopback keys follow safari_udp_quic_handling', () => {
    expect(CAPABILITY_KEYS).toHaveLength(21);
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
    for (const old of ['targeted_resource_refresh', 'policy_path_reread']) expect(CAPABILITY_KEYS as readonly string[]).not.toContain(old);
    const i = CAPABILITY_KEYS.indexOf('safari_udp_quic_handling');
    expect(CAPABILITY_KEYS.slice(i + 1, i + 6)).toEqual([...LOOPBACK, 'external_node_underlying_proxy']);
    for (const table of [CAPABILITY_LABELS, CAPABILITY_CONTEXT_DEPS, CAPABILITY_CRITERIA]) expect(Object.keys(table).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const key of Object.keys(CAPABILITY_PRIMITIVES)) expect(CAPABILITY_KEYS as readonly string[]).toContain(key);
    expect(JSON.stringify({ CAPABILITY_LABELS, CAPABILITY_CRITERIA })).not.toMatch(/targeted_resource_refresh|policy_path_reread/);
  });

  test('labels and context dependencies', () => {
    expect(LOOPBACK.map((k) => CAPABILITY_LABELS[k])).toEqual(['回环节点资源单 key 更新', '回环资源服务认证与端口占用', '回环资源重启后的缓存与恢复', '回环资源并发发布与崩溃恢复']);
    expect(CAPABILITY_CONTEXT_DEPS.loopback_resource_update).toEqual(['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism', 'autoReload']);
    expect(CAPABILITY_CONTEXT_DEPS.loopback_resource_auth).toEqual(['surgeVersion', 'surgeBuild', 'macosBuild', 'adapterMechanism']);
    expect(CAPABILITY_CONTEXT_DEPS.loopback_resource_restart).toEqual(['surgeVersion', 'surgeBuild', 'macosBuild', 'workingProfileId']);
    expect(CAPABILITY_CONTEXT_DEPS.loopback_publish_crash).toEqual(['surgeVersion', 'surgeBuild', 'workingProfileId', 'adapterMechanism']);
  });

  test('gates: publish needs the four loopback checks, the chain and continuity; serving credentials needs update, auth and restart', () => {
    expect([...CAPABILITY_GATES.publish]).toEqual([...LOOPBACK, 'external_node_underlying_proxy', 'connection_continuity']);
    expect([...CAPABILITY_GATES.resourceServe]).toEqual(['loopback_resource_update', 'loopback_resource_auth', 'loopback_resource_restart']);
    for (const k of CAPABILITY_GATES.resourceServe) expect(CAPABILITY_GATES.publish as readonly string[]).toContain(k);
    // 本地规则集的原子替换仍是规则集入口策略与维护写入的门槛
    expect([...CAPABILITY_GATES.activateRulesetStrategy]).toEqual(['auto_reload_atomic_replace']);
    expect([...CAPABILITY_GATES.maintenanceWrite]).toEqual(['auto_reload_atomic_replace']);
  });

  test('primitives: updateExternalResource only where publish calls it for its one loopback resource', () => {
    expect(CAPABILITY_PRIMITIVES.loopback_resource_update).toEqual(['listExternalResources', 'updateExternalResource', 'getGroupMembers', 'getGroupSelection']);
    expect(CAPABILITY_PRIMITIVES.loopback_resource_auth).toEqual(['listExternalResources', 'updateExternalResource', 'getGroupMembers']);
    expect(CAPABILITY_PRIMITIVES.loopback_resource_restart).toEqual(['listExternalResources', 'getGroupMembers', 'getGroupSelection']);
    expect(CAPABILITY_PRIMITIVES.loopback_publish_crash).toEqual(['listExternalResources', 'updateExternalResource', 'getGroupMembers']);
    expect(CAPABILITY_PRIMITIVES.connection_continuity).toEqual(['selectGroupPolicy', 'getGroupMembers', 'updateExternalResource']);
    const withUpdate = (Object.keys(CAPABILITY_PRIMITIVES) as (keyof typeof CAPABILITY_PRIMITIVES)[]).filter((k) => CAPABILITY_PRIMITIVES[k]!.includes('updateExternalResource'));
    expect(withUpdate.sort()).toEqual(['connection_continuity', 'loopback_publish_crash', 'loopback_resource_auth', 'loopback_resource_update']);
  });

  test('criteria describe the loopback design, never the local policy-path re-read', () => {
    for (const k of [...LOOPBACK, 'connection_continuity'] as const) {
      expect(CAPABILITY_CRITERIA[k]).not.toMatch(/本地 policy-path|自动重新读取|写入本地/);
    }
    expect(CAPABILITY_CRITERIA.loopback_resource_update).toContain('127.0.0.1');
    expect(CAPABILITY_CRITERIA.loopback_resource_update).toContain('从不 update all');
    expect(CAPABILITY_CRITERIA.loopback_resource_update).toContain('SFE-EMPTY');
    expect(CAPABILITY_CRITERIA.connection_continuity).toBe('发布节点资源期间（资源服务提供新版本并对该资源执行一次单 key 更新），其他应用的长连接保持、新请求正常、出口不变，并与未执行变更的对照比较。');
  });
});

describe('no Keychain (user decision: secrets stay in the service data directory)', () => {
  test('the capability list has no keychain gate; fill and auto-open need only the profile id and first-request checks', () => {
    expect(CAPABILITY_KEYS).toHaveLength(21);
    expect(CAPABILITY_KEYS as readonly string[]).not.toContain('bridge_keychain_access');
    for (const table of [CAPABILITY_LABELS, CAPABILITY_CONTEXT_DEPS, CAPABILITY_CRITERIA]) expect(Object.keys(table).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect([...CAPABILITY_GATES.fillAndAutoOpen]).toEqual(['native_profile_id', 'first_request_and_old_connections']);
    expect(JSON.stringify({ CAPABILITY_LABELS, CAPABILITY_CRITERIA })).not.toMatch(/钥匙串|keychain/i);
  });

  test('the login fill response is the same shape for the bridge and the extension: values only', () => {
    const service: LoginFillServiceResponse = { fills: [{ field: 'identifier', value: 'buyer01@example.test' }, { field: 'password', value: 'synth-pw' }] };
    const extension: LoginFillResponse = service;
    const mapped: NativeResponseMap['requestLoginFill'] = extension;
    expect(mapped.fills.map((f) => Object.keys(f).sort())).toEqual([
      ['field', 'value'],
      ['field', 'value'],
    ]);
  });
});
