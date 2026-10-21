// 测试用的最小 ZIP / XLSX 构造器（只用合成数据）。可以篡改声明大小、标志位、压缩方式与 CRC，
// 用来构造压缩炸弹、加密条目与损坏文件。

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFileSpec {
  name: string;
  data: string | Buffer;
  /** 不压缩（method 0）。 */
  store?: boolean;
  flags?: number;
  method?: number;
  /** 写入中央目录的声明大小（默认为真实值）。 */
  declaredUncompressed?: number;
  declaredCompressed?: number;
  crc?: number;
}

export function buildZip(files: ZipFileSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const method = f.method ?? (f.store ? 0 : 8);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name, 'utf8');
    const crc = f.crc ?? crc32(data);
    const flags = (f.flags ?? 0) | 0x800;
    const compSize = f.declaredCompressed ?? compressed.length;
    const uncompSize = f.declaredUncompressed ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compSize >>> 0, 20);
    central.writeUInt32LE(uncompSize >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- XLSX ----------

export type CellSpec =
  | string
  | number
  | boolean
  | null
  | { shared: number }
  | { formula: string; value?: string }
  | { sharedFormula: true }
  | { raw: string };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colLetter(i: number): string {
  let n = i;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** rows[0] 写在 startRow（默认第 1 行）。字符串默认写成内联字符串。 */
export function sheetXml(rows: CellSpec[][], opts: { startRow?: number; omitRefs?: boolean } = {}): string {
  const start = opts.startRow ?? 1;
  const body = rows
    .map((cells, ri) => {
      const r = start + ri;
      const cs = cells
        .map((c, ci) => {
          if (c === null) return '';
          const ref = opts.omitRefs ? '' : ` r="${colLetter(ci + 1)}${r}"`;
          if (typeof c === 'string') return `<c${ref} t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
          if (typeof c === 'number') return `<c${ref}><v>${c}</v></c>`;
          if (typeof c === 'boolean') return `<c${ref} t="b"><v>${c ? 1 : 0}</v></c>`;
          if ('shared' in c) return `<c${ref} t="s"><v>${c.shared}</v></c>`;
          if ('formula' in c) return `<c${ref}><f>${esc(c.formula)}</f><v>${c.value ?? '0'}</v></c>`;
          if ('sharedFormula' in c) return `<c${ref}><f t="shared" si="0"/><v>1</v></c>`;
          return c.raw;
        })
        .join('');
      return opts.omitRefs ? `<row>${cs}</row>` : `<row r="${r}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${body}</sheetData></worksheet>`;
}

export function sharedStringsXml(items: string[]): string {
  const si = items.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${items.length}" uniqueCount="${items.length}">${si}</sst>`;
}

export interface XlsxSpec {
  sheets: Array<{ name: string; xml: string; state?: 'hidden' | 'veryHidden' }>;
  /** 共享字符串：数组（自动转义）或原始 XML。 */
  sharedStrings?: string[] | { xml: string };
  extraFiles?: ZipFileSpec[];
  extraContentTypes?: string;
  extraWorkbookRels?: string;
  workbookExtra?: string;
  workbookContentType?: string;
}

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function xlsxFiles(spec: XlsxSpec): ZipFileSpec[] {
  const sheetOverrides = spec.sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const ssOverride = spec.sharedStrings
    ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    : '';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${spec.workbookContentType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>${sheetOverrides}${ssOverride}${spec.extraContentTypes ?? ''}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const sheetEls = spec.sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
    .join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_REL}"><sheets>${sheetEls}</sheets>${spec.workbookExtra ?? ''}</workbook>`;
  const sheetRels = spec.sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  const ssRel = spec.sharedStrings ? `<Relationship Id="rIdSS" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` : '';
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${ssRel}${spec.extraWorkbookRels ?? ''}</Relationships>`;

  const files: ZipFileSpec[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    ...spec.sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
  ];
  if (spec.sharedStrings) {
    const xml = Array.isArray(spec.sharedStrings) ? sharedStringsXml(spec.sharedStrings) : spec.sharedStrings.xml;
    files.push({ name: 'xl/sharedStrings.xml', data: xml });
  }
  files.push(...(spec.extraFiles ?? []));
  return files;
}

export function buildXlsx(spec: XlsxSpec): Buffer {
  return buildZip(xlsxFiles(spec));
}

/** 单表、内联字符串的简单工作簿。 */
export function simpleXlsx(rows: CellSpec[][], name = 'Sheet1'): Buffer {
  return buildXlsx({ sheets: [{ name, xml: sheetXml(rows) }] });
}
