// loopback-restart --phase prepare|after-surge-restart|after-mac-restart：回环资源重启后的缓存与恢复
// （loopback_resource_restart，D10）。每种变体一轮：
// - prepare：选定变体（服务先于 Surge 启动、服务晚于 Surge 启动、服务不可用、服务只返回 503、已暂存候选），发布一个已提交版本
//   （A/B/C，选中 C）并读回，记下成员、选择、错误、更新时间、引擎运行时长与进程启动时间，按变体设置测试资源服务，打印下一步；
// - 你在 Surge 菜单中退出并重新打开 Surge（或重启 Mac），按提示启动或不启动 resource-server；
// - after-surge-restart / after-mac-restart：先确认确实重启过，立即读回成员、选择、资源错误、更新时间与是否在更新，以及测试资源
//   服务记下的下载（Surge 启动时是否下载、下载到哪一代）；再让服务提供已提交版本，一次单 key 更新并读回，必须回到已提交版本。
// 每一轮的观察追加到运行目录；结论由全部观察推出（缺少的变体为不完整）。任何变体中 Surge 载入了未提交的版本（含已暂存候选）
// 即不通过。工具从不重载配置、从不 update all，也不用重载补救缓存。

import { CAPABILITY_CRITERIA } from '@sfe/contract';
import { refused, usage, type ExitCode } from '../errors.js';
import { readAuditRecords, readServerStatus, requestsBetween, serverRunning } from '../loopback-state.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { bootTime, surgeStartFingerprint } from '../system.js';
import { TEST_NODES } from '../test-profile.js';
import { resourceFile } from '../deps.js';
import { testNodeLine } from '../test-profile.js';
import { confirmWrites, measureContext, printResult, tryRead, type Ctx } from './common.js';
import { errorClass, openLoopback, readbackText, type OpenedLoopback } from './loopback-ops.js';

export const RESTART_VARIANTS = ['server-before', 'server-after', 'down', '503', 'candidate'] as const;
export type RestartVariant = (typeof RESTART_VARIANTS)[number];
export type RestartKind = 'surge' | 'mac';

const VARIANT_TEXT: Record<RestartVariant, string> = {
  'server-before': '服务先于 Surge 启动',
  'server-after': '服务晚于 Surge 启动',
  down: '服务不可用（不运行）',
  '503': '服务只返回 503（尚未初始化）',
  candidate: '服务正在提供已暂存的候选版本',
};

const PENDING_FILE = 'loopback-restart/pending.json';
const OBSERVATIONS_FILE = 'loopback-restart/observations.json';

interface Pending {
  version: 1;
  variant: RestartVariant;
  preparedAt: string;
  committed: { generation: number; names: string[] };
  candidate: { generation: number; names: string[] } | null;
  baseline: { members: string[] | null; selection: string | null; error: string; updatedAt: string | null; engineStartedAt: string | null; surgeStart: string | null; bootTime: number | null };
}

export interface RestartObservation {
  kind: RestartKind;
  variant: RestartVariant;
  at: string;
  restarted: boolean | null;
  members: string[] | null;
  selection: string | null;
  error: string;
  updatedAtChanged: boolean | null;
  updating: boolean | null;
  /** 重启之后、恢复之前测试资源服务记下的下载（Surge 启动时是否下载、下载到哪一代）。 */
  downloads: { count: number; generations: number[]; statuses: Array<number | null> };
  /** 服务开始提供之后 Surge 自己是否下载（服务晚于 Surge 启动时）。 */
  fetchedAfterServerStart: boolean | null;
  /** 是否载入了未提交的版本：读到候选（或其他未提交）这一代的完整下载，或成员不是已提交版本的子集。 */
  loadedUncommitted: boolean | null;
  recovered: boolean | null;
  note: string;
}

/** 必须观察到的变体（每种重启都要有：服务先于或晚于启动、不可用、只返回 503；Surge 重开要两种先后都有）。 */
export const REQUIRED: ReadonlyArray<{ kind: RestartKind; variants: readonly RestartVariant[]; label: string }> = [
  { kind: 'surge', variants: ['server-before'], label: 'Surge 退出重开 · 服务先于 Surge 启动' },
  { kind: 'surge', variants: ['server-after'], label: 'Surge 退出重开 · 服务晚于 Surge 启动' },
  { kind: 'surge', variants: ['down'], label: 'Surge 退出重开 · 服务不可用' },
  { kind: 'surge', variants: ['503'], label: 'Surge 退出重开 · 服务只返回 503' },
  { kind: 'mac', variants: ['server-before', 'server-after'], label: 'Mac 重启 · 服务先于或晚于 Surge 启动' },
  { kind: 'mac', variants: ['down'], label: 'Mac 重启 · 服务不可用' },
  { kind: 'mac', variants: ['503'], label: 'Mac 重启 · 服务只返回 503' },
];

function observationOk(o: RestartObservation): boolean | null {
  if (o.loadedUncommitted === true || o.recovered === false || o.restarted === false) return false;
  if (o.loadedUncommitted === null || o.recovered === null || o.restarted === null || o.members === null) return null;
  return true;
}

/** 结论（纯函数）：每个必须的变体取最近一次观察；任何观察载入了未提交的版本即不通过。 */
export function restartChecks(observations: readonly RestartObservation[]): CheckItem[] {
  const checks = REQUIRED.map((req) => {
    const obs = observations.filter((o) => o.kind === req.kind && req.variants.includes(o.variant)).at(-1);
    return check(
      `${req.label}：成员、选择、错误、更新时间与是否重新下载已记录，恢复后回到已提交版本`,
      obs ? observationOk(obs) : null,
      obs ? `${VARIANT_TEXT[obs.variant]}：${obs.note}` : '还没有测',
    );
  });
  const loaded = observations.filter((o) => o.loadedUncommitted === true);
  checks.push(
    check(
      '任何情况下都不会载入本服务未提交的版本（含已暂存候选）',
      loaded.length > 0 ? false : observations.length === 0 ? null : observations.some((o) => o.loadedUncommitted === null) ? null : true,
      loaded.length > 0 ? loaded.map((o) => `${o.kind === 'surge' ? 'Surge 重开' : 'Mac 重启'} · ${VARIANT_TEXT[o.variant]}`).join('；') : `${observations.length} 次观察`,
    ),
  );
  return checks;
}

export async function runLoopbackRestart(ctx: Ctx): Promise<ExitCode> {
  const phase = ctx.args.strings.phase;
  if (phase !== 'prepare' && phase !== 'after-surge-restart' && phase !== 'after-mac-restart') throw usage('参数检查失败：--phase 只能是 prepare、after-surge-restart、after-mac-restart');
  if (phase === 'prepare') return prepare(ctx);
  return after(ctx, phase === 'after-mac-restart' ? 'mac' : 'surge');
}

async function prepare(ctx: Ctx): Promise<ExitCode> {
  const { out, now, prompt, exec } = ctx.deps;
  const opened = await openLoopback(ctx, { requireSetup: true });
  const { dir, session, ops, lb, ports, creds } = opened;
  await lb.ensureKey();
  out.line(`变体：${RESTART_VARIANTS.map((v) => `${v}（${VARIANT_TEXT[v]}）`).join('；')}`);
  const answer = (await prompt.ask('这一轮测哪一种变体？')) ?? '';
  if (!(RESTART_VARIANTS as readonly string[]).includes(answer)) throw refused(`前置条件不满足：变体只能是 ${RESTART_VARIANTS.join('、')}`);
  const variant = answer as RestartVariant;
  const ok = await confirmWrites(
    ctx,
    `回环资源重启测试准备（${VARIANT_TEXT[variant]}）`,
    [
      '发布只含 A、B、C 的已提交版本（一次单 key 更新并读回），选中 C',
      variant === 'down' || variant === 'server-after'
        ? '测试资源服务停止监听（进程保持运行；Mac 重启时按提示不启动它）'
        : variant === '503'
          ? '测试资源服务不加载任何内容（令牌正确的请求得到 503）'
          : variant === 'candidate'
            ? '测试资源服务暂存一个只含 A、B 的候选版本（从不经更新与读回提交）'
            : '测试资源服务继续提供已提交版本',
      '然后由你退出并重新打开 Surge（或重启 Mac）',
    ],
    ['运行 --phase after-surge-restart 或 after-mac-restart：服务重新提供已提交版本，一次单 key 更新并读回'],
  );
  if (!ok) throw refused('已取消：没有写入任何东西');
  const abc = (['a', 'b', 'c'] as const).map((k) => testNodeLine(k, ports, creds.password));
  const pub = await lb.publishGeneration(abc, { label: `restart-${variant}` });
  if (!pub.committed) {
    out.warn(`已提交版本没有经读回确认（${readbackText(pub.assessment)}）：先查明原因再测重启`);
    return 1;
  }
  await ops.select(TEST_NODES.c);
  let candidate: Pending['candidate'] = null;
  if (variant === 'down' || variant === 'server-after') await lb.setScenario('stop');
  else if (variant === '503') await lb.setScenario('restartUninitialized');
  else if (variant === 'candidate') {
    const generation = (lb.served()?.lastGeneration ?? 0) + 1;
    const ab = abc.slice(0, 2);
    await lb.setServed(() => ({ candidate: { generation, content: resourceFile(generation, ab) } }));
    ops.action('resource_generation_served', { resource: 'loopback', generation, label: 'restart-candidate', uncommitted: true });
    candidate = { generation, names: [TEST_NODES.a, TEST_NODES.b] };
  }
  const snap = await lb.snapshot();
  const pending: Pending = {
    version: 1,
    variant,
    preparedAt: now().toISOString(),
    committed: { generation: pub.generation, names: [TEST_NODES.a, TEST_NODES.b, TEST_NODES.c] },
    candidate,
    baseline: {
      members: snap.members ? [...snap.members] : null,
      selection: snap.selection,
      error: errorClass(snap.error),
      updatedAt: snap.updatedAt?.toISOString() ?? null,
      engineStartedAt: (await tryRead(() => session.adapter.getRuntimeInfo()))?.startedAt?.toISOString() ?? null,
      surgeStart: await surgeStartFingerprint(exec),
      bootTime: await bootTime(exec),
    },
  };
  dir.writeJson(PENDING_FILE, pending);
  out.heading(`已准备：${VARIANT_TEXT[variant]}`);
  out.line(`已提交第 ${pub.generation} 代（A、B、C），选中 C；成员 ${snap.members?.join('、') ?? '读不到'}。`);
  out.line('Surge 退出重开：在 Surge 菜单中退出 Surge，再重新打开，等接管恢复后运行 loopback-restart --phase after-surge-restart。');
  out.line(
    `Mac 重启：重启 Mac 并登录；${
      variant === 'server-before'
        ? '在 Surge 自动启动之前（或先退出 Surge）运行 resource-server，再打开 Surge'
        : variant === 'server-after'
          ? '等 Surge 启动之后再运行 resource-server'
          : variant === '503'
            ? '运行 resource-server --scenario restartUninitialized'
            : variant === 'down'
              ? '先不要运行 resource-server'
              : '运行 resource-server（重启后它只提供已提交版本：候选不会保留）'
    }；然后运行 loopback-restart --phase after-mac-restart。`,
  );
  return 0;
}

async function after(ctx: Ctx, kind: RestartKind): Promise<ExitCode> {
  const { out, now, prompt, exec } = ctx.deps;
  const opened: OpenedLoopback = await openLoopback(ctx, { requireSetup: true, listening: false });
  const { dir, session, ops, lb } = opened;
  const pending = dir.readJson<Pending>(PENDING_FILE);
  if (!pending || pending.version !== 1 || !(RESTART_VARIANTS as readonly string[]).includes(pending.variant)) throw refused('前置条件不满足：还没有准备好的变体，请先运行 loopback-restart --phase prepare');
  const tPrep = Date.parse(pending.preparedAt);
  // 确认确实重启过（读不到时由操作员亲自确认；不受 --yes 影响）
  const engineStartedAt = (await tryRead(() => session.adapter.getRuntimeInfo()))?.startedAt ?? null;
  const surgeStart = await surgeStartFingerprint(exec);
  const boot = await bootTime(exec);
  // 进程启动时间优先；读不到时用引擎启动时间（运行时长换算，允许 2 秒的取整误差）
  const baselineEngine = pending.baseline.engineStartedAt === null ? null : Date.parse(pending.baseline.engineStartedAt);
  const surgeRestarted =
    surgeStart !== null && pending.baseline.surgeStart !== null
      ? surgeStart !== pending.baseline.surgeStart
      : engineStartedAt !== null && baselineEngine !== null && Number.isFinite(baselineEngine)
        ? engineStartedAt.getTime() - baselineEngine > 2000
        : null;
  const macRestarted = boot !== null && pending.baseline.bootTime !== null ? boot !== pending.baseline.bootTime : null;
  let restarted: boolean | null = kind === 'mac' ? macRestarted : surgeRestarted;
  if (restarted === null) {
    const a = await prompt.ask(kind === 'mac' ? '读不到系统启动时间。确认 Mac 已经重启过请输入 yes：' : '读不到 Surge 的启动时间。确认 Surge 已经退出并重新打开过请输入 yes：');
    restarted = a === 'yes' ? true : null;
  }
  if (restarted === false) throw refused(kind === 'mac' ? '前置条件不满足：系统启动时间没有变化（Mac 没有重启）' : '前置条件不满足：Surge 的启动时间与引擎运行时长都表明它没有重启');

  // 立即读回（恢复之前）
  await lb.ensureKey();
  const first = await lb.snapshot();
  const downloads = requestsBetween(dir, tPrep, now().getTime() + 1000, 'server');
  const records = readAuditRecords(dir).filter((r) => r.at.getTime() >= tPrep);
  const uncommittedRecords = records.filter((r) => r.complete && r.generation !== pending.committed.generation);
  const rest = first.members?.slice(1) ?? null;
  const notSubset = rest === null ? null : !rest.every((n) => pending.committed.names.includes(n));
  const candidateLoaded = pending.candidate !== null && rest !== null && rest.length === pending.candidate.names.length && pending.candidate.names.every((n) => rest.includes(n)) && uncommittedRecords.some((r) => r.generation === pending.candidate!.generation);
  const loadedUncommitted = uncommittedRecords.length > 0 || candidateLoaded ? true : notSubset;

  // 服务（重新）提供已提交版本
  if (!serverRunning(readServerStatus(dir))) {
    await prompt.pause('现在运行 resource-server（同一运行编号），它启动之后按回车');
    if (!serverRunning(readServerStatus(dir))) throw refused('前置条件不满足：测试资源服务没有在运行，无法恢复（读回已记录在运行目录）');
  }
  const tServe = now().getTime();
  await lb.setServed(() => ({ scenario: 'ok', candidate: null }));
  let fetchedAfterServerStart: boolean | null = null;
  if (pending.variant === 'server-after') {
    // 服务晚于 Surge 启动：开始提供之后等一会儿，看 Surge 自己会不会下载
    await ctx.deps.sleep(5000);
    await lb.snapshot();
    fetchedAfterServerStart = requestsBetween(dir, tServe, now().getTime() + 1000, 'server').length > 0;
  }
  const recovery = await lb.confirmCommitted(`restart-${kind}-${pending.variant}-recover`);
  const obs: RestartObservation = {
    kind,
    variant: pending.variant,
    at: now().toISOString(),
    restarted,
    members: first.members ? [...first.members] : null,
    selection: first.selection,
    error: errorClass(first.error),
    updatedAtChanged: first.updatedAt === null && pending.baseline.updatedAt === null ? false : (first.updatedAt?.toISOString() ?? null) !== pending.baseline.updatedAt,
    updating: first.updating,
    downloads: { count: downloads.length, generations: [...new Set(downloads.map((d) => d.generation).filter((g): g is number => g !== null))], statuses: downloads.map((d) => d.status) },
    fetchedAfterServerStart,
    loadedUncommitted,
    recovered: recovery.assessment.ok,
    note: '',
  };
  obs.note = [
    `重启后成员 ${obs.members?.join('、') ?? '读不到'}、选择 ${obs.selection ?? '读不到'}、错误 ${obs.error}、更新时间${obs.updatedAtChanged ? '变了' : '没变'}`,
    `重启后测试资源服务收到 ${obs.downloads.count} 个请求${obs.downloads.generations.length > 0 ? `（第 ${obs.downloads.generations.join('、')} 代）` : ''}`,
    ...(fetchedAfterServerStart === null ? [] : [`服务开始提供之后 Surge ${fetchedAfterServerStart ? '自己下载了' : '没有自己下载'}`]),
    loadedUncommitted ? '载入了未提交的版本' : loadedUncommitted === false ? '没有载入未提交的版本' : '无法判断是否载入了未提交的版本',
    `恢复：${readbackText(recovery.assessment)}`,
  ].join('；');
  const observations = [...(dir.readJson<RestartObservation[]>(OBSERVATIONS_FILE) ?? []), obs];
  dir.writeJson(OBSERVATIONS_FILE, observations);
  dir.writeJson(PENDING_FILE, { ...pending, version: 0, consumedAt: now().toISOString() });
  out.heading(`${kind === 'mac' ? 'Mac 重启' : 'Surge 退出重开'} · ${VARIANT_TEXT[pending.variant]}`);
  out.line(obs.note);

  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: 'loopback_resource_restart',
    command: 'loopback-restart',
    at: now().toISOString(),
    checks: restartChecks(observations),
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.loopback_resource_restart}`,
      ...observations.map((o) => `${o.kind === 'mac' ? 'Mac 重启' : 'Surge 退出重开'} · ${VARIANT_TEXT[o.variant]}（${o.at}）：${o.note}`),
    ],
    context,
  });
  printResult(out, result);
  const missing = REQUIRED.filter((r) => !observations.some((o) => o.kind === r.kind && r.variants.includes(o.variant)));
  if (missing.length > 0) out.line(`还要测：${missing.map((m) => m.label).join('；')}（每种先运行 --phase prepare）`);
  return 0;
}
