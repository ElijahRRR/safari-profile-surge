// 扩展用到的 WebExtension API 的最小类型。只声明本扩展实际调用的部分；Safari 同时提供
// browser 与 chrome 两个命名空间，优先使用 browser（返回 Promise）。

export interface MessageSender {
  id?: string;
  url?: string;
  frameId?: number;
  origin?: string;
  tab?: BrowserTab;
}

export interface BrowserTab {
  id?: number;
  url?: string;
  windowId?: number;
  active?: boolean;
}

export interface BrowserEvent<F extends (...args: never[]) => unknown> {
  addListener(listener: F): void;
  removeListener?(listener: F): void;
}

export type RuntimeMessageListener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface WebExtBrowser {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    /** 只有后台脚本调用。Safari 忽略 application 参数，按宿主 App 路由。 */
    sendNativeMessage?(application: string, message: unknown): Promise<unknown>;
    onMessage?: BrowserEvent<RuntimeMessageListener>;
    onStartup?: BrowserEvent<() => void>;
    onInstalled?: BrowserEvent<(details: unknown) => void>;
  };
  tabs?: {
    query(query: { url?: string | string[]; active?: boolean; currentWindow?: boolean }): Promise<BrowserTab[]>;
    create(props: { url: string; active?: boolean }): Promise<BrowserTab>;
    update(tabId: number, props: { active?: boolean; url?: string }): Promise<BrowserTab | undefined>;
    getCurrent?(): Promise<BrowserTab | undefined>;
    onCreated?: BrowserEvent<(tab: BrowserTab) => void>;
    onRemoved?: BrowserEvent<(tabId: number, info: unknown) => void>;
    onUpdated?: BrowserEvent<(tabId: number, change: unknown, tab: BrowserTab) => void>;
    onActivated?: BrowserEvent<(info: unknown) => void>;
  };
  windows?: {
    getAll(): Promise<unknown[]>;
    update?(windowId: number, props: { focused?: boolean }): Promise<unknown>;
    onCreated?: BrowserEvent<(win: unknown) => void>;
    onRemoved?: BrowserEvent<(windowId: number) => void>;
    onFocusChanged?: BrowserEvent<(windowId: number) => void>;
  };
  permissions?: {
    contains(query: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  /**
   * 只有后台脚本调用（需要 alarms 权限）。非持久后台的延迟工作只用它：Apple 要求“Use the Alarms API instead of
   * setTimeout”，计时器在后台页卸载后不会触发；闹钟由浏览器保存，到点时派发 onAlarm（Safari 的最小延迟与
   * 卸载后是否按时唤醒没有文档，由 P0 native_bridge_ipc 实测）。
   * create 在不同浏览器上返回 void 或 Promise，两种都要处理。
   */
  alarms?: {
    create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): void | Promise<void>;
    clear(name: string): Promise<boolean>;
    get?(name: string): Promise<BrowserAlarm | undefined>;
    onAlarm?: BrowserEvent<(alarm: BrowserAlarm) => void>;
  };
}

export interface BrowserAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export function getBrowser(): WebExtBrowser {
  const g = globalThis as { browser?: WebExtBrowser; chrome?: WebExtBrowser };
  const b = g.browser ?? g.chrome;
  if (!b || !b.runtime) throw new Error('WebExtension API unavailable');
  return b;
}
