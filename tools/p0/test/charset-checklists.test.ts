import { CAPABILITY_KEYS } from '@sfe/contract';
import { describe, expect, it } from 'vitest';
import {
  CHARSET_CLASSES,
  charsetExpectation,
  charsetIndexOf,
  charsetNodeLine,
  classifyCharset,
  compareCredentials,
  selectClasses,
} from '../src/charset.js';
import { AUTOMATED_BY, CHECKLISTS, checklistChecks, parseAnswer } from '../src/checklists.js';
import { isSurgeSafeCredential, parseProxyLine } from '../src/deps.js';
import { verdictOf } from '../src/results.js';

const PORTS = { echo: 18080, exit: 18081, front: 18082, deadFront: 18083 };

describe('charset fixtures', () => {
  it('places the class characters at the start, middle and end', () => {
    const cls = CHARSET_CLASSES.find((c) => c.id === 'comma')!;
    const e = charsetExpectation(12, cls);
    expect(e.username).toBe('p0cs12x,y,');
    expect(e.password).toBe(',q12,z,');
    expect(e.node).toBe('SFE-N-P0-CS12');
  });

  it('class ids are unique and the baseline is the currently allowed set', () => {
    expect(new Set(CHARSET_CLASSES.map((c) => c.id)).size).toBe(CHARSET_CLASSES.length);
    const base = charsetExpectation(0, CHARSET_CLASSES[0]!);
    expect(isSurgeSafeCredential(base.username) && isSurgeSafeCredential(base.password)).toBe(true);
    for (const c of CHARSET_CLASSES.slice(1)) expect(isSurgeSafeCredential(charsetExpectation(1, c).password)).toBe(false);
  });

  it('never contains line breaks', () => {
    for (const c of CHARSET_CLASSES) expect(/[\r\n\0]/.test(c.chars)).toBe(false);
    expect(() => charsetExpectation(1, { id: 'nl', label: 'nl', chars: '\n' })).toThrow();
  });

  it('builds a raw node line through the test front', () => {
    const e = charsetExpectation(3, CHARSET_CLASSES.find((c) => c.id === 'hash')!);
    const line = charsetNodeLine(e, PORTS);
    expect(line.startsWith('SFE-N-P0-CS03 = socks5, 127.0.0.1, 18081, ')).toBe(true);
    expect(line.endsWith('underlying-proxy=P0-Front')).toBe(true);
    // 安全字符类的行能被正常解析出完全一致的值
    const baseLine = charsetNodeLine(charsetExpectation(0, CHARSET_CLASSES[0]!), PORTS);
    expect(parseProxyLine(baseLine)?.params.username).toBe(charsetExpectation(0, CHARSET_CLASSES[0]!).username);
  });

  it('identifies the class from a possibly truncated username', () => {
    expect(charsetIndexOf(Buffer.from('p0cs07x!y!'))).toBe(7);
    expect(charsetIndexOf(Buffer.from('p0cs07'))).toBeNull();
    expect(charsetIndexOf(Buffer.from('p0-a'))).toBeNull();
  });

  it('compares received credentials byte for byte', () => {
    const e = charsetExpectation(26, CHARSET_CLASSES.find((c) => c.id === 'nonascii')!);
    expect(compareCredentials(e, Buffer.from(e.username), Buffer.from(e.password))).toBe('exact');
    expect(compareCredentials(e, Buffer.from(e.username), Buffer.from('x'))).toBe('password_altered');
    expect(compareCredentials(e, Buffer.from('x'), Buffer.from(e.password))).toBe('username_altered');
    expect(compareCredentials(e, Buffer.from('x'), Buffer.from('y'))).toBe('both_altered');
  });

  it('classifies observations', () => {
    const o = { index: 1, inMembers: true, selected: true, requestOk: true, authVerdicts: ['exact' as const] };
    expect(classifyCharset(o, true)).toBe('safe');
    expect(classifyCharset(o, false)).toBe('check_failed');
    expect(classifyCharset({ ...o, inMembers: false }, true)).toBe('skipped_by_surge');
    expect(classifyCharset({ ...o, authVerdicts: [] }, true)).toBe('no_connection');
    expect(classifyCharset({ ...o, authVerdicts: ['exact', 'password_altered'] }, true)).toBe('altered');
    expect(classifyCharset({ ...o, requestOk: false }, true)).toBe('altered');
    expect(classifyCharset({ ...o, selected: false }, true)).toBe('not_tested');
  });

  it('selects classes by id', () => {
    expect(selectClasses(undefined)).toHaveLength(CHARSET_CLASSES.length);
    expect(selectClasses(['comma', 'hash']).map((x) => x.cls.id)).toEqual(['hash', 'comma']);
    expect(() => selectClasses(['nope'])).toThrow();
  });
});

describe('checklists', () => {
  it('every capability is either automated or has a checklist', () => {
    for (const key of CAPABILITY_KEYS) expect(Boolean(AUTOMATED_BY[key]) !== Boolean(CHECKLISTS[key])).toBe(true);
  });

  it('native bridge checklist covers background wake from suspension', () => {
    expect(CHECKLISTS.native_bridge_ipc!.items.some((i) => i.id === 'background_wake')).toBe(true);
  });

  it('first request checklist covers restored tabs, extension sleep and old connections', () => {
    const ids = CHECKLISTS.first_request_and_old_connections!.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['restored_tabs', 'extension_sleep', 'old_long_connection']));
  });

  it('profile batch create and open by id are record only', () => {
    expect(CHECKLISTS.profile_batch_create!.recordOnly).toBe(true);
    expect(CHECKLISTS.open_profile_by_id!.recordOnly).toBe(true);
  });

  it('parses answers and maps them to checks', () => {
    expect(parseAnswer('Y')).toBe('y');
    expect(parseAnswer('否')).toBe('n');
    expect(parseAnswer('')).toBeNull();
    expect(parseAnswer(null)).toBeNull();
    const list = CHECKLISTS.bridge_keychain_access!;
    const checks = checklistChecks(list, { write: { answer: 'y', note: '' }, read_no_prompt: { answer: 'n', note: '每次都提示' } });
    expect(checks.map((c) => c.ok)).toEqual([true, false, null, null]);
    expect(verdictOf(checks)).toBe('fail');
    const all = checklistChecks(list, Object.fromEntries(list.items.map((i) => [i.id, { answer: 'y' as const, note: '' }])));
    expect(verdictOf(all)).toBe('pass');
  });
});
