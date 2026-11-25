/**
 * RealScheduler never runs a callback before the clock says it is due. Node's timers keep their
 * own monotonic time, so a timer can fire a little before Date.now() reaches the target; roulette
 * spins and Hold'em turn timeouts check the clock and would silently drop such a call (found by
 * the interaction bench: a wheel whose spin time had passed 22 s earlier never spun).
 *
 * Fake timers drive setTimeout; the scheduler's clock is made to trail them, which is exactly
 * what an early fire looks like.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Clock } from '../src/core/clock.js';
import { RealScheduler } from '../src/core/scheduler.js';

let lag = 0;
const clock: Clock = { now: () => Date.now() - lag };

beforeEach(() => {
  vi.useFakeTimers();
  lag = 0;
});
afterEach(() => vi.useRealTimers());

it('a timer that fires before the clock reaches its time waits out the rest, then runs once', () => {
  const scheduler = new RealScheduler(clock);
  const calls: number[] = [];
  const at = clock.now() + 20;
  scheduler.set('spin', at, () => calls.push(clock.now()));
  lag = 5; // the wall clock trails the timer by 5 ms
  vi.advanceTimersByTime(20); // the timer fires; the clock still reads 5 ms early
  expect(calls).toEqual([]);
  vi.advanceTimersByTime(5);
  expect(calls).toEqual([at]);
  vi.advanceTimersByTime(100);
  expect(calls).toHaveLength(1);
});

it('clearing or replacing a timer still cancels it while it waits out an early fire', () => {
  const scheduler = new RealScheduler(clock);
  const calls: string[] = [];
  scheduler.set('a', clock.now() + 10, () => calls.push('a'));
  scheduler.set('b', clock.now() + 10, () => calls.push('b-old'));
  lag = 30;
  vi.advanceTimersByTime(10); // both fired early and re-armed
  scheduler.clear('a');
  scheduler.set('b', clock.now() + 5, () => calls.push('b-new'));
  vi.advanceTimersByTime(100);
  expect(calls).toEqual(['b-new']);
});

it('an on-time timer runs exactly once', () => {
  const scheduler = new RealScheduler(clock);
  let calls = 0;
  scheduler.set('t', clock.now() + 50, () => calls++);
  vi.advanceTimersByTime(49);
  expect(calls).toBe(0);
  vi.advanceTimersByTime(1);
  expect(calls).toBe(1);
});
