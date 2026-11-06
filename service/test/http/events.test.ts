import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServiceEventPayload } from '@sfe/contract';
import { formatSnapshotRequired, parseResumePoint } from '../../src/http/sse.js';
import { openStream, parseSse, startHarness, send, type Harness } from './server-harness.js';

const ev = (id: string): ServiceEventPayload => ({ type: 'environment.deleted', environmentId: id });

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
  h = null;
});

describe('GET /api/events', () => {
  test('requires Bearer auth', async () => {
    h = await startHarness();
    const r = await send(h, { path: '/api/events', token: null });
    expect(r.status).toBe(401);
  });

  test('text/event-stream with security headers and no-store', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    expect(s.status).toBe(200);
    s.close();
  });

  test('live events carry id = sequence and event = type', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    h.app.events.publish(ev('env_a'));
    await s.until(() => parseSse(s.text).length === 1);
    const [first] = parseSse(s.text);
    expect(first).toEqual({ id: '1', event: 'environment.deleted', data: { type: 'environment.deleted', environmentId: 'env_a', sequence: 1 } });
    s.close();
  });

  test('replays from Last-Event-ID, then continues live without duplicates', async () => {
    h = await startHarness();
    for (const id of ['a', 'b', 'c']) h.app.events.publish(ev(id));
    const s = openStream(h, '/api/events', { 'last-event-id': '1' });
    await s.until(() => parseSse(s.text).length === 2);
    h.app.events.publish(ev('d'));
    await s.until(() => parseSse(s.text).length === 3);
    expect(parseSse(s.text).map((e) => e.id)).toEqual(['2', '3', '4']);
    s.close();
  });

  test('replays from ?since=', async () => {
    h = await startHarness();
    for (const id of ['a', 'b', 'c']) h.app.events.publish(ev(id));
    const s = openStream(h, '/api/events?since=2');
    await s.until(() => parseSse(s.text).length === 1);
    expect(parseSse(s.text)[0]!.id).toBe('3');
    s.close();
  });

  test('Last-Event-ID wins over ?since=', async () => {
    h = await startHarness();
    for (const id of ['a', 'b', 'c']) h.app.events.publish(ev(id));
    const s = openStream(h, '/api/events?since=0', { 'last-event-id': '2' });
    await s.until(() => parseSse(s.text).length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(parseSse(s.text).map((e) => e.id)).toEqual(['3']);
    s.close();
  });

  test('no resume point → only new events', async () => {
    h = await startHarness();
    h.app.events.publish(ev('old'));
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    h.app.events.publish(ev('new'));
    await s.until(() => parseSse(s.text).length === 1);
    expect(parseSse(s.text)[0]!.data.environmentId).toBe('new');
    s.close();
  });

  test('gap beyond the buffer → snapshot.required, then live events continue', async () => {
    h = await startHarness();
    for (let i = 0; i < 1100; i++) h.app.events.publish(ev(`e${i}`));
    const s = openStream(h, '/api/events', { 'last-event-id': '5' });
    await s.until(() => s.text.includes('snapshot.required'));
    const [first] = parseSse(s.text);
    expect(first).toEqual({ id: null, event: 'snapshot.required', data: { type: 'snapshot.required', reason: 'events_expired' } });
    h.app.events.publish(ev('after'));
    await s.until(() => parseSse(s.text).length === 2);
    expect(parseSse(s.text)[1]!.id).toBe('1101');
    s.close();
  });

  test('resume point ahead of the bus (service restarted) → snapshot.required', async () => {
    h = await startHarness();
    h.app.events.publish(ev('a'));
    const s = openStream(h, '/api/events', { 'last-event-id': '900' });
    await s.until(() => s.text.includes('snapshot.required'));
    expect(parseSse(s.text)[0]!.data.reason).toBe('sequence_ahead');
    s.close();
  });

  test('malformed Last-Event-ID → snapshot.required', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events', { 'last-event-id': 'abc' });
    await s.until(() => s.text.includes('snapshot.required'));
    expect(parseSse(s.text)[0]!.data.reason).toBe('invalid_last_event_id');
    s.close();
  });

  test('heartbeat comment every 15 s (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    expect(s.text).not.toContain(': heartbeat');
    vi.advanceTimersByTime(14_999);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.text).not.toContain(': heartbeat');
    vi.advanceTimersByTime(1);
    await s.until(() => s.text.includes(': heartbeat'));
    vi.advanceTimersByTime(15_000);
    await s.until(() => s.text.split(': heartbeat').length === 3);
    s.close();
  });

  test('the stream ends at the next heartbeat after the session is revoked', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    h.sessions.revoke(h.token);
    vi.advanceTimersByTime(15_000);
    await s.until(() => s.ended);
    expect(s.text).not.toContain(': heartbeat');
  });

  test('the stream ends at the next heartbeat after the session idles out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    vi.advanceTimersByTime(15_000);
    await s.until(() => s.text.includes(': heartbeat'));
    // 心跳不续期：空闲 2 小时后结束
    h.clock.advance(2 * 60 * 60 * 1000);
    vi.advanceTimersByTime(15_000);
    await s.until(() => s.ended);
  });

  test('logout closes the stream immediately', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    const r = await send(h, { method: 'POST', path: '/api/session/logout', body: '{}' });
    expect(r.status).toBe(204);
    await s.until(() => s.ended);
  });

  test('logout of one session leaves other sessions streaming', async () => {
    h = await startHarness();
    const { loginToken } = await import('./helpers.js');
    const other = loginToken(h.sessions);
    const a = openStream(h, '/api/events');
    const b = openStream(h, '/api/events', {}, other);
    await a.until(() => a.text.includes(': connected'));
    await b.until(() => b.text.includes(': connected'));
    await send(h, { method: 'POST', path: '/api/session/logout', body: '{}' });
    await a.until(() => a.ended);
    h.app.events.publish(ev('still'));
    await b.until(() => parseSse(b.text).length === 1);
    expect(b.ended).toBe(false);
    b.close();
  });

  test('server close ends open streams', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    await h.close();
    await s.until(() => s.ended);
    h = null;
  });

  test('client disconnect unsubscribes from the bus', async () => {
    h = await startHarness();
    const s = openStream(h, '/api/events');
    await s.until(() => s.text.includes(': connected'));
    s.close();
    await new Promise((r) => setTimeout(r, 50));
    // 断开后发布不会抛错，也不会写到已关闭的连接
    expect(() => h!.app.events.publish(ev('x'))).not.toThrow();
  });
});

describe('sse helpers', () => {
  test('parseResumePoint', () => {
    expect(parseResumePoint(null)).toEqual({ kind: 'none' });
    expect(parseResumePoint('')).toEqual({ kind: 'none' });
    expect(parseResumePoint(' 12 ')).toEqual({ kind: 'seq', seq: 12 });
    expect(parseResumePoint('-1')).toEqual({ kind: 'invalid' });
    expect(parseResumePoint('1.5')).toEqual({ kind: 'invalid' });
  });

  test('formatSnapshotRequired has no id line', () => {
    expect(formatSnapshotRequired('x')).toBe('event: snapshot.required\ndata: {"type":"snapshot.required","reason":"x"}\n\n');
  });
});
