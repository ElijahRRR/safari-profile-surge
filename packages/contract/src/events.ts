// 网页 SSE 事件。sequence 单调递增；客户端忽略旧序号，断线后用 Last-Event-ID 补读，
// 事件已过期时服务端发送 snapshot.required，客户端改读完整快照。事件中不含任何秘密。

import type {
  CapabilityView,
  EnvironmentId,
  EnvironmentView,
  FrontProxyView,
  OperationView,
  RouteStateView,
  SettingsView,
  SurgeStatusView,
} from './models.js';

export type ServiceEventPayload =
  | { type: 'operation.updated'; operation: OperationView }
  | { type: 'environment.updated'; environment: EnvironmentView }
  | { type: 'environment.deleted'; environmentId: EnvironmentId }
  | { type: 'route.updated'; route: RouteStateView }
  | { type: 'surge.status'; surge: SurgeStatusView }
  | { type: 'capabilities.updated'; capabilities: CapabilityView[] }
  | { type: 'frontProxies.updated'; frontProxies: FrontProxyView[] }
  | { type: 'settings.updated'; settings: SettingsView }
  | { type: 'snapshot.required'; reason: string };

export type ServiceEvent = ServiceEventPayload & { sequence: number };

export type ServiceEventType = ServiceEventPayload['type'];

/** 服务端保留的事件环形缓冲大小；超出后补读返回 snapshot.required。 */
export const EVENT_BUFFER_SIZE = 1000;
export const SSE_HEARTBEAT_MS = 15000;
