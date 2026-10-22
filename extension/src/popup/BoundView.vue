<script setup lang="ts">
// 已绑定场景：环境状态、出口与警告、受控动作。密码从不显示；登录身份始终为“未核对”。
import { computed, ref } from 'vue';
import { Icon } from '@sfe/easyquick';
import { SITES, type ProbeView, type ProxyRevisionView, type RouteWarning } from '@sfe/contract';
import BaseDialog from '../ui/BaseDialog.vue';
import StatusBadge from '../ui/StatusBadge.vue';
import InfoRow from './InfoRow.vue';
import EditForm from './EditForm.vue';
import type { PopupController } from './controller';
import {
  DEPLOYMENT_TEXT,
  PENDING_KIND_TEXT,
  READINESS_BADGE,
  WARNING_TEXT,
  formatRelative,
  isExpired,
  type BadgeStatus,
} from '../shared/text';

const props = defineProps<{ controller: PopupController }>();
const c = props.controller;
const s = c.state;

const editing = ref(false);
const confirmCancel = ref(false);
const confirmWindows = ref(false);

const cur = computed(() => s.current!);
const env = computed(() => cur.value.environment!);
const route = computed(() => cur.value.route);
/** 上一次普通模式未能确认 Safari 已没有经买家出口的连接（非活动场景只从路由摘要得到这一项）。 */
const buyerExitUnconfirmed = computed(() => cur.value.routeSummary.buyerExitConnectionsUnconfirmed === true);
const warnings = computed<RouteWarning[]>(() => route.value?.warnings ?? (buyerExitUnconfirmed.value ? ['buyer_exit_connections_unconfirmed'] : []));
const thisActive = computed(() => cur.value.relation === 'this_active');
const pending = computed(() => cur.value.pendingVerification);

const badge = computed<{ status: BadgeStatus; label: string }>(() => {
  const base = READINESS_BADGE[env.value.readiness];
  // 带警告的使用状态永不显示为无警告的绿色。
  if (env.value.readiness === 'active' && warnings.value.length) return { status: 'warning', label: '使用中，有警告' };
  return base;
});

const shownRevision = computed<ProxyRevisionView | null>(() => env.value.proxy.active ?? env.value.proxy.deployed ?? env.value.proxy.desired);
const pendingRevision = computed<ProxyRevisionView | null>(() => {
  const desired = env.value.proxy.desired;
  if (!desired || !shownRevision.value || desired.revision === shownRevision.value.revision) return null;
  return desired;
});

function proxyText(r: ProxyRevisionView): string {
  return `SOCKS5 ${r.host.includes(':') ? `[${r.host}]` : r.host}:${r.port}`;
}

const safariProbe = computed<ProbeView | null>(() => env.value.probes.safari);
const probeExpired = computed(() => !safariProbe.value || isExpired(safariProbe.value.expiresAt, s.now));
const probeText = computed(() => {
  const p = safariProbe.value;
  if (!p) return '未检测';
  if (p.outcome === 'ok') return p.exitIp ?? '已检测，出口未知';
  if (p.outcome === 'mismatch') return `${p.exitIp ?? '未知'}（与预期不符）`;
  if (p.outcome === 'failed') return '检测失败';
  return '未确认';
});
const preflight = computed(() => env.value.probes.preflight);

const accountText = computed(() => {
  const a = env.value.account;
  const parts = [a.label, a.loginIdentifierMasked].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : '未配置';
});

const showAckWindows = computed(() => warnings.value.includes('old_windows_kept_open') || warnings.value.includes('managed_windows_on_original_rules'));
const amazonUnverified = computed(() => !thisActive.value && s.profile?.amazon_tabs_open === true);
const sitePermissionMissing = computed(() => s.profile !== null && !s.profile.site_permission_granted);
// 路由已是空闲的普通模式时，只有上一次普通模式未能确认结束 Safari 经买家出口的连接才再提供（再次进入会再结束它们）
const canEnterNormal = computed(() => cur.value.relation !== 'none_active' || cur.value.routeSummary.entryMode !== 'NORMAL' || buyerExitUnconfirmed.value);

const ordersEnabled = computed(() => cur.value.ordersAllowed || cur.value.activationAvailable);
/** 每个视图最多一个主操作。 */
const primary = computed<'continue' | 'orders' | 'activate'>(() => {
  if (pending.value) return 'continue';
  if (thisActive.value) return 'orders';
  return 'activate';
});

const cancelText = computed(() =>
  pending.value?.kind === 'apply_new_revision'
    ? '新版本保持已部署，当前出口不变，下次打开时再切换。'
    : pending.value?.kind === 'probe_safari'
      ? '将结束本次出口检测。'
      : '将恢复切换前的节点选择并保持 Safari 阻断，之后需要重新核验；不会进入普通模式。',
);

async function doCancel() {
  confirmCancel.value = false;
  await c.cancelPending();
}
async function doAckWindows() {
  confirmWindows.value = false;
  await c.acknowledgeWindows();
}
</script>

<template>
  <div class="space-y-3" data-test="bound-view">
    <div class="card">
      <div class="card-body space-y-1 p-4">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h2 class="truncate text-base font-semibold text-gray-900 dark:text-white" data-test="env-name">{{ env.displayName }}</h2>
            <p class="text-xs text-gray-500 dark:text-dark-400"><span class="code">{{ env.code }}</span></p>
          </div>
          <StatusBadge :status="badge.status" :label="badge.label" data-test="env-status" />
        </div>
        <p v-if="env.nextActions[0]" class="text-xs text-gray-500 dark:text-dark-400" data-test="next-action">{{ env.nextActions[0].message }}</p>
      </div>
    </div>

    <ul v-if="warnings.length" class="space-y-1.5" data-test="warnings">
      <li v-for="w in warnings" :key="w" class="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning" :data-warning="w">
        <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
        <span>{{ WARNING_TEXT[w] }}</span>
      </li>
    </ul>
    <button v-if="showAckWindows" type="button" class="btn btn-secondary btn-sm w-full" :disabled="!!s.busy" data-test="ack-windows" @click="confirmWindows = true">
      我已关闭旧窗口
    </button>

    <div v-if="pending" class="rounded-2xl border border-primary-200 bg-primary-50 p-4 dark:border-primary-900 dark:bg-primary-900/20" data-test="pending-banner">
      <p class="text-sm font-medium text-gray-900 dark:text-white">等待在此场景完成出口检测：{{ PENDING_KIND_TEXT[pending.kind] }}</p>
      <p v-if="pending.deadline" class="mt-0.5 text-xs text-gray-500 dark:text-dark-400">截止时间 {{ new Date(pending.deadline).toLocaleTimeString('zh-CN') }}</p>
      <div class="mt-3 flex gap-2">
        <button type="button" class="btn btn-primary btn-sm" :disabled="!!s.busy" data-test="continue-verify" @click="c.continueVerification()">继续验证</button>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="!!s.busy" data-test="cancel-pending" @click="confirmCancel = true">取消切换</button>
      </div>
    </div>

    <p v-if="amazonUnverified" class="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning" data-test="amazon-unverified">
      <Icon name="exclamationTriangle" size="sm" class="mt-0.5" />
      <span>本场景的 Amazon 页面未经启动验证，正按当前路由规则发送请求</span>
    </p>
    <p v-if="sitePermissionMissing" class="flex items-start gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:bg-dark-900/40 dark:text-gray-300" data-test="site-permission">
      <Icon name="infoCircle" size="sm" class="mt-0.5" />
      <span>未授权访问 {{ SITES[env.site].host }}。在 Safari 设置的扩展页面允许本扩展访问该网站，才能定位订单页与填充登录。</span>
    </p>

    <EditForm v-if="editing" :controller="c" :environment="env" @close="editing = false" @saved="editing = false" />
    <div v-else class="card">
      <dl class="card-body divide-y divide-gray-100 p-4 py-2 text-sm dark:divide-dark-700">
        <InfoRow label="绑定场景" test="row-binding">
          <span class="code">{{ env.binding.profileIdShort ?? cur.profile.profileIdShort ?? '未知' }}</span>
          <span v-if="env.binding.state === 'bound_unverified_id'" class="block text-xs text-gray-500 dark:text-dark-400">场景标识稳定性未验证</span>
        </InfoRow>
        <InfoRow label="买家号" test="row-account">{{ accountText }}</InfoRow>
        <InfoRow label="页面登录状态" test="row-page-identity">
          <span>未核对</span>
          <template v-if="env.account.changedSincePageCheck">
            <span class="block text-xs text-warning" data-test="account-changed">配置账号已更换，网页登录状态未核对</span>
            <button type="button" class="btn btn-ghost btn-sm mt-1" :disabled="!!s.busy" data-test="ack-account" @click="c.acknowledgeAccount()">我已核对</button>
          </template>
        </InfoRow>
        <InfoRow label="站点" test="row-site">{{ SITES[env.site].label }}</InfoRow>
        <InfoRow label="代理" test="row-proxy">
          <span v-if="shownRevision">{{ proxyText(shownRevision) }}</span>
          <span v-else>未配置</span>
          <span v-if="pendingRevision" class="block text-xs text-gray-500 dark:text-dark-400">修改后：{{ proxyText(pendingRevision) }}（未生效）</span>
        </InfoRow>
        <InfoRow label="前置" test="row-front">{{ shownRevision?.frontProxyName ?? '未配置' }}</InfoRow>
        <InfoRow label="实际出口" test="row-exit">
          <span>{{ probeText }}</span>
          <span v-if="safariProbe" class="block text-xs text-gray-500 dark:text-dark-400">
            <span v-if="probeExpired" class="badge badge-gray mr-1" data-test="probe-stale">上次结果</span>{{ formatRelative(safariProbe.observedAt, s.now) }}
          </span>
        </InfoRow>
        <InfoRow v-if="preflight" label="代理预检" test="row-preflight">
          {{ preflight.outcome === 'ok' ? '通过' : preflight.outcome === 'failed' ? '失败' : '未确认' }}
          <span class="block text-xs text-gray-500 dark:text-dark-400">{{ formatRelative(preflight.observedAt, s.now) }}</span>
        </InfoRow>
        <InfoRow label="Surge 同步" test="row-sync">{{ DEPLOYMENT_TEXT[env.facets.deployment] }}</InfoRow>
      </dl>
    </div>

    <div v-if="!editing" class="space-y-2" data-test="actions">
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="btn"
          :class="primary === 'activate' ? 'btn-primary' : 'btn-secondary'"
          :disabled="!!s.busy || !cur.activationAvailable"
          :title="cur.activationBlockedReason ?? undefined"
          data-test="activate"
          @click="c.activate()"
        >
          使用此环境
        </button>
        <button
          type="button"
          class="btn"
          :class="primary === 'orders' ? 'btn-primary' : 'btn-secondary'"
          :disabled="!!s.busy || !ordersEnabled"
          :title="cur.ordersBlockedReason ?? undefined"
          data-test="orders"
          @click="c.openOrders()"
        >
          打开或定位订单页
        </button>
      </div>
      <p v-if="!cur.activationAvailable && cur.activationBlockedReason" class="text-xs text-gray-500 dark:text-dark-400" data-test="activation-blocked">
        {{ cur.activationBlockedReason }}
      </p>
      <p v-if="!cur.ordersAllowed" class="text-xs text-gray-500 dark:text-dark-400" data-test="orders-blocked">
        <template v-if="cur.activationAvailable">将先切换出口并在 Safari 中完成检测，通过后打开订单页。</template>
        <template v-else>{{ cur.ordersBlockedReason ?? '订单页暂不可用' }}</template>
      </p>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!!s.busy" data-test="probe" @click="c.probe()">
          <Icon name="refresh" size="sm" />
          重新检测
        </button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="!!s.busy" data-test="edit" @click="editing = true">
          <Icon name="edit" size="sm" />
          编辑
        </button>
        <button v-if="canEnterNormal" type="button" class="btn btn-ghost btn-sm" :disabled="!!s.busy" data-test="normal" @click="c.enterNormal()">
          <Icon name="ban" size="sm" />
          进入普通模式
        </button>
      </div>
    </div>

    <BaseDialog v-if="confirmCancel" title="确定要取消这次切换吗？" width="narrow" @close="confirmCancel = false">
      <p>{{ cancelText }}</p>
      <template #footer>
        <button type="button" class="btn btn-secondary btn-sm" @click="confirmCancel = false">取消</button>
        <button type="button" class="btn btn-danger btn-sm" data-test="confirm-cancel" @click="doCancel">取消切换</button>
      </template>
    </BaseDialog>
    <BaseDialog v-if="confirmWindows" title="确定已关闭旧窗口吗？" width="narrow" @close="confirmWindows = false">
      <p>只清除旧窗口警告，不改变当前路由。请确认旧环境的 Safari 窗口都已关闭。</p>
      <template #footer>
        <button type="button" class="btn btn-secondary btn-sm" @click="confirmWindows = false">取消</button>
        <button type="button" class="btn btn-primary btn-sm" data-test="confirm-ack-windows" @click="doAckWindows">已关闭</button>
      </template>
    </BaseDialog>
  </div>
</template>
