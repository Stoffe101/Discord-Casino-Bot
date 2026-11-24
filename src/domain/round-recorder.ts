import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { utcDayNumber } from '../core/clock.js';
import { chips, signedChips } from '../core/format.js';
import { DEFAULT_SETTINGS } from '../config/settings.js';
import type { EconomyService, GameId, SettingsProvider } from './economy/economy-service.js';
import type { StatsService } from './stats-service.js';
import type { ProgressService, XpGain } from './progress-service.js';
import type { AchievementDef } from './achievements.js';
import type { MissionDef } from './missions.js';

/** One player's result in one round of any game. Games build these; the recorder applies them. */
export interface PlayerRoundOutcome {
  userId: string;
  /** Total chips committed (must equal the player's held escrow for this round). */
  wagered: number;
  /** Total chips paid back to the player, stakes included. */
  returned: number;
  /** Game-specific counters to add, e.g. { hands: 2, hands_won: 1 }. */
  stats: Record<string, number>;
  /** Game-specific maximums to raise, e.g. { biggest_hand_win: 300 }. */
  maxStats?: Record<string, number>;
  /** Notable facts for achievements and missions. */
  flags: string[];
  /** Base XP for taking part (subject to the daily soft cap). */
  xp: number;
  /** Short outcome label stored with the round ('blackjack', 'win', 'lose', 'push', 'mixed'). */
  label: string;
  detail?: unknown;
}

export interface RecordRoundInput {
  guildId: string;
  roundId: string;
  game: GameId;
  tableId?: string | null;
  /** Human label for ledger memos, e.g. "Table 02 · Round 14". */
  title: string;
  players: PlayerRoundOutcome[];
  summary?: unknown;
  /** Number of players who took part (for social missions/achievements). */
  tablePlayers?: number;
}

export interface RecordedPlayer {
  userId: string;
  net: number;
  xp: XpGain;
  achievements: AchievementDef[];
  missions: MissionDef[];
}

export interface RecordedRound {
  duplicate: boolean;
  players: RecordedPlayer[];
}

/**
 * Settles a finished round in ONE transaction: marks the round settled (exactly once via the
 * game_rounds primary key), pays every player from their escrow, and updates statistics,
 * streaks, XP, achievements and missions. If anything throws, none of it happens.
 */
export class RoundRecorder {
  constructor(
    private readonly db: Database,
    private readonly economy: EconomyService,
    private readonly stats: StatsService,
    private readonly progress: ProgressService,
    private readonly clock: Clock,
    private readonly settings: SettingsProvider = () => DEFAULT_SETTINGS,
  ) {}

  isRecorded(roundId: string): boolean {
    return this.db.get<{ one: number }>('SELECT 1 AS one FROM game_rounds WHERE id = ?', [roundId]) !== undefined;
  }

  record(input: RecordRoundInput): RecordedRound {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO game_rounds (id, guild_id, game, table_id, status, summary_json, created_at, settled_at)
         VALUES (?, ?, ?, ?, 'settled', ?, ?, ?)`,
        [input.roundId, input.guildId, input.game, input.tableId ?? null, JSON.stringify(input.summary ?? null), now, now],
      );
      if (inserted.changes !== 1) return { duplicate: true, players: [] };

      const players: RecordedPlayer[] = [];
      for (const p of input.players) {
        players.push(this.recordPlayer(input, p, now));
      }
      return { duplicate: false, players };
    });
  }

  /** Mark a round void (all stakes refunded). Exactly once, like settlement. */
  voidRound(guildId: string, roundId: string, game: GameId, tableId: string | null, reason: string): { userId: string; amount: number }[] {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO game_rounds (id, guild_id, game, table_id, status, summary_json, created_at, settled_at)
         VALUES (?, ?, ?, ?, 'void', ?, ?, ?)`,
        [roundId, guildId, game, tableId, JSON.stringify({ reason }), now, now],
      );
      if (inserted.changes !== 1) return [];
      return this.economy.refundContext(guildId, roundId, reason);
    });
  }

  private recordPlayer(input: RecordRoundInput, p: PlayerRoundOutcome, now: number): RecordedPlayer {
    const { guildId, game, roundId } = input;
    const net = p.returned - p.wagered;
    const outcome = net > 0 ? 'win' : net < 0 ? 'loss' : 'push';
    this.economy.settle({
      guildId,
      userId: p.userId,
      contextId: roundId,
      game,
      payout: p.returned,
      outcome,
      key: `round:${roundId}`,
      expectedStake: p.wagered,
      memo: `${input.title} · staked ${chips(p.wagered)}, returned ${chips(p.returned)} (${signedChips(net)})`,
    });
    this.db.run(
      `INSERT INTO round_results (round_id, guild_id, user_id, game, wagered, returned, net, outcome, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [roundId, guildId, p.userId, game, p.wagered, p.returned, net, p.label, JSON.stringify(p.detail ?? null), now],
    );

    const flags = new Set(p.flags);
    // Per-game and cross-game totals.
    for (const g of [game, 'all']) {
      this.stats.bump(guildId, p.userId, g, 'rounds', 1);
      this.stats.bump(guildId, p.userId, g, net > 0 ? 'wins' : net < 0 ? 'losses' : 'pushes', 1);
      this.stats.bump(guildId, p.userId, g, 'wagered', p.wagered);
      this.stats.bump(guildId, p.userId, g, 'returned', p.returned);
      this.stats.bump(guildId, p.userId, g, 'net', net);
      if (net > 0) this.stats.bump(guildId, p.userId, g, 'net_won', net);
      if (net < 0) this.stats.bump(guildId, p.userId, g, 'net_lost', -net);
      if (net > 0) this.stats.raise(guildId, p.userId, g, 'biggest_win', net);
    }
    for (const [name, delta] of Object.entries(p.stats)) this.stats.bump(guildId, p.userId, game, name, delta);
    for (const [name, value] of Object.entries(p.maxStats ?? {})) this.stats.raise(guildId, p.userId, game, name, value);

    // Streaks (pushes leave streaks untouched).
    if (net !== 0) {
      const lossStreak = this.stats.get(guildId, p.userId, game, 'loss_streak');
      if (net > 0) {
        const streak = this.stats.get(guildId, p.userId, game, 'current_streak') + 1;
        this.stats.set(guildId, p.userId, game, 'current_streak', streak);
        this.stats.raise(guildId, p.userId, game, 'best_streak', streak);
        this.stats.set(guildId, p.userId, game, 'loss_streak', 0);
        if (lossStreak >= 5) flags.add('comeback');
      } else {
        this.stats.set(guildId, p.userId, game, 'current_streak', 0);
        this.stats.set(guildId, p.userId, game, 'loss_streak', lossStreak + 1);
      }
    }

    // Distinct days played.
    const today = utcDayNumber(now);
    if (this.stats.get(guildId, p.userId, 'all', 'last_play_day') !== today) {
      this.stats.set(guildId, p.userId, 'all', 'last_play_day', today);
      this.stats.bump(guildId, p.userId, 'all', 'days_played', 1);
    }

    const xp = this.progress.addXp(guildId, p.userId, p.xp, 'game');
    const missions = this.progress.trackMissions(guildId, p.userId, {
      game,
      stats: p.stats,
      flags,
      tablePlayers: input.tablePlayers ?? input.players.length,
    });
    const achievements = this.progress.evaluateAchievements(guildId, p.userId, flags);
    const finalXp = { ...xp, after: this.progress.levelOf(guildId, p.userId) };

    const highlights = this.settings(guildId).highlights;
    if (highlights.enabled && !this.economy.requirePlayer(guildId, p.userId).highlights_opt_out) {
      const enoughWager = p.wagered >= highlights.minimumWager;
      const event = enoughWager && flags.has('slots_jackpot') ? 'Slots jackpot'
        : net >= highlights.majorNet ? 'Major win'
        : enoughWager && net >= highlights.bigNet ? flags.has('roulette_straight_win') ? 'Straight-up win' : 'Big win'
        : null;
      if (event && net > 0 && !this.db.get(
        "SELECT id FROM highlights WHERE guild_id = ? AND user_id = ? AND kind = 'big_win' AND created_at > ? LIMIT 1",
        [guildId, p.userId, now - highlights.cooldownSeconds * 1000],
      )) {
        this.addHighlight(guildId, p.userId, 'big_win', `**${event}** · +${chips(net)} net at ${gameLabel(game)} · round ${roundId.slice(0, 8)}`, now);
      }
      for (const achievement of achievements.filter((item) => item.secret)) {
        this.addHighlight(guildId, p.userId, 'achievement', `unlocked **${achievement.name}**`, now);
      }
    }
    return { userId: p.userId, net, xp: finalXp, achievements, missions };
  }

  private addHighlight(guildId: string, userId: string, kind: string, text: string, now: number): void {
    this.db.run('INSERT INTO highlights (guild_id, kind, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)', [
      guildId,
      kind,
      userId,
      text,
      now,
    ]);
  }
}

export function gameLabel(game: string): string {
  switch (game) {
    case 'blackjack':
      return 'blackjack';
    case 'roulette':
      return 'roulette';
    case 'slots':
      return 'the slots';
    case 'coinflip':
      return 'a coinflip';
    default:
      return game;
  }
}
