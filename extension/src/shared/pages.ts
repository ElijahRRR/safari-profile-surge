// 扩展页面地址。演示模式下 runtime.getURL 由替身提供，会带上 ?profile=。

import type { WebExtBrowser } from './browser';

export type PrepareIntent = 'orders' | null;

export function prepareUrl(b: WebExtBrowser, operationId: string, intent: PrepareIntent = null): string {
  const url = new URL(b.runtime.getURL('prepare.html'));
  url.searchParams.set('op', operationId);
  if (intent) url.searchParams.set('intent', intent);
  return url.toString();
}

export async function openPreparePage(b: WebExtBrowser, operationId: string, intent: PrepareIntent = null): Promise<void> {
  if (!b.tabs) throw new Error('tabs API unavailable');
  await b.tabs.create({ url: prepareUrl(b, operationId, intent), active: true });
}

export function readPrepareParams(search: string): { operationId: string | null; intent: PrepareIntent } {
  const params = new URLSearchParams(search);
  const op = params.get('op');
  const operationId = op && /^[A-Za-z0-9_-]{1,128}$/.test(op) ? op : null;
  return { operationId, intent: params.get('intent') === 'orders' ? 'orders' : null };
}
