<script setup lang="ts">
// 设计系统 LoadingSpinner：currentColor 圆环、顶边透明；带「加载中」读屏文字。
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ size?: 'sm' | 'md' | 'lg' | 'xl'; color?: 'primary' | 'secondary' | 'gray' | 'white'; label?: string; decorative?: boolean }>(),
  { size: 'sm', color: 'primary', label: '加载中', decorative: false },
);

const SIZE = { sm: 'w-4 h-4 border-2', md: 'w-8 h-8 border-2', lg: 'w-12 h-12 border-[3px]', xl: 'w-16 h-16 border-4' } as const;
const COLOR = {
  primary: 'text-primary-500',
  secondary: 'text-gray-500 dark:text-dark-400',
  gray: 'text-gray-400 dark:text-dark-500',
  white: 'text-white',
} as const;
const classes = computed(() => ['spinner', SIZE[props.size], COLOR[props.color]]);
</script>

<template>
  <span v-if="decorative" :class="classes" aria-hidden="true" />
  <div v-else :class="classes" role="status" :aria-label="label" />
</template>
