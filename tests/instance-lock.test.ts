import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLockError, acquireInstanceLock } from '../src/db/instance-lock.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dbPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'casino-lock-'));
  dirs.push(d);
  return join(d, 'casino.db');
};
const DEAD_PID = 2_147_483_000; // far above any real process id

describe('single bot instance per database', () => {
  it('refuses a second bot while the first one is running', () => {
    const path = dbPath();
    const first = acquireInstanceLock(path, process.pid)!;
    expect(() => acquireInstanceLock(path, DEAD_PID - 1)).toThrow(InstanceLockError);
    first.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    const second = acquireInstanceLock(path, DEAD_PID - 1)!;
    expect(second).not.toBeNull();
    second.release();
  });

  it('takes over a lock left behind by a crashed process', () => {
    const path = dbPath();
    writeFileSync(`${path}.lock`, String(DEAD_PID));
    const lock = acquireInstanceLock(path, process.pid)!;
    expect(lock).not.toBeNull();
    lock.release();
  });

  it('does not lock in-memory databases', () => {
    expect(acquireInstanceLock(':memory:')).toBeNull();
  });
});
