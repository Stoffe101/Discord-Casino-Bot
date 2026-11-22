import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

export interface LoggerOptions {
  level: LogLevel;
  /** Directory for daily JSON-lines log files. Undefined disables file logging. */
  dir?: string | undefined;
  /** Disable console output (used by tests). */
  silent?: boolean;
}

type Fields = Record<string, unknown>;

/**
 * Minimal structured logger: human-friendly console lines plus daily JSON-lines files.
 * Deliberately dependency-free so the bot runs anywhere Node runs.
 */
export class Logger {
  private readonly threshold: number;

  constructor(
    private readonly options: LoggerOptions,
    private readonly bindings: Fields = {},
  ) {
    this.threshold = LEVELS[options.level];
    if (options.dir) mkdirSync(options.dir, { recursive: true });
  }

  child(bindings: Fields): Logger {
    return new Logger(this.options, { ...this.bindings, ...bindings });
  }

  trace(msg: string, fields?: Fields): void {
    this.write('trace', msg, fields);
  }
  debug(msg: string, fields?: Fields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    if (LEVELS[level] < this.threshold) return;
    const now = new Date();
    const record = { time: now.toISOString(), level, msg, ...this.bindings, ...serializeFields(fields) };
    if (!this.options.silent) {
      const extra = { ...this.bindings, ...serializeFields(fields) };
      const extraText = Object.keys(extra).length ? ` \x1b[90m${safeJson(extra)}\x1b[0m` : '';
      const line = `${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m ${now.toISOString().slice(11, 19)} ${msg}${extraText}`;
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    }
    if (this.options.dir) {
      try {
        const file = join(this.options.dir, `casino-${now.toISOString().slice(0, 10)}.log`);
        appendFileSync(file, safeJson(record) + '\n');
      } catch {
        // Never let logging failures crash the bot.
      }
    }
  }
}

function serializeFields(fields?: Fields): Fields {
  if (!fields) return {};
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return '"[unserializable]"';
  }
}

export const silentLogger = new Logger({ level: 'error', silent: true });
