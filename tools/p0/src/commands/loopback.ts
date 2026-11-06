// loopback：回环节点资源单 key 更新（loopback_resource_update，D10）。
// --setup（需要确认）：测试资源服务先提交只含 A、B 的一代；只把测试配置受管理段中的 SFE-ROUTE 这一行按摘要改写为测试资源地址
// （http://127.0.0.1:<端口>/<读取令牌>/sfe-nodes.list，令牌从不打印），--check 一次并记录测试资源服务是否因此收到请求；由你在
// Surge 中手动重新加载同一配置（工具从不重载），然后有界等待 Surge 登记这项资源。
// --rollback：把这一行改回本地文件引用（LEGACY_NODE_GROUP_LINE），由你手动重新加载，确认回环资源已不在列表中；不要求回环资源曾经
// 登记成功。
// 不带参数：测量。主配置见证——改写测试配置中的配置 canary 行而不重新加载，之后每一次更新都对新旧两个配置 canary 主机各请求一次
// （阴性检查：旧行仍生效、新行没有被加载）；场景矩阵——每一项从有效的 A/B/C（选中 C）开始，切换测试资源服务的场景，只执行一次
// 单 key 更新，按产品读回规则（assessResourceReadback）读回并记录 Surge 的行为，然后恢复 A/B/C（一次更新并读回）；全部结束后
// 由你手动重新加载一次作为阳性对照（新行生效），工具把 canary 行改回原编号再请你加载一次。最后恢复 A/B 并选回 REJECT。
// 退出码 0、success 与 ready=true 都不当作成功；从不 update all，结果不明的更新从不重放，不自动重载兜底。

import { CAPABILITY_CRITERIA, EMPTY_PLACEHOLDER_NODE, LEGACY_NODE_GROUP_LINE, NODE_RESOURCE_FILE, ROUTE_GROUP_NAME } from '@sfe/contract';
import { compareSignals, type ReloadSignals } from '../analysis/reload.js';
import { CALLS_LOG } from '../constants.js';
import { loopbackGroupBlockLines, resourceFile, type ResourceSnapshot, type SurgeExternalResource } from '../deps.js';
import { EXIT, refused, usage, type ExitCode } from '../errors.js';
import { auditMarkOf, paramReplacedC, readAuditRecords, readResourceToken, readServerStatus, requestsBetween, scenarioBody, serverRunning, type ResourceScenario } from '../loopback-state.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { loadState, saveState } from '../state.js';
import { maskResourceKey, resourcesForPath, resourcesForUrl, type CallLogEntry } from '../surge-access.js';
import { TEST_NODES, TEST_PROFILE_FILE, TEST_USERS, profileCanaryIndexOf, replaceRouteLine, routeLineState, testNodeLine } from '../test-profile.js';
import { confirmWrites, loadCredentials, measureContext, openRun, openSession, printResult, printSnapshot, proxyOf, requireServers, takeSnapshot, tryRead, type Ctx } from './common.js';
import { Loopback, discoveryText, errorClass, keyFormText, namesOf, openLoopback, readbackText, validateGenerationLines, type OpenedLoopback, type ReadbackRun } from './loopback-ops.js';
import { changedResources, noRestart, uptimeNote } from './refresh.js';
import { TestOps, probeProfileCanary, requestViaRoute } from './test-ops.js';

/** 手动重新加载之后等 Surge 登记测试资源的上限（2026-10-25 补测：加载之后资源不一定立即出现）。 */
const REGISTRATION_WAIT_MS = 30_000;

export async function runLoopback(ctx: Ctx): Promise<ExitCode> {
  const setup = ctx.args.booleans.setup === true;
  const rollback = ctx.args.booleans.rollback === true;
  if (setup && rollback) throw usage('参数检查失败：--setup 与 --rollback 不能同时使用');
  if (setup) return runSetup(ctx);
  if (rollback) return runRollback(ctx);
  return runMeasure(ctx);
}

// ---------- 接入 ----------

async function runSetup(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt } = ctx.deps;
  const { dir, state } = openRun(ctx);
  const servers = await requireServers(ctx, state);
  const creds = loadCredentials(dir);
  if (!creds) throw refused('前置条件不满足：缺少合成测试凭据，请先运行 test-servers');
  if (!state.testProfilePath || !state.testDirectory) throw refused('前置条件不满足：还没有测试配置，请先运行 make-test-profile');
  const token = readResourceToken(dir);
  const status = readServerStatus(dir);
  if (token === null || !serverRunning(status)) throw refused('前置条件不满足：测试资源服务没有在运行（在另一个终端运行 resource-server）');
  if (state.loopback?.setupAt && state.loopback.port !== status.port) throw refused(`前置条件不满足：测试配置已接入端口 ${state.loopback.port}，资源服务却在端口 ${status.port} 运行`);
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  for (const p of ['listExternalResources', 'getGroupMembers', 'getGroupSelection'] as const) {
    if (session.mechanism[p] === 'unavailable') throw refused(`前置条件不满足：原语 ${p} 没有可用实现`);
  }
  const ops = new TestOps(ctx, dir, session, state);
  const lb = new Loopback(ops, status.port, token);
  lb.requireServer();
  const text = await ops.files.read(TEST_PROFILE_FILE);
  if (text === null) throw refused('前置条件不满足：测试配置不存在');
  const line = routeLineState(text);
  if (line.kind === 'other') throw refused('前置条件不满足：测试配置的 SFE-ROUTE 行不是本工具写入的形式（可能被外部修改）');
  if (line.kind === 'loopback' && line.url !== lb.url) throw refused('前置条件不满足：测试配置已指向另一个测试资源地址（端口或令牌不同）：先运行 loopback --rollback');
  const ports = { echo: servers.echoPort, exit: servers.exitPort, front: servers.frontPort, deadFront: servers.deadFrontPort };
  const ab = [testNodeLine('a', ports, creds.password), testNodeLine('b', ports, creds.password)];

  const snap = await takeSnapshot(ctx, session, dir, 'loopback-setup-before');
  printSnapshot(out, snap);
  const ok = await confirmWrites(
    ctx,
    '接入回环测试资源',
    [
      lb.committed() ? '测试资源服务继续提供已提交的版本' : `测试资源服务提交只含 ${TEST_NODES.a}、${TEST_NODES.b} 的一代（Surge 第一次加载时下载它）`,
      line.kind === 'legacy'
        ? `只把测试配置 ${TEST_PROFILE_FILE} 受管理段中的 SFE-ROUTE 一行改为 policy-path=http://127.0.0.1:${lb.port}/***/sfe-nodes.list（按摘要比较并替换，其他行不动）`
        : '测试配置已指向本运行的测试资源：不改写',
      '你在 Surge 菜单中手动「重新加载配置」（同一配置）一次；工具有界等待 Surge 登记这项资源',
    ],
    [
      `loopback --rollback：把这一行改回 ${LEGACY_NODE_GROUP_LINE}，再手动重新加载一次（不要求回环资源曾经登记成功）`,
      '本命令不添加临时规则，不重载配置，不改变接管、出站模式或当前配置',
    ],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  if (!lb.committed()) await lb.commitInitial(ab);
  const tCheck = now().getTime();
  if (line.kind === 'legacy') {
    await ops.writeTestFile(TEST_PROFILE_FILE, replaceRouteLine(text, loopbackGroupBlockLines(lb.url)[0]!));
    ops.action('loopback_route_line_written', { port: lb.port });
  }
  // --check 一次：记录 surge-cli --check 是否下载远端 policy-path（TODO(P0)；产品的 --check 从不让 Surge 访问资源服务）
  let check: { ok: boolean | null; requests: number } = { ok: null, requests: 0 };
  if (session.mechanism.checkProfile !== 'unavailable' && state.testProfilePath) {
    const c = await tryRead(() => session.adapter.checkProfile(state.testProfilePath!));
    check = { ok: c?.ok ?? null, requests: requestsBetween(dir, tCheck, now().getTime() + 1000, 'server').length };
  }
  const latest = loadState(dir, now());
  saveState(dir, { ...latest, loopback: { port: lb.port, setupAt: now().toISOString(), loadedCanaryIndex: latest.loopback?.loadedCanaryIndex ?? null } });
  ops.state = loadState(dir, now());

  await prompt.pause(`现在在 Surge 菜单中手动「重新加载配置」（当前配置「${TEST_PROFILE_FILE.replace(/\.conf$/, '')}」，同一配置）`);
  const found = await ops.poll(() => lb.discover(), (d) => d.kind === 'found', REGISTRATION_WAIT_MS, 1000);
  const evidence: Record<string, unknown> = { at: now().toISOString(), port: lb.port, check, discovery: found.value?.kind ?? 'unreadable', waitedMs: found.ms };
  if (!found.ok) {
    dir.writeJson(`loopback/setup-${tCheck}.json`, evidence);
    out.warn(`${found.value ? discoveryText(found.value) : '读不到外部资源列表'}（等了 ${Math.round(found.ms / 1000)} 秒）：请确认已重新加载测试配置；不能继续时运行 loopback --rollback 恢复`);
    return EXIT.ERROR;
  }
  const idle = await lb.waitNotUpdating();
  const after = idle.snapshot ?? (await lb.snapshot());
  let keyNote = '';
  try {
    await lb.ensureKey();
    keyNote = keyFormText(lb.keyForm()!);
  } catch (e) {
    keyNote = (e as Error).message;
  }
  // 刚手动重新加载过：磁盘上的配置 canary 编号就是已载入的编号
  const diskIndex = profileCanaryIndexOf((await ops.files.read(TEST_PROFILE_FILE)) ?? '');
  const proxy = proxyOf(ctx);
  const loaded = diskIndex === null ? null : await probeProfileCanary(proxy, servers.echoPort, diskIndex);
  const st = loadState(dir, now());
  saveState(dir, { ...st, loopback: { port: lb.port, setupAt: st.loopback?.setupAt ?? now().toISOString(), loadedCanaryIndex: loaded === true ? diskIndex : null } });
  ops.state = loadState(dir, now());
  const membersOk = sameList(after.members, ['REJECT', TEST_NODES.a, TEST_NODES.b]);
  Object.assign(evidence, { members: after.members, error: errorClass(after.error), membersOk, keyNote, canaryIndexConfirmed: loaded === true });
  dir.writeJson(`loopback/setup-${tCheck}.json`, evidence);
  out.heading('回环测试资源已接入');
  out.line(discoveryText(found.value!));
  out.line(`资源 key：${keyNote}`);
  out.line(`SFE-ROUTE 成员：${after.members?.join('、') ?? '读不到'}；资源错误：${errorClass(after.error)}`);
  out.line(`--check：${check.ok === null ? '未执行' : check.ok ? '通过' : '未通过'}；--check 期间测试资源服务收到 ${check.requests} 个请求`);
  if (!membersOk) out.warn('成员不是 REJECT、A、B：先查明原因（资源服务的请求记录、Surge 的资源错误），必要时 loopback --rollback');
  out.line('下一步：loopback（测量）；整轮结束后 loopback --rollback 并手动重新加载一次。');
  return membersOk ? EXIT.OK : EXIT.ERROR;
}

// ---------- 回退 ----------

async function runRollback(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt } = ctx.deps;
  const { dir, state } = openRun(ctx);
  if (!state.testProfilePath || !state.testDirectory) throw refused('前置条件不满足：还没有测试配置');
  const session = await openSession(ctx, dir, state, { needTestProfile: true });
  const ops = new TestOps(ctx, dir, session, state);
  const text = await ops.files.read(TEST_PROFILE_FILE);
  if (text === null) throw refused('前置条件不满足：测试配置不存在');
  const line = routeLineState(text);
  if (line.kind === 'other') throw refused('回退失败：测试配置的 SFE-ROUTE 行不是本工具写入的形式（可能被外部修改），请手动核对');
  if (line.kind === 'legacy') {
    const latest = loadState(dir, now());
    if (latest.loopback) saveState(dir, { ...latest, loopback: { ...latest.loopback, setupAt: null } });
    out.line('测试配置的 SFE-ROUTE 已是本地文件引用，不需要改写。停止 resource-server 后确认资源端口已空闲。');
    return EXIT.OK;
  }
  const ok = await confirmWrites(
    ctx,
    '撤除回环测试资源',
    [`只把测试配置受管理段中的 SFE-ROUTE 一行改回 ${LEGACY_NODE_GROUP_LINE}（按摘要比较并替换）`, '你在 Surge 菜单中手动「重新加载配置」（同一配置）一次'],
    ['再运行 loopback --setup 可以重新接入（同一运行、同一端口与令牌）'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  await ops.writeTestFile(TEST_PROFILE_FILE, replaceRouteLine(text, LEGACY_NODE_GROUP_LINE));
  ops.action('loopback_route_line_restored');
  const latest = loadState(dir, now());
  if (latest.loopback) saveState(dir, { ...latest, loopback: { ...latest.loopback, setupAt: null } });
  await prompt.pause('现在在 Surge 菜单中手动「重新加载配置」（同一配置）');
  const nodePath = `${state.testDirectory}/${NODE_RESOURCE_FILE}`;
  const gone = await ops.poll(
    () => tryRead(() => session.adapter.listExternalResources()),
    (list: SurgeExternalResource[]) => resourcesForUrl(list, line.url).length === 0 && resourcesForPath(list, nodePath, state.testDirectory!).length === 1,
    REGISTRATION_WAIT_MS,
    1000,
  );
  const diskIndex = profileCanaryIndexOf((await ops.files.read(TEST_PROFILE_FILE)) ?? '');
  const st = loadState(dir, now());
  if (st.loopback) saveState(dir, { ...st, loopback: { ...st.loopback, setupAt: null, loadedCanaryIndex: gone.ok ? diskIndex : null } });
  if (!gone.ok) {
    out.warn('重新加载之后 Surge 仍列出回环测试资源，或没有列出本地节点文件：请确认已重新加载测试配置');
    return EXIT.ERROR;
  }
  out.line('已撤除：Surge 中没有回环地址的资源，SFE-ROUTE 改用本地节点文件。现在可以在 resource-server 终端按 Ctrl+C，并用 lsof -nP -iTCP:<资源端口> -sTCP:LISTEN 确认资源端口已空闲。');
  return EXIT.OK;
}

// ---------- 测量 ----------

/** 矩阵中的一项（resource-server 的场景，另加只有注释头的内容）。 */
type RowId = ResourceScenario | 'headerOnly';
/** 每一项按 2026-10-25 补测与通过条件预期的结果。 */
type RowExpect = 'ok' | 'kept' | 'dropC' | 'dupC' | 'paramC' | 'placeholder';

export const MATRIX: ReadonlyArray<{ id: RowId; expect: RowExpect }> = [
  { id: 'ok', expect: 'ok' },
  { id: 'http401', expect: 'kept' },
  { id: 'http403', expect: 'kept' },
  { id: 'http404', expect: 'kept' },
  { id: 'http500', expect: 'kept' },
  { id: 'http503', expect: 'kept' },
  { id: 'reset', expect: 'kept' },
  { id: 'truncate', expect: 'kept' },
  { id: 'hang', expect: 'kept' },
  { id: 'empty200', expect: 'kept' },
  { id: 'onlyBad', expect: 'kept' },
  { id: 'headerOnly', expect: 'kept' },
  { id: 'stop', expect: 'kept' },
  { id: 'restartUninitialized', expect: 'kept' },
  { id: 'validAbBadC', expect: 'dropC' },
  { id: 'dupC', expect: 'dupC' },
  { id: 'paramReplaceC', expect: 'paramC' },
  { id: 'removeC', expect: 'dropC' },
  { id: 'placeholderOnly', expect: 'placeholder' },
];

export interface RowRecord {
  id: RowId;
  expect: RowExpect;
  ok: boolean | null;
  note: string;
  update: { ok: boolean; code: string | null; outcome: string | null; reason: string | null; ms: number };
  error: string;
  members: string[] | null;
  selectionBefore: string | null;
  selection: string | null;
  updatedAtChanged: boolean | null;
  readback: { ok: boolean; level: string; failed: string[] };
  requests: { total: number; statuses: Array<number | null> };
  chainVia: string | null;
  detailC: { server: string | null; port: number | null; underlyingProxy: string | null } | null;
  restored: boolean | null;
}

function sameList(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

type NodeParams = { server: string | null; port: number | null; underlyingProxy: string | null };

/**
 * 一项的结论（纯函数）：失败的下载必须保留旧资源与旧节点；看似成功的变化必须由读回发现；占位列表被接受；重名由发布前校验拒绝。
 * paramReplaceC 同时改变 C 的服务器、端口与前置：读回必须发现 C 的参数变化，且 getPolicyDetail 读到的三项都等于提供的新值
 * （证明每一项都是新读的，不只是前置）。
 */
export function rowVerdict(input: {
  expect: RowExpect;
  before: ResourceSnapshot;
  run: ReadbackRun;
  chainVia: string | null;
  detailMapped: boolean;
  dupRefused: boolean;
  /** paramReplaceC：读回之后 getPolicyDetail 读到的 C（读不到为 null）与提供的新值。 */
  detailC?: NodeParams | null;
  servedC?: NodeParams | null;
}): { ok: boolean | null; note: string } {
  const { before, run } = input;
  const after = run.after;
  if (run.stillUpdating || after === null) return { ok: null, note: '到时限 Surge 仍在更新：没有读回（结果不明，不重放）' };
  const abc = ['REJECT', TEST_NODES.a, TEST_NODES.b, TEST_NODES.c];
  switch (input.expect) {
    case 'ok':
      return { ok: run.assessment.ok, note: readbackText(run.assessment) };
    case 'kept': {
      const kept = after.error !== null && sameList(after.members, before.members ?? []) && after.selection === before.selection && sameTime(after.updatedAt, before.updatedAt);
      const works = input.chainVia === null ? null : input.chainVia === TEST_USERS.c;
      const ok = !kept ? false : works;
      return { ok, note: `资源错误：${errorClass(after.error)}；${kept ? '保留旧资源（成员、选择与更新时间不变）' : '旧资源没有保留'}；旧节点 C ${works === null ? '没有测' : works ? '仍经前置到达 p0-c' : '不再可用'}` };
    }
    case 'dropC': {
      const dropped = after.error === null && sameList(after.members, ['REJECT', TEST_NODES.a, TEST_NODES.b]);
      const found = run.assessment.failed.includes('members');
      return { ok: found, note: `Surge ${dropped ? '报告成功、错误为空，C 被丢弃' : `成员 ${after.members?.join('、') ?? '读不到'}、错误 ${errorClass(after.error)}`}，选择 ${after.selection ?? '读不到'}；读回${found ? '发现成员不一致' : '没有发现'}` };
    }
    case 'dupC': {
      const firstWins = after.error === null && sameList(after.members, abc);
      return {
        ok: input.dupRefused,
        note: `Surge ${firstWins ? '报告成功，成员不变（同名只取一条）' : `成员 ${after.members?.join('、') ?? '读不到'}、错误 ${errorClass(after.error)}`}；读回只看成员与参数，无法区分只差凭据的重名；发布前严格校验${input.dupRefused ? '拒绝' : '没有拒绝'}这份内容`,
      };
    }
    case 'paramC': {
      if (!input.detailMapped) return { ok: null, note: 'getPolicyDetail 不可用：读回无法核对节点参数（partial）' };
      const found = run.assessment.failed.includes(`detail:${TEST_NODES.c}`);
      const d = input.detailC ?? null;
      const served = input.servedC ?? null;
      const fields = (['server', 'port', 'underlyingProxy'] as const).filter((f) => d !== null && served !== null && d[f] !== served[f]);
      const fresh = d === null || served === null ? null : fields.length === 0;
      const surge = `Surge ${after.error === null ? '报告成功' : `错误 ${errorClass(after.error)}`}，选择 ${after.selection ?? '读不到'}`;
      const readText = `读回${found ? '发现 C 的参数变化' : '没有发现 C 的参数变化'}`;
      const freshText = fresh === null ? '读不到 C 的服务器、端口与前置' : fresh ? '服务器、端口与前置都读到新值' : `${fields.join('、')} 没有读到新值`;
      return { ok: !found ? false : fresh, note: `${surge}；${readText}；${freshText}` };
    }
    case 'placeholder': {
      const accepted = after.error === null && sameList(after.members, ['REJECT', EMPTY_PLACEHOLDER_NODE]);
      return { ok: accepted, note: accepted ? '只含占位行的列表被接受（成员 REJECT、SFE-EMPTY，错误为空）' : `成员 ${after.members?.join('、') ?? '读不到'}、错误 ${errorClass(after.error)}` };
    }
  }
}

interface Witness {
  oldIndex: number | null;
  newIndex: number | null;
  /** 每次更新之后的阴性检查（旧行仍生效且新行没有被加载）；配置 canary 不可用时为 null。 */
  results: Array<boolean | null>;
}

async function runMeasure(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt } = ctx.deps;
  const opened = await openLoopback(ctx, { requireSetup: true });
  const { dir, session, ops, lb, servers, creds, ports, proxy } = opened;
  if (session.mechanism.selectGroupPolicy === 'unavailable') throw refused('前置条件不满足：原语 selectGroupPolicy 没有可用实现');
  await lb.ensureKey();
  const keyForm = lb.keyForm()!;
  const snap = await takeSnapshot(ctx, session, dir, 'loopback-before');
  printSnapshot(out, snap);
  const lines = (keys: ReadonlyArray<'a' | 'b' | 'c'>) => keys.map((k) => testNodeLine(k, ports, creds.password));
  const abc = lines(['a', 'b', 'c']);
  const ok = await confirmWrites(
    ctx,
    '回环节点资源单 key 更新测试',
    [
      '改写测试配置中的配置 canary 行为新编号（不重新加载；之后每次更新都检查它没有被加载）',
      `测试资源服务依次提供 ${MATRIX.length} 种场景（只对测试资源执行单 key 更新，每一项之前与之后都恢复有效的 A/B/C 并经一次更新与读回确认）`,
      '你在 Surge 菜单中手动「重新加载配置」一次（阳性对照）；工具把配置 canary 行改回原编号，再请你加载一次',
      '恢复只含 A、B 的版本（一次更新并读回），SFE-ROUTE 选回 REJECT',
    ],
    ['测试资源服务恢复提供只含 A、B 的版本，一次单 key 更新并读回；SFE-ROUTE 选回 REJECT', '配置 canary 行改回原编号并手动重新加载一次', '本命令不添加临时规则，从不重载配置、从不 update all'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');

  const t0 = now().getTime();
  const autoReload = await tryRead(() => session.adapter.getAutoReloadSetting());
  const resStart = await tryRead(() => session.adapter.listExternalResources());
  const sig0 = await ops.signals(proxy, servers.echoPort, null);
  const rows: RowRecord[] = [];
  const restores: boolean[] = [];
  const witness: Witness = { oldIndex: null, newIndex: null, results: [] };
  let positive: boolean | null = null;
  let placeholderPublish: boolean | null = null;
  const notes: string[] = [];
  const timings: number[] = [];

  /** 每一次更新之后：旧编号仍按 canary 生效、新编号没有被加载。 */
  const probeWitness = async (): Promise<void> => {
    if (witness.oldIndex === null || witness.newIndex === null) {
      witness.results.push(null);
      return;
    }
    const oldVia = await probeProfileCanary(proxy, servers.echoPort, witness.oldIndex);
    const newVia = await probeProfileCanary(proxy, servers.echoPort, witness.newIndex);
    witness.results.push(oldVia === null || newVia === null ? null : oldVia === true && newVia === false);
  };

  /** 恢复有效的 A/B/C（一次更新并读回）并选中 C。 */
  const restoreAbc = async (label: string): Promise<boolean> => {
    const pub = await lb.publishGeneration(abc, { label });
    await probeWitness();
    if (pub.committed) recordTiming(pub);
    restores.push(pub.committed);
    if (!pub.committed) return false;
    if ((await tryRead(() => session.adapter.getGroupSelection(ROUTE_GROUP_NAME))) !== TEST_NODES.c) await ops.select(TEST_NODES.c);
    return true;
  };

  /** 更新时间与本服务记下的完整下载之差（毫秒）：供设定产品的核对容差（TODO(P0)）。 */
  const recordTiming = (pub: ReadbackRun & { generation: number }): void => {
    const u = pub.after?.updatedAt;
    const rec = readAuditRecords(dir).filter((r) => r.generation === pub.generation && r.complete).at(-1);
    if (u && rec) timings.push(rec.at.getTime() - u.getTime());
  };

  try {
    // 1. 主配置见证：找出已载入的配置 canary 编号，再在磁盘上布置新编号（不重新加载）
    const profileText = (await ops.files.read(TEST_PROFILE_FILE)) ?? '';
    const candidates = [ops.state.loopback?.loadedCanaryIndex ?? null, profileCanaryIndexOf(profileText)].filter((n): n is number => n !== null);
    for (const idx of [...new Set(candidates)]) {
      if ((await probeProfileCanary(proxy, servers.echoPort, idx)) === true) {
        witness.oldIndex = idx;
        break;
      }
    }
    if (autoReload === true) notes.push('Surge 自动重载为开：改写主配置本身会触发重载，主配置见证不可用（相关检查为不完整）');
    if (witness.oldIndex !== null && autoReload !== true) {
      const n = nextIndex(now(), witness.oldIndex);
      await ops.armProfileCanary(n);
      witness.newIndex = n;
      await ctx.deps.sleep(1000);
      await probeWitness();
      if (witness.results[0] !== true) {
        notes.push('布置新编号之后配置 canary 已被加载或无法判断（自动重载可能开着）：主配置见证不可用');
        witness.newIndex = null;
      }
    } else if (witness.oldIndex === null) {
      notes.push('找不到已载入的配置 canary 编号：主配置见证不可用（先手动重新加载一次测试配置再测）');
    }

    // 2. 场景矩阵：每一项从有效的 A/B/C（选中 C）开始
    if (!(await restoreAbc('matrix-baseline'))) throw new Error('baseline');
    for (const row of MATRIX) {
      const rec = await runRow(opened, row, abc, probeWitness);
      rows.push(rec);
      out.line(`${row.id}：${rec.ok === true ? '符合' : rec.ok === false ? '不符合' : '未完成'} · ${rec.note}`);
      const restored = await restoreAbc(`matrix-${row.id}-restore`);
      rec.restored = restored;
      if (!restored) {
        notes.push(`${row.id} 之后恢复 A/B/C 没有经读回确认：停止矩阵`);
        break;
      }
    }

    // 3. 产品路径的空版本：没有节点时只提供占位行，经一次更新与读回确认（先选回 REJECT：C 会被删除）
    await ops.select('REJECT');
    const empty = await lb.publishGeneration([], { label: 'placeholder-generation' });
    await probeWitness();
    placeholderPublish = empty.committed;
    notes.push(`没有节点的一代（只有占位行）：${readbackText(empty.assessment)}`);
  } catch (e) {
    if (!(e instanceof Error && e.message === 'baseline')) throw e;
    notes.push('起点（有效的 A/B/C）没有经读回确认：矩阵未运行');
  } finally {
    // 4. 恢复 A、B 并选回 REJECT（失败也执行）
    try {
      await ops.select('REJECT').catch(() => undefined);
      const back = await lb.publishGeneration(lines(['a', 'b']), { label: 'loopback-restore' });
      await probeWitness();
      if (!back.committed) out.warn(`恢复只含 A、B 的版本没有经读回确认（${readbackText(back.assessment)}）：请按回退方式处理`);
    } catch {
      out.warn('恢复测试资源失败：请按回退方式处理');
    }
  }

  // 单 key 更新全部结束（含最后的恢复）：在两次手动重新加载之前读其他外部资源与重启信号——重新加载本身可能刷新或改变其他资源
  // 的错误状态，那不是单 key 更新的影响
  const resEnd = await tryRead(() => session.adapter.listExternalResources());
  const sig1 = await ops.signals(proxy, servers.echoPort, null);
  // 5. 阳性对照：手动重新加载之后新编号生效、旧编号不再生效；再把 canary 行改回原编号并加载一次
  if (witness.oldIndex !== null && witness.newIndex !== null) {
    await prompt.pause('阳性对照：现在在 Surge 菜单中手动「重新加载配置」（同一配置）');
    const newVia = await probeProfileCanary(proxy, servers.echoPort, witness.newIndex);
    const oldVia = await probeProfileCanary(proxy, servers.echoPort, witness.oldIndex);
    positive = newVia === null || oldVia === null ? null : newVia === true && oldVia === false;
    await ops.armProfileCanary(witness.oldIndex);
    await prompt.pause('配置 canary 行已改回原编号：再手动「重新加载配置」一次');
    const back = await probeProfileCanary(proxy, servers.echoPort, witness.oldIndex);
    const st = loadState(dir, now());
    if (st.loopback) saveState(dir, { ...st, loopback: { ...st.loopback, loadedCanaryIndex: back === true ? witness.oldIndex : null } });
    ops.state = loadState(dir, now());
  }

  const key = await lb.ensureKey();
  const others = resStart && resEnd ? changedResources(resStart, resEnd, [key]) : null;
  // 两次手动重新加载之后其他资源的变化只作记录（重新加载的影响），不计入检查
  const resAfterReloads = positive === null ? null : await tryRead(() => session.adapter.listExternalResources());
  const reloadEffects = resEnd && resAfterReloads ? changedResources(resEnd, resAfterReloads, [key]) : null;
  const cmp = compareSignals({ ...sig0, profileCanaryLoaded: null }, { ...sig1, profileCanaryLoaded: null } as ReloadSignals);
  const calls = dir.readJsonl<CallLogEntry>(CALLS_LOG).filter((c) => c.primitive === 'updateExternalResource' && Date.parse(c.at) >= t0);
  const masked = maskResourceKey(key, session.guard.secrets);
  const byExpect = (e: RowExpect, id?: RowId) => rows.filter((r) => r.expect === e && (id === undefined || r.id === id));
  const allOk = (rs: RowRecord[]): boolean | null => (rs.length === 0 ? null : rs.some((r) => r.ok === false) ? false : rs.some((r) => r.ok === null) ? null : true);
  const witnessOk = witness.results.some((r) => r === false) ? false : witness.results.length === 0 || witness.results.some((r) => r === null) ? null : true;
  const resolution = rows.every((r) => r.updatedAtChanged !== true) ? null : timings.length > 0 ? `下载记录与更新时间之差 ${Math.min(...timings)}–${Math.max(...timings)} ms` : null;

  const checks: CheckItem[] = [
    check('SFE-ROUTE 的 policy-path 指向测试资源（127.0.0.1，路径带读取令牌），恰好一个资源', true, `资源 key：${keyFormText(keyForm)}`),
    check('只对测试资源执行单 key 更新（从不 update all）', calls.length > 0 && calls.every((c) => c.args.length === 1 && c.args[0] === masked), `共 ${calls.length} 次更新，全部针对测试资源`),
    check('磁盘上未加载的主配置不被加载（每次更新后的阴性检查）', witnessOk, `${witness.results.filter((r) => r === true).length}/${witness.results.length} 次通过${notes.some((n) => n.includes('主配置见证不可用')) ? '；主配置见证不可用' : ''}`),
    check('显式同配置加载的阳性对照通过', positive, positive === null ? '没有做或无法判断' : positive ? '新编号生效、旧编号不再生效' : '重新加载后新编号没有生效'),
    check('不发生引擎重启或 Surge 重启', noRestart(cmp), uptimeNote(sig0, sig1)),
    check('其他外部资源不变', others === null ? null : others.length === 0, others && others.length > 0 ? `${others.length} 个资源的更新时间或错误状态变化` : ''),
    check('下载失败时保留旧资源、旧节点继续工作', allOk(byExpect('kept')), byExpect('kept').filter((r) => r.ok !== true).map((r) => `${r.id}：${r.note}`).join('；')),
    check('只含占位行 SFE-EMPTY 的列表被接受', allOk(byExpect('placeholder')) === true && placeholderPublish === true ? true : allOk(byExpect('placeholder')) === false || placeholderPublish === false ? false : null, `placeholderOnly：${byExpect('placeholder')[0]?.note ?? '未测'}；产品的空版本：${placeholderPublish === null ? '未测' : placeholderPublish ? '读回一致' : '读回不一致'}`),
    check('坏行被跳过由读回发现（validAbBadC）', allOk(byExpect('dropC', 'validAbBadC')), byExpect('dropC', 'validAbBadC')[0]?.note ?? '未测'),
    check('同名参数替换由读回发现（paramReplaceC）', allOk(byExpect('paramC')), byExpect('paramC')[0]?.note ?? '未测'),
    check('删除选中节点由读回发现（removeC）', allOk(byExpect('dropC', 'removeC')), byExpect('dropC', 'removeC')[0]?.note ?? '未测'),
    check('只差凭据的重名由发布前严格校验拒绝（dupC）', allOk(byExpect('dupC')), byExpect('dupC')[0]?.note ?? '未测'),
    check('有效的新版本经一次更新与读回确认（ok 场景与每次恢复）', restores.length === 0 ? null : restores.every(Boolean) && allOk(byExpect('ok')) === true, `恢复 ${restores.filter(Boolean).length}/${restores.length} 次读回一致`),
  ];
  dir.writeJson(`loopback/update-${t0}.json`, { at: new Date(t0).toISOString(), keyForm, autoReload, witness, positive, rows, restores, placeholderPublish, notes, timings, otherResourcesChanged: others?.length ?? null, reloadEffects: reloadEffects?.length ?? null });
  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'loopback_resource_update',
    command: 'loopback',
    at: now().toISOString(),
    checks,
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.loopback_resource_update}`,
      `测量于测试配置（自动重载 ${autoReload === null ? '读不到' : autoReload ? '开' : '关'}）`,
      `资源 key 的形式：${keyFormText(keyForm)}`,
      ...(resolution ? [`更新时间精度：${resolution}`] : []),
      ...(reloadEffects && reloadEffects.length > 0 ? [`阳性对照的两次手动重新加载之后另有 ${reloadEffects.length} 个外部资源的更新时间或错误状态变化（重新加载的影响，只作记录，不计入“其他外部资源不变”）`] : []),
      ...rows.map((r) => `${r.id}：${r.ok === true ? '符合' : r.ok === false ? '不符合' : '未完成'}（${r.note}；Surge 请求 ${r.requests.total} 次）`),
      ...notes,
    ],
    context,
    ...(autoReload === null ? {} : { declaredAutoReload: autoReload ? ('on' as const) : ('off' as const) }),
  });
  printResult(out, result);
  return 0;
}

function nextIndex(now: Date, previous: number): number {
  const n = Math.floor(now.getTime() / 1000) % 1_000_000;
  return n === previous ? (n + 1) % 1_000_000 : n;
}

/** 矩阵中的一项：切换场景（或暂存只有注释头的一代）→ 一次单 key 更新 → 读回与记录 → 场景回到 ok。 */
async function runRow(opened: OpenedLoopback, row: { id: RowId; expect: RowExpect }, abc: readonly string[], probeWitness: () => Promise<void>): Promise<RowRecord> {
  const { dir, session, lb, servers, proxy, ops } = opened;
  const committed = lb.committed()!;
  const before = await lb.snapshot();
  const mark = auditMarkOf(dir);
  let generation = committed.generation;
  if (row.id === 'headerOnly') {
    generation = (lb.served()?.lastGeneration ?? 0) + 1;
    await lb.setServed(() => ({ candidate: { generation, content: resourceFile(generation, []) } }));
    ops.action('resource_generation_served', { resource: 'loopback', generation, label: 'matrix-headerOnly' });
  } else if (row.id !== 'ok') {
    await lb.setScenario(row.id);
  }
  const t0 = ops.ctx.deps.now().getTime();
  const names = namesOf(abc);
  let run: ReadbackRun;
  try {
    run = await lb.updateAndRead({ label: `matrix-${row.id}`, before, mark, generation, expect: () => ({ names, lines: [...abc] }), detail: { scenario: row.id } });
  } finally {
    await lb.setServed(() => ({ scenario: 'ok', candidate: null }));
  }
  await probeWitness();
  const reqs = requestsBetween(dir, t0 - 1000, ops.ctx.deps.now().getTime(), 'server');
  const detailMapped = session.mechanism.getPolicyDetail !== 'unavailable';
  const d = detailMapped ? await tryRead(() => session.adapter.getPolicyDetail(TEST_NODES.c)) : null;
  // 下载失败的场景：旧节点 C 仍经前置到达出口
  const chainVia = row.expect === 'kept' ? (await requestViaRoute(proxy, servers.echoPort, `loopback-${row.id}`)).via : null;
  const dupRefused = row.expect === 'dupC' ? validateGenerationLines(namesAndLines(scenarioBody('dupC', committed.content))).length > 0 : false;
  const detailC = d ? { server: d.server, port: d.port, underlyingProxy: d.underlyingProxy } : null;
  const servedC = row.expect === 'paramC' ? paramReplacedC(committed.content) : null;
  const v = rowVerdict({ expect: row.expect, before, run, chainVia, detailMapped, dupRefused, detailC, servedC });
  const after = run.after;
  return {
    id: row.id,
    expect: row.expect,
    ok: v.ok,
    note: v.note,
    update: { ok: run.update.ok, code: run.update.code, outcome: run.update.result?.outcome ?? null, reason: run.update.reason, ms: run.update.ms },
    error: errorClass(after?.error ?? null),
    members: after?.members ? [...after.members] : null,
    selectionBefore: before.selection,
    selection: after?.selection ?? null,
    updatedAtChanged: after ? !sameTime(after.updatedAt, before.updatedAt) : null,
    readback: { ok: run.assessment.ok, level: run.assessment.level, failed: [...run.assessment.failed] },
    requests: { total: reqs.length, statuses: reqs.map((r) => r.status) },
    chainVia,
    detailC,
    restored: null,
  };
}

/** 一代内容中的节点行（不含注释与空行）。 */
function namesAndLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}
