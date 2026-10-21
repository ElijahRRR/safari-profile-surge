// 最小、安全的 XLSX 读取：自己解析 ZIP 中央目录，用 inflateRawSync 按声明大小上限解压，
// 只读取工作簿、关系、共享字符串与工作表 XML。凡含公式、外部链接、宏、加密、DTD/实体声明或
// 超出限制的文件整体拒绝（IMPORT_REJECTED），从不执行或展开其中任何内容。

import { crc32, inflateRawSync } from 'node:zlib';
import { IMPORT_LIMITS, rejectImport, type RawRecord, type RawTable } from './table.js';
import { XmlError, attrByLocal, localName, parseXmlTree, xmlEvents, type XmlElement } from './xml.js';

export const XLSX_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxRatio: 200,
} as const;

/** 选择工作表时优先使用的名称（不区分大小写、去掉首尾空白）。 */
export const PREFERRED_SHEET_NAMES = ['environments', '环境'] as const;

const MSG = {
  notXlsx: '导入失败：不是有效的 XLSX 文件',
  corrupt: '导入失败：XLSX 文件已损坏',
  encrypted: '导入失败：文件已加密或是旧版 .xls 格式，请取消密码保护并另存为 .xlsx 后重试',
  macro: '导入失败：文件包含宏，导入不执行宏，请另存为不含宏的 .xlsx 后重试',
  external: '导入失败：文件包含外部链接或外部数据连接，导入不读取外部数据，请改为纯文本值后重试',
  dtd: '导入失败：文件包含 DTD 或实体声明',
  zip64: '导入失败：不支持 ZIP64 或分卷格式的文件',
  tooLarge: `导入失败：XLSX 文件超过 ${IMPORT_LIMITS.xlsxMaxBytes / 1024 / 1024} MB`,
  tooManyEntries: `导入失败：文件内部条目超过 ${XLSX_LIMITS.maxEntries} 个`,
  entryTooLarge: `导入失败：文件中单个部件解压后超过 ${XLSX_LIMITS.maxEntryBytes / 1024 / 1024} MB`,
  totalTooLarge: `导入失败：文件解压后总大小超过 ${XLSX_LIMITS.maxTotalBytes / 1024 / 1024} MB`,
  ratio: '导入失败：文件压缩比异常，已按压缩炸弹拒绝',
  method: '导入失败：文件使用了不受支持的压缩方式',
  tooManyRows: `导入失败：数据超过 ${IMPORT_LIMITS.maxDataRows} 行，请拆分后分批导入`,
  noSheet: '导入失败：工作簿中没有可读取的工作表',
} as const;

export function formulaMessage(row: number, sheetName: string | null): string {
  const where = sheetName === null ? '' : `工作表「${sheetName}」`;
  return `${where}第 ${row} 行包含公式，导入不执行公式，请改为纯文本值`;
}

// ---------- ZIP ----------

interface ZipEntry {
  name: string;
  lower: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  nameBytes: Buffer;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0];

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === SIG_EOCD) return p;
  }
  return -1;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function readZipDirectory(buf: Buffer): { entries: ZipEntry[]; cdOffset: number } {
  if (buf.length < 22) rejectImport(MSG.notXlsx);
  const eocd = findEocd(buf);
  if (eocd < 0) rejectImport(MSG.notXlsx);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== total || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    rejectImport(MSG.zip64);
  }
  if (total > XLSX_LIMITS.maxEntries) rejectImport(MSG.tooManyEntries);
  if (cdOffset + cdSize > eocd) rejectImport(MSG.corrupt);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CEN) rejectImport(MSG.corrupt);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > eocd) rejectImport(MSG.corrupt);
    const nameBytes = buf.subarray(p + 46, nameEnd);
    let name: string;
    try {
      name = utf8Strict.decode(nameBytes);
    } catch {
      rejectImport(MSG.corrupt);
    }
    p = nameEnd + extraLen + commentLen;

    // 传统 ZIP 加密（位 0）与强加密（位 6）
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) rejectImport(MSG.encrypted);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) rejectImport(MSG.zip64);
    if (method !== 0 && method !== 8) rejectImport(MSG.method);
    if (name.length === 0) rejectImport(MSG.corrupt);
    const lower = name.toLowerCase();
    if (seen.has(lower)) rejectImport(MSG.corrupt);
    seen.add(lower);
    if (uncompressedSize > XLSX_LIMITS.maxEntryBytes) rejectImport(MSG.entryTooLarge);
    totalBytes += uncompressedSize;
    if (totalBytes > XLSX_LIMITS.maxTotalBytes) rejectImport(MSG.totalTooLarge);
    if (method === 0 && compressedSize !== uncompressedSize) rejectImport(MSG.corrupt);
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > XLSX_LIMITS.maxRatio)) {
      rejectImport(MSG.ratio);
    }
    entries.push({ name, lower, flags, method, crc, compressedSize, uncompressedSize, localOffset, nameBytes });
  }
  return { entries, cdOffset };
}

function readEntry(buf: Buffer, entry: ZipEntry, cdOffset: number): Buffer {
  const off = entry.localOffset;
  if (off + 30 > cdOffset || buf.readUInt32LE(off) !== SIG_LOC) rejectImport(MSG.corrupt);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const localName = buf.subarray(off + 30, off + 30 + nameLen);
  if (!localName.equals(entry.nameBytes)) rejectImport(MSG.corrupt);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > cdOffset) rejectImport(MSG.corrupt);
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(raw);
  } else {
    try {
      // 以声明大小为上限：实际解压超出即中止，不会先把炸弹完整展开。
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch {
      rejectImport(MSG.corrupt);
    }
  }
  if (out.length !== entry.uncompressedSize) rejectImport(MSG.corrupt);
  if (crc32(out) >>> 0 !== entry.crc >>> 0) rejectImport(MSG.corrupt);
  return out;
}

// ---------- 部件 ----------

function decodePart(bytes: Buffer): string {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    return utf8Strict.decode(bytes);
  } catch {
    rejectImport(MSG.corrupt);
  }
}

const DTD_RE = /<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i;
const XML_PART_RE = /\.(?:xml|rels|vml)$/i;

function isMacroName(lower: string): boolean {
  return /(^|\/)vbaproject\.bin$/.test(lower) || /(^|\/)vbaprojectsignature[^/]*\.bin$/.test(lower) || lower.startsWith('xl/macrosheets/');
}

function isExternalName(lower: string): boolean {
  return lower.startsWith('xl/externallinks/') || lower === 'xl/connections.xml';
}

function isEncryptedName(lower: string): boolean {
  return /(^|\/)(encryptedpackage|encryptioninfo)$/.test(lower);
}

function isMacroContentType(ct: string): boolean {
  return /macroenabled|vbaproject|macrosheet/i.test(ct);
}

function parseTreeOrReject(text: string): XmlElement {
  try {
    return parseXmlTree(text);
  } catch (e) {
    if (e instanceof XmlError && e.reason === 'dtd') rejectImport(MSG.dtd);
    rejectImport(MSG.corrupt);
  }
}

function children(el: XmlElement, local: string): XmlElement[] {
  return el.children.filter((c) => c.local === local);
}

function* descendants(el: XmlElement): Generator<XmlElement> {
  for (const c of el.children) {
    yield c;
    yield* descendants(c);
  }
}

/** OPC 关系目标 → 包内路径（小写，用于查找）。越出包根即视为损坏。 */
function resolvePart(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : baseDir === '' ? target : `${baseDir}/${target}`;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) rejectImport(MSG.corrupt);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/').toLowerCase();
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function relsPathFor(partPath: string): string {
  const dir = dirOf(partPath);
  const file = partPath.slice(dir.length === 0 ? 0 : dir.length + 1);
  return `${dir === '' ? '' : `${dir}/`}_rels/${file}.rels`;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function readRelationships(parts: Map<string, string>, partPath: string): Relationship[] {
  const text = parts.get(relsPathFor(partPath));
  if (text === undefined) return [];
  const root = parseTreeOrReject(text);
  return children(root, 'Relationship').map((r) => ({
    id: r.attrs['Id'] ?? '',
    type: r.attrs['Type'] ?? '',
    target: r.attrs['Target'] ?? '',
    external: (r.attrs['TargetMode'] ?? '').toLowerCase() === 'external',
  }));
}

// ---------- 单元格 ----------

function unescapeOoxml(s: string): string {
  // Excel 把控制字符等写成 _xHHHH_（_x005F_ 表示下划线本身）。
  return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) : s;
}

/** 数字按文本给出：整数不带小数或指数（避免浮点噪声），其他保留 15 位有效数字。 */
export function formatXlsxNumber(raw: string): string {
  const t = raw.trim();
  if (t === '') return '';
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  if (Number.isInteger(n)) return BigInt(n).toString();
  return String(Number(n.toPrecision(15)));
}

function parseSharedStrings(text: string): string[] {
  const out: string[] = [];
  let inSi = false;
  let cur = '';
  let rPh = 0;
  let inT = false;
  try {
    for (const ev of xmlEvents(text)) {
      if (ev.type === 'open') {
        const l = localName(ev.name);
        if (l === 'si') {
          inSi = true;
          cur = '';
        } else if (l === 'rPh') rPh++;
        else if (l === 't' && inSi && rPh === 0) inT = true;
      } else if (ev.type === 'close') {
        const l = localName(ev.name);
        if (l === 'si') {
          out.push(unescapeOoxml(cur));
          inSi = false;
        } else if (l === 'rPh') rPh--;
        else if (l === 't') inT = false;
      } else if (inT) {
        cur += ev.text;
      }
    }
  } catch (e) {
    if (e instanceof XmlError && e.reason === 'dtd') rejectImport(MSG.dtd);
    rejectImport(MSG.corrupt);
  }
  return out;
}

const MAX_SHEET_ROW = 1048576;
const MAX_SHEET_COL = 16384;

function parseCellRef(ref: string): { col: number; row: number | null } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{0,7})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = m[2] ? Number(m[2]) : null;
  if (col < 1 || col > MAX_SHEET_COL || (row !== null && (row < 1 || row > MAX_SHEET_ROW))) return null;
  return { col, row };
}

interface CellState {
  row: number;
  col: number;
  type: string;
  v: string;
  inline: string;
  inV: boolean;
  inIs: boolean;
  inT: boolean;
  rPh: number;
}

/**
 * 流式读取工作表。collect=false 时只检查公式（用于未选中的工作表）。
 * 返回非空单元格：行号 → (列号 → 文本)。
 */
function parseWorksheet(
  text: string,
  sharedStrings: string[],
  opts: { collect: boolean; sheetLabel: string | null },
): Map<number, Map<number, string>> {
  const rows = new Map<number, Map<number, string>>();
  let inSheetData = false;
  let currentRow = 0;
  let lastRow = 0;
  let lastCol = 0;
  let cell: CellState | null = null;

  const finishCell = (c: CellState) => {
    if (!opts.collect) return;
    let value: string;
    switch (c.type) {
      case 's': {
        const idx = c.v.trim();
        if (!/^\d+$/.test(idx)) rejectImport(MSG.corrupt);
        const s = sharedStrings[Number(idx)];
        if (s === undefined) rejectImport(MSG.corrupt);
        value = s;
        break;
      }
      case 'inlineStr':
        value = unescapeOoxml(c.inline);
        break;
      case 'b':
        value = c.v.trim() === '1' ? 'TRUE' : c.v.trim() === '0' ? 'FALSE' : c.v;
        break;
      case 'str':
        value = unescapeOoxml(c.v);
        break;
      case 'n':
        value = formatXlsxNumber(c.v);
        break;
      default:
        // e（错误值）、d（ISO 日期）等按原文本
        value = c.v;
    }
    if (value.trim() === '') return;
    if (c.col > IMPORT_LIMITS.maxColumns) rejectImport(`导入失败：第 ${c.row} 行超过 ${IMPORT_LIMITS.maxColumns} 列`);
    let r = rows.get(c.row);
    if (!r) {
      // 表头一行 + 最多 2000 行数据
      if (rows.size >= IMPORT_LIMITS.maxDataRows + 1) rejectImport(MSG.tooManyRows);
      r = new Map();
      rows.set(c.row, r);
    }
    r.set(c.col, value);
  };

  try {
    for (const ev of xmlEvents(text)) {
      if (ev.type === 'open') {
        const l = localName(ev.name);
        if (l === 'sheetData') {
          inSheetData = true;
        } else if (!inSheetData) {
          continue;
        } else if (l === 'row') {
          const r = ev.attrs['r'];
          let num: number;
          if (r !== undefined) {
            if (!/^\d{1,7}$/.test(r)) rejectImport(MSG.corrupt);
            num = Number(r);
          } else {
            num = lastRow + 1;
          }
          if (num < 1 || num > MAX_SHEET_ROW) rejectImport(MSG.corrupt);
          currentRow = num;
          lastRow = num;
          lastCol = 0;
        } else if (l === 'c') {
          const ref = ev.attrs['r'];
          let col = lastCol + 1;
          let row = currentRow;
          if (ref !== undefined) {
            const parsed = parseCellRef(ref);
            if (!parsed) rejectImport(MSG.corrupt);
            col = parsed.col;
            if (parsed.row !== null) row = parsed.row;
          }
          if (row < 1) rejectImport(MSG.corrupt);
          lastCol = col;
          cell = { row, col, type: ev.attrs['t'] ?? 'n', v: '', inline: '', inV: false, inIs: false, inT: false, rPh: 0 };
        } else if (cell) {
          if (l === 'f') rejectImport(formulaMessage(cell.row, opts.sheetLabel));
          else if (l === 'v') cell.inV = true;
          else if (l === 'is') cell.inIs = true;
          else if (l === 'rPh') cell.rPh++;
          else if (l === 't' && cell.inIs && cell.rPh === 0) cell.inT = true;
        }
      } else if (ev.type === 'close') {
        const l = localName(ev.name);
        if (l === 'sheetData') inSheetData = false;
        else if (!cell) continue;
        else if (l === 'c') {
          finishCell(cell);
          cell = null;
        } else if (l === 'v') cell.inV = false;
        else if (l === 'is') cell.inIs = false;
        else if (l === 'rPh') cell.rPh--;
        else if (l === 't') cell.inT = false;
      } else if (cell) {
        if (cell.inV) cell.v += ev.text;
        else if (cell.inT) cell.inline += ev.text;
      }
    }
  } catch (e) {
    if (e instanceof XmlError) rejectImport(e.reason === 'dtd' ? MSG.dtd : MSG.corrupt);
    throw e;
  }
  return rows;
}

function sanitizeSheetName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, 31).join('');
}

// ---------- 入口 ----------

export interface XlsxReadResult extends RawTable {
  /** 实际读取的工作表名。 */
  sheetName: string;
}

export function readXlsx(input: Uint8Array): XlsxReadResult {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length > IMPORT_LIMITS.xlsxMaxBytes) rejectImport(MSG.tooLarge);
  // OLE 复合文档：加密的 OOXML（EncryptedPackage）或旧版 .xls。
  if (buf.length >= 4 && CFB_SIG.every((b, i) => buf[i] === b)) rejectImport(MSG.encrypted);
  if (buf.length < 4 || buf.readUInt32LE(0) !== SIG_LOC) rejectImport(MSG.notXlsx);

  const { entries, cdOffset } = readZipDirectory(buf);

  for (const e of entries) {
    if (isEncryptedName(e.lower)) rejectImport(MSG.encrypted);
    if (isMacroName(e.lower)) rejectImport(MSG.macro);
    if (isExternalName(e.lower)) rejectImport(MSG.external);
  }

  // 解压并检查所有 XML 部件（不只是要读取的部件）：任何部件含 DTD/实体声明都拒绝整个文件。
  const parts = new Map<string, string>();
  for (const e of entries) {
    if (e.name.endsWith('/') || !XML_PART_RE.test(e.lower)) continue;
    const text = decodePart(readEntry(buf, e, cdOffset));
    if (DTD_RE.test(text)) rejectImport(MSG.dtd);
    parts.set(e.lower, text);
  }

  const ctText = parts.get('[content_types].xml');
  if (ctText === undefined) rejectImport(MSG.notXlsx);
  const ct = parseTreeOrReject(ctText);
  for (const el of ct.children) {
    const type = el.attrs['ContentType'] ?? '';
    if (isMacroContentType(type)) rejectImport(MSG.macro);
    if (/externallink|connections/i.test(type)) rejectImport(MSG.external);
  }

  // 主部件：_rels/.rels 的 officeDocument 关系，缺省 xl/workbook.xml。
  const rootRels = readRelationships(parts, '');
  const officeRel = rootRels.find((r) => r.type.endsWith('/officeDocument') && !r.external);
  const workbookPath = officeRel ? resolvePart('', officeRel.target) : 'xl/workbook.xml';
  const wbText = parts.get(workbookPath);
  if (wbText === undefined) rejectImport(MSG.notXlsx);
  const workbook = parseTreeOrReject(wbText);
  for (const el of descendants(workbook)) {
    if (el.local === 'externalReferences' || el.local === 'externalReference') rejectImport(MSG.external);
  }

  const wbDir = dirOf(workbookPath);
  const wbRels = readRelationships(parts, workbookPath);
  for (const r of wbRels) {
    if (r.external || /\/externalLink$/i.test(r.type) || /\/connections$/i.test(r.type)) rejectImport(MSG.external);
  }
  const relById = new Map(wbRels.map((r) => [r.id, r]));

  const sheetsEl = children(workbook, 'sheets')[0];
  const sheets = (sheetsEl ? children(sheetsEl, 'sheet') : []).map((s) => {
    const rid = attrByLocal(s.attrs, 'id', true);
    const rel = rid === undefined ? undefined : relById.get(rid);
    return {
      name: s.attrs['name'] ?? '',
      hidden: (s.attrs['state'] ?? 'visible') !== 'visible',
      rel,
    };
  });
  const worksheets = sheets.filter((s) => s.rel !== undefined && /\/worksheet$/i.test(s.rel.type));
  if (worksheets.length === 0) rejectImport(MSG.noSheet);

  const preferred = worksheets.find((s) => (PREFERRED_SHEET_NAMES as readonly string[]).includes(s.name.trim().toLowerCase()));
  // 用户看到的“第一张”是第一张可见工作表；全部隐藏时退回第一张。
  const selected = preferred ?? worksheets.find((s) => !s.hidden) ?? worksheets[0]!;

  const ssRel = wbRels.find((r) => /\/sharedStrings$/i.test(r.type));
  const ssPath = ssRel ? resolvePart(wbDir, ssRel.target) : null;
  const ssText = ssPath === null ? undefined : parts.get(ssPath);
  const sharedStrings = ssText === undefined ? [] : parseSharedStrings(ssText);

  let data: Map<number, Map<number, string>> | null = null;
  for (const s of worksheets) {
    const path = resolvePart(wbDir, s.rel!.target);
    const text = parts.get(path);
    if (text === undefined) rejectImport(MSG.corrupt);
    const isSelected = s === selected;
    const result = parseWorksheet(text, sharedStrings, {
      collect: isSelected,
      sheetLabel: isSelected ? null : sanitizeSheetName(s.name),
    });
    if (isSelected) data = result;
  }

  const records: RawRecord[] = [];
  let width = 0;
  for (const cols of data!.values()) for (const c of cols.keys()) width = Math.max(width, c);
  for (const rowNum of [...data!.keys()].sort((a, b) => a - b)) {
    const cols = data!.get(rowNum)!;
    const cells = new Array<string>(width).fill('');
    for (const [c, v] of cols) cells[c - 1] = v;
    records.push({ row: rowNum, cells });
  }
  return { records, sheetName: sanitizeSheetName(selected.name) };
}
