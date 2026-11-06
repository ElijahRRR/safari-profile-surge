import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createRepositories, openDatabase } from '../../src/db/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { createScrubber, SCRUB_MASK } from '../../src/util/scrubber.js';
import { makeRepos, seedEnvironment, seedOperation, T0 } from './fixtures.js';

describe('operations', () => {
  test('insert/get round-trip with parsed payload/result/error and defaults', () => {
    const { repos } = makeRepos();
    const env = seedEnvironment(repos);
    const op = repos.operations.insert({
      id: 'op_1',
      requestId: 'req-1',
      requestDigest: 'a'.repeat(64),
      kind: 'route.activate',
      environmentId: env.id,
      initiatorKind: 'bridge',
      initiatorProfileId: 'PROFILE-1',
      expectedRevision: 3,
      routeEpoch: 5,
      probeKind: 'safari',
      phase: 'SAVED',
      status: 'queued',
      payload: { proxyRevision: 2, oldSessionPolicy: 'closed_confirmed', passwordRef: 'sec_X' },
    });
    expect(op).toEqual({
      id: 'op_1',
      requestId: 'req-1',
      requestDigest: 'a'.repeat(64),
      kind: 'route.activate',
      environmentId: env.id,
      initiatorKind: 'bridge',
      initiatorProfileId: 'PROFILE-1',
      expectedRevision: 3,
      resultRevision: null,
      routeEpoch: 5,
      probeKind: 'safari',
      phase: 'SAVED',
      status: 'queued',
      supersededBy: null,
      payload: { proxyRevision: 2, oldSessionPolicy: 'closed_confirmed', passwordRef: 'sec_X' },
      result: null,
      error: null,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(repos.operations.byRequestId('req-1')?.id).toBe('op_1');
    expect(repos.operations.byRequestId('nope')).toBeNull();
  });

  test('request_id is unique', () => {
    const { repos } = makeRepos();
    seedOperation(repos, { requestId: 'same' });
    expect(() => seedOperation(repos, { requestId: 'same' })).toThrow(/UNIQUE/);
  });

  test('setPhase updates phase, status, patch fields and updatedAt', () => {
    const { repos, clock } = makeRepos();
    const op = seedOperation(repos);
    clock.advance(2000);
    repos.operations.setPhase(op.id, 'FAILED', 'failed', {
      error: { code: 'READBACK_MISMATCH', message: '读回失败：成员不一致' },
      result: { readbackLevel: 'partial', uncheckedFields: ['underlying-proxy'] },
      supersededBy: null,
    });
    const after = repos.operations.get(op.id)!;
    expect(after).toMatchObject({
      phase: 'FAILED',
      status: 'failed',
      error: { code: 'READBACK_MISMATCH', message: '读回失败：成员不一致' },
      result: { readbackLevel: 'partial', uncheckedFields: ['underlying-proxy'] },
      updatedAt: '2026-10-21T00:00:02.000Z',
    });
  });

  test('error messages and details are scrubbed before storage', () => {
    const scrubber = createScrubber();
    scrubber.register('Leaky-Secret-9');
    const { repos } = makeRepos({ scrubber });
    const op = seedOperation(repos, { error: { code: 'SURGE_COMMAND_FAILED', message: '执行失败：Leaky-Secret-9', details: { stderr: 'x Leaky-Secret-9' } } });
    const stored = repos.operations.get(op.id)!;
    expect(JSON.stringify(stored)).not.toContain('Leaky-Secret-9');
    repos.operations.update(op.id, { error: { code: 'INTERNAL', message: 'again Leaky-Secret-9', fieldErrors: [{ field: 'f', message: 'Leaky-Secret-9' }] } });
    expect(JSON.stringify(repos.operations.get(op.id))).not.toContain('Leaky-Secret-9');
  });

  test('payloads containing secret material are rejected', () => {
    const { repos } = makeRepos();
    expect(() => seedOperation(repos, { payload: { changes: { proxy: { password: { action: 'replace', value: 'x-1' } } } } })).toThrow(
      expect.objectContaining({ code: 'INTERNAL', details: { field: '$.changes.proxy.password.value' } }),
    );
    expect(() => seedOperation(repos, { payload: { record: { proxy_password: 'x-1' } } })).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => seedOperation(repos, { payload: { content_base64: 'QUJD' } })).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    // 引用、keep/clear、是否已配置都允许
    expect(() => seedOperation(repos, { payload: { passwordRef: 'sec_1', proxy: { password: { action: 'keep' }, username: { action: 'clear' } }, hasPassword: true } })).not.toThrow();
  });

  test('listByStatus, listRecent, listForEnvironment', () => {
    const { repos, clock } = makeRepos();
    const env = seedEnvironment(repos);
    const a = seedOperation(repos, { status: 'queued', kind: 'deploy.publish' });
    clock.advance(1000);
    const b = seedOperation(repos, { status: 'waiting', kind: 'route.activate', environmentId: env.id });
    clock.advance(1000);
    const c = seedOperation(repos, { status: 'succeeded', environmentId: env.id });
    expect(repos.operations.listByStatus(['queued', 'waiting']).map((o) => o.id)).toEqual([a.id, b.id]);
    expect(repos.operations.listByStatus(['queued', 'waiting'], { kinds: ['route.activate'] }).map((o) => o.id)).toEqual([b.id]);
    expect(repos.operations.listByStatus([])).toEqual([]);
    expect(repos.operations.listRecent(2).map((o) => o.id)).toEqual([c.id, b.id]);
    expect(repos.operations.listForEnvironment(env.id).map((o) => o.id)).toEqual([c.id, b.id]);
  });

  test('appendStep assigns sequence numbers and scrubs messages', () => {
    const { repos, clock } = makeRepos();
    const op = seedOperation(repos);
    const s1 = repos.operations.appendStep(op.id, 'VALIDATING', '开始校验');
    clock.advance(500);
    const s2 = repos.operations.appendStep(op.id, 'DEPLOYING', `stderr: A = socks5, 192.0.2.1, 1080, username=u1, password=${'Pw-Step-1'}`);
    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);
    const steps = repos.operations.listSteps(op.id);
    expect(steps).toEqual([
      { operationId: op.id, seq: 1, at: T0, phase: 'VALIDATING', message: '开始校验' },
      { operationId: op.id, seq: 2, at: '2026-10-21T00:00:00.500Z', phase: 'DEPLOYING', message: expect.stringContaining(`password=${SCRUB_MASK}`) },
    ]);
    expect(JSON.stringify(steps)).not.toContain('Pw-Step-1');
    expect(() => repos.operations.appendStep('op_missing', 'SAVED', 'x')).toThrow(/FOREIGN KEY/);
  });
});

describe('outbox', () => {
  test('enqueue/claim/markDone lifecycle respects availableAt ordering', () => {
    const { repos, clock } = makeRepos();
    const op1 = seedOperation(repos);
    const op2 = seedOperation(repos);
    const later = repos.outbox.enqueue(op1.id, 'arrival_timeout', '2026-10-21T00:01:00.000Z');
    const now = repos.outbox.enqueue(op2.id, null, T0);
    expect(repos.outbox.nextAvailableAt()).toBe(T0);
    const claimed = repos.outbox.claimNext(clock.now());
    expect(claimed).toEqual({ id: now, operationId: op2.id, resumeReason: null, availableAt: T0, claimedAt: T0, doneAt: null });
    expect(repos.outbox.claimNext(clock.now())).toBeNull();
    clock.advance(60_000);
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(later);
    expect(repos.outbox.markDone(now)).toBe(true);
    expect(repos.outbox.markDone(now)).toBe(false);
    expect(repos.outbox.listPending().map((e) => e.id)).toEqual([later]);
    expect(repos.outbox.get(now)?.doneAt).toBe('2026-10-21T00:01:00.000Z');
  });

  test('each entry is claimed exactly once even across two connections to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfe-outbox-'));
    const path = join(dir, 'sfe.sqlite');
    const clock = new FakeClock(T0);
    const a = makeRepos({ path, clock });
    const db2 = openDatabase(path);
    const b = createRepositories(db2, { clock });
    const ops = Array.from({ length: 40 }, () => seedOperation(a.repos));
    for (const op of ops) a.repos.outbox.enqueue(op.id, null, T0);
    const claimedBy: Record<number, string> = {};
    for (let i = 0; i < 100; i++) {
      const who = i % 2 === 0 ? 'a' : 'b';
      const repo = who === 'a' ? a.repos : b;
      const item = repo.outbox.claimNext(clock.now());
      if (!item) continue;
      expect(claimedBy[item.id]).toBeUndefined();
      claimedBy[item.id] = who;
    }
    expect(Object.keys(claimedBy)).toHaveLength(40);
    expect(new Set(Object.values(claimedBy))).toEqual(new Set(['a', 'b']));
    a.db.close();
    db2.close();
  });

  test('claim inside an outer transaction that rolls back is released', () => {
    const { repos, clock } = makeRepos();
    const op = seedOperation(repos);
    repos.outbox.enqueue(op.id, null, T0);
    expect(() =>
      repos.tx(() => {
        expect(repos.outbox.claimNext(clock.now())).not.toBeNull();
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(repos.outbox.claimNext(clock.now())).not.toBeNull();
  });

  test('prefer: entries of earlier operation groups are claimed first, each group still by availableAt and id', () => {
    const { repos, clock } = makeRepos();
    const publish = seedOperation(repos, { kind: 'environment.update' });
    const recovering = seedOperation(repos, { kind: 'environment.update' });
    const activate = seedOperation(repos, { kind: 'route.activate' });
    const normal = seedOperation(repos, { kind: 'route.normal' });
    repos.outbox.enqueue(publish.id, null, T0);
    repos.outbox.enqueue(normal.id, null, '2026-10-21T00:00:00.500Z');
    repos.outbox.enqueue(activate.id, null, '2026-10-21T00:00:00.200Z');
    repos.outbox.enqueue(recovering.id, 'profile_arrived', '2026-10-21T00:00:00.800Z');
    clock.advance(1_000);
    const prefer = [[recovering.id], [activate.id, normal.id]];
    expect(repos.outbox.claimNext(clock.now(), prefer)?.operationId).toBe(recovering.id);
    expect(repos.outbox.claimNext(clock.now(), prefer)?.operationId).toBe(activate.id);
    expect(repos.outbox.claimNext(clock.now(), prefer)?.operationId).toBe(normal.id);
    expect(repos.outbox.claimNext(clock.now(), prefer)?.operationId).toBe(publish.id);
    // 不指定或只有空组时只按可用时间
    const { repos: r2, clock: c2 } = makeRepos();
    const p2 = seedOperation(r2, { kind: 'environment.update' });
    const n2 = seedOperation(r2, { kind: 'route.normal' });
    const q2 = seedOperation(r2, { kind: 'route.activate' });
    r2.outbox.enqueue(p2.id, null, T0);
    r2.outbox.enqueue(n2.id, null, T0);
    r2.outbox.enqueue(q2.id, null, T0);
    expect(r2.outbox.claimNext(c2.now())?.operationId).toBe(p2.id);
    expect(r2.outbox.claimNext(c2.now(), [[], []])?.operationId).toBe(n2.id);
    expect(r2.outbox.claimNext(c2.now(), [[], [q2.id]])?.operationId).toBe(q2.id);
  });

  test('only timer entries wait for their availableAt: entries due on acceptance stay claimable after the wall clock steps back (§6.1)', () => {
    const { repos, clock } = makeRepos();
    const timer = seedOperation(repos, { kind: 'route.activate', status: 'waiting', phase: 'VERIFY_ONLY' });
    const normal = seedOperation(repos, { kind: 'route.normal' });
    const waiting = seedOperation(repos, { kind: 'route.activate', status: 'waiting', phase: 'VERIFY_ONLY' });
    const deadline = repos.outbox.enqueue(timer.id, 'arrival_timeout', '2026-10-21T00:00:30.000Z');
    const verifyDeadline = repos.outbox.enqueue(timer.id, 'verify_timeout', '2026-10-21T00:00:40.000Z');
    // 受理时按墙上时间入队，之后墙上时钟回拨 10 分钟
    const accepted = repos.outbox.enqueue(normal.id, null, T0);
    const cancel = repos.outbox.enqueue(waiting.id, 'cancel', T0);
    clock.set(Date.parse(T0) - 600_000);
    // 计时器以外的条目立即可以领取，下一次唤醒也按现在计
    expect(repos.outbox.nextAvailableAt(clock.now())).toBe(clock.now().toISOString());
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(accepted);
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(cancel);
    // 计时器条目等到截止时间
    expect(repos.outbox.claimNext(clock.now())).toBeNull();
    expect(repos.outbox.nextAvailableAt(clock.now())).toBe('2026-10-21T00:00:30.000Z');
    clock.set(Date.parse('2026-10-21T00:00:30.000Z'));
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(deadline);
    expect(repos.outbox.claimNext(clock.now())).toBeNull();
    clock.set(Date.parse('2026-10-21T00:00:40.000Z'));
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(verifyDeadline);
  });

  test('releaseClaims: a released entry of a still-running (crash-recovering) operation is due now even after the wall clock stepped back; other timer entries keep their deadline', () => {
    const { repos, clock } = makeRepos();
    const recovering = seedOperation(repos, { kind: 'route.activate', status: 'waiting', phase: 'VERIFY_ONLY' });
    const waiting = seedOperation(repos, { kind: 'route.activate', status: 'waiting', phase: 'VERIFY_ONLY' });
    const r1 = repos.outbox.enqueue(recovering.id, 'arrival_timeout', T0);
    const w1 = repos.outbox.enqueue(waiting.id, 'arrival_timeout', '2026-10-21T00:00:00.500Z');
    clock.advance(1_000);
    // 上一次进程领取了两个到期的计时器条目：第一个操作已开始处理（running）时进程退出；第二个尚未开始（仍在等待）
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(r1);
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(w1);
    repos.operations.update(recovering.id, { status: 'running', phase: 'ROLLING_BACK' });
    // 重启之前墙上时钟回拨 10 分钟
    clock.set(Date.parse(T0) - 600_000);
    expect(repos.outbox.releaseClaims(clock.now())).toBe(2);
    expect(repos.outbox.get(r1)).toMatchObject({ claimedAt: null, availableAt: clock.now().toISOString() });
    // 未开始处理的计时器条目保持截止时间（提前领取时处理器按截止时间什么也不做，截止时间就此丢失）
    expect(repos.outbox.get(w1)).toMatchObject({ claimedAt: null, availableAt: '2026-10-21T00:00:00.500Z' });
    expect(repos.outbox.claimNext(clock.now())?.id).toBe(r1);
    expect(repos.outbox.claimNext(clock.now())).toBeNull();
  });

  test('releaseClaims returns stale claims to the queue; cancelForOperation ends them', () => {
    const { repos, clock } = makeRepos();
    const op = seedOperation(repos);
    const other = seedOperation(repos);
    repos.outbox.enqueue(op.id, 'first', T0);
    repos.outbox.enqueue(op.id, 'second', T0);
    repos.outbox.enqueue(other.id, null, T0);
    repos.outbox.claimNext(clock.now());
    expect(repos.outbox.releaseClaims()).toBe(1);
    expect(repos.outbox.pendingForOperation(op.id)).toHaveLength(2);
    expect(repos.outbox.cancelForOperation(op.id)).toBe(2);
    expect(repos.outbox.pendingForOperation(op.id)).toHaveLength(0);
    expect(repos.outbox.claimNext(clock.now())?.operationId).toBe(other.id);
    expect(repos.outbox.nextAvailableAt()).toBeNull();
  });
});

describe('probes', () => {
  test('insert with defaults, latest per kind, update', () => {
    const { repos, clock } = makeRepos();
    const env = seedEnvironment(repos);
    const p1 = repos.probes.insert({
      id: 'probe_1',
      environmentId: env.id,
      kind: 'safari',
      outcome: 'ok',
      exitIp: '198.51.100.30',
      proxyRevision: 1,
      nodeName: 'SFE-N-E0001-US01-v001',
      routeEpoch: 3,
      entryMode: 'VERIFY_ONLY',
      surgeNewConnection: true,
      observedAt: T0,
      expiresAt: '2026-10-21T00:15:00.000Z',
    });
    expect(p1).toMatchObject({ testId: null, surgeNewConnection: true, browserHttpStatus: null, message: null, entryMode: 'VERIFY_ONLY', routeEpoch: 3 });
    clock.advance(1000);
    repos.probes.insert({ id: 'probe_2', environmentId: env.id, kind: 'preflight', outcome: 'inconclusive', proxyRevision: 1, nodeName: 'x', observedAt: clock.now().toISOString(), expiresAt: clock.now().toISOString() });
    repos.probes.insert({ id: 'probe_3', environmentId: env.id, kind: 'safari', outcome: 'mismatch', proxyRevision: 2, nodeName: 'y', observedAt: clock.now().toISOString(), expiresAt: clock.now().toISOString() });
    expect(repos.probes.latest(env.id, 'safari')?.id).toBe('probe_3');
    expect(repos.probes.latest(env.id, 'preflight')?.id).toBe('probe_2');
    expect(repos.probes.listForEnvironment(env.id).map((p) => p.id)).toEqual(['probe_3', 'probe_2', 'probe_1']);
    expect(repos.probes.update('probe_1', { expiresAt: T0, message: 'token=abc123' })).toBe(true);
    expect(repos.probes.get('probe_1')?.message).toBe(`token=${SCRUB_MASK}`);
  });
});

describe('verification tests', () => {
  test('consume works only once', () => {
    const { repos } = makeRepos();
    const env = seedEnvironment(repos);
    const op = seedOperation(repos, { kind: 'route.activate' });
    const t = repos.verificationTests.insert({ testId: 'tid_1', operationId: op.id, environmentId: env.id, profileId: 'P1', routeEpoch: 4, purpose: 'apply_new_revision', deadline: '2026-10-21T00:02:00.000Z' });
    expect(t).toEqual({ testId: 'tid_1', operationId: op.id, environmentId: env.id, profileId: 'P1', routeEpoch: 4, purpose: 'apply_new_revision', issuedAt: T0, deadline: '2026-10-21T00:02:00.000Z', consumedAt: null });
    expect(repos.verificationTests.consume('tid_1')).toBe(true);
    expect(repos.verificationTests.consume('tid_1')).toBe(false);
    expect(repos.verificationTests.consume('missing')).toBe(false);
    expect(repos.verificationTests.get('tid_1')?.consumedAt).toBe(T0);
    expect(repos.verificationTests.listForOperation(op.id)).toHaveLength(1);
  });

  test('purpose is constrained by the schema', () => {
    const { repos } = makeRepos();
    const env = seedEnvironment(repos);
    const op = seedOperation(repos);
    expect(() =>
      repos.verificationTests.insert({ testId: 't', operationId: op.id, environmentId: env.id, profileId: 'P', routeEpoch: 0, purpose: 'other' as 'activate', deadline: T0 }),
    ).toThrow(/CHECK/);
  });
});
