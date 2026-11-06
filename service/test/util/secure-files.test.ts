import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SfeError } from '@sfe/contract';
import { describe, expect, test } from 'vitest';
import {
  assertUnixSocketPathLength,
  classifyDirectoryRisk,
  createExclusivePrivateFile,
  ensurePrivateDir,
  ensurePrivateDirSync,
  isInsideGitWorkTree,
  sweepTempFiles,
  writeFileAtomicPrivate,
} from '../../src/util/secure-files.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'sfe-files-'));
const mode = (p: string) => statSync(p).mode & 0o777;

describe('ensurePrivateDir', () => {
  test('creates nested directories with mode 0700', async () => {
    const base = fresh();
    const dir = join(base, 'a', 'b');
    await ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(base, 'a'))).toBe(0o700);
  });

  test('tightens an existing group/world-accessible directory', async () => {
    const dir = join(fresh(), 'loose');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  test('sync variant behaves the same', () => {
    const dir = join(fresh(), 'sync');
    ensurePrivateDirSync(dir);
    expect(mode(dir)).toBe(0o700);
  });

  test('refuses a symlink or a regular file', async () => {
    const base = fresh();
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    await expect(ensurePrivateDir(link)).rejects.toMatchObject({ code: 'UNSAFE_LOCATION' });
    const file = join(base, 'file');
    writeFileSync(file, 'x');
    await expect(ensurePrivateDir(file)).rejects.toBeTruthy();
  });
});

describe('createExclusivePrivateFile', () => {
  test('creates a 0600 file with O_EXCL', async () => {
    const p = join(fresh(), 'x.tmp');
    await createExclusivePrivateFile(p, 'secret-ish');
    expect(mode(p)).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toBe('secret-ish');
  });

  test('refuses to overwrite an existing file', async () => {
    const p = join(fresh(), 'x.tmp');
    writeFileSync(p, 'original');
    await expect(createExclusivePrivateFile(p, 'new')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(p, 'utf8')).toBe('original');
  });

  test('refuses a dangling symlink at the path', async () => {
    const dir = fresh();
    const p = join(dir, 'x.tmp');
    symlinkSync(join(dir, 'nowhere'), p);
    await expect(createExclusivePrivateFile(p, 'new')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
  });
});

describe('writeFileAtomicPrivate', () => {
  test('writes the final file with 0600 and leaves no temp file', async () => {
    const dir = fresh();
    const final = await writeFileAtomicPrivate(dir, 'sfe-nodes.list', 'line\n');
    expect(final).toBe(join(dir, 'sfe-nodes.list'));
    expect(readFileSync(final, 'utf8')).toBe('line\n');
    expect(mode(final)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['sfe-nodes.list']);
  });

  test('replaces an existing file atomically and resets its mode to 0600', async () => {
    const dir = fresh();
    const p = join(dir, 'a.list');
    writeFileSync(p, 'old');
    chmodSync(p, 0o644);
    await writeFileAtomicPrivate(dir, 'a.list', 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(mode(p)).toBe(0o600);
  });

  test('refuses when the temp file already exists and touches nothing', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'a.list'), 'current');
    const tmp = join(dir, '.a.list.0123456789abcdef.tmp');
    writeFileSync(tmp, 'planted');
    await expect(writeFileAtomicPrivate(dir, 'a.list', 'new', { randomSuffix: () => '0123456789abcdef' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(join(dir, 'a.list'), 'utf8')).toBe('current');
    expect(readFileSync(tmp, 'utf8')).toBe('planted');
  });

  test.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])('rejects file name %j', async (name) => {
    await expect(writeFileAtomicPrivate(fresh(), name, 'x')).rejects.toBeInstanceOf(SfeError);
  });
});

describe('sweepTempFiles', () => {
  test('removes only our temp-file pattern', async () => {
    const dir = fresh();
    for (const n of ['.a.list.0123456789abcdef.tmp', '.日常-Safari环境.conf.fedcba9876543210.tmp']) writeFileSync(join(dir, n), 'x');
    for (const n of ['keep.tmp', '.other.tmp', '.a.list.XYZ.tmp', 'a.list']) writeFileSync(join(dir, n), 'x');
    const removed = await sweepTempFiles(dir);
    expect(removed.sort()).toEqual(['.a.list.0123456789abcdef.tmp', '.日常-Safari环境.conf.fedcba9876543210.tmp'].sort());
    expect(readdirSync(dir).sort()).toEqual(['.a.list.XYZ.tmp', '.other.tmp', 'a.list', 'keep.tmp'].sort());
  });

  test('olderThanMs keeps recent temp files', async () => {
    const dir = fresh();
    const oldName = '.a.list.0123456789abcdef.tmp';
    const newName = '.b.list.0123456789abcdef.tmp';
    writeFileSync(join(dir, oldName), 'x');
    writeFileSync(join(dir, newName), 'x');
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, oldName), past, past);
    const removed = await sweepTempFiles(dir, { olderThanMs: 60_000 });
    expect(removed).toEqual([oldName]);
    expect(existsSync(join(dir, newName))).toBe(true);
  });

  test('missing directory yields nothing', async () => {
    expect(await sweepTempFiles(join(fresh(), 'missing'))).toEqual([]);
  });

  test('does not follow directories with matching names', async () => {
    const dir = fresh();
    mkdirSync(join(dir, '.d.list.0123456789abcdef.tmp'));
    expect(await sweepTempFiles(dir)).toEqual([]);
    expect(lstatSync(join(dir, '.d.list.0123456789abcdef.tmp')).isDirectory()).toBe(true);
  });
});

describe('isInsideGitWorkTree', () => {
  test('detects a .git directory or file in any ancestor, including non-existent descendants', () => {
    const repo = fresh();
    mkdirSync(join(repo, '.git'));
    expect(isInsideGitWorkTree(join(repo, 'a', 'b', 'not-yet'))).toBe(true);
    const wt = fresh();
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere');
    expect(isInsideGitWorkTree(join(wt, 'data'))).toBe(true);
  });

  test('false for an unrelated temp directory', () => {
    expect(isInsideGitWorkTree(join(fresh(), 'data'))).toBe(false);
  });
});

describe('classifyDirectoryRisk', () => {
  const home = '/Users/tester';
  test.each([
    ['/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/Surge', 'synced'],
    ['/Users/tester/Library/CloudStorage/Dropbox/Surge', 'synced'],
    ['/Users/tester/Documents/Surge', 'protected'],
    ['/Users/tester/Desktop', 'protected'],
    ['/Users/tester/downloads/x', 'protected'],
    ['/Users/tester/Library/Application Support/Surge/Profiles', 'none'],
    ['/Users/tester/DocumentsArchive', 'none'],
    ['/Users/other/Documents', 'none'],
  ] as const)('%s → %s', (path, risk) => {
    expect(classifyDirectoryRisk(path, home)).toBe(risk);
  });

  test('follows symlinks into synced locations', () => {
    const h = fresh();
    const cloud = join(h, 'Library', 'Mobile Documents', 'iCloud~Surge');
    mkdirSync(cloud, { recursive: true });
    const link = join(h, 'surge-link');
    symlinkSync(cloud, link);
    expect(classifyDirectoryRisk(link, h)).toBe('synced');
  });

  test.each([
    ['Library/CloudStorage', 'synced'],
    ['Documents', 'protected'],
  ] as const)('checks canonical home and new descendants of a link to %s', (directory, risk) => {
    const base = fresh();
    const actualHome = join(base, 'actual-home');
    const destination = join(actualHome, directory);
    mkdirSync(destination, { recursive: true });
    const homeAlias = join(base, 'home-alias');
    symlinkSync(actualHome, homeAlias);
    const shortcut = join(base, 'shortcut');
    symlinkSync(destination, shortcut);

    expect(classifyDirectoryRisk(destination, homeAlias)).toBe(risk);
    expect(classifyDirectoryRisk(join(shortcut, 'not-created', 'data'), homeAlias)).toBe(risk);
  });

  test('an unresolvable path or home (not just missing, e.g. a link loop) fails closed with UNSAFE_LOCATION, no path in the error', () => {
    const base = fresh();
    const loop = join(base, 'loop');
    symlinkSync(loop, loop);
    const home = join(base, 'home');
    mkdirSync(home);
    for (const [path, h] of [
      [join(loop, 'surge'), home],
      [join(base, 'surge'), loop],
      [join(base, 'surge'), join(loop, 'nested')],
    ] as const) {
      let caught: unknown = null;
      try {
        classifyDirectoryRisk(path, h);
      } catch (err) {
        caught = err;
      }
      // 从不按 none 放行，也不抛出原始文件系统错误
      expect(caught).toBeInstanceOf(SfeError);
      const e = caught as SfeError;
      expect(e.code).toBe('UNSAFE_LOCATION');
      expect(e.message).toContain('无法确认目录的真实位置');
      expect(e.message).toContain('ELOOP');
      expect(JSON.stringify(e.toBody())).not.toContain(base);
    }
  });
});

describe('assertUnixSocketPathLength', () => {
  test('accepts up to 103 bytes and rejects longer, counting UTF-8 bytes', () => {
    expect(() => assertUnixSocketPathLength(`/${'a'.repeat(102)}`)).not.toThrow();
    expect(() => assertUnixSocketPathLength(`/${'a'.repeat(103)}`)).toThrow(SfeError);
    // 每个汉字 3 字节：1 + 34*3 = 103 可以；35 个超出
    expect(() => assertUnixSocketPathLength(`/${'场'.repeat(34)}`)).not.toThrow();
    try {
      assertUnixSocketPathLength(`/${'场'.repeat(35)}`);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'UNSAFE_LOCATION', details: { bytes: 106, limit: 103 } });
    }
  });
});
