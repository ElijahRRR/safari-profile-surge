// 命名分配（固定工作配置设计 §2）：稳定环境编号与站内标签只在创建时分配一次，计数器单调、从不复用；
// 出口节点名由编号、标签与代理版本组成，不含账号、密码或代理 IP。

import { environmentCode, environmentLabel, exitNodeName, nodeTag, type SiteCode } from '@sfe/contract';
import type { MetaRepo } from '../db/index.js';

export interface EnvironmentNaming {
  seq: number;
  code: string;
  nodeTag: string;
}

/** 在调用方事务内分配：环境编号（E0001）与站内标签（US01）。 */
export function allocateEnvironmentNaming(meta: Pick<MetaRepo, 'nextEnvironmentSeq' | 'nextSiteSeq'>, site: SiteCode): EnvironmentNaming {
  const seq = meta.nextEnvironmentSeq();
  const siteSeq = meta.nextSiteSeq(site);
  return { seq, code: environmentCode(seq), nodeTag: nodeTag(site, siteSeq) };
}

/** 某个代理版本对应的 Surge 节点名。 */
export function revisionNodeName(env: { code: string; nodeTag: string }, proxyRevision: number): string {
  return exitNodeName(env.code, env.nodeTag, proxyRevision);
}

/** 界面与提示中的环境名称：「展示名 · E0001」。 */
export function labelOf(env: { displayName: string; code: string }): string {
  return environmentLabel(env.displayName, env.code);
}
