<script setup lang="ts">
// 设计系统 Sidebar（AppSidebar.vue）：品牌区（36px gradient-primary + shadow-glow 的 Logo 占位框，白色 cube 图标）、
// 分组导航、底部主题切换与折叠。折叠态 72px，文字隐藏、导航靠 title 提示。
import { RouterLink, useRoute } from 'vue-router';
import { Icon } from '@sfe/easyquick';
import { NAV_SECTIONS } from '../router';

const props = defineProps<{ collapsed: boolean; mobileOpen: boolean; dark: boolean; version: string | null; demo: boolean }>();
const emit = defineEmits<{ toggleCollapse: []; toggleTheme: []; navigate: [] }>();
const route = useRoute();

function isActive(path: string): boolean {
  return path === '/' ? route.path === '/' : route.path === path || route.path.startsWith(`${path}/`);
}
</script>

<template>
  <aside
    class="sidebar"
    :class="[props.collapsed ? 'lg:w-[72px]' : '', props.mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0']"
    aria-label="主导航"
  >
    <div class="sidebar-header" :class="{ 'sidebar-header-collapsed': props.collapsed }">
      <div class="sidebar-logo flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-gradient-primary text-white shadow-glow" aria-hidden="true">
        <Icon name="cube" />
      </div>
      <div class="sidebar-brand" :class="{ 'sidebar-brand-collapsed': props.collapsed }" :aria-hidden="props.collapsed ? 'true' : undefined">
        <span class="sidebar-brand-title text-lg font-bold text-gray-900 dark:text-white">Safari 场景出口</span>
        <div class="relative flex items-center gap-1.5">
          <span class="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-dark-800 dark:text-dark-400">
            <span class="font-medium">{{ props.version ? `v${props.version}` : '—' }}</span>
          </span>
          <span v-if="props.demo" class="badge badge-warning">DEMO</span>
        </div>
      </div>
    </div>
    <nav class="sidebar-nav scrollbar-hide">
      <div v-for="(section, si) in NAV_SECTIONS" :key="si" class="sidebar-section">
        <div
          v-if="section.title"
          class="sidebar-section-title"
          :class="{ 'sidebar-section-title-collapsed': props.collapsed }"
          :aria-hidden="props.collapsed ? 'true' : undefined"
        >
          <span class="sidebar-section-title-text" :class="{ 'sidebar-section-title-text-collapsed': props.collapsed }">{{ section.title }}</span>
        </div>
        <RouterLink
          v-for="item in section.items"
          :key="item.name"
          :to="item.path"
          class="sidebar-link mb-1"
          :class="{ 'sidebar-link-active': isActive(item.path), 'sidebar-link-collapsed': props.collapsed }"
          :title="props.collapsed ? item.label : undefined"
          :aria-current="isActive(item.path) ? 'page' : undefined"
          :aria-label="props.collapsed ? item.label : undefined"
          @click="emit('navigate')"
        >
          <Icon :name="item.icon" />
          <span class="sidebar-label" :class="{ 'sidebar-label-collapsed': props.collapsed }" :aria-hidden="props.collapsed ? 'true' : undefined">{{ item.label }}</span>
        </RouterLink>
      </div>
    </nav>
    <div class="mt-auto border-t border-gray-100 p-3 dark:border-dark-800">
      <button
        type="button"
        class="sidebar-link mb-2 w-full"
        :class="{ 'sidebar-link-collapsed': props.collapsed }"
        :title="props.collapsed ? (props.dark ? '浅色模式' : '深色模式') : undefined"
        :aria-label="props.dark ? '切换到浅色模式' : '切换到深色模式'"
        @click="emit('toggleTheme')"
      >
        <Icon :name="props.dark ? 'sun' : 'moon'" />
        <span class="sidebar-label" :class="{ 'sidebar-label-collapsed': props.collapsed }" aria-hidden="true">{{ props.dark ? '浅色模式' : '深色模式' }}</span>
      </button>
      <button
        type="button"
        class="sidebar-link hidden w-full lg:flex"
        :class="{ 'sidebar-link-collapsed': props.collapsed }"
        :title="props.collapsed ? '展开' : undefined"
        :aria-label="props.collapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-expanded="props.collapsed ? 'false' : 'true'"
        @click="emit('toggleCollapse')"
      >
        <Icon :name="props.collapsed ? 'chevronRight' : 'chevronLeft'" />
        <span class="sidebar-label" :class="{ 'sidebar-label-collapsed': props.collapsed }" aria-hidden="true">{{ props.collapsed ? '展开' : '收起' }}</span>
      </button>
    </div>
  </aside>
</template>
