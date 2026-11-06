<script setup lang="ts">
// 逐协议覆盖：门槛协议项必须通过或写明限制才能确认“已通过”；DNS、WebRTC、系统服务只记录与展示。
import { computed } from 'vue';
import { GATING_COVERAGE_ITEMS, type ProtocolCoverage, type ProtocolCoverageItem } from '@sfe/contract';
import { Badge, DataTable, type TableColumn } from '@sfe/easyquick';
import { COVERAGE_ITEM_LABELS, COVERAGE_RESULT_LABELS } from '../lib/labels';

const props = defineProps<{ coverage: ProtocolCoverage | null }>();

const ITEMS = Object.keys(COVERAGE_ITEM_LABELS) as ProtocolCoverageItem[];
const rows = computed(() =>
  ITEMS.map((item) => ({ item, gating: GATING_COVERAGE_ITEMS.includes(item), entry: props.coverage?.[item] ?? null })),
);
const columns: TableColumn[] = [
  { key: 'item', label: '协议' },
  { key: 'kind', label: '类别' },
  { key: 'result', label: '结果' },
  { key: 'note', label: '说明', wrap: true },
];
</script>

<template>
  <DataTable :columns="columns" :rows="rows" :row-key="(r) => r.item" flat caption="逐协议覆盖" data-test="coverage-table">
    <template #cell-item="{ row }">{{ COVERAGE_ITEM_LABELS[row.item] }}</template>
    <template #cell-kind="{ row }">
      <span :class="row.gating ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-dark-400'">{{ row.gating ? '门槛项' : '只记录' }}</span>
    </template>
    <template #cell-result="{ row }">
      <Badge v-if="row.entry" :variant="COVERAGE_RESULT_LABELS[row.entry.result].variant">{{ COVERAGE_RESULT_LABELS[row.entry.result].label }}</Badge>
      <Badge v-else variant="gray">未记录</Badge>
    </template>
    <template #cell-note="{ row }"><span class="text-gray-700 dark:text-gray-300">{{ row.entry?.note ?? '—' }}</span></template>
  </DataTable>
</template>
