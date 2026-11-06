// 下拉面板定位：面板挂到 body 上（表格的 overflow-hidden 与毛玻璃顶栏都会裁切或改变定位），
// 用 fixed 坐标贴住触发按钮。坐标经 CSSOM 设置（:style），符合 CSP 的 style-src 'self'。
import { onBeforeUnmount, ref, type Ref } from 'vue';

export interface FloatingPosition {
  position: 'fixed';
  top: string;
  left: string;
  minWidth: string;
  zIndex: string;
}

export function useFloating(trigger: Ref<HTMLElement | null>, align: 'start' | 'end' = 'start') {
  const style = ref<FloatingPosition>({ position: 'fixed', top: '0px', left: '0px', minWidth: '0px', zIndex: '60' });

  function update() {
    const el = trigger.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, 160);
    const left = align === 'end' ? Math.max(8, rect.right - width) : rect.left;
    style.value = {
      position: 'fixed',
      top: `${Math.round(rect.bottom + 4)}px`,
      left: `${Math.round(left)}px`,
      minWidth: `${Math.round(rect.width)}px`,
      zIndex: '60',
    };
  }

  let listening = false;
  function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
  }
  function unlisten() {
    if (!listening) return;
    listening = false;
    window.removeEventListener('resize', update);
    window.removeEventListener('scroll', update, true);
  }
  onBeforeUnmount(unlisten);
  return { style, update, listen, unlisten };
}
