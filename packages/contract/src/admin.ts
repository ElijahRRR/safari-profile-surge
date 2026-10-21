// 本机套接字（NDJSON）命令：sfe CLI、GPT/导入工具与宿主 App 使用。
// 两个套接字，均为 0600、位于 0700 数据目录：
//   agent.sock       受限角色（sfe 默认、文档提供给 GPT/导入工具）：最小权限，输出脱敏；
//   maintenance.sock 维护角色（宿主 App、sfe admin 子命令）：登录码、账号明文、前置与设置。
// 这是给 agent 的最小权限分隔，不是对抗同一用户恶意进程的安全边界（见 docs/ARCHITECTURE.md §2）。
// 能力“确认”只能在网页完成；两个套接字都只能“提议”。

import type {
  AccountDetail,
  Accepted,
  AcknowledgeAccountRequest,
  AcknowledgeWindowsRequest,
  ActivateRequest,
  CancelOperationRequest,
  CreateEnvironmentRequest,
  DeleteEnvironmentRequest,
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRequest,
  NormalModeRequest,
  ProbeRequest,
  ProposeCapabilityRequest,
  PublishPendingRequest,
  RegisterFrontProxyRequest,
  ReplaceFrontCommitRequest,
  ReplaceFrontPreview,
  ReplaceFrontPreviewRequest,
  UnbindRequest,
  UpdateEnvironmentRequest,
  UpdateFrontProxyRequest,
  UpdateSettingsRequest,
  VerifyFrontProxyRequest,
} from './api.js';
import type { CapabilityView, EnvironmentView, FrontProxyView, OperationView, SettingsView, Snapshot, SurgeStatusView } from './models.js';

export type AdminRole = 'agent' | 'maintenance';

export const ADMIN_OPS = {
  status: { roles: ['agent', 'maintenance'], secrets: false },
  listEnvironments: { roles: ['agent', 'maintenance'], secrets: false },
  getEnvironment: { roles: ['agent', 'maintenance'], secrets: false },
  createEnvironment: { roles: ['agent', 'maintenance'], secrets: true },
  updateEnvironment: { roles: ['agent', 'maintenance'], secrets: true },
  deleteEnvironment: { roles: ['maintenance'], secrets: false },
  unbind: { roles: ['maintenance'], secrets: false },
  acknowledgeAccount: { roles: ['maintenance'], secrets: false },
  importPreview: { roles: ['agent', 'maintenance'], secrets: true },
  importCommit: { roles: ['agent', 'maintenance'], secrets: true },
  importTemplate: { roles: ['agent', 'maintenance'], secrets: false },
  getOperation: { roles: ['agent', 'maintenance'], secrets: false },
  cancelOperation: { roles: ['agent', 'maintenance'], secrets: false },
  acknowledgeWindows: { roles: ['maintenance'], secrets: false },
  listOperations: { roles: ['agent', 'maintenance'], secrets: false },
  activate: { roles: ['agent', 'maintenance'], secrets: false },
  normal: { roles: ['agent', 'maintenance'], secrets: false },
  probe: { roles: ['agent', 'maintenance'], secrets: false },
  publishPending: { roles: ['agent', 'maintenance'], secrets: false },
  listCapabilities: { roles: ['agent', 'maintenance'], secrets: false },
  proposeCapability: { roles: ['agent', 'maintenance'], secrets: false },
  listFrontProxies: { roles: ['agent', 'maintenance'], secrets: false },
  surgePolicies: { roles: ['agent', 'maintenance'], secrets: false },
  issueLoginCode: { roles: ['maintenance'], secrets: false },
  accountDetail: { roles: ['maintenance'], secrets: false },
  registerFrontProxy: { roles: ['maintenance'], secrets: false },
  updateFrontProxy: { roles: ['maintenance'], secrets: false },
  verifyFrontProxy: { roles: ['maintenance'], secrets: false },
  replaceFrontPreview: { roles: ['maintenance'], secrets: false },
  replaceFrontCommit: { roles: ['maintenance'], secrets: false },
  getSettings: { roles: ['agent', 'maintenance'], secrets: false },
  updateSettings: { roles: ['maintenance'], secrets: false },
  refreshSurge: { roles: ['agent', 'maintenance'], secrets: false },
} as const satisfies Record<keyof AdminOpTypes, { roles: readonly AdminRole[]; secrets: boolean }>;

export type AdminOp = keyof typeof ADMIN_OPS;

/**
 * 每个命令的参数与返回类型。参数中的 id 类字段与 HTTP 路径参数对应（id / environment_id）。
 * CLI 与服务端都按此表编解码，避免两边漂移。
 */
export interface AdminOpTypes {
  status: { args: Record<string, never>; result: Snapshot };
  listEnvironments: { args: Record<string, never>; result: EnvironmentView[] };
  getEnvironment: { args: { id: string }; result: EnvironmentView };
  createEnvironment: { args: CreateEnvironmentRequest; result: Accepted };
  updateEnvironment: { args: { id: string } & UpdateEnvironmentRequest; result: Accepted };
  deleteEnvironment: { args: { id: string } & DeleteEnvironmentRequest; result: Accepted };
  unbind: { args: { id: string } & UnbindRequest; result: Accepted };
  acknowledgeAccount: { args: { id: string } & AcknowledgeAccountRequest; result: Accepted };
  importPreview: { args: ImportPreviewRequest; result: ImportPreview };
  importCommit: { args: ImportCommitRequest; result: ImportCommitResult };
  importTemplate: { args: Record<string, never>; result: { csv: string } };
  getOperation: { args: { id: string }; result: OperationView };
  listOperations: { args: { limit?: number }; result: OperationView[] };
  cancelOperation: { args: { id: string } & CancelOperationRequest; result: Accepted };
  acknowledgeWindows: { args: AcknowledgeWindowsRequest; result: Accepted };
  activate: { args: { id: string } & ActivateRequest; result: Accepted };
  normal: { args: NormalModeRequest; result: Accepted };
  probe: { args: { id: string } & ProbeRequest; result: Accepted };
  publishPending: { args: PublishPendingRequest; result: Accepted };
  listCapabilities: { args: Record<string, never>; result: CapabilityView[] };
  proposeCapability: { args: ProposeCapabilityRequest; result: { proposal_id: string } };
  listFrontProxies: { args: Record<string, never>; result: FrontProxyView[] };
  surgePolicies: { args: Record<string, never>; result: { proxies: string[]; groups: string[] } };
  issueLoginCode: { args: Record<string, never>; result: LoginCodeResponse };
  accountDetail: { args: { id: string }; result: AccountDetail };
  registerFrontProxy: { args: RegisterFrontProxyRequest; result: FrontProxyView };
  updateFrontProxy: { args: { id: string } & UpdateFrontProxyRequest; result: FrontProxyView };
  verifyFrontProxy: { args: { id: string } & VerifyFrontProxyRequest; result: Accepted };
  replaceFrontPreview: { args: { id: string } & ReplaceFrontPreviewRequest; result: ReplaceFrontPreview };
  replaceFrontCommit: { args: { id: string } & ReplaceFrontCommitRequest; result: Accepted };
  getSettings: { args: Record<string, never>; result: SettingsView };
  updateSettings: { args: UpdateSettingsRequest; result: SettingsView };
  refreshSurge: { args: Record<string, never>; result: SurgeStatusView };
}

export interface AdminRequestEnvelope {
  v: 1;
  op: AdminOp;
  /** 携带秘密的命令（secrets: true）只能由 CLI 从 stdin 读入后发送，从不出现在命令行参数中。 */
  args: Record<string, unknown>;
}

export interface LoginCodeResponse {
  /** 实际已绑定的登录地址（含一次性登录码，≥128 位随机、60 秒、单次）。只交给宿主 App 或 .webloc 文件打开。 */
  url: string;
  expiresAt: string;
}

export function adminOpAllowed(op: string, role: AdminRole): op is AdminOp {
  const def = (ADMIN_OPS as Record<string, { roles: readonly AdminRole[] } | undefined>)[op];
  return def !== undefined && def.roles.includes(role);
}
