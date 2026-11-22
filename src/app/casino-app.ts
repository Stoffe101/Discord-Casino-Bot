import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Scheduler } from '../core/scheduler.js';
import { RealScheduler } from '../core/scheduler.js';
import { secureRng, type Rng } from '../core/random.js';
import { EconomyService } from '../domain/economy/economy-service.js';
import { GuildSettingsService } from '../domain/guild-settings-service.js';
import { StatsService } from '../domain/stats-service.js';
import { ProgressService } from '../domain/progress-service.js';
import { RoundRecorder } from '../domain/round-recorder.js';
import { LeaderboardService } from '../domain/leaderboard-service.js';
import { BlackjackTableService } from '../tables/blackjack-table-service.js';
import { CoinflipService } from '../games/coinflip/coinflip-service.js';
import { RouletteService } from '../games/roulette/roulette-service.js';
import { SlotsService } from '../games/slots/slots-service.js';
import { PngCache } from '../render/png.js';

export interface AppOptions {
  db: Database;
  logger: Logger;
  clock?: Clock;
  scheduler?: Scheduler;
  rng?: Rng;
}

/** Composition root: every service, wired together, with no Discord dependency. */
export class CasinoApp {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly rng: Rng;
  readonly settings: GuildSettingsService;
  readonly economy: EconomyService;
  readonly stats: StatsService;
  readonly progress: ProgressService;
  readonly recorder: RoundRecorder;
  readonly leaderboards: LeaderboardService;
  readonly blackjack: BlackjackTableService;
  readonly coinflip: CoinflipService;
  readonly roulette: RouletteService;
  readonly slots: SlotsService;
  readonly images = new PngCache(192);

  constructor(options: AppOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? new RealScheduler(this.clock);
    this.rng = options.rng ?? secureRng;
    this.settings = new GuildSettingsService(this.db, this.clock);
    const provider = this.settings.provider;
    this.economy = new EconomyService(this.db, provider, this.clock);
    this.stats = new StatsService(this.db);
    this.progress = new ProgressService(this.db, this.economy, this.stats, provider, this.clock);
    this.recorder = new RoundRecorder(this.db, this.economy, this.stats, this.progress, this.clock);
    this.leaderboards = new LeaderboardService(this.db, this.clock);
    const gameDeps = {
      db: this.db,
      economy: this.economy,
      recorder: this.recorder,
      settings: provider,
      clock: this.clock,
      scheduler: this.scheduler,
      logger: this.logger,
      rng: this.rng,
    };
    this.blackjack = new BlackjackTableService(gameDeps);
    this.coinflip = new CoinflipService(gameDeps);
    this.roulette = new RouletteService(gameDeps);
    this.slots = new SlotsService(gameDeps);
  }

  /** Restore every game after a restart. Safe to call once at startup. */
  recover(): Record<string, unknown> {
    return {
      blackjack: this.blackjack.recoverAll(),
      roulette: this.roulette.recoverAll(),
      coinflip: this.coinflip.recoverAll(),
      reconcile: this.economy.reconcile(),
    };
  }

  async shutdown(): Promise<void> {
    this.scheduler.clearAll();
    await Promise.allSettled([this.blackjack.idle(), this.roulette.idle(), this.coinflip.idle()]);
  }
}
