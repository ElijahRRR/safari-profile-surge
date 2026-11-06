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

  it('native bridge checklist covers background wake from suspension, including the alarm-driven profile report', () => {
    const item = CHECKLISTS.native_bridge_ipc!.items.find((i) => i.id === 'background_wake');
    // RUNBOOK §3.3 第 3 步：上报闹钟唤醒后 service.log 中没有上报时答「否」，题目必须问到它，不能只问弹窗往返
    expect(item?.question).toContain('sfe-profile-report');
    expect(item?.question).toContain('service.log');
  });

  it('no_tcc covers only the host app; extension access is decided by roundtrip (macOS 15: extensions are denied without a prompt)', () => {
    const item = CHECKLISTS.native_bridge_ipc!.items.find((i) => i.id === 'no_tcc');
    expect(item?.question).toContain('宿主 App');
    expect(item?.question).toContain('roundtrip');
  });

  it('no keychain checklist: secrets live in the service data directory, never in the Keychain (user decision)', () => {
    expect(Object.keys(CHECKLISTS)).not.toContain('bridge_keychain_access');
    expect(JSON.stringify(CHECKLISTS)).not.toMatch(/钥匙串|keychain/i);
  });

  it('native bridge checklist records the macOS 26 quit prompt for background tasks (Apple: users are prompted to allow or not allow)', () => {
    const item = CHECKLISTS.native_bridge_ipc!.items.find((i) => i.id === 'quit_prompt');
    expect(item?.question).toContain('macOS 26');
    expect(item?.question).toContain('「不允许」');
  });

  it('profile ID checklist requires distinct IDs only for named profiles and records the default profile (Apple: no key means normal browsing)', () => {
    const items = CHECKLISTS.native_profile_id!.items;
    expect(items.map((i) => i.id)).toEqual(['distinct', 'default_profile', 'safari_restart', 'reinstall', 'resign']);
    expect(items[0]!.question).toContain('已命名');
    expect(items[0]!.question).not.toContain('默认场景');
    // 默认场景显示「未识别当前场景」也可以回答 y；显示 ID 时必须与已命名场景不同
    expect(items[1]!.question).toContain('未识别当前场景');
    expect(items[1]!.question).toContain('都不同');
  });

  it('signing checklist records whether a provisioning profile is embedded (TN3125: not required on macOS without restricted entitlements)', () => {
    const item = CHECKLISTS.extension_install_persistence!.items.find((i) => i.id === 'validity');
    expect(item?.question).toContain('embedded.provisionprofile');
    expect(item?.question).toContain('ExpirationDate');
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
    const list = CHECKLISTS.native_profile_id!;
    const checks = checklistChecks(list, { distinct: { answer: 'y', note: '' }, default_profile: { answer: 'n', note: '与已命名场景相同' } });
    expect(checks.map((c) => c.ok)).toEqual([true, false, null, null, null]);
    expect(verdictOf(checks)).toBe('fail');
    const all = checklistChecks(list, Object.fromEntries(list.items.map((i) => [i.id, { answer: 'y' as const, note: '' }])));
    expect(verdictOf(all)).toBe('pass');
  });
});
