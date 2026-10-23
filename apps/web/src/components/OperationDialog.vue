<script setup lang="ts">
// 操作详情与实时进度：阶段徽章、步骤时间线、各版本、结束连接结果、回滚结果与错误。
// 等待中的路由操作可按效果取消（取消切换/取消等待/取消重测；服务端回滚，从不进入普通模式），
// 「关闭」只收起弹窗。激活等待场景时给出受控入口引导，不称一键完成。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { OperationView } from '@sfe/contract';
import { Badge, BaseDialog, DataTable, Spinner, StatusBadge, type TableColumn } from '@sfe/easyquick';
import KeyValueList from './KeyValueList.vue';
import NoticeBox from './NoticeBox.vue';
import { formatClock, formatDateTime, formatRelative, formatRevision } from '../lib/format';
import { ENTRY_MODE_LABELS, OPERATION_KIND_LABELS, OPERATION_PHASE_LABELS, OPERATION_STATUS_LABELS, PROBE_OUTCOME_LABELS, operationStatusDot } from '../lib/labels';
import { cancelActionLabel, envLabel, isCancellableRouteOperation, isSafariRetest } from '../lib/environments';
import { useConsole } from '../store/context';

const { api, store, viewer } = useConsole();

const loading = ref(false);
const loadError = ref<string | null>(null);
const fetched = ref<OperationView | null>(null);

const op = computed<OperationView | null>(() => {
  const id = viewer.state.id;
  if (!id) return null;
  const live = store.operationById(id);
  const f = fetched.value?.id === id ? fetched.value : null;
  if (live && f) return live.updatedAt >= f.updatedAt ? live : f;
  return live ?? f;
});

watch(
  () => viewer.state.id,
  async (id) => {
    loadError.value = null;
    if (!id) return;
    loading.value = true;
    try {
      const view = await api.getOperation(id);
      if (viewer.state.id === id) {
        fetched.value = view;
        store.upsertOperation(view);
      }
    } catch (e) {
      if (viewer.state.id === id && !store.operationById(id)) loadError.value = e instanceof Error ? e.message : '读取操作失败';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

// 事件流断开时退回到低频轮询，保证进度仍会更新（事件流正常时不轮询）。
const POLL_MS = 3000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const shouldPoll = computed(() => {
  const o = op.value;
  return viewer.state.id !== null && store.state.stream !== 'open' && !!o && (o.status === 'queued' || o.status === 'running' || o.status === 'waiting');
});
watch(
  shouldPoll,
  (on) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (!on) return;
    pollTimer = setInterval(async () => {
      const id = viewer.state.id;
      if (!id) return;
      try {
        store.upsertOperation(await api.getOperation(id));
      } catch {
        // 轮询失败不打扰用户：下一次再试，事件流恢复后停止轮询。
      }
    }, POLL_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const env = computed(() => (op.value?.environmentId ? (store.environmentsById.value.get(op.value.environmentId) ?? null) : null));
const sceneName = computed(() => viewer.state.sceneName ?? env.value?.displayName ?? null);
const title = computed(() => {
  if (!op.value) return '操作详情';
  const kind = OPERATION_KIND_LABELS[op.value.kind] ?? op.value.kind;
  return env.value ? `${kind} · ${envLabel(env.value)}` : kind;
});

const waitingForScene = computed(() => {
  const o = op.value;
  if (!o || o.status !== 'waiting') return false;
  // 活动环境发布进入切换后与激活一样停在 VERIFY_ONLY 等待
  return o.kind === 'route.activate' || o.kind === 'probe.safari' || o.phase === 'WAITING_ROUTE' || o.phase === 'VERIFY_ONLY';
});
// 操作自己的截止时间（服务端按实测截止时间或到达截止时间给出）：不用路由记录的 awaitingDeadline——重新检测与 WAITING_ROUTE 不负责
// 路由，那里可能是之前一次检测或切换留下的、早已过去的时间
const deadline = computed(() => (waitingForScene.value ? (op.value?.waitDeadline ?? null) : null));
/** 实测超时的后果按操作说明：重新检测（含激活复用时改为的重测）从不切换、阻断或进入普通模式（§6.4），超时只结束检测；切换超时按第 14 步回滚。 */
const timeoutText = computed(() =>
  op.value && isSafariRetest(op.value)
    ? '超时则本次重新检测失败，路由不变（不切换、不阻断 Safari）。'
    : '超时会尝试恢复原节点并保持 Safari 阻断（无法确认时改选 REJECT 并要求处理）。',
);
const cancellable = computed(() => (op.value ? isCancellableRouteOperation(op.value) : false));
const windowsWarning = computed(() => {
  const o = op.value;
  if (!o || (o.kind !== 'route.activate' && o.kind !== 'route.normal')) return false;
  return (store.route.value?.warnings ?? []).some((w) => w === 'old_windows_kept_open' || w === 'managed_windows_on_original_rules');
});

const effectiveItems = computed(() => {
  const e = op.value?.effective;
  return [
    { key: 'desired', label: '期望版本', value: formatRevision(e?.desiredProxyRevision) },
    { key: 'deployed', label: '已部署版本', value: formatRevision(e?.deployedProxyRevision) },
    { key: 'active', label: '活动版本', value: formatRevision(e?.activeProxyRevision) },
    { key: 'generation', label: '配置代数', value: e?.configurationGeneration ?? '—' },
    { key: 'epoch', label: '路由序号', value: e?.routeEpoch ?? '—' },
  ];
});

const killColumns: TableColumn[] = [
  { key: 'surgeRequestId', label: '连接' },
  { key: 'processPath', label: '进程路径' },
  { key: 'toVerifyHost', label: '检测连接' },
  { key: 'ok', label: '结果' },
  { key: 'at', label: '时间' },
];
const killResults = computed(() => op.value?.result?.killResults ?? []);
const rollback = computed(() => op.value?.result?.rollback ?? null);
const rollbackItems = computed(() => {
  const r = rollback.value;
  if (!r) return [];
  const prevEnv = r.previousEnvironmentId ? store.environmentsById.value.get(r.previousEnvironmentId) : null;
  return [
    { key: 'prevEnv', label: '恢复的环境', value: prevEnv ? envLabel(prevEnv) : (r.previousEnvironmentId ?? '无') },
    { key: 'prevRev', label: '恢复的版本', value: formatRevision(r.previousProxyRevision) },
    { key: 'selection', label: '恢复的节点选择', value: r.restoredSelection ?? '—' },
    { key: 'entry', label: '回滚后入口', value: ENTRY_MODE_LABELS[r.entryModeAfter]?.label ?? r.entryModeAfter },
    { key: 'failedRev', label: '失败的版本', value: formatRevision(r.failedProxyRevision) },
    { key: 'probe', label: '上次结果', value: null },
  ];
});
</script>

<template>
  <BaseDialog :show="viewer.state.id !== null" :title="title" width="wide" @close="viewer.close()">
    <div v-if="!op && loading" class="flex items-center gap-3 py-6 text-sm text-gray-500 dark:text-dark-400"><Spinner />正在读取操作</div>
    <NoticeBox v-else-if="!op" tone="danger">{{ loadError ?? '读取操作失败：操作不存在或无权查看' }}</NoticeBox>
    <div v-else class="space-y-5 text-sm" data-test="operation-detail">
      <div class="flex flex-wrap items-center gap-3">
        <Badge :variant="OPERATION_PHASE_LABELS[op.phase].variant" data-test="phase-badge">{{ OPERATION_PHASE_LABELS[op.phase].label }}</Badge>
        <StatusBadge :status="operationStatusDot(op.status)" :label="OPERATION_STATUS_LABELS[op.status].label" />
        <span class="text-gray-500 dark:text-dark-400">更新于 {{ formatRelative(op.updatedAt, store.state.now) }}</span>
        <span class="code">{{ op.id }}</span>
      </div>

      <NoticeBox v-if="waitingForScene && op.phase === 'WAITING_ROUTE'" tone="info" title="等待场景打开" data-test="waiting-route-guidance">
        新版本已部署。在 Safari 切换到场景 {{ sceneName ?? '（未知）' }}，点击扩展图标即可切换到新版本；在此之前当前出口不变。
        <template v-if="deadline"> 截止 {{ formatClock(deadline) }}。</template>
      </NoticeBox>
      <NoticeBox v-else-if="waitingForScene" tone="info" title="等待 Safari 实测" data-test="scene-guidance">
        在 Safari 切换到场景 {{ sceneName ?? '（未知）' }}，点击扩展图标完成验证。
        <template v-if="deadline"> 请在 {{ formatClock(deadline) }} 前完成，{{ timeoutText }}</template>
      </NoticeBox>

      <NoticeBox v-if="op.error" tone="danger" :title="op.error.code">{{ op.error.message }}</NoticeBox>
      <NoticeBox v-if="op.supersededBy" tone="warning">
        此操作已被新的操作取代。
        <button type="button" class="ml-1 font-medium underline" @click="viewer.open(op.supersededBy!)">查看新操作</button>
      </NoticeBox>
      <NoticeBox v-if="op.result?.readbackLevel === 'partial'" tone="warning" title="已部署，读回不完整">
        未核对字段：{{ (op.result?.uncheckedFields ?? []).join('、') || '未列出' }}
      </NoticeBox>

      <section>
        <h4 class="mb-2 text-sm font-semibold text-gray-900 dark:text-white">步骤</h4>
        <ol v-if="op.steps.length" class="relative space-y-3 border-l border-gray-200 pl-5 dark:border-dark-700" data-test="steps">
          <li v-for="(step, i) in op.steps" :key="i" class="relative">
            <span class="absolute -left-[1.6rem] top-1.5 inline-block h-2 w-2 rounded-full" :class="i === op.steps.length - 1 ? 'bg-primary-500' : 'bg-gray-300 dark:bg-dark-600'" aria-hidden="true" />
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-gray-500 dark:text-dark-400">{{ formatClock(step.at) }}</span>
              <Badge :variant="OPERATION_PHASE_LABELS[step.phase].variant">{{ OPERATION_PHASE_LABELS[step.phase].label }}</Badge>
            </div>
            <p class="mt-1 text-gray-700 dark:text-gray-300">{{ step.message }}</p>
          </li>
        </ol>
        <p v-else class="text-gray-500 dark:text-dark-400">还没有步骤记录。</p>
      </section>

      <section>
        <h4 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">版本</h4>
        <KeyValueList :items="effectiveItems" />
      </section>

      <section v-if="killResults.length">
        <h4 class="mb-2 text-sm font-semibold text-gray-900 dark:text-white">结束 Safari 连接</h4>
        <DataTable :columns="killColumns" :rows="killResults" :row-key="(r) => r.surgeRequestId" flat caption="结束 Safari 连接的结果">
          <template #cell-surgeRequestId="{ row }"><span class="code">{{ row.surgeRequestId }}</span></template>
          <template #cell-processPath="{ row }"><span class="font-mono text-xs">{{ row.processPath ?? '—' }}</span></template>
          <template #cell-toVerifyHost="{ row }">{{ row.toVerifyHost ? '是' : '否' }}</template>
          <template #cell-ok="{ row }">
            <Badge :variant="row.ok ? 'success' : 'danger'">{{ row.ok ? '已结束' : '失败' }}</Badge>
            <span v-if="row.error" class="ml-2 text-xs text-gray-500 dark:text-dark-400">{{ row.error }}</span>
          </template>
          <template #cell-at="{ row }">{{ formatClock(row.at) }}</template>
        </DataTable>
      </section>

      <section v-if="rollback">
        <h4 class="mb-1 text-sm font-semibold text-gray-900 dark:text-white">回滚结果</h4>
        <NoticeBox tone="warning">
          新版本失败：{{ rollback.failureError.message }}
          <template v-if="rollback.needsReverify"> 已恢复原节点并保持阻断，需要重新核验。</template>
        </NoticeBox>
        <KeyValueList :items="rollbackItems" class="mt-2">
          <template #v-probe>
            <span v-if="rollback.previousProbe">
              {{ rollback.previousProbe.exitIp ?? '—' }} ·
              <Badge :variant="PROBE_OUTCOME_LABELS[rollback.previousProbe.outcome].variant">{{ PROBE_OUTCOME_LABELS[rollback.previousProbe.outcome].label }}</Badge>
              · {{ formatDateTime(rollback.previousProbe.observedAt) }}
            </span>
            <span v-else>—</span>
          </template>
        </KeyValueList>
      </section>
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" @click="viewer.close()">关闭</button>
      <button v-if="windowsWarning" type="button" class="btn btn-secondary" data-test="op-ack-windows" @click="viewer.requestAcknowledgeWindows()">我已关闭旧窗口</button>
      <button v-if="op && cancellable" type="button" class="btn btn-danger" data-test="cancel-operation" @click="viewer.requestCancel(op.id)">{{ cancelActionLabel(op) }}</button>
    </template>
  </BaseDialog>
</template>
