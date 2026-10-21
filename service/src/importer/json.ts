// JSON 导入（GPT/脚本使用）：记录数组，或 { "environments": [...] }（也接受网页与 sfe 早先使用的
// { "records": [...] }）。键名与表格表头使用同一套别名；值只能是文本、数字、布尔或 null，
// 嵌套对象/数组一律无效（不递归解释）。网页、sfe 与 agent 都经这里解析，形状与 BOM 处理一致。

import type { FieldError, ImportRecord } from '@sfe/contract';
import { IMPORT_FIELD_LABELS, resolveHeader, type ImportField } from './columns.js';
import { IMPORT_LIMITS, rejectImport } from './table.js';

export interface JsonImportRow {
  /** 记录序号 + 1。 */
  row: number;
  record: ImportRecord;
  /** 结构问题（未知字段、重复字段、非基本类型的值）；为整条记录的错误。 */
  errors: FieldError[];
  /** 记录本身不是对象：不读取任何内容。 */
  notObject: boolean;
}

const SHAPE_MESSAGE = '导入失败：JSON 必须是记录数组，或 { "environments": [...] }';

/** 安全回显 JSON 键名：只含字母、数字、汉字、空格、下划线、连字符且不长时才显示。 */
function describeKey(key: string, index: number): string {
  if (key.length <= 40 && /^[\p{L}\p{N} _-]+$/u.test(key)) return `「${key}」`;
  return `（第 ${index + 1} 个字段）`;
}

/** 已解析的 JSON 文档 → 记录数组。 */
export function extractJsonRecords(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (typeof doc === 'object' && doc !== null) {
    const keys = Object.keys(doc);
    const only = keys.length === 1 ? keys[0]! : null;
    const list = only === 'environments' || only === 'records' ? (doc as Record<string, unknown>)[only] : undefined;
    if (Array.isArray(list)) return list;
  }
  rejectImport(SHAPE_MESSAGE);
}

export function parseJsonText(text: string): unknown[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // 不回显解析器的错误文本：它可能引用文件片段。
    rejectImport('导入失败：JSON 格式不正确');
  }
  return extractJsonRecords(doc);
}

export function parseJsonRecords(records: readonly unknown[]): JsonImportRow[] {
  if (records.length > IMPORT_LIMITS.maxDataRows) {
    rejectImport(`导入失败：记录超过 ${IMPORT_LIMITS.maxDataRows} 条，请拆分后分批导入`);
  }
  return records.map((item, index) => {
    const row = index + 1;
    const prefix = `rows[${row}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return {
        row,
        record: { display_name: '', proxy_host: '', proxy_port: '' },
        errors: [{ field: prefix, message: `第 ${row} 条记录不是对象` }],
        notObject: true,
      };
    }
    const errors: FieldError[] = [];
    const out: Partial<Record<ImportField, unknown>> = {};
    const seen = new Set<ImportField>();
    Object.entries(item as Record<string, unknown>).forEach(([key, value], keyIndex) => {
      const field = resolveHeader(key);
      if (field === null) {
        errors.push({ field: prefix, message: `第 ${row} 条记录的字段${describeKey(key, keyIndex)}无法识别` });
        return;
      }
      if (seen.has(field)) {
        errors.push({ field: `${prefix}.${field}`, message: `第 ${row} 条记录有多个字段对应「${IMPORT_FIELD_LABELS[field]}」` });
        return;
      }
      seen.add(field);
      const t = typeof value;
      if (value !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
        errors.push({ field: `${prefix}.${field}`, message: `「${IMPORT_FIELD_LABELS[field]}」只能是文本、数字、布尔值或 null` });
        return;
      }
      out[field] = value;
    });
    const record = {
      display_name: '',
      proxy_host: '',
      proxy_port: '',
      ...out,
    } as unknown as ImportRecord;
    return { row, record, errors, notObject: false };
  });
}
