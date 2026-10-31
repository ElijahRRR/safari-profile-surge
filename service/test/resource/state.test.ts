// 持久状态（engine.kv）：键名、形状校验、fail closed 的读取、审计记录的有界保存，以及与 ResourceHost 的衔接（重启后序号继续）。
import { describe, expect, test } from 'vitest';
import { createEngineKv } from '../../src/engine/kv.js';
import {
  RESOURCE_AUDIT_LIMIT,
  RESOURCE_KV_KEYS,
  clearCandidatePointer,
  commitCandidatePointer,
  createResourceHost,
  readAuditLog,
  readAuditState,
  readNeedsRefresh,
  readServedPointer,
  readTokenSuspect,
  recordAuditEntry,
  setCandidatePointer,
  virtualBinder,
  writeAuditState,
  writeNeedsRefresh,
  writeServedPointer,
  writeTokenSuspect,
} from '../../src/resource/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { makeRepos } from '../db/fixtures.js';
import { PORT, TOKEN, goodRequest, recordingLogger, sampleContent } from './helpers.js';

function kvFixture() {
  const { db } = makeRepos();
  const kv = createEngineKv(db);
  const rawKeys = () => db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'engine:resource:%' ORDER BY key").map((r) => r.key);
  const rawSet = (key: string, value: string) =>
    db.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`engine:${key}`, value]);
  return { db, kv, rawKeys, rawSet };
}

describe('key names', () => {
  test('exactly the spec names under the engine: prefix', () => {
    expect(RESOURCE_KV_KEYS).toEqual({
      served: 'resource:served',
      needsRefresh: 'resource:needsRefresh',
      audit: 'resource:audit',
      auditState: 'resource:auditState',
      tokenSuspect: 'resource:tokenSuspect',
    });
    const { kv, rawKeys } = kvFixture();
    writeServedPointer(kv, { committed: { generation: 0 }, candidate: null });
    writeNeedsRefresh(kv, { generation: 0, reason: 'startup' });
    recordAuditEntry(kv, { seq: 1, at: new Date('2026-10-31T00:00:00.000Z'), generation: 0, complete: false });
    writeAuditState(kv, { verifiedUpdatedAt: null, verifiedError: null, auditedSeq: 0, windowSeq: 0 });
    writeTokenSuspect(kv, { since: '2026-10-31T00:00:00.000Z', reason: 'unexplained_fetch' });
    expect(rawKeys()).toEqual([
      'engine:resource:audit',
      'engine:resource:auditState',
      'engine:resource:needsRefresh',
      'engine:resource:served',
      'engine:resource:tokenSuspect',
    ]);
  });
});

describe('resource:served', () => {
  test('absent → null; candidate and needsRefresh are set together; commit and clear', () => {
    const { kv } = kvFixture();
    expect(readServedPointer(kv)).toBeNull();
    expect(() => setCandidatePointer(kv, 5)).toThrow();
    writeServedPointer(kv, { committed: { generation: 4 }, candidate: null });
    setCandidatePointer(kv, 5);
    expect(readServedPointer(kv)).toEqual({ committed: { generation: 4 }, candidate: { generation: 5 } });
    expect(readNeedsRefresh(kv)).toEqual({ generation: 5, reason: 'publish' });
    clearCandidatePointer(kv);
    expect(readServedPointer(kv)).toEqual({ committed: { generation: 4 }, candidate: null });
    // 清除候选不动 needsRefresh
    expect(readNeedsRefresh(kv)).toEqual({ generation: 5, reason: 'publish' });
    setCandidatePointer(kv, 6, 'force_refresh');
    expect(commitCandidatePointer(kv)).toBe(6);
    expect(readServedPointer(kv)).toEqual({ committed: { generation: 6 }, candidate: null });
    expect(() => commitCandidatePointer(kv)).toThrow();
    clearCandidatePointer(kv);
  });

  test('invalid shapes read as absent and are refused on write', () => {
    const { kv, rawSet } = kvFixture();
    for (const bad of ['{"committed":{"generation":-1},"candidate":null}', '{"committed":{"generation":1}}', '{"committed":3,"candidate":null}', '[]', '"x"']) {
      rawSet('resource:served', bad);
      expect(readServedPointer(kv)).toBeNull();
    }
    expect(() => writeServedPointer(kv, { committed: { generation: 1.5 }, candidate: null })).toThrow();
    expect(() => writeServedPointer(kv, { committed: { generation: 1 }, candidate: { generation: -2 } })).toThrow();
  });
});

describe('resource:needsRefresh', () => {
  test('round trip; null deletes the key', () => {
    const { kv, rawKeys } = kvFixture();
    expect(readNeedsRefresh(kv)).toBeNull();
    writeNeedsRefresh(kv, { generation: 3, reason: 'startup_candidate' });
    expect(readNeedsRefresh(kv)).toEqual({ generation: 3, reason: 'startup_candidate' });
    writeNeedsRefresh(kv, null);
    expect(readNeedsRefresh(kv)).toBeNull();
    expect(rawKeys()).toEqual([]);
    expect(() => writeNeedsRefresh(kv, { generation: 1, reason: '' })).toThrow();
  });

  test('an unrecognised stored value (including the pre-D10 {operationId}) still means a refresh is needed', () => {
    const { kv, rawSet } = kvFixture();
    for (const bad of ['{"operationId":"op_01"}', '{"generation":"3","reason":"x"}', '1', '"yes"']) {
      rawSet('resource:needsRefresh', bad);
      expect(readNeedsRefresh(kv)).toEqual({ generation: 0, reason: 'unreadable' });
    }
  });

  test('regression: a truncated row or a stored JSON null is still "refresh needed" (never read as absent)', () => {
    const { kv, rawSet } = kvFixture();
    for (const bad of ['{"generation":3,', 'null', '', 'not json']) {
      rawSet('resource:needsRefresh', bad);
      expect(readNeedsRefresh(kv)).toEqual({ generation: 0, reason: 'unreadable' });
    }
    writeNeedsRefresh(kv, null);
    expect(readNeedsRefresh(kv)).toBeNull();
  });
});

describe('resource:audit', () => {
  test('empty by default; the before-write and completion calls end in one complete record', () => {
    const { kv } = kvFixture();
    expect(readAuditLog(kv)).toEqual({ records: [], nextSeq: 1 });
    const at = new Date('2026-10-31T00:00:01.000Z');
    recordAuditEntry(kv, { seq: 1, at, generation: 2, complete: false });
    expect(readAuditLog(kv)).toEqual({ records: [{ seq: 1, at, generation: 2, complete: false }], nextSeq: 2 });
    recordAuditEntry(kv, { seq: 1, at, generation: 2, complete: true });
    expect(readAuditLog(kv)).toEqual({ records: [{ seq: 1, at, generation: 2, complete: true }], nextSeq: 2 });
  });

  test('bounded to the last 64 records; nextSeq never goes back', () => {
    const { kv } = kvFixture();
    for (let seq = 1; seq <= RESOURCE_AUDIT_LIMIT + 10; seq++) {
      recordAuditEntry(kv, { seq, at: new Date(Date.UTC(2026, 9, 31, 0, 0, seq)), generation: 1, complete: true });
    }
    const log = readAuditLog(kv);
    expect(log.records).toHaveLength(RESOURCE_AUDIT_LIMIT);
    expect(log.records[0]!.seq).toBe(11);
    expect(log.nextSeq).toBe(RESOURCE_AUDIT_LIMIT + 11);
    // 迟到的完成回调（记录已被挤出）不会让序号回退
    recordAuditEntry(kv, { seq: 3, at: new Date('2026-10-31T00:00:03.000Z'), generation: 1, complete: true });
    expect(readAuditLog(kv).nextSeq).toBe(RESOURCE_AUDIT_LIMIT + 11);
    expect(readAuditLog(kv).records).toHaveLength(RESOURCE_AUDIT_LIMIT);
  });

  test('malformed stored records are skipped; invalid records are refused on write', () => {
    const { kv, rawSet } = kvFixture();
    rawSet(
      'resource:audit',
      JSON.stringify({
        records: [
          { seq: 2, at: '2026-10-31T00:00:02.000Z', generation: 1, complete: true },
          { seq: 0, at: '2026-10-31T00:00:02.000Z', generation: 1, complete: true },
          { seq: 3, at: 'yesterday', generation: 1, complete: true },
          { seq: 4, at: '2026-10-31T00:00:04.000Z', generation: 1 },
          { seq: 9, at: '2026-10-31T00:00:09.000Z', generation: 1, complete: false },
        ],
        nextSeq: 5,
      }),
    );
    const log = readAuditLog(kv);
    expect(log.records.map((r) => r.seq)).toEqual([2, 9]);
    expect(log.nextSeq).toBe(10);
    rawSet('resource:audit', '"garbage"');
    expect(readAuditLog(kv)).toEqual({ records: [], nextSeq: 1 });
    expect(() => recordAuditEntry(kv, { seq: 0, at: new Date(), generation: 1, complete: true })).toThrow();
    expect(() => recordAuditEntry(kv, { seq: 1, at: new Date(Number.NaN), generation: 1, complete: true })).toThrow();
  });

  test('host.onServed persisted through recordAuditEntry; a restarted host continues the sequence', async () => {
    const { kv } = kvFixture();
    const clock = new FakeClock('2026-10-31T00:00:00.000Z');
    const registry = new Map<number, unknown>();
    const binder = virtualBinder(registry);
    const first = createResourceHost({ token: TOKEN, clock, logger: recordingLogger(), binder });
    first.onServed((r) => recordAuditEntry(kv, r));
    first.configure(PORT);
    await first.listen();
    first.loadCommitted({ generation: 1, content: sampleContent(1) });
    binder.request(PORT, goodRequest());
    clock.advance(1000);
    binder.request(PORT, goodRequest());
    await first.close();
    const persisted = readAuditLog(kv);
    expect(persisted.records.map((r) => [r.seq, r.complete])).toEqual([
      [1, true],
      [2, true],
    ]);
    const second = createResourceHost({ token: TOKEN, clock, logger: recordingLogger(), binder, audit: persisted });
    second.onServed((r) => recordAuditEntry(kv, r));
    expect(second.auditMark()).toBe(3);
    second.configure(PORT);
    await second.listen();
    second.loadCommitted({ generation: 1, content: sampleContent(1) });
    binder.request(PORT, goodRequest());
    expect(readAuditLog(kv).records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(second.audit().map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});

describe('resource:auditState', () => {
  test('round trip, invalid → null, null deletes', () => {
    const { kv, rawSet, rawKeys } = kvFixture();
    expect(readAuditState(kv)).toBeNull();
    const s = { verifiedUpdatedAt: '2026-10-31T00:00:00.000Z', verifiedError: 'NSURLErrorDomain -1004', auditedSeq: 12, windowSeq: 15 };
    writeAuditState(kv, s);
    expect(readAuditState(kv)).toEqual(s);
    writeAuditState(kv, null);
    expect(rawKeys()).toEqual([]);
    for (const bad of [
      '{"verifiedUpdatedAt":null,"verifiedError":null,"auditedSeq":-1,"windowSeq":0}',
      '{"verifiedUpdatedAt":null,"verifiedError":null,"auditedSeq":1,"windowSeq":-1}',
      // 缺少审计窗口起点
      '{"verifiedUpdatedAt":null,"verifiedError":null,"auditedSeq":1}',
    ]) {
      rawSet('resource:auditState', bad);
      expect(readAuditState(kv)).toBeNull();
    }
    expect(() => writeAuditState(kv, { verifiedUpdatedAt: null, verifiedError: null, auditedSeq: 1.5, windowSeq: 0 })).toThrow();
    expect(() => writeAuditState(kv, { verifiedUpdatedAt: null, verifiedError: null, auditedSeq: 1, windowSeq: Number.NaN })).toThrow();
  });
});

describe('resource:tokenSuspect', () => {
  test('round trip; an unrecognised stored value is still suspect (fail closed)', () => {
    const { kv, rawSet } = kvFixture();
    expect(readTokenSuspect(kv)).toBeNull();
    writeTokenSuspect(kv, { since: '2026-10-31T00:00:00.000Z', reason: 'port_in_use' });
    expect(readTokenSuspect(kv)).toEqual({ since: '2026-10-31T00:00:00.000Z', reason: 'port_in_use' });
    rawSet('resource:tokenSuspect', '{"reason":"x"}');
    expect(readTokenSuspect(kv)).toEqual({ since: '1970-01-01T00:00:00.000Z', reason: 'unreadable' });
    // 回归：截断的 JSON、空值与 JSON null 同样按可能泄露处理（从不当作没有设置）
    for (const bad of ['{"since":"2026-10-31T00:00:00.000Z","reason":"port_in_', 'null', '']) {
      rawSet('resource:tokenSuspect', bad);
      expect(readTokenSuspect(kv)).toEqual({ since: '1970-01-01T00:00:00.000Z', reason: 'unreadable' });
    }
    writeTokenSuspect(kv, null);
    expect(readTokenSuspect(kv)).toBeNull();
    expect(() => writeTokenSuspect(kv, { since: 'now', reason: 'x' })).toThrow();
  });
});
