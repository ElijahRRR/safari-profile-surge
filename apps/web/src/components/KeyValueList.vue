<script setup lang="ts">
// 卡片内的「名称 — 值」列表；值用插槽 v-{key} 自定义，默认显示文字。
defineProps<{ items: Array<{ key: string; label: string; value?: string | number | null }> }>();
</script>

<template>
  <dl class="divide-y divide-gray-100 text-sm dark:divide-dark-700">
    <div v-for="item in items" :key="item.key" class="flex items-start justify-between gap-4 py-2.5">
      <dt class="flex-shrink-0 text-gray-500 dark:text-dark-400">{{ item.label }}</dt>
      <dd class="min-w-0 text-right text-gray-900 dark:text-gray-100">
        <slot :name="`v-${item.key}`">{{ item.value ?? '—' }}</slot>
      </dd>
    </div>
  </dl>
</template>
