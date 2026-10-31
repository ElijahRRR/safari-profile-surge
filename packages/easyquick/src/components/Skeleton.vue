<script setup lang="ts">
// 设计系统 Skeleton：animate-pulse 的 gray-200 块；尺寸由使用方用工具类给出。
withDefaults(defineProps<{ circle?: boolean }>(), { circle: false });
</script>

<template>
  <div class="animate-pulse bg-gray-200 dark:bg-dark-700" :class="circle ? 'rounded-full' : 'rounded-lg'" aria-hidden="true" />
</template>
