<script setup lang="ts">
// 设计系统 Pagination 桌面版：左侧条数与每页条数，右侧相连的页码组；窄屏为三段式。
import { computed } from 'vue';
import Icon from '../Icon.vue';
import SelectField from './SelectField.vue';

const props = withDefaults(
  defineProps<{ total: number; page: number; pageSize: number; pageSizeOptions?: number[]; showPageSizeSelector?: boolean }>(),
  { pageSizeOptions: () => [10, 20, 50, 100], showPageSizeSelector: true },
);
const emit = defineEmits<{ 'update:page': [page: number]; 'update:pageSize': [size: number] }>();

const fmt = new Intl.NumberFormat('zh-CN');
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1));
const to = computed(() => Math.min(props.total, props.page * props.pageSize));
const sizeOptions = computed(() => props.pageSizeOptions.map((n) => ({ value: n, label: String(n) })));

/** 页码序列：首尾、当前页前后各一页，其余以省略号代替。 */
const pages = computed<Array<number | 'gap'>>(() => {
  const n = pageCount.value;
  const cur = props.page;
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const set = new Set([1, n, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= n));
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === 'number' && p - prev > 1) out.push('gap');
    out.push(p);
  }
  return out;
});

function go(p: number) {
  if (p < 1 || p > pageCount.value || p === props.page) return;
  emit('update:page', p);
}
</script>

<template>
  <div class="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 dark:border-dark-700 dark:bg-dark-800 sm:px-6">
    <div class="flex flex-1 items-center justify-between sm:hidden">
      <button type="button" class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="go(page - 1)">上一页</button>
      <span class="text-sm text-gray-700 dark:text-gray-300">第 {{ page }} 页，共 {{ pageCount }} 页</span>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="page >= pageCount" @click="go(page + 1)">下一页</button>
    </div>
    <div class="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
      <div class="flex items-center space-x-4">
        <p class="text-sm text-gray-700 dark:text-gray-300">
          显示 <span class="font-medium">{{ fmt.format(from) }}</span> 至 <span class="font-medium">{{ fmt.format(to) }}</span> 条，共
          <span class="font-medium">{{ fmt.format(total) }}</span> 条
        </p>
        <div v-if="showPageSizeSelector" class="flex items-center space-x-2">
          <span class="text-sm text-gray-700 dark:text-gray-300">每页:</span>
          <div class="w-20">
            <SelectField :model-value="pageSize" :options="sizeOptions" accessible-label="每页条数" @update:model-value="(v) => emit('update:pageSize', Number(v))" />
          </div>
        </div>
      </div>
      <nav class="relative z-0 inline-flex -space-x-px rounded-md shadow-sm" aria-label="分页">
        <button
          type="button"
          :disabled="page <= 1"
          class="relative inline-flex items-center rounded-l-md border border-gray-300 bg-white px-2 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-400 dark:hover:bg-dark-600"
          aria-label="上一页"
          @click="go(page - 1)"
        >
          <Icon name="chevronLeft" />
        </button>
        <template v-for="(p, i) in pages" :key="p === 'gap' ? `gap-${i}` : p">
          <button
            v-if="p === 'gap'"
            type="button"
            disabled
            class="relative inline-flex cursor-default items-center border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-300"
          >
            …
          </button>
          <button
            v-else
            type="button"
            class="relative inline-flex items-center border px-4 py-2 text-sm font-medium"
            :class="
              p === page
                ? 'z-10 border-primary-500 bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-400'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-300 dark:hover:bg-dark-600'
            "
            :aria-current="p === page ? 'page' : undefined"
            @click="go(p)"
          >
            {{ p }}
          </button>
        </template>
        <button
          type="button"
          :disabled="page >= pageCount"
          class="relative inline-flex items-center rounded-r-md border border-gray-300 bg-white px-2 py-2 text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-dark-600 dark:bg-dark-700 dark:text-gray-400 dark:hover:bg-dark-600"
          aria-label="下一页"
          @click="go(page + 1)"
        >
          <Icon name="chevronRight" />
        </button>
      </nav>
    </div>
  </div>
</template>
