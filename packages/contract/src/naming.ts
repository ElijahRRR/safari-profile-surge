// 统一命名（固定工作配置设计 §2）。名称只含字母、数字、连字符，不含账号、密码或代理 IP。
// 归属以数据库清单为准；这里只负责格式。

import type { SiteCode } from './sites.js';

export const SFE_PREFIX = 'SFE-';
export const ROUTE_GROUP_NAME = 'SFE-ROUTE';
/** 只存本应用的环境出口节点。 */
export const NODE_RESOURCE_FILE = 'sfe-nodes.list';
/** ruleset_resource 入口策略使用的三个规则集文件，顺序即主配置中的顺序。 */
export const ENTRY_RULESET_FILES = {
  verify: 'sfe-entry-verify.list',
  block: 'sfe-entry-block.list',
  active: 'sfe-entry-active.list',
} as const;
export const MANAGED_BEGIN = '# SFE-BEGIN';
export const MANAGED_END = '# SFE-END';
export const WORKING_PROFILE_NAME = '日常-Safari环境';

const NAME_RE = /^SFE-[A-Za-z0-9-]+$/;

function pad(n: number, width: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`invalid sequence ${n}`);
  return String(n).padStart(width, '0');
}

/** 稳定环境编号：E0001。超过 9999 时自然变长（E10000），不回绕。 */
export function environmentCode(sequence: number): string {
  if (sequence < 1) throw new RangeError('environment sequence starts at 1');
  return `E${pad(sequence, 4)}`;
}

/** 创建时标签：站点 + 站内序号，例如 US01。只在创建时生成，之后不随改名变化。 */
export function nodeTag(site: SiteCode, sequenceInSite: number): string {
  if (sequenceInSite < 1) throw new RangeError('site sequence starts at 1');
  return `${site}${pad(sequenceInSite, 2)}`;
}

/** 环境出口节点：SFE-N-E0001-US01-v003。代理参数变化才产生新版本。 */
export function exitNodeName(envCode: string, tag: string, proxyRevision: number): string {
  if (proxyRevision < 1) throw new RangeError('proxy revision starts at 1');
  const name = `SFE-N-${envCode}-${tag}-v${pad(proxyRevision, 3)}`;
  assertSfeName(name);
  return name;
}

/** 专用前置节点（确实需要新建时）：SFE-F-F0001。 */
export function frontNodeName(sequence: number): string {
  if (sequence < 1) throw new RangeError('front sequence starts at 1');
  return `SFE-F-F${pad(sequence, 4)}`;
}

export function isSfeName(name: string): boolean {
  return NAME_RE.test(name);
}

export function assertSfeName(name: string): void {
  if (!isSfeName(name)) throw new Error(`invalid SFE name: ${name}`);
}

export interface ParsedExitNodeName {
  envCode: string;
  tag: string;
  proxyRevision: number;
}

export function parseExitNodeName(name: string): ParsedExitNodeName | null {
  const m = /^SFE-N-(E\d{4,})-([A-Z]{2}\d{2,})-v(\d{3,})$/.exec(name);
  if (!m) return null;
  return { envCode: m[1]!, tag: m[2]!, proxyRevision: Number(m[3]) };
}

/** 界面展示：“US-买家01 · E0001”。 */
export function environmentLabel(displayName: string, envCode: string): string {
  return `${displayName} · ${envCode}`;
}
