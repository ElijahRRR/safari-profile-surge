// 代理预检记录（docs/ARCHITECTURE.md §6.2 第 7 步、§6.3 第 3 步）。预检只证明经前置到 SOCKS5 的连通性：
// testPolicy 不返回出口 IP，因此 exitIp 恒为 null；预期出口只在 Safari 实测时比较。独立预检能力未通过时
// 记为 inconclusive，从不借当前选择组测试非活动环境。

import type { ProbeRecord, ProxyRevisionRecord } from '../../db/index.js';
import type { Engine } from '../context.js';

export const CHAIN_EVIDENCE_PREFLIGHT =
  '预检只证明候选节点经前置可以连通；6.5 无法读出完整链路，前置链路依赖 external_node_underlying_proxy 实测，不以出口 IP 作为链路证明';
export const CHAIN_EVIDENCE_UNTESTED = '独立预检能力尚未通过实测：不借当前选择组测试，待激活时由 Safari 实测';

export interface PreflightInput {
  environmentId: string;
  revision: ProxyRevisionRecord;
  operationId: string | null;
  /** independent_node_preflight 有效状态为 supported。 */
  allowed: boolean;
  generation: number;
  /** 经 SFE-ROUTE 测试（激活中推迟的预检，此时 Safari 已阻断）。 */
  viaRoute?: { group: string; routeEpoch: number };
}

export async function recordPreflight(engine: Engine, input: PreflightInput): Promise<ProbeRecord> {
  const now = engine.now();
  const ttl = engine.repos.settings.get('probeTtlSec') * 1000;
  const base = {
    id: engine.ids.next('probe'),
    environmentId: input.environmentId,
    kind: 'preflight' as const,
    exitIp: null,
    proxyRevision: input.revision.revision,
    nodeName: input.revision.nodeName,
    routeEpoch: input.viaRoute?.routeEpoch ?? null,
    configurationGeneration: input.generation,
    operationId: input.operationId,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  if (!input.allowed && !input.viaRoute) {
    return engine.repos.probes.insert({ ...base, outcome: 'inconclusive', chainEvidence: CHAIN_EVIDENCE_UNTESTED, message: '已部署，待激活时由 Safari 实测' });
  }
  const policy = input.viaRoute ? input.viaRoute.group : input.revision.nodeName;
  let outcome: 'ok' | 'failed' = 'failed';
  let message: string;
  try {
    const r = await engine.surge.testPolicy(policy, engine.verifyEndpoint().url);
    outcome = r.ok ? 'ok' : 'failed';
    message = r.ok ? `预检通过${r.latencyMs !== null ? `（${r.latencyMs} ms）` : ''}` : `预检失败：${engine.scrubber.scrub(r.error ?? '代理不可用')}`;
  } catch (err) {
    message = engine.errorBody(err, '预检失败：调用 Surge 失败').message;
  }
  return engine.repos.probes.insert({ ...base, outcome, chainEvidence: CHAIN_EVIDENCE_PREFLIGHT, message });
}

/** 未过期、属于该版本的 ok 预检。 */
export function currentPreflight(engine: Engine, environmentId: string, revision: number): ProbeRecord | null {
  const p = engine.repos.probes.latest(environmentId, 'preflight');
  if (!p || p.proxyRevision !== revision || p.outcome !== 'ok') return null;
  return Date.parse(p.expiresAt) > engine.now().getTime() ? p : null;
}

/** 让某环境最近的 Safari 实测立即过期（显示为“上次结果”）。 */
export function expireSafariProbe(engine: Engine, environmentId: string): boolean {
  const p = engine.repos.probes.latest(environmentId, 'safari');
  if (!p) return false;
  const now = engine.nowIso();
  if (p.expiresAt <= now) return false;
  engine.repos.probes.update(p.id, { expiresAt: now });
  return true;
}
