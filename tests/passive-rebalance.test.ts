/**
 * Migration 7: the switch from 20 chips/hour stored up to 24 h to 8/hour stored up to 48 h keeps
 * every chip already earned. A database from before the rebalance is migrated and each player's
 * accrued income is credited at the old settings, once, with a ledger entry; accrual then
 * continues at the new settings. Servers that set both values themselves are left alone.
 */
import { afterEach, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';

const HOUR = 3_600_000;
const G = '200000000000000001';
const OWN = '200000000000000002'; // set both passive values: untouched
const RATE_ONLY = '200000000000000003'; // set only the rate (20/h): the cap still changes 24 h → 48 h

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A database as the app left it before the rebalance, with players who joined at various times. */
function beforeRebalance() {
  const db = new Database(':memory:');
  db.migrate(MIGRATIONS.filter((m) => m.id < 7));
  const clock = new ManualClock(Date.now());
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock) });
  cleanup.push(() => db.close(), () => app.shutdown());
  app.settings.set(OWN, 'economy.passivePerHour', 12);
  app.settings.set(OWN, 'economy.passiveCapHours', 10);
  app.settings.set(RATE_ONLY, 'economy.passivePerHour', 20);
  const join = (guild: string, user: string, hoursAgo: number) => {
    // A minute's margin: SQLite's clock (used by the migration) can trail Date.now() by a few ms on Windows.
    clock.set(Date.now() - hoursAgo * HOUR - 60_000);
    app.economy.ensurePlayer(guild, user, user);
  };
  join(G, 'veteran', 30); // past the old 24 h cap: 480 stored
  join(G, 'recent', 5); // 100 at 20/h
  join(G, 'fresh', 0); // nothing yet
  join(OWN, 'veteran', 30);
  join(RATE_ONLY, 'veteran', 30);
  clock.set(Date.now());
  return { db, app, clock };
}

const player = (db: Database, guild: string, user: string) =>
  db.get<{ balance: number; reserved: number; highest_balance: number; passive_anchor_at: number }>('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guild, user])!;
const credits = (db: Database) =>
  db.all<{ guild_id: string; user_id: string; amount: number; memo: string; reference: string }>("SELECT * FROM ledger WHERE type = 'passive_income' ORDER BY guild_id, user_id");

it('credits income earned at the old rate once, then accrues at 8/h', () => {
  const { db, app, clock } = beforeRebalance();
  const start = app.settings.get(G).economy.startingBalance;
  const ownBefore = player(db, OWN, 'veteran');

  const migrated = db.migrate();
  expect(migrated.applied).toEqual([7]);

  expect(player(db, G, 'veteran').balance).toBe(start + 480); // 20/h, capped at 24 h
  expect(player(db, G, 'recent').balance).toBe(start + 100);
  expect(player(db, G, 'fresh').balance).toBe(start);
  expect(player(db, RATE_ONLY, 'veteran').balance).toBe(start + 480);
  // A server with both values set keeps them: nothing changes and its accrual continues.
  expect(player(db, OWN, 'veteran')).toEqual(ownBefore);
  expect(credits(db).map((c) => [c.guild_id, c.user_id, c.amount])).toEqual([
    [G, 'recent', 100], [G, 'veteran', 480], [RATE_ONLY, 'veteran', 480],
  ]);
  for (const c of credits(db)) expect(c).toMatchObject({ reference: 'migration:7', memo: 'Passive earnings at the previous rate' });
  expect(player(db, G, 'veteran').highest_balance).toBeGreaterThanOrEqual(start + 480);
  expect(app.economy.reconcile()).toEqual([]);

  // Accrual restarted at the new settings: nothing waiting now, 8 per hour from here.
  expect(app.economy.getWallet(G, 'veteran').passive.available).toBe(0);
  clock.advance(10 * HOUR);
  expect(app.economy.getWallet(G, 'veteran').passive).toMatchObject({ available: 80, ratePerHour: 8, cap: 384 });
  expect(app.economy.getWallet(OWN, 'veteran').passive).toMatchObject({ ratePerHour: 12, cap: 120 });

  // Restarting migrates nothing again.
  expect(db.migrate().applied).toEqual([]);
  expect(credits(db)).toHaveLength(3);
});

it('a brand-new database has nobody to credit', () => {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  expect(db.migrate().applied).toContain(7);
  expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger')!.n).toBe(0);
});
