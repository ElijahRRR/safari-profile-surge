// inventory（只读）：系统与 Safari 版本、运行中 Surge 实例的版本（与服务同一读取器，证据见 inventory/surge-instance.json；
// 磁盘上 Surge.app 的版本只作旁证）及其与 `surge-cli --raw version` 的交叉核对（证据见 inventory/surge-version.json；
// 最低支持 6.10.0（12500）、Controller 协议 22）、CLI 签名与帮助（顶层 --help 加上 CLI_HELP_TOPICS 的逐条
// `help <command>`，取词的并集）、各读原语经 CLI/HTTP 是否可用、外部资源、当前配置名、临时规则、接管与出站、
// 自动重载、Safari/WebKit 进程候选、配置目录是否在同步位置。
// 写入 inventory.json，打印表格与建议的 adapterMechanism。盘点从不调用任何写原语（写入守卫全部拒绝）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CAPABILITY_CRITERIA, type TakeoverState } from '@sfe/contract';
import { CALLS_LOG } from '../constants.js';
import {
  detectManagedConfigHeader,
  findForeignSfeObjects,
  listRelativeReferences,
  listRemoteSourceHosts,
  parseHttpApiLine,
  SURGE_MINIMUM,
  SURGE_VERSION_CHECK_FAILURE_TEXT,
  serviceInstanceResult,
  serviceLimitsExceeded,
  type SurgeAdapter,
  type SurgeVersionCheck,
} from '../deps.js';
import { refused, type ExitCode } from '../errors.js';
import { check, writeResult } from '../results.js';
import { classifyLocationRisk, findGitWorkTree } from '../run-dir.js';
import { saveState, type InventorySummary } from '../state.js';
import {
  ACTIVE_PRIMITIVES,
  CLI_HELP_TOPICS,
  HTTP_NOT_IMPLEMENTED,
  READ_PRIMITIVES,
  allMechanism,
  classifyTopicHelp,
  cliAvailability,
  createGuardedAdapter,
  createP0Adapter,
  describeLocation,
  emptyGuard,
  errorCode,
  helpTopicFile,
  parseCliHelp,
  proposeMechanism,
  unionHelpWords,
  type CliAvailability,
  type HelpTopicStatus,
  type Primitive,
  type ProbeOutcome,
  type ReadPrimitive,
} from '../surge-access.js';
import { SAFARI_APP, SURGE_APP, appVersion, listProcesses, restartPending, surgeProcesses, swVers, webkitSafariCandidates } from '../system.js';
import { TEST_PROFILE_NAME } from '../test-profile.js';
import { createRun, crossCheckVersion, fmtBool, measureContext, openRun, printResult, profileNameOf, readSurgeInstance, resolveCli, tryRead, type Ctx } from './common.js';
import { instanceEvidence, instanceSummaryText, printInstanceReport, warnOnDiskDifference, warnServiceLimits } from './instance.js';

const HELP_LINE_RE = /temp|rule|resource|policy|polic|request|dump|version|check|select|kill|profile|group|test|status|feature|mode|match|performance/i;

const HELP_TOPIC_STATUS_TEXT: Record<HelpTopicStatus, string> = { ok: '已读取', interactive: '进入交互模式（不采用）', unsupported: 'Unknown command（不采用）', failed: '失败或没有输出（不采用）' };

/** 版本交叉核对的一行说明（与服务同一规则）。 */
export function versionCheckText(check: SurgeVersionCheck | null): string {
  if (check === null) return '运行实例不可读，未核对';
  if (!check.ok) return `未通过：${SURGE_VERSION_CHECK_FAILURE_TEXT[check.reason]}`;
  return `通过：${check.version}（${check.build}）· Controller 协议 ${check.controllerProtocol} · Core ${check.coreVersion}`;
}

interface ProbeContext {
  group: string | null;
  policy: string | null;
  profilePath: string | null;
}

async function probe(adapter: SurgeAdapter, p: ReadPrimitive, c: ProbeContext): Promise<{ outcome: ProbeOutcome; value: unknown }> {
  const call = async (): Promise<unknown> => {
    switch (p) {
      case 'getGroupMembers':
        return adapter.getGroupMembers(c.group!);
      case 'getGroupSelection':
        return adapter.getGroupSelection(c.group!);
      case 'getPolicyDetail':
        return adapter.getPolicyDetail(c.policy!);
      case 'checkProfile':
        return adapter.checkProfile(c.profilePath!);
      case 'matchRule':
        // 只读求值（“without creating a connection”）：合成的主机与进程，只证明命令与输出可以解析；入口的运行时读回另行证明。
        return adapter.matchRule({ host: 'p0-inventory.invalid', processPath: '/usr/bin/true' });
      default:
        return (adapter[p] as () => Promise<unknown>)();
    }
  };
  if ((p === 'getGroupMembers' || p === 'getGroupSelection') && !c.group) return { outcome: { status: 'skipped', code: null }, value: null };
  if (p === 'getPolicyDetail' && !c.policy) return { outcome: { status: 'skipped', code: null }, value: null };
  if (p === 'checkProfile' && !c.profilePath) return { outcome: { status: 'skipped', code: null }, value: null };
  try {
    return { outcome: { status: 'ok', code: null }, value: await call() };
  } catch (e) {
    const code = errorCode(e);
    return { outcome: { status: code === 'CAPABILITY_UNVERIFIED' ? 'not_implemented' : 'error', code }, value: null };
  }
}

/** 盘点结果中只保留识别所需的信息（不保存策略详情原文、规则全文与请求主机）。 */
function summarizeValue(p: ReadPrimitive, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (p) {
    case 'listRules':
    case 'listActiveRequests':
    case 'listRecentRequests':
      return { count: Array.isArray(v) ? v.length : null };
    case 'listPolicies': {
      const x = v as { proxies: string[]; groups: string[] };
      return { proxies: x.proxies.length, groups: x.groups.length };
    }
    case 'getPolicyDetail': {
      const d = v as { type: string | null; underlyingProxy: string | null };
      return { type: d.type, hasUnderlyingProxy: d.underlyingProxy !== null };
    }
    case 'listExternalResources':
      return (v as Array<{ key: string; type: string; location: string; lastUpdatedAt: Date | null; error: string | null }>).map((r) => ({
        key: r.key,
        type: r.type,
        location: describeLocation(r.location),
        lastUpdatedAtAvailable: r.lastUpdatedAt !== null,
        error: r.error !== null,
      }));
    case 'checkProfile':
      return { ok: (v as { ok: boolean }).ok };
    case 'matchRule':
      return { hasRule: typeof (v as { rule?: unknown }).rule === 'string', hasPolicy: typeof (v as { policy?: unknown }).policy === 'string' };
    default:
      return v;
  }
}

function candidateProfileDirs(home: string): string[] {
  return [join(home, 'Library', 'Application Support', 'Surge', 'Profiles'), join(home, 'Library', 'Mobile Documents', 'iCloud~com~nssurge~inc', 'Documents')];
}

export async function runInventory(ctx: Ctx): Promise<ExitCode> {
  const { out, exec, now, home } = ctx.deps;
  const { dir, state: initial } = ctx.args.strings.run ? openRun(ctx) : createRun(ctx);
  let state = initial;
  out.heading(`P0 盘点（只读） · 运行 ${dir.id}`);
  out.line(`原始证据目录：${dir.path}（0700，文件 0600，不在仓库内）`);

  // 补充版本与待重启状态与服务同一规则（能力上下文的 macosVersionExtra、macosRestartPending）
  const macos = { ...(await swVers(exec)), restartPending: await restartPending(ctx.deps.pathPresence) };
  const safari = await appVersion(exec, SAFARI_APP);
  const surgeApp = await appVersion(exec, SURGE_APP);
  // Surge 版本只来自运行中的实例（与服务同一读取器）；磁盘上的 Surge.app 版本只作旁证，两者不一致时提示。
  const instance = await readSurgeInstance(ctx);
  // 服务按它的时限（codesign 15 秒、引擎总时限 8 秒）得到的结论：读不到时版本按未知记入盘点
  const svc = serviceInstanceResult(instance);
  dir.writeJson('inventory/surge-instance.json', instanceEvidence(now().toISOString(), instance, surgeApp));
  const procs = await listProcesses(exec);
  const webkit = webkitSafariCandidates(procs);
  dir.writeJson('inventory/processes.json', { at: now().toISOString(), webkitSafariCandidates: webkit, surge: surgeProcesses(procs) });

  // CLI：签名校验通过才执行；帮助原文存运行目录。顶层帮助若进入交互模式，命令词按空处理（不读逐条帮助，不探测任何
  // CLI 原语）。否则再逐条读取 `help <command>`（6.9.0 起顶层帮助只列命令组），可用的输出与顶层帮助取词的并集。
  const cli = await resolveCli(ctx, state);
  let words = new Set<string>();
  let helpInteractive = false;
  const helpTopics: Record<string, HelpTopicStatus> = {};
  if (cli.ok) {
    const r = await exec(cli.path, ['--help'], { timeoutMs: 15_000 });
    const help = `${r.stdout}\n${r.stderr}`;
    dir.writeAtomic('inventory/surge-cli-help.txt', help);
    ({ words, interactive: helpInteractive } = parseCliHelp(help));
    const texts: string[] = [help];
    if (helpInteractive) {
      out.warn('surge-cli --help 进入了交互模式：帮助中的命令按空处理，本次不读取逐条帮助、不经 CLI 探测任何原语（原文见 inventory/surge-cli-help.txt）');
    } else {
      for (const topic of CLI_HELP_TOPICS) {
        const t = await exec(cli.path, ['help', ...topic], { timeoutMs: 15_000 });
        const status = classifyTopicHelp(t);
        helpTopics[topic.join(' ')] = status;
        dir.writeAtomic(`inventory/surge-cli-help/${helpTopicFile(topic)}`, `${t.stdout}\n${t.stderr}`);
        if (status === 'ok') texts.push(t.stdout);
      }
      words = unionHelpWords(texts);
      const skipped = Object.entries(helpTopics).filter(([, v]) => v !== 'ok');
      if (skipped.length > 0) out.warn(`以下命令帮助不可用，其中的词没有采用：${skipped.map(([k, v]) => `help ${k}（${HELP_TOPIC_STATUS_TEXT[v]}）`).join('、')}`);
    }
    const relevant = [...new Set(texts.flatMap((t) => t.split(/\r?\n/)).filter((l) => HELP_LINE_RE.test(l)))].slice(0, 120);
    dir.writeAtomic('inventory/surge-cli-help-relevant.txt', `${relevant.join('\n')}\n`);
  }

  // 当前配置文件（只读）。
  const profilePath = ctx.args.strings.profile ?? state.sourceProfilePath;
  let profileInfo: Record<string, unknown> | null = null;
  let httpApi: { key: string; port: number } | null = null;
  let httpApiInfo = { configured: false, loopbackOnly: null as boolean | null };
  if (profilePath) {
    if (!isAbsolute(profilePath) || !existsSync(profilePath) || !statSync(profilePath).isFile()) throw refused('盘点失败：--profile 必须是存在的配置文件绝对路径');
    const text = readFileSync(profilePath, 'utf8');
    const api = parseHttpApiLine(text);
    httpApiInfo = { configured: api !== null, loopbackOnly: api?.loopbackOnly ?? null };
    if (api?.loopbackOnly) httpApi = { key: api.key, port: api.port };
    const profileDir = dirname(profilePath);
    let sfeFiles: string[] = [];
    try {
      sfeFiles = readdirSync(profileDir).filter((n) => /^sfe-/i.test(n));
    } catch {
      /* 目录不可读 */
    }
    profileInfo = {
      name: profileNameOf(profilePath),
      directoryRisk: ((r) => (r === 'unknown' ? null : r))(classifyLocationRisk(profileDir, home)),
      inGitWorkTree: findGitWorkTree(profileDir) !== null,
      managedConfigHeader: detectManagedConfigHeader(text) !== null,
      sfeObjects: findForeignSfeObjects(text, { names: [], files: [] }).length,
      sfeFilesInDirectory: sfeFiles,
      relativeReferences: listRelativeReferences(text).map((r) => ({ kind: r.kind, file: r.value.slice(r.value.lastIndexOf('/') + 1) })),
      remoteSourceHosts: listRemoteSourceHosts(text),
      httpApi: httpApiInfo,
    };
    dir.writeJson('inventory/profile-structure.json', profileInfo);
    // 切换到测试配置后重新盘点（更新原语映射）时，不把测试配置记成“原配置”。
    if (profileNameOf(profilePath) !== TEST_PROFILE_NAME) state = { ...state, sourceProfilePath: profilePath, sourceProfileName: profileNameOf(profilePath) };
  } else {
    const names: Record<string, string[]> = {};
    for (const d of candidateProfileDirs(home)) {
      try {
        names[d] = readdirSync(d).filter((n) => n.endsWith('.conf'));
      } catch {
        /* 不存在 */
      }
    }
    dir.writeJson('inventory/profile-candidates.json', names);
  }

  // 读原语逐个探测：CLI 只执行帮助中出现的命令；HTTP 只在 http-api 绑定回环时使用。
  const log = (e: unknown): void => dir.appendJsonl(CALLS_LOG, e);
  const cliAdapter = cli.ok ? createGuardedAdapter(createP0Adapter({ cliPath: cli.path, httpApi: null, mechanism: allMechanism('cli') }), emptyGuard(), log, now) : null;
  const httpAdapter = httpApi ? createGuardedAdapter(createP0Adapter({ cliPath: null, httpApi, mechanism: allMechanism('http') }), emptyGuard(), log, now) : null;
  const cliHelp: Partial<Record<Primitive, CliAvailability>> = {};
  for (const p of [...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES]) cliHelp[p] = cliAvailability(p, words);

  const cliProbes: Partial<Record<Primitive, ProbeOutcome>> = {};
  const httpProbes: Partial<Record<Primitive, ProbeOutcome>> = {};
  const values: Record<string, unknown> = {};
  const pc: ProbeContext = { group: null, policy: null, profilePath: profilePath ?? null };
  // listPolicies 先测，为组与策略详情提供参数。
  const order: ReadPrimitive[] = ['listPolicies', ...READ_PRIMITIVES.filter((p) => p !== 'listPolicies')];
  for (const p of order) {
    if (!cliAdapter) cliProbes[p] = { status: 'unavailable', code: null };
    else if (cliHelp[p] !== 'in_help') cliProbes[p] = { status: cliHelp[p] === 'not_in_table' ? 'not_in_table' : 'not_in_help', code: null };
    else {
      const r = await probe(cliAdapter, p, pc);
      cliProbes[p] = r.outcome;
      if (r.outcome.status === 'ok') values[p] = r.value;
    }
    if (!httpAdapter) httpProbes[p] = { status: 'unavailable', code: null };
    else if (HTTP_NOT_IMPLEMENTED.includes(p)) httpProbes[p] = { status: 'not_implemented', code: null };
    else {
      const r = await probe(httpAdapter, p, pc);
      httpProbes[p] = r.outcome;
      if (r.outcome.status === 'ok' && values[p] === undefined) values[p] = r.value;
    }
    if (p === 'listPolicies' && values.listPolicies) {
      const pol = values.listPolicies as { proxies: string[]; groups: string[] };
      pc.group = pol.groups[0] ?? null;
      pc.policy = pol.proxies[0] ?? null;
    }
  }
  const httpUsable = httpProbes.getCurrentProfile?.status === 'ok' || httpProbes.listPolicies?.status === 'ok';
  const proposal = proposeMechanism(cliProbes, httpProbes, cliHelp, httpUsable);
  // 运行实例与 `surge-cli --raw version` 的交叉核对（只读；帮助中没有 version 时不执行，按读不到处理）。
  const versionCheck = await crossCheckVersion(cliAdapter && cliHelp.getVersion === 'in_help' ? { adapter: cliAdapter } : null, instance);
  dir.writeJson('inventory/surge-version.json', {
    at: now().toISOString(),
    minimum: SURGE_MINIMUM,
    instance: svc.ok ? { version: svc.instance.version, build: svc.instance.build } : null,
    cli: values.getVersion ?? null,
    check: versionCheck,
  });

  const takeover = (values.getTakeoverState as TakeoverState | undefined) ?? null;
  const currentProfile = (values.getCurrentProfile as { name: string } | undefined)?.name ?? null;
  const summary: InventorySummary = {
    at: now().toISOString(),
    macos,
    safari,
    surgeApp,
    surgeVersion: svc.ok ? { version: svc.instance.version, build: svc.instance.build } : { version: null, build: null },
    surgeInstance: { ok: svc.ok, reason: svc.ok ? null : svc.reason },
    surgeVersionCheck:
      versionCheck === null
        ? null
        : versionCheck.ok
          ? { ok: true, reason: null, controllerProtocol: versionCheck.controllerProtocol, coreVersion: versionCheck.coreVersion }
          : { ok: false, reason: versionCheck.reason, controllerProtocol: null, coreVersion: null },
    cliVerified: { ok: cli.ok, reason: cli.reason },
    httpApi: httpApiInfo,
    currentProfileName: currentProfile,
    profileDirectoryRisk: (profileInfo?.directoryRisk as InventorySummary['profileDirectoryRisk']) ?? null,
    autoReload: (values.getAutoReloadSetting as boolean | undefined) ?? null,
    takeover: takeover ? { enhancedMode: takeover.enhancedMode, systemProxy: takeover.systemProxy, outboundMode: takeover.outboundMode } : null,
    webkitSafariProcesses: webkit,
  };
  const inventory = {
    runId: dir.id,
    summary,
    profile: profileInfo,
    cliHelp,
    cliHelpInteractive: helpInteractive,
    cliHelpTopics: helpTopics,
    surgeInstance: { ok: svc.ok, reason: svc.ok ? null : svc.reason, cached: instance.cached, serviceLimitsExceeded: serviceLimitsExceeded(instance), evidence: 'inventory/surge-instance.json' },
    probes: { cli: cliProbes, http: httpProbes },
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, summarizeValue(k as ReadPrimitive, v)])),
    proposedMechanism: proposal.mechanism,
    mechanismNotes: proposal.notes,
    unproven: proposal.unproven,
  };
  dir.writeJson('inventory.json', inventory);
  state = { ...state, surgeCliPath: cli.path, mechanism: proposal.mechanism, inventory: summary };
  saveState(dir, state);

  out.heading('系统与版本');
  out.table([
    ['项目', '结果'],
    ['macOS', `${macos.productVersion ?? '读不到'}（${macos.buildVersion ?? '读不到'}）`],
    ['后台安全改进（sw_vers -productVersionExtra）', macos.productVersionExtra === 'none' ? '未安装' : (macos.productVersionExtra ?? '读不到')],
    [
      '后台安全改进待重启',
      macos.restartPending === 'yes' ? '是：重启 Mac 之前不要测进程归属' : macos.restartPending === 'no' ? '否' : '无法确认（进程归属的结论会记为不完整）',
    ],
    ['Safari', `${safari.version ?? '读不到'}（${safari.build ?? '读不到'}）`],
    ['运行中的 Surge', instanceSummaryText(instance)],
    ['版本交叉核对（surge-cli --raw version）', versionCheckText(versionCheck)],
    ['Surge.app（磁盘，旁证）', `${surgeApp.version ?? '读不到'}（${surgeApp.build ?? '读不到'}）`],
    [
      'Surge CLI',
      cli.ok
        ? `签名校验通过（${cli.reason}）${helpInteractive ? '；--help 进入交互模式，命令按空处理' : `；逐条帮助 ${Object.values(helpTopics).filter((v) => v === 'ok').length}/${CLI_HELP_TOPICS.length} 条可用`}`
        : `不可用（${cli.reason}）`,
    ],
    ['http-api', httpApiInfo.configured ? (httpApiInfo.loopbackOnly ? '已配置，只监听回环' : '已配置，绑定非回环地址（不使用）') : profilePath ? '未配置' : '未提供 --profile'],
    ['当前配置', currentProfile ?? '读不到'],
    ['配置目录', profileInfo ? (profileInfo.directoryRisk === null ? '无法确认真实位置' : String(profileInfo.directoryRisk)) : '未提供 --profile'],
    ['自动重载设置', summary.autoReload === null ? '读不到（需在 Surge 设置中查看并在 refresh 中声明）' : summary.autoReload ? '开' : '关'],
    ['接管', takeover ? `增强模式 ${fmtBool(takeover.enhancedMode)}，系统代理 ${fmtBool(takeover.systemProxy)}，出站 ${takeover.outboundMode ?? '读不到'}` : '读不到'],
    ['临时规则', Array.isArray(values.listTempRules) ? `${(values.listTempRules as unknown[]).length} 条` : '读不到'],
    ['外部资源', Array.isArray(values.listExternalResources) ? `${(values.listExternalResources as unknown[]).length} 个` : '读不到'],
  ]);
  warnOnDiskDifference(out, instance, surgeApp);
  warnServiceLimits(out, instance);
  if (!instance.result.ok) {
    out.warn('无法确认运行中 Surge 的版本：能力上下文中的版本与构建号为空，依赖 Surge 版本的能力不能提议。逐条检查见下表与 inventory/surge-instance.json');
  } else if (versionCheck !== null && !versionCheck.ok) {
    out.warn(`版本交叉核对未通过（${SURGE_VERSION_CHECK_FAILURE_TEXT[versionCheck.reason]}）：能力上下文中的版本与构建号为空，依赖 Surge 版本的能力不能提议；证据见 inventory/surge-version.json`);
  }
  if (profileInfo) {
    const sfe = profileInfo.sfeFilesInDirectory as string[];
    if (sfe.length > 0) out.warn(`配置目录中已有 ${sfe.length} 个 sfe-* 文件（可能已初始化过）：make-test-profile 需要用 --target-dir 指定单独目录`);
    if (profileInfo.directoryRisk === null) out.warn('无法确认配置目录的真实位置：按不安全处理，正式产品不会在此写入，测试配置也不会写入');
    else if (profileInfo.directoryRisk !== 'none') out.warn('配置目录位于同步或受保护位置：正式产品不会在此写入，测试配置也不会写入');
    if (profileInfo.managedConfigHeader) out.warn('源配置带 #!MANAGED-CONFIG 远端托管头');
  } else {
    out.warn('没有提供 --profile：http-api 与配置结构未检查。请在 Surge「配置」中「在访达中显示」找到当前配置文件路径后重新运行');
  }

  out.heading('运行中的 Surge（版本来源）');
  printInstanceReport(out, instance);

  out.heading('Safari / WebKit 进程候选（只是候选，归属以 attribution 实测为准）');
  for (const p of webkit) out.line(`  ${p}`);
  if (webkit.length === 0) out.line('  （没有找到；先打开 Safari 再运行）');

  out.heading('原语可用性');
  out.table([
    ['原语', 'CLI', 'HTTP', '建议'],
    ...[...READ_PRIMITIVES, ...ACTIVE_PRIMITIVES].map((p) => [
      p,
      (cliProbes[p]?.status ?? cliHelp[p] ?? '-') + (cliProbes[p]?.code ? `(${cliProbes[p]!.code})` : ''),
      (httpProbes[p]?.status ?? (HTTP_NOT_IMPLEMENTED.includes(p) ? 'not_implemented' : httpUsable ? 'write_untested' : 'unavailable')) + (httpProbes[p]?.code ? `(${httpProbes[p]!.code})` : ''),
      proposal.mechanism[p],
    ]),
  ]);
  out.heading('建议的 adapterMechanism（写入 install.json 前先完成各测试命令；未证明的主动原语不能当作已通过）');
  out.json(proposal.mechanism);
  if (proposal.unproven.length > 0) out.line(`待证明的主动原语：${proposal.unproven.join('、')}`);
  if (proposal.mechanism.listTempRules !== 'unavailable') out.line(`listTempRules：${proposal.notes.listTempRules}`);

  // takeover_state_readable：按建议的固定映射只读获取三项（与服务运行时同一来源）。
  const fixedAdapter = createGuardedAdapter(createP0Adapter({ cliPath: cli.ok ? cli.path : null, httpApi, mechanism: proposal.mechanism }), emptyGuard(), log, now);
  const fixedSource = { adapter: fixedAdapter, mechanism: proposal.mechanism };
  const context = await measureContext(ctx, fixedSource, state, { instance });
  const fixedTakeover = await tryRead(() => fixedAdapter.getTakeoverState());
  const fixed = proposal.mechanism.getTakeoverState !== 'unavailable';
  const takeoverResult = writeResult(dir, {
    key: 'takeover_state_readable',
    command: 'inventory',
    at: now().toISOString(),
    checks: [
      check('getTakeoverState 有固定实现', fixed, fixed ? `经 ${proposal.mechanism.getTakeoverState}` : '没有可用实现'),
      check('增强模式可读', fixedTakeover !== null && fixedTakeover.enhancedMode !== null),
      check('系统代理可读', fixedTakeover !== null && fixedTakeover.systemProxy !== null),
      check('出站模式可读', fixedTakeover !== null && fixedTakeover.outboundMode !== null),
    ],
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.takeover_state_readable}`,
      `增强模式 ${fmtBool(fixedTakeover?.enhancedMode)}，系统代理 ${fmtBool(fixedTakeover?.systemProxy)}，出站模式 ${fixedTakeover?.outboundMode ?? '读不到'}`,
    ],
    context,
  });
  state = { ...state, lastContext: context };
  saveState(dir, state);
  out.heading('接管与出站模式读取');
  printResult(out, takeoverResult);
  out.heading('下一步');
  if (state.testProfilePath) {
    out.line('已按测试配置更新原语映射；继续 attribution。');
  } else {
    out.line('1. 在另一个终端运行 test-servers 并保持运行。');
    out.line('2. 运行 make-test-profile 生成测试配置，然后在 Surge 中手动切换到「SFE-P0-测试」。');
    out.line('3. 切换后运行 inventory --run <运行编号> --profile <测试配置路径>，按测试配置（含回环 http-api）更新原语映射。');
  }
  out.line(`运行编号：${dir.id}（之后的命令默认使用最近一次运行）`);
  return 0;
}
