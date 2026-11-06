import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { formatXlsxNumber, readXlsx } from '../../src/importer/xlsx.js';
import { buildXlsx, buildZip, sheetXml, simpleXlsx, xlsxFiles, type ZipFileSpec } from './zip-writer.js';

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

const cells = (buf: Buffer) => readXlsx(buf).records.map((r) => r.cells);

describe('readXlsx: normal sheets', () => {
  test('inline strings and numbers', () => {
    const buf = simpleXlsx([
      ['环境名称', '代理地址', '代理端口'],
      ['示例-买家01', '203.0.113.10', 1080],
    ]);
    const t = readXlsx(buf);
    expect(t.records.map((r) => r.row)).toEqual([1, 2]);
    expect(t.records[1]!.cells).toEqual(['示例-买家01', '203.0.113.10', '1080']);
    expect(t.sheetName).toBe('Sheet1');
  });

  test('shared strings', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([[{ shared: 0 }, { shared: 1 }], [{ shared: 2 }, 8080]]) }],
      sharedStrings: ['环境名称', '代理端口', 'buyer01@example.test'],
    });
    expect(cells(buf)).toEqual([
      ['环境名称', '代理端口'],
      ['buyer01@example.test', '8080'],
    ]);
  });

  test('rich-text shared strings concatenate runs and skip phonetic text', () => {
    const xml =
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><r><rPr><b/></rPr><t>示例</t></r><r><t xml:space="preserve">-买家</t></r><rPh sb="0" eb="1"><t>ルビ</t></rPh></si>' +
      '<si><t>a_x000D_b</t></si><si><t>keep_x005F_x0041_</t></si></sst>';
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([[{ shared: 0 }, { shared: 1 }, { shared: 2 }]]) }],
      sharedStrings: { xml },
    });
    expect(cells(buf)[0]).toEqual(['示例-买家', 'a\rb', 'keep_x0041_']);
  });

  test('inline rich text with runs', () => {
    const raw = '<c r="A1" t="inlineStr"><is><r><t>买家</t></r><r><t>01</t></r></is></c>';
    const buf = simpleXlsx([[{ raw }]]);
    expect(cells(buf)[0]).toEqual(['买家01']);
  });

  test('booleans become TRUE/FALSE text', () => {
    expect(cells(simpleXlsx([[true, false]]))[0]).toEqual(['TRUE', 'FALSE']);
  });

  test('numbers: integers without float noise', () => {
    const buf = simpleXlsx([[{ raw: '<c r="A1"><v>1.08E3</v></c>' }, 13800000000, { raw: '<c r="C1"><v>0.30000000000000004</v></c>' }, { raw: '<c r="D1"><v>1080.0</v></c>' }]]);
    expect(cells(buf)[0]).toEqual(['1080', '13800000000', '0.3', '1080']);
  });

  test('str cells without formula are text', () => {
    expect(cells(simpleXlsx([[{ raw: '<c r="A1" t="str"><v>abc</v></c>' }]]))[0]).toEqual(['abc']);
  });

  test('sparse cells are padded and gaps keep column positions', () => {
    const buf = simpleXlsx([
      ['a', null, 'c'],
      [null, 'y', null],
    ]);
    expect(cells(buf)).toEqual([
      ['a', '', 'c'],
      ['', 'y', ''],
    ]);
  });

  test('rows and cells without r attributes are numbered sequentially', () => {
    const xml = sheetXml(
      [
        ['h1', 'h2'],
        ['v1', 'v2'],
      ],
      { omitRefs: true },
    );
    const t = readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] }));
    expect(t.records.map((r) => [r.row, r.cells])).toEqual([
      [1, ['h1', 'h2']],
      [2, ['v1', 'v2']],
    ]);
  });

  test('empty rows are skipped and row numbers stay as shown in Excel', () => {
    const xml = sheetXml([['h'], [null], ['', ''], ['x']], { startRow: 3 });
    const t = readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] }));
    expect(t.records.map((r) => r.row)).toEqual([3, 6]);
  });

  test('cells with only whitespace count as empty', () => {
    expect(readXlsx(simpleXlsx([['h'], ['   ']])).records).toHaveLength(1);
  });
});

describe('readXlsx: sheet selection', () => {
  const sheet = (v: string) => sheetXml([[v]]);

  test('first sheet by default', () => {
    const buf = buildXlsx({ sheets: [{ name: 'A', xml: sheet('first') }, { name: 'B', xml: sheet('second') }] });
    expect(readXlsx(buf).sheetName).toBe('A');
    expect(cells(buf)).toEqual([['first']]);
  });

  test.each(['environments', 'Environments', ' 环境 '])('sheet named %j is preferred', (name) => {
    const buf = buildXlsx({ sheets: [{ name: 'Notes', xml: sheet('notes') }, { name, xml: sheet('env') }] });
    expect(cells(buf)).toEqual([['env']]);
  });

  test('hidden first sheet is skipped', () => {
    const buf = buildXlsx({ sheets: [{ name: 'H', xml: sheet('hidden'), state: 'hidden' }, { name: 'V', xml: sheet('visible') }] });
    expect(cells(buf)).toEqual([['visible']]);
  });
});

describe('readXlsx: formulas are rejected', () => {
  test('formula names the row', () => {
    const buf = simpleXlsx([['环境名称', '代理端口'], ['示例', 1080], ['示例2', { formula: 'A1+1', value: '2' }]]);
    expect(rejected(() => readXlsx(buf)).message).toBe('第 3 行包含公式，导入不执行公式，请改为纯文本值');
  });

  test('shared formula (empty <f/>) is rejected', () => {
    const buf = simpleXlsx([['h'], [{ sharedFormula: true }]]);
    expect(rejected(() => readXlsx(buf)).message).toContain('第 2 行包含公式');
  });

  test('formula in another sheet is rejected and names that sheet', () => {
    const buf = buildXlsx({
      sheets: [
        { name: '环境', xml: sheetXml([['h'], ['v']]) },
        { name: '计算', xml: sheetXml([['x'], [null], [{ formula: 'NOW()' }]]) },
      ],
    });
    expect(rejected(() => readXlsx(buf)).message).toBe('工作表「计算」第 3 行包含公式，导入不执行公式，请改为纯文本值');
  });
});

describe('readXlsx: unsafe content is rejected', () => {
  test('external link part', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraFiles: [{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' }],
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('外部链接');
  });

  test('externalReferences in workbook', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      workbookExtra: '<externalReferences><externalReference r:id="rId9"/></externalReferences>',
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('外部链接');
  });

  test('external relationship target in workbook rels', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraWorkbookRels:
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/x.xlsx" TargetMode="External"/>',
    });
    rejected(() => readXlsx(buf));
  });

  test('external link content type', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraContentTypes: '<Override PartName="/xl/x.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>',
    });
    rejected(() => readXlsx(buf));
  });

  test('data connections', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraFiles: [{ name: 'xl/connections.xml', data: '<connections/>' }],
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('外部');
  });

  test('vbaProject.bin macro', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraFiles: [{ name: 'xl/vbaProject.bin', data: Buffer.from([1, 2, 3, 4]) }],
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('宏');
  });

  test('macro-enabled workbook content type', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      workbookContentType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('宏');
  });

  test('Excel 4 macro sheet', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraFiles: [{ name: 'xl/macrosheets/sheet1.xml', data: '<xm/>' }],
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('宏');
  });

  test('encrypted OOXML (OLE compound file signature)', () => {
    const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
    expect(rejected(() => readXlsx(cfb)).message).toContain('加密');
  });

  test('EncryptedPackage entry', () => {
    const buf = buildZip([{ name: 'EncryptedPackage', data: 'x' }]);
    expect(rejected(() => readXlsx(buf)).message).toContain('加密');
  });

  test('ZIP traditional encryption flag', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files[4] = { ...files[4]!, flags: 0x1 };
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('加密');
  });

  test('DTD in the worksheet', () => {
    const xml = sheetXml([['h']]).replace('<worksheet', '<!DOCTYPE worksheet [<!ENTITY e "x">]><worksheet');
    expect(rejected(() => readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] }))).message).toContain('DTD');
  });

  test('ENTITY declaration in an unrelated XML part', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([['h']]) }],
      extraFiles: [{ name: 'docProps/core.xml', data: '<?xml version="1.0"?><!DOCTYPE c [<!ENTITY a "aaaa">]><c>&a;</c>' }],
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('DTD');
  });

  test('DTD in shared strings', () => {
    const buf = buildXlsx({
      sheets: [{ name: 'S', xml: sheetXml([[{ shared: 0 }]]) }],
      sharedStrings: { xml: '<!DOCTYPE sst SYSTEM "http://x.invalid/a.dtd"><sst><si><t>a</t></si></sst>' },
    });
    expect(rejected(() => readXlsx(buf)).message).toContain('DTD');
  });

  test('undeclared entity in worksheet', () => {
    const xml = sheetXml([[{ raw: '<c r="A1" t="inlineStr"><is><t>&ext;</t></is></c>' }]]);
    rejected(() => readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] })));
  });
});

describe('readXlsx: zip bombs and limits', () => {
  test('compression ratio over 200 is rejected', () => {
    const big = `${sheetXml([['h']]).slice(0, -('</sheetData></worksheet>'.length))}${' '.repeat(3 * 1024 * 1024)}</sheetData></worksheet>`;
    expect(rejected(() => readXlsx(buildXlsx({ sheets: [{ name: 'S', xml: big }] }))).message).toContain('压缩');
  });

  test('declared entry size over 20 MB is rejected before inflating', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files.push({ name: 'xl/media/big.bin', data: Buffer.alloc(16), declaredUncompressed: 20 * 1024 * 1024 + 1, declaredCompressed: 1024 * 1024 });
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('20 MB');
  });

  test('declared total over 50 MB is rejected', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    for (let i = 0; i < 3; i++) {
      files.push({ name: `xl/media/p${i}.bin`, data: Buffer.alloc(16), declaredUncompressed: 18 * 1024 * 1024, declaredCompressed: 1024 * 1024 });
    }
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('50 MB');
  });

  test('inflated data larger than declared is rejected', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h'], ['v']]) }] });
    const sheet = files[4]!;
    files[4] = { ...sheet, declaredUncompressed: 50 };
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('损坏');
  });

  test('CRC mismatch is rejected', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files[4] = { ...files[4]!, crc: 0x12345678 };
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('损坏');
  });

  test('more than 2000 entries is rejected', () => {
    const files: ZipFileSpec[] = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, data: '', store: true }));
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('2000');
  });

  test('more than 64 columns with data is rejected', () => {
    const row = Array.from({ length: 65 }, (_, i) => `c${i}`);
    expect(rejected(() => readXlsx(simpleXlsx([row]))).message).toContain('64');
  });

  test('64 columns are accepted', () => {
    const row = Array.from({ length: 64 }, (_, i) => `c${i}`);
    expect(cells(simpleXlsx([row]))[0]).toHaveLength(64);
  });

  test('more than 2000 data rows is rejected; 2000 accepted', () => {
    const ok = [['h'], ...Array.from({ length: 2000 }, (_, i) => [`r${i}`])];
    expect(readXlsx(simpleXlsx(ok)).records).toHaveLength(2001);
    const tooMany = [['h'], ...Array.from({ length: 2001 }, (_, i) => [`r${i}`])];
    expect(rejected(() => readXlsx(simpleXlsx(tooMany))).message).toContain('2000');
  });

  test('file over 10 MB is rejected', () => {
    expect(rejected(() => readXlsx(Buffer.alloc(10 * 1024 * 1024 + 1))).message).toContain('10 MB');
  });
});

describe('readXlsx: malformed files', () => {
  test('not a zip', () => {
    expect(rejected(() => readXlsx(Buffer.from('环境名称,代理端口\n'))).message).toContain('不是有效的 XLSX');
  });

  test('truncated zip', () => {
    const buf = simpleXlsx([['h']]);
    rejected(() => readXlsx(buf.subarray(0, buf.length - 30)));
  });

  test('unsupported compression method', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files[4] = { ...files[4]!, store: true, method: 12 };
    expect(rejected(() => readXlsx(buildZip(files))).message).toContain('压缩方式');
  });

  test('duplicate entry names', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files.push({ ...files[4]! });
    rejected(() => readXlsx(buildZip(files)));
  });

  test('missing workbook part', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] }).filter((f) => f.name !== 'xl/workbook.xml');
    rejected(() => readXlsx(buildZip(files)));
  });

  test('missing content types', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] }).slice(1);
    rejected(() => readXlsx(buildZip(files)));
  });

  test('shared string index out of range', () => {
    const buf = buildXlsx({ sheets: [{ name: 'S', xml: sheetXml([[{ shared: 5 }]]) }], sharedStrings: ['a'] });
    rejected(() => readXlsx(buf));
  });

  test('malformed sheet XML', () => {
    rejected(() => readXlsx(buildXlsx({ sheets: [{ name: 'S', xml: '<worksheet><sheetData><row></sheetData></worksheet>' }] })));
  });

  test('relationship target escaping the package root', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h']]) }] });
    files[3] = { ...files[3]!, data: String(files[3]!.data).replace('worksheets/sheet1.xml', '../../../sheet1.xml') };
    rejected(() => readXlsx(buildZip(files)));
  });

  test('stored (uncompressed) entries are read', () => {
    const files = xlsxFiles({ sheets: [{ name: 'S', xml: sheetXml([['h'], ['v']]) }] }).map((f) => ({ ...f, store: true }));
    expect(readXlsx(buildZip(files)).records.map((r) => r.cells)).toEqual([['h'], ['v']]);
  });
});

describe('formatXlsxNumber', () => {
  test.each([
    ['1080', '1080'],
    ['1.08E3', '1080'],
    ['-5', '-5'],
    ['0.1', '0.1'],
    ['2.0000000000000004', '2'],
    ['1E+21', '1000000000000000000000'],
    ['not a number', 'not a number'],
    ['', ''],
  ])('%j → %j', (input, out) => {
    expect(formatXlsxNumber(input)).toBe(out);
  });
});
