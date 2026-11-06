import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { extractJsonRecords, parseJsonRecords, parseJsonText } from '../../src/importer/json.js';

function rejected(fn: () => unknown): SfeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SfeError);
    expect((e as SfeError).code).toBe('IMPORT_REJECTED');
    return e as SfeError;
  }
  throw new Error('expected IMPORT_REJECTED');
}

const rec = { display_name: '示例-买家01', proxy_host: '203.0.113.10', proxy_port: 1080 };

describe('JSON document shapes', () => {
  test('array of records', () => {
    expect(extractJsonRecords([rec])).toEqual([rec]);
  });

  test('{ environments: [...] }', () => {
    expect(extractJsonRecords({ environments: [rec] })).toEqual([rec]);
  });

  test('{ records: [...] } (the shape the web page and sfe used before)', () => {
    expect(extractJsonRecords({ records: [rec] })).toEqual([rec]);
  });

  test.each([
    ['plain object', { display_name: 'x' }],
    ['environments not an array', { environments: {} }],
    ['extra top-level keys', { environments: [], version: 1 }],
    ['both wrappers', { environments: [], records: [] }],
    ['records not an array', { records: {} }],
    ['string', 'x'],
    ['number', 1],
    ['null', null],
  ])('%s is rejected', (_label, doc) => {
    rejected(() => extractJsonRecords(doc));
  });

  test('invalid JSON text is rejected without echoing the parser message', () => {
    const e = rejected(() => parseJsonText('{"proxy_password": "Mk7SecretZz9"'));
    expect(e.message).not.toContain('Mk7SecretZz9');
  });

  test('JSON text with BOM', () => {
    expect(parseJsonText('﻿[{"name":"a"}]')).toEqual([{ name: 'a' }]);
  });
});

describe('parseJsonRecords', () => {
  test('row numbers are index + 1 and values keep their primitive types', () => {
    const rows = parseJsonRecords([rec, { ...rec, auto_open_orders: false }]);
    expect(rows.map((r) => r.row)).toEqual([1, 2]);
    expect(rows[0]!.record.proxy_port).toBe(1080);
    expect(rows[1]!.record.auto_open_orders).toBe(false);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  test('Chinese keys map through the same aliases', () => {
    const rows = parseJsonRecords([{ 环境名称: '示例', 代理地址: '203.0.113.10', 代理端口: '1080', 站点: '美国' }]);
    expect(rows[0]!.record).toMatchObject({ display_name: '示例', proxy_host: '203.0.113.10', proxy_port: '1080', site: '美国' });
    expect(rows[0]!.errors).toEqual([]);
  });

  test('nested values are row errors and not used', () => {
    const rows = parseJsonRecords([{ ...rec, proxy_password: { value: 'x' }, site: ['US'] }]);
    expect(rows[0]!.errors.map((e) => e.field)).toEqual(['rows[1].proxy_password', 'rows[1].site']);
    expect(rows[0]!.record.proxy_password).toBeUndefined();
  });

  test('unknown simple key is named', () => {
    const rows = parseJsonRecords([{ ...rec, notes: 'x' }]);
    expect(rows[0]!.errors).toHaveLength(1);
    expect(rows[0]!.errors[0]!.message).toContain('「notes」');
  });

  test('unknown key with unusual characters is not echoed', () => {
    const rows = parseJsonRecords([{ ...rec, 'Mk7@Secret!': 'x' }]);
    expect(rows[0]!.errors[0]!.message).not.toContain('Mk7');
    expect(rows[0]!.errors[0]!.message).toContain('第 4 个字段');
  });

  test('two keys for the same field', () => {
    const rows = parseJsonRecords([{ ...rec, 代理地址: '203.0.113.11' }]);
    expect(rows[0]!.errors.map((e) => e.field)).toEqual(['rows[1].proxy_host']);
  });

  test('non-object record is flagged', () => {
    const rows = parseJsonRecords([rec, 'x', null, [1]]);
    expect(rows.map((r) => r.notObject)).toEqual([false, true, true, true]);
  });

  test('more than 2000 records is rejected', () => {
    rejected(() => parseJsonRecords(Array.from({ length: 2001 }, () => rec)));
    expect(parseJsonRecords(Array.from({ length: 2000 }, () => rec))).toHaveLength(2000);
  });

  test('__proto__ key does not pollute and is reported as unknown', () => {
    const item = JSON.parse('{"display_name":"a","proxy_host":"203.0.113.10","proxy_port":1,"__proto__":{"polluted":true}}') as unknown;
    const rows = parseJsonRecords([item]);
    expect(rows[0]!.errors).toHaveLength(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
