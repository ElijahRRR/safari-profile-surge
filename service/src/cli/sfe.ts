// sfe 命令行入口（docs/ARCHITECTURE.md §7.3）。构建为 dist/sfe.mjs（带 #!/usr/bin/env node）。
// 依赖全部经 CliDeps 注入，测试不需要真实套接字或 /usr/bin/open。

import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ndjsonRequest } from '../ipc/ndjson.js';
import { execFixed } from '../util/exec-fixed.js';
import { EXIT, SECRET_ARG_MESSAGE, UsageError, containsSecretArg, flag, parseArgv, resolveDataDir, single, type ExitCode } from './args.js';
import { CliApiError, CliConnectError, MAX_IMPORT_FILE_BYTES, renderError, runCommand, usageText, type CliDeps } from './commands.js';
import { OpenError } from './open.js';

export const MAX_STDIN_BYTES = 16 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 120_000;

export type { CliDeps } from './commands.js';

export async function runCli(deps: CliDeps): Promise<ExitCode> {
  const argv = deps.argv;
  // 在任何解析之前检查：秘密不能经命令行参数传入
  if (containsSecretArg(argv)) {
    deps.stderr(`${SECRET_ARG_MESSAGE}\n`);
    return EXIT.USAGE;
  }
  let json = false;
  try {
    const args = parseArgv(argv);
    json = flag(args, 'json');
    if (flag(args, 'help') || args.positionals[0] === 'help') {
      deps.stdout(usageText());
      return EXIT.OK;
    }
    if (args.positionals.length === 0) {
      deps.stderr(usageText());
      return EXIT.USAGE;
    }
    const dataDir = resolveDataDir({ flag: single(args, 'data-dir'), env: deps.env, platform: deps.platform, homedir: deps.homedir, cwd: deps.cwd });
    return await runCommand({ deps, args, json, dataDir }, args.positionals);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`${err.message}\n运行 sfe help 查看用法。\n`);
      return EXIT.USAGE;
    }
    if (err instanceof CliApiError) {
      const out = renderError(err, json);
      if (out.stdout) deps.stdout(out.stdout);
      if (out.stderr) deps.stderr(out.stderr);
      return err.body.code === 'NEEDS_CONFIRMATION' ? EXIT.NEEDS_CONFIRMATION : EXIT.ERROR;
    }
    if (err instanceof CliConnectError || err instanceof OpenError) {
      deps.stderr(`${err.message}\n`);
      return EXIT.ERROR;
    }
    // 不输出未知错误的原文：可能夹带输入片段
    deps.stderr('命令失败：发生未预期的错误\n');
    return EXIT.ERROR;
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('请通过标准输入提供 JSON，例如 sfe env create < environment.json');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_STDIN_BYTES) throw new UsageError('标准输入超过 16 MB 上限');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export function defaultDeps(argv: string[] = process.argv.slice(2)): CliDeps {
  return {
    argv,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    cwd: process.cwd(),
    uid: process.getuid?.(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    readStdin: readAllStdin,
    async readFile(path) {
      const st = await stat(path);
      if (!st.isFile()) throw new UsageError('读取导入文件失败：不是普通文件');
      if (st.size > MAX_IMPORT_FILE_BYTES) throw new UsageError('导入失败：文件超过 8 MB 上限');
      return readFile(path);
    },
    request: (socketPath, envelope) => ndjsonRequest({ path: socketPath }, envelope, { maxResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }),
    exec: async (file, args) => {
      const r = await execFixed(file, args, { timeout: 10_000 });
      if (r.error) throw r.error;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    newRequestId: () => `cli-${randomUUID()}`,
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runCli(defaultDeps()).then((code) => {
    process.exitCode = code;
  });
}
