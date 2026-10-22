// 结束属于 Safari 的连接：只按已确认的完整进程路径过滤，逐条记录结果，不清空其他应用的连接。
// 记录中只保留“是否为检测主机”，不持久化其他远端主机。见 docs/ARCHITECTURE.md §6.3 第 7 步、§6.5。

import { SFE_PREFIX, SfeError, type KillResult } from '@sfe/contract';
import type { SurgeAdapter, SurgeRequestRecord } from '../ports.js';

export interface KillOptions {
  processPaths: readonly string[];
  verifyHost: string;
  now: () => Date;
  /** 普通模式下门槛不满足时尽力而为：单条失败不抛错，只记录。 */
  bestEffort: boolean;
  /**
   * 结束连接时本应用入口是否已确认阻断 Safari（缺省 true）：重新列出时出现的新 Safari 连接都记为失败（入口应已阻断）。
   * false（普通模式中入口不确定阻断 Safari：入口已是普通模式、上一次保留的 block 关闭尚未加载、有规则排在入口之前）时，
   * Safari 按原规则立即重连是预期的：只有可能经买家出口的新连接记为失败——策略或叶节点是本应用的对象（`SFE-` 前缀：
   * SFE-ROUTE、出口节点），或两者都读不到（无法判断，按失败处理）。
   */
  entryBlocksSafari?: boolean;
  /**
   * 普通模式：Safari 可能经 SFE-ROUTE 期间配置过、之后被确认的进程归属提议换掉的进程路径（不在 processPaths 中）。按新的
   * 确认它们不再是配置的 Safari 进程：只结束其中可能经买家出口的连接（与重新列出时的新连接同一判断），其余不碰。
   */
  retiredProcessPaths?: readonly string[];
}

/** 新连接可能经买家出口：策略或叶节点是本应用的对象（SFE-ROUTE、出口节点），或两者都读不到。 */
function mayUseBuyerExit(r: SurgeRequestRecord): boolean {
  if (r.policyName === null && r.leafPolicyName === null) return true;
  return [r.policyName, r.leafPolicyName].some((n) => n !== null && n.startsWith(SFE_PREFIX));
}

function errorText(e: unknown): string {
  if (e instanceof SfeError) return `${e.code}: ${e.message}`;
  return '结束连接失败';
}

export async function killSafariConnections(adapter: SurgeAdapter, opts: KillOptions): Promise<KillResult[]> {
  const paths = new Set(opts.processPaths);
  const retired = new Set((opts.retiredProcessPaths ?? []).filter((p) => !paths.has(p)));
  const isSafari = (r: SurgeRequestRecord): boolean =>
    !r.completed && r.processPath !== null && (paths.has(r.processPath) || (retired.has(r.processPath) && mayUseBuyerExit(r)));
  const toVerify = (r: SurgeRequestRecord): boolean => (r.remoteHost ?? '').toLowerCase() === opts.verifyHost.toLowerCase();
  const targets = (await adapter.listActiveRequests()).filter(isSafari);
  const results: KillResult[] = [];
  for (const r of targets) {
    try {
      await adapter.killRequest(r.id);
      results.push({ surgeRequestId: r.id, processPath: r.processPath, toVerifyHost: toVerify(r), ok: true, error: null, at: opts.now().toISOString() });
    } catch (e) {
      results.push({ surgeRequestId: r.id, processPath: r.processPath, toVerifyHost: toVerify(r), ok: false, error: errorText(e), at: opts.now().toISOString() });
    }
  }
  // 重新列出确认：已结束的不应再出现；新出现的 Safari 连接也记下来（入口应已阻断）。入口不确定阻断 Safari 时
  // （entryBlocksSafari: false），按原规则发出的新连接是预期的，只记下可能经买家出口的新连接。
  const blocks = opts.entryBlocksSafari !== false;
  const remaining = (await adapter.listActiveRequests()).filter(isSafari);
  for (const r of remaining) {
    const prior = results.find((x) => x.surgeRequestId === r.id);
    if (prior) {
      if (prior.ok) {
        prior.ok = false;
        prior.error = '结束后仍然存在';
      }
    } else if (blocks || mayUseBuyerExit(r)) {
      results.push({
        surgeRequestId: r.id,
        processPath: r.processPath,
        toVerifyHost: toVerify(r),
        ok: false,
        error: blocks ? '结束后出现的新连接' : '结束后出现的新连接（可能经买家出口）',
        at: opts.now().toISOString(),
      });
    }
  }
  const failed = results.filter((x) => !x.ok).length;
  if (failed > 0 && !opts.bestEffort) {
    throw new SfeError('READBACK_MISMATCH', `结束 Safari 连接失败：${failed} 条连接未能确认结束`, { details: { killResults: results } });
  }
  return results;
}
