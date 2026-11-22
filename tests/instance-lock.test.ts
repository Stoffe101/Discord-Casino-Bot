import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstanceLockError, acquireInstanceLock, lockEndpoint } from '../src/db/instance-lock.js';

const uniquePath = (name: string) => join(tmpdir(), `casino-lock-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, name);

describe('single bot instance per database', () => {
  it('refuses a second bot on the same database while the first runs', async () => {
    const path = uniquePath('casino.db');
    const first = (await acquireInstanceLock(path))!;
    await expect(acquireInstanceLock(path)).rejects.toBeInstanceOf(InstanceLockError);
    // A different database is independent.
    const other = (await acquireInstanceLock(uniquePath('other.db')))!;
    await other.release();
    await first.release();
    const again = (await acquireInstanceLock(path))!;
    await again.release();
  });

  it('works before the data folder exists (fresh clone)', async () => {
    const lock = await acquireInstanceLock(join(uniquePath('missing-dir'), 'nested', 'casino.db'));
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('is released by the OS when the owning process is killed hard', async () => {
    const path = uniquePath('casino.db');
    const endpoint = lockEndpoint(path);
    // Another process holds the lock (same mechanism the bot uses), then dies without cleanup.
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(endpoint)}, () => console.log('ready'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout!, 'data');
    await expect(acquireInstanceLock(path)).rejects.toBeInstanceOf(InstanceLockError);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const lock = (await acquireInstanceLock(path))!;
    expect(lock).not.toBeNull();
    await lock.release();
  });

  it('does not lock in-memory databases', async () => {
    expect(await acquireInstanceLock(':memory:')).toBeNull();
  });
});
