// CLI 与真实的 agent/maintenance 套接字服务端对接（AppService 为桩）：验证线上编码、角色与退出码。

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { createAdminServer, type AdminServerHandle } from '../../src/ipc/admin-server.js';
import { ndjsonRequest } from '../../src/ipc/ndjson.js';
import { runCli } from '../../src/cli/sfe.js';
import { createStubApp } from '../support/stub-app.js';
import { recordingLogger } from '../http/helpers.js';
import { privateDir } from '../ipc/helpers.js';
import { fakeCli } from './helpers.js';

const servers: AdminServerHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup() {
  const dir = privateDir();
  const app = createStubApp();
  const agent = createAdminServer({ app, path: join(dir, 'agent.sock'), role: 'agent', logger: recordingLogger() });
  const maintenance = createAdminServer({ app, path: join(dir, 'maintenance.sock'), role: 'maintenance', logger: recordingLogger() });
  await agent.listen();
  await maintenance.listen();
  servers.push(agent, maintenance);
  const request = (socketPath: string, envelope: unknown) => ndjsonRequest({ path: socketPath }, envelope, { maxResponseBytes: 1 << 20, timeoutMs: 5000 });
  return { dir, app, request };
}

describe('sfe against real sockets', () => {
  test('env list over agent.sock with actor agent', async () => {
    const { dir, app, request } = await setup();
    app.respond('listEnvironments', []);
    const cli = fakeCli({ argv: ['env', 'list', '--data-dir', dir], request });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.stdout()).toContain('还没有环境');
    expect(app.callsTo('listEnvironments')[0]!.args[0]).toEqual({ kind: 'agent' });
  });

  test('sfe admin uses actor admin', async () => {
    const { dir, app, request } = await setup();
    app.respond('getSettings', { verifyEndpointId: 'ipify', safariProcessPaths: [] });
    const cli = fakeCli({ argv: ['admin', 'settings', 'get', '--data-dir', dir], request });
    expect(await runCli(cli.deps)).toBe(0);
    expect(app.callsTo('getSettings')).toHaveLength(1);
  });

  test('NEEDS_CONFIRMATION from the service → exit 3', async () => {
    const { dir, app, request } = await setup();
    app.throwOn('activate', new SfeError('NEEDS_CONFIRMATION', '切换失败：需要确认旧窗口的处理方式', { details: { reason: 'other_environment_active', currentEnvironmentId: 'env_cur', currentEnvironmentLabel: 'US-Buyer-01 · E0001', otherProfilesOpen: [], options: ['closed_confirmed', 'keep_open_acknowledged'], limitation: null } }));
    const cli = fakeCli({ argv: ['env', 'open', 'env_1', '--data-dir', dir], request });
    expect(await runCli(cli.deps)).toBe(3);
    expect(cli.stdout()).toContain('sfe env open env_1 --old-windows closed --confirmed-env env_cur');
  });

  test('a stdin secret reaches the service but never stdout/stderr', async () => {
    const { dir, app, request } = await setup();
    const input = { displayName: 'US-Buyer-01', site: 'US', proxy: { protocol: 'socks5', host: '192.0.2.10', port: 1080, frontProxyId: null, password: { action: 'replace', value: 'CANARY-proxy-pw-1' } } };
    const cli = fakeCli({ argv: ['env', 'create', '--data-dir', dir], stdin: JSON.stringify(input), request });
    expect(await runCli(cli.deps)).toBe(0);
    expect((app.callsTo('createEnvironment')[0]!.args[0] as { environment: unknown }).environment).toEqual(input);
    expect(cli.stdout() + cli.stderr()).not.toContain('CANARY');
  });

  test('service not running → exit 1', async () => {
    const dir = privateDir();
    const request = (socketPath: string, envelope: unknown) => ndjsonRequest({ path: socketPath }, envelope, { maxResponseBytes: 1 << 20, timeoutMs: 5000 });
    const cli = fakeCli({ argv: ['status', '--data-dir', dir], request });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.stderr()).toContain('服务未运行');
  });
});
