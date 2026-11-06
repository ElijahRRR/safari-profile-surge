<script setup lang="ts">
// 门槛不满足时列出缺失的能力（标签 + 当前有效结论），并指向能力门槛页。没有任何“仍然执行”的入口。
import { RouterLink } from 'vue-router';
import { Badge } from '@sfe/easyquick';
import type { MissingCapability } from '../lib/gates';
import { CAPABILITY_STATUS_LABELS } from '../lib/labels';

withDefaults(defineProps<{ missing: MissingCapability[]; intro?: string }>(), { intro: '以下能力尚未在测试 Mac 上通过实测并经你确认：' });
</script>

<template>
  <div class="space-y-2 text-sm" data-test="missing-capabilities">
    <p class="text-gray-700 dark:text-gray-300">{{ intro }}</p>
    <ul class="flex flex-wrap gap-2">
      <li v-for="m in missing" :key="m.key" class="flex items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1 dark:bg-dark-800">
        <span class="text-gray-900 dark:text-gray-100">{{ m.label }}</span>
        <Badge :variant="CAPABILITY_STATUS_LABELS[m.status].variant">{{ m.measured ? '未测量' : CAPABILITY_STATUS_LABELS[m.status].label }}</Badge>
      </li>
    </ul>
    <RouterLink to="/capabilities" class="inline-block font-medium text-primary-700 hover:underline dark:text-primary-400">查看能力门槛</RouterLink>
  </div>
</template>
