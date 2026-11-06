// P0 能力门槛实测工具入口：npx tsx tools/p0/src/cli.ts <命令>。见 docs/P0-RUNBOOK.md。
// 工具从不切换 Surge 配置、不重载全部、不 flush、不开关接管或出站模式；写入前打印快照与精确回退；
// 原始输出只写仓库外的限权目录，终端只打印脱敏摘要。

import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageText } from './args.js';
import { runAttribution } from './commands/attribution.js';
import { runChain } from './commands/chain.js';
import { runCharset } from './commands/charset.js';
import { runChecklist } from './commands/checklist.js';
import { sleep, type Ctx, type Deps } from './commands/common.js';
import { runContinuity } from './commands/continuity.js';
import { runEntry } from './commands/entry.js';
import { runInstance } from './commands/instance.js';
import { runInventory } from './commands/inventory.js';
import { runLoopbackAuth } from './commands/loopback-auth.js';
import { runLoopbackCrash } from './commands/loopback-crash.js';
import { runLoopbackRestart } from './commands/loopback-restart.js';
import { runLoopback } from './commands/loopback.js';
import { runMakeTestProfile } from './commands/make-test-profile.js';
import { runPreflight } from './commands/preflight.js';
import { runPropose } from './commands/propose.js';
import { runRefresh } from './commands/refresh.js';
import { runResourceServer } from './commands/resource-server.js';
import { runRollback } from './commands/rollback.js';
import { runTestServers } from './commands/test-servers.js';
import { EXIT, P0Error, type ExitCode } from './errors.js';
import { createConsoleOutput, createConsolePrompter } from './io.js';
import { defaultExec } from './system.js';

/** 等待 Ctrl+C / SIGTERM（长时间运行的命令用）。 */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

export async function main(argv: readonly string[], deps?: Partial<Deps>): Promise<ExitCode> {
  const home = deps?.home ?? homedir();
  const out = deps?.out ?? createConsoleOutput({ home });
  try {
    const args = parseArgs(argv);
    if (args.command === 'help' || args.booleans.help) {
      process.stdout.write(usageText());
      return EXIT.OK;
    }
    const interactive = !args.booleans['non-interactive'] && Boolean(process.stdin.isTTY);
    const full: Deps = {
      exec: deps?.exec ?? defaultExec,
      now: deps?.now ?? (() => new Date()),
      home,
      platform: deps?.platform ?? process.platform,
      env: deps?.env ?? process.env,
      out,
      prompt: deps?.prompt ?? createConsolePrompter({ interactive, assumeYes: Boolean(args.booleans.yes) }),
      sleep: deps?.sleep ?? sleep,
      ...(deps?.surgeOverride ? { surgeOverride: deps.surgeOverride } : {}),
      ...(deps?.surgeInstance ? { surgeInstance: deps.surgeInstance } : {}),
      ...(deps?.pathPresence ? { pathPresence: deps.pathPresence } : {}),
      ...(deps?.resourceBinder ? { resourceBinder: deps.resourceBinder } : {}),
      ...(deps?.resourcePeerProbe ? { resourcePeerProbe: deps.resourcePeerProbe } : {}),
      ...(deps?.random ? { random: deps.random } : {}),
    };
    const ctx: Ctx = { args, deps: full };
    switch (args.command) {
      case 'inventory':
        return await runInventory(ctx);
      case 'instance':
        return await runInstance(ctx);
      case 'test-servers':
        return await runTestServers(ctx, untilSignal);
      case 'make-test-profile':
        return await runMakeTestProfile(ctx);
      case 'attribution':
        return await runAttribution(ctx);
      case 'resource-server':
        return await runResourceServer(ctx, untilSignal);
      case 'loopback':
        return await runLoopback(ctx);
      case 'loopback-auth':
        return await runLoopbackAuth(ctx);
      case 'loopback-restart':
        return await runLoopbackRestart(ctx);
      case 'loopback-crash':
        return await runLoopbackCrash(ctx);
      case 'charset':
        return await runCharset(ctx);
      case 'refresh':
        return await runRefresh(ctx);
      case 'continuity':
        return await runContinuity(ctx, untilSignal);
      case 'entry':
        return await runEntry(ctx);
      case 'chain':
        return await runChain(ctx);
      case 'preflight':
        return await runPreflight(ctx);
      case 'checklist':
        return await runChecklist(ctx);
      case 'propose':
        return await runPropose(ctx);
      case 'rollback':
        return await runRollback(ctx);
      default:
        out.warn('未知命令');
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof P0Error) {
      out.warn(e.message);
      if (e.code === 'usage') out.line('运行 help 查看用法。');
      return e.exitCode;
    }
    const code = (e as { code?: unknown })?.code;
    // 不输出未知错误的原文（可能夹带 Surge 输出或路径中的个人信息）；错误码可以输出。
    out.warn(`命令失败：发生未预期的错误${typeof code === 'string' ? `（${code}）` : ''}`);
    return EXIT.ERROR;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // 交互式读入与计时器可能仍挂着：命令结束即退出。
    setTimeout(() => process.exit(code), 100).unref();
  });
}
