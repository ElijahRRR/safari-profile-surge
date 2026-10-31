// 组件使用设计系统的类名与结构（EasyQuick UI reference/components 的预览）。
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createMemoryHistory } from 'vue-router';
import { Badge, BaseDialog, ConfirmDialog, DataTable, EmptyState, StatCard, StatusBadge, Tabs, ToastStack, Toggle, cellPaddingClass } from '@sfe/easyquick';
import AppSidebar from '../src/components/AppSidebar.vue';
import { createConsoleRouter } from '../src/router';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Sidebar', () => {
  async function mountSidebar(path: string, collapsed = false) {
    const router = createConsoleRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    return mount(AppSidebar, { props: { collapsed, mobileOpen: false, dark: false, version: '0.1.0', demo: true }, global: { plugins: [router] } });
  }

  it('marks the current route with sidebar-link-active', async () => {
    const w = await mountSidebar('/environments');
    const active = w.findAll('.sidebar-link-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain('环境');
    expect(active[0]!.attributes('aria-current')).toBe('page');
    expect(w.find('aside.sidebar .sidebar-header .sidebar-logo.bg-gradient-primary.shadow-glow').exists()).toBe(true);
    expect(w.find('.sidebar-brand-title').text()).toBe('Safari 场景出口');
    expect(w.find('.sidebar-section-title').exists()).toBe(true);
    expect(w.text()).toContain('v0.1.0');
    expect(w.find('.badge.badge-warning').text()).toBe('DEMO');
  });

  it('collapsed state uses the collapsed classes and keeps titles', async () => {
    const w = await mountSidebar('/', true);
    expect(w.find('.sidebar-header-collapsed').exists()).toBe(true);
    expect(w.findAll('.sidebar-link-collapsed').length).toBeGreaterThan(5);
    expect(w.find('a.sidebar-link').attributes('title')).toBe('概览');
    expect(w.find('aside').classes()).toContain('lg:w-[72px]');
  });
});

describe('Badge and StatusBadge', () => {
  it('Badge renders badge + variant', () => {
    const w = mount(Badge, { props: { variant: 'success' }, slots: { default: '使用中' } });
    expect(w.classes()).toEqual(['badge', 'badge-success']);
    expect(w.text()).toBe('使用中');
  });

  it('StatusBadge always has text next to the dot', () => {
    const w = mount(StatusBadge, { props: { status: 'danger', label: '同步失败' } });
    expect(w.find('.bg-red-500.rounded-full').exists()).toBe(true);
    expect(w.text()).toBe('同步失败');
  });
});

describe('StatCard', () => {
  it('uses stat-card / stat-icon-* / stat-label / stat-value with thousands separators', () => {
    const w = mount(StatCard, { props: { title: '环境总数', value: 1284, icon: 'users', iconVariant: 'warning' } });
    expect(w.classes()).toContain('stat-card');
    expect(w.find('.stat-icon.stat-icon-warning').exists()).toBe(true);
    expect(w.find('.stat-label').text()).toBe('环境总数');
    expect(w.find('.stat-value').text()).toBe('1,284');
  });
});

describe('DataTable', () => {
  const rows = [{ id: 'a', name: 'E0001' }];
  it('uses the card / table-wrapper / thead.bg-gray-50 structure with th scope', () => {
    const w = mount(DataTable, {
      props: { columns: [{ key: 'name', label: '环境' }], rows, rowKey: (r: unknown) => (r as { id: string }).id },
    });
    expect(w.classes()).toEqual(expect.arrayContaining(['card', 'overflow-hidden']));
    expect(w.find('.table-wrapper > table').exists()).toBe(true);
    const th = w.find('thead.bg-gray-50 th');
    expect(th.attributes('scope')).toBe('col');
    expect(th.classes()).toEqual(expect.arrayContaining(['text-xs', 'uppercase', 'tracking-wider', 'px-6']));
    expect(w.find('tbody tr').classes()).toContain('hover:bg-gray-50');
  });

  it('tightens horizontal padding by column count', () => {
    expect([1, 4, 5, 6, 7, 9, 10, 12].map(cellPaddingClass)).toEqual(['px-6', 'px-6', 'px-4', 'px-4', 'px-3', 'px-3', 'px-2', 'px-2']);
  });

  it('renders the empty slot and skeleton rows', () => {
    const empty = mount(DataTable, { props: { columns: [{ key: 'name', label: '环境' }], rows: [], rowKey: () => 'x' }, slots: { empty: '<p class="empty">空</p>' } });
    expect(empty.find('.empty').exists()).toBe(true);
    const loading = mount(DataTable, { props: { columns: [{ key: 'name', label: '环境' }], rows: [], rowKey: () => 'x', loading: true } });
    expect(loading.findAll('.animate-pulse').length).toBe(3);
  });
});

describe('Tabs and Toggle', () => {
  it('Tabs use tabs/tab/tab-active with tablist roles', async () => {
    const w = mount(Tabs, { props: { modelValue: 'all', label: '筛选', options: [{ value: 'all', label: '全部' }, { value: 'using', label: '使用中' }] } });
    expect(w.classes()).toEqual(expect.arrayContaining(['tabs', 'w-fit']));
    expect(w.attributes('role')).toBe('tablist');
    const tabs = w.findAll('button.tab');
    expect(tabs[0]!.classes()).toContain('tab-active');
    expect(tabs[0]!.attributes('aria-selected')).toBe('true');
    await tabs[1]!.trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['using']);
  });

  it('Toggle is a button role=switch with the preview markup', async () => {
    const w = mount(Toggle, { props: { modelValue: true, label: '只看冲突' } });
    expect(w.element.tagName).toBe('BUTTON');
    expect(w.attributes('type')).toBe('button');
    expect(w.attributes('role')).toBe('switch');
    expect(w.attributes('aria-checked')).toBe('true');
    expect(w.classes()).toContain('bg-primary-600');
    expect(w.find('span').classes()).toContain('translate-x-5');
    await w.trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false]);
  });
});

describe('Dialog', () => {
  it('uses modal-overlay / modal-content / header / title / footer, traps focus and closes on Esc', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();
    const show = ref(true);
    const closed: number[] = [];
    const Host = defineComponent({
      render: () =>
        h(
          BaseDialog,
          { show: show.value, title: '编辑环境', onClose: () => closed.push(1) },
          { default: () => h('input', { class: 'input', id: 'first' }), footer: () => [h('button', { type: 'button', class: 'btn btn-secondary' }, '取消'), h('button', { type: 'button', class: 'btn btn-primary', id: 'last' }, '保存')] },
        ),
    });
    const w = mount(Host, { attachTo: document.body });
    await nextTick();
    await nextTick();
    const overlay = document.body.querySelector('.modal-overlay')!;
    expect(overlay).not.toBeNull();
    const content = overlay.querySelector('.modal-content.max-w-lg')!;
    expect(content.getAttribute('role')).toBe('dialog');
    expect(content.getAttribute('aria-modal')).toBe('true');
    expect(content.querySelector('.modal-header .modal-title')?.textContent).toBe('编辑环境');
    expect(content.querySelector('.modal-header button[aria-label="关闭"]')).not.toBeNull();
    const footer = content.querySelectorAll('.modal-footer button');
    expect(footer[0]?.textContent).toBe('取消');
    expect(footer[0]?.className).toContain('btn-secondary');
    expect(document.activeElement?.id).toBe('first');

    (document.getElementById('last') as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveLength(1);
    show.value = false;
    await nextTick();
    expect(document.activeElement).toBe(outside);
    w.unmount();
  });

  it('ConfirmDialog is narrow with 取消 on the left and btn-danger for dangerous actions', async () => {
    const w = mount(ConfirmDialog, { attachTo: document.body, props: { show: true, title: '删除环境', message: '确定要删除环境 US-买家01 吗？', confirmText: '删除', variant: 'danger' } });
    await nextTick();
    expect(document.body.querySelector('.modal-content')?.className).toContain('max-w-md');
    const buttons = document.body.querySelectorAll('.modal-footer button');
    expect(buttons[0]?.textContent?.trim()).toBe('取消');
    expect(buttons[1]?.className).toContain('btn-danger');
    expect(document.body.querySelector('.modal-body')?.textContent).toContain('确定要删除环境 US-买家01 吗？');
    w.unmount();
  });
});

describe('Toast and EmptyState', () => {
  it('toasts are stacked top-right in an aria-live region with a 4px status border', () => {
    const w = mount(ToastStack, { props: { toasts: [{ id: 1, type: 'success', message: '设置已保存', duration: 4000 }, { id: 2, type: 'error', message: '保存失败：版本冲突', duration: 8000 }] } });
    expect(w.attributes('aria-live')).toBe('polite');
    expect(w.classes()).toEqual(expect.arrayContaining(['fixed', 'right-4', 'top-4']));
    const items = w.findAll('.toast-item');
    expect(items[0]!.classes()).toEqual(expect.arrayContaining(['border-l-4', 'border-green-500']));
    expect(items[1]!.attributes('role')).toBe('alert');
    expect(w.findAll('.h-1').length).toBe(2);
  });

  it('EmptyState has the 80px muted icon box, title, description and primary action', async () => {
    const w = mount(EmptyState, { props: { title: '还没有环境', description: '导入表格批量建立环境。', actionText: '新建环境' } });
    expect(w.classes()).toContain('empty-state');
    expect(w.find('.h-20.w-20.rounded-2xl.bg-gray-100 .empty-state-icon').exists()).toBe(true);
    expect(w.find('.empty-state-title').text()).toBe('还没有环境');
    await w.find('button.btn.btn-primary').trigger('click');
    expect(w.emitted('action')).toHaveLength(1);
  });
});
