// Toast 队列：只放一句话的结果，自动消失；需要用户决定的事用弹窗。

import { reactive } from 'vue';
import type { ToastItem } from '@sfe/easyquick';
import type { Timers } from '../api/event-stream';

export type ToastType = ToastItem['type'];

export const TOAST_DURATION: Record<ToastType, number> = { success: 4000, info: 5000, warning: 7000, error: 8000 };
const MAX_VISIBLE = 5;

export interface ToastQueue {
  readonly items: ToastItem[];
  push(type: ToastType, message: string, opts?: { title?: string | null; duration?: number }): number;
  dismiss(id: number): void;
  success(message: string, title?: string): number;
  info(message: string, title?: string): number;
  warning(message: string, title?: string): number;
  error(message: string, title?: string): number;
}

export function createToastQueue(timers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }): ToastQueue {
  const items = reactive<ToastItem[]>([]);
  const handles = new Map<number, unknown>();
  let nextId = 1;

  function dismiss(id: number) {
    const i = items.findIndex((t) => t.id === id);
    if (i >= 0) items.splice(i, 1);
    const h = handles.get(id);
    if (h !== undefined) timers.clearTimeout(h);
    handles.delete(id);
  }

  function push(type: ToastType, message: string, opts: { title?: string | null; duration?: number } = {}): number {
    const id = nextId++;
    const duration = opts.duration ?? TOAST_DURATION[type];
    items.push({ id, type, title: opts.title ?? null, message, duration });
    while (items.length > MAX_VISIBLE) dismiss(items[0]!.id);
    if (duration > 0) handles.set(id, timers.setTimeout(() => dismiss(id), duration));
    return id;
  }

  return {
    items,
    push,
    dismiss,
    success: (m, t) => push('success', m, { title: t ?? null }),
    info: (m, t) => push('info', m, { title: t ?? null }),
    warning: (m, t) => push('warning', m, { title: t ?? null }),
    error: (m, t) => push('error', m, { title: t ?? null }),
  };
}
