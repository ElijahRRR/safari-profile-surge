// 场景状态提示的采集：只作提示，从不改变路由。读不到时取保守值——
// 认为有 Amazon 标签页（本次打开记为未经启动验证），认为站点权限缺失（提示用户检查）。

import type { WebExtBrowser } from '../shared/browser';
import type { ProfileStateReport } from '../shared/messages';
import { siteHostPatterns } from '../shared/orders';

export async function collectProfileState(b: WebExtBrowser): Promise<ProfileStateReport> {
  let windowsOpen = 1;
  if (b.windows?.getAll) {
    try {
      windowsOpen = (await b.windows.getAll()).length;
    } catch {
      windowsOpen = 1;
    }
  }

  let amazonTabsOpen = true;
  if (b.tabs) {
    try {
      // 不申请 tabs 权限：按站点权限下的 URL 过滤查询（Safari 的行为由 P0 确认）。
      amazonTabsOpen = (await b.tabs.query({ url: siteHostPatterns() })).length > 0;
    } catch {
      amazonTabsOpen = true;
    }
  }

  let sitePermissionGranted = false;
  if (b.permissions) {
    try {
      sitePermissionGranted = await b.permissions.contains({ origins: siteHostPatterns() });
    } catch {
      sitePermissionGranted = false;
    }
  }

  return { windows_open: windowsOpen, amazon_tabs_open: amazonTabsOpen, site_permission_granted: sitePermissionGranted };
}
