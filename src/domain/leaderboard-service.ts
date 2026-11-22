import type { Database, SqlInput } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { startOfUtcDay, startOfUtcWeek } from '../core/clock.js';
import { chips, percent, signedChips } from '../core/format.js';
import { levelInfo } from './progression.js';

export type LeaderboardCategory =
  | 'richest'
  | 'net'
  | 'wins'
  | 'blackjacks'
  | 'win_rate'
  | 'biggest_win'
  | 'best_streak'
  | 'level';

export type LeaderboardPeriod = 'all' | 'week' | 'day';

export interface CategoryInfo {
  id: LeaderboardCategory;
  label: string;
  short: string;
  description: string;
  periods: readonly LeaderboardPeriod[];
}

export const MIN_HANDS_FOR_WIN_RATE = 25;

export const LEADERBOARD_CATEGORIES: readonly CategoryInfo[] = [
  { id: 'richest', label: 'Richest Players', short: 'Richest', description: 'Total chips, including chips on the table', periods: ['all'] },
  { id: 'net', label: 'Net Winnings', short: 'Net', description: 'Chips won minus chips lost at the games', periods: ['all', 'week', 'day'] },
  { id: 'wins', label: 'Blackjack Victories', short: 'Wins', description: 'Blackjack rounds finished ahead', periods: ['all', 'week', 'day'] },
  { id: 'blackjacks', label: 'Natural Blackjacks', short: 'Naturals', description: 'Two-card 21s dealt', periods: ['all'] },
  {
    id: 'win_rate',
    label: 'Hand Win Rate',
    short: 'Win rate',
    description: `Blackjack hands won (minimum ${MIN_HANDS_FOR_WIN_RATE} hands)`,
    periods: ['all'],
  },
  { id: 'biggest_win', label: 'Biggest Single Win', short: 'Biggest win', description: 'Largest net win in one round', periods: ['all'] },
  { id: 'best_streak', label: 'Longest Win Streak', short: 'Streak', description: 'Consecutive blackjack rounds won', periods: ['all'] },
  { id: 'level', label: 'Most Experienced', short: 'Level', description: 'Casino level from experience', periods: ['all'] },
];

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  value: number;
  display: string;
}

export interface LeaderboardPage {
  category: CategoryInfo;
  period: LeaderboardPeriod;
  page: number;
  pages: number;
  total: number;
  entries: LeaderboardEntry[];
  viewer: LeaderboardEntry | null;
}

/** Server-specific rankings computed from known casino accounts (never from member lists). */
export class LeaderboardService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  page(
    guildId: string,
    categoryId: LeaderboardCategory,
    period: LeaderboardPeriod,
    page: number,
    pageSize: number,
    viewerId: string | null,
  ): LeaderboardPage {
    const category = LEADERBOARD_CATEGORIES.find((c) => c.id === categoryId) ?? LEADERBOARD_CATEGORIES[0]!;
    const effectivePeriod = category.periods.includes(period) ? period : 'all';
    const { sql, params } = this.source(guildId, category.id, effectivePeriod);
    const ranked = `WITH source AS (${sql}),
      ranked AS (
        SELECT s.user_id, s.value, p.display_name,
               ROW_NUMBER() OVER (ORDER BY s.value DESC, s.user_id ASC) AS rank
        FROM source s
        JOIN players p ON p.guild_id = ? AND p.user_id = s.user_id
        WHERE p.leaderboard_opt_out = 0
      )`;
    const total = this.db.get<{ n: number }>(`${ranked} SELECT COUNT(*) AS n FROM ranked`, [...params, guildId])?.n ?? 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(0, page), pages - 1);
    type Row = { user_id: string; value: number; display_name: string; rank: number };
    const rows = this.db.all<Row>(`${ranked} SELECT * FROM ranked ORDER BY rank LIMIT ? OFFSET ?`, [
      ...params,
      guildId,
      pageSize,
      safePage * pageSize,
    ]);
    const viewerRow = viewerId
      ? this.db.get<Row>(`${ranked} SELECT * FROM ranked WHERE user_id = ?`, [...params, guildId, viewerId])
      : undefined;
    const toEntry = (r: Row): LeaderboardEntry => ({
      rank: r.rank,
      userId: r.user_id,
      displayName: r.display_name,
      value: r.value,
      display: formatValue(category.id, r.value),
    });
    return {
      category,
      period: effectivePeriod,
      page: safePage,
      pages,
      total,
      entries: rows.map(toEntry),
      viewer: viewerRow ? toEntry(viewerRow) : null,
    };
  }

  /** Viewer's rank in a category (used on the profile screen). */
  rankOf(guildId: string, category: LeaderboardCategory, userId: string): number | null {
    return this.page(guildId, category, 'all', 0, 1, userId).viewer?.rank ?? null;
  }

  private source(guildId: string, category: LeaderboardCategory, period: LeaderboardPeriod): { sql: string; params: SqlInput[] } {
    const now = this.clock.now();
    const since = period === 'day' ? startOfUtcDay(now) : period === 'week' ? startOfUtcWeek(now) : 0;
    const statSql = (game: string, stat: string) => ({
      sql: 'SELECT user_id, value FROM player_stats WHERE guild_id = ? AND game = ? AND stat = ? AND value > 0',
      params: [guildId, game, stat] as SqlInput[],
    });
    switch (category) {
      case 'richest':
        return {
          sql: 'SELECT user_id, balance + reserved AS value FROM players WHERE guild_id = ?',
          params: [guildId],
        };
      case 'net':
        if (period === 'all') {
          return {
            sql: "SELECT user_id, value FROM player_stats WHERE guild_id = ? AND game = 'all' AND stat = 'net'",
            params: [guildId],
          };
        }
        return {
          sql: 'SELECT user_id, SUM(net) AS value FROM round_results WHERE guild_id = ? AND created_at >= ? GROUP BY user_id',
          params: [guildId, since],
        };
      case 'wins':
        if (period === 'all') return statSql('blackjack', 'wins');
        return {
          sql: "SELECT user_id, COUNT(*) AS value FROM round_results WHERE guild_id = ? AND game = 'blackjack' AND net > 0 AND created_at >= ? GROUP BY user_id",
          params: [guildId, since],
        };
      case 'blackjacks':
        return statSql('blackjack', 'blackjacks');
      case 'win_rate':
        return {
          sql: `SELECT h.user_id, (w.value * 1000) / h.value AS value
                FROM player_stats h
                JOIN player_stats w ON w.guild_id = h.guild_id AND w.user_id = h.user_id AND w.game = 'blackjack' AND w.stat = 'hands_won'
                WHERE h.guild_id = ? AND h.game = 'blackjack' AND h.stat = 'hands' AND h.value >= ?`,
          params: [guildId, MIN_HANDS_FOR_WIN_RATE],
        };
      case 'biggest_win':
        return statSql('all', 'biggest_win');
      case 'best_streak':
        return statSql('blackjack', 'best_streak');
      case 'level':
        return { sql: 'SELECT user_id, xp AS value FROM players WHERE guild_id = ? AND xp > 0', params: [guildId] };
    }
  }
}

function formatValue(category: LeaderboardCategory, value: number): string {
  switch (category) {
    case 'net':
      return signedChips(value);
    case 'win_rate':
      return percent(value / 1000);
    case 'wins':
      return `${chips(value)} won`;
    case 'blackjacks':
      return `${chips(value)}`;
    case 'best_streak':
      return `${value} in a row`;
    case 'level': {
      const info = levelInfo(value);
      return `Lv ${info.level} · ${info.rank.name}`;
    }
    default:
      return chips(value);
  }
}
