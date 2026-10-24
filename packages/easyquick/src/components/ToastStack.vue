<script setup lang="ts">
// 设计系统 Toast：右上角纵向堆叠，左侧 4px 状态色边，状态图标 + 文字 + 关闭按钮；有时长时底部进度条倒计时。
// 只放一句话的结果；需要用户决定的事用 Dialog。
import Icon from '../Icon.vue';
import type { IconName } from '../icons';
import ToastBar from './ToastBar.vue';
import type { ToastItem } from './types';

defineProps<{ toasts: ToastItem[] }>();
const emit = defineEmits<{ dismiss: [id: number] }>();

const STYLE: Record<ToastItem['type'], { border: string; text: string; bar: string; icon: IconName }> = {
  success: { border: 'border-green-500', text: 'text-green-500', bar: 'bg-green-500', icon: 'checkCircle' },
  error: { border: 'border-red-500', text: 'text-red-500', bar: 'bg-red-500', icon: 'xCircle' },
  warning: { border: 'border-yellow-500', text: 'text-yellow-500', bar: 'bg-yellow-500', icon: 'exclamationTriangle' },
  info: { border: 'border-blue-500', text: 'text-blue-500', bar: 'bg-blue-500', icon: 'infoCircle' },
};
</script>

<template>
  <div class="pointer-events-none fixed right-4 top-4 z-[100] space-y-3" aria-live="polite" aria-relevant="additions" role="region" aria-label="通知">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast-item pointer-events-auto min-w-[320px] max-w-md overflow-hidden rounded-lg border-l-4 bg-white shadow-lg dark:bg-dark-800"
      :class="STYLE[t.type].border"
      :role="t.type === 'error' ? 'alert' : 'status'"
      :data-type="t.type"
    >
      <div class="p-4">
        <div class="flex items-start gap-3">
          <div class="mt-0.5 flex-shrink-0"><Icon :name="STYLE[t.type].icon" :class="STYLE[t.type].text" /></div>
          <div class="min-w-0 flex-1">
            <template v-if="t.title">
              <p class="text-sm font-semibold text-gray-900 dark:text-white">{{ t.title }}</p>
              <p class="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ t.message }}</p>
            </template>
            <p v-else class="text-sm leading-relaxed text-gray-900 dark:text-white">{{ t.message }}</p>
          </div>
          <button
            type="button"
            class="-m-1 flex-shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-dark-700 dark:hover:text-gray-300"
            aria-label="关闭"
            @click="emit('dismiss', t.id)"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      </div>
      <ToastBar v-if="t.duration > 0" :duration="t.duration" :bar-class="STYLE[t.type].bar" />
    </div>
  </div>
</template>
