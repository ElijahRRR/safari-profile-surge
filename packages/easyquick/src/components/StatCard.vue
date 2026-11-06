<script setup lang="ts">
// 设计系统 StatCard：图标框 + 标签 + 大数字 + 可选趋势。图标颜色表达指标性质，趋势颜色由使用方判断好坏。
import { computed } from 'vue';
import Icon from '../Icon.vue';
import type { IconName } from '../icons';

const props = withDefaults(
  defineProps<{
    title: string;
    value: string | number;
    icon: IconName;
    iconVariant?: 'primary' | 'success' | 'warning' | 'danger';
    change?: string | null;
    changeType?: 'up' | 'down' | 'neutral';
    formatValue?: (value: string | number) => string;
  }>(),
  { iconVariant: 'primary', change: null, changeType: 'neutral', formatValue: undefined },
);

const display = computed(() => {
  if (props.formatValue) return props.formatValue(props.value);
  return typeof props.value === 'number' ? new Intl.NumberFormat('zh-CN').format(props.value) : props.value;
});
</script>

<template>
  <div class="stat-card">
    <div class="stat-icon" :class="`stat-icon-${iconVariant}`"><Icon :name="icon" size="lg" /></div>
    <div class="min-w-0 flex-1">
      <p class="stat-label truncate">{{ title }}</p>
      <div class="mt-1 flex items-baseline gap-2">
        <p class="stat-value">{{ display }}</p>
        <span v-if="change && changeType !== 'neutral'" class="stat-trend" :class="changeType === 'up' ? 'stat-trend-up' : 'stat-trend-down'">
          <svg class="h-3 w-3" :class="{ 'rotate-180': changeType === 'down' }" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          {{ change }}
        </span>
        <span v-else-if="change" class="stat-trend text-gray-500 dark:text-dark-400">{{ change }}</span>
      </div>
    </div>
  </div>
</template>
