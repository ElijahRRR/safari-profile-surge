import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { importTemplateCsv, parseImport, type ParsedImport } from '../../src/importer/index.js';
import { simpleXlsx, type CellSpec } from './zip-writer.js';

const MARKER = 'Mk7SecretZz9';

const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64');
const csv = (text: string, default_site: 'US' | null = null) => parseImport({ format: 'csv', content_base64: b64(text), default_site });

const HEADER = '环境编号,环境名称,代理地址,代理端口,代理用户名,代理密码,站点,登录账号,登录密码';

function thrown(fn: () => unknown, code: string): SfeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SfeError);
    expect((e as SfeError).code).toBe(code);
    return e as SfeError;
  }
  throw new Error(`expected ${code}`);
}

function allErrorText(p: ParsedImport): string {
  return JSON.stringify([p.fileErrors, p.rows.map((r) => r.normalized.errors)]);
}

describe('parseImport: CSV', () => {
  test('row numbers: header is row 1, first data row is row 2', () => {
    const p = csv(`${HEADER}\n,示例-买家01,203.0.113.10,1080,u1,p1,US,buyer01@example.test,pw\n,示例-买家02,203.0.113.11,1081,,,US,,\n`);
    expect(p.fileErrors).toEqual([]);
    expect(p.rows.map((r) => r.row)).toEqual([2, 3]);
    expect(p.rows.map((r) => r.normalized.errors)).toEqual([[], []]);
    expect(p.rows[0]!.record.proxy_password).toBe('p1');
    expect(p.rows[0]!.normalized.input.proxy.password).toEqual({ action: 'replace', value: 'p1' });
    expect(p.rows[1]!.normalized.input.proxy.password).toEqual({ action: 'keep' });
  });

  test('default site applies to rows without site', () => {
    const p = csv('环境名称,代理地址,代理端口\n示例,203.0.113.10,1080\n', 'US');
    expect(p.rows[0]!.normalized.errors).toEqual([]);
    expect(p.rows[0]!.normalized.input.site).toBe('US');
  });

  test('missing site and no default → row error, not US', () => {
    const p = csv('环境名称,代理地址,代理端口\n示例,203.0.113.10,1080\n');
    expect(p.rows[0]!.normalized.errors.map((e) => e.field)).toEqual(['rows[2].site']);
  });

  test('blank lines keep physical row numbers', () => {
    const p = csv('环境名称,代理地址,代理端口,站点\n\n示例,203.0.113.10,1080,US\n');
    expect(p.rows.map((r) => r.row)).toEqual([3]);
  });

  test('ragged row is an error and its cells are not read', () => {
    const p = csv(`${HEADER}\n,示例,203.0.113.10,1080,u1,${MARKER},US,buyer01@example.test,${MARKER},extra\n`);
    const row = p.rows[0]!;
    expect(row.normalized.errors).toHaveLength(1);
    expect(row.normalized.errors[0]!.field).toBe('rows[2]');
    expect(row.normalized.errors[0]!.message).toContain('10 列');
    expect(JSON.stringify(row)).not.toContain(MARKER);
  });

  test('short row is an error', () => {
    const p = csv('环境名称,代理地址,代理端口\n示例,203.0.113.10\n');
    expect(p.rows[0]!.normalized.errors[0]!.message).toContain('表头有 3 列');
  });

  test('row with characters after a closing quote is an error', () => {
    const p = csv(`环境名称,代理地址,代理端口\n"示例"x,203.0.113.10,1080\n示例2,203.0.113.11,1080\n`, 'US');
    expect(p.rows[0]!.normalized.errors[0]!.field).toBe('rows[2]');
    expect(p.rows[1]!.normalized.errors).toEqual([]);
  });

  test('unknown header → file error and no rows', () => {
    const p = csv('环境名称,代理地址,代理端口,备注\n示例,203.0.113.10,1080,x\n');
    expect(p.rows).toEqual([]);
    expect(p.fileErrors).toHaveLength(1);
    expect(p.fileErrors[0]!.message).toContain('第 4 列（D 列）');
  });

  test('duplicate header → file error', () => {
    const p = csv('环境名称,名称,代理地址,代理端口\n');
    expect(p.rows).toEqual([]);
    expect(p.fileErrors[0]!.message).toContain('重复');
  });

  test('empty header with data in that column → file error', () => {
    const p = csv(`环境名称,代理地址,代理端口,\n示例,203.0.113.10,1080,${MARKER}\n`);
    expect(p.rows).toEqual([]);
    expect(p.fileErrors[0]!.message).toBe('第 4 列（D 列）有数据但没有列名');
    expect(allErrorText(p)).not.toContain(MARKER);
  });

  test('empty header column that is empty everywhere is ignored', () => {
    const p = csv('环境名称,代理地址,代理端口,站点,\n示例,203.0.113.10,1080,US,\n');
    expect(p.fileErrors).toEqual([]);
    expect(p.rows[0]!.normalized.errors).toEqual([]);
  });

  test('header only → no data rows', () => {
    expect(csv('环境名称,代理地址,代理端口\n').fileErrors[0]!.message).toBe('文件中没有数据行');
  });

  test('empty file', () => {
    expect(parseImport({ format: 'csv', content_base64: b64('﻿') }).fileErrors[0]!.message).toBe('文件中没有内容');
  });

  test('file without header row: no values echoed', () => {
    const p = csv(`示例,203.0.113.10,1080,u1,${MARKER}\n`);
    expect(p.rows).toEqual([]);
    expect(allErrorText(p)).not.toContain(MARKER);
    expect(allErrorText(p)).not.toContain('203.0.113.10');
  });

  test('data URL prefix and line-wrapped base64 are accepted', () => {
    const raw = b64('环境名称,代理地址,代理端口,站点\n示例,203.0.113.10,1080,US\n');
    const wrapped = `data:text/csv;base64,${raw.replace(/(.{20})/g, '$1\n')}`;
    expect(parseImport({ format: 'csv', content_base64: wrapped }).rows).toHaveLength(1);
  });
});

describe('parseImport: XLSX', () => {
  test('normal workbook end to end', () => {
    const rows: CellSpec[][] = [
      ['环境名称', '代理地址', '代理端口', '站点', '自动打开订单', '登录账号'],
      ['示例-买家01', '203.0.113.10', 1080, '美国', false, 13800000000],
    ];
    const p = parseImport({ format: 'xlsx', content_base64: b64(simpleXlsx(rows)) });
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(1);
    const n = p.rows[0]!.normalized;
    expect(n.errors).toEqual([]);
    expect(n.input.proxy.port).toBe(1080);
    expect(n.input.autoOpenOrders).toBe(false);
    expect(n.input.account?.loginIdentifier).toBe('13800000000');
    expect(p.rows[0]!.row).toBe(2);
  });

  test('formula rejects the whole import with the row number', () => {
    const rows: CellSpec[][] = [
      ['环境名称', '代理地址', '代理端口', '代理密码'],
      ['示例', '203.0.113.10', 1080, MARKER],
      ['示例2', '203.0.113.11', { formula: 'C2+1', value: '1081' }, MARKER],
    ];
    const e = thrown(() => parseImport({ format: 'xlsx', content_base64: b64(simpleXlsx(rows)) }), 'IMPORT_REJECTED');
    expect(e.message).toBe('第 3 行包含公式，导入不执行公式，请改为纯文本值');
    expect(JSON.stringify(e.toBody())).not.toContain(MARKER);
  });

  test('data in a column beyond the header → file error', () => {
    const rows: CellSpec[][] = [
      ['环境名称', '代理地址', '代理端口'],
      ['示例', '203.0.113.10', 1080, MARKER],
    ];
    const p = parseImport({ format: 'xlsx', content_base64: b64(simpleXlsx(rows)) });
    expect(p.fileErrors[0]!.message).toContain('D 列');
    expect(allErrorText(p)).not.toContain(MARKER);
  });
});

describe('parseImport: JSON', () => {
  const rec = { display_name: '示例', proxy_host: '203.0.113.10', proxy_port: 1080, site: 'US' };

  test('records array', () => {
    const p = parseImport({ format: 'json', records: [rec, { ...rec, display_name: '示例2' }] });
    expect(p.rows.map((r) => r.row)).toEqual([1, 2]);
    expect(p.rows.every((r) => r.normalized.errors.length === 0)).toBe(true);
  });

  test('JSON file content with { environments }', () => {
    const p = parseImport({ format: 'json', content_base64: b64(JSON.stringify({ environments: [rec] })) });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.normalized.errors).toEqual([]);
  });

  test('structure errors are merged into the row errors', () => {
    const p = parseImport({ format: 'json', records: [{ ...rec, notes: 'x' }] });
    expect(p.rows[0]!.normalized.errors).toHaveLength(1);
  });

  test('non-object record becomes an error row', () => {
    const p = parseImport({ format: 'json', records: [MARKER] });
    expect(p.rows[0]!.normalized.errors).toEqual([{ field: 'rows[1]', message: '第 1 条记录不是对象' }]);
    expect(JSON.stringify(p.rows[0])).not.toContain(MARKER);
  });

  test('empty records array', () => {
    expect(parseImport({ format: 'json', records: [] }).fileErrors[0]!.message).toBe('没有任何记录');
  });
});

describe('within-file duplicates', () => {
  test('same environment_id twice → both rows error', () => {
    const p = csv(`${HEADER}\nE0001,A,203.0.113.10,1080,,,US,,\nE0002,B,203.0.113.11,1080,,,US,,\nE0001,C,203.0.113.12,1080,,,US,,\n`);
    const errs = p.rows.map((r) => r.normalized.errors.map((e) => e.field));
    expect(errs).toEqual([['rows[2].environment_id'], [], ['rows[4].environment_id']]);
    expect(p.rows[0]!.normalized.errors[0]!.message).toContain('第 4 行');
    expect(p.rows[2]!.normalized.errors[0]!.message).toContain('第 2 行');
  });

  test('same display_name among rows without environment_id → both flagged', () => {
    const p = csv(`${HEADER}\n,买家,203.0.113.10,1080,,,US,,\n,其他,203.0.113.11,1080,,,US,,\n,买家,203.0.113.12,1080,,,US,,\n`);
    expect(p.rows.map((r) => r.duplicateNameInFile)).toEqual([true, false, true]);
    expect(p.rows.every((r) => r.normalized.errors.length === 0)).toBe(true);
  });

  test('name comparison folds case and full-width characters', () => {
    const p = csv(`${HEADER}\n,Buyer01,203.0.113.10,1080,,,US,,\n,ＢＵＹＥＲ01,203.0.113.11,1080,,,US,,\n`);
    expect(p.rows.map((r) => r.duplicateNameInFile)).toEqual([true, true]);
  });

  test('rows with environment_id are not name duplicates', () => {
    const p = csv(`${HEADER}\nE0001,买家,203.0.113.10,1080,,,US,,\n,买家,203.0.113.11,1080,,,US,,\n`);
    expect(p.rows.map((r) => r.duplicateNameInFile)).toEqual([false, false]);
  });

  test('JSON duplicates use record numbers', () => {
    const rec = { environment_id: 'E0009', display_name: 'x', proxy_host: '203.0.113.10', proxy_port: 1080, site: 'US' };
    const p = parseImport({ format: 'json', records: [rec, rec] });
    expect(p.rows.map((r) => r.normalized.errors.map((e) => e.field))).toEqual([['rows[1].environment_id'], ['rows[2].environment_id']]);
  });
});

describe('request validation', () => {
  test('unknown format', () => {
    thrown(() => parseImport({ format: 'xls' as 'csv', content_base64: b64('a') }), 'BAD_REQUEST');
  });

  test('missing content', () => {
    thrown(() => parseImport({ format: 'csv' }), 'BAD_REQUEST');
  });

  test('invalid base64', () => {
    thrown(() => parseImport({ format: 'csv', content_base64: 'not*base64' }), 'BAD_REQUEST');
  });

  test('records with a table format', () => {
    thrown(() => parseImport({ format: 'csv', records: [] }), 'BAD_REQUEST');
  });

  test('both records and content for JSON', () => {
    thrown(() => parseImport({ format: 'json', records: [], content_base64: b64('[]') }), 'BAD_REQUEST');
  });

  test('oversized content is rejected before decoding', () => {
    const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 3) / 3) * 4);
    expect(thrown(() => parseImport({ format: 'csv', content_base64: big }), 'IMPORT_REJECTED').message).toContain('5 MB');
  });

  test('unsupported default site is a file error', () => {
    const p = parseImport({ format: 'json', records: [{ display_name: 'x', proxy_host: '203.0.113.10', proxy_port: 1 }], default_site: 'UK' as 'US' });
    expect(p.fileErrors.map((e) => e.field)).toEqual(['default_site']);
    expect(p.rows[0]!.normalized.errors.map((e) => e.field)).toEqual(['rows[1].site']);
  });
});

describe('secret canary: no secret value appears in any error', () => {
  test('CSV with secrets and many invalid fields', () => {
    const text = [
      HEADER + ',代理类型,自动打开订单,预期出口IP',
      // 秘密合法，其他字段无效
      `bad id!,,not a host,99999,${MARKER},${MARKER},UK,${MARKER},${MARKER},http,maybe,${MARKER}`,
      // 秘密本身非法（含不可表达字符）
      `,示例,203.0.113.10,1080,${MARKER}@,${MARKER}"",US,,${MARKER.repeat(30)},,,`,
      // 重复编号
      `E1,A,203.0.113.10,1080,${MARKER},${MARKER},US,,${MARKER},,,`,
      `E1,B,203.0.113.10,1080,${MARKER},${MARKER},US,,${MARKER},,,`,
    ].join('\n');
    const p = csv(text);
    expect(p.rows.length).toBe(4);
    expect(p.rows.every((r) => r.normalized.errors.length > 0)).toBe(true);
    expect(allErrorText(p)).not.toContain(MARKER);
  });

  test('JSON with secrets in wrong-typed and unknown fields', () => {
    const p = parseImport({
      format: 'json',
      records: [{ display_name: 'x', proxy_host: MARKER, proxy_port: MARKER, proxy_password: `${MARKER} `, login_password: MARKER, site: MARKER, expected_exit_ip: MARKER, auto_fill_login: MARKER }],
    });
    expect(p.rows[0]!.normalized.errors.length).toBeGreaterThan(3);
    expect(allErrorText(p)).not.toContain(MARKER);
  });

  test('rejected XLSX error body does not contain secrets', () => {
    const rows: CellSpec[][] = [['环境名称', '代理密码'], [MARKER, { formula: `"${MARKER}"` }]];
    const e = thrown(() => parseImport({ format: 'xlsx', content_base64: b64(simpleXlsx(rows)) }), 'IMPORT_REJECTED');
    expect(JSON.stringify(e.toBody())).not.toContain(MARKER);
  });

  test('rejected CSV error body does not contain secrets', () => {
    const e = thrown(() => csv(`环境名称,代理密码\n示例,"${MARKER}`), 'IMPORT_REJECTED');
    expect(JSON.stringify(e.toBody())).not.toContain(MARKER);
  });
});

describe('import template', () => {
  test('starts with a UTF-8 BOM and uses CRLF', () => {
    const t = importTemplateCsv();
    expect(t.charCodeAt(0)).toBe(0xfeff);
    expect(t.endsWith('\r\n')).toBe(true);
    expect(t.split('\r\n')).toHaveLength(3);
  });

  test('has Chinese headers for every field', () => {
    const header = importTemplateCsv().slice(1).split('\r\n')[0]!.split(',');
    expect(header).toEqual([
      '环境编号',
      '环境名称',
      '代理类型',
      '代理地址',
      '代理端口',
      '代理用户名',
      '代理密码',
      '前置代理',
      '站点',
      '买家号备注',
      '登录账号',
      '登录密码',
      '预期出口IP',
      '自动打开订单',
      '登录页自动填充',
    ]);
  });

  test('round-trips through the importer as one valid synthetic row', () => {
    const p = parseImport({ format: 'csv', content_base64: b64(importTemplateCsv()) });
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0]!;
    expect(r.row).toBe(2);
    expect(r.normalized.errors).toEqual([]);
    expect(r.normalized.environmentId).toBeNull();
    expect(r.normalized.input).toMatchObject({
      displayName: '示例-买家01',
      site: 'US',
      autoOpenOrders: true,
      autoFillLogin: false,
      proxy: { host: '203.0.113.10', port: 1080, username: { action: 'replace', value: 'example-user' }, password: { action: 'replace', value: 'example-pass' } },
      account: { loginIdentifier: 'buyer01@example.test', password: { action: 'replace', value: 'example-only' } },
    });
  });

  test('only synthetic values (documentation IPs, example.test)', () => {
    const t = importTemplateCsv();
    for (const ip of t.match(/\d+\.\d+\.\d+\.\d+/g) ?? []) expect(ip.startsWith('203.0.113.')).toBe(true);
    for (const at of t.match(/@[\w.-]+/g) ?? []) expect(at).toBe('@example.test');
  });
});

describe('duplicate message length', () => {
  test('lists at most five other rows', () => {
    const rec = { environment_id: 'E0009', display_name: 'x', proxy_host: '203.0.113.10', proxy_port: 1080, site: 'US' };
    const p = parseImport({ format: 'json', records: Array.from({ length: 8 }, () => rec) });
    expect(p.rows[0]!.normalized.errors[0]!.message).toBe('环境编号在文件中重复（另见第 2、3、4、5、6 等 7 行）');
  });
});
