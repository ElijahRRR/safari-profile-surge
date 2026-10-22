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
