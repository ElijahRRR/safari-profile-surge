// Safari 扩展 ↔ 原生桥 ↔ 本机服务 的消息契约。
//
// 扩展只发送 NativeEnvelope；原生桥（SafariWebExtensionHandler，签名的 App Extension）从
// SFExtensionProfileKey 取得可信场景 ID，与服务完成双向 HMAC 握手（传输令牌从不上线路）后，
// 把 { bridge, message } 转发给服务。扩展自己提供的任何身份字段都不被信任。请求/响应模式，
// 不假定存在常驻推送通道。
//
// 只有扩展页面（弹窗、准备页）与后台脚本可以发送原生消息；内容脚本只能向后台发送
// requestLoginFill（由后台根据 runtime.MessageSender 填写 top_url 与 frame_is_top）与只问是否适用填充的
// checkLoginFill（extension/src/shared/messages.ts）。

import type { ApiErrorBody } from './errors.js';
import type {
  EnvironmentChanges,
  EnvironmentId,
  EnvironmentInput,
  EnvironmentView,
  IsoTime,
  OperationId,
  OperationView,
  RequestId,
  RouteStateView,
  RouteSummaryView,
} from './models.js';
import type { NeedsConfirmationDetails, Accepted } from './api.js';
import type { OldSessionPolicy } from './phases.js';
import type { SiteCode } from './sites.js';

export const NATIVE_PROTOCOL_VERSION = 1 as const;

/**
 * 最低 Safari 版本。Safari 17.6 发行说明：“Fixed an issue where Safari Web Extension background pages would stop
 * responding after about 30 seconds.”（https://developer.apple.com/documentation/safari-release-notes/safari-17_6-release-notes）；
 * 本扩展依赖非持久后台页与原生消息，所以 17.0–17.5 不支持。扩展 manifest 以 browser_specific_settings.safari.strict_min_version
 * 声明（Apple：“Provide a specific version number in strict_min_version if you have a minimum Safari version requirement.”，
 * https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari）；P0 对低于它的测量拒绝提议。
 */
export const SAFARI_MINIMUM_VERSION = '17.6' as const;

/**
 * Safari 版本（Info.plist 的 CFBundleShortVersionString，如 17.6、18.0.1）是否低于 SAFARI_MINIMUM_VERSION。
 * 读不到或不是纯数字点分格式时返回 null（不能判断）。
 */
export function safariBelowMinimum(version: string | null): boolean | null {
  const v = version?.trim() ?? '';
  if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(v)) return null;
  const have = v.split('.').map(Number);
  const want = SAFARI_MINIMUM_VERSION.split('.').map(Number);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}
/** 原生宿主 App 的 bundle identifier（Safari 会忽略 sendNativeMessage 的 application 参数，仍按惯例填写）。 */
export const NATIVE_APP_ID = 'com.sfe.SafariProfileSurge';
/** 单条 NDJSON 消息上限。 */
export const NATIVE_MAX_MESSAGE_BYTES = 256 * 1024;

export type NativeRequest =
  | { type: 'getCurrentState' }
  /**
   * 场景状态提示：窗口数、是否有 www.amazon.com 标签页、站点权限。在弹窗打开、窗口与标签页
   * 创建/关闭时由后台发送；超过 PROFILE_REPORT_FRESH_SEC 的上报不再计入“有打开的窗口”。
   * 只作提示，从不改变路由。
   */
  | { type: 'reportProfileState'; windows_open: number; amazon_tabs_open: boolean; site_permission_granted: boolean }
  | { type: 'bindCurrentProfile'; request_id: RequestId; environment_id: EnvironmentId; expected_revision: number }
  | { type: 'createAndBindEnvironment'; request_id: RequestId; environment: EnvironmentInput }
  | { type: 'updateCurrentEnvironment'; request_id: RequestId; environment_id: EnvironmentId; expected_revision: number; changes: EnvironmentChanges }
  | {
      type: 'activateCurrentEnvironment';
      request_id: RequestId;
      environment_id: EnvironmentId;
      old_session_policy?: OldSessionPolicy;
      confirmed_environment_id?: EnvironmentId | null;
      proxy_revision?: number;
      /** 本场景在发起时是否已有 Amazon 标签页（有则本次打开记为“未经启动验证”）。 */
      amazon_tabs_open: boolean;
    }
  | { type: 'enterNormalMode'; request_id: RequestId; old_session_policy?: OldSessionPolicy; confirmed_environment_id?: EnvironmentId | null }
  | { type: 'probeCurrentEnvironment'; request_id: RequestId; environment_id: EnvironmentId; kind: 'preflight' | 'safari' }
  | { type: 'acknowledgeAccountChange'; request_id: RequestId; environment_id: EnvironmentId; expected_revision: number }
  | { type: 'getOperation'; operation_id: OperationId }
  /** 取消自己环境的等待中路由操作（按回滚处理，从不进入 NORMAL）。 */
  | { type: 'cancelOperation'; request_id: RequestId; operation_id: OperationId }
  /** 用户确认旧环境窗口已关闭：只清除对应警告。 */
  | { type: 'acknowledgeWindowsClosed'; request_id: RequestId }
  /**
   * 准备页在目标场景中调用：表示“绑定场景已到达，可以检测”。等待切换的操作由此继续；
   * 入口到达 VERIFY_ONLY（或当前环境重测时的 ACTIVE）后返回一次性检测编号。
   */
  | { type: 'beginSafariVerification'; operation_id: OperationId; amazon_tabs_open: boolean }
  | {
      type: 'submitSafariVerification';
      operation_id: OperationId;
      test_id: string;
      route_epoch: number;
      observed_ip: string | null;
      http_status: number | null;
      error: string | null;
      started_at: IsoTime;
      finished_at: IsoTime;
    }
  | {
      type: 'requestLoginFill';
      /** 由后台从 sender.tab.url / sender.url 填写，不采用内容脚本自报的值。 */
      top_url: string;
      /** 由后台从 sender.frameId === 0 填写。 */
      frame_is_top: boolean;
      /** 内容脚本读取的表单目标；不在表单内的字段为 null，服务直接拒绝。 */
      form_action: string | null;
      fields: Array<'identifier' | 'password'>;
      /** 内容脚本读取到的当前路由序号；过期即拒绝。 */
      route_epoch: number;
    };

export type NativeRequestType = NativeRequest['type'];

export interface NativeEnvelope {
  v: typeof NATIVE_PROTOCOL_VERSION;
  message: NativeRequest;
}

export interface BridgeInfo {
  /** 来自 SFExtensionProfileKey；系统不提供时为 null（只允许 getCurrentState）。 */
  profileId: string | null;
  bridgeVersion: string;
}

/**
 * 原生桥 ↔ 服务的一次连接（docs/ARCHITECTURE.md §7.2）：hello → challenge → request → NativeResponse，之后关闭。
 * 每次安装随机的传输令牌（由宿主 App 分发，不是用户凭据）从不出现在线路上：双方用 HMAC-SHA256（以令牌的
 * UTF-8 字节为密钥）互相证明持有令牌。原生桥先验证服务的证明，通过之前不发送场景 ID 或消息。
 * 随机数为 32 字节的小写十六进制；证明与摘要均为小写十六进制。
 */
export const BRIDGE_NONCE_BYTES = 32;
export const BRIDGE_SERVER_PROOF_LABEL = 'sfe-bridge-server';
export const BRIDGE_CLIENT_PROOF_LABEL = 'sfe-bridge-client';

/** 原生桥 → 服务。 */
export interface BridgeHello {
  v: typeof NATIVE_PROTOCOL_VERSION;
  type: 'hello';
  clientNonce: string;
}

/** 服务 → 原生桥。serverProof = HMAC(令牌, "sfe-bridge-server\n" + clientNonce + "\n" + serverNonce)。 */
export interface BridgeChallenge {
  v: typeof NATIVE_PROTOCOL_VERSION;
  type: 'challenge';
  serverNonce: string;
  serverProof: string;
}

/**
 * 原生桥 → 服务（验证 serverProof 之后）。payload 是 BridgePayload 的 JSON 文本，证明按它的原始 UTF-8 字节计算，
 * 双方不需要对 JSON 做跨语言规范化：
 * clientProof = HMAC(令牌, "sfe-bridge-client\n" + serverNonce + "\n" + clientNonce + "\n" + SHA-256(payload))。
 */
export interface BridgeRequest {
  v: typeof NATIVE_PROTOCOL_VERSION;
  type: 'request';
  clientProof: string;
  payload: string;
}

export interface BridgePayload {
  bridge: BridgeInfo;
  message: NativeRequest;
}

/** 握手与校验都通过后交给服务处理的请求（不含令牌或证明）。 */
export interface BridgeEnvelope {
  v: typeof NATIVE_PROTOCOL_VERSION;
  bridge: BridgeInfo;
  message: NativeRequest;
}

export type NativeResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

export interface BindableEnvironment {
  id: EnvironmentId;
  label: string;
  site: SiteCode;
  revision: number;
}

export interface CurrentStateResponse {
  profile: {
    identified: boolean;
    profileIdShort: string | null;
  };
  /** 当前场景绑定的环境（未绑定或场景未识别时为 null）。 */
  environment: EnvironmentView | null;
  /** 只有当前场景绑定的正是活动环境时才返回完整路由；否则只返回摘要。 */
  route: RouteStateView | null;
  routeSummary: RouteSummaryView;
  relation: 'this_active' | 'other_active' | 'none_active';
  otherActiveLabel: string | null;
  /** 当前场景绑定的环境有等待场景到达或实测的路由操作。 */
  pendingVerification: { operation_id: OperationId; kind: 'activate' | 'apply_new_revision' | 'reverify' | 'probe_safari'; deadline: IsoTime | null } | null;
  /** 仅已识别且未绑定时返回：可关联的未绑定环境。 */
  bindable: BindableEnvironment[];
  activationAvailable: boolean;
  activationBlockedReason: string | null;
  /** “打开或定位订单页”是否允许：当前场景是活动环境、实测有效、无接管/外部修改警告。 */
  ordersAllowed: boolean;
  ordersBlockedReason: string | null;
}

export type BeginVerificationResponse =
  | { status: 'pending'; phase: string; message: string }
  | { status: 'ready'; test_id: string; route_epoch: number; verify_url: string; deadline: IsoTime }
  | { status: 'not_needed'; message: string };

/** 服务对原生桥的填充应答：账号标识直接给值；密码只给钥匙串引用，由签名的原生桥自行读取。 */
export interface LoginFillServiceResponse {
  fills: Array<{ field: 'identifier'; value: string } | { field: 'password'; keychainRef: string; expiresAt: IsoTime }>;
}

/** 原生桥交给扩展的填充值（原生桥解析钥匙串引用后）。扩展只在内存中短暂持有。 */
export interface LoginFillResponse {
  fills: Array<{ field: 'identifier' | 'password'; value: string }>;
}

export interface NativeResponseMap {
  getCurrentState: CurrentStateResponse;
  reportProfileState: { recorded: boolean };
  bindCurrentProfile: Accepted;
  createAndBindEnvironment: Accepted;
  updateCurrentEnvironment: Accepted;
  activateCurrentEnvironment: Accepted;
  enterNormalMode: Accepted;
  probeCurrentEnvironment: Accepted;
  acknowledgeAccountChange: Accepted;
  getOperation: OperationView;
  cancelOperation: Accepted;
  acknowledgeWindowsClosed: { cleared: boolean };
  beginSafariVerification: BeginVerificationResponse;
  submitSafariVerification: { accepted: boolean };
  requestLoginFill: LoginFillServiceResponse;
}

export type NativeNeedsConfirmation = NeedsConfirmationDetails;

/**
 * 按场景状态的权限矩阵（服务端强制）：
 * - 未识别（profileId 为 null）：只允许 getCurrentState（不返回其他环境名称）。
 * - 已识别未绑定：getCurrentState、reportProfileState、bindCurrentProfile（只能绑未绑定环境）、
 *   createAndBindEnvironment、enterNormalMode（需确认）。
 * - 已绑定：以上（除绑定类）+ 针对自己绑定环境的 update/activate/probe/acknowledge、
 *   getOperation（只限自己环境的操作或自己发起的操作）、begin/submitSafariVerification
 *   （只限自己环境）、requestLoginFill（只限自己环境且为当前活动环境）。
 */
export const NATIVE_PERMISSIONS: Record<NativeRequestType, ReadonlyArray<'unidentified' | 'unbound' | 'bound'>> = {
  getCurrentState: ['unidentified', 'unbound', 'bound'],
  reportProfileState: ['unbound', 'bound'],
  bindCurrentProfile: ['unbound'],
  createAndBindEnvironment: ['unbound'],
  updateCurrentEnvironment: ['bound'],
  activateCurrentEnvironment: ['bound'],
  enterNormalMode: ['unbound', 'bound'],
  probeCurrentEnvironment: ['bound'],
  acknowledgeAccountChange: ['bound'],
  getOperation: ['unbound', 'bound'],
  cancelOperation: ['bound'],
  acknowledgeWindowsClosed: ['unbound', 'bound'],
  beginSafariVerification: ['bound'],
  submitSafariVerification: ['bound'],
  requestLoginFill: ['bound'],
};

/** 场景状态上报的有效期。 */
export const PROFILE_REPORT_FRESH_SEC = 600;

/** 内容脚本经后台可以发起的唯一请求类型。 */
export const CONTENT_SCRIPT_ALLOWED: readonly NativeRequestType[] = ['requestLoginFill'];
