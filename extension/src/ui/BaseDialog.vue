<script setup lang="ts">
// EasyQuick Dialog（BaseDialog 结构）：modal-overlay → modal-content → header / body / footer。
import { onBeforeUnmount, onMounted } from 'vue';
import { Icon } from '@sfe/easyquick';
import { useDialogTracking } from './dialog';

const props = withDefaults(defineProps<{ title: string; width?: 'narrow' | 'normal' }>(), { width: 'normal' });
const emit = defineEmits<{ close: [] }>();

const titleId = `dlg-${Math.random().toString(36).slice(2, 10)}`;
useDialogTracking();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" :aria-labelledby="titleId">
    <div class="modal-content" :class="props.width === 'narrow' ? 'max-w-md' : 'max-w-lg'">
      <div class="modal-header">
        <h3 :id="titleId" class="modal-title">{{ props.title }}</h3>
        <button
          type="button"
          class="-mr-2 rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 dark:text-dark-500 dark:hover:bg-dark-700 dark:hover:text-dark-300"
          aria-label="关闭"
          data-test="dialog-close"
          @click="emit('close')"
        >
          <Icon name="x" size="md" />
        </button>
      </div>
      <div class="modal-body space-y-3 text-sm text-gray-600 dark:text-gray-300">
        <slot />
      </div>
      <div class="modal-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
