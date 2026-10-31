// 订单页定位：先找本场景已打开的订单页并切到它，找不到再打开新标签页。
// 只能在服务确认路由“受控”（ordersAllowed）之后调用；调用方负责门控。

import { SITES, type SiteCode } from '@sfe/contract';
import type { BrowserTab, WebExtBrowser } from './browser';

export function ordersTabPatterns(site: SiteCode): string[] {
  const host = SITES[site].host;
  return [`https://${host}/gp/css/order-history*`, `https://${host}/your-orders*`];
}

export function siteHostPatterns(): string[] {
  return Object.values(SITES).map((s) => `https://${s.host}/*`);
}

export async function findOrdersTab(b: WebExtBrowser, site: SiteCode): Promise<BrowserTab | null> {
  if (!b.tabs) return null;
  try {
    const tabs = await b.tabs.query({ url: ordersTabPatterns(site) });
    return tabs.find((t) => typeof t.id === 'number') ?? null;
  } catch {
    return null;
  }
}

async function focusTab(b: WebExtBrowser, tab: BrowserTab): Promise<void> {
  if (typeof tab.id !== 'number' || !b.tabs) return;
  await b.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === 'number' && b.windows?.update) {
    try {
      await b.windows.update(tab.windowId, { focused: true });
    } catch {
      // 聚焦窗口失败不影响结果：标签页已激活。
    }
  }
}

export type OrdersResult = 'focused' | 'navigated' | 'created';

/**
 * 定位或打开订单页。navigateCurrent 给出时（准备页）在当前标签页导航，否则新建标签页。
 */
export async function openOrLocateOrders(
  b: WebExtBrowser,
  site: SiteCode,
  opts: { navigateCurrent?: (url: string) => void } = {},
): Promise<OrdersResult> {
  const existing = await findOrdersTab(b, site);
  if (existing) {
    await focusTab(b, existing);
    return 'focused';
  }
  const url = SITES[site].ordersUrl;
  if (opts.navigateCurrent) {
    opts.navigateCurrent(url);
    return 'navigated';
  }
  if (!b.tabs) throw new Error('tabs API unavailable');
  await b.tabs.create({ url });
  return 'created';
}
