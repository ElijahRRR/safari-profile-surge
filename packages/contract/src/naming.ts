// 统一命名（固定工作配置设计 §2）。名称只含字母、数字、连字符，不含账号、密码或代理 IP。
// 归属以数据库清单为准；这里只负责格式。

import type { SiteCode } from './sites.js';

export const SFE_PREFIX = 'SFE-';
export const ROUTE_GROUP_NAME = 'SFE-ROUTE';
/** 只存本应用的环境出口节点。 */
export const NODE_RESOURCE_FILE = 'sfe-nodes.list';
/** ruleset_resource 入口策略使用的四个规则集文件，顺序即主配置中的顺序（udp > verify > block > active）。 */
export const ENTRY_RULESET_FILES = {
  udp: 'sfe-entry-udp.list',
  verify: 'sfe-entry-verify.list',
  block: 'sfe-entry-block.list',
  active: 'sfe-entry-active.list',
} as const;
/**
 * 入口规则集文件中见证规则与占位规则限定的合成进程路径：不存在、也无法创建的可执行文件（/var/empty 只属于 root 且为空），
 * 只有 `rule match … process-path=<它>` 的见证探测会命中；Safari、Chrome 与其他应用的真实请求都不会。
 * 不限定进程不行：规则文档写明“Domain rules match the hostname of a request … never trigger a DNS lookup”
 * （https://manual.nssurge.com/rules/domain.html），`.invalid` 不解析也照样按主机名匹配，规则集文件又继承 RULE-SET 行的
 * 策略（verify/active 为 SFE-ROUTE），任何进程请求这一主机都会经买家出口发出。
 */
export const ENTRY_WITNESS_PROCESS_PATH = '/var/empty/sfe-entry-witness';
/** 占位规则：关闭的位写入它，而不是写空文件；限定合成进程，任何真实请求都不会命中（见 ENTRY_WITNESS_PROCESS_PATH）。 */
export const ENTRY_PLACEHOLDER_RULE = `AND,((PROCESS-NAME,${ENTRY_WITNESS_PROCESS_PATH}),(DOMAIN,sfe-disabled.invalid))`;
/** 旧格式的占位规则（不限定进程，任何进程请求这一主机都会命中）：只用于识别已有文件，从不写入。 */
export const LEGACY_ENTRY_PLACEHOLDER_RULE = 'DOMAIN,sfe-disabled.invalid';
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

/** 专用前置节点命名（保留：首版不开放创建，前置只允许用户已有的固定节点）。 */
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
