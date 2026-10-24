<script setup lang="ts">
// 行内「更多」菜单：触发按钮为 btn-ghost btn-sm 图标按钮（带 aria-label），面板用 bundle 的
// .dropdown / .dropdown-item，挂到 body 避免被表格卡片的 overflow-hidden 裁切。
import { nextTick, onBeforeUnmount, ref, useId } from 'vue';
import Icon from '../Icon.vue';
import type { IconName } from '../icons';
import { useFloating } from './floating';
import type { MenuItem } from './types';

const props = withDefaults(defineProps<{ items: MenuItem[]; label: string; icon?: IconName; triggerClass?: string }>(), {
  icon: 'more',
  triggerClass: 'btn btn-ghost btn-sm',
});
const emit = defineEmits<{ select: [key: string] }>();

const menuId = `menu-${useId()}`;
const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const { style, update, listen, unlisten } = useFloating(triggerRef, 'end');

function items(): HTMLElement[] {
  return Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
}

function onDocumentPointer(event: Event) {
  const target = event.target as Node | null;
  if (!target || triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  close(false);
}

async function openMenu(focusFirst: boolean) {
  if (open.value || props.items.length === 0) return;
  update();
  open.value = true;
  listen();
  document.addEventListener('mousedown', onDocumentPointer, true);
  await nextTick();
  if (focusFirst) items()[0]?.focus();
}

function close(returnFocus: boolean) {
  if (!open.value) return;
  open.value = false;
  unlisten();
  document.removeEventListener('mousedown', onDocumentPointer, true);
  if (returnFocus) triggerRef.value?.focus();
}

function choose(item: MenuItem) {
  if (item.disabled) return;
  close(true);
  emit('select', item.key);
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void openMenu(true);
  }
}

function onMenuKeydown(event: KeyboardEvent) {
  const list = items();
  const index = list.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    list[(index + step + list.length) % list.length]?.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === 'Tab') {
    close(false);
  }
}

onBeforeUnmount(() => close(false));
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    :class="triggerClass"
    :aria-label="label"
    :title="label"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-controls="open ? menuId : undefined"
    @click="open ? close(false) : openMenu(false)"
    @keydown="onTriggerKeydown"
  >
    <Icon :name="icon" size="sm" />
  </button>
  <Teleport to="body">
    <div v-if="open" :id="menuId" ref="menuRef" class="dropdown min-w-[10rem]" role="menu" :aria-label="label" :style="style" @keydown="onMenuKeydown">
      <button
        v-for="item in props.items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="dropdown-item flex w-full items-center gap-2 text-left"
        :class="item.danger ? 'text-red-600 dark:text-red-400' : ''"
        :disabled="item.disabled"
        @click="choose(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>
