// 后台安装：注册消息路由与场景状态上报。
// 任何生命周期事件（启动、安装、窗口/标签页创建与关闭、焦点变化）都只会触发
// reportProfileState 这一提示性上报；激活与普通模式只由用户在扩展页面中点击发起。
//
// 后台是非持久的（manifest persistent: false），Safari 会在空闲时卸载它。按 Apple 对非持久后台的要求
// （https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari）：
// - “Add event listeners in the top level of your background page.”：所有监听器都在 installBackground 中同步注册，
//   入口在脚本顶层调用它；后台被闹钟或消息唤醒时会重新执行入口，监听器在派发事件前就已就位。
// - “Use the Alarms API instead of setTimeout.”：合并上报用 alarms，不用计时器（WWDC21：“A timer won't be invoked
//   if the background page has unloaded.”，这次上报会丢失；闹钟由浏览器保存，到点时唤醒后台再派发 onAlarm——
//   Safari 上的最小延迟与是否按时唤醒没有文档，由 P0 native_bridge_ipc 实测）。

import type { BrowserAlarm, WebExtBrowser } from '../shared/browser';
import { createNativeClient, failure, type NativeClient, type NativeTransport } from '../shared/native';
import { collectProfileState } from './profile-state';
import { createRouter, type Router } from './router';

/**
 * 窗口/标签页事件之后合并上报的延迟。Safari 对闹钟的最小延迟没有文档（其他浏览器会把过短的延迟延长），
 * 实际值由 P0 native_bridge_ipc 记录；延长只会推迟这次提示性上报，不影响路由。
 */
export const REPORT_DEBOUNCE_MS = 1500;
/** 合并上报用的闹钟名。同名闹钟再次创建会替换前一个，一串事件只在最后一个之后上报一次。 */
export const PROFILE_REPORT_ALARM = 'sfe-profile-report';

export interface BackgroundHandle {
  router: Router;
  native: NativeClient;
  /** 测试用：取消挂起的上报闹钟并立即上报；没有挂起的闹钟时只等进行中的上报结束。 */
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

  // 上报串行进行：进行中时再来的请求合并成它之后的一次（读取最新状态），不用计时器。
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  const runReport = (): Promise<void> => {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          rerun = false;
          const state = await collectProfileState(b);
          // 只作提示：失败（例如服务不可达）不重试，也不影响路由。未识别场景（可能是默认场景）同样上报，计入旧窗口确认。
          await native.call({ type: 'reportProfileState', ...state });
        } while (rerun);
      } catch {
        // 同上：只作提示，不打印
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const alarms = b.alarms;
  const canSchedule = typeof alarms?.create === 'function' && typeof alarms.onAlarm?.addListener === 'function';
  alarms?.onAlarm?.addListener((alarm: BrowserAlarm) => {
    if (alarm?.name === PROFILE_REPORT_ALARM) void runReport();
  });

  const scheduleReport = () => {
    if (!canSchedule) {
      // 没有 alarms（API 或权限不可用）：不退回 setTimeout，直接上报；进行中的上报会合并后续请求。
      void runReport();
      return;
    }
    try {
      Promise.resolve(alarms!.create(PROFILE_REPORT_ALARM, { when: Date.now() + REPORT_DEBOUNCE_MS })).catch(() => {
        void runReport();
      });
    } catch {
      void runReport();
    }
  };

  b.windows?.onCreated?.addListener(scheduleReport);
  b.windows?.onRemoved?.addListener(scheduleReport);
  b.tabs?.onCreated?.addListener(scheduleReport);
  b.tabs?.onRemoved?.addListener(scheduleReport);

  return {
    router,
    native,
    async flushReport() {
      let pending = false;
      if (canSchedule && typeof alarms?.clear === 'function') {
        try {
          pending = await alarms.clear(PROFILE_REPORT_ALARM);
        } catch {
          pending = false;
        }
      }
      if (pending) await runReport();
      else if (inFlight) await inFlight;
    },
  };
}
