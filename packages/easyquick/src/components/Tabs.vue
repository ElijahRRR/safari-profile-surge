<script setup lang="ts" generic="V extends string">
// 设计系统 Tabs：同一数据集的视图切换（分段控件）。放在筛选栏里时加 w-fit。
// 左右方向键在选项间移动。
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{ modelValue: V; options: ReadonlyArray<{ value: V; label: string; count?: number | null }>; fit?: boolean; label: string }>(),
  { fit: true },
);
const emit = defineEmits<{ 'update:modelValue': [value: V] }>();
const buttons = ref<HTMLButtonElement[]>([]);

function onKeydown(event: KeyboardEvent, index: number) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const n = props.options.length;
  const next = (index + (event.key === 'ArrowRight' ? 1 : n - 1)) % n;
  const opt = props.options[next];
  if (!opt) return;
  emit('update:modelValue', opt.value);
  buttons.value[next]?.focus();
}
</script>

<template>
  <div class="tabs" :class="{ 'w-fit': fit }" role="tablist" :aria-label="label">
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      ref="buttons"
      type="button"
      role="tab"
      class="tab"
      :class="{ 'tab-active': opt.value === modelValue }"
      :aria-selected="opt.value === modelValue ? 'true' : 'false'"
      :tabindex="opt.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', opt.value)"
      @keydown="onKeydown($event, i)"
    >
      {{ opt.label }}<span v-if="opt.count !== undefined && opt.count !== null" class="ml-1.5 text-xs text-gray-500 dark:text-dark-400">{{ opt.count }}</span>
    </button>
  </div>
</template>
