/** Time source abstraction so economy and timers are deterministic in tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private current: number = Date.UTC(2026, 0, 1, 12, 0, 0)) {}
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** UTC calendar day key, e.g. "2026-11-22". */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC day key as an integer, e.g. 20261122 (handy for integer stat storage). */
export function utcDayNumber(ms: number): number {
  return Number(utcDayKey(ms).replaceAll('-', ''));
}

export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function startOfUtcWeek(ms: number): number {
  const dayStart = startOfUtcDay(ms);
  const weekday = (new Date(dayStart).getUTCDay() + 6) % 7; // Monday = 0
  return dayStart - weekday * DAY;
}

export function previousUtcDayKey(dayKey: string): string {
  return utcDayKey(Date.parse(`${dayKey}T00:00:00.000Z`) - DAY);
}
