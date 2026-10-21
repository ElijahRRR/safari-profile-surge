// continuity：工具作为“其他应用”经 Surge HTTP 代理端口保持长连接流、WebSocket 与周期短请求，记录时间线；
// 操作员在另一个终端执行 refresh/entry 或在 Surge 中手动重载同一配置，在本终端输入事件名标记。
// 第一个事件之前的时段是对照。也合并其他命令写入的动作时间线（资源刷新、选择、入口切换）。

import { createInterface, type Interface } from 'node:readline';
import { CAPABILITY_CRITERIA } from '@sfe/contract';
import { analyzeContinuity, formatPeriod, type MarkedEvent } from '../analysis/continuity.js';
import { ACTIONS_LOG } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { check, logAction, verdictLabel, writeResult, type ActionEntry } from '../results.js';
import { startOtherAppTraffic } from '../traffic.js';
import { fmtBool, measureContext, openRun, openSession, printResult, proxyOf, requireServers, tryRead, type Ctx } from './common.js';

const BASELINE_MIN_MS = 30_000;

export async function runContinuity(ctx: Ctx, stopSignal: () => Promise<void>): Promise<ExitCode> {
  const { out, now } = ctx.deps;
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const proxy = proxyOf(ctx);
  const duration = (ctx.args.numbers.duration ?? 300) * 1000;
  const intervalMs = (ctx.args.numbers.interval ?? 1) * 1000;
  let publicHost: string | null = null;
  if (ctx.args.strings['public-url']) {
    try {
      const u = new URL(ctx.args.strings['public-url']);
      if (u.protocol !== 'https:') throw new Error('https');
      publicHost = u.hostname;
    } catch {
      throw refused('参数检查失败：--public-url 必须是 https 地址（只测试经代理建立新连接）');
    }
  }
  const takeoverBefore = await tryRead(() => session.adapter.getTakeoverState());
  const profileBefore = (await tryRead(() => session.adapter.getCurrentProfile()))?.name ?? session.currentProfileName;

  out.heading('连接连续性（其他应用）');
  out.line(`通过条件：${CAPABILITY_CRITERIA.connection_continuity}`);
  out.line(`经 Surge 代理 ${proxy.host}:${proxy.port} 访问测试回显主机（经 P0-Plain），间隔 ${intervalMs} ms，最长 ${duration / 1000} 秒。`);
  out.line('先保持至少 30 秒不做任何变更（对照）；之后在另一个终端运行 refresh 或 entry，或在 Surge 菜单中手动「重新加载配置」。');
  out.line('在本终端输入事件名后回车标记（例如 refresh、select、reload），输入 q 结束。');

  const start = now().getTime();
  const traffic = startOtherAppTraffic({ proxy, echoPort: servers.echoPort, intervalMs, label: 'continuity', publicHost });
  const marks: MarkedEvent[] = [];
  const interactive = !ctx.args.booleans['no-prompt'] && !ctx.args.booleans['non-interactive'] && process.stdin.isTTY;
  let rl: Interface | null = null;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl?.close();
      resolve();
    };
    const timer = setTimeout(finish, duration);
    void stopSignal().then(finish);
    if (interactive) {
      rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const label = line.trim();
        if (label === 'q') {
          finish();
          return;
        }
        if (/^[A-Za-z0-9_-]{1,32}$/.test(label)) {
          marks.push({ t: now().getTime(), label, source: 'operator' });
          logAction(dir, { at: now().toISOString(), command: 'continuity', action: 'operator_mark', detail: { label } });
          out.line(`已标记：${label}`);
        }
      });
    }
  });
  await traffic.stop();
  const end = now().getTime();

  const actions = dir
    .readJsonl<ActionEntry>(ACTIONS_LOG)
    .filter((a) => a.command !== 'continuity' && ['resource_refresh', 'select', 'entry_step', 'test_file_written'].includes(a.action))
    .map((a): MarkedEvent => ({ t: Date.parse(a.at), label: `${a.command}:${a.action}`, source: 'action' }))
    .filter((e) => e.t >= start && e.t <= end);
  const events = [...marks, ...actions].sort((a, b) => a.t - b.t);
  const analysis = analyzeContinuity(traffic.samples, events, { start, end });
  dir.writeJson(`continuity/${start}.json`, { start, end, marks, actions, samples: traffic.samples, analysis });

  const takeoverAfter = await tryRead(() => session.adapter.getTakeoverState());
  const profileAfter = (await tryRead(() => session.adapter.getCurrentProfile()))?.name ?? null;
  const baseline = analysis.periods[0]!;
  const changes = analysis.impacts.filter((i) => !i.label.startsWith('reload'));
  const refreshSeen = events.some((e) => e.label.includes('resource_refresh'));
  const vias = new Set(analysis.periods.flatMap((p) => p.vias));
  const context = await measureContext(ctx, session, state);
  const continuity = writeResult(dir, {
    key: 'connection_continuity',
    command: 'continuity',
    at: now().toISOString(),
    checks: [
      check('有至少 30 秒的对照时段', baseline.to - baseline.from >= BASELINE_MIN_MS && baseline.shortTotal > 0, `${Math.round((baseline.to - baseline.from) / 1000)} 秒`),
      check('期间执行过节点资源发布（refresh）', refreshSeen ? true : null, refreshSeen ? '' : '没有观察到资源刷新动作'),
      check('长连接与 WebSocket 没有重置', changes.length === 0 ? null : changes.every((i) => i.streamResets === 0 && i.wsResets === 0)),
      check('新请求正常', changes.length === 0 ? null : changes.every((i) => i.failedShorts === 0)),
      check('出口不变（始终经过 p0-plain）', vias.size === 0 ? null : vias.size === 1 && vias.has('p0-plain'), [...vias].join('、')),
    ],
    summary: [`通过条件：${CAPABILITY_CRITERIA.connection_continuity}`, ...analysis.periods.map(formatPeriod)],
    context,
  });
  const reloadImpacts = analysis.impacts.filter((i) => i.label.startsWith('reload'));
  let reloadVerdict: string | null = null;
  if (reloadImpacts.length > 0) {
    const impacted = reloadImpacts.some((i) => i.failedShorts > 0 || i.streamResets > 0 || i.wsResets > 0);
    const r = writeResult(dir, {
      key: 'same_profile_reload_impact',
      command: 'continuity',
      at: now().toISOString(),
      checks: [
        check('同一配置重载期间已测量', true),
        check('接管与出站模式不变', takeoverBefore === null || takeoverAfter === null ? null : JSON.stringify({ ...takeoverBefore, checkedAt: null }) === JSON.stringify({ ...takeoverAfter, checkedAt: null }), `之后：增强模式 ${fmtBool(takeoverAfter?.enhancedMode)}，系统代理 ${fmtBool(takeoverAfter?.systemProxy)}，出站 ${takeoverAfter?.outboundMode ?? '读不到'}`),
        check('配置身份不变', profileBefore === null || profileAfter === null ? null : profileBefore === profileAfter),
        check('其他应用不受影响', !impacted, reloadImpacts.map((i) => `重置 ${i.streamResets + i.wsResets}，失败 ${i.failedShorts}，恢复 ${i.recoveryMs ?? '未恢复'} ms`).join('；')),
      ],
      summary: [
        `通过条件：${CAPABILITY_CRITERIA.same_profile_reload_impact}`,
        ...reloadImpacts.map((i) => `${i.label}：长连接/WebSocket 重置 ${i.streamResets + i.wsResets}，短请求失败 ${i.failedShorts}，恢复时间 ${i.recoveryMs ?? '未恢复'} ms`),
        '有影响时按“不支持（已测量影响）”提议，维护重载由用户选择时间执行',
      ],
      context,
    });
    reloadVerdict = verdictLabel(r.verdict);
  }

  out.heading(`连续性结论：${verdictLabel(continuity.verdict)}`);
  for (const p of analysis.periods) out.line(formatPeriod(p));
  printResult(out, continuity);
  if (reloadVerdict) out.line(`同一配置重载影响：${reloadVerdict}（详见 results/same_profile_reload_impact.json）`);
  return 0;
}
