// 导入模板：中文表头覆盖全部字段 + 一行明显的合成示例（文档专用地址 203.0.113.0/24、example.test 域名）。
// 带 UTF-8 BOM，Excel 双击打开时不会按本地编码误读中文。

import { IMPORT_FIELDS, IMPORT_FIELD_LABELS, type ImportField } from './columns.js';

const EXAMPLE_ROW: Record<ImportField, string> = {
  environment_id: '',
  display_name: '示例-买家01',
  proxy_type: 'socks5',
  proxy_host: '203.0.113.10',
  proxy_port: '1080',
  proxy_username: 'example-user',
  proxy_password: 'example-pass',
  front_proxy: '',
  site: 'US',
  account_label: '示例买家号',
  login_identifier: 'buyer01@example.test',
  login_password: 'example-only',
  expected_exit_ip: '203.0.113.20',
  auto_open_orders: '是',
  auto_fill_login: '否',
};

/** RFC 4180 转义：含逗号、引号、换行或首尾空白时加引号。 */
export function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function importTemplateCsv(): string {
  const header = IMPORT_FIELDS.map((f) => csvCell(IMPORT_FIELD_LABELS[f]));
  const example = IMPORT_FIELDS.map((f) => csvCell(EXAMPLE_ROW[f]));
  return `﻿${header.join(',')}\r\n${example.join(',')}\r\n`;
}
