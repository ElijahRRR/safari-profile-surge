<script setup lang="ts" generic="V extends string | number | null">
// 设计系统 Select 触发器（button.select-trigger + select-value + select-icon）。下拉面板不在设计系统
// 预览内，这里用 bundle 中的 .dropdown / .dropdown-item，按 listbox 模式实现键盘操作：
// 焦点始终留在触发按钮上（aria-activedescendant），因此在弹窗的焦点限制内也能使用。
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import Icon from '../Icon.vue';
import { useFloating } from './floating';
import type { SelectOption } from './types';

const props = withDefaults(
  defineProps<{
    modelValue: V;
    options: ReadonlyArray<SelectOption<V>>;
    label?: string | null;
    accessibleLabel?: string | null;
    placeholder?: string;
    hint?: string | null;
    error?: string | null;
    disabled?: boolean;
    required?: boolean;
    id?: string;
  }>(),
  { label: null, accessibleLabel: null, placeholder: '请选择', hint: null, error: null, disabled: false, required: false, id: undefined },
);
const emit = defineEmits<{ 'update:modelValue': [value: V] }>();

const autoId = useId();
const baseId = computed(() => props.id ?? `select-${autoId}`);
const listId = computed(() => `${baseId.value}-list`);
const labelId = computed(() => `${baseId.value}-label`);
const open = ref(false);
const activeIndex = ref(-1);
const triggerRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const { style, update, listen, unlisten } = useFloating(triggerRef);

const selectedIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));
const selectedLabel = computed(() => props.options[selectedIndex.value]?.label ?? null);
const optionId = (i: number) => `${baseId.value}-opt-${i}`;

function onDocumentPointer(event: Event) {
  const target = event.target as Node | null;
  if (!target) return;
  if (triggerRef.value?.contains(target) || listRef.value?.contains(target)) return;
  close();
}

function openList() {
  if (props.disabled || open.value) return;
  update();
  open.value = true;
  activeIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : firstEnabled(0, 1);
  listen();
  document.addEventListener('mousedown', onDocumentPointer, true);
  void nextTick(scrollActive);
}

function close() {
  if (!open.value) return;
  open.value = false;
  unlisten();
  document.removeEventListener('mousedown', onDocumentPointer, true);
}

function choose(index: number) {
  const opt = props.options[index];
  if (!opt || opt.disabled) return;
  emit('update:modelValue', opt.value);
  close();
  triggerRef.value?.focus();
}

function firstEnabled(from: number, step: 1 | -1): number {
  const n = props.options.length;
  for (let k = 0; k < n; k++) {
    const i = (from + step * k + n * 2) % n;
    if (!props.options[i]?.disabled) return i;
  }
  return -1;
}

function move(step: 1 | -1) {
  if (props.options.length === 0) return;
  activeIndex.value = firstEnabled(activeIndex.value + step, step);
  void nextTick(scrollActive);
}

function scrollActive() {
  const el = activeIndex.value >= 0 ? document.getElementById(optionId(activeIndex.value)) : null;
  el?.scrollIntoView?.({ block: 'nearest' });
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open.value) openList();
      else move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (!open.value) openList();
      else move(-1);
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (!open.value) openList();
      else if (activeIndex.value >= 0) choose(activeIndex.value);
      break;
    case 'Escape':
      if (open.value) {
        // 只关闭下拉，不让外层弹窗一起关闭。
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      break;
    case 'Tab':
      close();
      break;
    default:
      break;
  }
}

function toggle() {
  if (open.value) close();
  else openList();
}

onBeforeUnmount(close);
</script>

<template>
  <div>
    <label v-if="label" :id="labelId" class="input-label" :for="baseId">
      {{ label }}<template v-if="required"> <span class="text-red-500" aria-hidden="true">*</span></template>
    </label>
    <button
      :id="baseId"
      ref="triggerRef"
      type="button"
      class="select-trigger"
      :class="[open ? 'select-trigger-open' : '', error ? 'input-error ring-2 ring-red-500/20' : '', disabled ? 'cursor-not-allowed opacity-60' : '']"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      :aria-label="accessibleLabel ?? undefined"
      :aria-labelledby="!accessibleLabel && label ? `${labelId} ${baseId}` : undefined"
      :aria-invalid="error ? 'true' : undefined"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="select-value" :class="{ 'text-gray-400 dark:text-dark-500': selectedLabel === null }">{{ selectedLabel ?? placeholder }}</span>
      <span class="select-icon"><Icon name="chevronDown" size="sm" /></span>
    </button>
    <p v-if="error" class="input-error-text mt-1.5">{{ error }}</p>
    <p v-else-if="hint" class="input-hint mt-1.5">{{ hint }}</p>
    <Teleport to="body">
      <ul v-if="open" :id="listId" ref="listRef" class="dropdown max-h-64 overflow-y-auto" role="listbox" :aria-labelledby="label ? labelId : undefined" :aria-label="accessibleLabel ?? undefined" :style="style">
        <li
          v-for="(opt, i) in options"
          :id="optionId(i)"
          :key="String(opt.value)"
          class="dropdown-item flex items-start justify-between gap-3"
          :class="[i === activeIndex ? 'bg-gray-100 dark:bg-dark-700' : '', opt.disabled ? 'cursor-not-allowed opacity-50' : '']"
          role="option"
          :aria-selected="opt.value === modelValue ? 'true' : 'false'"
          :aria-disabled="opt.disabled ? 'true' : undefined"
          @mousedown.prevent
          @mouseenter="activeIndex = i"
          @click="choose(i)"
        >
          <span class="min-w-0">
            <span class="block">{{ opt.label }}</span>
            <span v-if="opt.description" class="block text-xs text-gray-500 dark:text-dark-400">{{ opt.description }}</span>
          </span>
          <Icon v-if="opt.value === modelValue" name="check" size="sm" class="mt-0.5 text-primary-600 dark:text-primary-400" />
        </li>
      </ul>
    </Teleport>
  </div>
</template>
