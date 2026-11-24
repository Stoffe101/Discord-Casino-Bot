import type { Database } from '../db/database.js';

const GUILD_TABLES = [
  'casino_events',
  'table_seats',
  'game_tables',
  'escrows',
  'round_results',
  'game_rounds',
  'player_stats',
  'player_achievements',
  'player_unlocks',
  'player_missions',
  'coinflip_challenges',
  'highlights',
  'ledger',
  'players',
] as const;

/**
 * Development-only wipe of one server's casino data. The ledger's append-only trigger is
 * suspended inside the same transaction and restored before commit. Callers must check that
 * the environment allows it (see /casinoadmin reset-dev).
 */
export function resetGuildData(db: Database, guildId: string): Record<string, number> {
  return db.transaction(() => {
    const counts: Record<string, number> = {};
    db.exec('DROP TRIGGER IF EXISTS ledger_is_append_only_delete');
    for (const table of GUILD_TABLES) {
      counts[table] = db.run(`DELETE FROM ${table} WHERE guild_id = ?`, [guildId]).changes;
    }
    db.exec(`CREATE TRIGGER ledger_is_append_only_delete BEFORE DELETE ON ledger
      BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`);
    return counts;
  });
}
