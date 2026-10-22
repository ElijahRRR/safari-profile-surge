<script setup lang="ts">
// 设计系统 AppLayout：min-h-screen bg-gray-50 + 固定的 mesh 渐变层，固定侧边栏（256px / 折叠 72px），
// 主区域 lg:ml-64 内含毛玻璃顶栏与 main（p-4 / md:p-6 / lg:p-8）。
import { computed, inject, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
import DemoBanner from './DemoBanner.vue';
import { useConsole } from '../store/context';
import { normalModeOffered } from '../lib/environments';
import { THEME_KEY } from '../store/theme';
import type { NavItem } from '../router';

const { api, store, toasts, routeActions, logout } = useConsole();
const theme = inject(THEME_KEY, null);
const route = useRoute();

const COLLAPSE_KEY = 'sfe.sidebarCollapsed';
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
const collapsed = ref(readCollapsed());
const mobileOpen = ref(false);
const refreshing = ref(false);

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
  } catch {
    // 只是界面偏好，存不下就不记住。
  }
}

const nav = computed(() => (route.meta.nav as NavItem | undefined) ?? null);
const showNormalMode = computed(() => normalModeOffered(store.route.value));

async function refresh() {
  refreshing.value = true;
  try {
    const surge = await api.refreshSurge();
    store.setSurge(surge);
    toasts.success('已重新读取 Surge 状态');
  } catch (e) {
    toasts.error(e instanceof Error ? e.message : '刷新失败');
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-dark-950">
    <div class="pointer-events-none fixed inset-0 bg-mesh-gradient" />
    <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-black/50 lg:hidden" aria-hidden="true" @click="mobileOpen = false" />
    <AppSidebar
      :collapsed="collapsed"
      :mobile-open="mobileOpen"
      :dark="theme?.state.dark ?? false"
      :version="store.state.snapshot?.serviceVersion ?? store.state.session.info?.serviceVersion ?? null"
      :demo="store.demoMode.value"
      @toggle-collapse="toggleCollapse"
      @toggle-theme="theme?.toggle()"
      @navigate="mobileOpen = false"
    />
    <div class="relative min-h-screen transition-all duration-200" :class="collapsed ? 'lg:ml-[72px]' : 'lg:ml-64'">
      <AppHeader
        :title="nav?.label ?? '概览'"
        :subtitle="nav?.subtitle ?? ''"
        :stream="store.state.stream"
        :show-normal-mode="showNormalMode"
        :refreshing="refreshing"
        @open-menu="mobileOpen = true"
        @normal-mode="routeActions.start({ kind: 'normal' })"
        @refresh="refresh"
        @logout="logout"
      />
      <DemoBanner v-if="store.demoMode.value" />
      <main class="p-4 md:p-6 lg:p-8">
        <slot />
      </main>
    </div>
  </div>
</template>
