// P0 工具的错误与退出码。消息为简体中文，按「动作 + 失败：原因」书写，从不回显秘密或原始输出。

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  /** 前置条件不满足或用户取消：没有写入任何东西。 */
  REFUSED: 3,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class P0Error extends Error {
  constructor(
    readonly code: 'usage' | 'refused' | 'failed' | 'unsafe',
    message: string,
  ) {
    super(message);
    this.name = 'P0Error';
  }

  get exitCode(): ExitCode {
    return this.code === 'usage' ? EXIT.USAGE : this.code === 'refused' || this.code === 'unsafe' ? EXIT.REFUSED : EXIT.ERROR;
  }
}

export function usage(message: string): P0Error {
  return new P0Error('usage', message);
}

export function refused(message: string): P0Error {
  return new P0Error('refused', message);
}

export function failed(message: string): P0Error {
  return new P0Error('failed', message);
}
