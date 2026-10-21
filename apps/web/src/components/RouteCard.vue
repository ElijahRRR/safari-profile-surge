<script setup lang="ts">
// 当前路由卡：活动环境、入口模式、选中节点、最近 Safari 实测（过期显示「上次结果」）与全部警告。
// 等待中的路由操作可取消；有旧窗口警告时可声明「我已关闭旧窗口」。带警告时从不显示为无警告的绿色。
import { computed } from 'vue';
import { Badge, StatusBadge } from '@sfe/easyquick';
import KeyValueList from './KeyValueList.vue';
import RouteWarnings from './RouteWarnings.vue';
import { useConsole } from '../store/context';
import { ENTRY_MODE_LABELS, PROBE_OUTCOME_LABELS, ROUTE_PHASE_LABELS, ROUTE_WARNING_TEXT } from '../lib/labels';
import { envLabel, isCancellableRouteOperation, probeDisplay } from '../lib/environments';
import { formatDateTime, formatRevision } from '../lib/format';
import { newRequestId } from '../lib/request-id';

const { api, store, toasts, routeActions, viewer, accepted } = useConsole();

const route = computed(() => store.route.value);
const active = computed(() => store.activeEnvironment.value);
const probe = computed(() => probeDisplay(route.value?.lastSafariProbe, store.state.now));
const routeOp = computed(() => store.operationById(route.value?.operationId));
const cancellable = computed(() => (routeOp.value ? isCancellableRouteOperation(routeOp.value) : false));
const windowsWarning = computed(() => (route.value?.warnings ?? []).some((w) => w === 'old_windows_kept_open' || w === 'managed_windows_on_original_rules'));
const showNormal = computed(() => !!route.value && (route.value.entryMode !== 'NORMAL' || route.value.activeEnvironmentId !== null));

const overall = computed(() => {
  const r = route.value;
  if (!r) return { status: 'unknown', label: '读取中' };
  if (r.warnings.some((w) => ROUTE_WARNING_TEXT[w]?.severity === 'danger') || r.entryMode === 'UNKNOWN') return { status: 'danger', label: '需要处理' };
  if (r.warnings.length > 0) return { status: 'warning', label: `有 ${r.warnings.length} 条警告` };
  if (r.phase === 'active_verified' && r.entryMode === 'ACTIVE') return { status: 'success', label: '受控' };
  if (r.entryMode === 'NORMAL' && !r.activeEnvironmentId) return { status: 'unknown', label: '普通模式' };
  return { status: 'warning', label: ROUTE_PHASE_LABELS[r.phase].label };
});

const items = computed(() => [
  { key: 'env', label: '活动环境' },
  { key: 'entry', label: '入口模式' },
  { key: 'phase', label: '路由阶段' },
  { key: 'node', label: '选中节点' },
  { key: 'probe', label: '最近 Safari 实测' },
  { key: 'reconciled', label: '最近对账', value: formatDateTime(route.value?.lastReconciledAt) },
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
          <Badge v-if="route" :variant="ENTRY_MODE_LABELS[route.entryMode].variant">{{ ENTRY_MODE_LABELS[route.entryMode].label }}</Badge>
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
      <RouteWarnings :warnings="route?.warnings ?? []" />
      <p v-if="cancellable" class="text-sm text-gray-500 dark:text-dark-400">
        有等待中的路由操作。取消会恢复原节点并保持 Safari 阻断，不会进入普通模式。
      </p>
    </div>
    <div v-if="active || cancellable || windowsWarning || showNormal" class="card-footer flex flex-wrap justify-end gap-3">
      <button v-if="routeOp" type="button" class="btn btn-ghost btn-sm" @click="viewer.open(routeOp.id, active?.displayName ?? null)">查看操作</button>
      <button v-if="windowsWarning" type="button" class="btn btn-secondary btn-sm" data-test="ack-windows" @click="viewer.requestAcknowledgeWindows()">我已关闭旧窗口</button>
      <button v-if="cancellable && routeOp" type="button" class="btn btn-secondary btn-sm" data-test="route-cancel" @click="viewer.requestCancel(routeOp.id)">取消</button>
      <button v-if="active && route?.phase === 'active_verified'" type="button" class="btn btn-secondary btn-sm" @click="reprobe">重新检测</button>
      <button v-if="showNormal" type="button" class="btn btn-secondary btn-sm" @click="routeActions.start({ kind: 'normal' })">进入普通模式</button>
    </div>
  </div>
</template>
