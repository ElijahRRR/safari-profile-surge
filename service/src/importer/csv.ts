// RFC 4180 CSV 解析：UTF-8（可带 BOM）、CRLF/LF/CR、带引号字段（"" 转义、内嵌换行）。
// 只做切分，从不求值：以 = + - @ 开头的单元格就是普通文本。行号按记录计（内嵌换行不增加行号），
// 与 Excel 打开该文件时看到的行号一致。

import { IMPORT_LIMITS, rejectImport, isBlankCells, type RawRecord, type RawTable } from './table.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** 字节 → 文本；非 UTF-8（含 UTF-16、GBK）整体拒绝，避免乱码写进环境数据。 */
export function decodeUtf8Text(bytes: Uint8Array, kind: 'CSV' | 'JSON'): string {
  if (bytes.byteLength > IMPORT_LIMITS.textMaxBytes) {
    rejectImport(`导入失败：${kind} 文件超过 5 MB`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    rejectImport(`导入失败：${kind} 文件不是 UTF-8 编码，请另存为「CSV UTF-8」或 UTF-8 文本后重试`);
  }
}

export function parseCsv(input: Uint8Array | string): RawTable {
  let text: string;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > IMPORT_LIMITS.textMaxBytes) rejectImport('导入失败：CSV 文件超过 5 MB');
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  } else {
    text = decodeUtf8Text(input, 'CSV');
  }

  const records: RawRecord[] = [];
  const n = text.length;
  let i = 0;
  let row = 1;
  let cells: string[] = [];
  let problem: string | undefined;
  let nonBlank = 0;

  const endRecord = () => {
    if (cells.length > IMPORT_LIMITS.maxColumns) {
      rejectImport(`导入失败：第 ${row} 行超过 ${IMPORT_LIMITS.maxColumns} 列`);
    }
    if (!isBlankCells(cells) || problem !== undefined) {
      nonBlank++;
      // 表头一行 + 最多 2000 行数据
      if (nonBlank > IMPORT_LIMITS.maxDataRows + 1) {
        rejectImport(`导入失败：数据超过 ${IMPORT_LIMITS.maxDataRows} 行，请拆分后分批导入`);
      }
      records.push(problem === undefined ? { row, cells } : { row, cells, problem });
    }
    row++;
    cells = [];
    problem = undefined;
  };

  /** 跳过一个换行（CRLF、LF 或单独的 CR）；返回是否跳过。 */
  const skipNewline = (): boolean => {
    const c = text[i];
    if (c === '\r') {
      i += text[i + 1] === '\n' ? 2 : 1;
      return true;
    }
    if (c === '\n') {
      i += 1;
      return true;
    }
    return false;
  };

  while (i < n) {
    let value: string;
    if (text[i] === '"') {
      const startRow = row;
      i++;
      value = '';
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) rejectImport(`导入失败：第 ${startRow} 行的引号没有闭合`);
        value += text.slice(i, q);
        if (text[q + 1] === '"') {
          value += '"';
          i = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
      if (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        // 引号闭合后还有字符：该行结构不可信，读到分隔符为止并整行标记为错误。
        problem ??= `第 ${row} 行第 ${cells.length + 1} 列的引号后还有多余字符`;
        while (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') i++;
      }
    } else {
      let j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\r' && text[j] !== '\n') j++;
      // 字段中间出现的引号按普通字符处理（与 Excel 一致）。
      value = text.slice(i, j);
      i = j;
    }
    cells.push(value);
    if (i >= n) {
      endRecord();
      break;
    }
    if (text[i] === ',') {
      i++;
      if (i >= n) {
        // 文件以逗号结尾：最后还有一个空字段。
        cells.push('');
        endRecord();
      }
      continue;
    }
    skipNewline();
    endRecord();
  }

  return { records };
}
