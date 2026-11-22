import type { Database } from '../db/database.js';

export type StatSnapshot = Record<string, Record<string, number>>;

/**
 * Flexible integer statistics keyed by (game, stat). New games add new stat names without
 * needing a migration. Use game 'all' for cross-game totals.
 */
export class StatsService {
  constructor(private readonly db: Database) {}

  bump(guildId: string, userId: string, game: string, stat: string, delta: number): void {
    if (delta === 0) return;
    this.db.run(
      `INSERT INTO player_stats (guild_id, user_id, game, stat, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, game, stat) DO UPDATE SET value = value + excluded.value`,
      [guildId, userId, game, stat, delta],
    );
  }

  raise(guildId: string, userId: string, game: string, stat: string, value: number): void {
    this.db.run(
      `INSERT INTO player_stats (guild_id, user_id, game, stat, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, game, stat) DO UPDATE SET value = MAX(value, excluded.value)`,
      [guildId, userId, game, stat, value],
    );
  }

  set(guildId: string, userId: string, game: string, stat: string, value: number): void {
    this.db.run(
      `INSERT INTO player_stats (guild_id, user_id, game, stat, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, game, stat) DO UPDATE SET value = excluded.value`,
      [guildId, userId, game, stat, value],
    );
  }

  get(guildId: string, userId: string, game: string, stat: string): number {
    return (
      this.db.get<{ value: number }>('SELECT value FROM player_stats WHERE guild_id = ? AND user_id = ? AND game = ? AND stat = ?', [
        guildId,
        userId,
        game,
        stat,
      ])?.value ?? 0
    );
  }

  snapshot(guildId: string, userId: string): StatSnapshot {
    const rows = this.db.all<{ game: string; stat: string; value: number }>(
      'SELECT game, stat, value FROM player_stats WHERE guild_id = ? AND user_id = ?',
      [guildId, userId],
    );
    const out: StatSnapshot = {};
    for (const row of rows) (out[row.game] ??= {})[row.stat] = row.value;
    return out;
  }
}

export function stat(snapshot: StatSnapshot, game: string, name: string): number {
  return snapshot[game]?.[name] ?? 0;
}
