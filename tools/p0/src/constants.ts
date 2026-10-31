// 运行目录中的文件名（相对路径）。原始证据只在本机限权目录。

export const CHARSET_EXPECT_FILE = 'charset-expect.json';
/** 合成测试凭据（只对本机测试服务有效）。 */
export const TEST_CREDENTIALS_FILE = 'test-credentials.json';
export const CALLS_LOG = 'surge-calls.jsonl';
/** 各命令的写入与关键动作时间线（continuity 据此标注事件）。 */
export const ACTIONS_LOG = 'actions.jsonl';
export const SERVER_LOGS = {
  echo: 'servers/echo.jsonl',
  exit: 'servers/exit.jsonl',
  front: 'servers/front.jsonl',
  page: 'servers/page.jsonl',
  /** 测试资源服务（resource-server，含 --squat 占用者）的请求记录：只记名称、状态与原因代码，从不记令牌、路径或列表内容。 */
  resource: 'servers/resource.jsonl',
  /** 测试资源服务的审计记录（产品 host.onServed 的序号、时间、代与是否完整写出），供各命令按产品规则核对下载。 */
  resourceAudit: 'servers/resource-audit.jsonl',
} as const;
/** 测试资源服务的读取令牌（64 位十六进制，0600；从不作为命令行参数、从不打印）。 */
export const RESOURCE_TOKEN_FILE = 'resource-token';
/** 测试资源服务提供哪一代内容与故障场景（其他命令原子写入，resource-server 读取）。 */
export const RESOURCE_SERVED_FILE = 'resource-served.json';
/** resource-server 自己写的状态（进程、端口、是否在监听、已应用的状态版本）。 */
export const RESOURCE_STATUS_FILE = 'resource-server-status.json';
/** resource-server --squat（端口占用者）自己写的状态。 */
export const RESOURCE_SQUAT_STATUS_FILE = 'resource-squat-status.json';
/** 测试资源服务的缺省端口：2026-10-25 补测保持空闲的第五个端口（18080–18083 已由 test-servers 使用）。 */
export const DEFAULT_RESOURCE_PORT = 18084;
/** 单 key 更新的适配器时限（与服务 main.ts 的 SURGE_RESOURCE_UPDATE_TIMEOUT_MS 相同）：超时是结果不明，从不重放。 */
export const RESOURCE_UPDATE_TIMEOUT_MS = 30_000;
/**
 * 更新之后的读回等待（与服务的 DEFAULT_RESOURCE_UPDATE_WAIT 相同）：Surge 报告 updating 期间每 pollMs 读一次，至多 timeoutMs；
 * 结束后再等 settleMs 读一次、再等 settleMs 重读一次（两次一致才算稳定）。2026-10-25 补测中一次不答复的下载连同重试约 12.9 秒。
 */
export const RESOURCE_UPDATE_WAIT = { timeoutMs: 30_000, pollMs: 500, settleMs: 800 } as const;
export const ENTRY_OWNERSHIP_FILE = 'entry-ownership.json';
export const DEFAULT_PORTS = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 } as const;
export const DEFAULT_SURGE_PROXY = '127.0.0.1:6152';
export const DEFAULT_H3_HOST = 'cloudflare-quic.com';
export const DEFAULT_IPV6_HOST = 'api6.ipify.org';
export const DEFAULT_HTTP_API_PORT = 6171;
/**
 * 提议摘要的最大字符数：与服务 proposeCapability 的校验上限一致（service/src/engine/admin-ops.ts，
 * 超过即 VALIDATION_FAILED）。契约包没有导出该常量；两处改动必须同步（test/proposal.test.ts 会核对）。
 */
export const PROPOSAL_SUMMARY_MAX_CHARS = 4000;
