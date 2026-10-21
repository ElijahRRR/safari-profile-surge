import { describe, expect, test } from 'vitest';
import type { ImportPreview, ImportRowPreview } from '@sfe/contract';
import { UsageError } from '../../src/cli/args.js';
import { buildImportDecisions, describeUnresolved, parseResolve, parseResolves } from '../../src/cli/import-decisions.js';
import { runCli } from '../../src/cli/sfe.js';
import { fakeCli } from './helpers.js';

const row = (over: Partial<ImportRowPreview> & Pick<ImportRowPreview, 'row' | 'status'>): ImportRowPreview => ({
  environment_id: null,
  current_revision: null,
  displayName: `US-Buyer-${over.row}`,
  diff: [],
  errors: [],
  conflictCandidates: [],
  ...over,
});

const preview = (rows: ImportRowPreview[], extra: Partial<ImportPreview> = {}): ImportPreview => ({
  preview_digest: 'digest-synthetic-01',
  rows,
  totals: { create: 0, update: 0, unchanged: 0, conflict: 0, invalid: 0 },
  fileErrors: [],
  ...extra,
});

const MIXED = preview([
  row({ row: 2, status: 'create' }),
  row({ row: 3, status: 'update', environment_id: 'env_a', current_revision: 5, diff: [{ field: 'proxy_password', before: '已设置', after: '已修改' }] }),
  row({ row: 4, status: 'conflict', conflictCandidates: [{ environment_id: 'env_b', label: 'US-Buyer-4 · E0002', revision: 9 }] }),
  row({ row: 5, status: 'unchanged', environment_id: 'env_c', current_revision: 1 }),
  row({ row: 6, status: 'invalid', errors: [{ field: 'proxy_port', message: '端口必须是 1–65535 的整数' }] }),
]);

describe('parseResolve', () => {
  test('forms', () => {
    expect(parseResolve('4:skip')).toEqual({ row: 4, action: 'skip' });
    expect(parseResolve('4:create')).toEqual({ row: 4, action: 'create' });
    expect(parseResolve('4:update:env_b')).toEqual({ row: 4, action: 'update', environmentId: 'env_b' });
  });

  test.each(['4', 'x:skip', '4:delete', '4:update', '4:update:', '4:skip:env_b', '4:update:a b'])('rejects %j', (s) => {
    expect(() => parseResolve(s)).toThrow(UsageError);
  });

  test('duplicate rows are rejected', () => {
    expect(() => parseResolves(['4:skip', '4:create'])).toThrow(UsageError);
  });
});

describe('buildImportDecisions', () => {
  test('create → create, update → update with current_revision, conflict → unresolved, unchanged/invalid → nothing', () => {
    const plan = buildImportDecisions(MIXED, new Map());
    expect(plan.decisions).toEqual([
      { row: 2, action: 'create' },
      { row: 3, action: 'update', environment_id: 'env_a', expected_revision: 5 },
    ]);
    expect(plan.unresolved.map((r) => r.row)).toEqual([4]);
  });

  test('conflict resolved to update uses the candidate revision', () => {
    const plan = buildImportDecisions(MIXED, parseResolves(['4:update:env_b']));
    expect(plan.unresolved).toHaveLength(0);
    expect(plan.decisions).toContainEqual({ row: 4, action: 'update', environment_id: 'env_b', expected_revision: 9 });
  });

  test('conflict resolved to create or skip', () => {
    expect(buildImportDecisions(MIXED, parseResolves(['4:create'])).decisions).toContainEqual({ row: 4, action: 'create' });
    expect(buildImportDecisions(MIXED, parseResolves(['4:skip'])).decisions).toContainEqual({ row: 4, action: 'skip' });
  });

  test('a resolution can override a create row', () => {
    const plan = buildImportDecisions(MIXED, parseResolves(['2:skip', '4:skip']));
    expect(plan.decisions).toContainEqual({ row: 2, action: 'skip' });
    expect(plan.decisions).not.toContainEqual({ row: 2, action: 'create' });
  });

  test('update to an environment that is not a candidate → UsageError', () => {
    expect(() => buildImportDecisions(MIXED, parseResolves(['4:update:env_zzz']))).toThrow(UsageError);
  });

  test('resolving an invalid or unchanged row to create/update → UsageError; skip is a no-op', () => {
    expect(() => buildImportDecisions(MIXED, parseResolves(['6:create', '4:skip']))).toThrow(UsageError);
    expect(() => buildImportDecisions(MIXED, parseResolves(['5:update:env_c', '4:skip']))).toThrow(UsageError);
    const plan = buildImportDecisions(MIXED, parseResolves(['6:skip', '4:skip']));
    expect(plan.decisions.find((d) => d.row === 6)).toBeUndefined();
  });

  test('resolution for a row not in the preview → UsageError', () => {
    expect(() => buildImportDecisions(MIXED, parseResolves(['99:skip']))).toThrow(UsageError);
  });

  test('describeUnresolved lists the exact flags', () => {
    const text = describeUnresolved([MIXED.rows[2]!]);
    expect(text).toContain('--resolve 4:skip');
    expect(text).toContain('--resolve 4:create');
    expect(text).toContain('--resolve 4:update:env_b');
  });
});

describe('sfe import', () => {
  const CSV = 'display_name,proxy_host,proxy_port,proxy_password\nUS-Buyer-02,203.0.113.10,1080,synthetic-pw\n';

  test('preview only: reads the file itself and sends base64; no commit', async () => {
    const cli = fakeCli({ argv: ['import', 'buyers.csv', '--default-site', 'US', '--default-front', 'front_1'], files: { '/work/buyers.csv': CSV }, responses: { importPreview: MIXED } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0]!.envelope).toEqual({
      v: 1,
      op: 'importPreview',
      args: { format: 'csv', default_front_proxy_id: 'front_1', default_site: 'US', content_base64: Buffer.from(CSV).toString('base64') },
    });
    expect(cli.stdout()).toContain('未提交');
    expect(cli.stdout()).toContain('同名冲突');
    expect(cli.stdout()).toContain('proxy_password: 已设置 → 已修改');
    // 输出只含服务端脱敏后的预览，不含原始文件内容
    expect(cli.stdout()).not.toContain('synthetic-pw');
  });

  test('--commit with an unresolved conflict → exit 3 and nothing committed', async () => {
    const cli = fakeCli({ argv: ['import', 'buyers.csv', '--commit'], files: { '/work/buyers.csv': CSV }, responses: { importPreview: MIXED } });
    expect(await runCli(cli.deps)).toBe(3);
    expect(cli.requests.map((r) => r.envelope.op)).toEqual(['importPreview']);
    expect(cli.stdout()).toContain('--resolve 4:update:env_b');
  });

  test('--commit with resolutions sends decisions, digest and the same content', async () => {
    const cli = fakeCli({
      argv: ['import', 'buyers.csv', '--commit', '--resolve', '4:update:env_b'],
      files: { '/work/buyers.csv': CSV },
      responses: {
        importPreview: MIXED,
        importCommit: { batch_id: 'batch_1', operation_id: 'op_9', items: [{ row: 2, environment_id: 'env_new', status: 'create', operation_id: 'op_9' }] },
      },
    });
    expect(await runCli(cli.deps)).toBe(0);
    const commit = cli.requests[1]!.envelope;
    expect(commit.op).toBe('importCommit');
    expect(commit.args).toEqual({
      format: 'csv',
      content_base64: Buffer.from(CSV).toString('base64'),
      request_id: 'cli-test-1',
      preview_digest: 'digest-synthetic-01',
      decisions: [
        { row: 2, action: 'create' },
        { row: 3, action: 'update', environment_id: 'env_a', expected_revision: 5 },
        { row: 4, action: 'update', environment_id: 'env_b', expected_revision: 9 },
      ],
    });
    expect(cli.stdout()).toContain('批次 batch_1');
  });

  test('commit result with a revision conflict → exit 1', async () => {
    const cli = fakeCli({
      argv: ['import', 'buyers.csv', '--commit', '--resolve', '4:skip'],
      files: { '/work/buyers.csv': CSV },
      responses: { importPreview: MIXED, importCommit: { batch_id: 'b', operation_id: 'o', items: [{ row: 3, environment_id: 'env_a', status: 'revision_conflict', operation_id: null }] } },
    });
    expect(await runCli(cli.deps)).toBe(1);
  });

  test('--resolve without --commit → 2', async () => {
    const cli = fakeCli({ argv: ['import', 'buyers.csv', '--resolve', '4:skip'], files: { '/work/buyers.csv': CSV } });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
  });

  test('file errors → exit 1 and no commit', async () => {
    const cli = fakeCli({
      argv: ['import', 'buyers.csv', '--commit'],
      files: { '/work/buyers.csv': CSV },
      responses: { importPreview: preview([], { fileErrors: [{ field: 'header', message: '缺少 proxy_host 列' }] }) },
    });
    expect(await runCli(cli.deps)).toBe(1);
    expect(cli.requests).toHaveLength(1);
    expect(cli.stdout()).toContain('缺少 proxy_host 列');
  });

  test('nothing to commit → 0 without importCommit', async () => {
    const cli = fakeCli({ argv: ['import', 'buyers.csv', '--commit'], files: { '/work/buyers.csv': CSV }, responses: { importPreview: preview([row({ row: 2, status: 'unchanged' })]) } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests).toHaveLength(1);
  });

  test('json files are sent as records (array or { records })', async () => {
    const records = [{ display_name: 'US-Buyer-01', proxy_host: '198.51.100.7', proxy_port: 1080 }];
    for (const body of [records, { records }]) {
      const cli = fakeCli({ argv: ['import', 'in.json'], files: { '/work/in.json': JSON.stringify(body) }, responses: { importPreview: preview([]) } });
      expect(await runCli(cli.deps)).toBe(0);
      expect(cli.requests[0]!.envelope.args).toEqual({ format: 'json', records });
    }
  });

  test('xlsx is detected by extension and sent as base64', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const cli = fakeCli({ argv: ['import', 'in.XLSX'], files: { '/work/in.XLSX': bytes }, responses: { importPreview: preview([]) } });
    expect(await runCli(cli.deps)).toBe(0);
    expect(cli.requests[0]!.envelope.args).toEqual({ format: 'xlsx', content_base64: bytes.toString('base64') });
  });

  test('unknown extension requires --format', async () => {
    expect(await runCli(fakeCli({ argv: ['import', 'in.txt'], files: { '/work/in.txt': 'x' } }).deps)).toBe(2);
    const cli = fakeCli({ argv: ['import', 'in.txt', '--format', 'csv'], files: { '/work/in.txt': 'a,b\n' }, responses: { importPreview: preview([]) } });
    expect(await runCli(cli.deps)).toBe(0);
  });

  test('bad JSON file → 2 without echoing contents', async () => {
    const cli = fakeCli({ argv: ['import', 'in.json'], files: { '/work/in.json': '{"proxy_password": "SYNTH-PW-77"' } });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.stderr()).not.toContain('SYNTH-PW-77');
  });

  test('missing file → 2', async () => {
    const cli = fakeCli({ argv: ['import', 'missing.csv'] });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.stderr()).toContain('读取导入文件失败');
  });

  test('oversized file → 2', async () => {
    const cli = fakeCli({ argv: ['import', 'big.csv'], files: { '/work/big.csv': Buffer.alloc(8 * 1024 * 1024 + 1) } });
    expect(await runCli(cli.deps)).toBe(2);
    expect(cli.requests).toHaveLength(0);
  });

  test('--default-site must be a known site', async () => {
    expect(await runCli(fakeCli({ argv: ['import', 'a.csv', '--default-site', 'JP'], files: { '/work/a.csv': 'x' } }).deps)).toBe(2);
  });
});
