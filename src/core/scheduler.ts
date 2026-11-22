import type { Clock } from './clock.js';

/** Keyed one-shot timers. Re-setting a key replaces the previous timer. */
export interface Scheduler {
  set(key: string, at: number, fn: () => void): void;
  clear(key: string): void;
  clearAll(): void;
}

const MAX_DELAY = 2_147_483_000;

export class RealScheduler implements Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly clock: Clock) {}

  set(key: string, at: number, fn: () => void): void {
    this.clear(key);
    const delay = Math.min(MAX_DELAY, Math.max(0, at - this.clock.now()));
    const handle = setTimeout(() => {
      if (this.timers.get(key) === handle) this.timers.delete(key);
      fn();
    }, delay);
    handle.unref?.();
    this.timers.set(key, handle);
  }

  clear(key: string): void {
    const handle = this.timers.get(key);
    if (handle) clearTimeout(handle);
    this.timers.delete(key);
  }

  clearAll(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }
}

/** Deterministic scheduler for tests: timers only fire when `runDue()` is called. */
export class ManualScheduler implements Scheduler {
  readonly timers = new Map<string, { at: number; fn: () => void }>();

  constructor(private readonly clock: Clock) {}

  set(key: string, at: number, fn: () => void): void {
    this.timers.set(key, { at, fn });
  }

  clear(key: string): void {
    this.timers.delete(key);
  }

  clearAll(): void {
    this.timers.clear();
  }

  /** Fire every timer due at the current clock time. Returns how many fired. */
  runDue(): number {
    const now = this.clock.now();
    const due = [...this.timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [key, timer] of due) {
      if (this.timers.get(key) === timer) {
        this.timers.delete(key);
        timer.fn();
      }
    }
    return due.length;
  }

  nextAt(key: string): number | undefined {
    return this.timers.get(key)?.at;
  }
}
