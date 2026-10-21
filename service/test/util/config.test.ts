import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALL_SURGE_PRIMITIVES, DEFAULT_BRIDGE_PORT, loadConfig, readInstallConfig, type LoadConfigOptions } from '../../src/config.js';

const isRoot = process.getuid?.() === 0;

function base(overrides: Partial<LoadConfigOptions> = {}): LoadConfigOptions {
  const home = mkdtempSync(join(tmpdir(), 'sfe-home-'));
  return { argv: [], env: {}, platform: 'linux', homedir: home, cwd: home, ...overrides };
}

function writeInstall(dataDir: string, content: unknown, mode = 0o600): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = join(dataDir, 'install.json');
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(p, mode);
  return p;
}

describe('data directory defaults', () => {
  test('darwin uses ~/Library/Application Support/SafariProfileSurge', () => {
    const o = base({ platform: 'darwin' });
    const c = loadConfig(o);
    expect(c.dataDir).toBe(join(o.homedir, 'Library', 'Application Support', 'SafariProfileSurge'));
  });

  test('linux uses $XDG_DATA_HOME when absolute', () => {
    const o = base();
    const xdg = join(o.homedir, 'xdg');
    const c = loadConfig({ ...o, env: { XDG_DATA_HOME: xdg } });
    expect(c.dataDir).toBe(join(xdg, 'safari-profile-surge'));
  });

  test('linux falls back to ~/.local/share when XDG_DATA_HOME is missing or relative', () => {
    const o = base();
    expect(loadConfig(o).dataDir).toBe(join(o.homedir, '.local', 'share', 'safari-profile-surge'));
    expect(loadConfig({ ...o, env: { XDG_DATA_HOME: 'relative/xdg' } }).dataDir).toBe(join(o.homedir, '.local', 'share', 'safari-profile-surge'));
  });

  test('--data-dir overrides (both forms), resolved against cwd', () => {
    const o = base();
    expect(loadConfig({ ...o, argv: ['--data-dir', 'mydata'] }).dataDir).toBe(join(o.cwd, 'mydata'));
    expect(loadConfig({ ...o, argv: ['--data-dir=/abs/data'] }).dataDir).toBe('/abs/data');
  });

  test('derived paths and defaults', () => {
    const o = base();
    const c = loadConfig(o);
    expect(c).toMatchObject({
      demo: false,
      tmpDir: join(c.dataDir, 'tmp'),
      backupsDir: join(c.dataDir, 'backups'),
      databasePath: join(c.dataDir, 'sfe.sqlite'),
      agentSocketPath: join(c.dataDir, 'agent.sock'),
      maintenanceSocketPath: join(c.dataDir, 'maintenance.sock'),
      installConfigPath: join(c.dataDir, 'install.json'),
      httpPort: 61847,
      webRoot: null,
      extensionHarnessRoot: null,
      surgeCliPath: null,
      keychainHelperPath: null,
      nodeVersionPin: null,
      installConfigIssues: [],
      bridge: { transport: 'tcp', host: '127.0.0.1', port: DEFAULT_BRIDGE_PORT, tokenFile: join(c.dataDir, 'bridge.token') },
    });
    expect(Object.values(c.adapterMechanism).every((m) => m === 'unavailable')).toBe(true);
    expect(Object.keys(c.adapterMechanism).sort()).toEqual([...ALL_SURGE_PRIMITIVES].sort());
  });
});

describe('arguments', () => {
  test('rejects unknown flags, positional arguments and missing values', () => {
    const o = base();
    expect(() => loadConfig({ ...o, argv: ['--surge-cli', '/x'] })).toThrow(/未知参数/);
    expect(() => loadConfig({ ...o, argv: ['extra'] })).toThrow(/位置参数/);
    expect(() => loadConfig({ ...o, argv: ['--data-dir'] })).toThrow(/缺少值/);
  });

  test('--http-port accepts 0–65535 and rejects others', () => {
    const o = base();
    expect(loadConfig({ ...o, argv: ['--http-port', '0'] }).httpPort).toBe(0);
    expect(loadConfig({ ...o, argv: ['--http-port=8080'] }).httpPort).toBe(8080);
    expect(() => loadConfig({ ...o, argv: ['--http-port', '70000'] })).toThrow();
    expect(() => loadConfig({ ...o, argv: ['--http-port', '8o'] })).toThrow();
  });

  test('--extension-harness-root only in demo mode', () => {
    const o = base();
    expect(() => loadConfig({ ...o, argv: ['--extension-harness-root', '/x'] })).toThrow(/演示模式/);
  });
});

describe('demo mode', () => {
  test('uses a fresh private temp dir and never reads install.json', () => {
    const o = base();
    const tmpBase = mkdtempSync(join(tmpdir(), 'sfe-tmpbase-'));
    const a = loadConfig({ ...o, argv: ['--demo', '--extension-harness-root', '/ext'], env: { TMPDIR: tmpBase } });
    const b = loadConfig({ ...o, argv: ['--demo'], env: { TMPDIR: tmpBase } });
    expect(a.demo).toBe(true);
    expect(a.dataDir.startsWith(join(tmpBase, 'sfe-demo-'))).toBe(true);
    expect(a.dataDir).not.toBe(b.dataDir);
    expect(statSync(a.dataDir).mode & 0o777).toBe(0o700);
    expect(a.extensionHarnessRoot).toBe('/ext');
    // 即使数据目录中有安装配置也不读取
    writeInstall(b.dataDir, { surgeCliPath: '/Applications/Surge.app/Contents/Applications/surge-cli' });
    expect(a.surgeCliPath).toBeNull();
  });

  test('cannot be combined with --data-dir', () => {
    expect(() => loadConfig({ ...base(), argv: ['--demo', '--data-dir', '/x'] })).toThrow();
  });
});

describe('unsafe locations', () => {
  test('refuses a data dir inside a git work tree', () => {
    const o = base();
    const repo = join(o.homedir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(() => loadConfig({ ...o, argv: ['--data-dir', join(repo, 'data')] })).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
  });

  test('refuses synced and protected data dirs', () => {
    const o = base();
    expect(() => loadConfig({ ...o, argv: ['--data-dir', join(o.homedir, 'Library', 'Mobile Documents', 'x')] })).toThrow(/同步/);
    expect(() => loadConfig({ ...o, argv: ['--data-dir', join(o.homedir, 'Documents', 'x')] })).toThrow(/受保护/);
  });

  test('refuses data dirs whose socket paths exceed 103 bytes', () => {
    const o = base();
    const long = join('/tmp', 'x'.repeat(90));
    expect(() => loadConfig({ ...o, argv: ['--data-dir', long] })).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
  });
});

describe('install.json', () => {
  const dataDirOf = (o: LoadConfigOptions) => join(o.homedir, 'data');

  test('reads Surge CLI, keychain helper, node pin, mechanisms, bridge and http port from a 0600 file', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, {
      surgeCliPath: '/Applications/Surge.app/Contents/Applications/surge-cli',
      keychainHelperPath: '/Applications/SafariProfileSurge.app/Contents/MacOS/sfe-keychain',
      nodeVersionPin: 'v22.22.0',
      adapterMechanism: { selectGroupPolicy: 'http', updateExternalResource: 'cli', reloadProfile: 'cli', bogus: 'cli', listRules: 'shell' },
      bridge: { transport: 'tcp', port: 61900 },
      httpPort: 61999,
      webRoot: '/Applications/SafariProfileSurge.app/Contents/Resources/web',
    });
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.surgeCliPath).toBe('/Applications/Surge.app/Contents/Applications/surge-cli');
    expect(c.keychainHelperPath).toBe('/Applications/SafariProfileSurge.app/Contents/MacOS/sfe-keychain');
    expect(c.nodeVersionPin).toBe('v22.22.0');
    expect(c.adapterMechanism.selectGroupPolicy).toBe('http');
    expect(c.adapterMechanism.updateExternalResource).toBe('cli');
    expect(c.adapterMechanism.reloadProfile).toBe('cli');
    expect(c.adapterMechanism.listRules).toBe('unavailable');
    expect(c.adapterMechanism.getVersion).toBe('unavailable');
    expect(c.bridge).toEqual({ transport: 'tcp', host: '127.0.0.1', port: 61900, tokenFile: join(dataDir, 'bridge.token') });
    expect(c.httpPort).toBe(61999);
    expect(c.webRoot).toBe('/Applications/SafariProfileSurge.app/Contents/Resources/web');
    expect(c.installConfigIssues).toHaveLength(2);
  });

  test('--http-port and --web-root take precedence over install.json', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, { httpPort: 61999, webRoot: '/a' });
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir, '--http-port', '1234', '--web-root', '/b'] });
    expect(c.httpPort).toBe(1234);
    expect(c.webRoot).toBe('/b');
  });

  test('ignores install.json that is group/world readable', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, { surgeCliPath: '/Applications/Surge.app/Contents/Applications/surge-cli' }, 0o644);
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.surgeCliPath).toBeNull();
    expect(c.installConfigIssues).toEqual(['安装配置权限不是 0600，已忽略']);
  });

  test('ignores a symlinked install.json', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    const real = writeInstall(join(o.homedir, 'elsewhere'), { surgeCliPath: '/x/surge-cli' });
    mkdirSync(dataDir, { recursive: true });
    symlinkSync(real, join(dataDir, 'install.json'));
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.surgeCliPath).toBeNull();
    expect(c.installConfigIssues[0]).toMatch(/符号链接/);
  });

  test.skipIf(!isRoot)('ignores install.json owned by another user', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    const p = writeInstall(dataDir, { surgeCliPath: '/x/surge-cli' });
    chownSync(p, 4242, 4242);
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.surgeCliPath).toBeNull();
    expect(c.installConfigIssues).toEqual(['安装配置不属于当前用户，已忽略']);
  });

  test('ignores a directory, invalid JSON and non-object JSON', () => {
    const o = base();
    const d1 = join(o.homedir, 'd1');
    mkdirSync(join(d1, 'install.json'), { recursive: true });
    expect(readInstallConfig(join(d1, 'install.json')).issues[0]).toMatch(/普通文件/);
    const d2 = join(o.homedir, 'd2');
    expect(readInstallConfig(writeInstall(d2, '{nope')).issues).toEqual(['安装配置不是有效的 JSON，已忽略']);
    const d3 = join(o.homedir, 'd3');
    expect(readInstallConfig(writeInstall(d3, '[1,2]')).issues).toEqual(['安装配置格式不正确，已忽略']);
  });

  test('ignores relative paths and malformed fields individually', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, { surgeCliPath: 'surge-cli', keychainHelperPath: '/ok/helper', nodeVersionPin: '22', httpPort: 'x', bridge: { transport: 'pipe' } });
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.surgeCliPath).toBeNull();
    expect(c.keychainHelperPath).toBe('/ok/helper');
    expect(c.nodeVersionPin).toBeNull();
    expect(c.httpPort).toBe(61847);
    expect(c.bridge.transport).toBe('tcp');
    expect(c.installConfigIssues).toHaveLength(4);
  });

  test('unix bridge transport with a valid path', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, { bridge: { transport: 'unix', path: '/tmp/group.example/bridge.sock' } });
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDir] });
    expect(c.bridge).toEqual({ transport: 'unix', path: '/tmp/group.example/bridge.sock', tokenFile: join(dataDir, 'bridge.token') });
  });

  test('unix bridge path longer than 103 bytes is refused', () => {
    const o = base();
    const dataDir = dataDirOf(o);
    writeInstall(dataDir, { bridge: { transport: 'unix', path: `/tmp/${'g'.repeat(120)}/bridge.sock` } });
    expect(() => loadConfig({ ...o, argv: ['--data-dir', dataDir] })).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
  });

  test('missing install.json is not an issue', () => {
    const o = base();
    const c = loadConfig({ ...o, argv: ['--data-dir', dataDirOf(o)] });
    expect(c.installConfigIssues).toEqual([]);
    expect(existsSync(c.dataDir)).toBe(false);
  });
});
