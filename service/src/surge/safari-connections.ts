// 结束属于 Safari 的连接：只按已确认的完整进程路径过滤，逐条记录结果，不清空其他应用的连接。
// 记录中只保留“是否为检测主机”，不持久化其他远端主机。见 docs/ARCHITECTURE.md §6.3 第 7 步、§6.5。

import { SfeError, type KillResult } from '@sfe/contract';
import type { SurgeAdapter, SurgeRequestRecord } from '../ports.js';

export interface KillOptions {
  processPaths: readonly string[];
  verifyHost: string;
  now: () => Date;
  /** 普通模式下门槛不满足时尽力而为：单条失败不抛错，只记录。 */
  bestEffort: boolean;
}

function errorText(e: unknown): string {
  if (e instanceof SfeError) return `${e.code}: ${e.message}`;
  return '结束连接失败';
}

export async function killSafariConnections(adapter: SurgeAdapter, opts: KillOptions): Promise<KillResult[]> {
  const paths = new Set(opts.processPaths);
  const isSafari = (r: SurgeRequestRecord): boolean => !r.completed && r.processPath !== null && paths.has(r.processPath);
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
  // 重新列出确认：已结束的不应再出现；新出现的 Safari 连接也记下来（入口应已阻断）。
  const remaining = (await adapter.listActiveRequests()).filter(isSafari);
  for (const r of remaining) {
    const prior = results.find((x) => x.surgeRequestId === r.id);
    if (prior) {
      if (prior.ok) {
        prior.ok = false;
        prior.error = '结束后仍然存在';
      }
    } else {
      results.push({
        surgeRequestId: r.id,
        processPath: r.processPath,
        toVerifyHost: toVerify(r),
        ok: false,
        error: '结束后出现的新连接',
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
