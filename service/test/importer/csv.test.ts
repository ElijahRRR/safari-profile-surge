import { describe, expect, test } from 'vitest';
import { SfeError } from '@sfe/contract';
import { parseCsv } from '../../src/importer/csv.js';

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

const cells = (text: string | Uint8Array) => parseCsv(text).records.map((r) => r.cells);
const rows = (text: string | Uint8Array) => parseCsv(text).records.map((r) => r.row);

describe('parseCsv basics', () => {
  test('LF line endings', () => {
    expect(cells('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('CRLF line endings', () => {
    expect(cells('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('lone CR line endings', () => {
    expect(cells('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('no trailing newline', () => {
    expect(cells('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('trailing comma at end of file keeps the empty last field', () => {
    expect(cells('a,b\n1,')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  test('empty input has no records', () => {
    expect(parseCsv('').records).toEqual([]);
    expect(parseCsv(new Uint8Array()).records).toEqual([]);
  });

  test('UTF-8 BOM is stripped from bytes and strings', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('环境名称,代理端口\n示例,1080\n', 'utf8')]);
    expect(cells(bytes)[0]).toEqual(['环境名称', '代理端口']);
    expect(cells('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  test('UTF-8 without BOM', () => {
    expect(cells(Buffer.from('名称\n买家', 'utf8'))).toEqual([['名称'], ['买家']]);
  });
});

describe('quoted fields', () => {
  test('comma inside quotes', () => {
    expect(cells('a\n"x,y"\n')[1]).toEqual(['x,y']);
  });

  test('escaped double quotes', () => {
    expect(cells('a\n"say ""hi"""\n')[1]).toEqual(['say "hi"']);
  });

  test('empty quoted field', () => {
    expect(cells('a,b\n"",x\n')[1]).toEqual(['', 'x']);
  });

  test('embedded newline stays in one record and counts as one row', () => {
    const t = parseCsv('a,b\r\n"line1\r\nline2",2\r\nnext,3\r\n');
    expect(t.records.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['line1\r\nline2', '2'],
      ['next', '3'],
    ]);
    expect(t.records.map((r) => r.row)).toEqual([1, 2, 3]);
  });

  test('quote in the middle of an unquoted field is literal', () => {
    expect(cells('a\n5" screen\n')[1]).toEqual(['5" screen']);
  });

  test('characters after a closing quote mark the row as a problem', () => {
    const t = parseCsv('a,b\n"x"y,2\nok,3\n');
    expect(t.records[1]!.problem).toContain('第 2 行第 1 列');
    expect(t.records[2]!.problem).toBeUndefined();
    expect(t.records[2]!.cells).toEqual(['ok', '3']);
  });

  test('unterminated quote rejects the file and names the starting row', () => {
    const e = rejected(() => parseCsv('a\n"abc\nmore'));
    expect(e.message).toContain('第 2 行');
  });
});

describe('row numbering', () => {
  test('blank lines are skipped but row numbers stay physical', () => {
    expect(rows('a\n\n1\n\n\n2\n')).toEqual([1, 3, 6]);
  });

  test('rows of only commas count as blank', () => {
    expect(rows('a,b\n,\n1,2\n')).toEqual([1, 3]);
  });
});

describe('no evaluation', () => {
  test.each(['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://a.invalid")'])('cell %j stays literal text', (v) => {
    const quoted = `"${v.replace(/"/g, '""')}"`;
    expect(cells(`a\n${quoted}\n`)[1]).toEqual([v]);
  });
});

describe('encoding and limits', () => {
  test('invalid UTF-8 is rejected', () => {
    const e = rejected(() => parseCsv(new Uint8Array([0x61, 0x0a, 0xc3, 0x28])));
    expect(e.message).toContain('UTF-8');
  });

  test('UTF-16 file is rejected', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n', 'utf16le')]);
    rejected(() => parseCsv(utf16));
  });

  test('more than 5 MB is rejected', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(rejected(() => parseCsv(big)).message).toContain('5 MB');
    expect(rejected(() => parseCsv('a'.repeat(5 * 1024 * 1024 + 1))).message).toContain('5 MB');
  });

  test('64 columns accepted, 65 rejected', () => {
    expect(cells(Array.from({ length: 64 }, (_, i) => `c${i}`).join(','))[0]).toHaveLength(64);
    const e = rejected(() => parseCsv(Array.from({ length: 65 }, (_, i) => `c${i}`).join(',')));
    expect(e.message).toContain('64');
  });

  test('2000 data rows accepted, 2001 rejected', () => {
    const ok = ['h', ...Array.from({ length: 2000 }, (_, i) => `r${i}`)].join('\n');
    expect(parseCsv(ok).records).toHaveLength(2001);
    const tooMany = ['h', ...Array.from({ length: 2001 }, (_, i) => `r${i}`)].join('\n');
    expect(rejected(() => parseCsv(tooMany)).message).toContain('2000');
  });

  test('blank lines do not count toward the row limit', () => {
    const text = ['h', ...Array.from({ length: 2000 }, (_, i) => `r${i}`), '', '', ''].join('\n');
    expect(parseCsv(text).records).toHaveLength(2001);
  });

  test('rejection carries a file field error', () => {
    const e = rejected(() => parseCsv('"x'));
    expect(e.fieldErrors?.[0]?.field).toBe('file');
  });
});
