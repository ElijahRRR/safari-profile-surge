// 组装根（main.ts）：演示模式完整启动（FakeSurge、合成数据、HTTP、agent/maintenance 套接字），
// 以及非演示模式在没有 Surge 工具时也能启动且不宣称任何能力。停止服务从不写 Surge。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { ROUTE_GROUP_NAME } from '@sfe/contract';
import type { Actor } from '../../src/app.js';
import { DEMO_CAPABILITY_NOTE, DEMO_PROFILES } from '../../src/demo/index.js';
import { startService, type RunningService } from '../../src/main.js';
import type { FakeSurge } from '../../src/surge/fake.js';
import { entryWrites } from '../engine/harness.js';

const WEB: Actor = { kind: 'web', sessionId: 'web_e2e00001' };
let svc: RunningService | null = null;
const cleanup: string[] = [];

afterEach(async () => {
  await svc?.stop();
  svc = null;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

function adminRequest(path: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify(body)}\n`));
    sock.on('data', (d) => (buf += d.toString('utf8')));
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
  });
}

const WRITES = ['updateExternalResource', 'selectGroupPolicy', 'addTempRule', 'removeTempRule', 'killRequest', 'reloadProfile'];

describe('startService --demo', () => {
  test('seeds synthetic data through the real flows; HTTP, sockets and demo flags are wired', async () => {
    const tmp = tempDir('sfe-e2e-');
    const home = tempDir('sfe-home-');
    svc = await startService({ argv: ['--demo', '--http-port', '0'], env: { TMPDIR: tmp }, platform: process.platform, homedir: home, cwd: tmp });
    cleanup.push(svc.config.dataDir);
    expect(svc.config.demo).toBe(true);
    expect(svc.config.dataDir.startsWith(tmp)).toBe(true);
    expect(svc.bridge).toBeNull();

    const snap = await svc.app.snapshot(WEB);
    expect(snap.demoMode).toBe(true);
    const byName = new Map(snap.environments.map((e) => [e.displayName, e]));
    expect(snap.environments).toHaveLength(4);
    const active = snap.environments.find((e) => e.id === snap.route.activeEnvironmentId);
    expect(active).toBeDefined();
    expect(snap.route.phase).toBe('active_verified');
    expect(snap.route.entryMode).toBe('ACTIVE');
    expect([...byName.values()].filter((e) => e.binding === null || e.facets.binding === 'unbound').length).toBeGreaterThanOrEqual(1);
    expect(snap.environments.some((e) => e.facets.preflight === 'failed')).toBe(true);
    // 演示能力只在 demo/ 中写入，带明确说明
    const caps = await svc.app.listCapabilities();
    expect(caps.every((c) => c.note === DEMO_CAPABILITY_NOTE)).toBe(true);
    // 演示模式的版本来自 FakeSurge 模拟的运行实例，并与 FakeSurge 的 `surge-cli version` 交叉核对（不读真实 Surge）：
    // 依赖版本的演示能力有效
    expect(snap.surge).toMatchObject({ reachable: true, version: '6.10.0', build: '12500', message: null });
    expect(caps.every((c) => c.effectiveStatus === 'supported')).toBe(true);
    const demoFake = svc.app.engine.surge as FakeSurge;
    expect(demoFake.instanceReads).toBeGreaterThan(0);
    expect(demoFake.calls.getVersion ?? 0).toBeGreaterThan(0);
    expect(svc.app.engine.facts.controllerProtocol).toBe(demoFake.controllerProtocol);
    // 演示发布从不调用外部资源更新：演示 FakeSurge 监视本地 policy-path 文件（演示专用的假设）
    expect(demoFake.calls.updateExternalResource ?? 0).toBe(0);
    expect(demoFake.watcherReloads.length).toBeGreaterThan(0);

    // HTTP：未登录的接口请求被拒绝（服务在线）
    const res = await fetch(`${svc.url}/api/snapshot`);
    expect(res.status).toBe(401);
    await res.arrayBuffer();

    // agent / maintenance 套接字（0600）
    expect(statSync(svc.config.agentSocketPath).isSocket()).toBe(true);
    const status = await adminRequest(svc.config.agentSocketPath, { v: 1, op: 'status', args: {} });
    expect(status.ok).toBe(true);
    const forbidden = await adminRequest(svc.config.agentSocketPath, { v: 1, op: 'deleteEnvironment', args: {} });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error?.code).toBe('BAD_REQUEST');

    // 原生消息（演示场景编号）：已绑定场景可以读到自己的状态
    const state = await svc.app.handleNative({ v: 1, bridge: { profileId: DEMO_PROFILES.active, bridgeVersion: 'demo' }, message: { type: 'getCurrentState' } });
    expect(state.ok).toBe(true);

    // 停止：从不写 Surge（入口与选择保持）。入口规则集的写入是文件写入加文件监视（不经适配器写原语），一并核对
    const fake = svc.app.engine.surge as FakeSurge;
    const before = WRITES.map((k) => fake.calls[k] ?? 0);
    const entryBefore = entryWrites(fake);
    const selection = await fake.getGroupSelection(ROUTE_GROUP_NAME);
    const entryMode = (await svc.app.engine.entryController(() => null)!.read()).mode;
    await svc.stop();
    expect(WRITES.map((k) => fake.calls[k] ?? 0)).toEqual(before);
    expect(entryWrites(fake)).toEqual(entryBefore);
    expect(await fake.getGroupSelection(ROUTE_GROUP_NAME)).toBe(selection);
    expect(entryMode).toBe('ACTIVE');
    svc = null;
    // 演示经真实流程发布并激活（等待按演示 FakeSurge 的监视延迟轮询）：明确的时限，不靠 vitest 的 5 秒缺省值
  }, 20_000);

  test('`main.ts --demo` as its own process prints the startup line and keeps running (startup waits must not drain the event loop)', async () => {
    // 套接字路径上限 103 字节：用短的临时目录
    const tmp = mkdtempSync(join('/tmp', 'sfe-d-'));
    cleanup.push(tmp);
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'service', 'src', 'main.ts'), '--demo', '--http-port', '0'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', TMPDIR: tmp, HOME: tmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let exited: number | null | undefined;
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('exit', (code) => (exited = code));
    try {
      const end = Date.now() + 45_000;
      while (!out.includes('演示模式：本机管理服务已启动') && exited === undefined && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(exited, out).toBeUndefined();
      expect(out).toMatch(/演示模式：本机管理服务已启动 http:\/\/127\.0\.0\.1:\d+/);
      // 启动之后仍在运行（监听维持事件循环）
      await new Promise((r) => setTimeout(r, 300));
      expect(exited).toBeUndefined();
    } finally {
      if (exited === undefined) {
        const done = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await done;
      }
    }
  }, 60_000);
});

describe('startService (production wiring, no Surge tools installed)', () => {
  test('starts, reports Surge unreachable and claims no capability', async () => {
    const home = tempDir('sfe-home-');
    const dataDir = join(home, 'data');
    svc = await startService({ argv: ['--data-dir', dataDir, '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: false });
    const snap = await svc.app.snapshot(WEB);
    expect(snap.demoMode).toBe(false);
    expect(snap.environments).toEqual([]);
    expect(snap.surge.reachable).toBe(false);
    expect(snap.surge).toMatchObject({ version: null, build: null });
    const caps = await svc.app.listCapabilities();
    expect(caps.some((c) => c.effectiveStatus === 'supported')).toBe(false);
    expect((statSync(join(dataDir, 'sfe.sqlite')).mode & 0o077) === 0).toBe(true);
  });

  test('refuses a data directory inside a Git work tree', async () => {
    const home = tempDir('sfe-home-');
    await expect(
      startService({ argv: ['--data-dir', join(process.cwd(), 'service', '.sfe-data-test'), '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: false }),
    ).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
  });
});
