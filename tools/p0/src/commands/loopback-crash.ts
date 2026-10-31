// loopback-crash：资源服务在发布中途被中断时 Surge 的行为（loopback_publish_crash，D10）。只测 Surge：本应用自己的发布互斥、
// 启动顺序与崩溃恢复由自动化测试覆盖（service/test），这里只请操作员确认同一提交的测试已全部通过。每种情况从已提交版本（A、B）
// 开始，候选版本加入 C，只执行单 key 更新：
// 1. 服务提供候选之后、执行更新之前停止服务，然后执行一次更新；
// 2. 更新进行中停止服务（hang 让下载停住，Surge 报告正在更新时停止）；
// 3. 响应中途中断（truncate：声明完整长度、只写出一半就断开）；
// 4. 更新进行中再次更新（记录第二次命令的结果、下载次数与最终版本）。
// “停止服务”是让 resource-server 停止监听；“重启服务”与产品启动相同：不再提供未提交的候选，只提供已提交版本。每种情况之后
// 重启服务，执行一次单 key 更新并读回，必须回到已提交版本。结果不明的更新从不重放。

import { CAPABILITY_CRITERIA } from '@sfe/contract';
import { refused, type ExitCode } from '../errors.js';
import { resourceBody } from '../deps.js';
import { requestsBetween } from '../loopback-state.js';
import { check, writeResult } from '../results.js';
import { TEST_NODES, testNodeLine } from '../test-profile.js';
import { confirmWrites, measureContext, printResult, printSnapshot, takeSnapshot, type Ctx } from './common.js';
import { errorClass, openLoopback, readbackText, type Loopback } from './loopback-ops.js';
import type { UpdateRecord } from './test-ops.js';

export type CrashCase = 'after_candidate' | 'during_update' | 'mid_response' | 'second_update';

const CASE_TEXT: Record<CrashCase, string> = {
  after_candidate: '服务提供候选之后、执行更新之前中断',
  during_update: '更新进行中中断',
  mid_response: '响应中途中断',
  second_update: '更新进行中再次更新',
};

export interface CrashObservation {
  case: CrashCase;
  /** 是否观察到 Surge 报告正在更新（2、4 需要）。 */
  updatingObserved: boolean | null;
  update: { ok: boolean; code: string | null; outcome: string | null; reason: string | null; ms: number } | null;
  secondUpdate: { ok: boolean; code: string | null; outcome: string | null; reason: string | null; ms: number } | null;
  /** 中断之后 Surge 持有的版本（按成员判断）。 */
  version: 'committed' | 'candidate' | 'other' | null;
  members: string[] | null;
  error: string;
  updating: boolean | null;
  requests: number;
  recovered: boolean | null;
  note: string;
}

function brief(u: UpdateRecord): CrashObservation['update'] {
  return { ok: u.ok, code: u.code, outcome: u.result?.outcome ?? null, reason: u.reason, ms: u.ms };
}

function versionOf(members: readonly string[] | null): CrashObservation['version'] {
  if (members === null) return null;
  const rest = [...members.slice(1)].sort().join(',');
  if (rest === [TEST_NODES.a, TEST_NODES.b].sort().join(',')) return 'committed';
  if (rest === [TEST_NODES.a, TEST_NODES.b, TEST_NODES.c].sort().join(',')) return 'candidate';
  return 'other';
}

/** 有界等待 Surge 报告正在更新（更新命令在另一个异步调用中进行）。 */
async function waitUpdating(lb: Loopback, timeoutMs: number): Promise<boolean> {
  const w = await lb.ops.poll(() => lb.snapshot(), (s) => s.updating === true, timeoutMs, 200);
  return w.ok;
}

export async function runLoopbackCrash(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt } = ctx.deps;
  const { dir, session, ops, lb, ports, creds } = await openLoopback(ctx, { requireSetup: true });
  await lb.ensureKey();
  const snap = await takeSnapshot(ctx, session, dir, 'loopback-crash-before');
  printSnapshot(out, snap);
  const ok = await confirmWrites(
    ctx,
    '回环资源发布中途中断测试',
    [
      '发布只含 A、B 的已提交版本（一次单 key 更新并读回）',
      `四种情况：测试资源服务暂存加入 ${TEST_NODES.c} 的候选版本后，分别在更新之前、更新进行中、响应中途停止服务，以及更新进行中再次更新`,
      '每种情况之后重启服务（只提供已提交版本），一次单 key 更新并读回',
    ],
    ['测试资源服务重新提供已提交版本，一次单 key 更新并读回', '本命令不改写测试配置，不添加临时规则，不重载配置'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  const ab = (['a', 'b'] as const).map((k) => testNodeLine(k, ports, creds.password));
  const abc = [...ab, testNodeLine('c', ports, creds.password)];
  await ops.select('REJECT').catch(() => undefined);
  const base = await lb.publishGeneration(ab, { label: 'crash-baseline' });
  if (!base.committed) {
    out.warn(`已提交版本没有经读回确认（${readbackText(base.assessment)}）：先查明原因`);
    return 1;
  }
  const observations: CrashObservation[] = [];

  /** 暂存候选（不提交）。 */
  const stage = async (): Promise<number> => {
    const generation = (lb.served()?.lastGeneration ?? 0) + 1;
    await lb.setServed(() => ({ candidate: { generation, content: resourceBody(generation, abc) } }));
    ops.action('resource_generation_served', { resource: 'loopback', generation, label: 'crash-candidate', uncommitted: true });
    return generation;
  };
  /** 与产品启动相同的“重启服务”：不再提供候选，只提供已提交版本；然后一次单 key 更新并读回。 */
  const restartAndRecover = async (label: string): Promise<boolean> => {
    await lb.setServed(() => ({ scenario: 'ok', candidate: null }));
    const c = await lb.confirmCommitted(label);
    return c.assessment.ok;
  };
  const observe = async (c: CrashCase, t0: number, extra: Partial<CrashObservation>): Promise<CrashObservation> => {
    const after = (await lb.waitNotUpdating()).snapshot ?? (await lb.snapshot());
    const o: CrashObservation = {
      case: c,
      updatingObserved: null,
      update: null,
      secondUpdate: null,
      version: versionOf(after.members),
      members: after.members ? [...after.members] : null,
      error: errorClass(after.error),
      updating: after.updating,
      requests: requestsBetween(dir, t0 - 1000, now().getTime() + 1000, 'server').length,
      recovered: null,
      note: '',
      ...extra,
    };
    o.recovered = await restartAndRecover(`crash-${c}-recover`);
    o.note = [
      `Surge 持有 ${o.version === 'committed' ? '已提交版本' : o.version === 'candidate' ? '候选版本' : o.version === 'other' ? '其他内容' : '读不到'}（成员 ${o.members?.join('、') ?? '读不到'}）`,
      `错误 ${o.error}`,
      `仍在更新 ${o.updating === null ? '未知' : o.updating ? '是' : '否'}`,
      `资源服务收到 ${o.requests} 个请求`,
      ...(o.updatingObserved === false ? ['没有观察到 Surge 报告正在更新'] : []),
      ...(o.secondUpdate ? [`第二次更新：${o.secondUpdate.ok ? `报告 ${o.secondUpdate.outcome ?? '成功'}` : `失败（${o.secondUpdate.code ?? 'ERROR'}${o.secondUpdate.reason ? `，${o.secondUpdate.reason}` : ''}）`}，用时 ${o.secondUpdate.ms} ms`] : []),
      `重启服务后${o.recovered ? '回到已提交版本' : '没有回到已提交版本'}`,
    ].join('；');
    out.line(`${CASE_TEXT[c]}：${o.note}`);
    return o;
  };

  // 1. 候选之后、更新之前中断
  {
    const t0 = now().getTime();
    await stage();
    await lb.setScenario('stop');
    const u = await lb.update('crash-after-candidate');
    observations.push(await observe('after_candidate', t0, { update: brief(u) }));
  }
  // 2. 更新进行中中断
  {
    const t0 = now().getTime();
    await stage();
    await lb.setScenario('hang');
    const pending = lb.update('crash-during-update');
    const seen = await waitUpdating(lb, 15_000);
    await lb.setScenario('stop');
    const u = await pending;
    observations.push(await observe('during_update', t0, { updatingObserved: seen, update: brief(u) }));
  }
  // 3. 响应中途中断
  {
    const t0 = now().getTime();
    await stage();
    await lb.setScenario('truncate');
    const u = await lb.update('crash-mid-response');
    observations.push(await observe('mid_response', t0, { update: brief(u) }));
  }
  // 4. 更新进行中再次更新
  {
    const t0 = now().getTime();
    await stage();
    await lb.setScenario('hang');
    const pending = lb.update('crash-second-update-1');
    const seen = await waitUpdating(lb, 15_000);
    const second = seen ? await lb.update('crash-second-update-2') : null;
    const u = await pending;
    observations.push(await observe('second_update', t0, { updatingObserved: seen, update: brief(u), secondUpdate: second ? brief(second) : null }));
  }

  const automated = await prompt.ask('测试 Mac 上同一提交的 npx vitest run service/test 是否全部通过？（y/n，回车 未知）');
  const byCase = (c: CrashCase) => observations.find((o) => o.case === c)!;
  const recorded = (o: CrashObservation, needUpdating: boolean): boolean | null => (o.members === null ? null : needUpdating && o.updatingObserved !== true ? null : true);
  const checks = [
    check('服务提供候选之后、执行更新之前中断：Surge 保留的版本、资源错误与更新状态已记录', recorded(byCase('after_candidate'), false), byCase('after_candidate').note),
    check('更新进行中中断：Surge 保留的版本、资源错误与更新状态已记录', recorded(byCase('during_update'), true), byCase('during_update').note),
    check('响应中途中断：Surge 保留的版本、资源错误与更新状态已记录', recorded(byCase('mid_response'), false), byCase('mid_response').note),
    check('更新进行中再次更新：Surge 的行为已记录', recorded(byCase('second_update'), true), byCase('second_update').note),
    check('服务重启后经一次单 key 更新与读回回到已提交版本', observations.every((o) => o.recovered === true) ? true : observations.some((o) => o.recovered === false) ? false : null, `${observations.filter((o) => o.recovered).length}/${observations.length} 次`),
    check('本应用的发布互斥、启动顺序与崩溃恢复由自动化测试覆盖（同一提交的 service/test 全部通过）', automated === 'y' ? true : automated === 'n' ? false : null, automated === 'y' ? '操作员确认' : '没有确认'),
  ];
  dir.writeJson(`loopback-crash/${now().getTime()}.json`, { observations, automated });
  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'loopback_publish_crash',
    command: 'loopback-crash',
    at: now().toISOString(),
    checks,
    summary: [`通过条件：${CAPABILITY_CRITERIA.loopback_publish_crash}`, ...observations.map((o) => `${CASE_TEXT[o.case]}：${o.note}`)],
    context,
  });
  printResult(out, result);
  return 0;
}
