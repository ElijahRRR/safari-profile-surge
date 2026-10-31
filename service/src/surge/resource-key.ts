// 本机节点资源（D10）的 key 安全检查：更新只按单个 key，CLI 把 key 放进 argv（`surge-cli external-resource update <key>`），
// HTTP API 把它放在请求体中。Surge 如何生成资源 key 没有写入文档（HTTP API 文档的示例像 32 位十六进制摘要）：如果 key 含有
// URL 或其中的读取令牌，经 CLI 更新就会把令牌放进命令行参数（CLAUDE.md 禁止凭据出现在命令行参数中，同一用户的 ps 可见）。
// 因此只有形状确定不可能含令牌的 key 才允许经 CLI 更新，其余必须经 HTTP API，否则发布暂停。TODO(P0)：记录真实的 key 形状。

import type { Mechanism } from './primitives.js';

/** 经 CLI 更新时 key 必须是这一形状（32 位小写十六进制，与 HTTP API 文档示例相同）。 */
const CLI_SAFE_RESOURCE_KEY_RE = /^[0-9a-f]{32}$/;

/** key 不可能经 CLI 安全更新时的暂停文字（发布与 P0 共用）。 */
export const RESOURCE_KEY_NEEDS_HTTP_MESSAGE = '更新本机节点资源必须经 Surge HTTP API：资源标识可能含读取令牌，不能出现在命令行参数中';

/** 没有可用的外部资源更新实现时的暂停文字。 */
export const RESOURCE_UPDATE_UNMAPPED_MESSAGE = '更新本机节点资源需要 Surge 的外部资源更新原语：当前没有经实测的实现';

/**
 * 本机节点资源的 key 能否作为 surge-cli 的命令行参数：只有恰好 32 位小写十六进制、不含 “/”、“:”、“%”，且与读取令牌互不包含
 * （key 不含令牌，也不是令牌的一段：一段令牌同样会削弱它）时为 true。令牌为空或不是字符串时为 false（失败即关闭）。
 */
export function canUseCliForResourceKey(key: string, token: string): boolean {
  if (typeof key !== 'string' || typeof token !== 'string' || token.length === 0) return false;
  if (!CLI_SAFE_RESOURCE_KEY_RE.test(key)) return false;
  if (key.includes('/') || key.includes(':') || key.includes('%')) return false;
  return !key.includes(token) && !token.includes(key);
}

export type ResourceUpdateRoute =
  | {
      kind: 'cli' | 'http' | 'fake';
    }
  | {
      kind: 'park';
      reason: 'key_unsafe_for_cli' | 'unmapped';
      /** 面向用户的暂停原因（不含 key、地址或令牌）。 */
      message: string;
    };

/**
 * 按原语清单决定本机节点资源的更新经哪种实现：
 * - http：key 在请求体中，任何 key 都可以；
 * - cli：只有 canUseCliForResourceKey 为 true 时；否则暂停（RESOURCE_KEY_NEEDS_HTTP_MESSAGE）；
 * - fake（假 Surge，进程内调用）：按 CLI 的规则检查，测试与演示据此覆盖暂停的路径；
 * - 未映射或 unavailable：暂停（RESOURCE_UPDATE_UNMAPPED_MESSAGE）。
 */
export function resourceUpdateRoute(mechanism: Readonly<Record<string, Mechanism | undefined>>, key: string, token: string): ResourceUpdateRoute {
  const m = mechanism.updateExternalResource;
  if (m === 'http') return { kind: 'http' };
  if (m === 'cli' || m === 'fake') {
    return canUseCliForResourceKey(key, token) ? { kind: m } : { kind: 'park', reason: 'key_unsafe_for_cli', message: RESOURCE_KEY_NEEDS_HTTP_MESSAGE };
  }
  return { kind: 'park', reason: 'unmapped', message: RESOURCE_UPDATE_UNMAPPED_MESSAGE };
}
