// 命令行参数解析（纯函数）。工具从不在参数中接受秘密：出现形似凭据的参数时拒绝执行。

import { CAPABILITY_KEYS, type CapabilityKey } from '@sfe/contract';
import { usage } from './errors.js';

export type FlagKind = 'string' | 'number' | 'boolean' | 'list';

export interface FlagSpec {
  kind: FlagKind;
  choices?: readonly string[];
  min?: number;
  max?: number;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  positionals: { min: number; max: number };
  flags: Record<string, FlagSpec>;
}

const PORT: FlagSpec = { kind: 'number', min: 1, max: 65535 };

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  'raw-dir': { kind: 'string' },
  run: { kind: 'string' },
  json: { kind: 'boolean' },
  yes: { kind: 'boolean' },
  'non-interactive': { kind: 'boolean' },
  help: { kind: 'boolean' },
  'surge-cli': { kind: 'string' },
  'surge-team-id': { kind: 'string' },
  profile: { kind: 'string' },
  mechanism: { kind: 'list' },
  proxy: { kind: 'string' },
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'inventory',
    summary: '只读盘点：Surge/CLI/HTTP 原语、外部资源、临时规则、系统与 Safari 版本、进程候选',
    usage: 'inventory [--profile <当前 Surge 配置路径>] [--surge-cli <路径>]',
    positionals: { min: 0, max: 0 },
    flags: {},
  },
  {
    name: 'test-servers',
    summary: '在 127.0.0.1 启动 IP 回显/WebSocket 服务、SOCKS5 出口与前置测试服务',
    usage: 'test-servers [--echo-port 18080] [--exit-port 18081] [--front-port 18082] [--dead-front-port 18083] [--allow-upstream <主机> …]',
    positionals: { min: 0, max: 0 },
    flags: {
      'echo-port': PORT,
      'exit-port': PORT,
      'front-port': PORT,
      'dead-front-port': PORT,
      'allow-upstream': { kind: 'list' },
      'h3-host': { kind: 'string' },
    },
  },
  {
    name: 'make-test-profile',
    summary: '从当前配置生成独立的 P0 测试配置（不覆盖任何文件）并 --check',
    usage: 'make-test-profile [--profile <源配置路径>] [--target-dir <目录>] [--http-api-port 6171] [--no-http-api]',
    positionals: { min: 0, max: 0 },
    flags: { 'target-dir': { kind: 'string' }, 'http-api-port': PORT, 'no-http-api': { kind: 'boolean' } },
  },
  {
    name: 'attribution',
    summary: '引导式：Safari、Chrome 与其他 WebKit 应用访问测试页，按进程路径归属',
    usage: 'attribution [--h3-host cloudflare-quic.com] [--ipv6-host api6.ipify.org] [--skip <步骤> …] [--grace 3]',
    positionals: { min: 0, max: 0 },
    flags: { 'h3-host': { kind: 'string' }, 'ipv6-host': { kind: 'string' }, skip: { kind: 'list' }, grace: { kind: 'number', min: 0, max: 60 } },
  },
  {
    name: 'charset',
    summary: '逐类测试代理凭据字符经 Surge 节点行传到出口服务器后是否保持原样',
    usage: 'charset [--classes <类别> …]',
    positionals: { min: 0, max: 0 },
    flags: { classes: { kind: 'list' }, wait: { kind: 'number', min: 1, max: 120 } },
  },
  {
    name: 'refresh',
    summary: '定向刷新测试节点资源并读回；测量自动重载、原子替换与是否发生重载',
    usage: 'refresh --auto-reload on|off [--wait 8] [--skip-removal-fallback]',
    positionals: { min: 0, max: 0 },
    flags: {
      'auto-reload': { kind: 'string', choices: ['on', 'off'] },
      wait: { kind: 'number', min: 1, max: 120 },
      'skip-removal-fallback': { kind: 'boolean' },
    },
  },
  {
    name: 'continuity',
    summary: '经 Surge HTTP 代理端口模拟“其他应用”的长连接、WebSocket 与短请求，记录时间线',
    usage: 'continuity [--duration 300] [--interval 1] [--public-url <https 地址>] [--reload-test] [--no-prompt]',
    positionals: { min: 0, max: 0 },
    flags: {
      duration: { kind: 'number', min: 10, max: 86400 },
      interval: { kind: 'number', min: 0.2, max: 60 },
      'public-url': { kind: 'string' },
      'reload-test': { kind: 'boolean' },
      'no-prompt': { kind: 'boolean' },
    },
  },
  {
    name: 'entry',
    summary: '在测试配置上按所选策略驱动 NORMAL→BLOCKED→VERIFY_ONLY→ACTIVE→NORMAL',
    usage: 'entry --strategy ruleset_resource|temp_rule [--process-path <路径> …] [--dwell 20] [--auto-reload-condition on|off|any] [--temp-insertion head|tail] [--probe-insertion] [--precedence-test temp|module …] [--restart-test] [--to <模式>]',
    positionals: { min: 0, max: 0 },
    flags: {
      strategy: { kind: 'string', choices: ['ruleset_resource', 'temp_rule'] },
      'process-path': { kind: 'list' },
      'verify-endpoint': { kind: 'string' },
      dwell: { kind: 'number', min: 0, max: 600 },
      'auto-reload-condition': { kind: 'string', choices: ['on', 'off', 'any'] },
      'temp-insertion': { kind: 'string', choices: ['head', 'tail'] },
      'probe-insertion': { kind: 'boolean' },
      'precedence-test': { kind: 'list' },
      'no-kill-test': { kind: 'boolean' },
      'restart-test': { kind: 'boolean' },
      to: { kind: 'string', choices: ['NORMAL', 'BLOCKED', 'VERIFY_ONLY', 'ACTIVE'] },
      'h3-host': { kind: 'string' },
    },
  },
  {
    name: 'chain',
    summary: '证明外部节点经 underlying-proxy 前置：前置可达、前置不可达、前置名缺失',
    usage: 'chain',
    positionals: { min: 0, max: 0 },
    flags: { wait: { kind: 'number', min: 1, max: 120 } },
  },
  {
    name: 'preflight',
    summary: '不改变当前选择，测试未选中的候选节点（testPolicy）',
    usage: 'preflight',
    positionals: { min: 0, max: 0 },
    flags: {},
  },
  {
    name: 'checklist',
    summary: '人工检查清单（原生桥、场景 ID、钥匙串、签名持久性、首请求与旧连接、重载影响、批量创建/按 ID 打开）',
    usage: 'checklist <能力> [--signing-identity <Team ID>] [--app-path /Applications/SafariProfileSurge.app]',
    positionals: { min: 1, max: 1 },
    flags: { 'signing-identity': { kind: 'string' }, 'app-path': { kind: 'string' } },
  },
  {
    name: 'propose',
    summary: '用本次证据生成能力提议并发送到服务 agent.sock（必须在网页后台确认）',
    usage: 'propose <能力> supported|unsupported [--dry-run] [--data-dir <服务数据目录>] [--working-profile any] [--auto-reload on|off|any] [--takeover enhanced|system_proxy|both|any] [--signing-identity <Team ID>] [--note <说明>]',
    positionals: { min: 2, max: 2 },
    flags: {
      'dry-run': { kind: 'boolean' },
      'data-dir': { kind: 'string' },
      'working-profile': { kind: 'string', choices: ['any'] },
      'auto-reload': { kind: 'string', choices: ['on', 'off', 'any'] },
      takeover: { kind: 'string', choices: ['enhanced', 'system_proxy', 'both', 'any'] },
      'signing-identity': { kind: 'string' },
      'app-path': { kind: 'string' },
      note: { kind: 'string' },
    },
  },
  {
    name: 'rollback',
    summary: '打印（--execute 时确认后执行）删除本工具添加的临时规则；说明如何手动切回原配置',
    usage: 'rollback [--execute]',
    positionals: { min: 0, max: 0 },
    flags: { execute: { kind: 'boolean' } },
  },
];

export interface ParsedArgs {
  command: string;
  positionals: string[];
  strings: Record<string, string>;
  numbers: Record<string, number>;
  booleans: Record<string, boolean>;
  lists: Record<string, string[]>;
}

// 形似凭据的参数：工具没有任何接收秘密的参数，出现即拒绝（不回显值）。
const SECRET_FLAG_RE = /^--?(password|passwd|pass|secret|token|key|api-key|apikey|username|user|x-key)(=|$)/i;
const SECRET_VALUE_RE = /(password|passwd|http-api|x-key)\s*=/i;

export function containsSecretArg(argv: readonly string[]): boolean {
  return argv.some((a) => SECRET_FLAG_RE.test(a) || SECRET_VALUE_RE.test(a));
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (containsSecretArg(argv)) {
    throw usage('参数检查失败：命令行参数中不能出现密码、密钥或令牌；P0 工具只使用合成测试凭据，并从运行目录读取');
  }
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', positionals: [], strings: {}, numbers: {}, booleans: {}, lists: {} };
  }
  const spec = findCommand(command);
  if (!spec) throw usage(`参数检查失败：未知命令 ${command.slice(0, 40)}`);
  const flags: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...spec.flags };
  const out: ParsedArgs = { command, positionals: [], strings: {}, numbers: {}, booleans: {}, lists: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const f = flags[name];
    if (!f) throw usage(`参数检查失败：命令 ${command} 不支持 --${name.slice(0, 40)}`);
    if (f.kind === 'boolean') {
      if (eq !== -1) throw usage(`参数检查失败：--${name} 不带值`);
      out.booleans[name] = true;
      continue;
    }
    const value = eq !== -1 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw usage(`参数检查失败：--${name} 缺少值`);
    if (/[\0\r\n]/.test(value)) throw usage(`参数检查失败：--${name} 的值含换行或控制字符`);
    if (f.choices && !f.choices.includes(value)) throw usage(`参数检查失败：--${name} 只能是 ${f.choices.join('、')}`);
    switch (f.kind) {
      case 'string':
        if (out.strings[name] !== undefined) throw usage(`参数检查失败：--${name} 重复`);
        out.strings[name] = value;
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n) || !/^-?\d+(\.\d+)?$/.test(value)) throw usage(`参数检查失败：--${name} 必须是数字`);
        if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          throw usage(`参数检查失败：--${name} 必须在 ${f.min ?? '-∞'}–${f.max ?? '∞'} 之间`);
        }
        if ((f.min ?? 0) >= 1 && f.max === 65535 && !Number.isInteger(n)) throw usage(`参数检查失败：--${name} 必须是整数`);
        out.numbers[name] = n;
        break;
      }
      case 'list':
        (out.lists[name] ??= []).push(...value.split(',').map((v) => v.trim()).filter(Boolean));
        break;
    }
  }
  if (out.positionals.length < spec.positionals.min || out.positionals.length > spec.positionals.max) {
    throw usage(`参数检查失败：用法 ${spec.usage}`);
  }
  return out;
}

export function parseCapabilityKey(value: string | undefined): CapabilityKey {
  if (value === undefined || !(CAPABILITY_KEYS as readonly string[]).includes(value)) {
    throw usage(`参数检查失败：能力必须是 ${CAPABILITY_KEYS.join('、')} 之一`);
  }
  return value as CapabilityKey;
}

/** --mechanism getVersion=cli,selectGroupPolicy=http 形式的覆盖。 */
export function parseMechanismOverrides(items: readonly string[], primitives: readonly string[]): Record<string, 'cli' | 'http' | 'unavailable'> {
  const out: Record<string, 'cli' | 'http' | 'unavailable'> = {};
  for (const item of items) {
    const m = /^([A-Za-z]+)=(cli|http|unavailable)$/.exec(item);
    if (!m || !primitives.includes(m[1]!)) throw usage('参数检查失败：--mechanism 格式为 <原语>=cli|http|unavailable，原语必须存在');
    out[m[1]!] = m[2] as 'cli' | 'http' | 'unavailable';
  }
  return out;
}

export function usageText(): string {
  const lines = [
    'P0 能力门槛实测工具。用法：npx tsx tools/p0/src/cli.ts <命令> [选项]',
    '',
    '命令：',
    ...COMMANDS.map((c) => `  ${c.usage}\n      ${c.summary}`),
    '',
    '通用选项：--raw-dir <目录>（原始证据，默认在仓库外）--run <运行编号> --json --yes --non-interactive',
    '          --surge-cli <路径> --surge-team-id <Team ID> --profile <配置路径> --proxy 127.0.0.1:6152',
    '          --mechanism <原语>=cli|http|unavailable',
    '',
    '工具从不切换配置、不重载全部、不 flush、不开关接管或出站模式；写入前打印快照与精确回退。',
    '操作手册：docs/P0-RUNBOOK.md',
  ];
  return `${lines.join('\n')}\n`;
}
