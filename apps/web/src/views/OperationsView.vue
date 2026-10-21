<script setup lang="ts">
// 操作记录：每个任务的阶段与结果；点开查看步骤时间线、各版本、结束连接结果、回滚结果与错误。
import { computed, onMounted, ref, watch } from 'vue';
import type { OperationView } from '@sfe/contract';
import { Badge, DataTable, EmptyState, Icon, PageHeader, Pagination, SearchInput, StatusBadge, Tabs, Toggle, type TableColumn } from '@sfe/easyquick';
import NoticeBox from '../components/NoticeBox.vue';
import { useConsole } from '../store/context';
import { OPERATION_KIND_LABELS, OPERATION_PHASE_LABELS, OPERATION_STATUS_LABELS, operationStatusDot } from '../lib/labels';
import { envLabel } from '../lib/environments';
import { formatCount, formatDateTime, formatRelative } from '../lib/format';

const { store, viewer, loadOperations } = useConsole();

const loadError = ref<string | null>(null);
const loading = ref(false);
async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    await loadOperations(200);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '读取操作记录失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

type StatusFilter = 'all' | 'active' | 'failed';
const statusFilter = ref<StatusFilter>('all');
const includeReconcile = ref(false);
const search = ref('');
const page = ref(1);
const pageSize = ref(20);

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const FAILED = new Set(['failed', 'needs_attention']);

function envName(op: OperationView): string {
  const env = op.environmentId ? store.environmentsById.value.get(op.environmentId) : null;
  return env ? envLabel(env) : op.environmentId ? op.environmentId : '全局';
}

const rows = computed(() =>
  store.state.operations.filter((op) => {
    if (!includeReconcile.value && op.kind === 'maintenance.reconcile') return false;
    if (statusFilter.value === 'active' && !ACTIVE.has(op.status)) return false;
    if (statusFilter.value === 'failed' && !FAILED.has(op.status)) return false;
    const q = search.value.trim().toLowerCase();
    if (q && !`${OPERATION_KIND_LABELS[op.kind]}\n${envName(op)}\n${op.id}`.toLowerCase().includes(q)) return false;
    return true;
  }),
);
const paged = computed(() => rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([statusFilter, includeReconcile, search, pageSize], () => {
  page.value = 1;
});

const tabOptions = computed(() => [
  { value: 'all' as const, label: '全部' },
  { value: 'active' as const, label: '进行中', count: store.state.operations.filter((o) => ACTIVE.has(o.status)).length },
  { value: 'failed' as const, label: '失败', count: store.state.operations.filter((o) => FAILED.has(o.status)).length },
]);

const columns: TableColumn[] = [
  { key: 'time', label: '时间' },
  { key: 'kind', label: '操作' },
  { key: 'env', label: '环境' },
  { key: 'phase', label: '阶段' },
  { key: 'status', label: '状态' },
  { key: 'error', label: '错误' },
  { key: 'actions', label: '查看', srOnly: true },
];
</script>

<template>
  <div>
    <PageHeader title="操作记录" :description="`最近 ${formatCount(store.state.operations.length, '条')}操作`">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load"><Icon name="refresh" />刷新</button>
      </template>
    </PageHeader>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <SearchInput v-model="search" label="搜索操作" placeholder="搜索操作、环境或编号…" />
      <Tabs v-model="statusFilter" :options="tabOptions" label="操作筛选" />
      <div class="flex items-center gap-2">
        <Toggle v-model="includeReconcile" label="显示对账记录" />
        <span class="text-sm text-gray-700 dark:text-gray-300">显示对账记录</span>
      </div>
    </div>
    <NoticeBox v-if="loadError" tone="danger" class="mb-4">{{ loadError }}</NoticeBox>
    <DataTable :columns="columns" :rows="paged" :row-key="(o) => o.id" :loading="loading && !store.state.operationsLoaded" caption="操作记录">
      <template #cell-time="{ row }"><span :title="formatDateTime(row.createdAt)">{{ formatRelative(row.createdAt, store.state.now) }}</span></template>
      <template #cell-kind="{ row }">{{ OPERATION_KIND_LABELS[row.kind] ?? row.kind }}</template>
      <template #cell-env="{ row }">{{ envName(row) }}</template>
      <template #cell-phase="{ row }"><Badge :variant="OPERATION_PHASE_LABELS[row.phase].variant">{{ OPERATION_PHASE_LABELS[row.phase].label }}</Badge></template>
      <template #cell-status="{ row }"><StatusBadge :status="operationStatusDot(row.status)" :label="OPERATION_STATUS_LABELS[row.status].label" /></template>
      <template #cell-error="{ row }">
        <span v-if="row.error" class="block max-w-[16rem] truncate text-red-600 dark:text-red-400" :title="row.error.message">{{ row.error.message }}</span>
        <span v-else class="text-gray-500 dark:text-dark-400">—</span>
      </template>
      <template #cell-actions="{ row }">
        <button type="button" class="btn btn-ghost btn-sm" :aria-label="`查看操作 ${OPERATION_KIND_LABELS[row.kind]}`" title="查看" @click="viewer.open(row.id)">
          <Icon name="eye" size="sm" />
        </button>
      </template>
      <template #empty>
        <EmptyState icon="clipboard" title="没有符合条件的操作" description="新建、导入、发布或切换环境后，每个任务都会记录在这里。" />
      </template>
      <template #footer>
        <Pagination v-if="rows.length > pageSize" v-model:page="page" v-model:page-size="pageSize" :total="rows.length" />
      </template>
    </DataTable>
  </div>
</template>
