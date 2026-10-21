// 后台安装：注册消息路由与场景状态上报。
// 任何生命周期事件（启动、安装、窗口/标签页创建与关闭、焦点变化）都只会触发
// reportProfileState 这一提示性上报；激活与普通模式只由用户在扩展页面中点击发起。

import type { WebExtBrowser } from '../shared/browser';
import { createNativeClient, failure, type NativeClient, type NativeTransport } from '../shared/native';
import { collectProfileState } from './profile-state';
import { createRouter, type Router } from './router';

export const REPORT_DEBOUNCE_MS = 1500;

export interface BackgroundHandle {
  router: Router;
  native: NativeClient;
  /** 测试用：立即执行挂起的上报。 */
  flushReport(): Promise<void>;
}

export function nativeMessagingTransport(b: WebExtBrowser, appId: string): NativeTransport {
  return {
    send(envelope) {
      if (!b.runtime.sendNativeMessage) return Promise.reject(new Error('nativeMessaging unavailable'));
      return b.runtime.sendNativeMessage(appId, envelope);
    },
  };
}

export function installBackground(b: WebExtBrowser, transport: NativeTransport): BackgroundHandle {
  const native = createNativeClient(transport);
  const router = createRouter({
    runtimeId: b.runtime.id,
    extensionBaseUrl: b.runtime.getURL(''),
    native,
    collectProfileState: () => collectProfileState(b),
  });

  b.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    router(message, sender).then(sendResponse, () => sendResponse(failure('INTERNAL', '处理请求失败：扩展后台出错')));
    return true;
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = async () => {
    timer = null;
    const state = await collectProfileState(b);
    await native.call({ type: 'reportProfileState', ...state });
  };
  const scheduleReport = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void report();
    }, REPORT_DEBOUNCE_MS);
  };

  b.windows?.onCreated?.addListener(scheduleReport);
  b.windows?.onRemoved?.addListener(scheduleReport);
  b.tabs?.onCreated?.addListener(scheduleReport);
  b.tabs?.onRemoved?.addListener(scheduleReport);

  return {
    router,
    native,
    async flushReport() {
      if (timer !== null) {
        clearTimeout(timer);
        await report();
      }
    },
  };
}
