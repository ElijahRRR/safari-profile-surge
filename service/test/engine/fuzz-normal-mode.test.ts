// 普通模式与买家出口的随机状态机测试（种子确定；docs/ARCHITECTURE.md §5.5、§6.3–§6.5）。只用合成数据。
//
// 每个种子生成约 20–40 个与状态无关的事件（环境创建与关联、激活与旧窗口确认、实测通过/失败/超时、取消、普通模式、
// killRequest 失败一次、rule match 不可用、文件监视延迟、故障消除、外部清空临时规则、Surge 重启、用户启用排在本应用入口之前的
// 模块规则（module：DOMAIN-SUFFIX → DIRECT，故障消除时移除）、Safari 与 Chrome 的长连接、
// 进程路径变化、服务崩溃（空闲时或某次 Surge 调用中）与恢复、对账、时钟推进……），在两种入口策略上回放。生成器另有偏置（激活、
// 实测、取消、重测之前常常安排 normalDuring / crash）与两个宏（retiredChain：被换掉的进程路径；focusChain：在干净的前提下走到
// 激活写入阻断之前、切换中、核对实测、回滚、重测），使下面「覆盖」中的危险状态经常出现（各事件仍独立，缩减时可以分别去掉）。
// 每个事件之后（执行器空闲时）检查不变量；I5 另在引擎的每次 Surge 调用前后与每个新的 Safari 请求时检查（切换中的放行窗口）。
//
//   I1 Safari 连接可能在买家出口上（策略 SFE-ROUTE 或叶节点 SFE-*）时，服务视图提供普通模式（除非该出口正是使用中已验证的路由）。
//   I2 路由由一次 NORMAL_RESTORED 的普通模式决定、且没有 buyer_exit_connections_unconfirmed / entry_unverified 时，没有 Safari
//      连接在 SFE-ROUTE 上。
//   I3 从不结束 Chrome（非 Safari）连接；入口按 FakeSurge 求值不阻断该进程时，从不结束不在买家出口上的 Safari 连接。
//   （I3、I6 的“入口是否阻断/放行”不含排在本应用入口之前、能证明与受保护主机——站点与检测主机——不相交的用户规则匹配的请求：
//   module 事件中 daily 主机的规则。§5.5 的优先级检查按设计忽略这类规则，入口状态的声明不覆盖它们；站点与检测主机的规则照常检查。）
//   I4 enterNormalMode 从不被拒绝（网页、已关联与未关联场景）：NEEDS_CONFIRMATION 按要求确认后重试（最多 3 次，并发的操作可能
//      在两次请求之间改变使用中的环境），其余任何拒绝（含 ROUTE_BUSY）都是违例，没有例外——空闲时，以及切换、核对实测、回滚、
//      重测或另一次普通模式进行中（normalDuring 事件），不论服务视图当时是否提供普通模式；从不重载配置。
//   I5 没有放行窗口：Safari 新请求经 SFE-ROUTE 时，出口要么在 SFE-ROUTE 换成它之后通过了真实的 Safari 实测，要么是检测主机
//      TCP，且该出口正在实测，或刚停止实测（本期到过 VERIFY_ONLY）而还有路由操作排队或执行中，或 Surge 尚未加载已写入的收紧内容
//      而还有路由操作排队、执行中或等待中——没有路由操作在进行中之后检测主机仍经未验证的出口发出即为违例（例如回滚按等满上限
//      视为已阻断，SFE-ROUTE 仍是未验证的出口）。重新选择同一节点不改变出口；换成以前实测过的节点（例如回滚恢复之前的买家
//      出口）要重新实测。Chrome 从不命中本应用入口或 SFE-ROUTE。
//      I5b：ACTIVE_VERIFIED（非复用）只在本测试提交过真实通过的实测之后出现（提交已受理即算：之后服务在核对中崩溃时，崩溃恢复
//      按提交的结果重新核对）。
//   I6 路由视图（未带 entry_unverified、外部改动之后已重新读取事实时）声称 NORMAL/BLOCKED（以及 VERIFY_ONLY/ACTIVE 中被拒绝
//      的部分）与 FakeSurge 求值一致；完成说明「Safari 按 Surge 原规则发出请求」「Safari 保持阻断」（回滚完成）与「Safari 保持已确认
//      的阻断」（回滚无法确认 → BLOCKED_NEEDS_ATTENTION，路由仍是它留下的状态时）属实；扩展的路由摘要与同一
//      响应中的完整路由一致，并与原生调用返回时（结算之前）的服务视图一致——结算会执行调用期间受理的操作（例如在动作前检查的
//      Surge 调用中受理的普通模式），它们的写入不在这个响应中。调用期间有执行器中的操作在运行（调用 Surge 或写路由记录）时
//      响应可能早于它们的写入，比较不成立时只计数（覆盖项 popupRaceSkipped），不判违例；弹窗中的 I1 同样。
//   L1 每个受理的普通模式（含 normalDuring 排队受理的）在执行器空闲后都已结束（不停在 queued/running/waiting）；受理时与检查时
//      文件监视延迟都短时，结束为 NORMAL_RESTORED（进入普通模式永远可用）。唯一的例外是文件监视比等待上限慢（latency 事件）。
//      L1b：最后受理的路由操作（激活、普通模式、重测，或带路由参数的发布）是一次已 NORMAL_RESTORED 的普通模式时，路由记录仍是
//      空闲的 NORMAL——受理更早的操作（例如崩溃恢复中的切换）不得在它之后重新写入入口（旧请求的结果覆盖新请求）。
//
// crash 与 normalDuring 只对下一个事件生效：在其第 nth 次 Surge 调用（文件监视见证的轮询不计，它取决于真实时间）时服务崩溃 /
// 用户点「进入普通模式」，下一个事件可以是任何事件（激活、实测、取消、重测、普通模式、弹窗……）。when 为 any（缺省）时数下一个
// 事件中的全部调用；否则只数执行器当前操作处于该状态时的调用：early（激活写入阻断之前）、switch（切换中）、check（激活核对已提交
// 的实测、写入 ACTIVE 与提交）、rollback（ROLLING_BACK）、probe（Safari 重测执行中：开始与核对）、normal（普通模式执行中）。
//
// 覆盖（每种策略的合计打印在运行摘要中并写入 SFE_FUZZ_OUT 的 JSON；每种策略 ≥100 个种子时断言 TARGETED 中每一项至少出现一次，
// 生成器不再到达某个危险状态时大规模运行失败）：普通模式开始执行时持久标记中有被换掉的进程路径（normalWithRetiredPaths）、
// 结束了已不在配置中的 Safari 进程路径上的连接（killRetiredPath）；normalDuring 在激活写入阻断之前、切换中、核对实测中、回滚中、
// 重测执行中受理（normalDuring.*）；激活让给排队的普通模式的位置（yield.beforeVerifyOnly / beforeActive / afterActive，按步骤
// 说明识别；第一次写入 Surge 之前的 yield.beforeFirstWrite 与其他说明的 yield.other 只作信息，不断言）；核对实测中与回滚中崩溃
// （crashDuring.check / rollback）。
//
// 环境变量：SFE_FUZZ_SEEDS（每种策略的种子数，缺省 10）、SFE_FUZZ_SEED_BASE（起始种子，缺省 1）、SFE_FUZZ_SEED（只回放
// 这一个种子并打印轨迹）、SFE_FUZZ_EVENTS（回放给定的 JSON 事件列表）、SFE_FUZZ_STRATEGY（只跑一种策略）、SFE_FUZZ_SHRINK
// （每个违例最多回放次数，缺省 60，0 不缩减）、SFE_FUZZ_OUT（把结果与覆盖 JSON 写到该路径前缀）、SFE_FUZZ_CALLS=1（打印轨迹时
// 逐条列出引擎的 Surge 调用与当时的状态，用于校准 nth）。大规模运行：SFE_FUZZ_SEEDS=300。
// 违例时打印种子与缩减后的最小事件轨迹（逐个去掉事件仍能复现同一违例签名）。

import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ENTRY_WITNESS_PROCESS_PATH,
  ROUTE_GROUP_NAME,
  SfeError,
  type ActivateRequest,
  type NativeResponse,
  type NormalModeRequest,
  type ProtocolCoverage,
  type RouteSummaryView,
} from '@sfe/contract';
import { processPathsDigest } from '../../src/engine/capabilities.js';
import { retiredSafariPaths, safariMayUseRouteMarked } from '../../src/engine/safari-route-marker.js';
import { payloadOf } from '../../src/domain/operations.js';
import type { OperationRecord } from '../../src/db/index.js';
import type { SurgeAdapter } from '../../src/ports.js';
import { FAKE_CHROME_PATH, FAKE_SAFARI_PATH, FAKE_VERIFY_HOST, FakeSurge, type SimulatedRequest } from '../../src/surge/fake.js';
import { SURGE_PRIMITIVES, capabilityUnverified } from '../../src/surge/primitives.js';
import { ALL_CAPS, AGENT, PROFILE_A, PROFILE_B, WEB, anyContext, createHarness, envInput, rid, type Harness } from './harness.js';

// ---------- 常量 ----------

const SAFARI_STP = '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview';
const SAFARI_FAMILY = [FAKE_SAFARI_PATH, SAFARI_STP];
const HOSTS = { verify: FAKE_VERIFY_HOST, site: 'www.amazon.com', daily: 'daily.example.test' } as const;
type HostKey = keyof typeof HOSTS;
const HOST_KEYS = Object.keys(HOSTS) as HostKey[];
const PROTOS = ['tcp', 'udp'] as const;
type Proto = (typeof PROTOS)[number];
/** 0、1 是已识别场景（可关联），2 是未识别场景（原生桥拿不到场景 ID）。 */
const PROFILES = [PROFILE_A, PROFILE_B, null] as const;
const NORMAL_DONE_TEXT = '已进入普通模式：Safari 按 Surge 原规则发出请求';
const CRASHED = Symbol('crashed');
const CALL_TIMEOUT_MS = 20_000;

const FULL_COVERAGE: ProtocolCoverage = {
  ipv4: { result: 'pass', note: null },
  ipv6: { result: 'limitation', note: '本机网络无 IPv6，未覆盖' },
  http1: { result: 'pass', note: null },
  http2: { result: 'pass', note: null },
  http3_quic: { result: 'pass', note: 'H3 被拒绝并回落 TCP' },
  websocket: { result: 'pass', note: null },
  extension_page_fetch: { result: 'pass', note: null },
};

// ---------- 随机数 ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 事件 ----------

/**
 * crash 与 normalDuring 数哪些 Surge 调用（见文件头）：any 是下一个事件中的全部调用；其余只数执行器当前操作处于该状态时的调用。
 * early：激活写入阻断之前（stage pending/arrived）；switch：切换中（stage switching）；check：激活核对已提交的实测、写入 ACTIVE 与
 * 提交；rollback：ROLLING_BACK；probe：Safari 重测执行中（开始与核对）；normal：普通模式执行中。
 */
const WHENS = ['any', 'early', 'switch', 'check', 'rollback', 'probe', 'normal'] as const;
type When = (typeof WHENS)[number];
type CallState = Exclude<When, 'any'>;

type Ev =
  | { t: 'create' }
  | { t: 'bind'; p: 0 | 1; e: number }
  | { t: 'publish' }
  | { t: 'activate'; e: number; via: 'web' | 'profile'; policy: 'none' | 'closed' | 'keep'; confirm: 'right' | 'wrong'; onNeed: 'retry' | 'giveup' }
  | { t: 'verify'; outcome: 'pass' | 'http_fail' | 'no_request' | 'chrome' | 'timeout'; longLived: boolean; tabs: boolean }
  | { t: 'cancel'; via: 'web' | 'profile' }
  /** 重新检测：Safari 重测（不切换、不断连）或代理预检。 */
  | { t: 'probe'; e: number; kind: 'safari' | 'preflight'; via: 'web' | 'profile' }
  | { t: 'normal'; via: 'web' | 'bound' | 'unbound'; policy: 'closed' | 'keep'; pick: number }
  | { t: 'killFail' }
  /** 故障消除：rule match 可用、文件监视快、尚未触发的 killRequest 失败作废（focusChain 用它建立干净的前提）。 */
  | { t: 'heal' }
  | { t: 'matchRule'; available: boolean }
  | { t: 'latency'; long: boolean }
  | { t: 'flush' }
  | { t: 'restart' }
  /** 用户启用的模块规则排在本应用入口之前：DOMAIN-SUFFIX,<host>,DIRECT（替换之前的；heal 移除）。 */
  | { t: 'module'; host: HostKey }
  | { t: 'safari'; host: HostKey; proto: Proto; app: 'safari' | 'stp' }
  | { t: 'chrome'; host: HostKey; proto: Proto }
  | { t: 'paths'; set: 'safari' | 'both' | 'stp'; regrant: boolean }
  /** nth 为 0：空闲时崩溃；否则下一个事件中第 nth 次（按 when 计数的）Surge 调用时崩溃（after：调用已生效）。 */
  | { t: 'crash'; nth: number; after: boolean; when?: When }
  | { t: 'reconcile'; kind: 'periodic' | 'refresh' }
  | { t: 'advance'; ms: number }
  | { t: 'popup'; p: 0 | 1 | 2 }
  | { t: 'report'; p: 0 | 1 | 2; windows: number }
  | { t: 'busy'; rate: number; rs: number }
  /** 下一个事件中，引擎第 nth 次（按 when 计数的）Surge 调用时（切换、回滚、重测等进行中）用户点「进入普通模式」。 */
  | { t: 'normalDuring'; nth: number; via: 'web' | 'bound' | 'unbound'; when?: When };

interface Header {
  strategy: 'ruleset_resource' | 'temp_rule';
  insertion: 'head' | 'tail';
  seed: number;
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/**
 * crash / normalDuring 的 nth 上限：按两种策略中该状态的 Surge 调用数（ruleset_resource 的 rule match 探测最多）取整。switch 只取
 * 阻断、结束连接与选择这一段（约 70 次调用；写入 VERIFY_ONLY 的调用仍可由 any 到达）：在其中受理的普通模式让激活停在写入
 * VERIFY_ONLY 之前。
 */
const NTH_MAX: Record<When, number> = { any: 130, early: 24, switch: 70, check: 80, rollback: 60, probe: 18, normal: 110 };
/** 激活核对已提交的实测时，写入 ACTIVE 之前的 Surge 调用数（选择、请求记录、重新读取事实）与 temp_rule 下整个核对的调用数。 */
const CHECK_FACT_CALLS = 8;
const CHECK_TEMP_RULE_CALLS = 55;
/** Safari 重测核对已提交的实测时的 Surge 调用数（选择、请求记录）；重测开始（检查条件）约 17 次，见 NTH_MAX.probe。 */
const PROBE_CHECK_CALLS = 2;

function generate(seed: number): Ev[] {
  const rng = mulberry32(seed * 7919 + 17);
  const n = 20 + Math.floor(rng() * 21);
  const out: Ev[] = [];
  const via3 = () => pick(rng, ['web', 'bound', 'unbound'] as const);
  /** 1..max，偏向小的序号（每个状态开头的几次调用决定落在哪个让出点之前），仍能到达 max。 */
  const nthUpTo = (max: number): number => 1 + Math.floor(rng() ** 2 * max);
  /**
   * check：前 CHECK_FACT_CALLS 次调用是提交后的选择与请求记录读取、写入 ACTIVE 之前重新读取事实（在其中受理 → 停在写入 ACTIVE
   * 之前），之后是写入 ACTIVE 与读回（→ 停在提交之前）。两段各占一部分：前一段不取最后两次（受理是异步的，会落到写入 ACTIVE
   * 期间），后一段按 temp_rule 较短的调用数取上限。
   */
  const nthFor = (when: When): number =>
    when !== 'check'
      ? nthUpTo(NTH_MAX[when])
      : rng() < 0.6
        ? 1 + Math.floor(rng() * (CHECK_FACT_CALLS - 2))
        : CHECK_FACT_CALLS + 1 + Math.floor(rng() * (CHECK_TEMP_RULE_CALLS - CHECK_FACT_CALLS));
  const during = (when: When): Ev => ({ t: 'normalDuring', nth: nthFor(when), via: via3(), when });
  const crashAt = (when: When): Ev => ({ t: 'crash', nth: nthFor(when), after: rng() < 0.5, when });
  const anyWhen = (): When => pick(rng, ['any', 'any', 'any', 'early', 'switch', 'check', 'rollback', 'probe', 'normal'] as const);
  /** 下一个事件中用户点普通模式（概率 pNormal）或服务崩溃（概率 pCrash），都按 when 计数；max 给出时 nth 取 1..max。 */
  const arm = (when: When, pNormal: number, pCrash: number, max?: number): void => {
    const r = rng();
    const ev = r < pNormal ? during(when) : r < pNormal + pCrash ? crashAt(when) : null;
    if (ev && max !== undefined && (ev.t === 'normalDuring' || ev.t === 'crash')) ev.nth = 1 + Math.floor(rng() * max);
    if (ev) out.push(ev);
  };
  const table: Array<[number, number, () => Ev]> = [
    // [保留, 权重, 生成]
    [10, 3, () => ({ t: 'create' })],
    [10, 4, () => ({ t: 'bind', p: pick(rng, [0, 1] as const), e: Math.floor(rng() * 3) })],
    [1, 2, () => ({ t: 'publish' })],
    [12, 14, () => ({
      t: 'activate',
      // 一半针对序幕中已关联的环境 0（之后的实测与核对、回滚才会发生）
      e: rng() < 0.5 ? 0 : Math.floor(rng() * 3),
      via: pick(rng, ['web', 'profile'] as const),
      policy: pick(rng, ['none', 'none', 'closed', 'keep'] as const),
      confirm: rng() < 0.85 ? 'right' : 'wrong',
      onNeed: rng() < 0.85 ? 'retry' : 'giveup',
    })],
    [8, 14, () => ({
      t: 'verify',
      outcome: pick(rng, ['pass', 'pass', 'pass', 'pass', 'http_fail', 'no_request', 'chrome', 'timeout'] as const),
      longLived: rng() < 0.4,
      tabs: rng() < 0.2,
    })],
    [2, 4, () => ({ t: 'cancel', via: pick(rng, ['web', 'profile'] as const) })],
    [1, 5, () => ({ t: 'probe', e: rng() < 0.5 ? 0 : Math.floor(rng() * 3), kind: rng() < 0.8 ? 'safari' : 'preflight', via: pick(rng, ['web', 'profile'] as const) })],
    [4, 12, () => ({ t: 'normal', via: via3(), policy: pick(rng, ['closed', 'keep'] as const), pick: Math.floor(rng() * 2) })],
    [2, 4, () => ({ t: 'killFail' })],
    [2, 4, () => ({ t: 'matchRule', available: rng() < 0.5 })],
    [2, 4, () => ({ t: 'latency', long: rng() < 0.5 })],
    [1, 3, () => ({ t: 'flush' })],
    [1, 3, () => ({ t: 'restart' })],
    [1, 2, () => ({ t: 'module', host: pick(rng, HOST_KEYS) })],
    [4, 12, () => ({ t: 'safari', host: pick(rng, HOST_KEYS), proto: rng() < 0.75 ? 'tcp' : 'udp', app: rng() < 0.8 ? 'safari' : 'stp' })],
    [2, 5, () => ({ t: 'chrome', host: pick(rng, HOST_KEYS), proto: rng() < 0.75 ? 'tcp' : 'udp' })],
    [1, 3, () => ({ t: 'paths', set: pick(rng, ['safari', 'both', 'stp', 'both'] as const), regrant: rng() < 0.8 })],
    [1, 5, () => (rng() < 0.3 ? { t: 'crash', nth: 0, after: false } : crashAt(anyWhen()))],
    [1, 4, () => ({ t: 'reconcile', kind: rng() < 0.5 ? 'periodic' : 'refresh' })],
    [1, 6, () => ({ t: 'advance', ms: pick(rng, [1_000, 31_000, 125_000, 700_000]) })],
    [2, 4, () => ({ t: 'popup', p: pick(rng, [0, 1, 2] as const) })],
    [1, 2, () => ({ t: 'report', p: pick(rng, [0, 1, 2] as const), windows: rng() < 0.5 ? 0 : 2 })],
    [2, 3, () => ({ t: 'busy', rate: pick(rng, [0, 0.15, 0.4]), rs: Math.floor(rng() * 1e9) })],
    [1, 3, () => during(anyWhen())],
  ];
  /**
   * 被换掉的进程路径：故障消除，（普通模式使入口回到 NORMAL，才能确认进程路径）Safari+STP → 激活并实测 → STP 经买家出口的长连接 →
   * 普通模式留下持久标记（结束连接失败；或 rule match 不可用且文件监视慢，撤销入口之前 STP 又经 SFE-ROUTE 建立连接）→ 确认只有
   * Safari（STP 并入标记的被换掉路径）→ 普通模式按被换掉的路径结束 STP 经买家出口的连接。各事件仍独立，缩减时可以分别去掉。
   */
  const retiredChain = (): Ev[] => {
    const evs: Ev[] = [
      { t: 'heal' },
      { t: 'normal', via: 'web', policy: 'closed', pick: 0 },
      { t: 'paths', set: 'both', regrant: true },
      { t: 'activate', e: 0, via: 'web', policy: 'closed', confirm: 'right', onNeed: 'retry' },
      { t: 'verify', outcome: 'pass', longLived: false, tabs: false },
      { t: 'safari', host: 'site', proto: 'tcp', app: 'stp' },
    ];
    if (rng() < 0.6) evs.push({ t: 'killFail' }, { t: 'normal', via: 'web', policy: 'closed', pick: 0 });
    else {
      evs.push(
        { t: 'matchRule', available: false },
        { t: 'latency', long: true },
        { t: 'normal', via: 'web', policy: 'closed', pick: 0 },
        { t: 'safari', host: 'daily', proto: 'tcp', app: 'stp' },
        { t: 'matchRule', available: true },
        { t: 'latency', long: false },
      );
    }
    evs.push({ t: 'paths', set: 'safari', regrant: true }, { t: 'normal', via: via3(), policy: 'closed', pick: 0 });
    return evs;
  };
  /**
   * 在干净的前提下走到一个危险状态：故障消除（heal）、普通模式（使下面的激活真正切换而不是复用）→ 激活已关联的
   * 环境 0 → 在激活写入阻断之前或切换中、核对实测（写入 ACTIVE 与提交）、回滚（取消或实测失败）、Safari 重测执行中或其核对中
   * 点普通模式或服务崩溃。
   * 随机的 rule match 不可用、慢监视与尚未触发的 killRequest 失败（会让激活第 7 步失败）会持续很久，单靠上面的偏置很少到达
   * 这些状态。
   */
  const focusChain = (): Ev[] => {
    const evs: Ev[] = [{ t: 'heal' }, { t: 'normal', via: 'web', policy: 'closed', pick: 0 }];
    const activate: Ev = { t: 'activate', e: 0, via: pick(rng, ['web', 'profile'] as const), policy: 'closed', confirm: 'right', onNeed: 'retry' };
    const target = pick(rng, ['early', 'switch', 'check', 'check', 'rollback', 'rollback', 'probe', 'probe', 'probe'] as const);
    const armed = rng() < 0.5 ? crashAt(target) : during(target);
    const pass: Ev = { t: 'verify', outcome: 'pass', longLived: rng() < 0.4, tabs: false };
    if (target === 'early' || target === 'switch') evs.push(armed, activate, pass);
    else if (target === 'check') evs.push(activate, armed, pass);
    else if (target === 'rollback') {
      evs.push(activate, armed, rng() < 0.6 ? { t: 'cancel', via: pick(rng, ['web', 'profile'] as const) } : { t: 'verify', outcome: pick(rng, ['http_fail', 'no_request', 'chrome', 'timeout'] as const), longLived: false, tabs: false });
    } else {
      const probe: Ev = { t: 'probe', e: 0, kind: 'safari', via: pick(rng, ['web', 'profile'] as const) };
      const after: Ev = { t: 'verify', outcome: pick(rng, ['pass', 'pass', 'http_fail'] as const), longLived: false, tabs: false };
      // 重测核对只有两次 Surge 调用（提交后的选择与请求记录）
      evs.push(activate, pass, ...(rng() < 0.5 ? [armed, probe, after] : [probe, { ...armed, nth: 1 + Math.floor(rng() * PROBE_CHECK_CALLS) } as Ev, after]));
    }
    return evs;
  };
  // 序幕：创建并关联一到三个环境（之后的事件与状态无关，缩减时可以去掉其中任何一个）
  out.push({ t: 'create' }, { t: 'bind', p: 0, e: 0 });
  if (rng() < 0.75) {
    out.push({ t: 'create' });
    if (rng() < 0.5) out.push({ t: 'bind', p: 1, e: 1 });
  }
  if (rng() < 0.4) out.push({ t: 'create' });
  const w = table.map(([, late]) => late);
  const total = w.reduce((a, b) => a + b, 0);
  while (out.length < n) {
    const macro = rng();
    if (macro < 0.018) {
      out.push(...retiredChain());
      continue;
    }
    if (macro < 0.068) {
      out.push(...focusChain());
      continue;
    }
    let r = rng() * total;
    let k = 0;
    while (r >= w[k]!) r -= w[k++]!;
    const ev = table[k]![2]();
    // 重测执行中、其后的核对实测中点普通模式或崩溃；重测之后常常紧接着实测
    if (ev.t === 'probe' && ev.kind === 'safari') {
      arm('probe', 0.3, 0.1);
      out.push(ev);
      if (rng() < 0.6) {
        arm('probe', 0.25, 0.08, PROBE_CHECK_CALLS);
        out.push({ t: 'verify', outcome: pick(rng, ['pass', 'pass', 'http_fail', 'no_request'] as const), longLived: rng() < 0.3, tabs: false });
      }
      continue;
    }
    // 激活之前（写入阻断之前或切换中）点普通模式或崩溃；之后常常紧接着在绑定场景中完成实测（其间点普通模式或崩溃）、再打开
    // 业务页，有时取消或实测失败（回滚）。两处只安排其中一处：激活被之前受理的普通模式取代（或崩溃后回滚）就没有核对与回滚了
    if (ev.t === 'activate') {
      const followUp = rng() < 0.7;
      const pre = !followUp || rng() < 0.35;
      if (pre) arm(pick(rng, ['early', 'switch', 'switch', 'any'] as const), 0.3, 0.15);
      out.push(ev);
      if (!followUp) continue;
      const r2 = rng();
      if (r2 < 0.7) {
        if (!pre) arm('check', 0.35, 0.15);
        out.push({ t: 'verify', outcome: 'pass', longLived: rng() < 0.4, tabs: false });
        if (rng() < 0.75) out.push({ t: 'safari', host: pick(rng, ['site', 'daily'] as const), proto: 'tcp', app: rng() < 0.85 ? 'safari' : 'stp' });
      } else {
        if (!pre) arm('rollback', 0.4, 0.2);
        // 等待实测期间用户启用排在本应用入口之前的模块规则：回滚回到阻断的最终读回因此不能确认（PRECEDENCE_VIOLATION）
        if (rng() < 0.15) out.push({ t: 'module', host: pick(rng, HOST_KEYS) });
        out.push(r2 < 0.85 ? { t: 'cancel', via: pick(rng, ['web', 'profile'] as const) } : { t: 'verify', outcome: pick(rng, ['http_fail', 'no_request', 'timeout'] as const), longLived: false, tabs: false });
      }
      continue;
    }
    // 普通模式之前常常有一次结束连接失败（仍是独立事件，缩减时可以分别去掉）
    if (ev.t === 'normal' && rng() < 0.3) out.push({ t: 'killFail' });
    // rule match 不可用且文件监视比等待上限慢时撤销入口（取消、实测失败或超时、普通模式）：入口按等满上限视为已加载的退路
    if ((ev.t === 'cancel' || ev.t === 'normal' || (ev.t === 'verify' && ev.outcome !== 'pass')) && rng() < 0.12) {
      out.push({ t: 'matchRule', available: false }, { t: 'latency', long: true });
    }
    // 普通模式、核对实测与回滚（取消、实测失败或超时）进行中点普通模式或服务崩溃
    if (ev.t === 'normal') arm('normal', 0.05, 0.12);
    if (ev.t === 'verify') arm(ev.outcome === 'pass' ? 'check' : 'rollback', 0.2, 0.1);
    if (ev.t === 'cancel') arm('rollback', 0.35, 0.2);
    out.push(ev);
  }
  // n 是目标长度：最后一个事件的后续事件与宏完整保留（截断会让它们停在半途）
  return out;
}

function describeEv(ev: Ev): string {
  const { t, ...rest } = ev;
  const parts = Object.entries(rest).map(([k, v]) => `${k}=${String(v)}`);
  return [t, ...parts].join(' ');
}

// ---------- FakeSurge 内部（只读求值，测试专用） ----------

interface FakeInternals {
  evaluate(facts: { processPath: string | null; host: string; protocol: 'tcp' | 'udp' }): { rule: string; policy: string };
  resolvePolicy(policy: string, depth: number): { leaf: string; chain: string[]; rejected: boolean };
  groups: Map<string, unknown>;
  selection: Map<string, string | null>;
  active: Map<string, SimulatedRequest>;
}

interface Truth {
  rule: string;
  policy: string;
  leaf: string | null;
  rejected: boolean;
}

const isSfe = (n: string | null | undefined): boolean => typeof n === 'string' && n.startsWith('SFE-');
/** 经 SFE-ROUTE 或本应用出口节点发出（没有被拒绝）。 */
const routes = (t: Truth): boolean => !t.rejected && (t.policy === ROUTE_GROUP_NAME || isSfe(t.leaf));
/** 连接可能在买家出口上（与 safari-connections.ts 的 mayUseBuyerExit 相同的判断）。 */
const mayBuyer = (r: { policyName: string | null; leafPolicyName: string | null }): boolean =>
  (r.policyName === null && r.leafPolicyName === null) || isSfe(r.policyName) || isSfe(r.leafPolicyName);
const short = (p: string | null): string => (p === FAKE_SAFARI_PATH ? 'Safari' : p === SAFARI_STP ? 'STP' : p === FAKE_CHROME_PATH ? 'Chrome' : String(p));

// ---------- 世界 ----------

interface Violation {
  inv: string;
  sig: string;
  detail: string;
  at: number;
  state: string;
}

interface Stats {
  runs: number;
  events: number;
  activeVerified: number;
  normalRestored: number;
  normalFailed: number;
  becWarnings: number;
  crashesMid: number;
  crashesIdle: number;
  rollbacks: number;
  attention: number;
  kills: number;
  pathChanges: number;
  i5Samples: number;
}

function emptyStats(): Stats {
  return { runs: 0, events: 0, activeVerified: 0, normalRestored: 0, normalFailed: 0, becWarnings: 0, crashesMid: 0, crashesIdle: 0, rollbacks: 0, attention: 0, kills: 0, pathChanges: 0, i5Samples: 0 };
}

/**
 * 覆盖计数（见文件头「覆盖」）。TARGETED 中的每一项在每种策略 ≥100 个种子的运行中至少出现一次，否则测试失败（生成器回归）；
 * 其余只作信息：yield.beforeFirstWrite（第一次写入 Surge 之前的让出点，产品代码仍在修改，不断言）、yield.other（未识别说明的
 * 让出点）、其他状态中的崩溃与普通模式、弹窗比较因竞争而跳过的次数。
 */
const TARGETED = [
  'normalWithRetiredPaths',
  'killRetiredPath',
  'normalDuring.early',
  'normalDuring.switch',
  'normalDuring.check',
  'normalDuring.rollback',
  'normalDuring.probe',
  'yield.beforeVerifyOnly',
  'yield.beforeActive',
  'yield.afterActive',
  'crashDuring.check',
  'crashDuring.rollback',
] as const;
const COVERAGE_KEYS = [
  ...TARGETED,
  'yield.beforeFirstWrite',
  'yield.other',
  'normalDuring.idle',
  'normalDuring.normal',
  'crashDuring.idle',
  'crashDuring.early',
  'crashDuring.switch',
  'crashDuring.probe',
  'crashDuring.normal',
  'popupRaceSkipped',
] as const;
type CoverageKey = (typeof COVERAGE_KEYS)[number];
type Coverage = Record<CoverageKey, number>;

function emptyCoverage(): Coverage {
  return Object.fromEntries(COVERAGE_KEYS.map((k) => [k, 0])) as Coverage;
}

/** 激活停下让给排队的普通模式（route.ts yieldToQueuedNormal）时的步骤说明 → 覆盖项。 */
const YIELD_TEXT = '已被进入普通模式取代：';
function yieldKey(message: string): CoverageKey {
  if (message.includes('在第一次写入 Surge 之前停下')) return 'yield.beforeFirstWrite';
  if (message.includes('在只开放检测服务（VERIFY_ONLY）之前停下')) return 'yield.beforeVerifyOnly';
  if (message.includes('在进入使用中模式（ACTIVE）之前停下')) return 'yield.beforeActive';
  if (message.includes('在提交之前停下')) return 'yield.afterActive';
  return 'yield.other';
}

type CallResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } | typeof CRASHED;

class Hang extends Error {}

class World {
  h!: Harness;
  ready = false;
  readonly header: Header;
  envs: string[] = [];
  violations: Violation[] = [];
  notes: string[] = [];
  /** 当前 SFE-ROUTE 选择期：选择换成另一个节点时开始新的一期；本期内收到真实通过的实测后为 verified。 */
  sel = { node: null as string | null, verified: false, verifyOnlyReached: false };
  goodSubmissions = new Set<string>();
  checkedCommits = new Set<string>();
  matchRuleUnavailable = false;
  latencyLong = false;
  killFailPending = false;
  crashArm: { countdown: number; after: boolean; when: When } | null = null;
  normalArm: { countdown: number; via: 'web' | 'bound' | 'unbound'; when: When } | null = null;
  pending: Array<Promise<unknown>> = [];
  /** 受理的普通模式（含 normalDuring 排队受理的）：L1 在执行器空闲后检查它们都已结束。 */
  acceptedNormals: Array<{ id: string; latency: boolean; at: number; busy: boolean; checked: boolean }> = [];
  /** 执行器中的操作（currentOperationId 非空）调用 Surge 或写路由记录的次数：弹窗比较据此判断调用期间是否有竞争。 */
  opActivity = 0;
  cov = emptyCoverage();
  private normalStarts = new Set<string>();
  private yieldsCounted = new Set<string>();
  /** SFE_FUZZ_CALLS：轨迹中逐条记下引擎的 Surge 调用与当时的状态（只影响输出）。 */
  traceCalls = false;
  crashSig: { promise: Promise<void>; resolve: () => void } | null = null;
  crashed = false;
  gens: Array<{ dead: boolean }> = [];
  externalDirty = false;
  /** module 事件启用的模块规则（heal 移除）。 */
  moduleRule: { text: string; host: HostKey } | null = null;
  busy = { rate: 0, rng: mulberry32(1) };
  eventIndex = -1;
  quietVerify = false;
  stats = emptyStats();
  trace: string[] = [];

  constructor(header: Header) {
    this.header = header;
  }

  get fake(): FakeSurge {
    return this.h.fake;
  }

  private get internals(): FakeInternals {
    return this.h.fake as unknown as FakeInternals;
  }

  // ----- Surge 适配器包装：只包装引擎使用的适配器（维护端口仍是 FakeSurge） -----

  wrap(fake: FakeSurge): SurgeAdapter {
    const gen = { dead: false };
    this.gens.push(gen);
    const target = fake as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const out: Record<string, unknown> = { mechanism: () => fake.mechanism() };
    for (const name of SURGE_PRIMITIVES) {
      out[name] = async (...args: unknown[]): Promise<unknown> => {
        if (gen.dead) return new Promise(() => undefined);
        // 文件监视见证的轮询次数取决于真实时间：不计入（保持回放确定）
        const counted = !(name === 'matchRule' && (args[0] as { processPath?: string } | undefined)?.processPath === ENTRY_WITNESS_PROCESS_PATH);
        if (counted) this.beforeEngineCall(name);
        if (counted && this.crashArm && this.callMatches(this.crashArm.when) && --this.crashArm.countdown <= 0) {
          const after = this.crashArm.after;
          this.crashArm = null;
          this.cov[`crashDuring.${this.callState() ?? 'idle'}`]++;
          if (after) {
            try {
              if (name === 'killRequest') this.onKill(String(args[0]));
              await target[name]!.apply(fake, args);
            } catch {
              // 结果未知
            }
            this.afterEngineCall(name, true);
          }
          gen.dead = true;
          this.crashed = true;
          this.stats.crashesMid++;
          this.trace.push(`   ! 服务在 ${name}${after ? '（已生效）' : '（未生效）'} 时崩溃`);
          this.crashSig?.resolve();
          return new Promise(() => undefined);
        }
        if (name === 'matchRule' && this.matchRuleUnavailable) throw capabilityUnverified('matchRule');
        if (name === 'killRequest') this.onKill(String(args[0]));
        let ok = false;
        try {
          const r = await target[name]!.apply(fake, args);
          ok = true;
          return r;
        } finally {
          if (name === 'killRequest') this.killFailPending = false;
          this.afterEngineCall(name, ok);
        }
      };
    }
    return out as unknown as SurgeAdapter;
  }

  private beforeEngineCall(name: string): void {
    if (!this.ready) return;
    const state = this.callState();
    if (this.traceCalls) this.trace.push(`     · ${name}（${state ?? '无操作'}）`);
    const op = this.currentOp();
    if (op) this.opActivity++;
    // 普通模式开始执行（第一次 Surge 调用）时持久标记中有被换掉的进程路径
    if (op?.kind === 'route.normal' && !this.normalStarts.has(op.id)) {
      this.normalStarts.add(op.id);
      if (retiredSafariPaths(this.h.app.engine, this.configuredPaths()).length > 0) this.cov.normalWithRetiredPaths++;
    }
    this.sampleI5(`mid:before ${name}`);
    if (this.normalArm && this.callMatches(this.normalArm.when) && --this.normalArm.countdown <= 0) {
      const via = this.normalArm.via;
      this.normalArm = null;
      this.pending.push(this.normalWhileBusy(via, state ?? 'idle'));
    }
    // Safari / Chrome 在切换进行中照常发出请求（与服务不同步）
    // 实测提交期间不插入（时间窗内其他检测主机请求会被当作本次检测，是不开 MITM 时的已知限制）
    if (this.busy.rate > 0 && !this.quietVerify && this.busy.rng() < this.busy.rate) {
      const r = this.busy.rng();
      const host = pick(this.busy.rng, HOST_KEYS);
      const proto: Proto = this.busy.rng() < 0.8 ? 'tcp' : 'udp';
      if (r < 0.75) this.open(FAKE_SAFARI_PATH, host, proto, 'mid');
      else if (r < 0.85) this.open(SAFARI_STP, host, proto, 'mid');
      else this.open(FAKE_CHROME_PATH, host, proto, 'mid');
    }
  }

  private afterEngineCall(name: string, ok: boolean): void {
    if (!this.ready) return;
    if (name === 'selectGroupPolicy' && ok) {
      // 引擎选择了另一个节点：开始新的一期（未实测；即使该节点以前实测过——例如回滚恢复之前的买家出口，也要重新实测）。
      // 重新选择已经选中的同一节点不改变出口（Safari 一直经它发出），本期的实测状态不变。
      const node = this.internals.selection.get(ROUTE_GROUP_NAME) ?? null;
      if (node !== this.sel.node) this.sel = { node, verified: false, verifyOnlyReached: false };
    }
    this.sampleI5(`mid:after ${name}`);
  }

  /**
   * 切换、回滚、重测等进行中用户点「进入普通模式」（不等待引擎当前的调用）。任何拒绝都由 normalMode 记为 I4 违例（没有例外）；
   * 受理后计入点击时的状态（覆盖）。
   */
  private async normalWhileBusy(via: 'web' | 'bound' | 'unbound', state: CallState | 'idle'): Promise<void> {
    const id = await normalMode(this, { t: 'normal', via, policy: 'closed', pick: 0 }, { busy: true, state });
    if (id !== null) this.cov[`normalDuring.${state}`]++;
  }

  /** 执行器当前操作的状态（crash / normalDuring 的 when，见 WHENS）；没有操作或不属于任何一种时为 null。 */
  callState(): CallState | null {
    const op = this.currentOp();
    if (!op) return null;
    if (op.phase === 'ROLLING_BACK') return 'rollback';
    if (op.kind === 'route.normal') return op.status === 'running' ? 'normal' : null;
    const p = payloadOf(op).route;
    if (!p || op.status !== 'running') return null;
    if (p.flow === 'probe') return 'probe';
    if (p.stage === 'pending' || p.stage === 'arrived') return 'early';
    if (p.stage === 'switching') return 'switch';
    if (p.stage === 'verify_only' && p.submission !== null) return 'check';
    return null;
  }

  private callMatches(when: When): boolean {
    return when === 'any' || this.callState() === when;
  }

  /** 激活停下让给排队的普通模式（SUPERSEDED 步骤说明）：按停下的位置计入覆盖。 */
  countYields(): void {
    for (const op of this.h.repos.operations.listByStatus(['superseded'])) {
      if (this.yieldsCounted.has(op.id)) continue;
      this.yieldsCounted.add(op.id);
      const step = this.h.repos.operations.listSteps(op.id).find((s) => s.phase === 'SUPERSEDED' && s.message.startsWith(YIELD_TEXT));
      if (!step) continue;
      this.cov[yieldKey(step.message)]++;
      this.trace.push(`   ↪ 操作 ${op.id}（${op.kind}）${step.message}`);
    }
  }

  // ----- 求值 -----

  truth(processPath: string, host: string, protocol: Proto): Truth {
    const f = this.internals;
    this.h.fake.checkFileChanges();
    const { rule, policy } = f.evaluate({ processPath, host, protocol });
    const r = f.resolvePolicy(policy, 0);
    return { rule, policy, leaf: f.groups.has(policy) ? r.leaf : null, rejected: r.rejected };
  }

  /** 命中本应用入口规则（ruleset_resource 的四条 RULE-SET；temp_rule 的临时规则——本测试不添加其他临时规则）。 */
  ours(t: Truth): boolean {
    return /^RULE-SET,sfe-entry-/i.test(t.rule) || this.h.fake.tempRules.includes(t.rule) || t.policy === ROUTE_GROUP_NAME;
  }

  /**
   * 请求命中排在本应用入口之前、与受保护主机（站点与检测主机）不相交的用户规则（module 事件的 daily 主机）：§5.5 的优先级检查
   * 按设计忽略这类规则，入口状态的声明（阻断、只允许检测）不覆盖这些请求。
   */
  disjointUserRule(t: Truth): boolean {
    return this.moduleRule !== null && this.moduleRule.host === 'daily' && t.rule === this.moduleRule.text;
  }

  configuredPaths(): string[] {
    return [...this.h.repos.settings.get('safariProcessPaths')];
  }

  activeConns(): SimulatedRequest[] {
    return [...this.internals.active.values()].filter((r) => !r.completed);
  }

  safariConns(): SimulatedRequest[] {
    return this.activeConns().filter((r) => r.processPath !== null && SAFARI_FAMILY.includes(r.processPath));
  }

  private refreshSel(): void {
    const actual = this.internals.selection.get(ROUTE_GROUP_NAME) ?? null;
    if (actual !== this.sel.node) this.sel = { node: actual, verified: false, verifyOnlyReached: false };
  }

  private currentOp(): OperationRecord | null {
    const id = this.h.app.executor.currentOperationId;
    return id ? this.h.repos.operations.get(id) : null;
  }

  private openOps(): OperationRecord[] {
    return this.h.repos.operations.listByStatus(['queued', 'running', 'waiting']);
  }

  private openActivationFor(node: string | null): boolean {
    return this.openOps().some((op) => {
      const p = payloadOf(op).route;
      return p !== undefined && p.flow !== 'probe' && p.nodeName === node;
    });
  }

  /**
   * 有路由操作正在执行或已排队（会在执行器中撤下当前入口）：例如等待中的激活被新受理的普通模式取代（受理时 SUPERSEDED），
   * 普通模式排在执行器当前的内部任务之后、尚未写入阻断。
   */
  private routeOpPending(): boolean {
    return this.h.repos.operations
      .listByStatus(['queued', 'running'])
      .some((op) => op.kind === 'route.activate' || op.kind === 'route.normal' || payloadOf(op).route !== undefined);
  }

  /** 有路由操作在进行中：排队、执行中或等待中（等待场景到达或实测、WAITING_ROUTE）。 */
  private routeOpInFlight(): boolean {
    return this.openOps().some((op) => op.kind === 'route.activate' || op.kind === 'route.normal' || op.kind === 'probe.safari' || payloadOf(op).route !== undefined);
  }

  /** ruleset_resource：Surge 加载文件中的当前内容之后该请求是否仍经 SFE-ROUTE（只用于判断“已写入收紧、Surge 尚未加载”）。 */
  private diskStillRoutes(processPath: string, host: string, protocol: Proto): boolean {
    if (this.header.strategy !== 'ruleset_resource') return true;
    const shadow = new FakeSurge({ directory: this.h.surgeDir, now: () => this.h.clock.now() }) as unknown as FakeInternals;
    return shadow.evaluate({ processPath, host, protocol }).policy === ROUTE_GROUP_NAME;
  }

  /** I5 的判断：返回 null 表示允许，否则为原因。 */
  private routeDenied(processPath: string, host: string, protocol: Proto, leaf: string | null): string | null {
    this.refreshSel();
    if (leaf !== this.sel.node) return `叶节点 ${leaf} 不是当前 SFE-ROUTE 选择 ${this.sel.node}`;
    if (this.sel.verified) return null;
    if (host === HOSTS.verify && protocol === 'tcp') {
      if (this.openActivationFor(leaf)) {
        this.sel.verifyOnlyReached = true;
        return null;
      }
      if (this.sel.verifyOnlyReached && this.routeOpPending()) return null;
      // 已写入收紧、Surge 尚未加载：只在仍有路由操作进行中（它负责读回并撤销）时放过；没有路由操作在进行中之后仍经未验证的
      // 出口发出（例如回滚按等满上限视为已阻断、SFE-ROUTE 仍是未验证的出口）就是放行窗口
      if (this.sel.verifyOnlyReached && this.routeOpInFlight() && !this.diskStillRoutes(processPath, host, protocol)) return null;
      return this.sel.verifyOnlyReached && !this.diskStillRoutes(processPath, host, protocol)
        ? '检测主机经 SFE-ROUTE 到达未验证的出口：已写入的收紧内容 Surge 尚未加载，而已没有路由操作在进行中'
        : '检测主机经 SFE-ROUTE 到达一个没有在实测中的未验证出口';
    }
    return '经 SFE-ROUTE 到达本次选择之后没有通过 Safari 实测的出口（不是 VERIFY_ONLY 的检测主机流量）';
  }

  routeDesc(): string {
    const r = this.h.repos.routeState.get();
    return `${r.phase}/${r.entryMode}`;
  }

  sampleI5(ctx: string): void {
    this.stats.i5Samples++;
    for (const path of SAFARI_FAMILY) {
      for (const hk of HOST_KEYS) {
        for (const proto of PROTOS) {
          const t = this.truth(path, HOSTS[hk], proto);
          if (!routes(t)) continue;
          const why = this.routeDenied(path, HOSTS[hk], proto, t.leaf);
          if (why) {
            this.violate(
              'I5',
              `I5|${hk === 'verify' && proto === 'tcp' ? 'verify-tcp' : 'other-host-or-udp'}|route=${this.routeDesc()}`,
              `${ctx}：新的 Safari 请求（${short(path)} ${HOSTS[hk]} ${proto}）命中「${t.rule}」→ ${t.policy}/${t.leaf}：${why}`,
            );
          }
        }
      }
    }
    for (const hk of HOST_KEYS) {
      for (const proto of PROTOS) {
        const t = this.truth(FAKE_CHROME_PATH, HOSTS[hk], proto);
        if (routes(t) || this.ours(t)) this.violate('I5', `I5|chrome-hits-entry|${hk}/${proto}`, `${ctx}：Chrome 请求 ${HOSTS[hk]} ${proto} 命中「${t.rule}」→ ${t.policy}`);
      }
    }
  }

  /** Safari / Chrome 打开一个长连接（被拒绝的请求不会留在活动列表中）。 */
  open(processPath: string, hk: HostKey, proto: Proto, ctx: string): SimulatedRequest {
    const r = this.h.fake.simulateRequest({ processPath, host: HOSTS[hk], protocol: proto, longLived: true });
    if (SAFARI_FAMILY.includes(processPath) && !r.failed && (r.policyName === ROUTE_GROUP_NAME || isSfe(r.leafPolicyName))) {
      const why = this.routeDenied(processPath, HOSTS[hk], proto, r.leafPolicyName);
      if (why) this.violate('I5', `I5|${hk === 'verify' && proto === 'tcp' ? 'verify-tcp' : 'other-host-or-udp'}|route=${this.routeDesc()}`, `Safari 新请求（${short(processPath)} ${HOSTS[hk]} ${proto}）经 ${r.rule} → ${r.policyName}/${r.leafPolicyName}：${why}`);
    }
    if (processPath === FAKE_CHROME_PATH && (r.policyName === ROUTE_GROUP_NAME || isSfe(r.leafPolicyName))) {
      this.violate('I5', `I5|chrome-routed|${hk}/${proto}`, `Chrome 请求经 ${r.rule} → ${r.policyName}`);
    }
    return r;
  }

  // ----- I3：引擎结束连接 -----

  onKill(id: string): void {
    if (!this.ready) return;
    this.stats.kills++;
    const rec = this.internals.active.get(id);
    if (!rec || rec.completed) return;
    const op = this.currentOp();
    const opDesc = op ? `${op.kind}/${op.phase}` : 'request';
    if (rec.processPath === null || !SAFARI_FAMILY.includes(rec.processPath)) {
      this.violate('I3', `I3|non-safari-killed|${short(rec.processPath)}|op=${op?.kind ?? 'request'}`, `引擎结束了非 Safari 连接 #${id}（${short(rec.processPath)} ${rec.remoteHost} ${rec.protocol} → ${rec.policyName}），操作 ${opDesc}`);
      return;
    }
    // 被换掉（已不在配置中）的 Safari 进程路径上的连接
    if (!this.configuredPaths().includes(rec.processPath)) this.cov.killRetiredPath++;
    if (mayBuyer(rec)) return;
    const t = this.truth(rec.processPath, rec.remoteHost ?? '', rec.protocol ?? 'tcp');
    if (!t.rejected && !this.disjointUserRule(t)) {
      this.violate(
        'I3',
        `I3|safari-original-rules-killed|op=${op?.kind ?? 'request'}|configured=${this.configuredPaths().includes(rec.processPath)}`,
        `入口按 FakeSurge 求值不阻断 ${short(rec.processPath)}（${rec.remoteHost} ${rec.protocol} 新请求命中「${t.rule}」→ ${t.policy}），引擎却结束了不在买家出口上的 Safari 连接 #${id}（→ ${rec.policyName}/${rec.leafPolicyName}），操作 ${opDesc}`,
      );
    }
  }

  // ----- 记录 -----

  violate(inv: string, sig: string, detail: string): void {
    if (this.violations.some((v) => v.sig === sig)) return;
    this.violations.push({ inv, sig, detail, at: this.eventIndex, state: this.stateDump() });
    this.trace.push(`   ✗ ${inv}: ${detail}`);
  }

  stateDump(): string {
    if (!this.ready) return '';
    const { repos } = this.h;
    const r = repos.routeState.get();
    const op = r.operationId ? repos.operations.get(r.operationId) : null;
    const steps = op ? repos.operations.listSteps(op.id).slice(-3).map((s) => s.message) : [];
    const conns = this.activeConns().map((c) => `#${c.id} ${short(c.processPath)} ${c.remoteHost} ${c.protocol} → ${c.policyName}/${c.leafPolicyName}`);
    let entry: string;
    if (this.header.strategy === 'temp_rule') entry = `临时规则 ${JSON.stringify(this.h.fake.tempRules)}`;
    else {
      entry = ['udp', 'verify', 'block', 'active']
        .map((b) => {
          const loaded = this.h.fake.loadedContent(`ruleset:sfe-entry-${b}.list`) ?? '';
          return `${b}=${/PROCESS-NAME,\/Applications\/(Safari|Safari Technology)/.test(loaded) ? 'on' : 'off'}(已加载)`;
        })
        .join(' ');
    }
    return [
      `路由：phase=${r.phase} entry=${r.entryMode} active=${r.activeEnvironmentId} selected=${r.selectedNode} epoch=${r.routeEpoch} warnings=${JSON.stringify(r.warnings)} snapshot=${r.activationSnapshot ? 'yes' : 'no'}`,
      `持久标记=${safariMayUseRouteMarked(this.h.app.engine)} normalModeOffered=${this.h.app.views.routeView().normalModeOffered} 进程路径=${JSON.stringify(this.configuredPaths().map(short))}`,
      `路由操作：${op ? `${op.kind} ${op.phase}/${op.status}` : '无'}${steps.length ? ` 最后步骤：${steps.join(' ｜ ')}` : ''}`,
      `入口：${entry}；SFE-ROUTE 选择=${this.internals.selection.get(ROUTE_GROUP_NAME)}（本期 ${this.sel.verified ? '已实测' : '未实测'}）`,
      `活动连接：${conns.length ? conns.join('；') : '无'}`,
    ].join('\n      ');
  }

  // ----- 调用与等待 -----

  private raceCrash<T>(p: Promise<T>): Promise<T | typeof CRASHED> {
    const guards: Array<Promise<T | typeof CRASHED>> = [p];
    if (this.crashSig) guards.push(this.crashSig.promise.then(() => CRASHED));
    let timer: NodeJS.Timeout | undefined;
    guards.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Hang('调用超过 20 秒没有结束')), CALL_TIMEOUT_MS);
      }),
    );
    return Promise.race(guards).finally(() => clearTimeout(timer));
  }

  async call<T>(p: Promise<T>): Promise<CallResult<T>> {
    try {
      const v = await this.raceCrash(p);
      if (v === CRASHED) return CRASHED;
      return { ok: true, value: v };
    } catch (e) {
      if (e instanceof Hang) throw e;
      if (e instanceof SfeError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
      return { ok: false, error: { code: 'THROWN', message: e instanceof Error ? e.message : String(e) } };
    }
  }

  async native(profile: string | null, message: Parameters<Harness['native']>[1]): Promise<CallResult<unknown>> {
    const r = await this.call(this.h.native(profile, message));
    if (r === CRASHED || !r.ok) return r;
    const resp = r.value as NativeResponse;
    if (resp.ok) return { ok: true, value: resp.data };
    return { ok: false, error: { code: resp.error.code, message: resp.error.message, details: resp.error.details as Record<string, unknown> | undefined } };
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      if (this.crashed) {
        this.crashed = false;
        this.crashSig = null;
        this.trace.push('   ↻ 服务重启（同一数据库与 Surge），恢复未完成的操作');
        await this.call(this.h.crash());
      }
      const r = await this.raceCrash(this.h.idle());
      if (r !== CRASHED) return;
    }
  }

  boundProfileOf(envId: string): string | null {
    return this.h.repos.profileBindings.byEnvironment(envId)?.profileId ?? null;
  }

  isBound(profile: string): boolean {
    return this.h.repos.profileBindings.byProfile(profile) !== null;
  }

  /** 等待中的路由操作（激活或重测；最新的）。 */
  waitingRouteOp(): OperationRecord | null {
    const ops = this.h.repos.operations
      .listByStatus(['waiting'])
      .filter((op) => {
        const p = payloadOf(op).route;
        return p !== undefined && (p.stage === 'verify_only' || p.stage === 'probe_waiting');
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ops[0] ?? null;
  }
}

// ---------- 事件执行 ----------

async function confirmPaths(w: World, paths: string[]): Promise<boolean> {
  const { h } = w;
  const prop = await w.call(
    h.app.proposeCapability(
      {
        request_id: rid('prop'),
        key: 'safari_process_attribution',
        proposed_status: 'supported',
        context: { ...anyContext(), surgeVersion: h.fake.version, surgeBuild: h.fake.build, processPathsDigest: processPathsDigest(paths) },
        summary: '进程归属（合成）',
        evidence_digest: 'sha256:0123456789abcdef',
        protocol_coverage: FULL_COVERAGE,
        safari_process_paths: paths,
      },
      AGENT,
    ),
  );
  if (prop === CRASHED || !prop.ok) return false;
  const conf = await w.call(h.app.confirmCapability({ request_id: rid(), action: 'confirm', proposal_id: prop.value.proposal_id }, WEB));
  return conf !== CRASHED && conf.ok;
}

/**
 * 用户点「进入普通模式」。NEEDS_CONFIRMATION 按要求确认后重试（最多 3 次：并发的操作可能在两次请求之间改变使用中的环境）；
 * 其余任何拒绝（含 ROUTE_BUSY）都是 I4 违例，没有例外。受理的操作记入 acceptedNormals（L1）。返回操作 id，崩溃或被拒绝时为 null。
 */
async function normalMode(w: World, ev: Extract<Ev, { t: 'normal' }>, opts: { busy?: boolean; state?: CallState | 'idle' } = {}): Promise<string | null> {
  const { h } = w;
  const running = opts.busy ? w.h.app.executor.currentOperationId : null;
  const runningOp = running ? h.repos.operations.get(running) : null;
  const latency = w.latencyLong;
  let profile: string | null = null;
  let via = 'web';
  if (ev.via === 'bound') {
    const bound = [PROFILE_A, PROFILE_B].filter((p) => w.isBound(p));
    if (bound.length > 0) {
      profile = bound[ev.pick % bound.length]!;
      via = 'bound';
    }
  } else if (ev.via === 'unbound') {
    const unbound = [PROFILE_A, PROFILE_B].filter((p) => !w.isBound(p));
    if (unbound.length > 0) {
      profile = unbound[ev.pick % unbound.length]!;
      via = 'unbound';
    }
  }
  const send = async (req: NormalModeRequest): Promise<CallResult<{ operation_id: string }>> => {
    if (profile === null) return w.call(h.app.enterNormal(req, WEB));
    const r = await w.native(profile, { type: 'enterNormalMode', ...req });
    return r as CallResult<{ operation_id: string }>;
  };
  let r = await send({ request_id: rid('normal') });
  for (let i = 0; i < 3 && r !== CRASHED && !r.ok && r.error.code === 'NEEDS_CONFIRMATION'; i++) {
    const current = (r.error.details?.currentEnvironmentId as string | null | undefined) ?? null;
    r = await send({ request_id: rid('normal'), old_session_policy: ev.policy === 'closed' ? 'closed_confirmed' : 'keep_open_acknowledged', confirmed_environment_id: current });
  }
  if (r === CRASHED) return null;
  const during = opts.busy ? `，${opts.state ?? 'idle'}${runningOp ? `（${runningOp.kind} ${runningOp.phase}/${runningOp.status}）` : ''}进行中` : '';
  if (!r.ok) {
    w.violate(
      'I4',
      `I4|refused|${r.error.code}|via=${via}${opts.busy ? `|during=${opts.state ?? 'idle'}` : ''}`,
      `进入普通模式被拒绝（${via}${during}，路由 ${w.routeDesc()}，服务视图${h.app.views.routeView().normalModeOffered ? '' : '不'}提供普通模式）：${r.error.code} ${r.error.message}`,
    );
    return null;
  }
  const id = r.value.operation_id;
  w.trace.push(`   → 普通模式操作 ${id}（${via}${during}）`);
  if (!w.acceptedNormals.some((n) => n.id === id)) w.acceptedNormals.push({ id, latency, at: w.eventIndex, busy: opts.busy === true, checked: false });
  return id;
}

async function activate(w: World, ev: Extract<Ev, { t: 'activate' }>): Promise<void> {
  const { h } = w;
  if (w.envs.length === 0) return;
  const envId = w.envs[ev.e % w.envs.length]!;
  const profile = ev.via === 'profile' ? w.boundProfileOf(envId) : null;
  const send = async (req: ActivateRequest): Promise<CallResult<{ operation_id: string }>> => {
    if (profile === null) return w.call(h.app.activate(envId, req, WEB));
    const r = await w.native(profile, { type: 'activateCurrentEnvironment', environment_id: envId, amazon_tabs_open: false, ...req });
    return r as CallResult<{ operation_id: string }>;
  };
  const route = h.repos.routeState.get();
  const req: ActivateRequest = { request_id: rid('act') };
  if (ev.policy !== 'none') {
    req.old_session_policy = ev.policy === 'closed' ? 'closed_confirmed' : 'keep_open_acknowledged';
    req.confirmed_environment_id = ev.confirm === 'right' ? route.activeEnvironmentId : route.activeEnvironmentId === null ? w.envs.find((e) => e !== envId) ?? null : null;
  }
  let r = await send(req);
  if (r !== CRASHED && !r.ok && r.error.code === 'NEEDS_CONFIRMATION' && ev.onNeed === 'retry') {
    const current = (r.error.details?.currentEnvironmentId as string | null | undefined) ?? null;
    r = await send({ request_id: rid('act'), old_session_policy: ev.policy === 'keep' ? 'keep_open_acknowledged' : 'closed_confirmed', confirmed_environment_id: current });
  }
  if (r !== CRASHED) w.trace.push(r.ok ? `   → 激活操作 ${r.value.operation_id}` : `   → 激活被拒绝：${r.error.code}`);
}

async function verifyEv(w: World, ev: Extract<Ev, { t: 'verify' }>): Promise<void> {
  const { h } = w;
  const op = w.waitingRouteOp();
  if (!op) {
    // 轨迹中写明为什么没有可实测的操作（最近的路由操作停在哪里），便于判断生成器为何没有到达核对或回滚
    const last = h.repos.operations.listRecent(20).find((o) => o.kind === 'route.activate' || o.kind === 'probe.safari' || payloadOf(o).route !== undefined);
    w.trace.push(`   → 没有等待实测的切换或检测${last ? `（最近的路由操作 ${last.kind} ${last.phase}/${last.status}${last.error ? ` ${last.error.code} ${last.error.message}` : ''}）` : ''}`);
    return;
  }
  const p = payloadOf(op).route!;
  const profile = w.boundProfileOf(p.targetEnvironmentId);
  if (!profile) {
    w.trace.push('   → 等待实测的操作的环境没有关联场景，无法实测');
    return;
  }
  const begin = await w.native(profile, { type: 'beginSafariVerification', operation_id: op.id, amazon_tabs_open: ev.tabs });
  if (begin === CRASHED || !begin.ok) {
    if (begin !== CRASHED) w.trace.push(`   → 签发检测编号失败：${begin.error.code}`);
    return;
  }
  const data = begin.value as { status: string; test_id?: string; route_epoch?: number };
  if (data.status !== 'ready') return;
  if (ev.outcome === 'timeout') {
    const s = h.repos.settings;
    h.clock.advance(Math.max(s.get('safariVerifyTimeoutSec'), s.get('profileArrivalTimeoutSec')) * 1000 + 1000);
    w.trace.push('   → 实测超时（时钟推进到截止时间之后）');
    return;
  }
  // 时间在用户操作之间流逝：之前记录的请求不落在本次检测的时间窗（含 2 秒容差）内（假时钟不会自己走）
  h.clock.advance(5000);
  const started = h.clock.now().toISOString();
  let good = false;
  if (ev.outcome !== 'no_request') {
    const paths = w.configuredPaths();
    const path = ev.outcome === 'chrome' ? FAKE_CHROME_PATH : (paths[0] ?? FAKE_SAFARI_PATH);
    const sim = ev.longLived ? w.open(path, 'verify', 'tcp', 'verify') : h.fake.simulateRequest({ processPath: path, host: FAKE_VERIFY_HOST, protocol: 'tcp' });
    if (!ev.longLived && SAFARI_FAMILY.includes(path) && !sim.failed && sim.policyName === ROUTE_GROUP_NAME) {
      // 短请求同样检查放行窗口
      w.sampleI5('request:verify');
    }
    good = ev.outcome === 'pass' && paths.includes(path) && !sim.failed && sim.policyName === ROUTE_GROUP_NAME && sim.leafPolicyName === p.nodeName;
  }
  const finished = h.clock.now().toISOString();
  const sub = await w.native(profile, {
    type: 'submitSafariVerification',
    operation_id: op.id,
    test_id: data.test_id!,
    route_epoch: data.route_epoch!,
    observed_ip: '192.0.2.50',
    http_status: ev.outcome === 'http_fail' ? 503 : 200,
    error: null,
    started_at: started,
    finished_at: finished,
  });
  if (sub === CRASHED) {
    // 提交已受理（检测编号已消费、结果已记入操作）而服务在之后的核对中崩溃：崩溃恢复按提交的结果重新核对（重测，§6.1），它照样是
    // 本测试提交的实测——按数据库中记下的提交判断（原生桥的应答随崩溃丢失）
    const stored = payloadOf(h.repos.operations.get(op.id) ?? op).route?.submission?.testId === data.test_id;
    if (stored) {
      w.trace.push(`   → 提交实测（${ev.outcome}${good ? '，真实通过' : ''}）：已受理（之后服务崩溃）`);
      if (good) {
        w.goodSubmissions.add(op.id);
        if (w.sel.node === p.nodeName) w.sel.verified = true;
      }
    }
    return;
  }
  w.trace.push(`   → 提交实测（${ev.outcome}${good ? '，真实通过' : ''}）：${sub.ok ? '已受理' : sub.error.code}`);
  if (sub.ok && good) {
    w.goodSubmissions.add(op.id);
    if (w.sel.node === p.nodeName) w.sel.verified = true;
  }
}

async function exec(w: World, ev: Ev): Promise<void> {
  const { h } = w;
  switch (ev.t) {
    case 'create': {
      if (w.envs.length >= 3) return;
      const i = w.envs.length;
      const r = await w.call(h.app.createEnvironment({ request_id: rid('create'), environment: envInput(`Buyer-${i + 1}`, `203.0.113.${10 + i}`) }, WEB));
      if (r !== CRASHED && r.ok && r.value.environment_id) w.envs.push(r.value.environment_id);
      return;
    }
    case 'bind': {
      if (w.envs.length === 0) return;
      const profile = PROFILES[ev.p]!;
      const envId = w.envs[ev.e % w.envs.length]!;
      const env = h.repos.environments.get(envId);
      if (!env || w.isBound(profile) || w.boundProfileOf(envId)) return;
      await w.native(profile, { type: 'bindCurrentProfile', request_id: rid('bind'), environment_id: envId, expected_revision: env.revision });
      return;
    }
    case 'publish':
      await w.call(h.app.publishPending({ request_id: rid('pub') }, WEB));
      return;
    case 'activate':
      await activate(w, ev);
      return;
    case 'verify':
      w.quietVerify = true;
      try {
        await verifyEv(w, ev);
      } finally {
        w.quietVerify = false;
      }
      return;
    case 'probe': {
      if (w.envs.length === 0) return;
      const envId = w.envs[ev.e % w.envs.length]!;
      const profile = ev.via === 'profile' ? w.boundProfileOf(envId) : null;
      const r = profile
        ? await w.native(profile, { type: 'probeCurrentEnvironment', request_id: rid('probe'), environment_id: envId, kind: ev.kind })
        : await w.call(h.app.probe(envId, { request_id: rid('probe'), kind: ev.kind }, WEB));
      if (r !== CRASHED) w.trace.push(r.ok ? `   → 检测操作已受理（${ev.kind}）` : `   → 检测被拒绝：${r.error.code}`);
      return;
    }
    case 'cancel': {
      const op = w.waitingRouteOp();
      if (!op) return;
      const target = payloadOf(op).route!.targetEnvironmentId;
      const profile = ev.via === 'profile' ? w.boundProfileOf(target) : null;
      if (profile) await w.native(profile, { type: 'cancelOperation', request_id: rid('cancel'), operation_id: op.id });
      else await w.call(h.app.cancelOperation(op.id, { request_id: rid('cancel') }, WEB));
      return;
    }
    case 'normal':
      // 结束状态由 checkNormals 在执行器空闲后检查（L1）
      await normalMode(w, ev);
      return;
    case 'killFail':
      h.fake.failNext('killRequest');
      w.killFailPending = true;
      return;
    case 'heal':
      w.matchRuleUnavailable = false;
      w.latencyLong = false;
      h.fake.localWatchLatencyMs = 0;
      (h.fake as unknown as { faults: Map<string, unknown[]> }).faults.delete('killRequest');
      w.killFailPending = false;
      if (w.moduleRule) {
        h.fake.setModuleRules([]);
        w.moduleRule = null;
        w.externalDirty = true;
      }
      return;
    case 'matchRule':
      w.matchRuleUnavailable = !ev.available;
      return;
    case 'latency':
      w.latencyLong = ev.long;
      h.fake.localWatchLatencyMs = ev.long ? 60_000 : 0;
      return;
    case 'flush': {
      const rules = h.fake.tempRules;
      if (rules.length === 0) return;
      // 别的工具在 Surge 运行中清空临时规则（`rule temp flush`；不经引擎）
      for (const r of rules) await h.fake.removeTempRule(r);
      w.externalDirty = true;
      return;
    }
    case 'restart':
      h.fake.restart();
      w.externalDirty = true;
      return;
    case 'module':
      // 用户启用模块（不经引擎）：它的规则排在本应用入口之前，Safari 中被它匹配的请求按它发出
      w.moduleRule = { text: `DOMAIN-SUFFIX,${HOSTS[ev.host]},DIRECT`, host: ev.host };
      h.fake.setModuleRules([{ text: w.moduleRule.text, moduleName: 'fuzz-module' }]);
      w.externalDirty = true;
      return;
    case 'safari':
      w.open(ev.app === 'safari' ? FAKE_SAFARI_PATH : SAFARI_STP, ev.host, ev.proto, 'event');
      return;
    case 'chrome':
      w.open(FAKE_CHROME_PATH, ev.host, ev.proto, 'event');
      return;
    case 'paths': {
      const set = ev.set === 'safari' ? [FAKE_SAFARI_PATH] : ev.set === 'stp' ? [SAFARI_STP] : [FAKE_SAFARI_PATH, SAFARI_STP];
      const ok = await confirmPaths(w, set);
      w.trace.push(`   → 进程路径提议 ${set.map(short).join('+')}：${ok ? '已确认' : '未确认'}`);
      if (ok) w.stats.pathChanges++;
      if (ok && ev.regrant) h.grant(ALL_CAPS);
      return;
    }
    case 'crash':
      if (ev.nth === 0) {
        w.stats.crashesIdle++;
        await w.call(h.crash());
      } else {
        w.crashArm = { countdown: ev.nth, after: ev.after, when: ev.when ?? 'any' };
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        w.crashSig = { promise, resolve };
      }
      return;
    case 'reconcile':
      if (ev.kind === 'periodic') await w.call(h.app.runPeriodicReconcile());
      else await w.call(h.app.refreshSurge(WEB));
      return;
    case 'advance':
      h.clock.advance(ev.ms);
      return;
    case 'popup': {
      const profile = PROFILES[ev.p]!;
      const activity = w.opActivity;
      const r = await w.native(profile, { type: 'getCurrentState' });
      if (r === CRASHED) return;
      if (!r.ok) {
        w.violate('I6', `I6|popup-failed|${r.error.code}`, `扩展读取状态失败：${r.error.code} ${r.error.message}`);
        return;
      }
      // 原生调用返回时（结算之前）的服务视图与 Safari 连接：之后的结算会执行调用期间受理的操作（例如 normalDuring 在动作前检查的
      // Surge 调用中受理的普通模式），它们改写的路由不在这个响应中。调用期间有执行器中的操作在运行（调用 Surge 或写路由记录）时，
      // 响应可能早于它们的写入：比较不成立时只计数，不判违例
      const route = h.repos.routeState.get();
      const view = h.app.views.routeView();
      const buyerConns = w.safariConns().filter(mayBuyer);
      const raced = w.opActivity !== activity || h.app.executor.currentOperationId !== null;
      const resp = r.value as { routeSummary: RouteSummaryView; route: { entryMode: string; phase: string; warnings: string[]; normalModeOffered: boolean } | null };
      const summary = resp.routeSummary;
      if (resp.route && (resp.route.entryMode !== summary.entryMode || resp.route.phase !== summary.phase)) {
        // 同一个响应里的完整路由（动作前对账之后读取）与路由摘要（对账之前读取）不一致：弹窗顶栏按摘要显示
        w.violate(
          'I6',
          'I6|popup-summary-stale-within-response',
          `扩展同一响应中：路由摘要 entry=${summary.entryMode} phase=${summary.phase}，完整路由 entry=${resp.route.entryMode} phase=${resp.route.phase} warnings=${JSON.stringify(resp.route.warnings)}`,
        );
      } else if (
        summary.entryMode !== route.entryMode ||
        summary.normalModeOffered !== view.normalModeOffered ||
        summary.buyerExitConnectionsUnconfirmed !== route.warnings.includes('buyer_exit_connections_unconfirmed') ||
        // 顶栏不按未经确认的入口声称已阻断或托管中（entryUnconfirmed）
        summary.entryUnconfirmed !== (route.warnings.includes('entry_unverified') || route.warnings.includes('precedence_violation'))
      ) {
        if (raced) w.cov.popupRaceSkipped++;
        else w.violate('I6', 'I6|popup-summary-mismatch', `扩展路由摘要 ${JSON.stringify(summary)} 与原生调用返回时的服务视图（entry=${route.entryMode} offered=${view.normalModeOffered} warnings=${JSON.stringify(route.warnings)}）不一致`);
      }
      if (!summary.normalModeOffered && buyerConns.length > 0) {
        if (raced) w.cov.popupRaceSkipped++;
        else w.violate('I1', `I1|popup|${route.phase}/${route.entryMode}`, `扩展（${profile === null ? '未识别场景' : profile}）没有提供普通模式，而 Safari 仍有可能在买家出口上的连接`);
      }
      return;
    }
    case 'report':
      await w.native(PROFILES[ev.p]!, { type: 'reportProfileState', windows_open: ev.windows, amazon_tabs_open: false, site_permission_granted: true });
      return;
    case 'busy':
      w.busy = { rate: ev.rate, rng: mulberry32(ev.rs) };
      return;
    case 'normalDuring':
      w.normalArm = { countdown: ev.nth, via: ev.via, when: ev.when ?? 'any' };
      return;
  }
}

// ---------- 空闲时的不变量 ----------

/**
 * L1：每个受理的普通模式（含 normalDuring 排队受理的）在执行器空闲后都已结束（不停在 queued/running/waiting）；受理时与检查时
 * 文件监视延迟都短时，结束为 NORMAL_RESTORED。唯一的例外是文件监视比等待上限慢（撤销入口按时限等满，§5.5）。
 */
function checkNormals(w: World): void {
  const { repos } = w.h;
  for (const n of w.acceptedNormals) {
    if (n.checked) continue;
    const op = repos.operations.get(n.id);
    if (!op) continue;
    const where = `受理于事件 #${n.at}${n.busy ? '（normalDuring，其他操作进行中）' : ''}`;
    if (op.status === 'queued' || op.status === 'running' || op.status === 'waiting') {
      w.violate('L1', `L1|normal-not-terminal|${op.status}|busy=${n.busy}`, `普通模式 ${op.id}（${where}）在执行器空闲后仍是 ${op.phase}/${op.status}，没有结束`);
      continue;
    }
    n.checked = true;
    if (op.phase === 'NORMAL_RESTORED') {
      w.stats.normalRestored++;
      continue;
    }
    w.stats.normalFailed++;
    w.trace.push(`   → 普通模式 ${op.id} 结束为 ${op.phase}：${op.error?.code} ${op.error?.message}`);
    if (!n.latency && !w.latencyLong) {
      w.violate(
        'L1',
        `L1|normal-not-restored|${op.phase}|${op.error?.code}|busy=${n.busy}`,
        `文件监视延迟短，普通模式 ${op.id}（${where}）却结束为 ${op.phase}：${op.error?.code} ${op.error?.message}（路由 ${w.routeDesc()}）`,
      );
    }
  }
  // L1b：按受理顺序（rowid）最后一个路由操作是已 NORMAL_RESTORED 的普通模式时，路由仍是它留下的空闲 NORMAL
  const ids = repos.db.all<{ id: string }>('SELECT id FROM operations ORDER BY rowid').map((r) => r.id);
  for (let i = ids.length - 1; i >= 0; i--) {
    const op = repos.operations.get(ids[i]!);
    if (!op) continue;
    const routeOp = op.kind === 'route.activate' || op.kind === 'route.normal' || op.kind === 'probe.safari' || payloadOf(op).route !== undefined;
    if (!routeOp) continue;
    if (op.kind !== 'route.normal' || op.phase !== 'NORMAL_RESTORED') break;
    const route = repos.routeState.get();
    if (route.entryMode !== 'NORMAL' || route.phase !== 'idle') {
      const owner = route.operationId ? repos.operations.get(route.operationId) : null;
      w.violate(
        'L1',
        `L1|normal-overwritten|${route.entryMode}|${route.phase}|${owner?.kind ?? '-'}`,
        `普通模式 ${op.id} 已 NORMAL_RESTORED、之后没有受理新的路由操作，路由却是 ${w.routeDesc()}（记在 ${owner ? `${owner.kind} ${owner.id} ${owner.phase}` : '无'} 名下）`,
      );
    }
    break;
  }
}

function checkIdle(w: World): void {
  const { h } = w;
  const { repos } = h;
  w.sampleI5('idle');
  const route = repos.routeState.get();
  const view = h.app.views.routeView();

  // I1
  for (const c of w.safariConns()) {
    if (!mayBuyer(c)) continue;
    const exempt = route.phase === 'active_verified' && route.entryMode === 'ACTIVE' && c.leafPolicyName === route.selectedNode;
    if (!view.normalModeOffered && !exempt) {
      w.violate(
        'I1',
        `I1|${route.phase}/${route.entryMode}|marker=${safariMayUseRouteMarked(h.app.engine)}|${c.policyName === ROUTE_GROUP_NAME ? 'SFE-ROUTE' : 'other'}`,
        `Safari 连接 #${c.id}（${short(c.processPath)} ${c.remoteHost} ${c.protocol} → ${c.policyName}/${c.leafPolicyName}）可能在买家出口上，服务视图却不提供普通模式`,
      );
    }
  }

  // I2 + I6（完成说明）
  const op = route.operationId ? repos.operations.get(route.operationId) : null;
  if (op?.kind === 'route.normal' && op.phase === 'NORMAL_RESTORED') {
    const clean = !route.warnings.includes('buyer_exit_connections_unconfirmed') && !route.warnings.includes('entry_unverified');
    const claimsOriginal = repos.operations.listSteps(op.id).at(-1)?.message === NORMAL_DONE_TEXT;
    for (const c of w.safariConns()) {
      if (c.policyName !== ROUTE_GROUP_NAME && !isSfe(c.leafPolicyName)) continue;
      if (clean) w.violate('I2', `I2|${short(c.processPath)}|${route.phase}/${route.entryMode}`, `普通模式 ${op.id} 已完成且路由没有警告，Safari 连接 #${c.id}（${short(c.processPath)} ${c.remoteHost} ${c.protocol}）仍在 ${c.policyName}/${c.leafPolicyName} 上`);
      if (claimsOriginal) w.violate('I6', 'I6|done-text-but-buyer-conn', `普通模式 ${op.id} 的完成说明是「${NORMAL_DONE_TEXT}」，而 Safari 连接 #${c.id} 仍在 ${c.policyName}/${c.leafPolicyName} 上`);
    }
    if (claimsOriginal && !w.externalDirty && route.phase === 'idle' && route.entryMode === 'NORMAL') {
      for (const path of SAFARI_FAMILY) for (const hk of HOST_KEYS) for (const proto of PROTOS) {
        const t = w.truth(path, HOSTS[hk], proto);
        if (w.ours(t)) w.violate('I6', 'I6|done-text-but-entry', `普通模式 ${op.id} 的完成说明是「${NORMAL_DONE_TEXT}」，而 ${short(path)} ${HOSTS[hk]} ${proto} 新请求命中本应用入口「${t.rule}」→ ${t.policy}`);
      }
    }
  }

  // I6（回滚完成说明）：「Safari 保持阻断」——只在路由仍是这次回滚留下的状态（failed/BLOCKED）时核对；之后对账按事实改成
  // UNKNOWN 等，说明就只是当时的记录
  // 回滚无法确认（BLOCKED_NEEDS_ATTENTION）的说明「Safari 保持已确认的阻断」同样只在路由仍是它留下的状态（attention/BLOCKED）时核对。
  // 切换前 SFE-ROUTE 已改选 REJECT 的回滚（RollbackResult.rejectKept）留下 attention/BLOCKED，说明同样是「Safari 保持阻断」
  const rollbackClaim =
    op && op.kind !== 'route.normal' && route.entryMode === 'BLOCKED' && !w.externalDirty
      ? op.phase === 'FAILED' && (route.phase === 'failed' || (route.phase === 'attention' && route.operationId === op.id))
        ? 'Safari 保持阻断'
        : op.phase === 'BLOCKED_NEEDS_ATTENTION' && route.phase === 'attention' && route.operationId === op.id
          ? 'Safari 保持已确认的阻断'
          : null
      : null;
  if (op && rollbackClaim) {
    const last = repos.operations.listSteps(op.id).at(-1)?.message ?? '';
    if (last.includes(rollbackClaim)) {
      for (const path of w.configuredPaths()) for (const hk of HOST_KEYS) for (const proto of PROTOS) {
        const t = w.truth(path, HOSTS[hk], proto);
        if (!t.rejected && !w.disjointUserRule(t)) {
          w.violate(
            'I6',
            `I6|rollback-text-claims-blocked|${op.phase}|entry_unverified=${route.warnings.includes('entry_unverified')}`,
            `操作 ${op.id} 的完成说明是「${last}」，而 ${short(path)} ${HOSTS[hk]} ${proto} 新请求按 FakeSurge 求值命中「${t.rule}」→ ${t.policy}${t.leaf ? `/${t.leaf}` : ''}`,
          );
        }
      }
    }
  }

  // I4：从不重载
  if ((h.fake.calls.reloadProfile ?? 0) > 0 || h.fake.reloadCount > 0) w.violate('I4', 'I4|reload', `配置被重载（reloadProfile ${h.fake.calls.reloadProfile ?? 0} 次）`);

  // I5b：ACTIVE_VERIFIED 只在真实通过的实测之后
  for (const o of repos.operations.listRecent(60)) {
    if (o.phase !== 'ACTIVE_VERIFIED' || w.checkedCommits.has(o.id)) continue;
    w.checkedCommits.add(o.id);
    w.stats.activeVerified++;
    if ((o.result as { reused?: boolean } | null)?.reused === true) continue;
    if (!w.goodSubmissions.has(o.id)) w.violate('I5', `I5b|commit-without-good-verification|${o.kind}`, `操作 ${o.id}（${o.kind}）以 ACTIVE_VERIFIED 结束，但本测试没有为它提交真实通过的 Safari 实测`);
  }

  // I6：路由视图声称的入口状态
  if (!w.externalDirty && !route.warnings.includes('entry_unverified')) {
    const paths = w.configuredPaths();
    const claim = route.entryMode;
    const check = (path: string, hk: HostKey, proto: Proto, want: 'original' | 'rejected'): void => {
      const t = w.truth(path, HOSTS[hk], proto);
      const bad = want === 'original' ? w.ours(t) || routes(t) : !t.rejected && !w.disjointUserRule(t);
      if (bad) {
        w.violate(
          'I6',
          `I6|claim=${claim}|want=${want}|${route.phase}`,
          `路由视图声称入口 ${claim}（phase ${route.phase}），${short(path)} ${HOSTS[hk]} ${proto} 新请求按 FakeSurge 求值却命中「${t.rule}」→ ${t.policy}${t.leaf ? `/${t.leaf}` : ''}`,
        );
      }
    };
    for (const hk of HOST_KEYS) {
      for (const proto of PROTOS) {
        if (claim === 'NORMAL') for (const path of SAFARI_FAMILY) check(path, hk, proto, 'original');
        if (claim === 'BLOCKED') for (const path of paths) check(path, hk, proto, 'rejected');
        if (claim === 'VERIFY_ONLY' && !(hk === 'verify' && proto === 'tcp')) for (const path of paths) check(path, hk, proto, 'rejected');
        if (claim === 'ACTIVE' && proto === 'udp') for (const path of paths) check(path, hk, proto, 'rejected');
      }
    }
  }

  if (route.warnings.includes('buyer_exit_connections_unconfirmed')) w.stats.becWarnings++;
  if (route.phase === 'attention') w.stats.attention++;
}

// ---------- 一次运行 ----------

async function runSequence(header: Header, events: readonly Ev[], opts: { trace?: boolean } = {}): Promise<World> {
  const w = new World(header);
  w.h = await createHarness({
    entryStrategy: header.strategy,
    surge: (fake) => w.wrap(fake),
    rulesetWatch: { timeoutMs: 30, pollMs: 10 },
  });
  const { h } = w;
  h.fake.tempRuleInsertion = header.insertion;
  // 路由记录写入：重新读取过事实（对账、入口切换）之后，外部改动之前的声明不再是旧的
  const update = h.repos.routeState.update.bind(h.repos.routeState);
  h.repos.routeState.update = ((patch: Parameters<typeof update>[0]) => {
    const r = update(patch);
    if (patch && ('lastReconciledAt' in patch || 'entryMode' in patch)) w.externalDirty = false;
    if (w.h.app.executor.currentOperationId !== null) w.opActivity++;
    return r;
  }) as typeof update;
  w.traceCalls = opts.trace === true && TRACE_CALLS;
  w.ready = true;
  w.stats.runs = 1;
  try {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      w.eventIndex = i;
      w.stats.events++;
      w.trace.push(`#${i} ${describeEv(ev)}`);
      const armed = ev.t === 'crash' && ev.nth > 0;
      const normalArmed = ev.t === 'normalDuring';
      await exec(w, ev);
      await w.settle();
      while (w.pending.length > 0) {
        await w.call(Promise.all(w.pending.splice(0)));
        await w.settle();
      }
      if (!armed) {
        w.crashArm = null;
        w.crashSig = null;
      }
      if (!normalArmed) w.normalArm = null;
      w.countYields();
      checkNormals(w);
      checkIdle(w);
    }
    w.stats.rollbacks = h.repos.operations.listRecent(500).filter((o) => (o.result as { rollback?: unknown } | null)?.rollback !== undefined).length;
  } catch (e) {
    if (!(e instanceof Hang)) throw e;
    w.violate('HANG', `HANG|${describeEv(events[w.eventIndex]!).split(' ')[0]}`, `事件 #${w.eventIndex} 之后调用没有结束：${e.message}`);
  } finally {
    if (opts.trace) console.log(w.trace.join('\n'));
    await h.close();
  }
  return w;
}

// ---------- 缩减 ----------

async function shrink(header: Header, events: Ev[], sig: string, budget: number): Promise<{ events: Ev[]; world: World }> {
  let cur = events;
  let replays = 0;
  let best: World | null = null;
  const fails = async (cand: Ev[]): Promise<World | null> => {
    replays++;
    const w = await runSequence(header, cand);
    return w.violations.some((v) => v.sig === sig) ? w : null;
  };
  let chunk = Math.max(1, Math.ceil(cur.length / 2));
  while (chunk >= 1 && replays < budget) {
    let removed = false;
    for (let i = 0; i < cur.length && replays < budget; ) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      const w = cand.length > 0 ? await fails(cand) : null;
      if (w) {
        const v = w.violations.find((x) => x.sig === sig)!;
        cur = cand.slice(0, v.at + 1);
        best = w;
        removed = true;
      } else i += chunk;
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  if (!best) best = await runSequence(header, cur);
  return { events: cur, world: best };
}

// ---------- 测试 ----------

const SEEDS = Number(process.env.SFE_FUZZ_SEEDS ?? 10);
const SEED_BASE = Number(process.env.SFE_FUZZ_SEED_BASE ?? 1);
const ONLY_SEED = process.env.SFE_FUZZ_SEED !== undefined ? Number(process.env.SFE_FUZZ_SEED) : null;
const SHRINK_BUDGET = Number(process.env.SFE_FUZZ_SHRINK ?? 60);
const TRACE_CALLS = process.env.SFE_FUZZ_CALLS === '1';
const EVENTS_JSON = process.env.SFE_FUZZ_EVENTS ?? null;
const STRATEGIES = (['ruleset_resource', 'temp_rule'] as const).filter((s) => !process.env.SFE_FUZZ_STRATEGY || process.env.SFE_FUZZ_STRATEGY === s);
/** 每种策略至少这么多个种子时断言 TARGETED 覆盖项都出现过。 */
const COVERAGE_ASSERT_MIN_SEEDS = 100;

function headerFor(strategy: Header['strategy'], seed: number): Header {
  return { strategy, seed, insertion: mulberry32(seed * 31 + 7)() < 0.5 ? 'head' : 'tail' };
}

interface Found {
  header: Header;
  events: Ev[];
  violation: Violation;
  count: number;
  seeds: number[];
}

/**
 * 随机运行（每种策略 2×300 个种子）缩减出的最小轨迹，以及按同一夹具构造的一条轨迹（I5 回滚恢复之前的买家出口）。逐条回放，
 * 断言没有违例；修复之前它们复现各自的违例。
 */
const MINIMAL_TRACES: Array<{ name: string; strategies: ReadonlyArray<Header['strategy']>; events: Ev[] }> = [
  {
    name: 'I6: 等待实测期间用户启用排在入口之前的模块规则（站点主机），取消：回滚说明「Safari 保持已确认的阻断」，而站点请求按该规则直连',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'activate', e: 0, via: 'profile', policy: 'none', confirm: 'right', onNeed: 'retry' },
      { t: 'module', host: 'site' },
      { t: 'cancel', via: 'web' },
    ],
  },
  {
    name: 'I3/I6（不是违例）：排在入口之前、与受保护主机不相交的用户规则（daily）匹配的请求不在入口状态的声明之内（§5.5 优先级检查按设计忽略）',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'module', host: 'daily' },
      { t: 'killFail' },
      { t: 'safari', host: 'daily', proto: 'udp', app: 'safari' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'activate', e: 0, via: 'profile', policy: 'none', confirm: 'right', onNeed: 'retry' },
      { t: 'verify', outcome: 'pass', longLived: false, tabs: false },
    ],
  },
  {
    name: 'I3: rule match 不可用、文件监视比等待慢时，普通模式在未确认的阻断下结束按原规则发出的 Safari 连接',
    strategies: ['ruleset_resource'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'matchRule', available: false },
      { t: 'latency', long: true },
      { t: 'activate', e: 0, via: 'profile', policy: 'none', confirm: 'right', onNeed: 'retry' },
      { t: 'safari', host: 'daily', proto: 'tcp', app: 'safari' },
      { t: 'normal', via: 'web', policy: 'closed', pick: 1 },
    ],
  },
  {
    name: 'I6: 回滚按等满上限视为已阻断，完成说明「Safari 保持阻断」，而 Surge 仍按原规则放行 Safari',
    strategies: ['ruleset_resource'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 1, e: 1 },
      { t: 'matchRule', available: false },
      { t: 'latency', long: true },
      { t: 'activate', e: 0, via: 'profile', policy: 'closed', confirm: 'right', onNeed: 'retry' },
    ],
  },
  {
    name: 'I5: 取消等待实测的切换，回滚在未确认的阻断下恢复之前买家的出口，仍加载的 VERIFY_ONLY 让检测主机经之前买家的出口发出',
    strategies: ['ruleset_resource'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'create' },
      { t: 'bind', p: 1, e: 1 },
      { t: 'activate', e: 0, via: 'web', policy: 'none', confirm: 'right', onNeed: 'retry' },
      { t: 'verify', outcome: 'pass', longLived: false, tabs: false },
      { t: 'activate', e: 1, via: 'web', policy: 'closed', confirm: 'right', onNeed: 'retry' },
      { t: 'matchRule', available: false },
      { t: 'latency', long: true },
      { t: 'cancel', via: 'web' },
    ],
  },
  {
    name: 'I4: 激活执行中（服务视图提供普通模式）进入普通模式被拒绝 ROUTE_BUSY',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'activate', e: 0, via: 'profile', policy: 'keep', confirm: 'wrong', onNeed: 'retry' },
      { t: 'normalDuring', nth: 7, via: 'web' },
      { t: 'activate', e: 0, via: 'web', policy: 'closed', confirm: 'right', onNeed: 'retry' },
    ],
  },
  {
    name: 'I4: Safari 重测执行中（服务视图提供普通模式）进入普通模式被拒绝 ROUTE_BUSY',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'activate', e: 2, via: 'profile', policy: 'closed', confirm: 'right', onNeed: 'retry' },
      { t: 'verify', outcome: 'pass', longLived: false, tabs: false },
      { t: 'normalDuring', nth: 8, via: 'unbound' },
      { t: 'probe', e: 2, kind: 'safari', via: 'profile' },
    ],
  },
  {
    name: 'I5: 接手等待实测的激活在第一次 Surge 调用时崩溃，重启后启动对账把路由改为 attention/UNKNOWN（模块规则排在入口之前），它在写入之前失败而不回滚：检测主机仍经 SFE-ROUTE 到未验证的出口（种子 600025）',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 1, e: 1 },
      { t: 'activate', e: 0, via: 'web', policy: 'none', confirm: 'right', onNeed: 'retry' },
      { t: 'module', host: 'site' },
      { t: 'crash', nth: 1, after: false, when: 'early' },
      { t: 'activate', e: 0, via: 'profile', policy: 'keep', confirm: 'right', onNeed: 'giveup' },
    ],
  },
  {
    name: 'I6: Surge 重启后扩展读取状态，同一响应中路由摘要仍是对账之前的 ACTIVE/active_verified',
    strategies: ['ruleset_resource', 'temp_rule'],
    events: [
      { t: 'create' },
      { t: 'bind', p: 0, e: 0 },
      { t: 'activate', e: 0, via: 'profile', policy: 'keep', confirm: 'right', onNeed: 'retry' },
      { t: 'verify', outcome: 'pass', longLived: false, tabs: false },
      { t: 'restart' },
      { t: 'popup', p: 0 },
    ],
  },
];

describe('minimal traces of violations found by the seeded state machine', () => {
  for (const trace of MINIMAL_TRACES) {
    for (const strategy of trace.strategies) {
      test(`${strategy}: ${trace.name}`, async () => {
        const w = await runSequence({ strategy, insertion: 'head', seed: 0 }, trace.events);
        if (w.violations.length > 0) console.log([...w.trace, ...w.violations.map((v) => `■ ${v.sig}\n      ${v.state}`)].join('\n'));
        expect(w.violations.map((v) => v.sig)).toEqual([]);
      }, 60_000);
    }
  }
});

describe('normal mode and buyer-exit invariants under random event sequences (seeded state machine)', () => {
  for (const strategy of STRATEGIES) {
    test(
      `${strategy}: ${ONLY_SEED !== null ? `seed ${ONLY_SEED}` : `${SEEDS} seeds from ${SEED_BASE}`}`,
      async () => {
        const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: SEEDS }, (_, i) => SEED_BASE + i);
        // 回放给定的事件列表（JSON，例如报告中的最小轨迹）：SFE_FUZZ_EVENTS='[{"t":"create"},…]'，插入位置取 SFE_FUZZ_SEED 的
        if (EVENTS_JSON) {
          const w = await runSequence(headerFor(strategy, ONLY_SEED ?? 1), JSON.parse(EVENTS_JSON) as Ev[], { trace: true });
          console.log(w.violations.map((v) => `■ ${v.sig}\n  ${v.detail}\n      ${v.state}`).join('\n'));
          expect(w.violations.map((v) => v.sig)).toEqual([]);
          return;
        }
        const found = new Map<string, Found>();
        const stats = emptyStats();
        const coverage = emptyCoverage();
        const started = Date.now();
        for (const seed of seeds) {
          const header = headerFor(strategy, seed);
          const events = generate(seed);
          const w = await runSequence(header, events, { trace: ONLY_SEED !== null });
          for (const k of Object.keys(stats) as Array<keyof Stats>) stats[k] += w.stats[k];
          for (const k of COVERAGE_KEYS) coverage[k] += w.cov[k];
          for (const v of w.violations) {
            const f = found.get(v.sig);
            if (f) {
              f.count++;
              if (f.seeds.length < 8) f.seeds.push(seed);
            } else found.set(v.sig, { header, events, violation: v, count: 1, seeds: [seed] });
          }
        }
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const uncovered = TARGETED.filter((k) => coverage[k] === 0);
        const assertCoverage = seeds.length >= COVERAGE_ASSERT_MIN_SEEDS;
        const lines: string[] = [
          `[fuzz ${strategy}] ${seeds.length} 个种子，${elapsed} 秒；统计 ${JSON.stringify(stats)}；不同违例 ${found.size} 种`,
          `[fuzz ${strategy}] 覆盖 ${JSON.stringify(coverage)}；未覆盖的目标状态 ${uncovered.length ? uncovered.join('、') : '无'}${assertCoverage ? '' : `（不足 ${COVERAGE_ASSERT_MIN_SEEDS} 个种子，不断言）`}`,
        ];
        const report: Array<Record<string, unknown>> = [];
        for (const [sig, f] of found) {
          const cut = f.events.slice(0, f.violation.at + 1);
          const min = SHRINK_BUDGET > 0 ? await shrink(f.header, cut, sig, SHRINK_BUDGET) : { events: cut, world: null };
          const v = min.world?.violations.find((x) => x.sig === sig) ?? f.violation;
          lines.push(
            '',
            `■ ${sig}（${f.count} 个种子，例如 ${f.seeds.join(', ')}；插入位置 ${f.header.insertion}）`,
            `  ${v.detail}`,
            `  最小轨迹（种子 ${f.header.seed}，${cut.length} → ${min.events.length} 个事件）：`,
            ...min.events.map((e, i) => `    #${i} ${describeEv(e)}`),
            `  违例时状态：\n      ${v.state}`,
          );
          if (min.world) lines.push('  回放轨迹：', ...min.world.trace.map((t) => `    ${t}`));
          report.push({ sig, count: f.count, seeds: f.seeds, header: f.header, detail: v.detail, state: v.state, minimal: min.events, trace: min.world?.trace ?? [] });
        }
        console.log(lines.join('\n'));
        if (process.env.SFE_FUZZ_OUT) {
          writeFileSync(`${process.env.SFE_FUZZ_OUT}.${strategy}.json`, JSON.stringify({ stats, coverage, uncovered, elapsed, violations: report }, null, 2));
        }
        // 违例与覆盖回归一起报告：生成器不再到达某个目标状态时大规模运行失败，而不是悄悄地少测
        expect({ violations: [...found.keys()], uncovered: assertCoverage ? uncovered : [] }).toEqual({ violations: [], uncovered: [] });
      },
      6 * 60 * 60 * 1000,
    );
  }
});
