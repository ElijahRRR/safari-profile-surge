<script setup lang="ts">
// 设计系统 Progress：上方一行名称与数值，下方 progress / progress-bar（宽度经 CSSOM 设置）。
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: number; label: string; valueText?: string | null }>(), { valueText: null });
const pct = computed(() => Math.max(0, Math.min(100, Math.round(props.value))));
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-center justify-between text-sm">
      <span class="text-gray-700 dark:text-gray-300">{{ label }}</span>
      <span class="font-medium text-gray-900 dark:text-white">{{ valueText ?? `${pct}%` }}</span>
    </div>
    <div class="progress" role="progressbar" :aria-label="label" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="pct">
      <div class="progress-bar" :style="{ width: `${pct}%` }" />
    </div>
  </div>
</template>
