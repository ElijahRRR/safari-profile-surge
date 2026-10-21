// 应用门面：HTTP、admin 套接字、原生桥都只通过这个接口调用业务；业务实现见 engine/。
// Actor 用于审计与权限：bridge 请求的场景身份只来自原生桥，不来自消息体。

import type {
  AccountDetail,
  Accepted,
  ActivateRequest,
  BridgeEnvelope,
  CapabilityView,
  CreateEnvironmentRequest,
  DeleteEnvironmentRequest,
  EnvironmentView,
  FrontProxyView,
  ImportCommitResult,
  ImportPreview,
  ImportRequest,
  InitCommitRequest,
  InitPreviewResponse,
  NativeResponse,
  NormalModeRequest,
  OperationView,
  ProbeRequest,
  PublishPendingRequest,
  RecordCapabilityRequest,
  RegisterFrontProxyRequest,
  SettingsView,
  Snapshot,
  SurgeStatusView,
  UnbindRequest,
  UpdateEnvironmentRequest,
  UpdateSettingsRequest,
} from '@sfe/contract';
import type { EventBus } from './ports.js';

export type Actor =
  | { kind: 'web'; sessionId: string }
  | { kind: 'admin' }
  | { kind: 'bridge'; profileId: string | null };

export interface SurgePolicyCandidates {
  /** Surge 当前配置中的代理节点名（可作为前置候选），不含本应用 SFE- 节点。 */
  proxies: string[];
  groups: string[];
}

export interface AppService {
  readonly events: EventBus;

  snapshot(): Promise<Snapshot>;
  listEnvironments(): Promise<EnvironmentView[]>;
  createEnvironment(req: CreateEnvironmentRequest, actor: Actor): Promise<Accepted>;
  updateEnvironment(id: string, req: UpdateEnvironmentRequest, actor: Actor): Promise<Accepted>;
  deleteEnvironment(id: string, req: DeleteEnvironmentRequest, actor: Actor): Promise<Accepted>;
  accountDetail(id: string, actor: Actor): Promise<AccountDetail>;
  unbind(id: string, req: UnbindRequest, actor: Actor): Promise<Accepted>;

  activate(id: string, req: ActivateRequest, actor: Actor): Promise<Accepted>;
  enterNormal(req: NormalModeRequest, actor: Actor): Promise<Accepted>;
  probe(id: string, req: ProbeRequest, actor: Actor): Promise<Accepted>;
  publishPending(req: PublishPendingRequest, actor: Actor): Promise<Accepted>;

  getOperation(id: string): Promise<OperationView>;
  listOperations(limit: number): Promise<OperationView[]>;

  importPreview(req: ImportRequest, actor: Actor): Promise<ImportPreview>;
  importCommit(req: ImportRequest, actor: Actor): Promise<ImportCommitResult>;
  importTemplateCsv(): string;

  listCapabilities(): Promise<CapabilityView[]>;
  recordCapability(req: RecordCapabilityRequest, actor: Actor): Promise<CapabilityView>;

  getSettings(): Promise<SettingsView>;
  updateSettings(req: UpdateSettingsRequest, actor: Actor): Promise<SettingsView>;

  listFrontProxies(): Promise<FrontProxyView[]>;
  registerFrontProxy(req: RegisterFrontProxyRequest, actor: Actor): Promise<FrontProxyView>;
  surgePolicies(): Promise<SurgePolicyCandidates>;
  refreshSurge(actor: Actor): Promise<SurgeStatusView>;

  initPreview(actor: Actor): Promise<InitPreviewResponse>;
  initCommit(req: InitCommitRequest, actor: Actor): Promise<Accepted>;

  /** 原生桥消息：权限按 envelope.bridge.profileId 与绑定关系判断。 */
  handleNative(envelope: BridgeEnvelope): Promise<NativeResponse>;

  /** 启动：迁移后对账，再开始执行器。 */
  start(): Promise<void>;
  stop(): Promise<void>;
}
