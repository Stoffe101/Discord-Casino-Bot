import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { resolveSettings, type GuildSettings } from '../src/config/settings.js';
import { EconomyService } from '../src/domain/economy/economy-service.js';
import { StatsService } from '../src/domain/stats-service.js';
import { ProgressService } from '../src/domain/progress-service.js';
import { RoundRecorder } from '../src/domain/round-recorder.js';
import { BlackjackTableService } from '../src/tables/blackjack-table-service.js';
import type { RenderHint, TableObserver, TableSnapshot } from '../src/tables/types.js';

export interface Harness {
  db: Database;
  clock: ManualClock;
  scheduler: ManualScheduler;
  settings: Map<string, GuildSettings>;
  economy: EconomyService;
  stats: StatsService;
  progress: ProgressService;
  recorder: RoundRecorder;
  tables: BlackjackTableService;
  renders: { tableId: string; hint: RenderHint }[];
  closed: { snapshot: TableSnapshot; reason: string }[];
  /** Advance the clock and fire due timers, waiting for all table work to finish. */
  tick(ms: number): Promise<void>;
}

export function createHarness(options: { db?: Database; clock?: ManualClock; seed?: number; settings?: Map<string, GuildSettings> } = {}): Harness {
  const db = options.db ?? new Database(':memory:');
  db.migrate();
  const clock = options.clock ?? new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const settings = options.settings ?? new Map<string, GuildSettings>();
  const provider = (guildId: string): GuildSettings => {
    let s = settings.get(guildId);
    if (!s) {
      s = resolveSettings({ economy: { startingBalance: 1000 } });
      settings.set(guildId, s);
    }
    return s;
  };
  const economy = new EconomyService(db, provider, clock);
  const stats = new StatsService(db);
  const progress = new ProgressService(db, economy, stats, provider, clock);
  const recorder = new RoundRecorder(db, economy, stats, progress, clock);
  const tables = new BlackjackTableService({
    db,
    economy,
    recorder,
    settings: provider,
    clock,
    scheduler,
    logger: silentLogger,
    rng: seededRng(options.seed ?? 1234),
  });
  const renders: Harness['renders'] = [];
  const closed: Harness['closed'] = [];
  const observer: TableObserver = {
    tableChanged: (tableId, hint) => renders.push({ tableId, hint }),
    tableClosed: (snapshot, reason) => closed.push({ snapshot, reason }),
  };
  tables.setObserver(observer);
  return {
    db,
    clock,
    scheduler,
    settings,
    economy,
    stats,
    progress,
    recorder,
    tables,
    renders,
    closed,
    async tick(ms: number) {
      clock.advance(ms);
      scheduler.runDue();
      await tables.idle();
    },
  };
}
