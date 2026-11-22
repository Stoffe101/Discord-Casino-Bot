import { ConfigError, loadEnvFile, readEnv } from './config/env.js';
import { Logger } from './core/logger.js';
import { openDatabase } from './db/database.js';
import { CasinoApp } from './app/casino-app.js';
import { CasinoBot } from './discord/bot.js';

/**
 * Entry point: load configuration, open (and migrate) the database, restore every game,
 * connect to Discord. Shuts down cleanly on Ctrl+C / SIGTERM.
 */
async function main(): Promise<void> {
  loadEnvFile();
  let env;
  try {
    env = readEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const logger = new Logger({ level: env.logLevel, dir: env.logDir });
  logger.info('starting casino', { env: env.nodeEnv, database: env.databasePath });
  const db = openDatabase(env.databasePath);
  const app = new CasinoApp({ db, logger });
  const bot = new CasinoBot(app, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}; shutting down`);
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      await bot.stop();
      await app.shutdown();
    } finally {
      db.close();
      logger.info('goodbye');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: reason instanceof Error ? reason : String(reason) }));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    void shutdown('uncaughtException');
  });

  await bot.start(env.token);
}

void main();
