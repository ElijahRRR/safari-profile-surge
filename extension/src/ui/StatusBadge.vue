<script setup lang="ts">
// EasyQuick StatusBadge：圆点 + 文字，文字必填，颜色不单独表达状态。
import type { BadgeStatus } from '../shared/text';

const props = defineProps<{ status: BadgeStatus; label: string }>();
const DOT: Record<BadgeStatus, string> = {
  success: 'bg-green-500',
  warning: 'bg-yellow-500',
  error: 'bg-red-500',
  info: 'bg-gray-400',
};
</script>

<template>
  <div class="flex items-center gap-1.5" :data-status="props.status">
    <span class="inline-block h-2 w-2 flex-shrink-0 rounded-full" :class="DOT[props.status]" aria-hidden="true"></span>
    <span class="text-sm text-gray-700 dark:text-gray-300">{{ props.label }}</span>
  </div>
</template>
