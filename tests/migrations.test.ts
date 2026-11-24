import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, openDatabase } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';

describe('database & migrations', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('applies every migration on a fresh database and is idempotent', () => {
    const db = new Database(':memory:');
    const first = db.migrate();
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.id));
    const second = db.migrate();
    expect(second.applied).toEqual([]);
    expect(second.current).toBe(Math.max(...MIGRATIONS.map((m) => m.id)));
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
    for (const t of ['players', 'ledger', 'escrows', 'game_tables', 'table_seats', 'game_rounds', 'round_results', 'player_stats', 'coinflip_challenges']) {
      expect(tables).toContain(t);
    }
  });

  it('preserves balances and existing ledger rows when adding wallet preferences', () => {
    const db = new Database(':memory:');
    db.migrate(MIGRATIONS.slice(0, 1));
    db.run("INSERT INTO players (guild_id, user_id, balance, highest_balance, passive_anchor_at, created_at, last_seen_at) VALUES ('g', 'u', 1000, 1000, 0, 0, 0)");
    db.run("INSERT INTO ledger (id, guild_id, user_id, type, amount, balance_after, reserved_after, idempotency_key, created_at) VALUES ('row', 'g', 'u', 'initial_grant', 1000, 1000, 0, 'welcome', 0)");
    const prior = db.get("SELECT * FROM ledger WHERE id = 'row'");
    expect(db.migrate().applied).toEqual(MIGRATIONS.slice(1).map((migration) => migration.id));
    expect(db.get("SELECT * FROM players WHERE guild_id = 'g' AND user_id = 'u'")).toMatchObject({
      balance: 1000, gifts_opt_out: 0, highlights_opt_out: 0, relief_title_until: null,
    });
    expect(db.get("SELECT * FROM ledger WHERE id = 'row'")).toEqual(prior);
    expect(() => db.run("UPDATE ledger SET amount = 0 WHERE id = 'row'")).toThrow(/append-only/);
    db.close();
  });

  it('persists to disk with WAL and survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'casino-db-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'casino.db');
    const db = openDatabase(path);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    db.run("INSERT INTO guild_settings (guild_id, settings_json, updated_at) VALUES ('g', '{}', 1)");
    db.close();
    const again = openDatabase(path);
    expect(again.get<{ n: number }>('SELECT COUNT(*) AS n FROM guild_settings')!.n).toBe(1);
    again.close();
  });

  it('rolls back nested savepoints independently and rejects async transactions', () => {
    const db = new Database(':memory:');
    db.migrate();
    db.transaction(() => {
      db.run("INSERT INTO guild_settings (guild_id, settings_json, updated_at) VALUES ('a', '{}', 1)");
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO guild_settings (guild_id, settings_json, updated_at) VALUES ('b', '{}', 1)");
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
    });
    expect(db.all<{ guild_id: string }>('SELECT guild_id FROM guild_settings').map((r) => r.guild_id)).toEqual(['a']);
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow(/synchronous/);
    expect(db.inTransaction).toBe(false);
  });

  it('enforces one seat per player per server and unique open table numbers', () => {
    const db = new Database(':memory:');
    db.migrate();
    const table = (id: string, n: number) =>
      db.run(
        "INSERT INTO game_tables (id, guild_id, game, number, name, owner_id, config_json, status, state_json, created_at, last_activity_at) VALUES (?, 'g', 'blackjack', ?, 'T', 'o', '{}', 'open', '{}', 1, 1)",
        [id, n],
      );
    table('t1', 1);
    table('t2', 2);
    expect(() => table('t3', 1)).toThrow(/UNIQUE/);
    db.run("INSERT INTO table_seats (table_id, guild_id, user_id, seat_index, joined_at) VALUES ('t1', 'g', 'u', 0, 1)");
    expect(() => db.run("INSERT INTO table_seats (table_id, guild_id, user_id, seat_index, joined_at) VALUES ('t2', 'g', 'u', 0, 1)")).toThrow(/UNIQUE/);
  });
});
