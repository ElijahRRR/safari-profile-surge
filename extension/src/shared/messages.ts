// 扩展内部消息（runtime.sendMessage）。扩展页面经后台转发原生请求；内容脚本只能发送
// ContentFillMessage：requestLoginFill 由后台根据 sender 重建完整请求；checkLoginFill 只问本场景是否适用填充。

import type { NativeRequest, NativeRequestType, NativeResponse } from '@sfe/contract';
import type { WebExtBrowser } from './browser';
import { failure, type ExtensionResponseMap, type RequestOf } from './native';

/** 场景状态提示：窗口数、是否有 Amazon 标签页、站点权限。 */
export interface ProfileStateReport {
  windows_open: number;
  amazon_tabs_open: boolean;
  site_permission_granted: boolean;
}

/** 扩展页面 → 后台。 */
export type PageMessage =
  | { sfe: 'native'; message: NativeRequest }
  /** 读取场景状态；report 为 true 时后台同时上报 reportProfileState（弹窗打开时）。 */
  | { sfe: 'profileState'; report: boolean };

/** 内容脚本 → 后台：只有这些字段，其余由后台从 sender 与新的 getCurrentState 填写。 */
export type ContentFillMessage =
  | {
      type: 'requestLoginFill';
      form_action: string | null;
      fields: Array<'identifier' | 'password'>;
    }
  /**
   * 页面上没有可填充字段时，内容脚本显示任何提示之前先问：本场景是否已绑定、在该站点登录页、开启了自动填充、
   * 是使用中的环境。适用时应答 { ok: true, data: { eligible: true } }；否则与 requestLoginFill 相同的拒绝原因。
   * 从不请求填充值。
   */
  | { type: 'checkLoginFill' };

export interface PageClient {
  call<K extends NativeRequestType>(message: RequestOf<K>): Promise<NativeResponse<ExtensionResponseMap[K]>>;
  profileState(report: boolean): Promise<NativeResponse<ProfileStateReport>>;
}

async function send<T>(b: WebExtBrowser, message: PageMessage): Promise<NativeResponse<T>> {
  try {
    const reply = await b.runtime.sendMessage(message);
    if (reply && typeof reply === 'object' && 'ok' in reply) return reply as NativeResponse<T>;
    return failure('INTERNAL', '连接扩展后台失败：应答为空');
  } catch {
    return failure('INTERNAL', '连接扩展后台失败：后台脚本未响应');
  }
}

export function createPageClient(b: WebExtBrowser): PageClient {
  return {
    call<K extends NativeRequestType>(message: RequestOf<K>) {
      return send<ExtensionResponseMap[K]>(b, { sfe: 'native', message });
    },
    profileState(report: boolean) {
      return send<ProfileStateReport>(b, { sfe: 'profileState', report });
    },
  };
}
