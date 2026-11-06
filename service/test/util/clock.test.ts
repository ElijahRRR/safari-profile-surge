import { describe, expect, test } from 'vitest';
import { FakeClock, systemClock } from '../../src/util/clock.js';

describe('FakeClock', () => {
  test('starts at the given time and now() returns a copy', () => {
    const c = new FakeClock('2026-03-01T00:00:00.000Z');
    const a = c.now();
    a.setFullYear(1999);
    expect(c.now().toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('advance fires due timers in time order, ties in scheduling order', () => {
    const c = new FakeClock(0);
    const fired: string[] = [];
    c.setTimeout(() => fired.push(`b@${c.now().getTime()}`), 200);
    c.setTimeout(() => fired.push(`a@${c.now().getTime()}`), 100);
    c.setTimeout(() => fired.push(`c@${c.now().getTime()}`), 200);
    c.setTimeout(() => fired.push('late'), 1000);
    c.advance(500);
    expect(fired).toEqual(['a@100', 'b@200', 'c@200']);
    expect(c.now().getTime()).toBe(500);
    expect(c.pendingTimers()).toBe(1);
  });

  test('cancel prevents a timer from firing', () => {
    const c = new FakeClock(0);
    let fired = false;
    const cancel = c.setTimeout(() => {
      fired = true;
    }, 10);
    cancel();
    c.advance(100);
    expect(fired).toBe(false);
    expect(c.pendingTimers()).toBe(0);
  });

  test('timers scheduled inside callbacks fire within the same advance when due', () => {
    const c = new FakeClock(0);
    const fired: number[] = [];
    c.setTimeout(() => {
      fired.push(c.now().getTime());
      c.setTimeout(() => fired.push(c.now().getTime()), 50);
    }, 100);
    c.advance(120);
    expect(fired).toEqual([100]);
    c.advance(30);
    expect(fired).toEqual([100, 150]);
  });

  test('set() changes time without firing; advance(0) then fires overdue timers', () => {
    const c = new FakeClock(0);
    let fired = 0;
    c.setTimeout(() => fired++, 100);
    c.set(new Date(1000));
    expect(fired).toBe(0);
    expect(c.nextTimerAt()?.getTime()).toBe(100);
    c.advance(0);
    expect(fired).toBe(1);
    expect(c.now().getTime()).toBe(1000);
  });

  test('advance rejects negative or non-finite durations', () => {
    const c = new FakeClock(0);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(Number.NaN)).toThrow(RangeError);
  });

  test('advanceAsync lets promise chains started by timers progress', async () => {
    const c = new FakeClock(0);
    const seen: string[] = [];
    c.setTimeout(() => {
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => seen.push('async-done'));
    }, 10);
    await c.advanceAsync(10);
    expect(seen).toEqual(['async-done']);
  });

  test('guards against runaway zero-delay timers', () => {
    const c = new FakeClock(0);
    const loop = () => {
      c.setTimeout(loop, 0);
    };
    c.setTimeout(loop, 0);
    expect(() => c.advance(0)).toThrow(/too many timers/);
  });
});

describe('systemClock', () => {
  test('now() is close to Date.now()', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  test('setTimeout fires and can be cancelled', async () => {
    let fired = 0;
    await new Promise<void>((resolve) => {
      systemClock.setTimeout(() => {
        fired++;
        resolve();
      }, 1);
    });
    const cancel = systemClock.setTimeout(() => fired++, 1);
    cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(1);
  });
});
