<script setup lang="ts">
// 设计系统 AppHeader：粘在顶部的毛玻璃顶栏（h-16），左侧页面标题与说明，右侧全局工具。
// 页面自己的操作放在 PageHeader；这里只放全局的：进入普通模式、刷新 Surge 状态、实时连接状态、退出登录。
import { computed } from 'vue';
import { Icon, StatusBadge } from '@sfe/easyquick';
import type { StreamState } from '../api/event-stream';

const props = defineProps<{ title: string; subtitle: string; stream: StreamState; showNormalMode: boolean; refreshing: boolean }>();
const emit = defineEmits<{ openMenu: []; normalMode: []; refresh: []; logout: [] }>();

const streamBadge = computed(() => {
  switch (props.stream) {
    case 'open':
      return { status: 'success', label: '实时同步' };
    case 'connecting':
    case 'reconnecting':
      return { status: 'warning', label: '正在重连' };
    default:
      return { status: 'unknown', label: '未连接' };
  }
});

const LINK =
  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-dark-400 dark:hover:bg-dark-800 dark:hover:text-white';
</script>

<template>
  <header class="glass sticky top-0 z-30 border-b border-gray-200/50 dark:border-dark-700/50">
    <div class="flex h-16 items-center justify-between gap-2 px-2 sm:px-4 md:px-6">
      <div class="flex min-w-0 shrink-0 items-center gap-2 sm:gap-4">
        <button type="button" class="btn btn-ghost btn-icon lg:hidden" aria-label="打开导航" @click="emit('openMenu')"><Icon name="menu" /></button>
        <div class="hidden lg:block">
          <h1 class="text-lg font-semibold text-gray-900 dark:text-white">{{ title }}</h1>
          <p class="text-xs text-gray-500 dark:text-dark-400">{{ subtitle }}</p>
        </div>
      </div>
      <div class="flex min-w-0 items-center gap-1 sm:gap-3">
        <div class="hidden sm:flex"><StatusBadge :status="streamBadge.status" :label="streamBadge.label" /></div>
        <button v-if="showNormalMode" type="button" :class="LINK" data-test="header-normal-mode" @click="emit('normalMode')">
          <Icon name="ban" size="sm" /><span class="hidden sm:inline">进入普通模式</span><span class="sr-only sm:hidden">进入普通模式</span>
        </button>
        <button type="button" :class="LINK" :disabled="refreshing" @click="emit('refresh')">
          <Icon name="refresh" size="sm" /><span class="hidden sm:inline">刷新状态</span><span class="sr-only sm:hidden">刷新状态</span>
        </button>
        <button type="button" :class="LINK" @click="emit('logout')">
          <Icon name="lock" size="sm" /><span class="hidden sm:inline">退出登录</span><span class="sr-only sm:hidden">退出登录</span>
        </button>
      </div>
    </div>
  </header>
</template>
