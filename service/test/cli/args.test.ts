import { describe, expect, test } from 'vitest';
import { SECRET_ARG_RE, UsageError, assertFlags, containsSecretArg, multi, parseArgv, resolveDataDir, single, socketPath } from '../../src/cli/args.js';
import { runCli } from '../../src/cli/sfe.js';
import { fakeCli } from './helpers.js';

describe('secret refusal in argv', () => {
  test.each([
    ['env', 'create', '--password', 'hunter2'],
    ['env', 'create', '--password=abc'],
    ['env', 'create', '--proxy-pass', 'x'],
    ['import', 'buyers-PASSWORDS.csv'],
    ['status', '--token', 'abc'],
    ['status', 'session-token-abc'],
    ['admin', 'settings', 'set', 'secret'],
    ['status', 'api_key=abc'],
    ['status', '--key', 'abc'],
    ['status', 'Cookie:sfe.session=x'],
  ])('refuses %j with exit 2 and never contacts the service', async (...argv) => {
    const cli = fakeCli({ argv });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
    expect(cli.stderr()).toContain('命令行参数中不能出现密码、令牌、密钥或 Cookie');
    expect(cli.stderr()).toContain('标准输入');
    // 不回显可能是秘密的参数
    expect(cli.stderr()).not.toContain('hunter2');
    expect(cli.stderr()).not.toContain('abc');
    expect(cli.stdout()).toBe('');
  });

  test('normal arguments pass', () => {
    expect(containsSecretArg(['env', 'open', 'env_01', '--old-windows', 'closed', '--confirmed-env', 'none'])).toBe(false);
    expect(containsSecretArg(['import', 'buyers.csv', '--resolve', '3:update:env_02', '--commit'])).toBe(false);
  });

  test('pattern is the specified one', () => {
    expect(SECRET_ARG_RE.source).toBe('pass|token|secret|key=|--key|cookie');
    expect(SECRET_ARG_RE.flags).toBe('i');
  });
});

describe('parseArgv', () => {
  test('positionals, --flag value, --flag=value, booleans', () => {
    const a = parseArgv(['env', 'open', 'env_01', '--old-windows', 'closed', '--confirmed-env=none', '--json']);
    expect(a.positionals).toEqual(['env', 'open', 'env_01']);
    expect(single(a, 'old-windows')).toBe('closed');
    expect(single(a, 'confirmed-env')).toBe('none');
    expect(a.booleans.has('json')).toBe(true);
  });

  test('repeatable flags', () => {
    const a = parseArgv(['publish', '--env', 'a', '--env=b']);
    expect(multi(a, 'env')).toEqual(['a', 'b']);
  });

  test('non-repeatable flags cannot repeat', () => {
    expect(() => parseArgv(['op', 'x', '--timeout', '1', '--timeout', '2'])).toThrow(UsageError);
  });

  test('unknown flag, missing value, boolean with value', () => {
    expect(() => parseArgv(['status', '--nope'])).toThrow(UsageError);
    expect(() => parseArgv(['probe', 'x', '--kind'])).toThrow(UsageError);
    expect(() => parseArgv(['status', '--json=1'])).toThrow(UsageError);
    expect(() => parseArgv(['status', '-x'])).toThrow(UsageError);
  });

  test('-- ends flag parsing', () => {
    expect(parseArgv(['import', '--', '--odd-name.csv']).positionals).toEqual(['import', '--odd-name.csv']);
  });

  test('-h means help', () => {
    expect(parseArgv(['-h']).booleans.has('help')).toBe(true);
  });

  test('assertFlags allows globals and declared flags only', () => {
    expect(() => assertFlags(parseArgv(['status', '--json', '--data-dir', '/x']), [], 'sfe status')).not.toThrow();
    expect(() => assertFlags(parseArgv(['status', '--commit']), [], 'sfe status')).toThrow(UsageError);
  });
});

describe('data dir and sockets', () => {
  const base = { env: {}, homedir: '/Users/tester', cwd: '/work' };
  test('darwin default', () => {
    expect(resolveDataDir({ ...base, flag: undefined, platform: 'darwin' })).toBe('/Users/tester/Library/Application Support/SafariProfileSurge');
  });
  test('linux default and XDG', () => {
    expect(resolveDataDir({ ...base, flag: undefined, platform: 'linux' })).toBe('/Users/tester/.local/share/safari-profile-surge');
    expect(resolveDataDir({ ...base, flag: undefined, platform: 'linux', env: { XDG_DATA_HOME: '/xdg' } })).toBe('/xdg/safari-profile-surge');
    expect(resolveDataDir({ ...base, flag: undefined, platform: 'linux', env: { XDG_DATA_HOME: 'relative' } })).toBe('/Users/tester/.local/share/safari-profile-surge');
  });
  test('SFE_DATA_DIR and --data-dir (flag wins; relative to cwd)', () => {
    expect(resolveDataDir({ ...base, flag: undefined, platform: 'darwin', env: { SFE_DATA_DIR: 'd' } })).toBe('/work/d');
    expect(resolveDataDir({ ...base, flag: '/f', platform: 'darwin', env: { SFE_DATA_DIR: '/e' } })).toBe('/f');
  });
  test('socket names', () => {
    expect(socketPath('/d', 'agent')).toBe('/d/agent.sock');
    expect(socketPath('/d', 'maintenance')).toBe('/d/maintenance.sock');
  });

  test('default commands use agent.sock; sfe admin uses maintenance.sock', async () => {
    const a = fakeCli({ argv: ['env', 'list', '--data-dir', '/dd'], responses: { listEnvironments: [] } });
    expect(await runCli(a.deps)).toBe(0);
    expect(a.requests[0]!.socketPath).toBe('/dd/agent.sock');
    const m = fakeCli({ argv: ['admin', 'env', 'list', '--data-dir', '/dd'], responses: { listEnvironments: [] } });
    expect(await runCli(m.deps)).toBe(0);
    expect(m.requests[0]!.socketPath).toBe('/dd/maintenance.sock');
  });

  test('SFE_DATA_DIR selects the socket directory', async () => {
    const a = fakeCli({ argv: ['status'], env: { SFE_DATA_DIR: '/env-data' }, responses: { status: { serviceVersion: 'x', environments: [] } } });
    await runCli(a.deps);
    expect(a.requests[0]!.socketPath).toBe('/env-data/agent.sock');
  });
});
