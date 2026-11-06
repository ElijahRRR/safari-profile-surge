<script setup lang="ts">
// 设计系统 Toggle（Toggle.vue 预览原样）：button[role=switch]，开关立即生效。
// 需要「保存」才生效的选项用复选框，不用开关。
withDefaults(defineProps<{ modelValue: boolean; label: string; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="label"
    :disabled="disabled"
    class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-dark-800"
    :class="modelValue ? 'bg-primary-600' : 'bg-gray-200 dark:bg-dark-600'"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
      :class="modelValue ? 'translate-x-5' : 'translate-x-0'"
    />
  </button>
</template>
