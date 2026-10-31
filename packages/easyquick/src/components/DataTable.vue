<script setup lang="ts" generic="T">
// 设计系统 DataTable 桌面版：card overflow-hidden → table-wrapper → table；表头 12px 全大写，
// 行悬停高亮，单元格横向内边距按数据列数收紧；单元格内容用插槽 cell-{key}。
import { computed } from 'vue';
import { cellPaddingClass, type TableColumn } from './types';

const props = withDefaults(
  defineProps<{
    columns: TableColumn[];
    rows: T[];
    rowKey: (row: T) => string;
    loading?: boolean;
    skeletonRows?: number;
    selectable?: boolean;
    selected?: string[];
    rowLabel?: (row: T) => string;
    caption?: string | null;
    flat?: boolean;
  }>(),
  { loading: false, skeletonRows: 3, selectable: false, selected: () => [], rowLabel: undefined, caption: null, flat: false },
);
const emit = defineEmits<{ 'update:selected': [keys: string[]] }>();

const padX = computed(() => cellPaddingClass(props.columns.length));
const totalColumns = computed(() => props.columns.length + (props.selectable ? 1 : 0));
const selectedSet = computed(() => new Set(props.selected));
const allSelected = computed(() => props.rows.length > 0 && props.rows.every((r) => selectedSet.value.has(props.rowKey(r))));

function cellValue(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

function toggleRow(row: T) {
  const key = props.rowKey(row);
  const next = new Set(selectedSet.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  emit('update:selected', [...next]);
}

function toggleAll() {
  emit('update:selected', allSelected.value ? [] : props.rows.map((r) => props.rowKey(r)));
}
</script>

<template>
  <div :class="flat ? 'overflow-hidden rounded-xl border border-gray-200 dark:border-dark-700' : 'card overflow-hidden'">
    <div class="table-wrapper">
      <table class="w-full min-w-max divide-y divide-gray-200 dark:divide-dark-700">
        <caption v-if="caption" class="sr-only">{{ caption }}</caption>
        <thead class="table-header bg-gray-50 dark:bg-dark-800">
          <tr>
            <th v-if="selectable" scope="col" class="w-11 min-w-11 px-3 py-3 text-center">
              <input
                type="checkbox"
                class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800"
                aria-label="全选"
                :checked="allSelected"
                :disabled="rows.length === 0"
                @change="toggleAll"
              />
            </th>
            <th
              v-for="col in columns"
              :key="col.key"
              scope="col"
              class="py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-dark-400"
              :class="padX"
            >
              <span :class="{ 'sr-only': col.srOnly }">{{ col.label }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="table-body divide-y divide-gray-200 bg-white dark:divide-dark-700 dark:bg-dark-900">
          <template v-if="loading">
            <tr v-for="n in skeletonRows" :key="`sk-${n}`" aria-hidden="true">
              <td v-if="selectable" class="w-11 min-w-11 px-3 py-4" />
              <td v-for="col in columns" :key="col.key" class="py-4" :class="padX">
                <div class="h-4 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-dark-700" />
              </td>
            </tr>
          </template>
          <tr v-else-if="rows.length === 0">
            <td :colspan="totalColumns" class="p-0">
              <slot name="empty" />
            </td>
          </tr>
          <template v-else>
            <tr
              v-for="row in rows"
              :key="rowKey(row)"
              :class="selectable && selectedSet.has(rowKey(row)) ? 'bg-primary-50/40 dark:bg-primary-900/10' : 'hover:bg-gray-50 dark:hover:bg-dark-800'"
            >
              <td v-if="selectable" class="w-11 min-w-11 px-3 py-4 text-center">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-600 dark:bg-dark-800"
                  :aria-label="rowLabel ? `选择 ${rowLabel(row)}` : '选择'"
                  :checked="selectedSet.has(rowKey(row))"
                  @change="toggleRow(row)"
                />
              </td>
              <td
                v-for="col in columns"
                :key="col.key"
                class="py-4 text-sm text-gray-900 dark:text-gray-100"
                :class="[padX, col.wrap ? 'whitespace-normal' : 'whitespace-nowrap', col.class]"
              >
                <slot :name="`cell-${col.key}`" :row="row" :value="cellValue(row, col.key)">{{ cellValue(row, col.key) ?? '' }}</slot>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <slot name="footer" />
  </div>
</template>
