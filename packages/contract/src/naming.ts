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
 * 入口规则集文件中见证规则与占位规则只由合成进程路径构成（PROCESS-NAME 完整路径模式，不带任何主机或 IP 条件）：
 * 文档“If the expression starts with `/` (and does not end with `/`), it matches the executable's full absolute path.”、
 * “Matching is case-sensitive in all modes.”（https://manual.nssurge.com/rules/process.html）。选 /var/empty 是因为应用的
 * 可执行文件不会放在这里（Safari 进程路径落在其下时校验拒绝）。TODO(P0)：/var/empty 在测试 Mac 上属于 root、为空（root 仍可在
 * 其下创建文件，不是保证）；`rule match` 是否接受不存在的 process-path、是否把 /var 规范化为 /private/var——文档没有写明，由
 * P0 见证形式核对实测，不成立时服务等不到见证、失败即关闭。在这些前提下只有 `rule match <ENTRY_PROBE_IPV4> process-path=<它>`
 * 的见证探测会命中；Safari、Chrome 与其他应用的真实请求都不会。
 * 不用主机区分：规则集文件继承 RULE-SET 行的策略（verify/active 为 SFE-ROUTE），DOMAIN 规则对任何进程按主机名匹配；
 * 探测合成域名又会在求值走到用户的 IP 规则时触发 DNS 查询而失败（2026-10-24 测试 Mac：`.invalid` 主机的 rule match 退出 1，
 * DNS 空回答），见 docs/ARCHITECTURE.md §5.5。
 */
/** 见证规则的合成进程路径前缀：完整路径为 `<前缀><位>-<标记>`（单层、不以 “/” 结尾），见 service generate.ts entryWitnessProcessPath。 */
export const ENTRY_WITNESS_PROCESS_PREFIX = '/var/empty/sfe-entry-witness-';
/** 旧格式见证与占位规则限定的合成进程（与 `.invalid` 主机组合）：只用于识别已有文件，从不写入。 */
export const LEGACY_ENTRY_WITNESS_PROCESS_PATH = '/var/empty/sfe-entry-witness';
/** 占位规则的合成进程路径：与任何见证路径都不同。 */
export const ENTRY_PLACEHOLDER_PROCESS_PATH = '/var/empty/sfe-entry-disabled';
/** 占位规则：关闭的位写入它，而不是写空文件；只匹配合成进程，任何真实请求都不会命中。 */
export const ENTRY_PLACEHOLDER_RULE = `PROCESS-NAME,${ENTRY_PLACEHOLDER_PROCESS_PATH}`;
/** 上一版占位规则（合成进程 + `.invalid` 主机）：只用于识别已有文件，从不写入。 */
export const PREVIOUS_ENTRY_PLACEHOLDER_RULE = `AND,((PROCESS-NAME,${LEGACY_ENTRY_WITNESS_PROCESS_PATH}),(DOMAIN,sfe-disabled.invalid))`;
/** 最早的占位规则（不限定进程，任何进程请求这一主机都会命中）：只用于识别已有文件，从不写入。 */
export const LEGACY_ENTRY_PLACEHOLDER_RULE = 'DOMAIN,sfe-disabled.invalid';
/**
 * 本应用 rule match 探测中的合成目标主机：RFC 5737 文档地址（TEST-NET-1）。IP 字面量不需要 DNS——IP 规则文档：“If the request
 * targets an IP literal, the rule matches it directly; GEOIP and IP-ASN perform their database lookup without a DNS query.”
 * （https://manual.nssurge.com/rules/ip.html）。用于见证探测与没有站点主机时的“其他主机”。
 */
export const ENTRY_PROBE_IPV4 = '192.0.2.1';
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
