import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { utcDayKey, utcDayNumber } from '../core/clock.js';
import type { EconomyService, GameId, SettingsProvider } from './economy/economy-service.js';
import type { StatsService } from './stats-service.js';
import { ACHIEVEMENTS, isAchieved, type AchievementDef } from './achievements.js';
import { MISSIONS, missionById, pickMissions, type MissionDef, type MissionProgressInput } from './missions.js';
import { cappedGameXp, levelInfo, type LevelInfo } from './progression.js';

export interface XpGain {
  gained: number;
  before: LevelInfo;
  after: LevelInfo;
}

export interface MissionView {
  def: MissionDef;
  progress: number;
  target: number;
  completedAt: number | null;
}

/** Levels, achievements and daily missions. All writes happen inside the caller's transaction. */
export class ProgressService {
  constructor(
    private readonly db: Database,
    private readonly economy: EconomyService,
    private readonly stats: StatsService,
    private readonly settings: SettingsProvider,
    private readonly clock: Clock,
  ) {}

  levelOf(guildId: string, userId: string): LevelInfo {
    return levelInfo(this.economy.getPlayer(guildId, userId)?.xp ?? 0);
  }

  /** Add XP. Game XP is subject to the daily soft cap; goal XP (achievements/missions) is not. */
  addXp(guildId: string, userId: string, amount: number, source: 'game' | 'goal'): XpGain {
    const player = this.economy.requirePlayer(guildId, userId);
    const before = levelInfo(player.xp);
    let gained = Math.max(0, Math.floor(amount));
    if (source === 'game' && gained > 0) {
      const today = utcDayNumber(this.clock.now());
      const day = this.stats.get(guildId, userId, 'all', 'xp_day');
      const earned = day === today ? this.stats.get(guildId, userId, 'all', 'xp_today') : 0;
      gained = cappedGameXp(earned, gained);
      this.stats.set(guildId, userId, 'all', 'xp_day', today);
      this.stats.set(guildId, userId, 'all', 'xp_today', earned + gained);
    }
    if (gained > 0) {
      this.db.run('UPDATE players SET xp = xp + ? WHERE guild_id = ? AND user_id = ?', [gained, guildId, userId]);
    }
    return { gained, before, after: levelInfo(player.xp + gained) };
  }

  unlockedAchievements(guildId: string, userId: string): Map<string, number> {
    const rows = this.db.all<{ achievement_id: string; unlocked_at: number }>(
      'SELECT achievement_id, unlocked_at FROM player_achievements WHERE guild_id = ? AND user_id = ?',
      [guildId, userId],
    );
    return new Map(rows.map((r) => [r.achievement_id, r.unlocked_at]));
  }

  /**
   * Unlock every achievement whose condition is now met. Each unlock is recorded exactly once
   * (primary key) and its chip reward uses an idempotent ledger key.
   */
  evaluateAchievements(guildId: string, userId: string, flags: ReadonlySet<string>): AchievementDef[] {
    const unlocked: AchievementDef[] = [];
    const have = this.unlockedAchievements(guildId, userId);
    // XP rewards can level a player up, which can satisfy level-based achievements: iterate.
    for (let pass = 0; pass < 3; pass++) {
      const ctx = {
        stats: this.stats.snapshot(guildId, userId),
        flags,
        level: this.levelOf(guildId, userId).level,
      };
      let changed = false;
      for (const def of ACHIEVEMENTS) {
        if (have.has(def.id) || !isAchieved(def, ctx)) continue;
        const now = this.clock.now();
        const inserted = this.db.run(
          'INSERT OR IGNORE INTO player_achievements (guild_id, user_id, achievement_id, unlocked_at) VALUES (?, ?, ?, ?)',
          [guildId, userId, def.id, now],
        );
        have.set(def.id, now);
        if (inserted.changes !== 1) continue;
        if (def.reward.chips) {
          this.economy.credit({
            guildId,
            userId,
            amount: def.reward.chips,
            type: 'achievement_reward',
            key: `achievement:${def.id}`,
            memo: `Achievement: ${def.name}`,
          });
        }
        if (def.reward.xp) this.addXp(guildId, userId, def.reward.xp, 'goal');
        unlocked.push(def);
        changed = true;
      }
      if (!changed) break;
    }
    return unlocked;
  }

  enabledGames(guildId: string): Set<GameId> {
    const s = this.settings(guildId);
    const enabled = new Set<GameId>();
    if (s.blackjack.enabled) enabled.add('blackjack');
    if (s.roulette.enabled) enabled.add('roulette');
    if (s.slots.enabled) enabled.add('slots');
    if (s.coinflip.enabled) enabled.add('coinflip');
    return enabled;
  }

  /** Today's missions (UTC), created on first access. */
  todaysMissions(guildId: string, userId: string): MissionView[] {
    const day = utcDayKey(this.clock.now());
    let rows = this.missionRows(guildId, userId, day);
    if (rows.length === 0) {
      for (const def of pickMissions(guildId, userId, day, this.enabledGames(guildId))) {
        this.db.run(
          'INSERT OR IGNORE INTO player_missions (guild_id, user_id, day, mission_id, progress, target) VALUES (?, ?, ?, ?, 0, ?)',
          [guildId, userId, day, def.id, def.target],
        );
      }
      rows = this.missionRows(guildId, userId, day);
    }
    return rows
      .map((r) => {
        const def = missionById(r.mission_id);
        return def ? { def, progress: r.progress, target: r.target, completedAt: r.completed_at } : null;
      })
      .filter((m): m is MissionView => m !== null);
  }

  /** Advance today's missions from a recorded round; completing one pays its reward once. */
  trackMissions(guildId: string, userId: string, input: MissionProgressInput): MissionDef[] {
    const day = utcDayKey(this.clock.now());
    const completed: MissionDef[] = [];
    for (const mission of this.todaysMissions(guildId, userId)) {
      if (mission.completedAt !== null) continue;
      const delta = mission.def.track(input);
      if (delta <= 0) continue;
      const progress = Math.min(mission.target, mission.progress + delta);
      const done = progress >= mission.target;
      this.db.run(
        'UPDATE player_missions SET progress = ?, completed_at = ? WHERE guild_id = ? AND user_id = ? AND day = ? AND mission_id = ?',
        [progress, done ? this.clock.now() : null, guildId, userId, day, mission.def.id],
      );
      if (done) {
        this.economy.credit({
          guildId,
          userId,
          amount: mission.def.reward,
          type: 'mission_reward',
          key: `mission:${day}:${mission.def.id}`,
          memo: `Daily mission: ${mission.def.name}`,
        });
        this.addXp(guildId, userId, mission.def.xp, 'goal');
        completed.push(mission.def);
      }
    }
    return completed;
  }

  private missionRows(guildId: string, userId: string, day: string) {
    return this.db.all<{ mission_id: string; progress: number; target: number; completed_at: number | null }>(
      'SELECT mission_id, progress, target, completed_at FROM player_missions WHERE guild_id = ? AND user_id = ? AND day = ? ORDER BY rowid',
      [guildId, userId, day],
    );
  }
}

export { MISSIONS };
