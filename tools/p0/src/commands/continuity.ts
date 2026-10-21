// continuity：工具作为“其他应用”经 Surge HTTP 代理端口保持长连接流、WebSocket 与周期短请求，记录时间线；
// 操作员在另一个终端执行 refresh/entry 或在 Surge 中手动重载同一配置，在本终端输入事件名标记。
// 第一个事件之前的时段是对照（本身有重置或失败时结论为不完整）。也合并其他命令写入的动作时间线（资源刷新、选择、入口切换）。
// 同一配置重载（--reload-test）：先原子替换 canary 规则集（不刷新）作为“重载确实发生”的证据，整个观察窗口内的
// 中断都计入重载影响（操作员的标记可能晚于实际重载）；没有重载证据时不判定“无影响”。

import { createInterface, type Interface } from 'node:readline';
import { CAPABILITY_CRITERIA } from '@sfe/contract';
import { analyzeContinuity, assessReload, formatPeriod, periodImpacted, summarizePeriods, type MarkedEvent, type ReloadSignalEvidence } from '../analysis/continuity.js';
import { compareSignals, type ReloadSignals } from '../analysis/reload.js';
import { ACTIONS_LOG } from '../constants.js';
import { refused, type ExitCode } from '../errors.js';
import { check, logAction, verdictLabel, writeResult, type ActionEntry } from '../results.js';
import { CANARY_FILE } from '../test-profile.js';
import { startOtherAppTraffic } from '../traffic.js';
import { confirmWrites, fmtBool, measureContext, openRun, openSession, printResult, proxyOf, requireServers, tryRead, type Ctx } from './common.js';
import { TestOps } from './test-ops.js';

const BASELINE_MIN_MS = 30_000;
/** 点击「重新加载配置」与输入 reload 标记之间允许的延迟：标记前这段时间的中断归入重载，不算对照。 */
const RELOAD_LEAD_MS = 15_000;
const isReloadLabel = (label: string): boolean => label.startsWith('reload');

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

  // 重载测量：布置 canary（只写本工具创建的测试规则集文件，不刷新），之后能看到它被重新读取即证明重载确实发生。
  const reloadTest = ctx.args.booleans['reload-test'] === true;
  let ops: TestOps | null = null;
  let canaryIndex: number | null = null;
  let sigBefore: ReloadSignals | null = null;
  if (reloadTest) {
    const ok = await confirmWrites(
      ctx,
      '同一配置重载影响测量',
      [`原子替换测试 canary 规则集 ${CANARY_FILE}（不刷新），作为“重载确实发生”的证据；重载由你在 Surge 菜单中手动执行`],
      ['canary 规则集只存在于测试配置；切回原配置后按 rollback 列出的文件删除', '本命令不添加临时规则、不刷新资源、不重载配置'],
    );
    if (!ok) throw refused('已取消：没有写入任何东西');
    ops = new TestOps(ctx, dir, session, state);
    canaryIndex = Math.floor(now().getTime() / 1000) % 1_000_000;
    await ops.armCanary(canaryIndex);
    await ctx.deps.sleep(3000);
    sigBefore = await ops.signals(proxy, servers.echoPort, canaryIndex);
    if (sigBefore.canaryLoaded !== false) {
      out.warn('canary 在没有刷新时已被读取或无法判断（自动重载可能已开启）：无法用 canary 证明重载发生。请在 Surge 设置中关闭自动重载后重测');
      canaryIndex = null;
    }
  }

  out.heading('连接连续性（其他应用）');
  out.line(`通过条件：${CAPABILITY_CRITERIA.connection_continuity}`);
  out.line(`经 Surge 代理 ${proxy.host}:${proxy.port} 访问测试回显主机（经 P0-Plain），间隔 ${intervalMs} ms，最长 ${duration / 1000} 秒。`);
  if (reloadTest) {
    out.line(`先保持至少 ${(BASELINE_MIN_MS + RELOAD_LEAD_MS) / 1000} 秒不做任何变更（对照）；然后在本终端输入 reload 回车，再立即在 Surge 菜单中「重新加载配置」。`);
    out.line('恢复后再观察 30 秒，输入 q 结束。观察期间不要运行 refresh、entry 等其他命令。');
  } else {
    out.line('先保持至少 30 秒不做任何变更（对照）；之后在另一个终端运行 refresh 或 entry。测量同一配置重载请改用 continuity --reload-test。');
    out.line('在本终端输入事件名后回车标记（例如 refresh、select），输入 q 结束。');
  }

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
  const sigAfter = ops ? await ops.signals(proxy, servers.echoPort, canaryIndex) : null;

  const actions = dir
    .readJsonl<ActionEntry>(ACTIONS_LOG)
    .filter((a) => a.command !== 'continuity' && ['resource_refresh', 'select', 'entry_step', 'test_file_written'].includes(a.action))
    .map((a): MarkedEvent => ({ t: Date.parse(a.at), label: `${a.command}:${a.action}`, source: 'action' }))
    .filter((e) => e.t >= start && e.t <= end);
  const events = [...marks, ...actions].sort((a, b) => a.t - b.t);
  const analysis = analyzeContinuity(traffic.samples, events, { start, end });
  dir.writeJson(`continuity/${start}.json`, { start, end, marks, actions, samples: traffic.samples, analysis, reloadSignals: { before: sigBefore, after: sigAfter } });

  const takeoverAfter = await tryRead(() => session.adapter.getTakeoverState());
  const profileAfter = (await tryRead(() => session.adapter.getCurrentProfile()))?.name ?? null;
  const baseline = analysis.periods[0]!;
  const changes = analysis.impacts.filter((i) => !isReloadLabel(i.label));
  const refreshSeen = events.some((e) => e.label.includes('resource_refresh'));
  const vias = new Set(analysis.periods.flatMap((p) => p.vias));
  const context = await measureContext(ctx, session, state);
  const continuity = writeResult(dir, {
    key: 'connection_continuity',
    command: 'continuity',
    at: now().toISOString(),
    checks: [
      check('有至少 30 秒的对照时段', baseline.to - baseline.from >= BASELINE_MIN_MS && baseline.shortTotal > 0, `${Math.round((baseline.to - baseline.from) / 1000)} 秒`),
      // 对照本身有中断时无法比较：结论为不完整，而不是把变更期间的结果当作通过或不通过。
      check('对照时段没有重置或失败', periodImpacted(baseline) ? null : true, periodImpacted(baseline) ? '对照时段已有重置、重连失败或短请求失败：测试环境本身不稳定，请重测' : ''),
      check('期间执行过节点资源发布（refresh）', refreshSeen ? true : null, refreshSeen ? '' : '没有观察到资源刷新动作'),
      check('长连接与 WebSocket 没有重置', changes.length === 0 ? null : changes.every((i) => i.streamResets === 0 && i.wsResets === 0 && i.wsOpenFailures === 0)),
      check('新请求正常', changes.length === 0 ? null : changes.every((i) => i.failedShorts === 0)),
      check('出口不变（始终经过 p0-plain）', vias.size === 0 ? null : vias.size === 1 && vias.has('p0-plain'), [...vias].join('、')),
    ],
    summary: [`通过条件：${CAPABILITY_CRITERIA.connection_continuity}`, ...summarizePeriods(analysis.periods.filter((p, i) => i === 0 || !isReloadLabel(p.label)))],
    context,
  });
  const reloadMarked = events.some((e) => isReloadLabel(e.label));
  let reloadVerdict: string | null = null;
  if (reloadMarked || reloadTest) {
    const signals: ReloadSignalEvidence | null =
      sigBefore && sigAfter
        ? {
            ...compareSignals(sigBefore, sigAfter),
            restarted: sigBefore.surgeStart !== null && sigAfter.surgeStart !== null && sigBefore.surgeStart !== sigAfter.surgeStart,
          }
        : null;
    const ra = assessReload(traffic.samples, events, { start, end }, { leadMs: RELOAD_LEAD_MS, baselineMinMs: BASELINE_MIN_MS, isReload: isReloadLabel, signals });
    const w = ra.window;
    const impactText = `长连接/WebSocket 重置 ${w.streamResets + w.wsResets}，WebSocket 重连失败 ${w.wsOpenFailures}，短请求失败 ${w.failedShorts}/${w.shortTotal}，恢复时间 ${ra.recoveryMs ?? '未恢复'} ms`;
    const r = writeResult(dir, {
      key: 'same_profile_reload_impact',
      command: 'continuity',
      at: now().toISOString(),
      checks: [
        check('已标记重载', ra.marks.length > 0 ? true : null, ra.marks.length > 0 ? '' : '没有输入 reload 标记'),
        check(
          `重载前至少 ${BASELINE_MIN_MS / 1000} 秒的对照没有中断`,
          ra.baselineOk,
          ra.baselineOk ? '' : `对照 ${Math.round((ra.baseline.to - ra.baseline.from) / 1000)} 秒（不含标记前 ${RELOAD_LEAD_MS / 1000} 秒），短请求 ${ra.baseline.shortTotal}，中断 ${ra.baseline.issues}`,
        ),
        check('确实发生了同一配置重载', ra.evidence, ra.evidenceNote),
        check('观察期间只有重载（没有其他变更）', ra.onlyReload, ra.otherEvents.length > 0 ? `另有 ${ra.otherEvents.length} 个变更事件：请单独测量重载` : ''),
        check('接管与出站模式不变', takeoverBefore === null || takeoverAfter === null ? null : JSON.stringify({ ...takeoverBefore, checkedAt: null }) === JSON.stringify({ ...takeoverAfter, checkedAt: null }), `之后：增强模式 ${fmtBool(takeoverAfter?.enhancedMode)}，系统代理 ${fmtBool(takeoverAfter?.systemProxy)}，出站 ${takeoverAfter?.outboundMode ?? '读不到'}`),
        check('配置身份不变', profileBefore === null || profileAfter === null ? null : profileBefore === profileAfter),
        check('其他应用不受影响（整个观察窗口）', ra.unaffected, impactText),
      ],
      summary: [
        `通过条件：${CAPABILITY_CRITERIA.same_profile_reload_impact}`,
        `整个观察窗口（${Math.round((w.to - w.from) / 1000)} 秒，含标记前的延迟）：${impactText}`,
        `重载证据：${ra.evidence ? ra.evidenceNote : `无（${ra.evidenceNote}）`}`,
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
