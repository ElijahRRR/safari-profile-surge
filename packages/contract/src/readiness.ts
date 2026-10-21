// 环境汇总状态与下一步的推导。网页、插件、服务端都用这一个函数，避免三处各写一套。
// 优先级（先命中先返回）见 docs/ARCHITECTURE.md §6.9。

import type { CapabilityKey } from './phases.js';
import type { EnvironmentFacets, EnvironmentReadiness, NextAction } from './models.js';

export interface ReadinessInput {
  facets: EnvironmentFacets;
  /** 是否已有可用（已部署）的版本；有则即使有更新的待部署修改也仍可使用。 */
  hasDeployedRevision: boolean;
  /** desired 版本比 deployed 新。 */
  pendingNewerRevision: boolean;
  /** 发布门槛缺失的能力（pending 时用于提示）。 */
  publishMissing: readonly CapabilityKey[];
  /** 激活门槛缺失的能力。 */
  activateMissing: readonly CapabilityKey[];
  accountChangedSincePageCheck: boolean;
  safariProbeExpired: boolean;
}

export interface ReadinessResult {
  readiness: EnvironmentReadiness;
  nextActions: NextAction[];
}

export function deriveReadiness(input: ReadinessInput): ReadinessResult {
  const { facets } = input;
  const extra: NextAction[] = [];
  if (input.accountChangedSincePageCheck) {
    extra.push({ kind: 'acknowledge_account_change', message: '配置账号已更换，网页登录状态未核对' });
  }
  if (input.pendingNewerRevision && input.hasDeployedRevision) {
    extra.push(
      input.publishMissing.length
        ? { kind: 'verify_capability', message: '新版本已保存，待部署：发布能力尚未通过实测', capabilities: [...input.publishMissing] }
        : { kind: 'publish_pending', message: '新版本已保存，待部署' },
    );
  }
  const done = (readiness: EnvironmentReadiness, primary: NextAction): ReadinessResult => ({
    readiness,
    nextActions: [primary, ...extra.filter((a) => a.kind !== primary.kind)],
  });

  if (facets.input === 'invalid') return done('invalid', { kind: 'fix_input', message: '环境数据不完整或不合法，请修正后保存' });

  if (facets.route === 'active') {
    if (input.safariProbeExpired) return done('active', { kind: 'probe_safari', message: '实测出口已过期，请重新检测' });
    return done('active', { kind: 'open_orders', message: '环境使用中，可以打开订单页' });
  }
  if (facets.route === 'waiting_route') return done('activating', { kind: 'apply_new_revision', message: '新版本已部署，在该场景中打开扩展即可切换' });
  if (facets.route === 'activating' || facets.route === 'verifying') {
    return done('activating', { kind: 'safari_verify', message: '等待在绑定的 Safari 场景中完成出口检测' });
  }
  if (facets.route === 'rolled_back') return done('needs_reverify', { kind: 'reverify', message: '切换失败，已恢复原节点并保持阻断，需要重新核验' });

  if (!input.hasDeployedRevision) {
    if (facets.deployment === 'failed') return done('sync_failed', { kind: 'publish_pending', message: '同步到 Surge 失败，请查看错误后重试' });
    // 读回不完整且未被 P0 记录覆盖：不能当作可用版本。
    if (facets.deployment === 'readback_partial') {
      return done('sync_failed', { kind: 'verify_capability', message: '已部署，读回不完整：需要相应能力的实测记录覆盖未核对字段' });
    }
  }
  if (facets.preflight === 'failed') return done('proxy_unavailable', { kind: 'fix_input', message: '代理预检失败：前置或 SOCKS5 不可用' });
  if (facets.binding === 'unbound') return done('needs_binding', { kind: 'bind_profile', message: '尚未关联 Safari 场景' });

  if (!input.hasDeployedRevision) {
    if (facets.deployment === 'deploying') return done('deploying', { kind: 'none', message: '正在同步到 Surge' });
    if (input.publishMissing.length) {
      return done('waiting_deployment', {
        kind: 'verify_capability',
        message: '已保存，待部署：发布能力尚未通过实测',
        capabilities: [...input.publishMissing],
      });
    }
    return done('waiting_deployment', { kind: 'publish_pending', message: '已保存，待部署' });
  }

  const activateAction: NextAction = input.activateMissing.length
    ? { kind: 'verify_capability', message: '切换出口所需能力尚未通过实测', capabilities: [...input.activateMissing] }
    : { kind: 'activate', message: '可以使用此环境' };
  if (facets.preflight === 'ok') return done('ready', activateAction);
  return done('deployed_unverified', input.activateMissing.length ? activateAction : { kind: 'activate', message: '已部署，未独立预检，将由 Safari 实测验证' });
}

/** 允许发起激活的汇总状态（能力门槛另行检查）。 */
export function readinessAllowsActivation(readiness: EnvironmentReadiness): boolean {
  return readiness === 'ready' || readiness === 'deployed_unverified' || readiness === 'active' || readiness === 'needs_reverify';
}
