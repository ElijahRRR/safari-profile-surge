import { describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/sfe.js';
import { COMMANDS, findCommand } from '../../src/cli/commands.js';
import { apiError, fakeCli } from './helpers.js';

const accepted = { operation_id: 'op_01', environment_id: 'env_01', revision: 2, duplicate: false };

const needsConfirmation = apiError('NEEDS_CONFIRMATION', '切换失败：需要确认旧窗口的处理方式', {
  details: {
    reason: 'other_environment_active',
    currentEnvironmentId: 'env_cur',
    currentEnvironmentLabel: 'US-Buyer-01 · E0001',
    otherProfilesOpen: [{ profileIdShort: 'ABCDEF12', environmentLabel: 'US-Buyer-02 · E0002' }],
    options: ['closed_confirmed', 'keep_open_acknowledged'],
    limitation: '首请求与旧连接能力尚未通过实测：建议保存工作后退出并重开 Safari',
  },
});

describe('general', () => {
  test('help → 0 and lists commands', async () => {
    const cli = fakeCli({ argv: ['help'] });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.stdout()).toContain('sfe env open');
    expect(cli.stdout()).toContain('退出码：0 成功，1 失败，2 用法错误，3 需要确认');
  });

  test('no command → 2', async () => {
    expect(await runCli(fakeCli({ argv: [] }).deps)).toBe(2);
  });

  test('unknown command → 2', async () => {
    const cli = fakeCli({ argv: ['frobnicate'] });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.stderr()).toContain('未知命令');
  });

  test('wrong positional count → 2', async () => {
    expect(await runCli(fakeCli({ argv: ['env', 'show'] }).deps)).toBe(2);
    expect(await runCli(fakeCli({ argv: ['status', 'extra'] }).deps)).toBe(2);
  });

  test('flags not declared for a command → 2', async () => {
    const cli = fakeCli({ argv: ['status', '--commit'] });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
  });

  test('every command path is unique', () => {
    const keys = COMMANDS.map((c) => c.path.join(' '));
    expect(new Set(keys).size).toBe(keys.length);
    expect(findCommand(['env', 'open', 'x'])?.def.path).toEqual(['env', 'open']);
  });

  test('connection failure → 1 with a Chinese message', async () => {
    const cli = fakeCli({
      argv: ['status'],
      request: async () => {
        throw Object.assign(new Error('connect'), { kind: 'connect', errno: 'ENOENT' });
      },
    });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('连接本机服务失败：服务未运行');
  });

  test('service error → 1, formatted message with field errors', async () => {
    const cli = fakeCli({
      argv: ['env', 'create'],
      stdin: '{"displayName":"US-Buyer-01"}',
      responses: { createEnvironment: apiError('VALIDATION_FAILED', '保存失败：输入有误', { fieldErrors: [{ field: 'proxy.port', message: '端口必须是 1–65535 的整数' }] }) },
    });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('保存失败：输入有误');
    expect(cli.stderr()).toContain('proxy.port：端口必须是 1–65535 的整数');
    expect(cli.stderr()).toContain('VALIDATION_FAILED');
  });

  test('--json prints the raw error object on stdout', async () => {
    const cli = fakeCli({ argv: ['env', 'show', 'env_x', '--json'], responses: { getEnvironment: apiError('NOT_FOUND', '读取失败：环境不存在') } });
    expect(await runCli(cli.deps)).toBe(1);
    expect(JSON.parse(cli.stdout())).toEqual({ error: { code: 'NOT_FOUND', message: '读取失败：环境不存在' } });
  });

  test('malformed service response → 1', async () => {
    const cli = fakeCli({ argv: ['status'], request: async () => ({ hello: 'world' }) });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('读取应答失败');
  });

  test('terminal escape sequences from the service are neutralised', async () => {
    const cli = fakeCli({
      argv: ['env', 'list'],
      responses: { listEnvironments: [{ id: 'env_1', code: 'E0001', displayName: 'evil\u001b[2J\u001b]0;pwn\u0007', site: 'US', binding: { state: 'bound' }, readiness: 'ready', proxy: {}, probes: {} }] },
    });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.stdout()).not.toContain('\u001b');
    expect(cli.stdout()).not.toContain('\u0007');
  });
});

describe('status and listing', () => {
  test('sfe status → op status on agent.sock', async () => {
    const cli = fakeCli({
      argv: ['status'],
      responses: {
        status: {
          serviceVersion: '0.1.0',
          demoMode: true,
          environments: [],
          route: { entryMode: 'NORMAL', phase: 'idle', activeEnvironmentId: null, selectedNode: 'REJECT', warnings: ['takeover_unknown'] },
          surge: { reachable: true, version: '6.5.0', build: '10960', currentProfileName: '日常-Safari环境' },
          pendingOperations: [],
        },
      },
    });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toEqual({ v: 1, op: 'status', args: {} });
    expect(cli.stdout()).toContain('普通模式');
    expect(cli.stdout()).toContain('演示模式');
    expect(cli.stdout()).toContain('接管状态无法读取');
  });

  test('--json prints raw data', async () => {
    const cli = fakeCli({ argv: ['env', 'list', '--json'], responses: { listEnvironments: [{ id: 'env_1' }] } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual([{ id: 'env_1' }]);
  });

  test('env show sends the id', async () => {
    const cli = fakeCli({ argv: ['env', 'show', 'env_1'], responses: { getEnvironment: { id: 'env_1', code: 'E0001', displayName: 'US-Buyer-01', site: 'US', account: { loginIdentifierMasked: 'b*****1@example.test' } } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope.args).toEqual({ id: 'env_1' });
    expect(cli.stdout()).toContain('b*****1@example.test');
  });

  test('capability list, front list', async () => {
    const a = fakeCli({ argv: ['capability', 'list'], responses: { listCapabilities: [{ key: 'native_bridge_ipc', label: 'x', status: 'unverified', effectiveStatus: 'unverified', staleReasons: [] }] } });
    expect(await runCli(a.deps)).toBe(0);
    expect(a.stdout()).toContain('扩展与本机服务通信');
    const f = fakeCli({ argv: ['front', 'list'], responses: { listFrontProxies: [] } });
    expect(await runCli(f.deps)).toBe(0);
    expect(f.stdout()).toContain('还没有登记前置代理');
  });
});

describe('stdin-driven commands', () => {
  test('env create wraps stdin EnvironmentInput with a generated request_id', async () => {
    const input = { displayName: 'US-Buyer-01', site: 'US', proxy: { protocol: 'socks5', host: '203.0.113.10', port: 1080, frontProxyId: null, password: { action: 'replace', value: 'synthetic-pw' } } };
    const cli = fakeCli({ argv: ['env', 'create'], stdin: JSON.stringify(input), responses: { createEnvironment: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toEqual({ v: 1, op: 'createEnvironment', args: { request_id: 'cli-test-1', environment: input } });
    expect(cli.stdout()).toContain('已受理：操作 op_01');
    expect(cli.stdout()).toContain('sfe op op_01 --wait');
    expect(cli.stdout()).not.toContain('synthetic-pw');
  });

  test('invalid stdin JSON → 2 without echoing the input', async () => {
    const cli = fakeCli({ argv: ['env', 'create'], stdin: 'password: SYNTHETIC-PW-42' });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.stderr()).toContain('标准输入不是有效的 JSON');
    expect(cli.stderr()).not.toContain('SYNTHETIC-PW-42');
    expect(cli.requests).toHaveLength(0);
  });

  test('stdin must be an object', async () => {
    const cli = fakeCli({ argv: ['env', 'create'], stdin: '[1]' });
    expect(await runCli(cli.deps)).toBe(2);
  });

  test('env update sends id, expected_revision and changes', async () => {
    const cli = fakeCli({ argv: ['env', 'update', 'env_1'], stdin: JSON.stringify({ expected_revision: 4, changes: { displayName: 'US-Buyer-01b' } }), responses: { updateEnvironment: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope.args).toEqual({ id: 'env_1', request_id: 'cli-test-1', expected_revision: 4, changes: { displayName: 'US-Buyer-01b' } });
  });

  test('env update without expected_revision → 2', async () => {
    const cli = fakeCli({ argv: ['env', 'update', 'env_1'], stdin: JSON.stringify({ changes: {} }) });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
  });

  test('capability propose adds request_id', async () => {
    const cli = fakeCli({ argv: ['capability', 'propose'], stdin: JSON.stringify({ key: 'native_bridge_ipc', proposed_status: 'supported' }), responses: { proposeCapability: { proposal_id: 'prop_1' } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope.args).toEqual({ key: 'native_bridge_ipc', proposed_status: 'supported', request_id: 'cli-test-1' });
    expect(cli.stdout()).toContain('需要在网页后台确认后才生效');
  });

  test('a stdin request_id is replaced by the CLI one', async () => {
    const cli = fakeCli({ argv: ['admin', 'settings', 'set'], stdin: JSON.stringify({ request_id: 'mine', probeTtlSec: 600 }), responses: { updateSettings: { verifyEndpointId: 'ipify', safariProcessPaths: [] } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toMatchObject({ op: 'updateSettings', args: { probeTtlSec: 600, request_id: 'cli-test-1' } });
    expect(cli.requests[0]!.socketPath).toMatch(/maintenance\.sock$/);
  });
});

describe('channel selection', () => {
  test('env delete on the agent channel is refused locally', async () => {
    const cli = fakeCli({ argv: ['env', 'delete', 'env_1', '--revision', '3'] });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.requests).toHaveLength(0);
    expect(cli.stderr()).toContain('该命令不允许在此通道使用');
    expect(cli.stderr()).toContain('sfe admin');
  });

  test('sfe admin env delete uses maintenance.sock', async () => {
    const cli = fakeCli({ argv: ['admin', 'env', 'delete', 'env_1', '--revision', '3'], responses: { deleteEnvironment: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.socketPath).toMatch(/maintenance\.sock$/);
    expect(cli.requests[0]!.envelope.args).toEqual({ id: 'env_1', request_id: 'cli-test-1', expected_revision: 3 });
  });

  test('env delete requires --revision', async () => {
    expect(await runCli(fakeCli({ argv: ['admin', 'env', 'delete', 'env_1'] }).deps)).toBe(2);
    expect(await runCli(fakeCli({ argv: ['admin', 'env', 'delete', 'env_1', '--revision', '0'] }).deps)).toBe(2);
  });

  test('admin-only commands need the admin prefix', async () => {
    for (const argv of [['front', 'add', 'HK-Front'], ['settings', 'get'], ['account', 'env_1']]) {
      const cli = fakeCli({ argv });
      expect(await runCli(cli.deps)).toBe(2);
      expect(cli.requests).toHaveLength(0);
    }
  });

  test('admin front add', async () => {
    const cli = fakeCli({ argv: ['admin', 'front', 'add', 'HK-Front', '--default'], responses: { registerFrontProxy: { id: 'front_1', surgeName: 'HK-Front', isDefault: true } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toEqual({ v: 1, op: 'registerFrontProxy', args: { request_id: 'cli-test-1', surgeName: 'HK-Front', makeDefault: true } });
  });

  test('admin account shows the login identifier from the maintenance channel', async () => {
    const cli = fakeCli({ argv: ['admin', 'account', 'env_1'], responses: { accountDetail: { environment_id: 'env_1', label: 'B01', loginIdentifier: 'buyer01@example.test', hasPassword: true } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.socketPath).toMatch(/maintenance\.sock$/);
    expect(cli.stdout()).toContain('buyer01@example.test');
    expect(cli.stdout()).toContain('已设置');
  });

  test('admin settings get', async () => {
    const cli = fakeCli({ argv: ['admin', 'settings', 'get'], responses: { getSettings: { verifyEndpointId: 'ipify', safariProcessPaths: ['/Applications/Safari.app'], probeTtlSec: 600 } } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.stdout()).toContain('/Applications/Safari.app');
  });
});

describe('routing commands', () => {
  test('env open maps flags to the activate request', async () => {
    const cli = fakeCli({ argv: ['env', 'open', 'env_1', '--old-windows', 'keep', '--confirmed-env', 'env_cur', '--revision', '7'], responses: { activate: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toEqual({
      v: 1,
      op: 'activate',
      args: { id: 'env_1', request_id: 'cli-test-1', old_session_policy: 'keep_open_acknowledged', confirmed_environment_id: 'env_cur', proxy_revision: 7 },
    });
  });

  test('--confirmed-env none sends null; omitted sends nothing', async () => {
    const a = fakeCli({ argv: ['env', 'open', 'env_1', '--old-windows', 'closed', '--confirmed-env', 'none'], responses: { activate: accepted } });
    await runCli(a.deps);
    expect(a.requests[0]!.envelope.args).toMatchObject({ old_session_policy: 'closed_confirmed', confirmed_environment_id: null });
    const b = fakeCli({ argv: ['env', 'open', 'env_1'], responses: { activate: accepted } });
    await runCli(b.deps);
    expect(b.requests[0]!.envelope.args).toEqual({ id: 'env_1', request_id: 'cli-test-1' });
  });

  test('bad --old-windows → 2', async () => {
    expect(await runCli(fakeCli({ argv: ['env', 'open', 'env_1', '--old-windows', 'maybe'] }).deps)).toBe(2);
  });

  test('NEEDS_CONFIRMATION → exit 3 with details and exact re-run commands', async () => {
    const cli = fakeCli({ argv: ['env', 'open', 'env_1', '--revision', '7'], responses: { activate: needsConfirmation } });
    expect(await runCli(cli.deps)).toBe(3);
    const out = cli.stdout();
    expect(out).toContain('当前正在使用环境「US-Buyer-01 · E0001」');
    expect(out).toContain('ABCDEF12（US-Buyer-02 · E0002）');
    expect(out).toContain('限制：首请求与旧连接能力尚未通过实测');
    expect(out).toContain('  sfe env open env_1 --revision 7 --old-windows closed --confirmed-env env_cur');
    expect(out).toContain('  sfe env open env_1 --revision 7 --old-windows keep --confirmed-env env_cur');
  });

  test('NEEDS_CONFIRMATION with no current environment suggests --confirmed-env none', async () => {
    const cli = fakeCli({
      argv: ['env', 'open', 'env_1'],
      responses: { activate: apiError('NEEDS_CONFIRMATION', '切换失败：需要确认', { details: { reason: 'other_profiles_open', currentEnvironmentId: null, otherProfilesOpen: [], options: ['closed_confirmed'] } }) },
    });
    expect(await runCli(cli.deps)).toBe(3);
    expect(cli.stdout()).toContain('sfe env open env_1 --old-windows closed --confirmed-env none');
    expect(cli.stdout()).not.toContain('--old-windows keep');
  });

  test('NEEDS_CONFIRMATION via sfe admin keeps the admin prefix in hints', async () => {
    const cli = fakeCli({ argv: ['admin', 'normal'], responses: { normal: needsConfirmation } });
    expect(await runCli(cli.deps)).toBe(3);
    expect(cli.stdout()).toContain('sfe admin normal --old-windows closed --confirmed-env env_cur');
  });

  test('NEEDS_CONFIRMATION with --json → error JSON and exit 3', async () => {
    const cli = fakeCli({ argv: ['normal', '--json'], responses: { normal: needsConfirmation } });
    expect(await runCli(cli.deps)).toBe(3);
    expect(JSON.parse(cli.stdout()).error.code).toBe('NEEDS_CONFIRMATION');
  });

  test('sfe normal sends the policy', async () => {
    const cli = fakeCli({ argv: ['normal', '--old-windows', 'closed', '--confirmed-env', 'env_cur'], responses: { normal: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope).toEqual({ v: 1, op: 'normal', args: { request_id: 'cli-test-1', old_session_policy: 'closed_confirmed', confirmed_environment_id: 'env_cur' } });
  });

  test('probe requires --kind preflight|safari', async () => {
    expect(await runCli(fakeCli({ argv: ['probe', 'env_1'] }).deps)).toBe(2);
    expect(await runCli(fakeCli({ argv: ['probe', 'env_1', '--kind', 'chrome'] }).deps)).toBe(2);
    const cli = fakeCli({ argv: ['probe', 'env_1', '--kind', 'safari'], responses: { probe: accepted } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope.args).toEqual({ id: 'env_1', request_id: 'cli-test-1', kind: 'safari' });
  });

  test('publish with and without --env', async () => {
    const all = fakeCli({ argv: ['publish'], responses: { publishPending: accepted } });
    await runCli(all.deps);
    expect(all.requests[0]!.envelope.args).toEqual({ request_id: 'cli-test-1' });
    const some = fakeCli({ argv: ['publish', '--env', 'env_1', '--env', 'env_2'], responses: { publishPending: accepted } });
    await runCli(some.deps);
    expect(some.requests[0]!.envelope.args).toEqual({ request_id: 'cli-test-1', environment_ids: ['env_1', 'env_2'] });
  });

  test('ids with odd characters are rejected before sending', async () => {
    const cli = fakeCli({ argv: ['env', 'open', 'env 1;rm'] });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
  });
});

describe('sfe op', () => {
  const op = (status: string, phase: string) => ({ id: 'op_1', kind: 'route.activate', status, phase, steps: [], environmentId: 'env_1', error: null, updatedAt: '2026-10-21T08:00:00Z' });

  test('without --wait prints once', async () => {
    const cli = fakeCli({ argv: ['op', 'op_1'], responses: { getOperation: op('running', 'SAFARI_BLOCKED') } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.stdout()).toContain('Safari 已阻断');
  });

  test('--wait polls until the operation leaves queued/running', async () => {
    const seq = [op('queued', 'SAVED'), op('running', 'SAFARI_BLOCKED'), op('running', 'SAFARI_BLOCKED'), op('waiting', 'VERIFY_ONLY')];
    let i = 0;
    const cli = fakeCli({ argv: ['op', 'op_1', '--wait'], responses: { getOperation: () => seq[Math.min(i++, seq.length - 1)] } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests).toHaveLength(4);
    expect(cli.sleeps).toEqual([1000, 1000, 1000]);
    expect(cli.stdout()).toContain('等待 Safari 实测');
    // 相同阶段只打印一次进度
    expect(cli.stdout().split('Safari 已阻断（执行中）').length).toBe(2);
  });

  test('failed operation → exit 1', async () => {
    const cli = fakeCli({ argv: ['op', 'op_1', '--wait'], responses: { getOperation: { ...op('failed', 'FAILED'), error: { code: 'PREFLIGHT_FAILED', message: '预检失败：前置不可达' } } } });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stdout()).toContain('预检失败：前置不可达');
  });

  test('--wait gives up after --timeout', async () => {
    let now = 0;
    const cli = fakeCli({
      argv: ['op', 'op_1', '--wait', '--timeout', '3'],
      responses: { getOperation: op('running', 'DEPLOYING') },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('等待操作超时');
  });

  test('--timeout without --wait → 2', async () => {
    expect(await runCli(fakeCli({ argv: ['op', 'op_1', '--timeout', '3'], responses: { getOperation: op('running', 'DEPLOYING') } }).deps)).toBe(2);
  });
});
