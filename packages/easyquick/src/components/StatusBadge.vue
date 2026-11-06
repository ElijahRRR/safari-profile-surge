<script setup lang="ts">
// 设计系统 StatusBadge：8px 状态点 + 文字。文字必填，颜色不能单独表达状态。
import { computed } from 'vue';

const props = defineProps<{ status: string; label: string }>();

const dotClass = computed(() => {
  switch (props.status) {
    case 'active':
    case 'success':
      return 'bg-green-500';
    case 'disabled':
    case 'inactive':
    case 'warning':
      return 'bg-yellow-500';
    case 'error':
    case 'danger':
      return 'bg-red-500';
    default:
      return 'bg-gray-400';
  }
});
</script>

<template>
  <div class="flex items-center gap-1.5">
    <span class="inline-block h-2 w-2 flex-shrink-0 rounded-full" :class="dotClass" aria-hidden="true" />
    <span class="text-sm text-gray-700 dark:text-gray-300">{{ label }}</span>
  </div>
</template>
