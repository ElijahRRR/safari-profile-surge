<script setup lang="ts">
// 卡片或弹窗内的提示块：soft 底 + 状态色文字 + 图标（不用左侧色边，色边只属于 Toast）。
import { computed } from 'vue';
import { Icon, type IconName } from '@sfe/easyquick';

const props = withDefaults(defineProps<{ tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string | null; icon?: IconName | null }>(), {
  tone: 'info',
  title: null,
  icon: null,
});

const STYLE = {
  info: { box: 'bg-blue-50 text-blue-800 dark:bg-blue-900/20 dark:text-blue-300', icon: 'infoCircle' },
  warning: { box: 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300', icon: 'exclamationTriangle' },
  danger: { box: 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300', icon: 'xCircle' },
  success: { box: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300', icon: 'checkCircle' },
} as const;

const style = computed(() => STYLE[props.tone]);
const iconName = computed<IconName>(() => props.icon ?? style.value.icon);
</script>

<template>
  <div class="flex items-start gap-3 rounded-xl p-4 text-sm" :class="style.box" :role="tone === 'danger' ? 'alert' : undefined">
    <Icon :name="iconName" class="mt-0.5" />
    <div class="min-w-0 flex-1 space-y-1">
      <p v-if="title" class="font-semibold">{{ title }}</p>
      <div class="leading-relaxed"><slot /></div>
    </div>
  </div>
</template>
