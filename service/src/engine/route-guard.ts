// SFE-ROUTE 选择的配置身份守卫（docs/ARCHITECTURE.md §6.3 第 8、14 步、§6.6「配置身份」）：SFE-ROUTE 的选择属于固定工作配置——
// Surge 中每个配置有自己的同名组与选择，选择命令总是作用于当前加载的配置。本模块是本应用唯一调用 selectGroupPolicy 的地方
// （静态测试强制），也是除对账、发布读回与核对门槛之外唯一读取 SFE-ROUTE 选择的地方：
// - 写入之前重新核对 Surge 可连接且当前是固定工作配置（routeGuard，窄核对：只读检测原语与当前配置，不覆盖对账的其他事实）；
// - 写入（或要记为本应用路由状态的读取）之后再核对一次当前配置仍是固定工作配置（profileStillWorking）；
// - 核对不通过时不写入、不认定：调用方如实写明没有改选（或不能确认改选落在固定工作配置上），失败即关闭。
// Surge 没有对选择的比较并交换：切换配置之后紧接着发出的写入仍可能落在其他配置中；这里能做的是不认定它，并如实写明。

import { ROUTE_GROUP_NAME, SfeError } from '@sfe/contract';
import type { SurgeProfileInfo } from '../ports.js';
import { profileMatches, type Engine } from './context.js';

/** 守卫拒绝的原因：无法连接 Surge、当前配置不是固定工作配置、无法确认当前配置是否是固定工作配置。 */
export type RouteGuardBlock = 'surge_unreachable' | 'external_profile' | 'profile_unknown';
export type RouteGuardCode = 'SURGE_UNREACHABLE' | 'EXTERNAL_PROFILE';
export type RouteGuardAllowed = { allowed: true };
export type RouteGuard = RouteGuardAllowed | { allowed: false; block: RouteGuardBlock; code: RouteGuardCode };

/** 守卫拒绝原因对应的错误代码（无法确认当前配置时同样按 EXTERNAL_PROFILE）。 */
export function guardCodeOf(block: RouteGuardBlock): RouteGuardCode {
  return block === 'surge_unreachable' ? 'SURGE_UNREACHABLE' : 'EXTERNAL_PROFILE';
}

function refused(block: RouteGuardBlock): RouteGuard {
  return { allowed: false, block, code: guardCodeOf(block) };
}

/** 读当前配置的总次数：可达而 getCurrentProfile 抛出时最多再读两次（间隔 Engine.profileReadRetryMs）；读到而不匹配不重试。 */
const PROFILE_READ_ATTEMPTS = 3;

function wait(engine: Engine, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    engine.clock.setTimeout(resolve, ms);
  });
}

async function readProfileWithRetry(engine: Engine): Promise<{ ok: true; profile: SurgeProfileInfo } | { ok: false; error: unknown }> {
  let last: unknown = null;
  for (let i = 0; i < PROFILE_READ_ATTEMPTS; i++) {
    if (i > 0) await wait(engine, engine.profileReadRetryMs());
    try {
      return { ok: true, profile: await engine.surge.getCurrentProfile() };
    } catch (err) {
      last = err;
    }
  }
  return { ok: false, error: last };
}

/**
 * 改选或认定 SFE-ROUTE 的选择之前的配置身份核对：一次检测读取（与 readBasicFacts 相同的原语），可达时读当前配置（读取失败有限
 * 重试）并与固定工作配置比较。只有可连接且确认是固定工作配置时允许。只更新 engine.facts 的 reachable、currentProfileName、
 * currentProfilePath 与 onWorkingProfile——不覆盖运行时长、启动时间等对账用作比较基线的事实（否则一次结束点的核对会吞掉对账
 * 判断引擎重启的依据）。从不抛出。
 */
export async function routeGuard(engine: Engine): Promise<RouteGuard> {
  try {
    if (!(await engine.probeLiveness())) {
      engine.facts = { ...engine.facts, reachable: false, onWorkingProfile: null, currentProfileName: null, currentProfilePath: null };
      return refused('surge_unreachable');
    }
    const read = await readProfileWithRetry(engine);
    if (!read.ok) {
      engine.facts = { ...engine.facts, reachable: true, onWorkingProfile: null };
      return refused('profile_unknown');
    }
    const wp = engine.workingProfile();
    const on = wp ? profileMatches(read.profile, wp) : null;
    engine.facts = { ...engine.facts, reachable: true, currentProfileName: read.profile.name, currentProfilePath: read.profile.path, onWorkingProfile: on };
    if (on === true) return { allowed: true };
    return refused(on === false ? 'external_profile' : 'profile_unknown');
  } catch {
    return refused('profile_unknown');
  }
}

/**
 * 写入或读取之后的核对：读当前配置（读取失败有限重试）并与固定工作配置比较；不改 engine.facts（对账负责记下事实与
 * external_profile_change）。仍是固定工作配置时为 null。从不抛出。
 */
export async function profileStillWorking(engine: Engine): Promise<RouteGuardBlock | null> {
  try {
    const read = await readProfileWithRetry(engine);
    if (!read.ok) return read.error instanceof SfeError && read.error.code === 'SURGE_UNREACHABLE' ? 'surge_unreachable' : 'profile_unknown';
    const wp = engine.workingProfile();
    if (!wp) return 'profile_unknown';
    return profileMatches(read.profile, wp) ? null : 'external_profile';
  } catch {
    return 'profile_unknown';
  }
}

export type RouteGuardStage = 'not_attempted' | 'profile_changed';

export type RouteWrite =
  | { ok: true; readback: string }
  | { ok: false; kind: 'guard'; block: RouteGuardBlock; code: RouteGuardCode; stage: RouteGuardStage; readback: string | null }
  | { ok: false; kind: 'surge'; failed: 'select' | 'readback' | 'mismatch'; error: unknown; readback: string | null };

/**
 * 唯一的 SFE-ROUTE 写入：前置核对（opts.guard 为同一步刚得到的允许结果时不重读）→ 改选 → 读回 → 读回一致时再核对当前配置仍是
 * 固定工作配置。只有 ok 才能记为本应用的选择；stage 'profile_changed' 表示写入已发出，但不能确认它落在固定工作配置上（可能改到了
 * 其他配置中的同名组）。从不抛出。
 */
export async function writeRouteSelection(engine: Engine, policy: string, opts: { guard?: RouteGuardAllowed } = {}): Promise<RouteWrite> {
  const guard = opts.guard ?? (await routeGuard(engine));
  if (!guard.allowed) return { ok: false, kind: 'guard', block: guard.block, code: guard.code, stage: 'not_attempted', readback: null };
  try {
    await engine.surge.selectGroupPolicy(ROUTE_GROUP_NAME, policy);
  } catch (error) {
    return { ok: false, kind: 'surge', failed: 'select', error, readback: null };
  }
  let readback: string | null;
  try {
    readback = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch (error) {
    return { ok: false, kind: 'surge', failed: 'readback', error, readback: null };
  }
  if (readback !== policy) return { ok: false, kind: 'surge', failed: 'mismatch', error: null, readback };
  const post = await profileStillWorking(engine);
  if (post !== null) return { ok: false, kind: 'guard', block: post, code: guardCodeOf(post), stage: 'profile_changed', readback };
  return { ok: true, readback };
}

export type RouteRead =
  | { ok: true; selection: string | null }
  | { ok: false; kind: 'guard'; block: RouteGuardBlock; code: RouteGuardCode; stage: RouteGuardStage }
  | { ok: false; kind: 'surge'; error: unknown };

/** 要记为本应用路由状态（或据此认定、放过）的读取：前置核对（opts.guard 同上）→ 读取 → 再核对当前配置仍是固定工作配置。从不抛出。 */
export async function readRouteSelection(engine: Engine, opts: { guard?: RouteGuardAllowed } = {}): Promise<RouteRead> {
  const guard = opts.guard ?? (await routeGuard(engine));
  if (!guard.allowed) return { ok: false, kind: 'guard', block: guard.block, code: guard.code, stage: 'not_attempted' };
  let selection: string | null;
  try {
    selection = await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch (error) {
    return { ok: false, kind: 'surge', error };
  }
  const post = await profileStillWorking(engine);
  if (post !== null) return { ok: false, kind: 'guard', block: post, code: guardCodeOf(post), stage: 'profile_changed' };
  return { ok: true, selection };
}

/**
 * 不认定的原始读取（读不到为 undefined）：只用于让结果更保守的判断（例如无法确认当前配置时，结束点按读到的选择决定是否要求处理），
 * 从不据此记下选择或放过。从不抛出。
 */
export async function readSelectionUncredited(engine: Engine): Promise<string | null | undefined> {
  try {
    return await engine.surge.getGroupSelection(ROUTE_GROUP_NAME);
  } catch {
    return undefined;
  }
}

/** 守卫拒绝原因的说明。 */
export const ROUTE_GUARD_TEXT: Record<RouteGuardBlock, string> = {
  surge_unreachable: '无法连接 Surge',
  external_profile: 'Surge 当前配置不是固定工作配置',
  profile_unknown: '无法确认 Surge 当前配置是否是固定工作配置',
};

/** 守卫拒绝时的处理：进入普通模式在当前加载的配置上同样可以进行（撤销入口、结束连接；只跳过 SFE-ROUTE 的改选）。 */
export const ROUTE_GUARD_REMEDY = '立即进入普通模式（不必先切回固定工作配置）';

/** 普通模式中守卫拒绝时的处理。 */
export const ROUTE_GUARD_NORMAL_REMEDY = '再次进入普通模式（可在当前配置上进行）；回到固定工作配置之后路由仍需要处理时再进入一次普通模式';

/**
 * 当前加载的不是（或无法确认是）固定工作配置时的暴露说明：这个配置若也含本应用入口（例如固定工作配置的副本，引用同一组入口
 * 规则集文件），Safari 请求此刻按它的同名 SFE-ROUTE 发出——本应用不改动其他配置中的同名组。无法连接 Surge 时为空。
 */
export function routeGuardExposure(block: RouteGuardBlock): string {
  return block === 'surge_unreachable'
    ? ''
    : '；Surge 当前加载的配置若也含本应用入口（例如固定工作配置的副本），Safari 请求此刻可能经该配置中同名 SFE-ROUTE 选择的出口发出，本应用不改动它';
}
