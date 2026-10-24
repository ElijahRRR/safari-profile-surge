// 会话令牌：登录交换页把令牌写入本源 localStorage 的 sfe.session（按端口隔离；不用 Cookie）。
// 任何读写都可能因隐私模式或存储被禁用而抛错，因此全部包在 try/catch 里；读不到即视为未登录。

export const SESSION_STORAGE_KEY = 'sfe.session';

export interface TokenStore {
  get(): string | null;
  clear(): void;
}

// 令牌只允许可见 ASCII，避免把异常内容拼进请求头。
const TOKEN_RE = /^[\x21-\x7e]{16,512}$/;

export function parseStoredToken(raw: string | null): string | null {
  if (raw === null) return null;
  let value = raw.trim();
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      value = parsed && typeof parsed === 'object' && typeof (parsed as { token?: unknown }).token === 'string' ? (parsed as { token: string }).token : '';
    } catch {
      return null;
    }
  }
  return TOKEN_RE.test(value) ? value : null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createLocalTokenStore(storage: () => Storage | null = defaultStorage): TokenStore {
  return {
    get() {
      try {
        return parseStoredToken(storage()?.getItem(SESSION_STORAGE_KEY) ?? null);
      } catch {
        return null;
      }
    },
    clear() {
      try {
        storage()?.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // 存储不可用时无事可做：令牌本来也读不到。
      }
    },
  };
}

/** 测试与演示用的内存实现。 */
export function createMemoryTokenStore(initial: string | null): TokenStore {
  let token = initial;
  return {
    get: () => token,
    clear: () => {
      token = null;
    },
  };
}
