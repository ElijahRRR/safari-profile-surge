// 弹窗焦点管理：焦点限制在最上层弹窗内，关闭后还给打开前的元素。
// 只按 DOM 判断可聚焦元素，不依赖布局（测试环境没有真实布局）。

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/** Tab / Shift+Tab 在容器内循环；返回是否已处理。 */
export function trapTab(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && root.contains(active);
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

// 同时只有最上层弹窗响应 Esc 与焦点限制（设计系统不允许弹窗套弹窗，这里只是兜底）。
const stack: symbol[] = [];

export function pushDialog(id: symbol): void {
  stack.push(id);
  if (typeof document !== 'undefined') document.body.classList.add('modal-open');
}

export function popDialog(id: symbol): void {
  const i = stack.lastIndexOf(id);
  if (i >= 0) stack.splice(i, 1);
  if (stack.length === 0 && typeof document !== 'undefined') document.body.classList.remove('modal-open');
}

export function isTopDialog(id: symbol): boolean {
  return stack[stack.length - 1] === id;
}
