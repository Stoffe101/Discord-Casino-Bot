import { existsSync } from 'node:fs';
import type { LogLevel } from '../core/logger.js';

export interface AppEnv {
  token: string;
  clientId: string;
  devGuildId: string | undefined;
  nodeEnv: 'development' | 'production';
  databasePath: string;
  logLevel: LogLevel;
  logDir: string | undefined;
  allowDevReset: boolean;
  nicknameGuildId: string | undefined;
}

/** Load `.env` (if present) using Node's built-in loader — no dotenv dependency needed. */
export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export class ConfigError extends Error {}

export function readEnv(options: { requireToken: boolean } = { requireToken: true }): AppEnv {
  const env = process.env;
  const token = (env.DISCORD_TOKEN ?? '').trim();
  const clientId = (env.DISCORD_CLIENT_ID ?? '').trim();
  const problems: string[] = [];
  if (options.requireToken && !token) problems.push('DISCORD_TOKEN is not set');
  if (options.requireToken && !/^\d{15,22}$/.test(clientId)) problems.push('DISCORD_CLIENT_ID must be your application ID');
  const devGuildId = (env.DISCORD_DEV_GUILD_ID ?? '').trim() || undefined;
  if (devGuildId && !/^\d{15,22}$/.test(devGuildId)) problems.push('DISCORD_DEV_GUILD_ID must be a server ID');
  const nicknameGuildId = (env.CASINO_NICKNAME_GUILD_ID ?? '').trim() || undefined;
  if (nicknameGuildId && !/^\d{15,22}$/.test(nicknameGuildId)) problems.push('CASINO_NICKNAME_GUILD_ID must be a server ID');
  const level = (env.LOG_LEVEL ?? 'info').trim() as LogLevel;
  if (!['trace', 'debug', 'info', 'warn', 'error'].includes(level)) problems.push('LOG_LEVEL is invalid');
  if (problems.length) {
    throw new ConfigError(`Configuration problem:\n  • ${problems.join('\n  • ')}\nCopy .env.example to .env and fill it in.`);
  }
  return {
    token,
    clientId,
    devGuildId,
    nodeEnv: env.NODE_ENV === 'production' ? 'production' : 'development',
    databasePath: (env.DATABASE_PATH ?? './data/casino.db').trim() || './data/casino.db',
    logLevel: level,
    logDir: (env.LOG_DIR ?? './logs').trim() || undefined,
    allowDevReset: env.ALLOW_DEV_RESET === 'true',
    nicknameGuildId,
  };
}
