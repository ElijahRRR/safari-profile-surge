// 路由警告分类（D10 的 node_resource_unverified）：节点资源未确认让使用中的路由需要处理、阻断复用与“受控”，但不是失控类
// （不表示入口或 SFE-ROUTE 的选择失去控制）。进入普通模式与 REJECT 保持从不按这些清单拒绝。只用合成数据。

import { describe, expect, test } from 'vitest';
import type { RouteWarning } from '@sfe/contract';
import type { ProbeRecord, RouteStateRecord } from '../../src/db/index.js';
import { defaultRouteState } from '../../src/db/index.js';
import { buildRouteSummary } from '../../src/domain/views.js';
import {
  ATTENTION_WARNINGS,
  IN_CONTROL_BLOCKING_WARNINGS,
  LOSS_OF_CONTROL_WARNINGS,
  REUSE_BLOCKING_WARNINGS,
  evaluateControl,
  hasAny,
} from '../../src/domain/route-rules.js';

const NOW = new Date('2026-10-31T00:00:00.000Z');
const T = NOW.toISOString();
const LATER = new Date(NOW.getTime() + 600_000).toISOString();

function route(patch: Partial<RouteStateRecord> = {}): RouteStateRecord {
  return {
    ...defaultRouteState(T),
    activeEnvironmentId: 'env_1',
    activeProxyRevision: 1,
    phase: 'active_verified',
    entryMode: 'ACTIVE',
    routeEpoch: 2,
    selectedNode: 'SFE-N-E0001-US01-v001',
    ...patch,
  };
}

function probe(patch: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    id: 'probe_1',
    environmentId: 'env_1',
    kind: 'safari',
    outcome: 'ok',
    exitIp: '192.0.2.50',
    proxyRevision: 1,
    nodeName: 'SFE-N-E0001-US01-v001',
    routeEpoch: 2,
    configurationGeneration: 1,
    entryMode: 'VERIFY_ONLY',
    testId: 't',
    operationId: 'op_1',
    surgeRequestId: '7',
    surgeRemoteHost: 'verify.example.test',
    surgeRule: 'RULE-SET,sfe-entry-verify.list,SFE-ROUTE',
    surgePolicy: 'SFE-ROUTE',
    surgeStartedAt: T,
    surgeNewConnection: null,
    chainEvidence: null,
    browserHttpStatus: 200,
    browserStartedAt: T,
    browserFinishedAt: T,
    browserError: null,
    message: null,
    observedAt: T,
    expiresAt: LATER,
    ...patch,
  };
}

const W: RouteWarning = 'node_resource_unverified';

describe('node_resource_unverified classification (D10)', () => {
  test('moves an active route to attention, blocks reuse and "in control"; not a loss-of-control warning', () => {
    expect(ATTENTION_WARNINGS).toContain(W);
    expect(REUSE_BLOCKING_WARNINGS).toContain(W);
    expect(IN_CONTROL_BLOCKING_WARNINGS).toContain(W);
    expect(LOSS_OF_CONTROL_WARNINGS).not.toContain(W);
    // 与 managed_segments_changed（受管理段或本应用文件被修改）同一类
    for (const list of [ATTENTION_WARNINGS, REUSE_BLOCKING_WARNINGS, IN_CONTROL_BLOCKING_WARNINGS, LOSS_OF_CONTROL_WARNINGS]) {
      expect(list.includes(W)).toBe(list.includes('managed_segments_changed'));
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test('an otherwise verified route with a current probe is not in control while the warning is set', () => {
    const r = route();
    expect(evaluateControl(r, probe(), NOW)).toEqual({ ok: true, reason: null });
    const e = evaluateControl(route({ warnings: [W] }), probe(), NOW);
    expect(e.ok).toBe(false);
    expect(e.reason).toContain(W);
    // 与提示类警告同时存在时同样不受控
    expect(evaluateControl(route({ warnings: ['takeover_unknown', W] }), probe(), NOW).ok).toBe(false);
    expect(hasAny([W, 'launch_unverified'], REUSE_BLOCKING_WARNINGS)).toEqual([W]);
  });

  test('the summary does not turn the warning into an entry or buyer-exit claim', () => {
    // 摘要的入口与买家出口判断只看各自的警告，不因节点资源未确认而改变。是否提供进入普通模式由服务端判定
    // （engine/safari-route-marker.ts normalModeOffered），经引擎的覆盖见 test/engine/node-resource-warning.test.ts
    const s = buildRouteSummary(route({ phase: 'attention', warnings: [W] }), true, true);
    expect(s.entryUnconfirmed).toBe(false);
    expect(s.buyerExitConnectionsUnconfirmed).toBe(false);
    expect(s.phase).toBe('attention');
    expect(buildRouteSummary(route({ phase: 'attention', warnings: [W, 'entry_unverified'] }), true, true).entryUnconfirmed).toBe(true);
  });
});
