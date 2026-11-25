/**
 * Economy defaults vs. per-server overrides. Defaults live in code and each server stores only
 * the keys an admin set (guild_settings.settings_json), so a new default reaches every server
 * that never touched that key while explicit choices, balances, history and committed chips are
 * left exactly as they were.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { HOUR, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { DEFAULT_SETTINGS, type GuildSettings } from '../src/config/settings.js';
import { Database } from '../src/db/database.js';
import { GuildSettingsService } from '../src/domain/guild-settings-service.js';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';
/** The defaults before the 2026-11 rebalance. */
const PREVIOUS = { passivePerHour: 20, passiveCapHours: 24 };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Run `fn` as if the build shipped different economy defaults (restored afterwards). */
async function withDefaults<T>(economy: Partial<GuildSettings['economy']>, fn: () => T | Promise<T>): Promise<T> {
  const saved = { ...DEFAULT_SETTINGS.economy };
  Object.assign(DEFAULT_SETTINGS.economy, economy);
  try {
    return await fn();
  } finally {
    Object.assign(DEFAULT_SETTINGS.economy, saved);
  }
}

function setup() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  cleanup.push(() => db.close());
  const app = (): CasinoApp => {
    const made = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock) });
    cleanup.push(() => made.shutdown());
    return made;
  };
  const stored = (guildId: string) => JSON.parse(db.get<{ settings_json: string }>('SELECT settings_json FROM guild_settings WHERE guild_id = ?', [guildId])?.settings_json ?? '{}') as Record<string, unknown>;
  return { db, clock, app, stored };
}

describe('economy defaults vs. server overrides', () => {
  it('ships a lower passive rate without shortening how long passive income is stored', () => {
    expect(DEFAULT_SETTINGS.economy.passivePerHour).toBeLessThan(PREVIOUS.passivePerHour);
    expect(DEFAULT_SETTINGS.economy.passiveCapHours).toBeGreaterThanOrEqual(PREVIOUS.passiveCapHours);
  });

  it('keeps an explicitly set rate, and only untouched keys follow a new default', async () => {
    const { db, clock, app, stored } = setup();
    const casino = app();
    casino.settings.set(A, 'economy.passivePerHour', PREVIOUS.passivePerHour); // an admin chose the old value on purpose
    casino.settings.set(B, 'economy.dailyReward', 120); // an unrelated economy change
    expect(stored(A)).toEqual({ economy: { passivePerHour: 20 } });
    expect(stored(B)).toEqual({ economy: { dailyReward: 120 } }); // the passive keys were not snapshotted
    expect(casino.settings.get(A).economy.passivePerHour).toBe(20);
    // Intended and documented: each key stands alone, so a server that set only the rate keeps
    // its rate while its cap follows the new default (20/h × 48 h can store 960, not 480).
    expect(casino.settings.get(A).economy.passiveCapHours).toBe(DEFAULT_SETTINGS.economy.passiveCapHours);
    expect(casino.settings.get(B).economy.passivePerHour).toBe(DEFAULT_SETTINGS.economy.passivePerHour);
    expect(casino.settings.get(C).economy).toEqual(DEFAULT_SETTINGS.economy);

    // Any later default change behaves the same way.
    await withDefaults({ passivePerHour: 7, passiveCapHours: 30 }, () => {
      const fresh = new GuildSettingsService(db, clock);
      expect(fresh.get(A).economy).toMatchObject({ passivePerHour: 20, passiveCapHours: 30 });
      expect(fresh.get(B).economy).toMatchObject({ passivePerHour: 7, passiveCapHours: 30, dailyReward: 120 });
    });

    // Resetting a server's settings lands on the current defaults.
    casino.settings.resetAll(A);
    expect(casino.settings.get(A).economy.passivePerHour).toBe(DEFAULT_SETTINGS.economy.passivePerHour);
  });

  it('upgrading from the previous defaults keeps balances, history and committed chips', async () => {
    const { db, clock, app } = setup();
    const ledger = () => db.all('SELECT * FROM ledger ORDER BY rowid');
    const escrows = () => db.all('SELECT * FROM escrows ORDER BY rowid');
    const player = () => db.get<{ balance: number; reserved: number; passive_anchor_at: number }>('SELECT balance, reserved, passive_anchor_at FROM players WHERE guild_id = ? AND user_id = ?', [A, 'p'])!;

    // The previous build: the server never touched the passive settings.
    await withDefaults(PREVIOUS, async () => {
      const before = app();
      before.settings.set(A, 'poker.enabled', true);
      before.economy.ensurePlayer(A, 'p', 'P');
      clock.advance(10 * HOUR);
      expect(before.economy.claimPassive(A, 'p').amount).toBe(200);
      await before.poker.create({ guildId: A, userId: 'p', name: 'P', buyIn: 100 }); // 100 chips committed to a Hold'em stack
      clock.advance(5 * HOUR);
      expect(before.economy.getWallet(A, 'p').passive.available).toBe(100); // accrued, not yet collected
      await before.shutdown();
    });
    const balances = player();
    const history = ledger();
    const held = escrows();
    expect(balances).toMatchObject({ balance: 600, reserved: 100 });

    // The new build on the same database.
    const after = app();
    after.recover();
    expect(player()).toEqual(balances);
    expect(ledger()).toEqual(history);
    expect(escrows()).toEqual(held);
    expect(after.economy.reconcile()).toEqual([]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_tables WHERE guild_id = ? AND game = 'poker' AND status = 'open'", [A])!.n).toBe(1);
    // Uncollected passive income is recomputed from the same anchor at the new rate.
    const rate = DEFAULT_SETTINGS.economy.passivePerHour;
    expect(after.economy.getWallet(A, 'p').passive.available).toBe(5 * rate);
    expect(after.economy.claimPassive(A, 'p').amount).toBe(5 * rate);
    expect(player().balance).toBe(600 + 5 * rate);
  });
});
