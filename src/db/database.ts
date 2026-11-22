import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from './sqlite.js';
import { MIGRATIONS, type Migration } from './migrations.js';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlInput = SqlValue | boolean | undefined;
export type SqlParams = Record<string, SqlInput> | SqlInput[];

/**
 * Thin, synchronous wrapper around node:sqlite.
 *
 * Every economy mutation runs inside `transaction()`, which is synchronous by design:
 * nothing can interleave with it inside this process, and SQLite guarantees atomicity.
 * Passing an async function is rejected so that nobody accidentally awaits mid-transaction.
 */
export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointCounter = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA temp_store = MEMORY');
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
    const stmt = this.statement(sql);
    const result = Array.isArray(params)
      ? stmt.run(...normalizeList(params))
      : params
        ? stmt.run(normalizeNamed(params))
        : stmt.run();
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    const stmt = this.statement(sql);
    const row = Array.isArray(params)
      ? stmt.get(...normalizeList(params))
      : params
        ? stmt.get(normalizeNamed(params))
        : stmt.get();
    return row as T | undefined;
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    const stmt = this.statement(sql);
    const rows = Array.isArray(params)
      ? stmt.all(...normalizeList(params))
      : params
        ? stmt.all(normalizeNamed(params))
        : stmt.all();
    return rows as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Runs `fn` atomically. Nested calls use savepoints, so services can compose freely.
   * Any thrown error rolls back everything done inside `fn`.
   */
  transaction<T>(fn: () => T): T {
    const outermost = this.depth === 0;
    const savepoint = outermost ? '' : `sp_${++this.savepointCounter}`;
    this.raw.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error('Database.transaction() callbacks must be synchronous');
      }
      this.depth--;
      this.raw.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      if (outermost) {
        this.raw.exec('ROLLBACK');
      } else {
        this.raw.exec(`ROLLBACK TO ${savepoint}`);
        this.raw.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    }
  }

  migrate(migrations: readonly Migration[] = MIGRATIONS): { applied: number[]; current: number } {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    const done = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    const applied: number[] = [];
    const ordered = [...migrations].sort((a, b) => a.id - b.id);
    for (const migration of ordered) {
      if (done.has(migration.id)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          Date.now(),
        ]);
      });
      applied.push(migration.id);
    }
    const current = this.get<{ v: number | null }>('SELECT MAX(id) AS v FROM schema_migrations')?.v ?? 0;
    return { applied, current };
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) {
      if (this.path !== ':memory:') {
        try {
          this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          // Best effort.
        }
      }
      this.raw.close();
    }
  }
}

function normalizeValue(value: SqlInput): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeList(params: SqlInput[]): SqlValue[] {
  return params.map(normalizeValue);
}

function normalizeNamed(params: Record<string, SqlInput>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) out[key] = normalizeValue(value);
  return out;
}

export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.migrate();
  return db;
}
