// 应用门面：HTTP、agent/maintenance 套接字、原生桥都只通过这个接口调用业务；业务实现见 engine/。
// Actor 用于审计与权限：bridge 请求的场景身份只来自原生桥（令牌校验后），不来自消息体。

import type {
  AccountDetail,
  Accepted,
  AcknowledgeAccountRequest,
  ActivateRequest,
  BridgeEnvelope,
  CapabilityView,
  ConfirmCapabilityRequest,
  CreateEnvironmentRequest,
  DeleteEnvironmentRequest,
  EnvironmentView,
  FrontProxyView,
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRequest,
  InitCommitRequest,
  InitPreviewRequest,
  InitPreviewResponse,
  LoginCodeResponse,
  NativeResponse,
  NormalModeRequest,
  OperationView,
  ProbeRequest,
  ProposeCapabilityRequest,
  PublishPendingRequest,
  RegisterFrontProxyRequest,
  RemergeCommitRequest,
  RemergePreviewResponse,
  ReplaceFrontCommitRequest,
  ReplaceFrontPreview,
  ReplaceFrontPreviewRequest,
  SettingsView,
  Snapshot,
  SurgeStatusView,
  UnbindRequest,
  UpdateEnvironmentRequest,
  UpdateFrontProxyRequest,
  UpdateSettingsRequest,
} from '@sfe/contract';
import type { EventBus } from './ports.js';

export type Actor =
  | { kind: 'web'; sessionId: string }
  | { kind: 'agent' }
  | { kind: 'admin' }
  | { kind: 'bridge'; profileId: string | null };

export interface SurgePolicyCandidates {
  /** 可作为前置的用户代理节点名（不含 SFE- 节点、内置策略）。 */
  proxies: string[];
  /** 仅供展示：组不能作为前置。 */
  groups: string[];
}

export interface AppService {
  readonly events: EventBus;

  /** agent 角色得到的快照中登录账号已打码。 */
  snapshot(actor: Actor): Promise<Snapshot>;
  listEnvironments(actor: Actor): Promise<EnvironmentView[]>;
  getEnvironment(id: string, actor: Actor): Promise<EnvironmentView>;
  createEnvironment(req: CreateEnvironmentRequest, actor: Actor): Promise<Accepted>;
  updateEnvironment(id: string, req: UpdateEnvironmentRequest, actor: Actor): Promise<Accepted>;
  deleteEnvironment(id: string, req: DeleteEnvironmentRequest, actor: Actor): Promise<Accepted>;
  /** 只允许 web 与 admin（maintenance）角色。 */
  accountDetail(id: string, actor: Actor): Promise<AccountDetail>;
  acknowledgeAccount(id: string, req: AcknowledgeAccountRequest, actor: Actor): Promise<Accepted>;
  unbind(id: string, req: UnbindRequest, actor: Actor): Promise<Accepted>;

  activate(id: string, req: ActivateRequest, actor: Actor): Promise<Accepted>;
  enterNormal(req: NormalModeRequest, actor: Actor): Promise<Accepted>;
  probe(id: string, req: ProbeRequest, actor: Actor): Promise<Accepted>;
  publishPending(req: PublishPendingRequest, actor: Actor): Promise<Accepted>;

  getOperation(id: string, actor: Actor): Promise<OperationView>;
  listOperations(limit: number, actor: Actor): Promise<OperationView[]>;

  importPreview(req: ImportPreviewRequest, actor: Actor): Promise<ImportPreview>;
  importCommit(req: ImportCommitRequest, actor: Actor): Promise<ImportCommitResult>;
  importTemplateCsv(): string;

  listCapabilities(): Promise<CapabilityView[]>;
  /** agent/admin/web 都可以提议；只有 web 可以确认（confirmCapability）。 */
  proposeCapability(req: ProposeCapabilityRequest, actor: Actor): Promise<{ proposal_id: string }>;
  confirmCapability(req: ConfirmCapabilityRequest, actor: Actor): Promise<CapabilityView>;

  getSettings(): Promise<SettingsView>;
  updateSettings(req: UpdateSettingsRequest, actor: Actor): Promise<SettingsView>;

  listFrontProxies(): Promise<FrontProxyView[]>;
  registerFrontProxy(req: RegisterFrontProxyRequest, actor: Actor): Promise<FrontProxyView>;
  updateFrontProxy(id: string, req: UpdateFrontProxyRequest, actor: Actor): Promise<FrontProxyView>;
  verifyFrontProxy(id: string, requestId: string, actor: Actor): Promise<Accepted>;
  replaceFrontPreview(id: string, req: ReplaceFrontPreviewRequest, actor: Actor): Promise<ReplaceFrontPreview>;
  replaceFrontCommit(id: string, req: ReplaceFrontCommitRequest, actor: Actor): Promise<Accepted>;
  surgePolicies(): Promise<SurgePolicyCandidates>;
  /** 只读重新读取 Surge 事实（对账），从不写 Surge。 */
  refreshSurge(actor: Actor): Promise<SurgeStatusView>;

  initPreview(req: InitPreviewRequest, actor: Actor): Promise<InitPreviewResponse>;
  initCommit(req: InitCommitRequest, actor: Actor): Promise<Accepted>;
  remergePreview(actor: Actor): Promise<RemergePreviewResponse>;
  remergeCommit(req: RemergeCommitRequest, actor: Actor): Promise<Accepted>;

  /** 只允许 admin（maintenance）角色；HTTP 未绑定时失败。 */
  issueLoginCode(actor: Actor): Promise<LoginCodeResponse>;

  /** 原生桥消息：调用方（ipc 层）已校验传输令牌；权限按 NATIVE_PERMISSIONS 与绑定关系判断。 */
  handleNative(envelope: BridgeEnvelope): Promise<NativeResponse>;

  /** 启动：版本断言、迁移后对账、恢复未完成操作，再开始执行器与周期对账。 */
  start(): Promise<void>;
  /** 停止从不改变入口状态或 SFE-ROUTE 选择。 */
  stop(): Promise<void>;
}
