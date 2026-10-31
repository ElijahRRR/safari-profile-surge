// 回环发布（D10）测试用的小工具：只用合成数据。读 Surge 与本机资源服务的状态、让 FakeSurge 在一次下载中跳过某个节点行、
// 在某次原语调用处挂起（模拟进程在这里退出）。

import type { SurgeAdapter } from '../../src/ports.js';
import { readNeedsRefresh, readServedPointer, readTokenSuspect, type ResourceServedPointer } from '../../src/resource/index.js';
import type { Harness } from './harness.js';

/** 单 key 更新的调用次数（累计；断言请用差值）。 */
export const updates = (h: Harness): number => h.fake.calls.updateExternalResource ?? 0;

/** 本机资源服务当前提供的版本。 */
export const served = (h: Harness) => h.app.engine.resource!.served();

/** Surge 缓存的本应用节点资源（被接受的行，以换行连接；未就绪为 null）。 */
export const loaded = (h: Harness): string | null => h.fake.loadedContent(h.resourceKey()!);

export const pointer = (h: Harness): ResourceServedPointer | null => readServedPointer(h.app.engine.kv);

export const needsRefresh = (h: Harness) => readNeedsRefresh(h.app.engine.kv);

export const tokenSuspect = (h: Harness) => readTokenSuspect(h.app.engine.kv);

/** SFE-ROUTE 的成员（不含首位 REJECT）。 */
export async function nodes(h: Harness): Promise<string[]> {
  return (await h.fake.getGroupMembers('SFE-ROUTE')).slice(1);
}

/**
 * 下一次单 key 更新的下载中，Surge 不接受这些节点的行（如同 Surge 认为它们无效而跳过；之后的下载照常）。被跳过的节点从成员中
 * 消失，选着它时选择回落到首成员 REJECT（2026-10-25 矩阵：validAbBadC）。
 */
export function dropNodesOnNextUpdate(h: Harness, nodeNames: readonly string[]): void {
  const fake = h.fake;
  const orig = fake.updateExternalResource.bind(fake);
  const accept = fake.acceptNodeLine;
  fake.updateExternalResource = async (key: string) => {
    fake.updateExternalResource = orig;
    fake.acceptNodeLine = (line) => !nodeNames.some((n) => line.startsWith(`${n} =`)) && accept(line);
    try {
      return await orig(key);
    } finally {
      fake.acceptNodeLine = accept;
    }
  };
}

/**
 * 原语 primitive 的第 nth 次调用（从现在起计）挂起：之前的调用照常，挂起的调用从不返回（模拟服务在这里退出；之后用 h.crash()）。
 * before 为 true 时挂在调用之前（Surge 没有执行它），否则在 Surge 执行之后、返回之前。
 */
export function hangAt(h: Harness, primitive: keyof SurgeAdapter & string, nth = 1, opts: { before?: boolean } = {}): { reached: () => boolean; restore: () => void } {
  const fake = h.fake as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const orig = fake[primitive]!.bind(h.fake);
  let count = 0;
  let reached = false;
  fake[primitive] = async (...args: unknown[]) => {
    count++;
    if (count !== nth) return orig(...args);
    reached = true;
    if (opts.before !== true) await orig(...args).catch(() => undefined);
    return new Promise(() => undefined);
  };
  return {
    reached: () => reached,
    restore: () => {
      fake[primitive] = orig;
    },
  };
}

/** 等到条件成立（只让出事件循环，不推进 FakeClock）。 */
export async function until(cond: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('until: condition not reached');
}
