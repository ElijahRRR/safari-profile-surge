// 各格式解析器的共同产物与限制。解析器只产出“表格”，表头映射与逐行校验在 index.ts 统一完成。

import { SfeError } from '@sfe/contract';

export const IMPORT_LIMITS = {
  /** CSV 与 JSON 文本的最大字节数。 */
  textMaxBytes: 5 * 1024 * 1024,
  /** XLSX 文件本身（压缩后）的最大字节数。 */
  xlsxMaxBytes: 10 * 1024 * 1024,
  maxDataRows: 2000,
  maxColumns: 64,
} as const;

export interface RawRecord {
  /** 用户看到的行号：表头为第 1 行（或其实际所在行），数据从下一行起。 */
  row: number;
  cells: string[];
  /** 该行本身结构有问题（例如引号后有多余字符）；index.ts 把它记为行错误，不读取该行内容。 */
  problem?: string;
}

export interface RawTable {
  /** 非空行（含表头，表头是第一条）。全空的行已跳过，但行号保持文件中的实际位置。 */
  records: RawRecord[];
}

/** 整个文件拒绝导入。消息不含任何单元格内容。 */
export function rejectImport(message: string): never {
  throw new SfeError('IMPORT_REJECTED', message, { fieldErrors: [{ field: 'file', message }] });
}

export function isBlankCells(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/** 1 → A，27 → AA；用于在错误中指出列位置而不回显表头文字。 */
export function columnLetter(index1: number): string {
  let n = index1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
