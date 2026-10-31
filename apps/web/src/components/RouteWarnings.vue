<script setup lang="ts">
// 路由警告逐条显示为可读的中文；阻断类用红色，其余用琥珀色。没有警告时不显示任何“正常”的绿色提示。
import type { RouteWarning } from '@sfe/contract';
import { Icon } from '@sfe/easyquick';
import { ROUTE_WARNING_TEXT, warningText } from '../lib/labels';

defineProps<{ warnings: RouteWarning[] }>();
</script>

<template>
  <ul v-if="warnings.length" class="space-y-2" aria-label="路由警告">
    <li
      v-for="w in warnings"
      :key="w"
      class="flex items-start gap-2 rounded-xl px-3 py-2 text-sm"
      :class="
        ROUTE_WARNING_TEXT[w]?.severity === 'danger'
          ? 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
          : 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
      "
      :data-warning="w"
    >
      <Icon :name="ROUTE_WARNING_TEXT[w]?.severity === 'danger' ? 'xCircle' : 'exclamationTriangle'" size="sm" class="mt-0.5" />
      <span>{{ warningText(w) }}</span>
    </li>
  </ul>
</template>
