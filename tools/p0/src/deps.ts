// P0 工具从服务代码复用的部分（只读引用，不修改 service/）：Surge 适配层、入口策略、生成器、
// 假 Surge、核对与脱敏，以及 agent.sock 的 NDJSON 客户端。

export * from '../../../service/src/surge/index.js';
export { ndjsonRequest, NdjsonClientError } from '../../../service/src/ipc/ndjson.js';
export { isSurgeSafeCredential, SURGE_SAFE_CREDENTIAL_RE } from '../../../service/src/domain/validate.js';
export type {
  EntryController,
  EntryReadback,
  EntryStep,
  ProfileFiles,
  SurgeAdapter,
  SurgeExternalResource,
  SurgeRequestRecord,
  SurgeRuleRecord,
} from '../../../service/src/ports.js';
