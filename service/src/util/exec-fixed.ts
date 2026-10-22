// 外部程序的统一执行入口（服务与 P0 共用）：只接受绝对路径的固定可执行文件，execFile 不经 shell，
// 启动后立即关闭 stdin。本项目调用的外部程序（surge-cli、codesign、sw_vers、defaults、ps、open 等）都不从
// stdin 读取输入；stdin 保持打开时，进入交互模式的程序（6.5 的 surge-cli 遇到无法识别的参数）会一直等到
// 超时被结束，被误报为“命令超时 / 无法连接”。关闭后它读到 EOF 立即退出。见 docs/ARCHITECTURE.md §5.1。
// 需要经 stdin 传请求的 sfe-keychain 不走这里（secrets/keychain-helper-store.ts 写入一行后同样立即关闭）。

import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface ExecFixedOptions {
  timeout: number;
  /** stdout/stderr 各自的上限（字节）；缺省为 Node 默认值。 */
  maxBuffer?: number;
  /** 子进程的完整环境（不与本进程合并）；缺省继承本进程。 */
  env?: NodeJS.ProcessEnv;
}

export interface ExecFixedResult {
  /** 无法启动、非零退出、超时被结束或输出超限时的错误（code 为退出码或 ENOENT 等）；成功为 null。 */
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}

/** 关闭子进程的 stdin。子进程已经退出时写端可能报 EPIPE，忽略。 */
export function closeChildStdin(child: Pick<ChildProcess, 'stdin'>): void {
  child.stdin?.on('error', () => undefined);
  child.stdin?.end();
}

/** 执行固定的外部程序；从不拒绝，结果中的 error 交给调用方按自己的语义分类。 */
export function execFixed(file: string, args: readonly string[], opts: ExecFixedOptions): Promise<ExecFixedResult> {
  if (!isAbsolute(file)) {
    // 不做 PATH 查找：相对名称可能解析到任意程序
    const error = Object.assign(new Error('只能执行绝对路径的程序'), { code: 'ERR_EXEC_NOT_ABSOLUTE' }) as ExecFileException;
    return Promise.resolve({ error, stdout: '', stderr: '' });
  }
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: opts.timeout,
        ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
    closeChildStdin(child);
  });
}
