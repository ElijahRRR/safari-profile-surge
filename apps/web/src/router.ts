// hash 路由（静态文件由本机服务提供，不依赖服务端路由回退）。导航数据与侧边栏共用。

import { createRouter, createWebHashHistory, type RouteRecordRaw, type RouterHistory } from 'vue-router';
import type { IconName } from '@sfe/easyquick';
import OverviewView from './views/OverviewView.vue';
import EnvironmentsView from './views/EnvironmentsView.vue';
import BindingWizardView from './views/BindingWizardView.vue';
import ImportView from './views/ImportView.vue';
import PublishView from './views/PublishView.vue';
import CapabilitiesView from './views/CapabilitiesView.vue';
import OperationsView from './views/OperationsView.vue';
import SettingsPageView from './views/SettingsPageView.vue';

export interface NavItem {
  name: string;
  path: string;
  label: string;
  icon: IconName;
  /** 顶栏副标题：这一页做什么。 */
  subtitle: string;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      { name: 'overview', path: '/', label: '概览', icon: 'home', subtitle: '当前路由、Surge 状态与能力门槛' },
      { name: 'environments', path: '/environments', label: '环境', icon: 'users', subtitle: '买家环境、代理出口与 Safari 场景' },
      { name: 'binding', path: '/binding', label: '场景关联', icon: 'link', subtitle: '为新环境创建并关联 Safari 场景' },
      { name: 'import', path: '/import', label: '导入', icon: 'upload', subtitle: '从 CSV、XLSX 或 JSON 批量建立环境' },
    ],
  },
  {
    title: 'Surge',
    items: [
      { name: 'publish', path: '/publish', label: '发布与 Surge', icon: 'server', subtitle: '固定工作配置、节点发布与前置代理' },
      { name: 'capabilities', path: '/capabilities', label: '能力门槛', icon: 'shield', subtitle: 'P0 实测结论与待确认的提议' },
    ],
  },
  {
    title: '系统',
    items: [
      { name: 'operations', path: '/operations', label: '操作记录', icon: 'clipboard', subtitle: '每个任务的阶段、结果与回滚' },
      { name: 'settings', path: '/settings', label: '设置', icon: 'cog', subtitle: '检测服务、默认前置与超时' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

const COMPONENTS: Record<string, RouteRecordRaw['component']> = {
  overview: OverviewView,
  environments: EnvironmentsView,
  binding: BindingWizardView,
  import: ImportView,
  publish: PublishView,
  capabilities: CapabilitiesView,
  operations: OperationsView,
  settings: SettingsPageView,
};

export const routes: RouteRecordRaw[] = [
  ...NAV_ITEMS.map((item) => ({ path: item.path, name: item.name, component: COMPONENTS[item.name]!, meta: { nav: item } })),
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createConsoleRouter(history: RouterHistory = createWebHashHistory()) {
  return createRouter({ history, routes });
}
