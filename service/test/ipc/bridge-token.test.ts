// 原生桥令牌文件：服务运行期间宿主 App 改写 <数据目录>/bridge.token 后，下一个连接就用新令牌（不需要重启服务），
// 每次都重新做与启动时相同的安全检查。

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createBridgeTokenSource, readBridgeTokenFile } from '../../src/ipc/bridge-token.js';
import { startService, type RunningService } from '../../src/main.js';
import { bridgeCall, privateDir } from './helpers.js';

const TOKEN_A = 'bridge-token-synthetic-AAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'bridge-token-synthetic-BBBBBBBBBBBBBBBBBBBB';
const PAYLOAD = JSON.stringify({ bridge: { profileId: null, bridgeVersion: '0.1.0+1' }, message: { type: 'getCurrentState' } });

const cleanup: string[] = [];
let svc: RunningService | null = null;
afterEach(async () => {
  await svc?.stop();
  svc = null;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = privateDir();
  cleanup.push(d);
  return d;
}

/** 与宿主 App 的 SecureFile.writeAtomically 相同：0600 临时文件 + rename（新 inode）。 */
function replaceAtomically(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

describe('readBridgeTokenFile', () => {
  test('reads a 0600 file, reports missing and empty files', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    expect(readBridgeTokenFile(path)).toEqual({ kind: 'missing' });
    writeFileSync(path, '\n', { mode: 0o600 });
    expect(readBridgeTokenFile(path)).toEqual({ kind: 'invalid' });
    replaceAtomically(path, `${TOKEN_A}\n`);
    expect(readBridgeTokenFile(path)).toEqual({ kind: 'ok', token: TOKEN_A });
  });

  test('refuses a group/other-readable file or a symlink', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    writeFileSync(path, TOKEN_A, { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => readBridgeTokenFile(path)).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
    const target = join(d, 'elsewhere');
    writeFileSync(target, TOKEN_A, { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);
    expect(() => readBridgeTokenFile(path)).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
  });
});

describe('createBridgeTokenSource', () => {
  test('picks up a token rewritten by the host App (atomic replace) on the next call', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    writeFileSync(path, `${TOKEN_A}\n`, { mode: 0o600 });
    const states: string[] = [];
    const token = createBridgeTokenSource(path, { onChange: (s) => states.push(s) });
    expect(token()).toBe(TOKEN_A);
    expect(token()).toBe(TOKEN_A);
    replaceAtomically(path, `${TOKEN_B}\n`);
    expect(token()).toBe(TOKEN_B);
    expect(states).toEqual(['loaded', 'loaded']);
  });

  test('picks up an in-place rewrite (same inode, new mtime)', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    writeFileSync(path, `${TOKEN_A}\n`, { mode: 0o600 });
    const token = createBridgeTokenSource(path);
    expect(token()).toBe(TOKEN_A);
    writeFileSync(path, `${TOKEN_B}\n`);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(token()).toBe(TOKEN_B);
  });

  test('stops accepting (returns "") as soon as the file becomes unsafe, missing or empty, and recovers afterwards', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    writeFileSync(path, `${TOKEN_A}\n`, { mode: 0o600 });
    const states: string[] = [];
    const token = createBridgeTokenSource(path, { onChange: (s) => states.push(s) });
    expect(token()).toBe(TOKEN_A);
    // 只改权限不改内容：缓存不能掩盖不安全的文件
    chmodSync(path, 0o640);
    expect(token()).toBe('');
    expect(token()).toBe('');
    chmodSync(path, 0o600);
    expect(token()).toBe(TOKEN_A);
    unlinkSync(path);
    expect(token()).toBe('');
    writeFileSync(path, '', { mode: 0o600 });
    expect(token()).toBe('');
    const target = join(d, 'elsewhere');
    writeFileSync(target, TOKEN_B, { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);
    expect(token()).toBe('');
    unlinkSync(path);
    replaceAtomically(path, TOKEN_B);
    expect(token()).toBe(TOKEN_B);
    // 同一问题只报告一次
    expect(states).toEqual(['loaded', 'unsafe', 'loaded', 'missing', 'invalid', 'unsafe', 'loaded']);
  });

  test('a directory or FIFO at the path is refused without blocking', () => {
    const d = dir();
    const path = join(d, 'bridge.token');
    mkdirSync(path, { mode: 0o700 });
    expect(createBridgeTokenSource(path)()).toBe('');
    const fifo = join(d, 'fifo.token');
    if (spawnSync('mkfifo', ['-m', '600', fifo]).status === 0) {
      // 没有写端的 FIFO：不加 O_NONBLOCK 时 open 会一直阻塞
      expect(createBridgeTokenSource(fifo)()).toBe('');
      expect(() => readBridgeTokenFile(fifo)).toThrow(expect.objectContaining({ code: 'UNSAFE_LOCATION' }));
    }
  });
});

describe('service wiring', () => {
  test('a running service accepts a token the host App rewrote, without a restart, and stops accepting the old one', async () => {
    const home = dir();
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const sock = join(home, 'b.sock');
    writeFileSync(join(dataDir, 'install.json'), JSON.stringify({ bridge: { transport: 'unix', path: sock } }), { mode: 0o600 });
    writeFileSync(join(dataDir, 'bridge.token'), `${TOKEN_A}\n`, { mode: 0o600 });
    svc = await startService({ argv: ['--data-dir', dataDir, '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: true });

    expect((await bridgeCall({ path: sock }, { token: TOKEN_A, payload: PAYLOAD })).kind).toBe('response');
    replaceAtomically(join(dataDir, 'bridge.token'), `${TOKEN_B}\n`);
    expect((await bridgeCall({ path: sock }, { token: TOKEN_B, payload: PAYLOAD })).kind).toBe('response');
    expect((await bridgeCall({ path: sock }, { token: TOKEN_A, payload: PAYLOAD })).kind).toBe('server_unauthenticated');
  });

  test('without a token file the service creates one (0600) and uses it', async () => {
    const home = dir();
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const sock = join(home, 'b.sock');
    writeFileSync(join(dataDir, 'install.json'), JSON.stringify({ bridge: { transport: 'unix', path: sock } }), { mode: 0o600 });
    svc = await startService({ argv: ['--data-dir', dataDir, '--http-port', '0'], env: {}, platform: process.platform, homedir: home, cwd: home, bridge: true });
    const read = readBridgeTokenFile(join(dataDir, 'bridge.token'));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect((await bridgeCall({ path: sock }, { token: read.token, payload: PAYLOAD })).kind).toBe('response');
  });
});
