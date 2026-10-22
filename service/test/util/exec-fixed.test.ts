import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { execFixed } from '../../src/util/exec-fixed.js';

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfe-exec-fixed-'));
  const path = join(dir, 'child.mjs');
  writeFileSync(path, body);
  return path;
}

// 读到 stdin 的 EOF 才输出读到的字节数并退出：stdin 保持打开时会一直等到超时。
const READS_STDIN = "let n=0;process.stdin.on('data',(c)=>{n+=c.length});process.stdin.on('end',()=>{process.stdout.write(String(n))});";
const PRINTS_ENV = "process.stdout.write(JSON.stringify({only:process.env.SFE_EXEC_ONLY??null,parent:process.env.SFE_EXEC_PARENT??null}))";

afterEach(() => {
  delete process.env.SFE_EXEC_PARENT;
});

describe('execFixed', () => {
  test('closes stdin right after starting: a child that reads to EOF finishes at once with nothing read', async () => {
    const t0 = Date.now();
    const r = await execFixed(process.execPath, [script(READS_STDIN)], { timeout: 5_000 });
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('0');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test('env replaces the child environment; without it the child inherits', async () => {
    process.env.SFE_EXEC_PARENT = 'from-parent';
    const path = script(PRINTS_ENV);
    const replaced = await execFixed(process.execPath, [path], { timeout: 5_000, env: { SFE_EXEC_ONLY: 'yes' } });
    expect(JSON.parse(replaced.stdout)).toEqual({ only: 'yes', parent: null });
    const inherited = await execFixed(process.execPath, [path], { timeout: 5_000 });
    expect(JSON.parse(inherited.stdout)).toEqual({ only: null, parent: 'from-parent' });
  });

  test('non-zero exit is reported with its code and the captured output', async () => {
    const r = await execFixed(process.execPath, [script("process.stdout.write('out');process.stderr.write('err');process.exit(3)")], { timeout: 5_000 });
    expect(r.error?.code).toBe(3);
    expect(r).toMatchObject({ stdout: 'out', stderr: 'err' });
  });

  test('a child that outlives the timeout is killed', async () => {
    const r = await execFixed(process.execPath, [script('setTimeout(()=>{},10000)')], { timeout: 200 });
    expect(r.error?.killed).toBe(true);
  });

  test('a relative executable name is refused without a PATH lookup', async () => {
    const r = await execFixed('node', ['-e', "process.stdout.write('ran')"], { timeout: 5_000 });
    expect(r.error).toMatchObject({ code: 'ERR_EXEC_NOT_ABSOLUTE' });
    expect(r.stdout).toBe('');
  });
});

describe('child processes in service/src', () => {
  // 所有外部程序都经 execFixed（stdin 关闭）；唯一例外是 sfe-keychain，它在 stdin 上写一行请求后立即关闭。
  test('only exec-fixed.ts and the keychain helper import node:child_process', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /from 'node:child_process'|require\('(node:)?child_process'\)|from 'child_process'/.test(readFileSync(p, 'utf8'))) found.push(relative(root, p));
      }
    };
    walk(root);
    expect(found.sort()).toEqual(['secrets/keychain-helper-store.ts', 'util/exec-fixed.ts']);
    expect(readFileSync(join(root, 'secrets/keychain-helper-store.ts'), 'utf8')).toMatch(/child\.stdin\?\.end\(/);
  });
});
