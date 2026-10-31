// 审计与发布读回（纯函数）：更新时间必须对应本服务记下的完整 200，资源错误必须能解释；读回逐项核对。只用合成数据。
import { describe, expect, test } from 'vitest';
import { EMPTY_PLACEHOLDER_NODE } from '@sfe/contract';
import {
  DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS,
  assessResourceReadback,
  auditResource,
  isConnectionRefused,
  isConnectionRefusedOrTimeout,
  isRequestTimeout,
  resourceLocationHash,
  servedFailureCount,
  type AssessResourceReadbackInput,
  type AuditResourceInput,
  type ResourceAuditRecord,
  type ResourceAuditState,
  type ResourceNodeDetail,
  type ResourceSnapshot,
} from '../../src/resource/index.js';
import { PATH, PORT } from './helpers.js';

const URL = `http://127.0.0.1:${PORT}${PATH}`;
const HASH = resourceLocationHash(URL);
const KEY = '0123456789abcdef0123456789abcdef';
const T = (iso: string) => new Date(iso);
const U0 = '2026-10-31T00:00:00.000Z';
const U1 = '2026-10-31T00:10:00.000Z';
const TOL = 5000;

const snap = (over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  key: KEY,
  locationHash: HASH,
  updatedAt: T(U0),
  error: null,
  updating: false,
  members: ['REJECT', 'SFE-N-E0001-US01-v001'],
  selection: 'REJECT',
  ...over,
});
const rec = (seq: number, at: string | Date, generation = 1, complete = true): ResourceAuditRecord => ({
  seq,
  at: at instanceof Date ? at : T(at),
  generation,
  complete,
});
const state = (over: Partial<ResourceAuditState> = {}): ResourceAuditState => ({ verifiedUpdatedAt: U0, verifiedError: null, auditedSeq: 4, windowSeq: 4, ...over });
const shift = (iso: string, ms: number) => new Date(T(iso).getTime() + ms);

describe('resourceLocationHash', () => {
  test('sha256 hex of the url', () => {
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(resourceLocationHash(URL)).toBe(HASH);
    expect(resourceLocationHash(URL.replace(PATH, `/${'b'.repeat(64)}/sfe-nodes.list`))).not.toBe(HASH);
  });
});

describe('isConnectionRefusedOrTimeout', () => {
  test.each([
    ['NSURLErrorDomain -1004 无法连接服务器', true],
    ['Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."', true],
    ['Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', true],
    ['NSURLErrorDomain -1001', true],
    ['请求超时。', true],
    ['未能连接到服务器。无法连接服务器', true],
    ['The request timed out.', true],
    ['NSURLErrorDomain -1005', false],
    ['NSURLErrorDomain -10041', false],
    ['HTTP 404', false],
    ['服务器未返回任何数据。', false],
    ['Failed to parse remote resource data', false],
  ])('%s → %s', (text, expected) => {
    expect(isConnectionRefusedOrTimeout(text)).toBe(expected);
  });

  test.each([
    ['NSURLErrorDomain -1004 无法连接服务器', true, false],
    ['Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."', true, false],
    ['未能连接到服务器。无法连接服务器', true, false],
    ['Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', false, true],
    ['NSURLErrorDomain -1001', false, true],
    ['请求超时。 (NSURLErrorDomain:-1001)', false, true],
    ['The request timed out.', false, true],
    ['NSURLErrorDomain -1005', false, false],
    ['NSURLErrorDomain -10011', false, false],
    ['HTTP 404', false, false],
  ])('refused vs timeout: %s → refused %s, timeout %s', (text, refused, timeout) => {
    expect(isConnectionRefused(text)).toBe(refused);
    expect(isRequestTimeout(text)).toBe(timeout);
  });
});

describe('auditResource', () => {
  /** 缺省：本服务没有一直监听、窗口内没有失败答复、读快照之前的 mark 在所有记录之后。 */
  const audit = (over: Partial<AuditResourceInput> = {}) => {
    const records = over.records ?? [];
    const mark = records.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    return auditResource({ snapshot: snap(), state: state(), records, toleranceMs: TOL, serving: false, servedFailures: 0, mark, ...over });
  };

  test('no state yet → initialized from the snapshot (never flagged)', () => {
    const r = audit({ snapshot: snap({ error: 'HTTP 404' }), state: null, records: [rec(3, U0), rec(9, U0, 1, false)] });
    expect(r).toEqual({ verdict: 'initialized', matchedSeq: null, nextState: { verifiedUpdatedAt: U0, verifiedError: 'HTTP 404', auditedSeq: 9, windowSeq: 9 } });
    const empty = audit({ snapshot: snap({ updatedAt: null }), state: null });
    expect(empty.nextState).toEqual({ verifiedUpdatedAt: null, verifiedError: null, auditedSeq: 0, windowSeq: 0 });
  });

  test('nothing changed → ok, state unchanged', () => {
    const s = state();
    expect(audit({ state: s, mark: 5 })).toEqual({ verdict: 'ok', matchedSeq: null, nextState: s });
  });

  test('a new updatedAt explained by a complete 200 in the window → ok and the state advances to that record', () => {
    const records = [rec(4, shift(U1, -2000)), rec(5, shift(U1, -1500)), rec(6, shift(U1, -200)), rec(7, shift(U1, 3000))];
    const r = audit({ snapshot: snap({ updatedAt: T(U1) }), records, serving: true, mark: 6 });
    // 多条匹配时取序号最大的；序号 4 不大于 auditedSeq，7 晚于窗口。窗口起点前移到读快照之前已有的记录（mark − 1）
    expect(r).toEqual({ verdict: 'ok', matchedSeq: 6, nextState: { verifiedUpdatedAt: U1, verifiedError: null, auditedSeq: 6, windowSeq: 5 } });
  });

  test('window bounds: [U − tolerance, U + 1000 ms]', () => {
    const at = (ms: number) => audit({ snapshot: snap({ updatedAt: T(U1) }), records: [rec(5, shift(U1, ms))], serving: true }).verdict;
    expect(at(-TOL)).toBe('ok');
    expect(at(-TOL - 1)).toBe('unexplained_fetch');
    expect(at(1000)).toBe('ok');
    expect(at(1001)).toBe('unexplained_fetch');
    expect(at(0)).toBe('ok');
  });

  test('unexplained fetches: no record, incomplete record, record already audited', () => {
    const s = state();
    for (const records of [[], [rec(5, U1, 1, false)], [rec(4, U1)], [rec(3, U1)]]) {
      const r = audit({ snapshot: snap({ updatedAt: T(U1) }), state: s, records, serving: true, servedFailures: 3 });
      expect(r.verdict).toBe('unexplained_fetch');
      expect(r.matchedSeq).toBeNull();
      // 不前移：之后的审计仍会报告，直到轮换或确认的读回重置
      expect(r.nextState).toBe(s);
    }
  });

  test('an unparseable updatedAt is unexplained', () => {
    expect(audit({ snapshot: snap({ updatedAt: new Date(Number.NaN) }), records: [rec(5, U1)], serving: true }).verdict).toBe('unexplained_fetch');
  });

  test('updatedAt dropping to null (cache dropped) needs no fetch record; the confirmed updatedAt is kept', () => {
    const r = audit({ snapshot: snap({ updatedAt: null, error: 'not_ready' }), serving: true, servedFailures: 1, mark: 5 });
    expect(r).toEqual({ verdict: 'ok', matchedSeq: null, nextState: { verifiedUpdatedAt: U0, verifiedError: 'not_ready', auditedSeq: 4, windowSeq: 4 } });
    // 缓存重新出现同一更新时间：不是新的下载
    expect(audit({ snapshot: snap({ updatedAt: T(U0) }), state: r.nextState, serving: false }).verdict).toBe('ok');
    // 出现不同的更新时间：仍要对应本服务的审计记录
    expect(audit({ snapshot: snap({ updatedAt: T(U1) }), state: r.nextState, serving: false }).verdict).toBe('unexplained_fetch');
  });

  test('regression: a bare not_ready without updatedAt (no completed download yet, e.g. after a Surge relaunch) is explained, serving or not', () => {
    for (const serving of [true, false]) {
      const s = state({ verifiedError: null });
      const r = audit({ snapshot: snap({ updatedAt: null, error: 'not_ready' }), state: s, serving, servedFailures: 0, mark: 5 });
      expect(r).toEqual({ verdict: 'ok', matchedSeq: null, nextState: { verifiedUpdatedAt: U0, verifiedError: 'not_ready', auditedSeq: 4, windowSeq: 4 } });
    }
  });

  test('not_ready is explained only without updatedAt; an error text on a never-loaded resource follows the normal rules', () => {
    // 有更新时间却报告 not_ready：不是“尚未下载”
    expect(audit({ snapshot: snap({ updatedAt: T(U0), error: 'not_ready' }), serving: false }).verdict).toBe('unexplained_error');
    // 从未下载成功而有错误文字（他人答复了 404）：本服务没有一直监听时无法解释
    expect(audit({ snapshot: snap({ updatedAt: null, error: 'HTTP 404' }), serving: false }).verdict).toBe('unexplained_error');
  });

  test('a new error: connection refused (nobody listening) is explainable even while not serving', () => {
    for (const error of ['NSURLErrorDomain -1004 无法连接服务器', 'Error Domain=NSURLErrorDomain Code=-1004 "Could not connect to the server."']) {
      const r = audit({ snapshot: snap({ error }) });
      expect(r.verdict).toBe('ok');
      expect(r.nextState.verifiedError).toBe(error);
    }
  });

  test('regression: a request timeout is explained only while we were serving (otherwise a squatter took the token and hung)', () => {
    const s = state();
    for (const error of ['Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', '请求超时。 (NSURLErrorDomain:-1001) [未能完成操作。]', 'The request timed out.']) {
      const notServing = audit({ snapshot: snap({ error }), state: s, serving: false, servedFailures: 3, records: [rec(5, U0, 1, false)] });
      expect(notServing.verdict).toBe('unexplained_error');
      expect(notServing.nextState).toBe(s);
      const serving = audit({ snapshot: snap({ error }), state: s, serving: true });
      expect(serving.verdict).toBe('ok');
      expect(serving.nextState.verifiedError).toBe(error);
    }
  });

  const OTHER_ERRORS = ['HTTP 404', 'HTTP 503', '服务器未返回任何数据。', 'Failed to parse remote resource data', 'NSURLErrorDomain -1005'];

  test.each(OTHER_ERRORS)('not serving: %s is unexplained even with an incomplete 200 or failure counts in the window (someone else may have answered)', (error) => {
    const s = state();
    for (const records of [[], [rec(5, U0, 1, false)], [rec(9, '2026-09-01T00:00:00Z', 3, false)]]) {
      const r = audit({ snapshot: snap({ error }), state: s, records, servedFailures: 4 });
      expect(r.verdict).toBe('unexplained_error');
      expect(r.nextState).toBe(s);
    }
  });

  test('regression: a stale incomplete record from before the restart does not explain the startup audit (port squatter answered 404)', () => {
    // 服务停止前一次下载中途断开（序号 6 未写完），停止期间他人占用端口、对 Surge 的下载答复 404；重启后监听之前审计
    const s = state({ verifiedUpdatedAt: U0, verifiedError: null, auditedSeq: 5, windowSeq: 5 });
    const r = audit({ snapshot: snap({ updatedAt: T(U0), error: 'HTTP 404' }), state: s, records: [rec(6, '2026-09-01T00:00:00Z', 3, false)], serving: false });
    expect(r.verdict).toBe('unexplained_error');
    expect(r.nextState).toBe(s);
  });

  test('serving: a new error needs our own failed answer in the window (404/503 count or an incomplete 200)', () => {
    for (const error of OTHER_ERRORS) {
      // 没有失败答复、记录都已完整：错误不是本服务产生的
      expect(audit({ snapshot: snap({ error }), records: [rec(5, U0)], serving: true }).verdict).toBe('unexplained_error');
      expect(audit({ snapshot: snap({ error }), serving: true, servedFailures: 1 }).verdict).toBe('ok');
      expect(audit({ snapshot: snap({ error }), records: [rec(5, U0, 1, false)], serving: true }).verdict).toBe('ok');
    }
    // 窗口之前（序号不大于 windowSeq）的未完成记录不算
    expect(audit({ snapshot: snap({ error: 'NSURLErrorDomain -1005' }), state: state({ windowSeq: 5 }), records: [rec(5, U0, 1, false)], serving: true }).verdict).toBe(
      'unexplained_error',
    );
    // 非法的失败计数按 0 处理
    for (const servedFailures of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(audit({ snapshot: snap({ error: 'HTTP 503' }), serving: true, servedFailures }).verdict).toBe('unexplained_error');
    }
  });

  test('regression: one incomplete 200 explains at most the first audit after it; a later different error is unexplained', () => {
    const records = [rec(5, U0, 1, false)];
    const first = audit({ snapshot: snap({ error: 'NSURLErrorDomain -1005' }), records, serving: true, mark: 6 });
    expect(first.verdict).toBe('ok');
    expect(first.nextState).toMatchObject({ verifiedError: 'NSURLErrorDomain -1005', auditedSeq: 4, windowSeq: 5 });
    const second = audit({ snapshot: snap({ error: 'Failed to parse remote resource data' }), state: first.nextState, records, serving: true, mark: 6 });
    expect(second.verdict).toBe('unexplained_error');
    expect(second.nextState).toBe(first.nextState);
    // 同一错误不再报告
    expect(audit({ snapshot: snap({ error: 'NSURLErrorDomain -1005' }), state: first.nextState, records, serving: true, mark: 6 }).verdict).toBe('ok');
  });

  test('records written while the snapshot was read (seq ≥ mark) stay in the window for the next audit', () => {
    // 读快照之前 mark = 5；读快照期间序号 5 的下载中途断开：这次的结论不靠它，下一次审计仍可用它解释
    const records = [rec(5, U0, 1, false)];
    const first = audit({ snapshot: snap({ error: null }), records, serving: true, mark: 5 });
    expect(first.nextState.windowSeq).toBe(4);
    expect(audit({ snapshot: snap({ error: 'NSURLErrorDomain -1005' }), state: first.nextState, records, serving: true, mark: 6 }).verdict).toBe('ok');
  });

  test('an invalid mark consumes every record (fail closed for later errors)', () => {
    const records = [rec(5, U0, 1, false), rec(7, U0)];
    for (const mark of [0, -1, Number.NaN, 2.5]) {
      expect(audit({ snapshot: snap({ error: null }), records, serving: true, mark }).nextState.windowSeq).toBe(7);
    }
  });

  test('an error already confirmed, or an error clearing, is not re-flagged', () => {
    expect(audit({ snapshot: snap({ error: 'HTTP 404' }), state: state({ verifiedError: 'HTTP 404' }) }).verdict).toBe('ok');
    const cleared = audit({ snapshot: snap({ error: null }), state: state({ verifiedError: 'HTTP 404' }) });
    expect(cleared.verdict).toBe('ok');
    expect(cleared.nextState.verifiedError).toBeNull();
  });

  test('an invalid tolerance falls back to the default', () => {
    const r = audit({ snapshot: snap({ updatedAt: T(U1) }), records: [rec(5, shift(U1, -DEFAULT_RESOURCE_AUDIT_TOLERANCE_MS))], toleranceMs: Number.NaN, serving: true });
    expect(r.verdict).toBe('ok');
  });
});

describe('servedFailureCount', () => {
  test('sums 404 reasons and 503s; a completion-recording failure is not an answer', () => {
    expect(servedFailureCount({})).toBe(0);
    expect(servedFailureCount({ method: 2, token_mismatch: 1, unavailable: 3, audit_failed: 1, token_refused: 1 })).toBe(8);
    expect(servedFailureCount({ audit_complete_failed: 5, host: 1 })).toBe(1);
    expect(servedFailureCount({ host: Number.NaN, path: -2, method: 1 })).toBe(1);
  });
});

describe('assessResourceReadback', () => {
  const NODES = ['SFE-N-E0001-US01-v001', 'SFE-N-E0002-US02-v001'];
  const MARK = 10;
  const detail = (server: string, port = 1080, underlyingProxy: string | null = 'HK-01'): ResourceNodeDetail => ({ server, port, underlyingProxy });
  const details = () => ({
    expected: new Map([
      [NODES[0]!, detail('192.0.2.10')],
      [NODES[1]!, detail('192.0.2.11')],
    ]),
    actual: new Map<string, ResourceNodeDetail | null>([
      [NODES[0]!, detail('192.0.2.10')],
      [NODES[1]!, detail('192.0.2.11')],
    ]),
  });
  const after = (over: Partial<ResourceSnapshot> = {}) => snap({ updatedAt: T(U1), members: ['REJECT', ...NODES], selection: NODES[0]!, ...over });
  const base = (over: Partial<AssessResourceReadbackInput> = {}): AssessResourceReadbackInput => ({
    url: URL,
    before: snap({ selection: NODES[0]! }),
    after: after(),
    afterRepeat: after(),
    expectedMembers: NODES,
    selectionBefore: NODES[0]!,
    records: [rec(MARK, shift(U1, -300), 7)],
    mark: MARK,
    expectedGeneration: 7,
    toleranceMs: TOL,
    details: details(),
    ...over,
  });

  test('all checks pass → ok, full with details', () => {
    expect(assessResourceReadback(base())).toEqual({ ok: true, level: 'full', failed: [] });
  });

  test('without details the level is partial', () => {
    expect(assessResourceReadback(base({ details: undefined }))).toEqual({ ok: true, level: 'partial', failed: [] });
    expect(assessResourceReadback(base({ details: null }))).toEqual({ ok: true, level: 'partial', failed: [] });
  });

  test('details that could not be read (or have no expectation) keep the level partial without failing', () => {
    const d1 = details();
    d1.actual.set(NODES[1]!, null);
    expect(assessResourceReadback(base({ details: d1 }))).toEqual({ ok: true, level: 'partial', failed: [] });
    const d2 = details();
    d2.expected.delete(NODES[0]!);
    expect(assessResourceReadback(base({ details: d2 }))).toEqual({ ok: true, level: 'partial', failed: [] });
  });

  test.each([
    ['server', detail('192.0.2.99')],
    ['port', detail('192.0.2.11', 1081)],
    ['underlying proxy', detail('192.0.2.11', 1080, 'HK-02')],
    ['missing underlying proxy', detail('192.0.2.11', 1080, null)],
  ])('detail mismatch (%s) fails that node', (_n, got) => {
    const d = details();
    d.actual.set(NODES[1]!, got);
    expect(assessResourceReadback(base({ details: d }))).toEqual({ ok: false, level: 'full', failed: [`detail:${NODES[1]}`] });
  });

  const failing: Array<[string, Partial<AssessResourceReadbackInput>, string[]]> = [
    ['key changed', { after: after({ key: 'f'.repeat(32) }), afterRepeat: after({ key: 'f'.repeat(32) }) }, ['resource_key']],
    ['locationHash mismatch', { after: after({ locationHash: resourceLocationHash(URL.replace(String(PORT), String(PORT + 1))) }) }, ['location']],
    ['locationHash missing', { afterRepeat: after({ locationHash: null }) }, ['location']],
    ['error non-null', { after: after({ error: 'HTTP 503' }) }, ['resource_error']],
    ['updating true', { after: after({ updating: true }) }, ['resource_updating']],
    ['updating true on repeat', { afterRepeat: after({ updating: true }) }, ['resource_updating']],
    ['repeat-read members differ', { afterRepeat: after({ members: ['REJECT', NODES[0]!] }) }, ['unstable']],
    ['repeat-read updatedAt differs', { afterRepeat: after({ updatedAt: shift(U1, 1) }) }, ['unstable']],
    ['updatedAt earlier than before', { before: snap({ updatedAt: shift(U1, 1), selection: NODES[0]! }) }, ['updated_at']],
    ['updatedAt null', { after: after({ updatedAt: null }), afterRepeat: after({ updatedAt: null }) }, ['updated_at', 'fetch']],
    ['record before the mark', { records: [rec(MARK - 1, shift(U1, -300), 7)] }, ['fetch']],
    ['record incomplete', { records: [rec(MARK, shift(U1, -300), 7, false)] }, ['fetch']],
    ['record of another generation', { records: [rec(MARK, shift(U1, -300), 6)] }, ['fetch']],
    ['record outside the window', { records: [rec(MARK, shift(U1, -TOL - 1), 7)] }, ['fetch']],
    ['record later than the window', { records: [rec(MARK, shift(U1, 1001), 7)] }, ['fetch']],
    ['no record', { records: [] }, ['fetch']],
    ['REJECT not first', { after: after({ members: [NODES[0]!, 'REJECT', NODES[1]!] }), afterRepeat: after({ members: [NODES[0]!, 'REJECT', NODES[1]!] }) }, ['first_member', 'members']],
    ['extra member', { after: after({ members: ['REJECT', ...NODES, 'SFE-N-E0003-US03-v001'] }), afterRepeat: after({ members: ['REJECT', ...NODES, 'SFE-N-E0003-US03-v001'] }) }, ['members']],
    ['missing member', { after: after({ members: ['REJECT', NODES[0]!] }), afterRepeat: after({ members: ['REJECT', NODES[0]!] }) }, ['members']],
    ['duplicate member', { after: after({ members: ['REJECT', NODES[0]!, NODES[0]!] }), afterRepeat: after({ members: ['REJECT', NODES[0]!, NODES[0]!] }) }, ['members']],
    ['members unreadable', { after: after({ members: null }), afterRepeat: after({ members: null }) }, ['members']],
    ['selection changed', { after: after({ selection: NODES[1]! }), afterRepeat: after({ selection: NODES[1]! }) }, ['selection']],
    ['selection changed on repeat', { afterRepeat: after({ selection: 'REJECT' }) }, ['selection']],
  ];

  test.each(failing)('%s → %j', (_name, over, codes) => {
    const r = assessResourceReadback(base(over));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(codes);
  });

  test('a record exactly at the mark counts; an equal updatedAt is allowed when a new record matches', () => {
    expect(assessResourceReadback(base({ records: [rec(MARK, U1, 7)] })).ok).toBe(true);
    expect(assessResourceReadback(base({ before: snap({ updatedAt: T(U1), selection: NODES[0]! }) })).ok).toBe(true);
  });

  test('the first member check is case-insensitive like the existing readback', () => {
    expect(assessResourceReadback(base({ after: after({ members: ['reject', ...NODES] }), afterRepeat: after({ members: ['reject', ...NODES] }) })).ok).toBe(true);
  });

  test('an empty generation expects only the placeholder; details are trivially complete', () => {
    const members = ['REJECT', EMPTY_PLACEHOLDER_NODE];
    const r = assessResourceReadback(
      base({ expectedMembers: [], after: after({ members, selection: 'REJECT' }), afterRepeat: after({ members, selection: 'REJECT' }), selectionBefore: 'REJECT', details: { expected: new Map(), actual: new Map() } }),
    );
    expect(r).toEqual({ ok: true, level: 'full', failed: [] });
    const missing = assessResourceReadback(base({ expectedMembers: [], after: after({ members: ['REJECT'] }), afterRepeat: after({ members: ['REJECT'] }), details: null }));
    expect(missing.failed).toContain('members');
  });
});
