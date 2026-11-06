<script setup lang="ts">
// 设计系统 PageHeader：大标题 + 一句当前数据状态的说明 + 右侧页面级操作（btn-secondary 次要 + btn-primary 主要）。
withDefaults(defineProps<{ title: string; description?: string | null; level?: 'h1' | 'h2' }>(), { description: null, level: 'h2' });
</script>

<template>
  <div class="page-header flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <component :is="level" class="page-title">{{ title }}</component>
      <p v-if="description" class="page-description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-3">
      <slot name="actions" />
    </div>
  </div>
</template>
