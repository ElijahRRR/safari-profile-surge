<script setup lang="ts">
// 设计系统 SearchInput：前缀 pl-3 的搜索图标 + 输入框 pl-10，筛选栏中约 288px 宽。
import Icon from '../Icon.vue';

withDefaults(defineProps<{ modelValue: string; placeholder?: string; label: string; widthClass?: string }>(), {
  placeholder: '搜索…',
  widthClass: 'w-72',
});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="relative max-w-full" :class="widthClass">
    <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3"><Icon name="search" class="text-gray-400" /></div>
    <input
      type="text"
      class="input pl-10"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="label"
      autocomplete="off"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>
