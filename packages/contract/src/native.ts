// Safari 扩展 ↔ 原生桥 ↔ 本机服务 的消息契约。
//
// 扩展只发送 NativeEnvelope；原生桥（SafariWebExtensionHandler）从 SFExtensionProfileKey 取得
// 可信场景 ID，包装成 BridgeEnvelope 经 Unix 套接字转发给服务。扩展自己提供的任何身份字段都
// 不被信任。请求/响应模式，不假定存在常驻推送通道。

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
} from './models.js';
import type { OldSessionPolicy } from './phases.js';
import type { Accepted } from './api.js';
import type { SiteCode } from './sites.js';

export const NATIVE_PROTOCOL_VERSION = 1 as const;
/** 原生宿主 App 的 bundle identifier（Safari 会忽略 sendNativeMessage 的 application 参数，仍按惯例填写）。 */
export const NATIVE_APP_ID = 'com.sfe.SafariProfileSurge';

export type NativeRequest =
  | { type: 'getCurrentState' }
  | { type: 'bindCurrentProfile'; request_id: RequestId; environment_id: EnvironmentId; expected_revision: number }
  | { type: 'createAndBindEnvironment'; request_id: RequestId; environment: EnvironmentInput }
  | { type: 'updateCurrentEnvironment'; request_id: RequestId; expected_revision: number; changes: EnvironmentChanges }
  | { type: 'activateCurrentEnvironment'; request_id: RequestId; old_session_policy?: OldSessionPolicy }
  | { type: 'enterNormalMode'; request_id: RequestId }
  | { type: 'probeCurrentEnvironment'; request_id: RequestId }
  | { type: 'getOperation'; operation_id: OperationId }
  | { type: 'beginSafariVerification'; operation_id: OperationId }
  | {
      type: 'submitSafariVerification';
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
      top_url: string;
      /** 内容脚本只在顶层框架运行；为 false 时服务直接拒绝。 */
      frame_is_top: boolean;
      form_action: string | null;
      fields: Array<'identifier' | 'password'>;
    };

export type NativeRequestType = NativeRequest['type'];

export interface NativeEnvelope {
  v: typeof NATIVE_PROTOCOL_VERSION;
  message: NativeRequest;
}

export interface BridgeInfo {
  /** 来自 SFExtensionProfileKey；macOS/Safari 不提供时为 null（视为不可信，只允许只读请求）。 */
  profileId: string | null;
  bridgeVersion: string;
}

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
    /** 原生桥是否提供了可信场景 ID。 */
    identified: boolean;
    profileIdShort: string | null;
  };
  environment: EnvironmentView | null;
  route: RouteStateView;
  /** 当前场景与全局活动环境的关系。 */
  relation: 'this_active' | 'other_active' | 'none_active';
  otherActiveLabel: string | null;
  /** 当前场景绑定的环境正在等待 Safari 实测出口。 */
  pendingVerification: { operation_id: OperationId; deadline: IsoTime } | null;
  /** 仅未绑定时返回：可关联的未绑定环境。 */
  bindable: BindableEnvironment[];
  /** 服务端是否已具备激活所需的能力门槛（未通过时插件只展示原因，不提供假按钮）。 */
  activationAvailable: boolean;
  activationBlockedReason: string | null;
}

export interface BeginVerificationResponse {
  test_id: string;
  route_epoch: number;
  verify_url: string;
  deadline: IsoTime;
}

export interface LoginFillResponse {
  field: 'identifier' | 'password';
  value: string;
}

export interface NativeResponseMap {
  getCurrentState: CurrentStateResponse;
  bindCurrentProfile: Accepted;
  createAndBindEnvironment: Accepted;
  updateCurrentEnvironment: Accepted;
  activateCurrentEnvironment: Accepted;
  enterNormalMode: Accepted;
  probeCurrentEnvironment: Accepted;
  getOperation: OperationView;
  beginSafariVerification: BeginVerificationResponse;
  submitSafariVerification: { accepted: boolean };
  requestLoginFill: LoginFillResponse;
}

/** 不需要可信场景 ID 的只读请求；其余请求在 profileId 为 null 时一律拒绝。 */
export const PROFILE_OPTIONAL_REQUESTS: readonly NativeRequestType[] = ['getCurrentState', 'getOperation'];
