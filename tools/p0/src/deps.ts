// P0 工具从服务代码复用的部分（只读引用，不修改 service/）：Surge 适配层（含运行中 Surge 实例的版本读取器）、入口策略、生成器、
// 假 Surge、核对与脱敏、子进程执行器（stdin 关闭）、agent.sock 的 NDJSON 客户端，以及本机资源服务（D10：读取令牌、资源宿主
// 与绑定方、审计与读回核对——P0 的资源服务就是产品的处理程序）。

export * from '../../../service/src/surge/index.js';
export * from '../../../service/src/resource/index.js';
export { ndjsonRequest, NdjsonClientError } from '../../../service/src/ipc/ndjson.js';
export { isSurgeSafeCredential, SURGE_SAFE_CREDENTIAL_RE } from '../../../service/src/domain/validate.js';
export { classifyDirectoryRisk } from '../../../service/src/util/secure-files.js';
export { execFixed, type ExecFixedOptions, type ExecFixedResult } from '../../../service/src/util/exec-fixed.js';
export type {
  Clock,
  EntryController,
  Logger,
  LogLevel,
  EntryReadback,
  EntryStep,
  ProfileFiles,
  SurgeAdapter,
  SurgeExternalResource,
  SurgeRequestRecord,
  SurgeResourceUpdateResult,
  SurgeRuleMatchResult,
  SurgeRuleRecord,
  SurgeVersion,
} from '../../../service/src/ports.js';
