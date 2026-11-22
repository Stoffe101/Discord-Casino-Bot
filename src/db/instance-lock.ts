import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

/**
 * One bot process per database. Two processes on the same SQLite file would each keep their own
 * in-memory table state and fight over panels and timers, so the second one refuses to start.
 *
 * The lock is a small file next to the database holding the owner's PID. A lock left behind by a
 * crashed process (its PID no longer running) is taken over automatically.
 */
export class InstanceLockError extends Error {}

export interface InstanceLock {
  path: string;
  release(): void;
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists but belongs to someone else
  }
}

export function acquireInstanceLock(databasePath: string, pid = process.pid): InstanceLock | null {
  if (databasePath === ':memory:') return null;
  const path = `${databasePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = NaN;
      try {
        owner = Number(readFileSync(path, 'utf8').trim());
      } catch {
        // Unreadable: treat as stale.
      }
      if (owner === pid) return { path, release: () => rmSync(path, { force: true }) };
      if (isRunning(owner)) {
        throw new InstanceLockError(
          `Another casino bot (process ${owner}) is already using ${databasePath}.\n` +
            'Stop it first — two bots on one database would conflict. If no bot is running, delete ' +
            `${path} and try again.`,
        );
      }
      rmSync(path, { force: true }); // stale lock from a crashed process
    }
  }
  throw new InstanceLockError(`Could not lock ${databasePath}.`);
}
