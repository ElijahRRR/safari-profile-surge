// 组装根（main.ts）停止服务时，本机资源服务（D10）最后关闭：执行器已停止（进行中的发布或回滚已结束）、数据库仍可写
// （下载记录要持久保存）。只用合成数据，不开真实的资源监听。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startService, type RunningService } from '../../src/main.js';
import type { ResourceHost } from '../../src/resource/index.js';

let svc: RunningService | null = null;
const cleanup: string[] = [];

afterEach(async () => {
  await svc?.stop();
  svc = null;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('startService stop order (D10)', () => {
  test('closes the resource host last: after the executor stopped, before the database closes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sfe-home-'));
    cleanup.push(home);
    svc = await startService({ argv: ['--data-dir', join(home, 'data'), '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: false });
    const running = svc;
    const seen: Array<{ executorRunning: boolean; dbWritable: boolean }> = [];
    const stub = {
      close: async () => {
        let dbWritable = true;
        try {
          running.app.engine.kv.set('test:resource_close', 1);
        } catch {
          dbWritable = false;
        }
        seen.push({ executorRunning: running.app.executor.running, dbWritable });
      },
    } as unknown as ResourceHost;
    running.app.engine.resource = stub;
    await running.stop();
    svc = null;
    expect(seen).toEqual([{ executorRunning: false, dbWritable: true }]);
  });

  test('stops normally when the resource host was never created', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sfe-home-'));
    cleanup.push(home);
    svc = await startService({ argv: ['--data-dir', join(home, 'data'), '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: false });
    svc.app.engine.resource = null;
    await expect(svc.stop()).resolves.toBeUndefined();
    svc = null;
  });
});
