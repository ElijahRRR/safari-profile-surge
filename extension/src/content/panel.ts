// 登录页上的小提示面板：封闭的 Shadow DOM，不受页面样式影响，也不暴露给页面脚本。
// 只提供提示文字、「返回订单」（只导航一次）与关闭按钮；从不点击或提交页面上的任何东西。

export type PanelTone = 'info' | 'success' | 'warning';

export interface PanelContent {
  title: string;
  detail?: string | null;
  tone: PanelTone;
}

export interface Panel {
  show(content: PanelContent): void;
  remove(): void;
  readonly element: HTMLElement;
}

const TONE_COLOR: Record<PanelTone, string> = {
  info: '#14b8a6',
  success: '#10b981',
  warning: '#f59e0b',
};

// EasyQuick 外观的最小内联版本：页面中不能加载扩展的样式表。
const STYLE = `
:host { all: initial; }
.box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 280px; box-sizing: border-box;
  font-family: system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif; font-size: 13px; line-height: 1.5;
  color: #111827; background: #ffffff; border: 1px solid #e5e7eb; border-left-width: 4px; border-radius: 8px;
  box-shadow: 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1); padding: 12px 12px 12px 14px; }
.title { font-weight: 600; margin: 0 20px 2px 0; }
.detail { margin: 0 0 8px 0; color: #4b5563; }
.actions { display: flex; justify-content: flex-end; }
.btn { font: inherit; font-weight: 500; cursor: pointer; border-radius: 8px; padding: 4px 12px; border: 1px solid #e5e7eb; background: #ffffff; color: #374151; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.close { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; color: #9ca3af; cursor: pointer; font: 16px/1 system-ui; padding: 4px; }
@media (prefers-color-scheme: dark) {
  .box { color: #f3f4f6; background: #1e293b; border-color: #334155; }
  .detail { color: #94a3b8; }
  .btn { background: #1e293b; color: #e5e7eb; border-color: #475569; }
}
`;

export function createPanel(doc: Document, opts: { ordersUrl: string; navigate: (url: string) => void }): Panel {
  const host = doc.createElement('div');
  host.setAttribute('data-sfe-login-assist', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const box = doc.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'status');
  const title = doc.createElement('p');
  title.className = 'title';
  const detail = doc.createElement('p');
  detail.className = 'detail';
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'btn';
  back.textContent = '返回订单';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  actions.append(back);
  box.append(close, title, detail, actions);
  root.append(style, box);

  let navigated = false;
  back.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigated) return;
    navigated = true;
    back.disabled = true;
    opts.navigate(opts.ordersUrl);
  });
  close.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    host.remove();
  });

  return {
    element: host,
    show(content) {
      title.textContent = content.title;
      detail.textContent = content.detail ?? '';
      detail.style.display = content.detail ? '' : 'none';
      box.style.borderLeftColor = TONE_COLOR[content.tone];
      if (!host.isConnected) (doc.body ?? doc.documentElement).append(host);
    },
    remove() {
      host.remove();
    },
  };
}
