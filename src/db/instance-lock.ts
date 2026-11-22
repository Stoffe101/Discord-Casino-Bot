import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * One bot process per database. Two processes on the same SQLite file would each keep their own
 * in-memory table state and fight over panels and timers, so the second one refuses to start.
 *
 * The lock is a local IPC endpoint keyed on the database's absolute path: a named pipe on Windows,
 * a Unix socket elsewhere. The operating system releases it when the process ends — including a
 * crash, a hard kill or a reboot — so there is no stale lock file to clean up and no PID that
 * could be reused by an unrelated program.
 */
export class InstanceLockError extends Error {}

export interface InstanceLock {
  endpoint: string;
  release(): Promise<void>;
}

export function lockEndpoint(databasePath: string): string {
  const key = createHash('sha1').update(resolve(databasePath).toLowerCase()).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\emerald-room-${key}` : join(tmpdir(), `emerald-room-${key}.sock`);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(endpoint, () => {
      server.off('error', fail);
      ok();
    });
  });
}

/** True if something is accepting connections on the endpoint (a live bot). */
function isAlive(endpoint: string): Promise<boolean> {
  return new Promise((ok) => {
    const socket = createConnection(endpoint);
    const done = (alive: boolean) => {
      socket.destroy();
      ok(alive);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1_000).unref();
  });
}

export async function acquireInstanceLock(databasePath: string): Promise<InstanceLock | null> {
  if (databasePath === ':memory:') return null;
  const endpoint = lockEndpoint(databasePath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer((socket) => socket.end());
    try {
      await listen(server, endpoint);
      server.unref(); // never keeps the process alive on its own
      return { endpoint, release: () => new Promise((ok) => server.close(() => ok())) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (await isAlive(endpoint)) {
        throw new InstanceLockError(
          `Another casino bot is already running against ${databasePath}.\n` +
            'Stop it first — two bots on one database would conflict (look for another terminal, `npm run dev` or the Windows runner).',
        );
      }
      // A Unix socket file left by a crashed process: nothing is listening, so remove it and retry.
      if (process.platform !== 'win32') rmSync(endpoint, { force: true });
    }
  }
  throw new InstanceLockError(`Could not lock ${databasePath}.`);
}
