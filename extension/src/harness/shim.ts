// 演示模式替身：本机服务在 /dev/extension/ 下把弹窗与准备页当普通网页提供。
// 这里补上普通网页没有的扩展 API，并在页面内运行同一个后台路由（传输换成 HTTP）。
// 演示模式不会打开或导航到任何外部站点，出口检测返回合成的文档用地址。只在 --mode harness 构建。

import type { BrowserTab, MessageSender, WebExtBrowser } from '../shared/browser';
import { createNativeClient } from '../shared/native';
import { createRouter } from '../background/router';
import { harnessHttpTransport, readSessionToken } from './transport';

export const HARNESS_RUNTIME_ID = 'sfe-harness';
/** 合成出口（RFC 5737 文档地址）；可用 ?demo_ip= 覆盖。 */
export const HARNESS_DEFAULT_EXIT_IP = '192.0.2.10';

function currentParams(): URLSearchParams {
  return new URLSearchParams(location.search);
}

function profileParam(): string | null {
  const p = currentParams().get('profile');
  return p && /^[A-Za-z0-9-]{1,128}$/.test(p) ? p : null;
}

function harnessBase(): URL {
  return new URL('./', location.href);
}

function showNotice(text: string): void {
  const el = document.getElementById('sfe-harness-notice');
  if (el) el.textContent = text;
}

function installBanner(profileId: string | null): void {
  if (document.getElementById('sfe-harness-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'sfe-harness-banner';
  bar.className = 'flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-900/30 dark:text-amber-300';
  const badge = document.createElement('span');
  badge.className = 'badge badge-warning';
  badge.textContent = 'DEMO';
  const label = document.createElement('span');
  label.textContent = profileId ? `演示模式 · 场景 ${profileId.slice(0, 8)}` : '演示模式 · 未识别场景';
  const notice = document.createElement('span');
  notice.id = 'sfe-harness-notice';
  notice.className = 'w-full';
  bar.append(badge, label, notice);
  document.body.prepend(bar);
}

export function installHarness(): WebExtBrowser {
  const profileId = profileParam();
  const base = harnessBase();
  const getURL = (path: string) => {
    const url = new URL(path.replace(/^\//, ''), base);
    if (profileId) url.searchParams.set('profile', profileId);
    const demoIp = currentParams().get('demo_ip');
    if (demoIp) url.searchParams.set('demo_ip', demoIp);
    return url.toString();
  };

  const native = createNativeClient(
    harnessHttpTransport({ profileId, getToken: () => readSessionToken(globalThis.localStorage) }),
  );
  const router = createRouter({
    runtimeId: HARNESS_RUNTIME_ID,
    extensionBaseUrl: base.toString(),
    native,
    collectProfileState: async () => ({ windows_open: 1, amazon_tabs_open: false, site_permission_granted: true }),
  });

  const isHarnessPage = (url: string) => url.startsWith(base.toString());
  let nextTabId = 1;

  const shim: WebExtBrowser = {
    runtime: {
      id: HARNESS_RUNTIME_ID,
      getURL,
      sendMessage: (message: unknown) => {
        const sender: MessageSender = { id: HARNESS_RUNTIME_ID, url: location.href };
        return router(message, sender);
      },
    },
    tabs: {
      query: async () => [],
      create: async ({ url }) => {
        const tab: BrowserTab = { id: nextTabId++, url };
        if (isHarnessPage(url)) {
          window.open(url, '_blank', 'noopener');
        } else {
          showNotice(`演示模式不打开外部站点：${new URL(url).host}`);
        }
        return tab;
      },
      update: async () => undefined,
    },
    windows: { getAll: async () => [{}] },
    permissions: { contains: async () => true },
  };
  (globalThis as { browser?: WebExtBrowser }).browser = shim;
  if (document.body) installBanner(profileId);
  else document.addEventListener('DOMContentLoaded', () => installBanner(profileId), { once: true });
  return shim;
}

/** 演示模式的出口检测：不访问外部检测服务，返回合成地址。 */
export async function harnessVerifyFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const ip = currentParams().get('demo_ip') ?? HARNESS_DEFAULT_EXIT_IP;
  showNotice(`演示模式未请求 ${url.host}，返回合成出口 ${ip}`);
  return new Response(JSON.stringify({ ip }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 演示模式不导航到外部站点。 */
export function harnessNavigate(url: string): void {
  showNotice(`演示模式不打开外部站点：${new URL(url).host}`);
}
