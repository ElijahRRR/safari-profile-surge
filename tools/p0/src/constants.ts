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
} as const;
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
