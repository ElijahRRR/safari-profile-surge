<script setup lang="ts">
// 能力验证上下文：每个字段的记录值；过期原因中的字段标红。
import { CAPABILITY_CONTEXT_FIELDS, type CapabilityContext, type CapabilityContextField } from '@sfe/contract';
import { CONTEXT_FIELD_LABELS } from '../lib/labels';

withDefaults(defineProps<{ context: CapabilityContext | null; stale?: CapabilityContextField[] }>(), { stale: () => [] });
</script>

<template>
  <dl v-if="context" class="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
    <div v-for="field in CAPABILITY_CONTEXT_FIELDS" :key="field" class="flex justify-between gap-3">
      <dt class="text-gray-500 dark:text-dark-400">{{ CONTEXT_FIELD_LABELS[field] }}</dt>
      <dd class="min-w-0 truncate font-mono" :class="stale.includes(field) ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'" :title="context[field] ?? ''">
        {{ context[field] ?? '无法读取' }}
      </dd>
    </div>
  </dl>
  <p v-else class="text-xs text-gray-500 dark:text-dark-400">没有验证记录。</p>
</template>
