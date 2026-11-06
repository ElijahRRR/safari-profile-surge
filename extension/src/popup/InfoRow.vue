<script setup lang="ts">
const props = defineProps<{ label: string; test?: string }>();
</script>

<template>
  <div class="flex items-start justify-between gap-3 py-1.5" :data-test="props.test">
    <dt class="flex-shrink-0 text-gray-500 dark:text-dark-400">{{ props.label }}</dt>
    <dd class="min-w-0 break-words text-right text-gray-900 dark:text-white">
      <slot />
    </dd>
  </div>
</template>
