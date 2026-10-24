import { describe, expect, test } from 'vitest';
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_ALIASES,
  IMPORT_FIELD_LABELS,
  mapHeader,
  normalizeHeader,
  resolveHeader,
} from '../../src/importer/columns.js';

describe('resolveHeader', () => {
  test.each([
    ['environment_id', 'environment_id'],
    ['环境ID', 'environment_id'],
    ['环境编号', 'environment_id'],
    ['display_name', 'display_name'],
    ['环境名称', 'display_name'],
    ['名称', 'display_name'],
    ['proxy_type', 'proxy_type'],
    ['代理类型', 'proxy_type'],
    ['proxy_host', 'proxy_host'],
    ['代理地址', 'proxy_host'],
    ['proxy_port', 'proxy_port'],
    ['代理端口', 'proxy_port'],
    ['proxy_username', 'proxy_username'],
    ['代理用户名', 'proxy_username'],
    ['proxy_password', 'proxy_password'],
    ['代理密码', 'proxy_password'],
    ['front_proxy', 'front_proxy'],
    ['前置代理', 'front_proxy'],
    ['前置', 'front_proxy'],
    ['site', 'site'],
    ['站点', 'site'],
    ['account_label', 'account_label'],
    ['买家号', 'account_label'],
    ['买家号备注', 'account_label'],
    ['login_identifier', 'login_identifier'],
    ['登录账号', 'login_identifier'],
    ['登录邮箱', 'login_identifier'],
    ['手机号', 'login_identifier'],
    ['登录邮箱/手机号', 'login_identifier'],
    ['login_password', 'login_password'],
    ['登录密码', 'login_password'],
    ['expected_exit_ip', 'expected_exit_ip'],
    ['预期出口IP', 'expected_exit_ip'],
    ['auto_open_orders', 'auto_open_orders'],
    ['自动打开订单', 'auto_open_orders'],
    ['auto_fill_login', 'auto_fill_login'],
    ['登录页自动填充', 'auto_fill_login'],
  ])('%j → %s', (header, field) => {
    expect(resolveHeader(header)).toBe(field);
  });

  test.each([
    ['  Proxy_Host  ', 'proxy_host'],
    ['PROXY HOST', 'proxy_host'],
    ['proxy-host', 'proxy_host'],
    ['proxyHost', 'proxy_host'],
    ['Environment ID', 'environment_id'],
    ['预期出口ip', 'expected_exit_ip'],
    ['预期出口 IP', 'expected_exit_ip'],
    ['预期出口ＩＰ', 'expected_exit_ip'],
    ['代理端口（必填）', 'proxy_port'],
    ['代理端口(必填)', 'proxy_port'],
    ['环境名称*', 'display_name'],
  ])('tolerant matching: %j → %s', (header, field) => {
    expect(resolveHeader(header)).toBe(field);
  });

  test.each(['', '   ', 'password', 'username', 'notes', '备注', 'id'])('%j is not recognized', (header) => {
    expect(resolveHeader(header)).toBeNull();
  });

  test('every field has a label that resolves back to it', () => {
    for (const f of IMPORT_FIELDS) {
      expect(resolveHeader(IMPORT_FIELD_LABELS[f])).toBe(f);
      expect(resolveHeader(f)).toBe(f);
    }
  });

  test('aliases are unambiguous after normalization', () => {
    const seen = new Map<string, string>();
    for (const f of IMPORT_FIELDS) {
      for (const a of IMPORT_FIELD_ALIASES[f]) {
        const k = normalizeHeader(a);
        expect(seen.get(k) ?? f).toBe(f);
        seen.set(k, f);
      }
    }
  });
});

describe('mapHeader', () => {
  test('maps known columns and leaves blanks as null', () => {
    const m = mapHeader(['环境名称', '', '代理地址', 'proxy_port']);
    expect(m.errors).toEqual([]);
    expect(m.columns).toEqual(['display_name', null, 'proxy_host', 'proxy_port']);
  });

  test('unknown header is a file error naming only the column position', () => {
    const m = mapHeader(['环境名称', '代理地址', '代理端口', 'SecretLooking123']);
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]!.field).toBe('header');
    expect(m.errors[0]!.message).toContain('第 4 列（D 列）');
    expect(m.errors[0]!.message).not.toContain('SecretLooking123');
  });

  test('duplicate header (two aliases of the same field) is a file error', () => {
    const m = mapHeader(['环境名称', '代理地址', 'proxy_host', '代理端口']);
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]!.message).toContain('第 2 列');
    expect(m.errors[0]!.message).toContain('第 3 列');
    expect(m.errors[0]!.message).toContain('代理地址');
  });

  test('exact duplicate header is a file error', () => {
    expect(mapHeader(['环境名称', '环境名称', '代理地址', '代理端口']).errors).toHaveLength(1);
  });

  test('missing required columns are reported', () => {
    const m = mapHeader(['环境名称']);
    expect(m.errors.map((e) => e.message)).toEqual(['缺少必需的列「代理地址」', '缺少必需的列「代理端口」']);
  });

  test('a data row used as header produces one generic error without echoing values', () => {
    const m = mapHeader(['示例-买家01', '203.0.113.10', '1080', 'MarkerPass77']);
    expect(m.errors).toHaveLength(1);
    expect(JSON.stringify(m.errors)).not.toContain('MarkerPass77');
    expect(JSON.stringify(m.errors)).not.toContain('203.0.113.10');
  });
});
