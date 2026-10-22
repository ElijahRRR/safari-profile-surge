// entry：在测试配置上用服务的入口策略（temp_rule 或 ruleset_resource）驱动 NORMAL→BLOCKED→VERIFY_ONLY→ACTIVE→NORMAL，
// Safari 测试页与 Chrome 测试页保持轮询。检查：每个模式读回精确、切换中无放行窗口（Surge 记录）、Chrome 不受影响、
// 优先于注入的临时规则/模块 DIRECT 规则、UDP/QUIC 被拒绝并回落 TCP 经 SFE-ROUTE、没有配置重载、
// BLOCKED 后结束 Safari 旧连接、（可选）Surge 重启后的规则去留。--to 只做一次切换（例如回到 NORMAL）。
// UDP/QUIC 结果另带逐协议覆盖：IPv6、WebSocket 在本次运行中实测；扩展页面请求与测试页请求无法区分，
// 由同一进程路径的归属结果补足（见 analysis/udp-coverage.ts）。
// 临时规则一律按规范化文本比较（Surge 列出时可能改变逗号与括号周围的空格）；注入测试规则前确认没有相同的用户规则。

import { existsSync, readFileSync } from 'node:fs';
import { CAPABILITY_CRITERIA, ENTRY_RULESET_FILES, type EntryStrategy, type KillResult, type KnownEntryMode, type ProtocolCoverage } from '@sfe/contract';
import { analyzeEntryWindow, outcomeOf, type ObservedRequest } from '../analysis/entry-window.js';
import { compareSignals, type ReloadSignals } from '../analysis/reload.js';
import { udpQuicCoverage, websocketEvidence, type ModeWindow } from '../analysis/udp-coverage.js';
import { DEFAULT_H3_HOST, DEFAULT_IPV6_HOST } from '../constants.js';
import { processPathsDigest } from '../context.js';
import {
  ENTRY_BITS_IN_ORDER,
  createRulesetStrategy,
  createTempRuleStrategy,
  killSafariConnections,
  normalizeRuleText,
  ownedRulesetRecords,
  tempRuleText,
  validateSafariProcessPaths,
  type EntryController,
  type SurgeRequestRecord,
} from '../deps.js';
import { createFileEntryOwnership, loadEntryRecords } from '../entry-ownership.js';
import { precedenceTest, probeTempInsertion, runEntrySequence, type ModeRecord } from '../entry-driver.js';
import { refused, type ExitCode } from '../errors.js';
import { check, readResult, writeResult, type CheckItem } from '../results.js';
import { markTempRule, recordTempRuleIntent, saveState } from '../state.js';
import { surgeStartFingerprint } from '../system.js';
import { CANARY_FILE, ECHO_HOST, PRECEDENCE_MODULE_FILE, TEST_NODES, TEST_USERS, profileRuleLines } from '../test-profile.js';
import { describeImpact, startOtherAppTraffic, trafficImpact, trafficUnaffected } from '../traffic.js';
import { allowRefreshFor, confirmWrites, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, verifyHostOf, type Ctx } from './common.js';
import { TestOps, chromeImpact, pageEvents } from './test-ops.js';

const SEQUENCE: readonly KnownEntryMode[] = ['BLOCKED', 'VERIFY_ONLY', 'ACTIVE', 'NORMAL'];
const SETTLE_MS = 2000;

interface RestartInfo {
  readback: string | null;
  ourRulesPresent: boolean | null;
  startChanged: boolean | null;
  normalAfter: boolean;
}

/** 主序列完成后：回到 ACTIVE，由操作员手动退出并重开 Surge，读回入口规则去留，再回到 NORMAL。 */
async function restartPhase(
  ctx: Ctx,
  controller: EntryController,
  session: { adapter: { listTempRules(): Promise<string[]> } },
  ourTempRules: readonly string[],
  onStep: (step: { bit: string; value: boolean }) => void,
): Promise<RestartInfo> {
  const { prompt, exec } = ctx.deps;
  await controller.transition('ACTIVE', onStep);
  const startBefore = await surgeStartFingerprint(exec);
  await prompt.pause('现在在 Surge 菜单中退出 Surge，再重新打开，等待接管恢复');
  const rb = await tryRead(() => controller.read());
  const temps = await tryRead(() => session.adapter.listTempRules());
  const startAfter = await surgeStartFingerprint(exec);
  let normalAfter = true;
  try {
    await controller.transition('NORMAL', onStep);
  } catch {
    normalAfter = false;
    ctx.deps.out.warn('重启后回到 NORMAL 失败：请运行 entry --to NORMAL 或 rollback');
  }
  ctx.deps.out.line(`Surge 重启后入口读回：${rb?.mode ?? '读不到'}`);
  return {
    readback: rb?.mode ?? null,
    ourRulesPresent: temps === null || ourTempRules.length === 0 ? null : ourTempRules.some((r) => hasRule(temps, r)),
    startChanged: startBefore === null || startAfter === null ? null : startBefore !== startAfter,
    normalAfter,
  };
}

/** 测试配置 [Rule] 段的规则文本（读不到时为 null，插入探测会如实报告无法确定配置规则的起点）。 */
function testProfileRules(path: string | null): string[] | null {
  if (!path) return null;
  try {
    return profileRuleLines(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 临时规则列表中是否有与 rule 规范化后相同的规则。 */
function hasRule(list: readonly string[], rule: string): boolean {
  const want = normalizeRuleText(rule);
  return list.some((r) => normalizeRuleText(r) === want);
}

export async function runEntry(ctx: Ctx): Promise<ExitCode> {
  const { out, prompt, now, sleep } = ctx.deps;
  const strategy = ctx.args.strings.strategy as EntryStrategy | undefined;
  if (!strategy) throw refused('参数检查失败：请用 --strategy temp_rule|ruleset_resource 指定入口策略');
  const { dir, state: initial } = openRun(ctx);
  const servers = await requireServers(ctx, initial);
  const session = await openSession(ctx, dir, initial, { needTestProfile: true });
  const ops = new TestOps(ctx, dir, session, initial);
  const processPaths = ctx.args.lists['process-path'] ?? ops.state.processPaths;
  const pathErrors = validateSafariProcessPaths(processPaths, { exists: (p) => existsSync(p) });
  if (pathErrors.length > 0) throw refused(`前置条件不满足：Safari 进程路径不可用（${pathErrors.map((e) => e.message).join('；')}）。先完成 attribution 或用 --process-path 指定`);
  const verifyHost = verifyHostOf(ctx);
  const h3Host = ctx.args.strings['h3-host'] ?? servers.h3Host ?? DEFAULT_H3_HOST;
  // 测试页轮询的 IPv6 检测主机（与 test-servers 允许的上游相同）。
  const ipv6Host = DEFAULT_IPV6_HOST;
  const proxy = proxyOf(ctx);
  const dwellMs = (ctx.args.numbers.dwell ?? 20) * 1000;
  const cfg = { processPaths: [...processPaths], verifyHost, siteHosts: [ECHO_HOST, h3Host, 'www.amazon.com'] };
  const operationId = `p0-${dir.id}`;
  session.guard.killablePaths = new Set(processPaths);

  // ruleset_resource 写入时按服务规则比较的自动重载条件（记入摘要；提议的自动重载上下文仍以测量时读到的设置为证据）。
  const condition = strategy === 'ruleset_resource' ? ((ctx.args.strings['auto-reload-condition'] as 'on' | 'off' | 'any' | undefined) ?? null) : null;
  // 入口归属记录（运行目录中持久化）。ruleset：只有本工具创建且未被改动的规则集文件才登记为本应用所有。
  let controller: EntryController;
  if (strategy === 'ruleset_resource') {
    const names = ENTRY_BITS_IN_ORDER.map((b) => ENTRY_RULESET_FILES[b]);
    for (const n of names) if (!ops.state.createdFiles.some((f) => f.path === `${ops.state.testDirectory}/${n}`)) throw refused(`前置条件不满足：${n} 不是本工具创建的测试文件`);
    const keys = await allowRefreshFor(session, ops.state, names);
    if (Object.keys(keys).length !== names.length) throw refused('前置条件不满足：Surge 中找不到全部四个入口规则集资源（请确认已切换到测试配置）');
    let seed: Awaited<ReturnType<typeof ownedRulesetRecords>> = [];
    if (!(loadEntryRecords(dir) ?? []).some((r) => r.kind === 'entry_ruleset_file')) {
      seed = await ownedRulesetRecords(ops.files, operationId);
      for (const r of seed) {
        const rec = ops.state.createdFiles.find((f) => f.path === `${ops.state.testDirectory}/${r.identity}`);
        if (!rec || rec.digest !== r.digest) throw refused(`前置条件不满足：${r.identity} 已被外部修改`);
      }
    }
    if (condition === null) out.warn('没有 --auto-reload-condition：ruleset_resource 策略会按服务规则拒绝写入（读不到或不一致即拒绝）');
    controller = createRulesetStrategy({
      adapter: session.adapter,
      files: ops.files,
      ownership: createFileEntryOwnership(dir, seed),
      config: () => cfg,
      operationId: () => operationId,
      autoReloadCondition: () => condition,
    });
  } else {
    const insertion = (ctx.args.strings['temp-insertion'] as 'head' | 'tail' | undefined) ?? ops.state.tempRuleInsertion ?? undefined;
    controller = createTempRuleStrategy({ adapter: session.adapter, ownership: createFileEntryOwnership(dir), config: () => cfg, operationId: () => operationId, insertion });
  }
  // 临时规则：本策略可能添加的四条精确规则先登记意图，守卫只放行它们。
  const entryTempRules = strategy === 'temp_rule' ? ENTRY_BITS_IN_ORDER.map((b) => tempRuleText(b, cfg)) : [];
  const register = async (rule: string, purpose: string): Promise<void> => {
    ops.state = recordTempRuleIntent(ops.state, rule, purpose, now());
    saveState(dir, ops.state);
    session.guard.tempRules.add(rule);
  };
  const markRemoved = async (rule: string): Promise<void> => {
    ops.state = markTempRule(ops.state, rule, 'removed', now());
    saveState(dir, ops.state);
  };
  // listTempRules 的正向确认：本次运行了插入探测时以本次结果为准（undefined = 本次未探测），否则以运行状态中
  // 之前的确认为准。只有确认为 true 时，列表中“没有”才能当作已删除；未确认（null）与确认不可用（false）都不能。
  let probedNow: boolean | null | undefined;
  const tempListTrusted = (): boolean => (probedNow !== undefined ? probedNow === true : ops.state.tempListConfirmed === true);
  const syncTempRules = async (): Promise<void> => {
    const list = await tryRead(() => session.adapter.listTempRules());
    if (list === null) return;
    const trusted = tempListTrusted();
    for (const r of session.guard.tempRules) {
      // 列表中出现是正向证据；列表中没有只在列表经过正向确认时才标为已删除。
      if (hasRule(list, r)) ops.state = markTempRule(ops.state, r, 'present', now());
      else if (trusted) ops.state = markTempRule(ops.state, r, 'removed', now());
    }
    saveState(dir, ops.state);
  };
  let insertionNote: string | null = null;
  // 插入探测：添加并删除两条永不命中的临时规则，测量插入位置，并正向确认 listTempRules（结果记入运行状态）。
  const runInsertionProbe = async (): Promise<void> => {
    const p = await probeTempInsertion(session.adapter, (r) => register(r, 'insertion-probe'), markRemoved, { profileRules: testProfileRules(ops.state.testProfilePath) });
    probedNow = p.tempListConfirmed;
    if (p.insertion || p.tempListConfirmed !== null) {
      // null（无法确认）不覆盖之前的结论；false 只来自“添加已生效、列表却没有列出”的确定证据，之后的 true 可以覆盖它。
      ops.state = { ...ops.state, tempRuleInsertion: p.insertion ?? ops.state.tempRuleInsertion, tempListConfirmed: p.tempListConfirmed ?? ops.state.tempListConfirmed };
      saveState(dir, ops.state);
    }
    const listMech = session.mechanism.listTempRules ?? 'unavailable';
    insertionNote = p.skipped
      ? `新临时规则插入位置：${p.skipped}；listTempRules（${listMech}）未确认`
      : [
          `新临时规则插入位置：${p.insertion ?? '无法判断'}`,
          p.beforeProfileRules === null
            ? `与配置规则的先后无法判断（${p.boundaryNote ?? '原因未知'}）`
            : p.beforeProfileRules
              ? '临时规则排在测试配置规则之前'
              : '临时规则没有排在全部测试配置规则之前',
          p.tempListConfirmed === true ? `listTempRules（${listMech}）列出了刚添加的探测规则` : `listTempRules（${listMech}）${p.tempListConfirmed === false ? '' : '未确认：'}${p.tempListNote ?? '原因未知'}`,
        ].join('；');
    ops.action('insertion_probe', {
      insertion: p.insertion,
      beforeProfileRules: p.beforeProfileRules,
      tempListConfirmed: p.tempListConfirmed,
      tempListReadError: p.tempListReadError,
      addConfirmed: p.addConfirmed,
      skipped: p.skipped ?? null,
    });
    out.line(insertionNote);
    if (p.tempListConfirmed === false) {
      out.warn('listTempRules 读不到刚添加的临时规则：临时规则的读回、同步与回退都不可信，--precedence-test temp 不注入；把 dump temp-rule 的输出格式交给开发者核对');
    } else if (p.addConfirmed === false) {
      out.warn('有效规则中也看不到刚添加的探测规则：addTempRule 可能没有生效（不归咎于 listTempRules）；把 temp-rule add 的实际效果交给开发者核对');
    }
  };
  const syncEntryDigests = async (): Promise<void> => {
    if (strategy === 'ruleset_resource') for (const b of ENTRY_BITS_IN_ORDER) await ops.syncDigest(ENTRY_RULESET_FILES[b]);
  };

  // 单次切换（例如回到 NORMAL）。
  const single = ctx.args.strings.to as KnownEntryMode | undefined;
  if (single) {
    // temp_rule 进入 NORMAL 之外的模式要靠 listTempRules 读回：运行状态中没有正向确认时先探测（或按 --probe-insertion 探测）。
    const probe = ctx.args.booleans['probe-insertion'] === true || (strategy === 'temp_rule' && single !== 'NORMAL' && ops.state.tempListConfirmed !== true);
    // listTempRules 被确认不可用时读回不可信，无法确认任何模式（包括 NORMAL）：改用 rollback 逐条删除本工具登记的规则。
    const listUnusable = (): boolean => strategy === 'temp_rule' && ops.state.tempListConfirmed === false;
    const unusable = '前置条件不满足：listTempRules 已被确认不可用（没有列出本工具刚添加的探测规则），temp_rule 入口无法读回。请运行 rollback --execute 逐条删除本工具登记的临时规则，并在 Surge 中手动核对';
    if (!probe && listUnusable()) throw refused(unusable);
    const ok = await confirmWrites(
      ctx,
      `入口切换到 ${single}`,
      [...(probe ? ['添加并删除两条永不命中的临时规则，正向确认 listTempRules 并测量插入位置'] : []), `按 ${strategy} 策略逐位切换到 ${single}，每步读回`],
      ['失败时停在已确认的更严格状态；进入普通模式：entry --to NORMAL', 'rollback --execute 删除本工具添加的临时规则'],
    );
    if (!ok) throw refused('已取消：没有写入任何东西');
    if (probe) await runInsertionProbe();
    if (strategy === 'temp_rule' && single !== 'NORMAL' && !tempListTrusted()) {
      throw refused(`前置条件不满足：listTempRules 没有经过正向确认（${insertionNote ?? '未探测'}），temp_rule 入口依赖它读回，没有写入入口规则`);
    }
    if (listUnusable()) throw refused(unusable);
    // 入口写入之前登记意图（被拒绝时不登记从未写入的规则）。
    for (const r of entryTempRules) await register(r, 'entry');
    const run = await runEntrySequence({ controller, now: () => now().getTime(), onStep: (r) => ops.action('entry_step', { bit: r.step.bit, value: r.step.value }) }, [single]);
    await syncTempRules();
    await syncEntryDigests();
    const m = run.modes[0]!;
    out.line(m.ok ? `已切换到 ${single}（读回 ${m.readbackMode}）` : `切换失败：${m.error?.code ?? '读回不符'} ${m.error?.message ?? `读回 ${m.readbackMode}`}`);
    if (strategy === 'temp_rule' && !tempListTrusted()) {
      out.warn('listTempRules 没有经过正向确认（entry 的插入探测）：读回不能证明本工具的临时规则已删除；接着运行 rollback --execute，并在 Surge 中核对');
    }
    return m.ok ? 0 : 1;
  }

  const before = await controller.read();
  if (before.mode !== 'NORMAL') throw refused(`前置条件不满足：入口读回为 ${before.mode}，不是 NORMAL。先运行 entry --strategy ${strategy} --to NORMAL`);
  const snap = await takeSnapshot(ctx, session, dir, 'entry-before');
  printSnapshot(out, snap);
  const precedenceTests = new Set(ctx.args.lists['precedence-test'] ?? []);
  // temp_rule 入口与 --precedence-test temp 都依赖 listTempRules：必须在本次运行中由插入探测正向确认。
  const probeMain = ctx.args.booleans['probe-insertion'] === true || strategy === 'temp_rule' || precedenceTests.has('temp');
  const ok = await confirmWrites(
    ctx,
    `入口模式测试（${strategy}）`,
    [
      `SFE-ROUTE 选择 ${TEST_NODES.a}；原子替换 canary 规则集（不刷新）作为重载检测`,
      ...(probeMain ? ['添加并删除两条永不命中的临时规则，正向确认 listTempRules 并测量新临时规则的插入位置'] : []),
      ...(precedenceTests.has('temp') ? [`添加临时规则 DOMAIN,${verifyHost},DIRECT，确认 VERIFY_ONLY 被拒绝后删除`] : []),
      ...(precedenceTests.has('module') ? [`由你在 Surge 中手动启用测试模块 ${PRECEDENCE_MODULE_FILE}，确认 VERIFY_ONLY 被拒绝后手动停用`] : []),
      `按 ${strategy} 策略依次切换 ${SEQUENCE.join(' → ')}，每个模式停留 ${dwellMs / 1000} 秒`,
      ...(ctx.args.booleans['no-kill-test'] ? [] : ['BLOCKED 后结束属于 Safari 进程路径的连接（逐条记录，不影响其他应用）']),
      ...(ctx.args.booleans['restart-test'] ? ['主序列结束后再次进入 ACTIVE，由你手动退出并重新打开 Surge，读回入口规则去留，再回到 NORMAL'] : []),
    ],
    [
      strategy === 'temp_rule'
        ? '进入普通模式：entry --strategy temp_rule --to NORMAL（listTempRules 被插入探测确认不可用时会拒绝：改用 rollback --execute 并在 Surge 中核对）'
        : `进入普通模式：entry --strategy ${strategy} --to NORMAL`,
      'rollback --execute：只删除本工具登记过的临时规则',
      `切回原配置「${ops.state.sourceProfileName ?? '原配置'}」后删除测试文件（本命令不改动测试配置之外的任何文件）`,
    ],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const traffic = startOtherAppTraffic({ proxy, echoPort: servers.echoPort, intervalMs: 1000, label: 'entry' });
  let seqStart = now().getTime();
  const records = new Map<string, SurgeRequestRecord>();
  const collect = async (): Promise<void> => {
    const list = await tryRead(() => session.adapter.listRecentRequests());
    for (const r of list ?? []) records.set(r.id, r);
  };
  const checksPrecedence: CheckItem[] = [];
  let canaryIndex: number | null = null;
  let sigBefore: ReloadSignals | null = null;
  let sigAfter: ReloadSignals | null = null;
  // 在回调中写入的观察结果（放在对象里，避免闭包赋值后的类型收窄问题）。
  const obs: { killResults: KillResult[] | null; killError: string | null; h3Observed: string | null } = { killResults: null, killError: null, h3Observed: null };
  const windows: ModeWindow[] = [];
  let restart: RestartInfo | null = null;
  let run: Awaited<ReturnType<typeof runEntrySequence>> | null = null;
  let seqEnd = 0;

  try {
    const selected = await ops.select(TEST_NODES.a);
    if (selected !== TEST_NODES.a) out.warn(`SFE-ROUTE 选择读回为 ${selected ?? '读不到'}`);
    canaryIndex = Math.floor(now().getTime() / 1000) % 1_000_000;
    await allowRefreshFor(session, ops.state, [CANARY_FILE]);
    await ops.armCanary(canaryIndex);
    await sleep(3000);
    sigBefore = await ops.signals(proxy, servers.echoPort, canaryIndex);
    if (sigBefore.canaryLoaded !== false) {
      out.warn('canary 在没有刷新时已被读取或无法判断（自动重载可能已开启）：本次无法用 canary 判断是否重载');
      canaryIndex = null;
    }

    if (probeMain) await runInsertionProbe();
    // temp_rule 策略的每一步都靠 listTempRules 读回：本次运行没有正向确认它时，入口写入之前停止。
    if (strategy === 'temp_rule' && !tempListTrusted()) {
      throw refused(`前置条件不满足：listTempRules 没有经过正向确认（${insertionNote ?? '未探测'}），temp_rule 策略依赖它读回，未运行入口序列`);
    }
    // 入口写入（优先级测试与主序列）之前登记意图；上面被拒绝时不登记从未写入的规则。
    for (const r of entryTempRules) await register(r, 'entry');

    const tempPrecedenceName = '入口优先于用户临时规则（注入 DIRECT 规则时拒绝进入 VERIFY_ONLY）';
    const tempListUnusable = !tempListTrusted();
    const existingTemps = precedenceTests.has('temp') && !tempListUnusable ? await tryRead(() => session.adapter.listTempRules()) : null;
    if (precedenceTests.has('temp') && (existingTemps === null || hasRule(existingTemps, `DOMAIN,${verifyHost},DIRECT`))) {
      // 用户已有相同的临时规则（或读不到列表、列表未经正向确认）时不注入：注入与清理都按文本，会删掉或接管用户自己的规则。
      const why = tempListUnusable
        ? `listTempRules 没有经过正向确认（${insertionNote ?? '未探测'}），无法确认没有相同的用户规则，未注入`
        : existingTemps === null
          ? '读不到当前临时规则，无法确认没有相同的用户规则，未注入'
          : '已存在相同的用户临时规则，未注入（不会删除用户自己的规则）';
      checksPrecedence.push(check(tempPrecedenceName, null, why));
    } else if (precedenceTests.has('temp')) {
      const rule = `DOMAIN,${verifyHost},DIRECT`;
      const r = await precedenceTest(
        controller,
        async () => {
          await register(rule, 'precedence-test');
          await session.adapter.addTempRule(rule);
        },
        async () => {
          await session.adapter.removeTempRule(rule).catch(() => undefined);
          await syncTempRules();
        },
      );
      checksPrecedence.push(check(tempPrecedenceName, r.refused && r.modeAfter === 'NORMAL', `错误 ${r.code ?? '无（未被拒绝）'}，阻断项 ${r.blockingIssues}，之后读回 ${r.modeAfter}`));
    }
    if (precedenceTests.has('module')) {
      await prompt.pause(`在 Surge「模块」中安装并启用本地模块 ${ops.state.testDirectory}/${PRECEDENCE_MODULE_FILE}`);
      const moduleRule = normalizeRuleText(`DOMAIN,${verifyHost},DIRECT`);
      const enabled = ((await tryRead(() => session.adapter.listRules())) ?? []).some((r) => normalizeRuleText(r.text) === moduleRule);
      if (!enabled) {
        checksPrecedence.push(check('入口优先于模块 DIRECT 规则（启用测试模块时拒绝进入 VERIFY_ONLY）', null, '有效规则中没有看到测试模块的规则：模块未启用或 listRules 不含模块规则'));
      } else {
        const r = await precedenceTest(controller, async () => undefined, async () => {
          await prompt.pause('在 Surge「模块」中停用并移除该测试模块');
        });
        checksPrecedence.push(check('入口优先于模块 DIRECT 规则（启用测试模块时拒绝进入 VERIFY_ONLY）', r.refused && r.modeAfter === 'NORMAL', `错误 ${r.code ?? '无（未被拒绝）'}，阻断项 ${r.blockingIssues}，之后读回 ${r.modeAfter}`));
      }
    }

    await prompt.pause(
      `在 Safari 测试场景打开 http://${ECHO_HOST}:${servers.echoPort}/app/safari ，在 Chrome 打开 http://${ECHO_HOST}:${servers.echoPort}/app/chrome ，两页保持轮询`,
    );
    seqStart = now().getTime();
    run = await runEntrySequence(
      {
        controller,
        now: () => now().getTime(),
        onStep: (r) => ops.action('entry_step', { bit: r.step.bit, value: r.step.value, effective: r.step.effective }),
        afterMode: async (m: ModeRecord) => {
          out.line(`${m.target}：读回 ${m.readbackMode}${m.ok ? '' : '（与目标不符）'}`);
          const from = m.confirmedAt!;
          if (m.target === 'BLOCKED' && !ctx.args.booleans['no-kill-test']) {
            try {
              obs.killResults = await killSafariConnections(session.adapter, { processPaths, verifyHost, now, bestEffort: false });
            } catch (e) {
              obs.killError = (e as { code?: string }).code ?? 'ERROR';
              obs.killResults = ((e as { details?: { killResults?: KillResult[] } }).details?.killResults ?? null) as KillResult[] | null;
            }
            const kr = obs.killResults;
            out.line(`结束 Safari 连接：${kr ? `${kr.filter((k) => k.ok).length}/${kr.length} 条` : '失败'}${obs.killError ? `（${obs.killError}）` : ''}`);
          }
          if (m.target === 'VERIFY_ONLY') out.line('预期：Safari 测试页回显失败、检测服务成功；Chrome 不受影响。');
          if (m.target === 'ACTIVE') {
            out.line(`预期：Safari 测试页回显经过 ${TEST_USERS.a}；在 Safari 打开 https://${h3Host}/cdn-cgi/trace 并刷新 3 次。`);
          }
          await sleep(dwellMs);
          if (m.target === 'ACTIVE') {
            const v = await prompt.ask('ACTIVE 下 HTTP/3 测试页最后显示的 http= 值（http/2 表示已回落 TCP；未测直接回车）：');
            obs.h3Observed = v && /^http\/[123](\.1)?$/.test(v.trim()) ? v.trim() : null;
          }
          await collect();
          windows.push({ mode: m.target, from, to: now().getTime() });
        },
      },
      SEQUENCE,
    );
    seqEnd = now().getTime();
    sigAfter = await ops.signals(proxy, servers.echoPort, canaryIndex);
    if (ctx.args.booleans['restart-test'] && !run.stoppedEarly) restart = await restartPhase(ctx, controller, session, entryTempRules, (step) => ops.action('entry_step', { bit: step.bit, value: step.value }));
    if (run.stoppedEarly) {
      const last = run.modes[run.modes.length - 1]!;
      out.warn(`切换停止在 ${last.target}：${last.error ? `${last.error.code} ${last.error.message}` : `读回 ${last.readbackMode}`}`);
      if (await prompt.confirm('是否进入普通模式（NORMAL）？')) {
        try {
          await controller.transition('NORMAL', (step) => ops.action('entry_step', { bit: step.bit, value: step.value }));
        } catch (e) {
          out.warn(`进入普通模式失败：${(e as { code?: string }).code ?? 'ERROR'}；请运行 entry --to NORMAL 或 rollback`);
        }
      }
    }
  } finally {
    await collect();
    if (seqEnd === 0) seqEnd = now().getTime();
    if (sigAfter === null) sigAfter = await ops.signals(proxy, servers.echoPort, canaryIndex).catch(() => null);
    await traffic.stop();
    await syncTempRules();
    await syncEntryDigests();
  }
  // ---------- 分析 ----------
  const safariSet = new Set(processPaths);
  const all = [...records.values()].filter((r) => r.startedAt !== null && r.startedAt.getTime() >= seqStart && r.startedAt.getTime() <= seqEnd);
  const testHosts = new Set([ECHO_HOST, verifyHost, h3Host, ipv6Host].map((h) => h.toLowerCase()));
  const kept = all
    .filter((r) => (r.processPath !== null && safariSet.has(r.processPath)) || testHosts.has((r.remoteHost ?? '').toLowerCase()))
    .map((r) => ({ ...r, remoteHost: testHosts.has((r.remoteHost ?? '').toLowerCase()) ? r.remoteHost : null }));
  dir.writeJson(`entry/${strategy}-${seqStart}.json`, { strategy, run, windows, kept, ...obs, restart, sigBefore, sigAfter, insertionNote });

  const observed: ObservedRequest[] = kept.map((r) => ({ at: r.startedAt!.getTime(), processPath: r.processPath, host: r.remoteHost, protocol: r.protocol, policy: r.policyName }));
  const window = run ? analyzeEntryWindow(run.timeline, observed, { processPaths, verifyHost, from: seqStart, to: seqEnd }) : { checked: 0, unclassified: 0, violations: [] };
  const modesOk = run !== null && !run.stoppedEarly && run.modes.length === SEQUENCE.length && run.modes.every((m) => m.ok);
  const sb = sigBefore as ReloadSignals | null;
  const sa = sigAfter as ReloadSignals | null;
  const reload = sb && sa ? compareSignals(sb, sa) : { reloaded: null, reasons: [] as string[] };
  const h3Observed = obs.h3Observed;
  const imp = trafficImpact(traffic.samples, seqStart, seqEnd);
  const chrome = chromeImpact(dir, seqStart, seqEnd);
  const safariPage = (mode: KnownEntryMode): Array<{ kind: string; ok: boolean; via?: string | null }> => {
    const w = windows.find((x) => x.mode === mode);
    return w ? pageEvents(dir, 'safari', w.from + SETTLE_MS, w.to) : [];
  };
  const pageExpect = (): boolean | null => {
    const b = safariPage('BLOCKED');
    const v = safariPage('VERIFY_ONLY');
    const a = safariPage('ACTIVE');
    const n = safariPage('NORMAL');
    if ([b, v, a, n].every((x) => x.length === 0)) return null;
    const echo = (xs: typeof b) => xs.filter((e) => e.kind === 'echo');
    const ver = (xs: typeof b) => xs.filter((e) => e.kind === 'verify');
    return (
      echo(b).every((e) => !e.ok) &&
      ver(b).every((e) => !e.ok) &&
      echo(v).every((e) => !e.ok) &&
      ver(v).some((e) => e.ok) &&
      echo(a).some((e) => e.ok) &&
      echo(a).filter((e) => e.ok).every((e) => e.via === TEST_USERS.a) &&
      echo(n).filter((e) => e.ok).every((e) => e.via === TEST_USERS.plain)
    );
  };
  // HTTP/1.1 回显单独判断（不含检测服务）：BLOCKED/VERIFY_ONLY 下全部失败，ACTIVE 下成功且经过目标节点。
  const echoExpect = (): boolean | null => {
    const echo = (mode: KnownEntryMode) => safariPage(mode).filter((e) => e.kind === 'echo');
    const [b, v, a] = [echo('BLOCKED'), echo('VERIFY_ONLY'), echo('ACTIVE')];
    if (b.length + v.length + a.length === 0) return null;
    return b.every((e) => !e.ok) && v.every((e) => !e.ok) && a.some((e) => e.ok) && a.filter((e) => e.ok).every((e) => e.via === TEST_USERS.a);
  };
  const inMode = (mode: KnownEntryMode, r: ObservedRequest): boolean => {
    const w = windows.find((x) => x.mode === mode);
    return w !== undefined && r.at >= w.from && r.at <= w.to;
  };
  const safariObs = observed.filter((r) => r.processPath !== null && safariSet.has(r.processPath));
  const verifyRouted = safariObs.filter((r) => inMode('VERIFY_ONLY', r) && (r.host ?? '').toLowerCase() === verifyHost.toLowerCase() && r.protocol !== 'udp' && outcomeOf(r.policy) === 'route');
  const udpActive = safariObs.filter((r) => r.protocol === 'udp' && (inMode('ACTIVE', r) || inMode('VERIFY_ONLY', r)));
  const udpRejected = udpActive.filter((r) => outcomeOf(r.policy) === 'reject');
  const h3Tcp = safariObs.filter((r) => inMode('ACTIVE', r) && r.protocol !== 'udp' && (r.host ?? '').toLowerCase() === h3Host.toLowerCase());
  const context = await measureContext(ctx, session, ops.state, { entryStrategy: strategy, processPaths });
  const at = now().toISOString();
  const common = [`入口策略：${strategy}`, ...(strategy === 'ruleset_resource' ? [`自动重载条件（--auto-reload-condition）：${condition ?? '未提供'}；测量时读到的自动重载设置：${context.autoReload ?? '读不到'}`] : []), `模式：${run?.modes.map((m) => `${m.target}→${m.readbackMode ?? m.error?.code ?? '?'}`).join('，') ?? '未运行'}`, ...(insertionNote ? [insertionNote] : [])];

  const entryChecks: CheckItem[] = [
    check('四种模式依次精确生效（运行时读回）', modesOk),
    check('切换中无放行窗口（Surge 中的 Safari 请求）', window.checked === 0 ? null : window.violations.length === 0, `核对 ${window.checked} 条，违反 ${window.violations.length} 条，无法归类 ${window.unclassified} 条`),
    check('Safari 测试页在各模式下的结果符合预期', pageExpect(), 'BLOCKED 全部失败；VERIFY_ONLY 只有检测服务成功；ACTIVE 经过目标节点；NORMAL 按原规则'),
    check('Chrome 不受影响', chrome === null ? null : chrome.failures === 0 && chrome.wsCloses === 0, chrome === null ? 'Chrome 测试页没有上报' : `失败 ${chrome.failures}，WebSocket 断开 ${chrome.wsCloses}`),
    check('其他应用长连接与新请求不受影响', trafficUnaffected(imp), describeImpact(imp)),
    check('切换位不发生配置重载', reload.reloaded === null ? null : !reload.reloaded, reload.reasons.join('、')),
    check('AND(进程,域名) 规则可用（VERIFY_ONLY 下检测请求经 SFE-ROUTE）', verifyRouted.length > 0 ? true : null, `${verifyRouted.length} 条`),
    check('AND(进程,UDP) 规则可用（UDP 被拒绝）', udpActive.length === 0 ? null : udpRejected.length === udpActive.length, `${udpRejected.length}/${udpActive.length} 条`),
    ...(checksPrecedence.length > 0 ? checksPrecedence : [check('入口优先于模块 DIRECT 规则与用户临时规则', null, '未运行 --precedence-test temp,module')]),
    ...(precedenceTests.has('temp') && !precedenceTests.has('module') ? [check('入口优先于模块 DIRECT 规则', null, '未运行 --precedence-test module')] : []),
    ...(precedenceTests.has('module') && !precedenceTests.has('temp') ? [check('入口优先于用户临时规则', null, '未运行 --precedence-test temp')] : []),
  ];
  const results = [
    writeResult(dir, { key: 'runtime_entry_modes', command: 'entry', at, checks: entryChecks, summary: [`通过条件：${CAPABILITY_CRITERIA.runtime_entry_modes}`, ...common], context, entryStrategy: strategy, processPaths: [...processPaths] }),
  ];
  // 逐协议覆盖：每一项来自本次运行的测量（或同一进程路径、结论为通过的归属结果），不写死“未测”。
  const modeOf = (at: number): KnownEntryMode | null => windows.find((w) => at >= w.from + SETTLE_MS && at <= w.to)?.mode ?? null;
  const ipv6Records = safariObs
    .filter((r) => (r.host ?? '').toLowerCase() === ipv6Host.toLowerCase() && r.protocol !== 'udp')
    .flatMap((r) => {
      const mode = modeOf(r.at);
      return mode ? [{ mode, outcome: outcomeOf(r.policy) }] : [];
    });
  const normalIpv6 = safariPage('NORMAL').filter((e) => e.kind === 'ipv6_poll');
  // WebSocket 按阻断期（BLOCKED 起到 VERIFY_ONLY 结束）与 VERIFY_ONLY 之后划分，ACTIVE 的首次建立不加稳定时间。
  const websocket = websocketEvidence(windows, pageEvents(dir, 'safari', seqStart, seqEnd), SETTLE_MS);
  const attribution = readResult(dir, 'safari_process_attribution');
  const coverage: ProtocolCoverage = udpQuicCoverage({
    udp: { total: udpActive.length, rejected: udpRejected.length },
    h3Observed,
    h3Tcp: { total: h3Tcp.length, routed: h3Tcp.filter((r) => outcomeOf(r.policy) === 'route').length },
    verifyRouted: verifyRouted.length,
    echoExpect: echoExpect(),
    ipv6: { records: ipv6Records, normalPage: { total: normalIpv6.length, ok: normalIpv6.filter((e) => e.ok).length } },
    websocket,
    expectedVia: TEST_USERS.a,
    processPathsDigest: processPathsDigest(processPaths),
    attribution: attribution ? { verdict: attribution.verdict, processPathsDigest: processPathsDigest(attribution.processPaths ?? []), coverage: attribution.coverage } : null,
  });
  results.push(
    writeResult(dir, {
      key: 'safari_udp_quic_handling',
      command: 'entry',
      at,
      checks: [
        check('VERIFY_ONLY 与 ACTIVE 下 Safari 的 UDP/QUIC 被拒绝且从不直连', udpActive.length === 0 ? null : udpRejected.length === udpActive.length, `${udpRejected.length}/${udpActive.length} 条`),
        check('页面回落 TCP（http/2）', h3Observed === null ? null : h3Observed !== 'http/3', h3Observed ?? '未记录'),
        check('回落的 TCP 经 SFE-ROUTE', h3Tcp.length === 0 ? null : h3Tcp.every((r) => outcomeOf(r.policy) === 'route')),
        check('入口模式测试本身通过读回', modesOk),
      ],
      summary: [`通过条件：${CAPABILITY_CRITERIA.safari_udp_quic_handling}`, ...common],
      context,
      coverage,
      entryStrategy: strategy,
      processPaths: [...processPaths],
    }),
  );
  const rs = restart as RestartInfo | null;
  if (rs) {
    const consistent =
      strategy === 'temp_rule'
        ? rs.ourRulesPresent === null
          ? null
          : rs.ourRulesPresent
            ? rs.readback === 'ACTIVE'
            : rs.readback === 'UNKNOWN'
        : rs.readback === 'ACTIVE' || rs.readback === 'UNKNOWN';
    results.push(
      writeResult(dir, {
        key: 'entry_rules_after_restart',
        command: 'entry',
        at,
        checks: [
          check('Surge 确实重启', rs.startChanged, rs.startChanged === null ? '读不到进程启动时间' : ''),
          check('重启后入口规则去留已记录', rs.readback !== null, `读回 ${rs.readback ?? '读不到'}；本应用临时规则${rs.ourRulesPresent === null ? '无法读取' : rs.ourRulesPresent ? '仍在' : '已消失'}`),
          check('控制器读回与实际去留一致（丢失时为 UNKNOWN）', consistent),
        ],
        summary: [`通过条件：${CAPABILITY_CRITERIA.entry_rules_after_restart}`, ...common, `重启后读回 ${rs.readback ?? '读不到'}，之后回到 NORMAL：${rs.normalAfter ? '成功' : '失败'}`],
        context,
        entryStrategy: strategy,
        processPaths: [...processPaths],
      }),
    );
  }
  dir.writeJson('entry/old-connections-evidence.json', {
    at,
    strategy,
    killResults: obs.killResults,
    killError: obs.killError,
    safariWsClosesAfterBlocked: windows.find((w) => w.mode === 'BLOCKED') ? pageEvents(dir, 'safari', windows.find((w) => w.mode === 'BLOCKED')!.from - SETTLE_MS, seqEnd).filter((e) => e.kind === 'ws_close').length : null,
    chrome,
  });

  out.heading('入口测试结果');
  for (const r of results) printResult(out, r);
  for (const v of window.violations.slice(0, 10)) out.warn(`放行窗口：${new Date(v.at).toISOString()} ${v.protocol} ${v.target} 结果 ${v.outcome}，允许 ${v.allowed.join('/')}`);
  const final = await tryRead(() => controller.read());
  out.line(`当前入口读回：${final?.mode ?? '读不到'}。需要时运行 entry --strategy ${strategy} --to NORMAL；结束后运行 rollback。`);
  return 0;
}
