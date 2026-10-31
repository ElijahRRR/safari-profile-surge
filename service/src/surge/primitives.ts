// Surge 原语清单与公共小工具。原语只来自 SurgeAdapter（ports.ts）；这里不出现任何
// switch-profile、reload、restart-engine、update all、flush、停止 Surge 或接管/出站写入。
// 最低支持 Surge Mac 6.10.0（构建 12500、Controller 协议 22），见 running-instance.ts 的 SURGE_MINIMUM。

import { SfeError } from '@sfe/contract';
import type { SurgeAdapter } from '../ports.js';

export type Mechanism = 'cli' | 'http' | 'fake' | 'unavailable';
export type MechanismMap = Record<string, Mechanism>;

export const SURGE_PRIMITIVES = [
  'getVersion',
  'getRuntimeInfo',
  'getCurrentProfile',
  'getTakeoverState',
  'getAutoReloadSetting',
  'checkProfile',
  'listPolicies',
  'getPolicyDetail',
  'getGroupMembers',
  'getGroupSelection',
  'selectGroupPolicy',
  'testPolicy',
  'listRules',
  'matchRule',
  'listActiveRequests',
  'listRecentRequests',
  'killRequest',
  'listExternalResources',
  'updateExternalResource',
  'listTempRules',
  'addTempRule',
  'removeTempRule',
] as const;
export type SurgePrimitive = (typeof SURGE_PRIMITIVES)[number];

// 编译期保证：清单与 SurgeAdapter 的方法一一对应（除 mechanism）。
type AdapterPrimitive = Exclude<keyof SurgeAdapter, 'mechanism'>;
type MissingFromList = Exclude<AdapterPrimitive, SurgePrimitive>;
type ExtraInList = Exclude<SurgePrimitive, AdapterPrimitive>;
const primitivesComplete: [MissingFromList, ExtraInList] extends [never, never] ? true : never = true;
void primitivesComplete;

/** 适配器的单个原语超时（毫秒）：覆盖该适配器的缺省超时（CLI 15 秒、HTTP 10 秒）。 */
export type PrimitiveTimeouts = Partial<Record<SurgePrimitive, number>>;

/**
 * 更新本机节点资源的超时（D10，main.ts 对 CLI 与 HTTP 都用它）。回环矩阵（docs/verification/
 * 2026-10-25-loopback-main-witness-matrix.md）：服务器不响应时一次更新约 12.9 秒才返回（NSURLErrorDomain -1001），连接被重置时
 * Surge 重试到 6 次；缺省的 15 秒会让仍在下载的更新被判为超时。TODO(P0)：按回环补测记录的耗时调整。
 */
export const SURGE_RESOURCE_UPDATE_TIMEOUT_MS = 30_000;

/** 校验单个原语超时：只接受正的安全整数，否则构造适配器失败（不静默改用缺省值）。 */
export function validatePrimitiveTimeouts(timeouts: PrimitiveTimeouts | undefined): PrimitiveTimeouts {
  const out: PrimitiveTimeouts = {};
  for (const [p, ms] of Object.entries(timeouts ?? {})) {
    if (!(SURGE_PRIMITIVES as readonly string[]).includes(p) || typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) {
      throw new SfeError('VALIDATION_FAILED', '创建 Surge 适配器失败：原语超时设置不正确', { details: { primitive: p } });
    }
    out[p as SurgePrimitive] = ms;
  }
  return out;
}

/**
 * updateExternalResource 超时：请求已经发给 Surge，它可能仍在下载、已经载入或没有收到——结果未知（不是“无法连接”）。
 * 调用方不能据此判断资源是否变化，必须等更新结束后读回；从不重放这次更新。
 */
export function resourceUpdateTimeoutError(): SfeError {
  return new SfeError('SURGE_COMMAND_FAILED', '更新外部资源失败：等待 Surge 返回结果超时，资源是否已更新未知', {
    details: { primitive: 'updateExternalResource', reason: 'update_timeout' },
  });
}

export function capabilityUnverified(primitive: string): SfeError {
  return new SfeError('CAPABILITY_UNVERIFIED', `调用 Surge 失败：原语 ${primitive} 在当前实现中尚未通过实测`, {
    details: { primitive },
  });
}

export function truncate(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 本地遮盖：把已知秘密值替换为 ***，再交给注入的脱敏器。 */
export function maskKnown(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length > 0) out = out.split(s).join('***');
  }
  return out;
}
