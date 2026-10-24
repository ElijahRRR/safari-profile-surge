<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconName } from './icons';

const props = withDefaults(defineProps<{ name: IconName; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' }>(), { size: 'md' });
const SIZE_CLASS = { xs: 'h-3 w-3', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6', xl: 'h-8 w-8' } as const;
const markup = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    :class="[SIZE_CLASS[props.size], 'flex-shrink-0']"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    stroke-width="1.5"
    aria-hidden="true"
    v-html="markup"
  />
</template>
