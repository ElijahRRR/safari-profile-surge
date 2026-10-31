// loopback-restart --phase prepare|after-surge-restart|after-mac-restart：回环资源重启后的缓存与恢复
// （loopback_resource_restart，D10）。每种变体一轮：
// - prepare：选定变体（服务先于 Surge 启动、服务晚于 Surge 启动、服务不可用、服务只返回 503、已暂存候选），发布一个已提交版本
//   （A/B/C，选中 C）并读回，记下成员、选择、错误、更新时间、引擎运行时长、进程启动时间与该能力依赖的验证上下文，按变体设置
//   测试资源服务，打印下一步；
// - 你在 Surge 菜单中退出并重新打开 Surge（或重启 Mac），按提示启动或不启动 resource-server；
// - after-surge-restart / after-mac-restart：先确认确实重启过（读不到启动时间时由操作员确认，记为操作员确认），测得重启之后的
//   上下文，立即读回成员、选择、资源错误、更新时间与是否在更新，以及测试资源服务记下的下载（Surge 启动时是否下载、下载到
//   哪一代）；Mac 重启的变体按运行目录核对（服务是否运行、启动先后、系统启动之后收到的请求）；Surge 不再更新时记下缓存不存在
//   时下载失败是否可见（产品下载核对中“未就绪”例外的前提，classifyEmptyCache）；再让服务提供已提交版本，一次单 key 更新并
//   读回，必须回到已提交版本。
// 每一轮的观察追加到运行目录（可能相隔数天）；结论只由上下文与当前一致、准备与观察之间上下文没有变化（例如重启时装上了
// Surge 或 macOS 更新）且变体核对相符的观察推出，其余列为需重测（缺少的变体为不完整）。任何观察中 Surge 载入了未提交的版本
// 即不通过。工具从不重载配置、从不 update all，也不用重载补救缓存。

import { CAPABILITY_CONTEXT_DEPS, CAPABILITY_CRITERIA, type CapabilityContext, type CapabilityContextField } from '@sfe/contract';
import { contextDrift } from '../context.js';
import { EXIT, refused, usage, type ExitCode } from '../errors.js';
import { readAuditRecords, readServerStatus, requestsBetween, serverRunning, type ResourceScenario } from '../loopback-state.js';
import { check, writeResult, type CheckItem } from '../results.js';
import { bootTime, surgeStartFingerprint, surgeStartedAtMs } from '../system.js';
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

const KEY = 'loopback_resource_restart' as const;

interface Pending {
  /** 2：带验证上下文（之前的格式没有上下文，after 拒绝并要求重新 prepare）。 */
  version: 2;
  variant: RestartVariant;
  preparedAt: string;
  committed: { generation: number; names: string[] };
  candidate: { generation: number; names: string[] } | null;
  /** 准备时（重启之前）测得的验证上下文。 */
  context: CapabilityContext;
  baseline: { members: string[] | null; selection: string | null; error: string; updatedAt: string | null; engineStartedAt: string | null; surgeStart: string | null; bootTime: number | null };
}

/** 怎样确认确实重启过：Surge 进程启动时间、引擎运行时长、系统启动时间，或读不到时由操作员确认。 */
export type RestartEvidence = 'process_start' | 'engine_uptime' | 'boot_time' | 'operator';

const EVIDENCE_TEXT: Record<RestartEvidence, string> = {
  process_start: '按 Surge 进程启动时间确认重启',
  engine_uptime: '按引擎运行时长确认重启',
  boot_time: '按系统启动时间确认重启',
  operator: '重启由操作员确认（读不到启动时间）',
};

export interface RestartObservation {
  kind: RestartKind;
  variant: RestartVariant;
  at: string;
  restarted: boolean | null;
  /** 确认重启的依据（旧记录没有）。 */
  restartEvidence?: RestartEvidence | null;
  /** 重启之后测得的验证上下文（旧记录没有：不计入结论）。 */
  context?: CapabilityContext | null;
  /** 准备（重启之前）与观察（重启之后）之间该能力依赖的上下文字段的变化：非空即这次观察跨了两个版本，不计入结论。 */
  contextChanged?: CapabilityContextField[];
  /** 变体核对（Mac 重启按运行目录核对；Surge 退出重开由工具设置场景）：false 不计入；null 无法核对（操作员陈述）。 */
  variantCheck?: { ok: boolean | null; note: string };
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
  /** 重启之后（Surge 不再更新时）缓存不存在时下载失败是否可见（classifyEmptyCache；旧记录没有，按 unknown）。 */
  emptyCache?: EmptyCacheError;
  recovered: boolean | null;
  note: string;
}

/**
 * 重启之后（Surge 不再更新时）资源的缓存与错误：核对产品下载核对中“未就绪”例外的前提（service/src/resource/audit.ts
 * errorExplained：没有更新时间、只报告 not_ready 的资源错误按尚未完成过下载解释，启动审计不按占用处理）。
 * - cached：有更新时间（缓存保留或已重新下载），例外不适用；
 * - visible：没有更新时间，资源错误是可见的失败文字（占用者的 404、超时等仍会被下载核对发现）；
 * - hidden：没有更新时间、只报告 not_ready，而测试资源服务在重启之后答复过失败（非 200 或不答复）的下载——Surge 把下载失败
 *   藏在未就绪之后，例外会让启动审计发现不了占用端口的一方：不通过；
 * - unknown：其余（只报告 not_ready 而重启之后没有失败的下载、读不到或仍在更新）。
 */
export type EmptyCacheError = 'cached' | 'visible' | 'hidden' | 'unknown';

export function classifyEmptyCache(
  snap: { updatedAt: Date | null; error: string | null; updating: boolean | null } | null,
  failedDownloadsSinceRestart: number,
): EmptyCacheError {
  if (snap === null || snap.updating !== false || snap.error === 'unreadable') return 'unknown';
  if (snap.updatedAt !== null) return 'cached';
  if (snap.error === 'not_ready') return failedDownloadsSinceRestart > 0 ? 'hidden' : 'unknown';
  return snap.error === null ? 'unknown' : 'visible';
}

const EMPTY_CACHE_TEXT: Record<EmptyCacheError, string> = {
  cached: '缓存保留或已重新下载',
  visible: '缓存不存在，下载失败可见',
  hidden: '缓存不存在，只报告未就绪而本服务答复过失败的下载（下载错误被隐藏）',
  unknown: '缓存不存在时下载失败是否可见无法判断',
};

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

/** 该能力依赖的上下文字段在两次测量之间的变化（逐字段比较；两次都读不到算没有变化，读不到由 contextDrift 另行排除）。 */
export function changedContextFields(before: CapabilityContext, after: CapabilityContext): CapabilityContextField[] {
  return CAPABILITY_CONTEXT_DEPS[KEY].filter((f) => (before[f] ?? null) !== (after[f] ?? null));
}

/**
 * 观察是否计入结论（纯函数）：记录了上下文、准备与观察之间上下文没有变化、与当前上下文一致（contextDrift 为空：同一 Surge
 * 版本与构建、macOS 构建与工作配置身份，版本读不到也不一致），且变体核对不是“不符”。不计入时给出原因。
 */
export function restartComparability(o: RestartObservation, current: CapabilityContext): { counted: boolean; reason: string | null } {
  if (!o.context) return { counted: false, reason: '没有记录验证上下文（旧格式），需重测' };
  if ((o.contextChanged ?? []).length > 0) return { counted: false, reason: `重启前后上下文不同（${o.contextChanged!.join('、')}：重启时装上了更新），需重测` };
  const drift = contextDrift(KEY, o.context, current);
  if (drift.length > 0) return { counted: false, reason: `上下文与当前不同或读不到（${drift.join('、')}），需重测` };
  if (o.variantCheck?.ok === false) return { counted: false, reason: `变体与实际不符（${o.variantCheck.note}），没有计入` };
  return { counted: true, reason: null };
}

function observationOk(o: RestartObservation): boolean | null {
  if (o.loadedUncommitted === true || o.recovered === false || o.restarted === false) return false;
  if (o.loadedUncommitted === null || o.recovered === null || o.restarted === null || o.members === null) return null;
  return true;
}

function observationLabel(o: RestartObservation): string {
  return `${o.kind === 'surge' ? 'Surge 重开' : 'Mac 重启'} · ${VARIANT_TEXT[o.variant]}`;
}

/** 观察的说明，操作员确认的重启与无法核对的变体在前面标出。 */
function observationNote(o: RestartObservation): string {
  const marks = [
    ...(o.restartEvidence === 'operator' ? ['重启由操作员确认'] : []),
    ...(o.variantCheck?.ok === null ? [`变体由操作员陈述（${o.variantCheck.note}）`] : []),
  ];
  return `${marks.length > 0 ? `【${marks.join('；')}】` : ''}${o.note}`;
}

/**
 * 结论（纯函数）：只用计入的观察（restartComparability），每个必须的变体取其中最近一次；不计入的观察列为需重测。任何观察
 * （包括不计入的）载入了未提交的版本即不通过。“含已暂存候选”只在计入的观察中有一次 Surge 退出重开的 candidate 变体时才写进
 * 检查项名称（候选是可选变体：没有测时只能说明已测的几种情况）。
 */
export function restartChecks(observations: readonly RestartObservation[], current: CapabilityContext): CheckItem[] {
  const judged = observations.map((o) => ({ o, ...restartComparability(o, current) }));
  const counted = judged.filter((j) => j.counted).map((j) => j.o);
  const checks = REQUIRED.map((req) => {
    const matches = (o: RestartObservation): boolean => o.kind === req.kind && req.variants.includes(o.variant);
    const obs = counted.filter(matches).at(-1);
    const skipped = judged.filter((j) => !j.counted && matches(j.o));
    return check(
      `${req.label}：成员、选择、错误、更新时间与是否重新下载已记录，恢复后回到已提交版本`,
      obs ? observationOk(obs) : null,
      obs
        ? `${VARIANT_TEXT[obs.variant]}：${observationNote(obs)}`
        : skipped.length > 0
          ? `还没有可计入的观察：${skipped.map((j) => `${VARIANT_TEXT[j.o.variant]}（${j.o.at}）${j.reason}`).join('；')}`
          : '还没有测',
    );
  });
  const loaded = observations.filter((o) => o.loadedUncommitted === true);
  const candidateMeasured = counted.some((o) => o.kind === 'surge' && o.variant === 'candidate');
  const notCounted = judged.filter((j) => !j.counted).length;
  checks.push(
    check(
      candidateMeasured ? '任何情况下都不会载入本服务未提交的版本（含已暂存候选）' : '任何情况下都不会载入本服务未提交的版本',
      loaded.length > 0 ? false : counted.length === 0 ? null : counted.some((o) => o.loadedUncommitted === null) ? null : true,
      loaded.length > 0
        ? loaded.map((o) => `${observationLabel(o)}${counted.includes(o) ? '' : '（不计入的观察：上下文不同或变体不符，仍按不通过）'}`).join('；')
        : [
            `${counted.length} 次可计入的观察`,
            ...(candidateMeasured ? [] : ['已暂存候选（可选）未测']),
            ...(notCounted > 0 ? [`${notCounted} 次没有计入（上下文不同或变体不符，需重测）`] : []),
          ].join('；'),
    ),
  );
  // 下载核对中“未就绪”例外的前提：任何观察（包括不计入的）看到下载错误被藏在未就绪之后即不通过；计入的观察中看到过缓存不存在时
  // 失败可见、或缓存从来都保留（例外在重开时不适用）才通过；其余无法判断（不完整）
  const hidden = observations.filter((o) => o.emptyCache === 'hidden');
  const visible = counted.filter((o) => o.emptyCache === 'visible');
  const allCached = counted.length > 0 && counted.every((o) => o.emptyCache === 'cached');
  checks.push(
    check(
      '重开后缓存不存在时，本服务答复失败的下载在资源错误中可见（下载核对中“未就绪”例外的前提）',
      hidden.length > 0 ? false : visible.length > 0 || allCached ? true : null,
      hidden.length > 0
        ? `Surge 把下载错误藏在未就绪之后：${hidden.map((o) => `${observationLabel(o)}${counted.includes(o) ? '' : '（不计入的观察，仍按不通过）'}`).join('；')}；下载核对的“未就绪”例外无法发现占用端口的一方`
        : visible.length > 0
          ? `缓存不存在时下载失败可见：${visible.map(observationLabel).join('；')}`
          : allCached
            ? `${counted.length} 次可计入的观察中缓存都保留或已重新下载（例外在重开时不适用）`
            : counted.length === 0
              ? '还没有可计入的观察'
              : '缓存不存在时还没有看到本服务答复失败的下载（只返回 503 的变体），无法判断',
    ),
  );
  return checks;
}

/** Mac 重启变体的核对所需的事实（纯函数的输入）。 */
export interface VariantFacts {
  kind: RestartKind;
  variant: RestartVariant;
  /**
   * 重启之后、恢复之前测试资源服务答复的状态码（不答复为 null）；Mac 重启读不到系统启动时间时为 null（重启之前与之后的请求
   * 无法区分，依赖它的核对记为无法核对）。
   */
  statuses: ReadonlyArray<number | null> | null;
  /** after 开始时测试资源服务的状态（没有在运行为 null）。 */
  server: { startedAt: number; scenario: ResourceScenario | null } | null;
  /** 重启之后 Surge 主程序的启动时间（毫秒，ps 只到秒）；读不到时用引擎启动时间；都读不到为 null。 */
  surgeStartedAt: number | null;
}

/** ps lstart 只到秒：在这一秒之内的先后无法判断。 */
const START_RESOLUTION_MS = 1000;

/**
 * 变体是否与运行目录记下的事实相符（纯函数）。Surge 退出重开由工具设置测试资源服务的场景（stop、restartUninitialized、候选），
 * 总是相符；Mac 重启时资源服务由操作员手动启动，按以下核对：
 * - down：服务没有在运行，重启之后没有收到任何请求；
 * - 503：服务以 restartUninitialized 运行，且重启之后收到的请求全部是 503（重启之前的 503 不算：那时运行的服务不能说明重启
 *   之后的情况）；
 * - server-before：服务在运行，且启动早于 Surge；server-after：服务没有在运行（由工具提示之后启动），或启动晚于 Surge；
 *   读不到 Surge 的启动时间或相差不到一秒时为 null（先后由操作员陈述）；
 * - candidate：Mac 重启后候选不保留，不核对。
 */
export function checkRestartVariant(f: VariantFacts): { ok: boolean | null; note: string } {
  if (f.kind === 'surge') return { ok: true, note: '测试资源服务的场景由工具设置' };
  const non503 = f.statuses === null ? 0 : f.statuses.filter((s) => s !== 503).length;
  const unbounded = '读不到系统启动时间，重启之前与之后的请求无法区分';
  switch (f.variant) {
    case 'down':
      if (f.server !== null) return { ok: false, note: '重启后测试资源服务在运行（变体要求不运行）' };
      if (f.statuses === null) return { ok: null, note: `重启后服务没有运行；${unbounded}` };
      if (f.statuses.length > 0) return { ok: false, note: `重启后测试资源服务收到 ${f.statuses.length} 个请求（变体要求不运行）` };
      return { ok: true, note: '重启后服务没有运行，没有收到请求' };
    case '503':
      if (non503 > 0) return { ok: false, note: `重启后测试资源服务有 ${non503} 个请求不是 503（变体要求只返回 503）` };
      if (f.server === null) return { ok: false, note: '重启后服务没有运行（变体要求以 --scenario restartUninitialized 运行）' };
      if (f.server.scenario !== 'restartUninitialized') return { ok: false, note: `服务的场景是 ${f.server.scenario ?? '—'}（变体要求 restartUninitialized）` };
      if (f.statuses === null) return { ok: null, note: `服务以 restartUninitialized 运行；${unbounded}` };
      return { ok: true, note: f.statuses.length > 0 ? `服务以 restartUninitialized 运行，重启后的 ${f.statuses.length} 个请求都是 503` : '服务以 restartUninitialized 运行' };
    case 'server-before':
      if (f.server === null) return { ok: false, note: '重启后服务没有在运行（变体要求先于 Surge 启动）' };
      if (f.surgeStartedAt === null) return { ok: null, note: '读不到 Surge 的启动时间，先后无法核对' };
      if (f.server.startedAt < f.surgeStartedAt) return { ok: true, note: '服务的启动早于 Surge' };
      if (f.server.startedAt >= f.surgeStartedAt + START_RESOLUTION_MS) return { ok: false, note: '服务的启动晚于 Surge（变体要求先于 Surge 启动）' };
      return { ok: null, note: '服务与 Surge 在同一秒内启动，先后无法核对' };
    case 'server-after':
      if (f.server === null) return { ok: true, note: '服务在工具提示之后才启动' };
      if (f.surgeStartedAt === null) return { ok: null, note: '读不到 Surge 的启动时间，先后无法核对' };
      if (f.server.startedAt >= f.surgeStartedAt + START_RESOLUTION_MS) return { ok: true, note: '服务的启动晚于 Surge' };
      if (f.server.startedAt < f.surgeStartedAt) return { ok: false, note: '服务的启动早于 Surge（变体要求晚于 Surge 启动）' };
      return { ok: null, note: '服务与 Surge 在同一秒内启动，先后无法核对' };
    case 'candidate':
      return { ok: true, note: 'Mac 重启后候选不保留，不核对先后' };
  }
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
  // 重启之前的验证上下文：after 用它判断重启时是否装上了 Surge 或 macOS 更新（跨两个版本的观察不计入）
  const context = await measureContext(ctx, session, ops.state);
  const pending: Pending = {
    version: 2,
    variant,
    preparedAt: now().toISOString(),
    committed: { generation: pub.generation, names: [TEST_NODES.a, TEST_NODES.b, TEST_NODES.c] },
    candidate,
    context,
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
  if ((pending as { version?: unknown } | null)?.version === 1) throw refused('前置条件不满足：准备记录是旧格式（没有记录验证上下文），请重新运行 loopback-restart --phase prepare');
  if (!pending || pending.version !== 2 || !pending.context || !(RESTART_VARIANTS as readonly string[]).includes(pending.variant)) throw refused('前置条件不满足：还没有准备好的变体，请先运行 loopback-restart --phase prepare');
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
  let restartEvidence: RestartEvidence | null =
    restarted === null ? null : kind === 'mac' ? 'boot_time' : surgeStart !== null && pending.baseline.surgeStart !== null ? 'process_start' : 'engine_uptime';
  if (restarted === null) {
    const a = await prompt.ask(kind === 'mac' ? '读不到系统启动时间。确认 Mac 已经重启过请输入 yes：' : '读不到 Surge 的启动时间。确认 Surge 已经退出并重新打开过请输入 yes：');
    restarted = a === 'yes' ? true : null;
    if (restarted) {
      restartEvidence = 'operator';
      ops.action('operator_confirmed_restart', { kind, variant: pending.variant });
    }
  }
  if (restarted === false) throw refused(kind === 'mac' ? '前置条件不满足：系统启动时间没有变化（Mac 没有重启）' : '前置条件不满足：Surge 的启动时间与引擎运行时长都表明它没有重启');

  // 重启之后的验证上下文：与准备时不同（重启时装上了 Surge 或 macOS 更新）的观察照样记录，但不计入结论
  const afterContext = await measureContext(ctx, session, ops.state);
  const contextChanged = changedContextFields(pending.context, afterContext);
  if (contextChanged.length > 0) out.warn(`重启前后验证上下文不同（${contextChanged.join('、')}）：这次观察照样记录，但不计入结论；在新的版本上重新 prepare 再测`);

  // 立即读回（恢复之前）
  await lb.ensureKey();
  const first = await lb.snapshot();
  const surgeStartedAt = (await surgeStartedAtMs(exec)) ?? engineStartedAt?.getTime() ?? null;
  // 重启的时刻（Mac 重启按系统启动时间，Surge 退出重开按 Surge 的启动时间）：之前的请求（例如准备之后、重启之前 Surge 的定时
  // 刷新）不算重启之后的下载；读不到时从准备开始算
  const restartAt = kind === 'mac' ? (boot !== null ? boot * 1000 : null) : surgeStartedAt;
  const since = Math.max(tPrep, restartAt ?? tPrep);
  const downloads = requestsBetween(dir, since, now().getTime() + 1000, 'server');
  const records = readAuditRecords(dir).filter((r) => r.at.getTime() >= tPrep);
  const uncommittedRecords = records.filter((r) => r.complete && r.generation !== pending.committed.generation);
  const rest = first.members?.slice(1) ?? null;
  const notSubset = rest === null ? null : !rest.every((n) => pending.committed.names.includes(n));
  const candidateLoaded = pending.candidate !== null && rest !== null && rest.length === pending.candidate.names.length && pending.candidate.names.every((n) => rest.includes(n)) && uncommittedRecords.some((r) => r.generation === pending.candidate!.generation);
  const loadedUncommitted = uncommittedRecords.length > 0 || candidateLoaded ? true : notSubset;

  // 变体核对（Mac 重启时资源服务由操作员手动启动）：服务是否在运行、启动先后与收到的请求，在工具提示启动服务之前读
  const serverAtStart = readServerStatus(dir);
  const serverStartedAt = serverRunning(serverAtStart) ? Date.parse(serverAtStart.startedAt) : NaN;
  // Mac 重启之前写下的状态文件没有 stoppedAt，它的进程号重启后可能属于别的进程：启动早于系统启动时间的按没有运行
  const staleAfterBoot = kind === 'mac' && boot !== null && Number.isFinite(serverStartedAt) && serverStartedAt < boot * 1000;
  const variantCheck = checkRestartVariant({
    kind,
    variant: pending.variant,
    statuses: kind === 'mac' && boot === null ? null : downloads.map((d) => d.status),
    server: serverRunning(serverAtStart) && Number.isFinite(serverStartedAt) && !staleAfterBoot ? { startedAt: serverStartedAt, scenario: serverAtStart.scenario } : null,
    surgeStartedAt,
  });
  if (variantCheck.ok === false) out.warn(`变体与实际不符：${variantCheck.note}。这次观察照样记录，但不计入结论；按提示重新 prepare 再测`);

  // 下载核对中“未就绪”例外的前提：Surge 不再更新时（有界等待）再读一次，按重启之后测试资源服务答复的失败下载分类（恢复之前）
  const settled = first.updating === true ? (await lb.waitNotUpdating()).snapshot : first;
  const failedSinceRestart = requestsBetween(dir, since, now().getTime() + 1000, 'server').filter((d) => d.status !== 200).length;
  const emptyCache = classifyEmptyCache(settled, failedSinceRestart);
  if (emptyCache === 'hidden') out.warn(`Surge 把下载错误藏在未就绪之后（${EMPTY_CACHE_TEXT.hidden}）：产品下载核对的“未就绪”例外的前提不成立，这一项不通过`);

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
    restartEvidence,
    context: afterContext,
    contextChanged,
    variantCheck,
    members: first.members ? [...first.members] : null,
    selection: first.selection,
    error: errorClass(first.error),
    updatedAtChanged: first.updatedAt === null && pending.baseline.updatedAt === null ? false : (first.updatedAt?.toISOString() ?? null) !== pending.baseline.updatedAt,
    updating: first.updating,
    downloads: { count: downloads.length, generations: [...new Set(downloads.map((d) => d.generation).filter((g): g is number => g !== null))], statuses: downloads.map((d) => d.status) },
    fetchedAfterServerStart,
    loadedUncommitted,
    emptyCache,
    recovered: recovery.assessment.ok,
    note: '',
  };
  obs.note = [
    ...(restartEvidence === null ? ['没有确认重启'] : [EVIDENCE_TEXT[restartEvidence]]),
    ...(kind === 'mac' ? [`变体核对：${variantCheck.ok === true ? '相符' : variantCheck.ok === false ? '不符' : '无法核对'}（${variantCheck.note}）`] : []),
    ...(contextChanged.length > 0 ? [`重启前后上下文不同（${contextChanged.join('、')}）`] : []),
    `重启后成员 ${obs.members?.join('、') ?? '读不到'}、选择 ${obs.selection ?? '读不到'}、错误 ${obs.error}、更新时间${obs.updatedAtChanged ? '变了' : '没变'}`,
    `重启后测试资源服务收到 ${obs.downloads.count} 个请求${obs.downloads.generations.length > 0 ? `（第 ${obs.downloads.generations.join('、')} 代）` : ''}`,
    ...(fetchedAfterServerStart === null ? [] : [`服务开始提供之后 Surge ${fetchedAfterServerStart ? '自己下载了' : '没有自己下载'}`]),
    loadedUncommitted ? '载入了未提交的版本' : loadedUncommitted === false ? '没有载入未提交的版本' : '无法判断是否载入了未提交的版本',
    EMPTY_CACHE_TEXT[emptyCache],
    `恢复：${readbackText(recovery.assessment)}`,
  ].join('；');
  const observations = [...(dir.readJson<RestartObservation[]>(OBSERVATIONS_FILE) ?? []), obs];
  dir.writeJson(OBSERVATIONS_FILE, observations);
  dir.writeJson(PENDING_FILE, { ...pending, version: 0, consumedAt: now().toISOString() });
  out.heading(`${kind === 'mac' ? 'Mac 重启' : 'Surge 退出重开'} · ${VARIANT_TEXT[pending.variant]}`);
  out.line(obs.note);

  // 结论按现在的上下文：只有上下文一致的观察计入（可能相隔数天的各轮之间装上了更新时，旧的观察列为需重测）
  const context = await measureContext(ctx, session, ops.state);
  const result = writeResult(dir, {
    key: KEY,
    command: 'loopback-restart',
    at: now().toISOString(),
    checks: restartChecks(observations, context),
    summary: [
      `通过条件：${CAPABILITY_CRITERIA.loopback_resource_restart}`,
      ...observations.map((o) => {
        const c = restartComparability(o, context);
        return `${o.kind === 'mac' ? 'Mac 重启' : 'Surge 退出重开'} · ${VARIANT_TEXT[o.variant]}（${o.at}）${c.counted ? '' : `【不计入：${c.reason}】`}：${observationNote(o)}`;
      }),
    ],
    context,
  });
  printResult(out, result);
  const counted = observations.filter((o) => restartComparability(o, context).counted);
  const missing = REQUIRED.filter((r) => !counted.some((o) => o.kind === r.kind && r.variants.includes(o.variant)));
  if (missing.length > 0) out.line(`还要测：${missing.map((m) => m.label).join('；')}（每种先运行 --phase prepare）`);
  return variantCheck.ok === false ? EXIT.ERROR : EXIT.OK;
}
