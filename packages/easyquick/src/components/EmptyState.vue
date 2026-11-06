<script setup lang="ts">
// 设计系统 EmptyState：80px bg-muted 图标框（40px 图标）+ 标题 + 「下一步可以做什么」+ 可选主操作。
import Icon from '../Icon.vue';
import type { IconName } from '../icons';

withDefaults(defineProps<{ title: string; description: string; icon?: IconName; actionText?: string | null; actionIcon?: IconName }>(), {
  icon: 'inbox',
  actionText: null,
  actionIcon: 'plus',
});
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="empty-state">
    <div class="mb-5 flex h-20 w-20 items-center justify-center rounded-2xl bg-gray-100 dark:bg-dark-800">
      <Icon :name="icon" class="empty-state-icon h-10 w-10" />
    </div>
    <h3 class="empty-state-title">{{ title }}</h3>
    <p class="empty-state-description">{{ description }}</p>
    <div v-if="actionText" class="mt-6">
      <button type="button" class="btn btn-primary" @click="emit('action')"><Icon :name="actionIcon" />{{ actionText }}</button>
    </div>
  </div>
</template>
