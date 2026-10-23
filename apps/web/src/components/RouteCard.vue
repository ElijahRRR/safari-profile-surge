<script setup lang="ts">
// 当前路由卡：活动环境、入口模式、选中节点、最近 Safari 实测（过期显示「上次结果」）与全部警告。
// 等待中的路由操作可取消；有旧窗口警告时可声明「我已关闭旧窗口」。带警告时从不显示为无警告的绿色；
// 实测已过期或未通过时也不显示绿色「受控」（受控要求最近一次 Safari 实测通过且未过期）。
import { computed } from 'vue';
import type { RouteWarning } from '@sfe/contract';
import { Badge, StatusBadge } from '@sfe/easyquick';
import KeyValueList from './KeyValueList.vue';
import RouteWarnings from './RouteWarnings.vue';
import { useConsole } from '../store/context';
import { ENTRY_MODE_LABELS, PROBE_OUTCOME_LABELS, ROUTE_PHASE_LABELS, ROUTE_WARNING_TEXT, type StatusLabel } from '../lib/labels';
import { HELD_ON_END, cancelActionLabel, envLabel, isCancellableRouteOperation, isSafariRetest, normalModeOffered, probeDisplay } from '../lib/environments';
import { formatDateTime, formatRevision } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, routeActions, viewer, accepted } = useConsole();

const route = computed(() => store.route.value);
const active = computed(() => store.activeEnvironment.value);
const probe = computed(() => probeDisplay(route.value?.lastSafariProbe, store.state.now));
const routeOp = computed(() => store.operationById(route.value?.operationId));
const cancellable = computed(() => (routeOp.value ? isCancellableRouteOperation(routeOp.value) : false));
/** 取消的后果按操作说明（与取消确认相同）：只有切换才尝试恢复原节点；等待场景与重测取消后通常路由不变（例外见 HELD_ON_END）。 */
const cancelNote = computed(() => {
  const o = routeOp.value;
  if (o?.phase === 'WAITING_ROUTE') return `有等待场景打开的新版本。取消只结束等待，新版本保持已部署，通常当前出口不变；${HELD_ON_END}`;
  if (o && isSafariRetest(o)) return `有等待中的 Safari 重测。取消只结束本次检测，通常路由不变（不切换、不阻断 Safari）；${HELD_ON_END}`;
  return '有等待中的路由操作。取消会尝试恢复原节点并保持 Safari 阻断；无法确认时不恢复，改选 REJECT 拒绝 Safari 经本应用出口的新连接并要求处理。不会进入普通模式。';
});
const windowsWarning = computed(() => (route.value?.warnings ?? []).some((w) => w === 'old_windows_kept_open' || w === 'managed_windows_on_original_rules'));
const showNormal = computed(() => normalModeOffered(route.value));

/** 入口是 ACTIVE 时最近 Safari 实测的问题；null 表示实测通过且未过期。 */
const probeIssue = computed<string | null>(() => {
  const r = route.value;
  if (!r || r.entryMode !== 'ACTIVE') return null;
  if (!r.lastSafariProbe) return '未实测';
  if (r.lastSafariProbe.outcome !== 'ok') return '实测未通过';
  if (probe.value?.expired) return '实测已过期';
  return null;
});

// 服务端要到下一次对账才加 probe_expired（对账间隔可调到很长）；实测行已按本机时钟显示「上次结果」时，
// 警告也立即按过期显示，不等对账。
const warnings = computed<RouteWarning[]>(() => {
  const r = route.value;
  if (!r) return [];
  const expired = r.phase === 'active_verified' && !!probe.value?.expired;
  return expired && !r.warnings.includes('probe_expired') ? [...r.warnings, 'probe_expired'] : r.warnings;
});

const overall = computed(() => {
  const r = route.value;
  if (!r) return { status: 'unknown', label: '读取中' };
  const list = warnings.value;
  if (list.some((w) => ROUTE_WARNING_TEXT[w]?.severity === 'danger') || r.entryMode === 'UNKNOWN') return { status: 'danger', label: '需要处理' };
  if (list.length > 0) return { status: 'warning', label: `有 ${list.length} 条警告` };
  if (r.phase === 'active_verified' && r.entryMode === 'ACTIVE') return probeIssue.value ? { status: 'warning', label: probeIssue.value } : { status: 'success', label: '受控' };
  // 入口记为普通模式、但服务端仍提供普通模式（Safari 可能仍有经买家出口的连接，§6.5）：不显示成单纯的「普通模式」
  if (r.entryMode === 'NORMAL' && !r.activeEnvironmentId) return showNormal.value ? { status: 'warning', label: '普通模式（未确认）' } : { status: 'unknown', label: '普通模式' };
  return { status: 'warning', label: ROUTE_PHASE_LABELS[r.phase].label };
});

const entryBadge = computed<StatusLabel | null>(() => {
  const r = route.value;
  if (!r) return null;
  if (probeIssue.value) return { label: `${ENTRY_MODE_LABELS[r.entryMode].label}（${probeIssue.value}）`, variant: 'warning' };
  return ENTRY_MODE_LABELS[r.entryMode];
});

const items = computed(() => [
  { key: 'env', label: '活动环境' },
  { key: 'entry', label: '入口模式' },
  { key: 'phase', label: '路由阶段' },
  { key: 'node', label: '选中节点' },
  { key: 'probe', label: '最近 Safari 实测' },
  { key: 'reconciled', label: '最近对账', value: formatDateTime(store.lastReconciledAt.value) },
]);

async function reprobe() {
  const env = active.value;
  if (!env) return;
  try {
    const acc = await api.probe(env.id, { request_id: newRequestId(), kind: 'safari' });
    accepted(acc, '已受理：等待在 Safari 场景中完成检测', env.displayName);
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '检测失败');
  }
}
</script>

<template>
  <div class="card" data-test="route-card">
    <div class="card-header flex items-center justify-between gap-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">当前路由</h3>
      <StatusBadge :status="overall.status" :label="overall.label" />
    </div>
    <div class="card-body space-y-4">
      <KeyValueList :items="items">
        <template #v-env>
          <span v-if="active">{{ envLabel(active) }} · {{ formatRevision(route?.activeProxyRevision) }}</span>
          <span v-else>无（Safari 按 Surge 原规则）</span>
        </template>
        <template #v-entry>
          <Badge v-if="entryBadge" :variant="entryBadge.variant" data-test="entry-badge">{{ entryBadge.label }}</Badge>
        </template>
        <template #v-phase>
          <Badge v-if="route" :variant="ROUTE_PHASE_LABELS[route.phase].variant">{{ ROUTE_PHASE_LABELS[route.phase].label }}</Badge>
        </template>
        <template #v-node>
          <span v-if="route?.selectedNode" class="code">{{ route.selectedNode }}</span>
          <span v-else>—</span>
        </template>
        <template #v-probe>
          <span v-if="probe && route?.lastSafariProbe" class="inline-flex flex-wrap items-center justify-end gap-2">
            <span v-if="probe.expired" class="text-gray-500 dark:text-dark-400">上次结果</span>
            <span class="font-mono">{{ probe.exitIp ?? '—' }}</span>
            <Badge :variant="PROBE_OUTCOME_LABELS[route.lastSafariProbe.outcome].variant">{{ PROBE_OUTCOME_LABELS[route.lastSafariProbe.outcome].label }}</Badge>
            <span class="text-gray-500 dark:text-dark-400" :title="formatDateTime(route.lastSafariProbe.observedAt)">{{ probe.when }}</span>
          </span>
          <span v-else>未检测</span>
        </template>
      </KeyValueList>
      <RouteWarnings :warnings="warnings" />
      <p v-if="cancellable" class="text-sm text-gray-500 dark:text-dark-400" data-test="route-cancel-note">{{ cancelNote }}</p>
    </div>
    <div v-if="active || cancellable || windowsWarning || showNormal" class="card-footer flex flex-wrap justify-end gap-3">
      <button v-if="routeOp" type="button" class="btn btn-ghost btn-sm" @click="viewer.open(routeOp.id, active?.displayName ?? null)">查看操作</button>
      <button v-if="windowsWarning" type="button" class="btn btn-secondary btn-sm" data-test="ack-windows" @click="viewer.requestAcknowledgeWindows()">我已关闭旧窗口</button>
      <button v-if="cancellable && routeOp" type="button" class="btn btn-secondary btn-sm" data-test="route-cancel" @click="viewer.requestCancel(routeOp.id)">{{ cancelActionLabel(routeOp) }}</button>
      <button v-if="active && route?.phase === 'active_verified'" type="button" class="btn btn-secondary btn-sm" @click="reprobe">重新检测</button>
      <button v-if="showNormal" type="button" class="btn btn-secondary btn-sm" @click="routeActions.start({ kind: 'normal' })">进入普通模式</button>
    </div>
  </div>
</template>
