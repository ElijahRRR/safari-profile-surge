<script setup lang="ts">
// 设计系统 Badge：soft 底 + 700 字的胶囊；颜色必须与含义一致。
import Icon from '../Icon.vue';
import type { IconName } from '../icons';
import type { BadgeVariant } from './types';

withDefaults(defineProps<{ variant?: BadgeVariant; icon?: IconName }>(), { variant: 'gray', icon: undefined });
</script>

<template>
  <span class="badge" :class="`badge-${variant}`">
    <Icon v-if="icon" :name="icon" size="xs" />
    <slot />
  </span>
</template>
