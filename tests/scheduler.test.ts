/**
 * RealScheduler never runs a callback before the clock says it is due. Node's timers keep their
 * own monotonic time, so a timer can fire a little before Date.now() reaches the target; roulette
 * spins and Hold'em turn timeouts check the clock and would silently drop such a call (found by
 * the interaction bench: a wheel whose spin time had passed 22 s earlier never spun).
 */
import { expect, it } from 'vitest';
import type { Clock } from '../src/core/clock.js';
import { RealScheduler } from '../src/core/scheduler.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('a timer that fires before the clock reaches its time waits out the rest, then runs once', async () => {
  let lag = 0;
  const clock: Clock = { now: () => Date.now() - lag };
  const scheduler = new RealScheduler(clock);
  const calls: number[] = [];
  const at = clock.now() + 20;
  scheduler.set('spin', at, () => calls.push(clock.now()));
  lag = 40; // the wall clock now trails the timer: when it fires, the clock still reads ~20 ms early
  await wait(35);
  expect(calls).toEqual([]);
  await wait(60);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeGreaterThanOrEqual(at);
  scheduler.clearAll();
});

it('clearing or replacing a timer still cancels it while it waits out an early fire', async () => {
  let lag = 0;
  const clock: Clock = { now: () => Date.now() - lag };
  const scheduler = new RealScheduler(clock);
  const calls: string[] = [];
  scheduler.set('a', clock.now() + 10, () => calls.push('a'));
  scheduler.set('b', clock.now() + 10, () => calls.push('b-old'));
  lag = 30;
  await wait(20); // both fired early and re-armed
  scheduler.clear('a');
  scheduler.set('b', clock.now() + 5, () => calls.push('b-new'));
  await wait(80);
  expect(calls).toEqual(['b-new']);
  scheduler.clearAll();
});
