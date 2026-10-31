import { describe, expect, test } from 'vitest';
import { clean, displayWidth, formatAccepted, formatError, formatNeedsConfirmation, renderTable, shellQuote } from '../../src/cli/format.js';

describe('format', () => {
  test('displayWidth counts CJK as 2', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('环境')).toBe(4);
    expect(displayWidth('US-买家01')).toBe(9);
  });

  test('renderTable aligns mixed-width columns', () => {
    const out = renderTable(['编号', '环境'], [['env_1', 'US-买家01 · E0001'], ['e2', 'x']]);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    const offset = (line: string, needle: string) => displayWidth(line.slice(0, line.lastIndexOf(needle)));
    expect(offset(lines[0]!, '环境')).toBe(7);
    expect(offset(lines[2]!, 'US-')).toBe(7);
    expect(offset(lines[3]!, 'x')).toBe(7);
  });

  test('clean removes escape sequences and bidi overrides', () => {
    expect(clean('a\u001b[31mb')).toBe('a?[31mb');
    expect(clean('x‮y')).toBe('x?y');
    expect(clean('line1\nline2')).toBe('line1 line2');
    expect(clean(null)).toBe('');
  });

  test('formatError', () => {
    expect(formatError({ code: 'REVISION_CONFLICT', message: '保存失败：数据已被其他人修改' })).toBe('保存失败：数据已被其他人修改\n（错误码 REVISION_CONFLICT）\n');
  });

  test('formatAccepted mentions that acceptance is not effect', () => {
    expect(formatAccepted({ operation_id: 'op_1', environment_id: null, revision: null, duplicate: true })).toContain('同一请求已提交过');
    expect(formatAccepted({ operation_id: 'op_1', environment_id: null, revision: null, duplicate: false })).toContain('受理不代表已生效');
  });

  test('formatNeedsConfirmation quotes unusual ids', () => {
    const text = formatNeedsConfirmation({ reason: 'managed_environment_active', currentEnvironmentId: "env 'x'", options: ['closed_confirmed'] }, ['sfe', 'normal']);
    expect(text).toContain(`--confirmed-env 'env '\\''x'\\'''`);
  });

  test('shellQuote', () => {
    expect(shellQuote('env_1')).toBe('env_1');
    expect(shellQuote('a b')).toBe("'a b'");
  });
});
