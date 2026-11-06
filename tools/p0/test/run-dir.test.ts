import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { P0Error } from '../src/errors.js';
import { RUN_ID_RE, RunDir, assertSafeBaseDir, classifyLocationRisk, defaultBaseDir, findGitWorkTree, newRunId } from '../src/run-dir.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sfe-p0-test-'));
}

describe('base directory', () => {
  it('defaults outside the repository', () => {
    expect(defaultBaseDir('darwin', '/Users/tester', {})).toBe('/Users/tester/Library/Application Support/SafariProfileSurge/p0');
    expect(defaultBaseDir('linux', '/home/tester', {})).toBe('/home/tester/.local/share/safari-profile-surge/p0');
    expect(defaultBaseDir('linux', '/home/tester', { XDG_DATA_HOME: '/data' })).toBe('/data/safari-profile-surge/p0');
  });

  it('classifies synced and protected locations', () => {
    expect(classifyLocationRisk('/Users/t/Library/Mobile Documents/iCloud~com~nssurge~inc/Documents', '/Users/t')).toBe('synced');
    expect(classifyLocationRisk('/Users/t/Library/CloudStorage/Drive/x', '/Users/t')).toBe('synced');
    expect(classifyLocationRisk('/Users/t/Documents/p0', '/Users/t')).toBe('protected');
    expect(classifyLocationRisk('/Users/t/Desktop', '/Users/t')).toBe('protected');
    expect(classifyLocationRisk('/Users/t/Library/Application Support/SafariProfileSurge/p0', '/Users/t')).toBe('none');
    expect(classifyLocationRisk('/Users/t/Documentsx', '/Users/t')).toBe('none');
  });

  it('uses the canonical location like the service: symlinked and differently-cased aliases of synced folders are synced', () => {
    const home = tmp();
    mkdirSync(join(home, 'Library', 'CloudStorage', 'Dropbox'), { recursive: true });
    mkdirSync(join(home, 'Documents'), { recursive: true });
    // ~/Dropbox → ~/Library/CloudStorage/Dropbox（Dropbox 的 File Provider 集成通常留下的布局）。
    symlinkSync(join(home, 'Library', 'CloudStorage', 'Dropbox'), join(home, 'Dropbox'));
    symlinkSync(join(home, 'Documents'), join(home, 'docs-link'));
    expect(classifyLocationRisk(join(home, 'Dropbox', 'sfe-p0'), home)).toBe('synced');
    expect(classifyLocationRisk(join(home, 'Dropbox', 'not', 'yet', 'created'), home)).toBe('synced');
    expect(classifyLocationRisk(join(home, 'Dropbox'), home)).toBe('synced');
    expect(classifyLocationRisk(join(home, 'library', 'cloudstorage', 'Dropbox', 'p0'), home)).toBe('synced');
    expect(classifyLocationRisk(join(home, 'docs-link', 'p0'), home)).toBe('protected');
    expect(classifyLocationRisk(join(home, 'Library', 'Application Support', 'SafariProfileSurge', 'p0'), home)).toBe('none');
    const base = join(home, 'Dropbox', 'sfe-p0');
    expect(() => assertSafeBaseDir(base, home)).toThrow(/iCloud 或云盘同步位置/);
    expect(existsSync(join(home, 'Library', 'CloudStorage', 'Dropbox', 'sfe-p0'))).toBe(false);
  });

  it('keeps the iCloud name checks and refuses a location it cannot resolve', () => {
    expect(classifyLocationRisk('/Volumes/x/com~apple~CloudDocs/p0', '/Users/t')).toBe('synced');
    expect(classifyLocationRisk('/Volumes/x/iCloud Drive/p0', '/Users/t')).toBe('synced');
    // 祖先是普通文件：真实位置无法确认（ENOTDIR），按不安全处理。
    const root = tmp();
    writeFileSync(join(root, 'file'), '');
    expect(classifyLocationRisk(join(root, 'file', 'sub'), '/nonexistent-home')).toBe('unknown');
    expect(() => assertSafeBaseDir(join(root, 'file', 'sub'), '/nonexistent-home')).toThrow(/无法确认目录的真实位置/);
  });

  it('finds git work trees from non-existing children', () => {
    const root = tmp();
    mkdirSync(join(root, '.git'));
    expect(findGitWorkTree(join(root, 'a', 'b', 'c'))).toBe(root);
  });

  it('refuses a base inside a git work tree or a relative path', () => {
    const root = tmp();
    mkdirSync(join(root, '.git'));
    expect(() => assertSafeBaseDir(join(root, 'evidence'), '/nonexistent-home')).toThrow(P0Error);
    expect(() => assertSafeBaseDir('relative/dir', '/nonexistent-home')).toThrow(P0Error);
  });
});

describe('newRunId', () => {
  it('has a fixed sortable format', () => {
    const id = newRunId(new Date(2026, 9, 21, 9, 5, 7), () => Buffer.from([0xab, 0xcd, 0xef]));
    expect(id).toBe('20261021-090507-abcdef');
    expect(RUN_ID_RE.test(id)).toBe(true);
  });
});

describe('RunDir', () => {
  it('creates 0700 directories, 0600 files and a run key', () => {
    const base = join(tmp(), 'p0');
    const dir = RunDir.create(base, '20261021-090507-abcdef');
    expect(statSync(dir.path).mode & 0o777).toBe(0o700);
    expect(statSync(dir.file('digest.key')).mode & 0o777).toBe(0o600);
    expect(dir.key()).toHaveLength(32);
    const p = dir.writeJson('results/x.json', { a: 1 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir.path, 'results')).mode & 0o777).toBe(0o700);
    dir.appendJsonl('servers/echo.jsonl', { n: 1 });
    dir.appendJsonl('servers/echo.jsonl', { n: 2 });
    expect(statSync(dir.file('servers/echo.jsonl')).mode & 0o777).toBe(0o600);
    expect(dir.readJsonl<{ n: number }>('servers/echo.jsonl').map((x) => x.n)).toEqual([1, 2]);
  });

  it('opens the latest run by default', () => {
    const base = join(tmp(), 'p0');
    RunDir.create(base, '20261021-090507-aaaaaa');
    RunDir.create(base, '20261021-090508-bbbbbb');
    expect(RunDir.open(base, null).id).toBe('20261021-090508-bbbbbb');
    expect(RunDir.open(base, '20261021-090507-aaaaaa').id).toBe('20261021-090507-aaaaaa');
  });

  it('refuses unknown or malformed runs and duplicate ids', () => {
    const base = join(tmp(), 'p0');
    expect(() => RunDir.open(base, null)).toThrow(P0Error);
    expect(() => RunDir.open(base, '../etc')).toThrow(P0Error);
    RunDir.create(base, '20261021-090507-cccccc');
    expect(() => RunDir.create(base, '20261021-090507-cccccc')).toThrow(P0Error);
    expect(() => RunDir.create(base, 'bad')).toThrow(P0Error);
  });

  it('refuses path traversal and absolute file names', () => {
    const dir = RunDir.create(join(tmp(), 'p0'), '20261021-090507-dddddd');
    expect(() => dir.file('../x')).toThrow(P0Error);
    expect(() => dir.file('/etc/passwd')).toThrow(P0Error);
    expect(() => dir.file('a//b')).toThrow(P0Error);
  });

  it('writeNew never overwrites', () => {
    const dir = RunDir.create(join(tmp(), 'p0'), '20261021-090507-eeeeee');
    dir.writeNew('once.txt', 'a');
    expect(() => dir.writeNew('once.txt', 'b')).toThrow();
    expect(dir.readText('once.txt')).toBe('a');
  });

  it('skips half-written jsonl lines', () => {
    const dir = RunDir.create(join(tmp(), 'p0'), '20261021-090507-ffffff');
    writeFileSync(dir.file('x.jsonl'), '{"a":1}\n{"a":', { mode: 0o600 });
    expect(dir.readJsonl('x.jsonl')).toEqual([{ a: 1 }]);
  });

  it('lists files recursively in sorted order', () => {
    const dir = RunDir.create(join(tmp(), 'p0'), '20261021-090507-abcabc');
    dir.writeJson('b/z.json', 1);
    dir.writeJson('a.json', 1);
    expect(dir.listFiles()).toEqual(['a.json', 'b/z.json', 'digest.key']);
    expect(dir.listFiles('b')).toEqual(['b/z.json']);
  });
});
