<script setup lang="ts">
// 设计系统 BaseDialog：modal-overlay → modal-content → modal-header / modal-body / modal-footer。
// 挂到 body 上，避免被毛玻璃顶栏等祖先的 backdrop-filter 改变定位；焦点限制在弹窗内，Esc 关闭。
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import Icon from '../Icon.vue';
import { focusableWithin, isTopDialog, popDialog, pushDialog, trapTab } from './focus';

const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    width?: 'narrow' | 'normal' | 'wide' | 'extra-wide' | 'full';
    closeOnEscape?: boolean;
    closeOnClickOutside?: boolean;
    showCloseButton?: boolean;
    /** 打开时优先聚焦的元素选择器（在弹窗内查找）。 */
    initialFocus?: string;
  }>(),
  { width: 'normal', closeOnEscape: true, closeOnClickOutside: false, showCloseButton: true, initialFocus: undefined },
);
const emit = defineEmits<{ close: [] }>();

const WIDTH_CLASS = {
  narrow: 'max-w-md',
  normal: 'max-w-lg',
  wide: 'max-w-3xl',
  'extra-wide': 'max-w-5xl',
  full: 'max-w-7xl',
} as const;

const titleId = `dlg-${useId()}`;
const contentRef = ref<HTMLElement | null>(null);
const token = Symbol('dialog');
let previouslyFocused: HTMLElement | null = null;
let registered = false;

const widthClass = computed(() => WIDTH_CLASS[props.width]);

function onDocumentKeydown(event: KeyboardEvent) {
  if (!props.show || !isTopDialog(token)) return;
  if (event.key === 'Escape' && props.closeOnEscape) {
    event.preventDefault();
    emit('close');
    return;
  }
  if (contentRef.value) trapTab(event, contentRef.value);
}

function onOverlayClick(event: MouseEvent) {
  if (props.closeOnClickOutside && event.target === event.currentTarget) emit('close');
}

async function activate() {
  if (registered) return;
  registered = true;
  previouslyFocused = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  pushDialog(token);
  document.addEventListener('keydown', onDocumentKeydown);
  await nextTick();
  const root = contentRef.value;
  if (!root) return;
  const preferred = props.initialFocus ? root.querySelector<HTMLElement>(props.initialFocus) : null;
  const body = root.querySelector<HTMLElement>('.modal-body');
  const target = preferred ?? (body ? focusableWithin(body)[0] : undefined) ?? focusableWithin(root)[0] ?? root;
  target.focus();
}

function deactivate() {
  if (!registered) return;
  registered = false;
  popDialog(token);
  document.removeEventListener('keydown', onDocumentKeydown);
  const back = previouslyFocused;
  previouslyFocused = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
}

watch(
  () => props.show,
  (show) => {
    if (show) void activate();
    else deactivate();
  },
  { immediate: true },
);
onBeforeUnmount(deactivate);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay" role="presentation" @click="onOverlayClick">
        <div
          ref="contentRef"
          class="modal-content"
          :class="widthClass"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <div class="modal-header">
            <h3 :id="titleId" class="modal-title">{{ title }}</h3>
            <button
              v-if="showCloseButton"
              type="button"
              class="-mr-2 rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 focus-visible:ring-offset-2 dark:text-dark-500 dark:hover:bg-dark-700 dark:hover:text-dark-300 dark:focus-visible:ring-offset-dark-900"
              aria-label="关闭"
              @click="emit('close')"
            >
              <Icon name="x" />
            </button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
