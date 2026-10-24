import { describe, expect, test } from 'vitest';
import { openRepositories } from '../../src/db/index.js';
import { createEventBus } from '../../src/engine/events.js';

const ev = (n: number) => ({ type: 'snapshot.required' as const, reason: `r${n}` });

describe('event bus', () => {
  test('sequence is monotonic and persisted across instances', () => {
    const repos = openRepositories(':memory:');
    const a = createEventBus({ meta: repos.meta });
    expect(a.publish(ev(1))).toBe(1);
    expect(a.publish(ev(2))).toBe(2);
    const b = createEventBus({ meta: repos.meta });
    expect(b.currentSequence()).toBe(2);
    expect(b.publish(ev(3))).toBe(3);
  });

  test('since returns missed events, [] when up to date', () => {
    const repos = openRepositories(':memory:');
    const bus = createEventBus({ meta: repos.meta });
    for (let i = 1; i <= 5; i++) bus.publish(ev(i));
    expect(bus.since(2)!.map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(bus.since(5)).toEqual([]);
    expect(bus.since(9)).toEqual([]);
  });

  test('since returns null when the request fell out of the ring buffer', () => {
    const repos = openRepositories(':memory:');
    const bus = createEventBus({ meta: repos.meta, capacity: 3 });
    for (let i = 1; i <= 6; i++) bus.publish(ev(i));
    expect(bus.size).toBe(3);
    expect(bus.since(2)).toBeNull();
    expect(bus.since(3)!.map((e) => e.sequence)).toEqual([4, 5, 6]);
  });

  test('since returns null for sequences that predate this process', () => {
    const repos = openRepositories(':memory:');
    const first = createEventBus({ meta: repos.meta });
    for (let i = 1; i <= 4; i++) first.publish(ev(i));
    const second = createEventBus({ meta: repos.meta });
    second.publish(ev(5));
    expect(second.baseSequence).toBe(4);
    expect(second.since(2)).toBeNull();
    expect(second.since(4)!.map((e) => e.sequence)).toEqual([5]);
  });

  test('subscriber errors do not break publishing', () => {
    const repos = openRepositories(':memory:');
    const errors: unknown[] = [];
    const bus = createEventBus({ meta: repos.meta, onListenerError: (e) => errors.push(e) });
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    const off = bus.subscribe((e) => seen.push(e.sequence));
    bus.publish(ev(1));
    off();
    bus.publish(ev(2));
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(2);
  });

  test('rejects invalid since values', () => {
    const repos = openRepositories(':memory:');
    const bus = createEventBus({ meta: repos.meta });
    bus.publish(ev(1));
    expect(bus.since(-1)).toBeNull();
    expect(bus.since(1.5)).toBeNull();
  });
});
