import { ConfigError, loadEnvFile, readEnv } from './config/env.js';
import { Logger } from './core/logger.js';
import { openDatabase, type Database } from './db/database.js';
import { InstanceLockError, acquireInstanceLock, type InstanceLock } from './db/instance-lock.js';
import { CasinoApp } from './app/casino-app.js';
import { CasinoBot } from './discord/bot.js';
import { OutboundGuard, allowlistFromEnv } from './discord/outbound-guard.js';

/**
 * Entry point: load configuration, open (and migrate) the database, restore every game,
 * connect to Discord. Shuts down cleanly on Ctrl+C / SIGTERM.
 *
 * Exit codes: 0 = graceful shutdown; 1 = failed login or crash (scripts/start-casino.ps1 restarts);
 * 2 = configuration problem or another bot already using the database (no restart — fix it first).
 */
let logger: Logger = new Logger({ level: 'info' });
let db: Database | undefined;
let bot: CasinoBot | undefined;
let app: CasinoApp | undefined;
let lock: InstanceLock | null = null;
let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger[exitCode === 0 ? 'info' : 'error'](`shutting down: ${reason}`);
  const force = setTimeout(() => {
    logger.error('shutdown timed out; exiting');
    process.exit(exitCode || 1);
  }, 10_000);
  force.unref();
  try {
    await bot?.stop();
    await app?.shutdown();
  } catch (error) {
    logger.error('error during shutdown', { error });
  } finally {
    db?.close();
    lock?.release();
    logger.info('goodbye');
    process.exit(exitCode);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv();
  logger = new Logger({ level: env.logLevel, dir: env.logDir });
  logger.info('starting casino', { env: env.nodeEnv, database: env.databasePath });
  let allowlist;
  try {
    allowlist = allowlistFromEnv(process.env, env.clientId);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  try {
    lock = acquireInstanceLock(env.databasePath);
  } catch (error) {
    if (error instanceof InstanceLockError) throw new ConfigError(error.message);
    throw error;
  }
  process.on('exit', () => lock?.release());
  db = openDatabase(env.databasePath);
  app = new CasinoApp({ db, logger });
  bot = new CasinoBot(app, logger, { guard: allowlist ? new OutboundGuard(allowlist, logger) : null });

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: reason instanceof Error ? reason : String(reason) }));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    void shutdown('uncaught exception', 1);
  });

  await bot.start(env.token);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
    process.exit(2);
  }
  const code = (error as { code?: unknown } | null)?.code;
  const hint =
    code === 'TokenInvalid'
      ? 'Discord rejected the token. Check DISCORD_TOKEN in .env (Bot tab → Reset Token).'
      : code === 'DisallowedIntents'
        ? 'Discord refused the gateway intents. This bot only needs the Guilds intent; check the Bot tab.'
        : 'Could not start (network down or Discord unreachable?).';
  logger.error(`startup failed: ${hint}`, { error });
  // Nothing is running yet: release resources and let the event loop wind down naturally
  // (an abrupt process.exit() during discord.js teardown can trip a libuv assertion on Windows).
  shuttingDown = true;
  process.exitCode = 1;
  void (async () => {
    await app?.shutdown().catch(() => undefined);
    await bot?.client.destroy().catch(() => undefined);
    db?.close();
    lock?.release();
    setTimeout(() => process.exit(1), 2_000).unref();
  })();
});
