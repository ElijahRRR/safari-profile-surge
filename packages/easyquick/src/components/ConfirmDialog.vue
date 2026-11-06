<script setup lang="ts">
// 设计系统 ConfirmDialog：narrow 宽度，正文一行「确定要……吗？」，页脚左「取消」右确认；危险操作用 btn-danger。
import BaseDialog from './BaseDialog.vue';
import Spinner from './Spinner.vue';

withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    message: string;
    confirmText: string;
    variant?: 'primary' | 'danger' | 'warning';
    loading?: boolean;
    confirmDisabled?: boolean;
    width?: 'narrow' | 'normal';
  }>(),
  { variant: 'primary', loading: false, confirmDisabled: false, width: 'narrow' },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <BaseDialog :show="show" :title="title" :width="width" @close="emit('cancel')">
    <p class="text-sm text-gray-500 dark:text-dark-400">{{ message }}</p>
    <div v-if="$slots.default" class="mt-4 space-y-3 text-sm text-gray-700 dark:text-gray-300">
      <slot />
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="loading" @click="emit('cancel')">取消</button>
      <button
        type="button"
        class="btn"
        :class="`btn-${variant}`"
        :disabled="loading || confirmDisabled"
        data-test="confirm"
        @click="emit('confirm')"
      >
        <Spinner v-if="loading" color="white" decorative />
        {{ confirmText }}
      </button>
    </template>
  </BaseDialog>
</template>
