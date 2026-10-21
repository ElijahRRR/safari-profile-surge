// 导入入口：解码 → 解析为表格或记录 → 表头映射 → 逐行规范化与校验 → 文件内重复检查。
// 整个文件不可读或不安全时抛 SfeError('IMPORT_REJECTED')（422）；请求形状不对抛 BAD_REQUEST；
// 表头问题放在 fileErrors（此时不返回任何行）；行内问题放在各行 normalized.errors。
// 返回的 record 含秘密明文（引擎写钥匙串需要）：调用方不得记录日志或原样返回给客户端。

import { SfeError, isSiteCode, type FieldError, type ImportFormat, type ImportRecord, type SiteCode } from '@sfe/contract';
import { mapHeader, type ImportField } from './columns.js';
import { decodeUtf8Text, parseCsv } from './csv.js';
import { parseJsonRecords, parseJsonText } from './json.js';
import { displayNameKey, normalizeRecord, type NormalizedRecord } from './normalize.js';
import { IMPORT_LIMITS, columnLetter, rejectImport, type RawTable } from './table.js';
import { readXlsx } from './xlsx.js';

export { importTemplateCsv } from './template.js';
export {
  IMPORT_FIELDS,
  IMPORT_FIELD_ALIASES,
  IMPORT_FIELD_LABELS,
  IMPORT_SECRET_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  mapHeader,
  resolveHeader,
  type ImportField,
} from './columns.js';
export { displayNameKey, normalizeRecord, parseImportBoolean, resolveSite, type NormalizedRecord, type NormalizeOptions } from './normalize.js';
export { IMPORT_LIMITS } from './table.js';
export { XLSX_LIMITS } from './xlsx.js';

export interface ParseImportRequest {
  format: ImportFormat;
  content_base64?: string;
  records?: unknown[];
  default_site?: SiteCode | null;
}

export interface ParsedImportRow {
  /** 用户看到的行号：表格中表头为第 1 行、数据从第 2 行起；JSON 为序号 + 1。 */
  row: number;
  /** 原始记录（含秘密明文）。结构有问题的行为空占位记录，不含文件内容。 */
  record: ImportRecord;
  normalized: NormalizedRecord;
  /** 没有环境编号、且与文件中其他行同名：引擎应把它记为 conflict，从不按名称合并。 */
  duplicateNameInFile: boolean;
}

export interface ParsedImport {
  rows: ParsedImportRow[];
  fileErrors: FieldError[];
}

const FORMATS: readonly ImportFormat[] = ['csv', 'xlsx', 'json'];

function emptyRecord(): ImportRecord {
  return { display_name: '', proxy_host: '', proxy_port: '' };
}

/** 结构有问题的行：不读取其单元格（列可能错位，秘密可能落进普通字段），只报告行错误。 */
function brokenRow(row: number, message: string, defaultSite: SiteCode | null): ParsedImportRow {
  const record = emptyRecord();
  const base = normalizeRecord(record, { defaultSite, row });
  return {
    row,
    record,
    normalized: { ...base, environmentId: null, frontProxyRef: null, errors: [{ field: `rows[${row}]`, message }] },
    duplicateNameInFile: false,
  };
}

function decodeBase64(content: string | undefined, maxBytes: number): Buffer {
  if (typeof content !== 'string' || content.length === 0) {
    throw new SfeError('BAD_REQUEST', '导入失败：缺少文件内容');
  }
  const s = content.replace(/^data:[^,]{0,200};base64,/i, '').replace(/\s+/g, '');
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new SfeError('BAD_REQUEST', '导入失败：文件内容不是有效的 base64');
  }
  // 先按长度估算，超限时不解码。
  if ((s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0) > maxBytes) {
    rejectImport(`导入失败：文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  return Buffer.from(s, 'base64');
}

function tableToRows(table: RawTable, defaultSite: SiteCode | null): ParsedImport {
  const [header, ...data] = table.records;
  if (!header) return { rows: [], fileErrors: [{ field: 'file', message: '文件中没有内容' }] };
  if (header.problem !== undefined) {
    return { rows: [], fileErrors: [{ field: 'header', message: `表头行结构不正确：${header.problem}` }] };
  }
  const mapping = mapHeader(header.cells);
  const fileErrors = [...mapping.errors];
  const width = header.cells.length;
  for (let i = 0; i < width; i++) {
    if (header.cells[i]!.trim() !== '') continue;
    if (data.some((d) => d.cells.length === width && (d.cells[i] ?? '').trim() !== '')) {
      fileErrors.push({ field: 'header', message: `第 ${i + 1} 列（${columnLetter(i + 1)} 列）有数据但没有列名` });
    }
  }
  if (fileErrors.length > 0) return { rows: [], fileErrors };
  if (data.length === 0) return { rows: [], fileErrors: [{ field: 'file', message: '文件中没有数据行' }] };

  const rows = data.map((rec): ParsedImportRow => {
    if (rec.problem !== undefined) return brokenRow(rec.row, rec.problem, defaultSite);
    if (rec.cells.length !== width) {
      return brokenRow(rec.row, `第 ${rec.row} 行有 ${rec.cells.length} 列，表头有 ${width} 列：请检查是否有未加引号的逗号`, defaultSite);
    }
    const out: Partial<Record<ImportField, string>> = {};
    mapping.columns.forEach((field, i) => {
      if (field !== null) out[field] = rec.cells[i] ?? '';
    });
    const record = { ...emptyRecord(), ...out } as ImportRecord;
    return { row: rec.row, record, normalized: normalizeRecord(record, { defaultSite, row: rec.row }), duplicateNameInFile: false };
  });
  return { rows, fileErrors: [] };
}

function jsonToRows(records: readonly unknown[], defaultSite: SiteCode | null): ParsedImport {
  const parsed = parseJsonRecords(records);
  if (parsed.length === 0) return { rows: [], fileErrors: [{ field: 'file', message: '没有任何记录' }] };
  const rows = parsed.map((p): ParsedImportRow => {
    if (p.notObject) return brokenRow(p.row, p.errors[0]!.message, defaultSite);
    const normalized = normalizeRecord(p.record, { defaultSite, row: p.row });
    if (p.errors.length > 0) normalized.errors = [...p.errors, ...normalized.errors];
    return { row: p.row, record: p.record, normalized, duplicateNameInFile: false };
  });
  return { rows, fileErrors: [] };
}

/** 文件内检查：同一环境编号出现多次 → 这些行都无效；无编号的同名行 → 都标记 duplicateNameInFile。 */
function markDuplicates(rows: ParsedImportRow[]): void {
  const byId = new Map<string, ParsedImportRow[]>();
  const byName = new Map<string, ParsedImportRow[]>();
  for (const r of rows) {
    const id = r.normalized.environmentId;
    if (id !== null) {
      byId.set(id, [...(byId.get(id) ?? []), r]);
      continue;
    }
    // 编号格式不正确的行不参与同名判断：它本来就无效。
    if (!r.normalized.blankFields.includes('environment_id')) continue;
    const name = r.normalized.input.displayName;
    if (typeof name !== 'string' || name.trim() === '') continue;
    const key = displayNameKey(name);
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      const others = group.filter((o) => o !== r).map((o) => o.row);
      const shown = others.slice(0, 5).join('、');
      const more = others.length > 5 ? ` 等 ${others.length} 行` : ' 行';
      r.normalized.errors.push({
        field: `rows[${r.row}].environment_id`,
        message: `环境编号在文件中重复（另见第 ${shown}${more}）`,
      });
    }
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const r of group) r.duplicateNameInFile = true;
  }
}

export function parseImport(req: ParseImportRequest): ParsedImport {
  if (typeof req !== 'object' || req === null || !FORMATS.includes(req.format)) {
    throw new SfeError('BAD_REQUEST', '导入失败：文件格式只能是 csv、xlsx 或 json');
  }
  const extraErrors: FieldError[] = [];
  let defaultSite: SiteCode | null = null;
  if (req.default_site !== undefined && req.default_site !== null) {
    if (isSiteCode(req.default_site)) defaultSite = req.default_site;
    else extraErrors.push({ field: 'default_site', message: '默认站点不受支持：首版只支持 Amazon 美国站' });
  }

  let result: ParsedImport;
  if (req.format === 'json') {
    if (req.records !== undefined && req.content_base64 !== undefined) {
      throw new SfeError('BAD_REQUEST', '导入失败：只能提供文件内容或记录其中之一');
    }
    let records: readonly unknown[];
    if (req.records !== undefined) {
      if (!Array.isArray(req.records)) throw new SfeError('BAD_REQUEST', '导入失败：records 必须是数组');
      records = req.records;
    } else {
      const bytes = decodeBase64(req.content_base64, IMPORT_LIMITS.textMaxBytes);
      records = parseJsonText(decodeUtf8Text(bytes, 'JSON'));
    }
    result = jsonToRows(records, defaultSite);
  } else {
    if (req.records !== undefined) throw new SfeError('BAD_REQUEST', '导入失败：表格文件请上传文件内容');
    if (req.format === 'csv') {
      const bytes = decodeBase64(req.content_base64, IMPORT_LIMITS.textMaxBytes);
      result = tableToRows(parseCsv(bytes), defaultSite);
    } else {
      const bytes = decodeBase64(req.content_base64, IMPORT_LIMITS.xlsxMaxBytes);
      result = tableToRows(readXlsx(bytes), defaultSite);
    }
  }

  markDuplicates(result.rows);
  return { rows: result.rows, fileErrors: [...extraErrors, ...result.fileErrors] };
}
