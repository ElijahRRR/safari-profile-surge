// 表头 → ImportRecord 字段。中英文别名；匹配时去掉首尾空白、忽略大小写、全角半角、空格/下划线/连字符，
// 并忽略末尾的「（必填）」「(可选)」或 * 标记。未知表头与重复表头都是文件错误：宁可让用户改表头，
// 也不猜测某列的含义（猜错可能把密码当作展示名显示出来）。错误只指出列位置，不回显表头文字，
// 因为缺少表头的文件会把第一行数据（可能含密码）当作表头。

import type { FieldError, ImportRecord } from '@sfe/contract';
import { columnLetter } from './table.js';

export type ImportField = keyof ImportRecord;

export const IMPORT_FIELDS = [
  'environment_id',
  'display_name',
  'proxy_type',
  'proxy_host',
  'proxy_port',
  'proxy_username',
  'proxy_password',
  'front_proxy',
  'site',
  'account_label',
  'login_identifier',
  'login_password',
  'expected_exit_ip',
  'auto_open_orders',
  'auto_fill_login',
] as const satisfies readonly ImportField[];

/** 秘密字段：只能替换或保留，错误与预览中从不出现其值。 */
export const IMPORT_SECRET_FIELDS: readonly ImportField[] = ['proxy_password', 'login_password', 'proxy_username'];

/** 缺少这些列时整个文件无法使用。 */
export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = ['display_name', 'proxy_host', 'proxy_port'];

/** 模板与错误提示使用的中文列名（第一个别名即模板表头）。 */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  environment_id: '环境编号',
  display_name: '环境名称',
  proxy_type: '代理类型',
  proxy_host: '代理地址',
  proxy_port: '代理端口',
  proxy_username: '代理用户名',
  proxy_password: '代理密码',
  front_proxy: '前置代理',
  site: '站点',
  account_label: '买家号备注',
  login_identifier: '登录账号',
  login_password: '登录密码',
  expected_exit_ip: '预期出口IP',
  auto_open_orders: '自动打开订单',
  auto_fill_login: '登录页自动填充',
};

export const IMPORT_FIELD_ALIASES: Record<ImportField, readonly string[]> = {
  environment_id: ['environment_id', 'env_id', '环境ID', '环境编号', '环境编码'],
  display_name: ['display_name', 'name', 'environment_name', 'env_name', '环境名称', '名称', '环境名'],
  proxy_type: ['proxy_type', 'proxy_protocol', 'protocol', '代理类型', '代理协议', '协议'],
  proxy_host: ['proxy_host', 'proxy_address', 'proxy_server', 'host', 'server', '代理地址', '代理主机', '代理服务器', '代理IP'],
  proxy_port: ['proxy_port', 'port', '代理端口', '端口'],
  proxy_username: ['proxy_username', 'proxy_user', '代理用户名', '代理账号', '代理用户'],
  proxy_password: ['proxy_password', 'proxy_pass', '代理密码'],
  front_proxy: ['front_proxy', 'front_proxy_id', 'front', 'underlying_proxy', '前置代理', '前置', '前置节点'],
  site: ['site', 'amazon_site', 'marketplace', '站点', 'Amazon站点', '亚马逊站点'],
  account_label: ['account_label', 'buyer_label', 'buyer', '买家号', '买家号备注', '买家号标识'],
  login_identifier: [
    'login_identifier',
    'login',
    'login_id',
    'login_email',
    'login_phone',
    'email',
    'phone',
    '登录账号',
    '登录邮箱',
    '手机号',
    '登录手机号',
    '登录邮箱/手机号',
    '登录邮箱或手机号',
    '邮箱',
  ],
  login_password: ['login_password', 'account_password', '登录密码', '账号密码', '买家号密码'],
  expected_exit_ip: ['expected_exit_ip', 'expected_ip', 'exit_ip', '预期出口IP', '预期出口', '出口IP'],
  auto_open_orders: ['auto_open_orders', 'open_orders', '自动打开订单', '打开订单'],
  auto_fill_login: ['auto_fill_login', 'autofill', 'auto_fill', '登录页自动填充', '自动填充', '自动填充登录'],
};

/** 表头规范化：NFKC（全角转半角）、去掉末尾必填/可选标记、忽略大小写与空格/下划线/连字符。 */
export function normalizeHeader(raw: string): string {
  let s = raw.normalize('NFKC').trim();
  s = s.replace(/[*＊]+$/u, '').trim();
  s = s.replace(/[（(][^（）()]*[）)]$/u, '').trim();
  return s.toLowerCase().replace(/[\s_\-]+/g, '');
}

const ALIAS_INDEX: ReadonlyMap<string, ImportField> = (() => {
  const m = new Map<string, ImportField>();
  for (const field of IMPORT_FIELDS) {
    for (const alias of IMPORT_FIELD_ALIASES[field]) {
      const key = normalizeHeader(alias);
      const prev = m.get(key);
      if (prev !== undefined && prev !== field) throw new Error(`import alias collision: ${alias}`);
      m.set(key, field);
    }
  }
  return m;
})();

export function resolveHeader(raw: string): ImportField | null {
  const key = normalizeHeader(raw);
  if (key === '') return null;
  return ALIAS_INDEX.get(key) ?? null;
}

export interface HeaderMapping {
  /** 每列对应的字段；null 表示空表头（该列整列为空时忽略）。 */
  columns: Array<ImportField | null>;
  errors: FieldError[];
}

function colName(index0: number): string {
  return `第 ${index0 + 1} 列（${columnLetter(index0 + 1)} 列）`;
}

/** 映射表头。errors 非空时整个文件不能导入。 */
export function mapHeader(header: readonly string[]): HeaderMapping {
  const columns: Array<ImportField | null> = [];
  const errors: FieldError[] = [];
  const firstIndex = new Map<ImportField, number>();
  let recognized = 0;
  const unknown: number[] = [];
  header.forEach((raw, i) => {
    if (raw.trim() === '') {
      columns.push(null);
      return;
    }
    const field = resolveHeader(raw);
    if (field === null) {
      unknown.push(i);
      columns.push(null);
      return;
    }
    recognized++;
    const prev = firstIndex.get(field);
    if (prev !== undefined) {
      errors.push({
        field: 'header',
        message: `${colName(prev)}与${colName(i)}都对应「${IMPORT_FIELD_LABELS[field]}」，请删除重复的列`,
      });
    } else {
      firstIndex.set(field, i);
    }
    columns.push(field);
  });
  if (recognized === 0) {
    // 很可能缺少表头行：不逐列报错，避免把第一行数据当作表头文字回显。
    return { columns, errors: [{ field: 'header', message: '第一行没有可识别的列名，请使用导入模板的表头' }] };
  }
  for (const i of unknown) {
    errors.push({ field: 'header', message: `${colName(i)}的列名无法识别，请使用导入模板中的列名` });
  }
  for (const f of REQUIRED_IMPORT_FIELDS) {
    if (!firstIndex.has(f)) errors.push({ field: 'header', message: `缺少必需的列「${IMPORT_FIELD_LABELS[f]}」` });
  }
  return { columns, errors };
}
