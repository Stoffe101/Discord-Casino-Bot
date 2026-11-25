import type { Database } from '../db/database.js';
import type { GameId } from './economy/economy-service.js';

export interface MatchResult {
  round_id: string;
  game: GameId;
  wagered: number;
  returned: number;
  net: number;
  outcome: string;
  detail_json: string | null;
  created_at: number;
}

export function readResultDetail(source: string | null): Record<string, unknown> {
  if (!source) return {};
  try {
    const detail: unknown = JSON.parse(source);
    return typeof detail === 'object' && detail !== null && !Array.isArray(detail)
      ? detail as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class MatchHistory {
  constructor(private readonly db: Database) {}

  get(guildId: string, userId: string, roundId: string): MatchResult | undefined {
    return this.db.get<MatchResult>(
      'SELECT * FROM round_results WHERE guild_id = ? AND user_id = ? AND round_id = ?', [guildId, userId, roundId],
    );
  }

  page(guildId: string, userId: string, game: GameId | undefined, requested: number, size: number) {
    const filter = game === undefined ? 'guild_id = ? AND user_id = ?' : 'guild_id = ? AND user_id = ? AND game = ?';
    const params = game === undefined ? [guildId, userId] : [guildId, userId, game];
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM round_results WHERE ${filter}`, params)!.n;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pages - 1, Math.max(0, requested));
    const results = this.db.all<MatchResult>(
      `SELECT * FROM round_results WHERE ${filter} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...params, size, page * size],
    );
    return { total, page, pages, results };
  }
}
