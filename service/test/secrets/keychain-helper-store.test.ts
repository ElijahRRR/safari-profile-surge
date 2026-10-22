import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KEYCHAIN_HELPER_ARGS, KeychainHelperStore } from '../../src/secrets/keychain-helper-store.js';

// 假的 sfe-keychain：一个 node 脚本，经 sh 包装成可执行文件。它把收到的 argv、环境变量名与请求
// （含值，只在测试临时目录中）记到 calls.jsonl，按 mode.json 决定行为，用 store.json 模拟钥匙串。
const HELPER_SCRIPT = String.raw`
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const mode = existsSync(join(dir, 'mode.json')) ? JSON.parse(readFileSync(join(dir, 'mode.json'), 'utf8')) : { behavior: 'ok' };
const storePath = join(dir, 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(input.split('\n')[0]);
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env), envValues: Object.values(process.env), req, pid: process.pid }) + '\n');
  const b = mode.behavior;
  if (b === 'hang') { setInterval(() => {}, 1000); return; }
  if (b === 'garbage') { process.stdout.write('not json\n'); return; }
  if (b === 'exit1') { process.exit(1); }
  if (b === 'stderr-leak') { process.stderr.write('debug: value was ' + (req.value ?? '') + '\n'); process.stdout.write(JSON.stringify({ ok: false, reason: 'other' }) + '\n'); return; }
  if (b === 'partial-then-ok') { process.stdout.write('{"ok":'); setTimeout(() => process.stdout.write('true}\n'), 20); return; }
  if (['denied', 'locked', 'acl', 'weird'].includes(b)) { process.stdout.write(JSON.stringify({ ok: false, reason: b }) + '\n'); return; }
  const key = req.kind + ':' + req.ref;
  if (req.op === 'set') {
    if (store[key] !== undefined) { process.stdout.write(JSON.stringify({ ok: false, reason: 'other' }) + '\n'); return; }
    store[key] = req.value; writeFileSync(storePath, JSON.stringify(store));
    process.stdout.write(JSON.stringify({ ok: true }) + '\n'); return;
  }
  if (req.op === 'get') {
    if (req.kind === 'account') { process.stdout.write(JSON.stringify({ ok: false, reason: 'acl' }) + '\n'); return; }
    if (store[key] === undefined) { process.stdout.write(JSON.stringify({ ok: false, reason: 'not_found' }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ ok: true, value: store[key] }) + '\n'); return;
  }
  if (req.op === 'delete') {
    if (store[key] === undefined) { process.stdout.write(JSON.stringify({ ok: false, reason: 'not_found' }) + '\n'); return; }
    delete store[key]; writeFileSync(storePath, JSON.stringify(store));
    process.stdout.write(JSON.stringify({ ok: true }) + '\n'); return;
  }
});
`;

interface Call {
  argv: string[];
  envKeys: string[];
  envValues: string[];
  req: { op: string; ref: string; kind: string; value?: string };
  pid: number;
}

function makeHelper(behavior = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-keychain-'));
  writeFileSync(join(dir, 'helper.mjs'), HELPER_SCRIPT);
  writeFileSync(join(dir, 'mode.json'), JSON.stringify({ behavior }));
  const exe = join(dir, 'sfe-keychain');
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'helper.mjs')}" "$@"\n`);
  chmodSync(exe, 0o700);
  return {
    dir,
    exe,
    setBehavior: (b: string) => writeFileSync(join(dir, 'mode.json'), JSON.stringify({ behavior: b })),
    calls: (): Call[] =>
      existsSync(join(dir, 'calls.jsonl'))
        ? readFileSync(join(dir, 'calls.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Call)
        : [],
  };
}

const VALUE = 'Kc-Secret-Value-42';

describe('KeychainHelperStore', () => {
  test('round-trips a proxy secret; the value travels only via stdin', async () => {
    const h = makeHelper();
    const spawned: Array<{ cmd: string; args: readonly string[]; opts: SpawnOptions }> = [];
    const store = new KeychainHelperStore({
      helperPath: h.exe,
      spawn: (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
        spawned.push({ cmd, args, opts });
        return spawn(cmd, [...args], opts);
      },
    });
    await store.put('sec_01ABC', VALUE, 'proxy');
    expect(await store.get('sec_01ABC')).toBe(VALUE);
    await store.delete('sec_01ABC');
    expect(await store.get('sec_01ABC')).toBeNull();

    expect(spawned.every((s) => s.cmd === h.exe && JSON.stringify(s.args) === JSON.stringify(['--stdin-json']) && s.opts.shell === false)).toBe(true);
    const calls = h.calls();
    expect(calls.map((c) => c.req.op)).toEqual(['set', 'get', 'delete', 'get']);
    for (const c of calls) {
      expect(c.argv).toEqual([...KEYCHAIN_HELPER_ARGS]);
      expect(JSON.stringify(c.argv)).not.toContain(VALUE);
      expect(c.envValues.join('\n')).not.toContain(VALUE);
    }
    expect(calls[0]!.req).toEqual({ op: 'set', ref: 'sec_01ABC', kind: 'proxy', value: VALUE });
    expect(calls[1]!.req).toEqual({ op: 'get', ref: 'sec_01ABC', kind: 'proxy' });
  });

  test('passes only a minimal environment to the helper', async () => {
    const h = makeHelper();
    process.env.SFE_TEST_SHOULD_NOT_LEAK = 'leak-check';
    try {
      await new KeychainHelperStore({ helperPath: h.exe }).put('sec_env', VALUE, 'proxy');
    } finally {
      delete process.env.SFE_TEST_SHOULD_NOT_LEAK;
    }
    const keys = h.calls()[0]!.envKeys;
    expect(keys).not.toContain('SFE_TEST_SHOULD_NOT_LEAK');
  });

  test('get() for account secrets is refused locally without spawning the helper', async () => {
    const h = makeHelper();
    const store = new KeychainHelperStore({ helperPath: h.exe });
    await store.put('sec_acc', VALUE, 'account');
    expect(await store.get('sec_acc')).toBeNull();
    expect(h.calls().map((c) => c.req.op)).toEqual(['set']);
    // 重启后由 kindOf 提供种类
    const restarted = new KeychainHelperStore({ helperPath: h.exe, kindOf: (ref) => (ref === 'sec_acc' ? 'account' : null) });
    expect(await restarted.get('sec_acc')).toBeNull();
    expect(h.calls()).toHaveLength(1);
  });

  test('unknown refs default to proxy kind; sfe.* refs to system kind', async () => {
    const h = makeHelper();
    const store = new KeychainHelperStore({ helperPath: h.exe });
    expect(await store.get('sec_unknown')).toBeNull();
    expect(await store.get('sfe.pepper')).toBeNull();
    expect(h.calls().map((c) => c.req.kind)).toEqual(['proxy', 'system']);
  });

  test.each(['denied', 'locked', 'acl'] as const)('maps %s to SECRET_STORE_FAILED without the value', async (reason) => {
    const h = makeHelper(reason);
    const store = new KeychainHelperStore({ helperPath: h.exe });
    const err = (await store.put('sec_x', VALUE, 'proxy').catch((e: unknown) => e)) as { code: string; message: string; details: unknown };
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason } });
    expect(err.message.startsWith('写入钥匙串失败：')).toBe(true);
    expect(JSON.stringify([err.message, err.details])).not.toContain(VALUE);
    const getErr = await store.get('sec_x').catch((e: unknown) => e);
    expect(getErr).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason } });
    expect((getErr as Error).message.startsWith('读取钥匙串失败：')).toBe(true);
  });

  test('unknown failure reasons map to other', async () => {
    const h = makeHelper('weird');
    await expect(new KeychainHelperStore({ helperPath: h.exe }).delete('sec_x')).rejects.toMatchObject({ details: { reason: 'other' } });
  });

  test('not_found: get returns null, delete succeeds', async () => {
    const h = makeHelper();
    const store = new KeychainHelperStore({ helperPath: h.exe });
    expect(await store.get('sec_none')).toBeNull();
    await expect(store.delete('sec_none')).resolves.toBeUndefined();
  });

  test('a helper that echoes the value on stderr does not leak it into the error', async () => {
    const h = makeHelper('stderr-leak');
    const err = (await new KeychainHelperStore({ helperPath: h.exe }).put('sec_x', VALUE, 'proxy').catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED' });
    expect(JSON.stringify({ m: err.message, d: (err as { details?: unknown }).details, s: err.stack })).not.toContain(VALUE);
  });

  test('response split across chunks is assembled', async () => {
    const h = makeHelper('partial-then-ok');
    await expect(new KeychainHelperStore({ helperPath: h.exe }).put('sec_x', VALUE, 'proxy')).resolves.toBeUndefined();
  });

  test('garbage output and non-zero exit map to other', async () => {
    const h = makeHelper('garbage');
    await expect(new KeychainHelperStore({ helperPath: h.exe }).put('sec_x', VALUE, 'proxy')).rejects.toMatchObject({ details: { reason: 'other' } });
    h.setBehavior('exit1');
    await expect(new KeychainHelperStore({ helperPath: h.exe }).put('sec_y', VALUE, 'proxy')).rejects.toMatchObject({ details: { reason: 'other' } });
  });

  test('timeout kills the helper and is reported as recoverable timeout', async () => {
    const h = makeHelper('hang');
    let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    const store = new KeychainHelperStore({
      helperPath: h.exe,
      timeoutMs: 400,
      spawn: (cmd, args, opts) => {
        const child = spawn(cmd, [...args], opts);
        // Observe the child directly: it can time out before writing calls.jsonl.
        // A missing log must not turn into process.kill(0, 0), which probes the group.
        exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
        return child;
      },
    });
    const err = (await store.put('sec_x', VALUE, 'proxy').catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'SECRET_STORE_FAILED', details: { reason: 'timeout' } });
    expect(err.message).not.toContain(VALUE);
    expect(exit).toBeDefined();
    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  }, 10_000);

  test('missing helper binary is reported without crashing', async () => {
    const store = new KeychainHelperStore({ helperPath: join(tmpdir(), 'definitely-missing-sfe-keychain') });
    await expect(store.get('sec_x')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED', message: '读取钥匙串失败：找不到钥匙串工具' });
  });

  test('malformed refs are refused before spawning', async () => {
    const h = makeHelper();
    const store = new KeychainHelperStore({ helperPath: h.exe });
    await expect(store.get('bad ref\n')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    await expect(store.put('', VALUE, 'proxy')).rejects.toMatchObject({ code: 'SECRET_STORE_FAILED' });
    expect(h.calls()).toEqual([]);
  });
});
