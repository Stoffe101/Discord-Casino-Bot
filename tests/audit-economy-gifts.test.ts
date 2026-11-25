/**
 * Audit: chip gifting. Transfers must be atomic and exactly-once, limited per UTC day, restricted
 * to established accounts in the same server, confirmable only by the sender, and fully audited.
 *
 * Tests wrapped in `it.fails` reproduce a CONFIRMED bug that could not be fixed inside the
 * audited files and assert the CORRECT behaviour.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { DAY, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { DEFAULT_SETTINGS, resolveSettings } from '../src/config/settings.js';
import { Database } from '../src/db/database.js';
import { EconomyService } from '../src/domain/economy/economy-service.js';
import { CasinoHarness } from './harness/casino-harness.js';
import type { FakeMessage, FakeUser } from './harness/fake-discord.js';

const G = '100000000000000001';
const OTHER = '100000000000000002';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function makeApp() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(); // 2026-01-01 12:00 UTC: far from the daily-limit midnight
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock) });
  cleanup.push(() => db.close(), () => app.shutdown());
  return { app, db, clock };
}

/** Two established (24 h old) accounts with the default 500 chips each. */
function established() {
  const made = makeApp();
  for (const id of ['alice', 'bob', 'carol']) made.app.economy.ensurePlayer(G, id, id);
  made.clock.advance(DAY);
  return made;
}

const ledger = (app: CasinoApp, type: string) =>
  app.db.all<{ user_id: string; amount: number; reference: string; memo: string }>('SELECT * FROM ledger WHERE type = ? ORDER BY rowid', [type]);

describe('EconomyService.gift', () => {
  it('rolls back the sender debit when the recipient credit fails', () => {
    const { app } = established();
    app.economy.adminAdjust({ guildId: G, userId: 'bob', actorId: 'audit', reason: 'Near the wallet limit', amount: Number.MAX_SAFE_INTEGER - 505 });
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 't1')).toThrow(/wallet limit/);
    expect(app.economy.requirePlayer(G, 'alice').balance).toBe(500);
    expect(ledger(app, 'gift_sent')).toEqual([]);
    expect(ledger(app, 'gift_received')).toEqual([]);
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('refuses gifts that exceed the available balance (committed chips are not giftable)', () => {
    const { app } = established();
    app.economy.reserve({ guildId: G, userId: 'alice', game: 'roulette', contextId: 'spin', amount: 450, key: 'bet' });
    expect(() => app.economy.gift(G, 'alice', 'bob', 100, 't1')).toThrow();
    expect(app.economy.getWallet(G, 'alice')).toMatchObject({ balance: 50, reserved: 450 });
    expect(app.economy.requirePlayer(G, 'bob').balance).toBe(500);
    expect(ledger(app, 'gift_sent')).toEqual([]);
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('writes one linked audit pair and replays the same transfer id as a no-op, even after a restart', () => {
    const { app, db, clock } = established();
    const first = app.economy.gift(G, 'alice', 'bob', 60, 'transfer-1');
    const restarted = new EconomyService(db, app.settings.provider, clock);
    const replay = restarted.gift(G, 'alice', 'bob', 60, 'transfer-1');
    expect(replay.id).toBe(first.id);
    const sent = ledger(app, 'gift_sent');
    const received = ledger(app, 'gift_received');
    expect(sent).toMatchObject([{ user_id: 'alice', amount: -60, reference: 'transfer-1' }]);
    expect(received).toMatchObject([{ user_id: 'bob', amount: 60, reference: 'transfer-1' }]);
    expect(app.economy.requirePlayer(G, 'alice').balance + app.economy.requirePlayer(G, 'bob').balance).toBe(1000);
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('enforces the cumulative daily limit and resets it at UTC midnight', () => {
    const { app, clock } = established();
    app.economy.adminAdjust({ guildId: G, userId: 'alice', actorId: 'audit', reason: 'Bankroll', amount: 2000 });
    app.economy.gift(G, 'alice', 'bob', 300, 'a');
    app.economy.gift(G, 'alice', 'carol', 200, 'b');
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 'c')).toThrow(/0 chips left/);
    expect(() => app.economy.gift(G, 'alice', 'bob', 501, 'd')).toThrow(/between 10 and 500/);
    expect(() => app.economy.gift(G, 'alice', 'bob', 9, 'e')).toThrow(/between 10 and 500/);
    clock.set(Date.UTC(2026, 0, 2, 23, 59, 59, 999));
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 'f')).toThrow(/0 chips left/);
    clock.set(Date.UTC(2026, 0, 3, 0, 0, 0, 0));
    app.economy.gift(G, 'alice', 'bob', 500, 'g');
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('requires both accounts to be at least 24 hours old, measured exactly', () => {
    const { app, clock } = makeApp();
    app.economy.ensurePlayer(G, 'alice');
    app.economy.ensurePlayer(G, 'bob');
    clock.advance(DAY - 1);
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 'early')).toThrow(/24 hours/);
    clock.advance(1);
    app.economy.gift(G, 'alice', 'bob', 10, 'on-time');
    clock.advance(1);
    app.economy.ensurePlayer(G, 'fresh');
    expect(() => app.economy.gift(G, 'alice', 'fresh', 10, 'to-new')).toThrow(/24 hours/);
    expect(() => app.economy.gift(G, 'fresh', 'alice', 10, 'from-new')).toThrow(/24 hours/);
  });

  it('rejects self-gifts, opted-out recipients, unknown players and other servers', () => {
    const { app } = established();
    app.economy.ensurePlayer(OTHER, 'dave');
    expect(() => app.economy.gift(G, 'alice', 'alice', 10, 'self')).toThrow(/another player/);
    expect(() => app.economy.gift(G, 'alice', 'dave', 10, 'foreign')).toThrow(/hasn't visited/);
    expect(() => app.economy.gift(OTHER, 'alice', 'dave', 10, 'foreign-sender')).toThrow(/hasn't visited/);
    expect(() => app.economy.gift(G, 'alice', 'never-seen-bot', 10, 'bot')).toThrow(/hasn't visited/);
    app.db.run("UPDATE players SET gifts_opt_out = 1 WHERE user_id = 'bob'");
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 'opted-out')).toThrow(/turned off/);
    expect(ledger(app, 'gift_sent')).toEqual([]);
  });

  it('is enabled by default and an explicit guild override wins', () => {
    expect(DEFAULT_SETTINGS.economy.giftingEnabled).toBe(true);
    expect(resolveSettings({}).economy.giftingEnabled).toBe(true);
    expect(resolveSettings({ economy: { dailyReward: 5 } }).economy.giftingEnabled).toBe(true);
    expect(resolveSettings({ economy: { giftingEnabled: false } }).economy.giftingEnabled).toBe(false);
    const { app } = established();
    app.settings.set(G, 'economy.giftingEnabled', false);
    expect(() => app.economy.gift(G, 'alice', 'bob', 10, 'off')).toThrow(/disabled/);
    expect(app.settings.get(OTHER).economy.giftingEnabled).toBe(true);
  });
});

describe('gift confirmation through Discord', () => {
  function harness(options: ConstructorParameters<typeof CasinoHarness>[0] = {}) {
    const h = new CasinoHarness({ clock: new ManualClock(), ...options });
    cleanup.push(() => h.close());
    return h;
  }

  /** Alice opens Wallet → Gift chips → picks Bob → enters an amount; returns the confirmation. */
  async function prepare(h: CasinoHarness, alice: FakeUser, bob: FakeUser, amount = '50') {
    const wallet = h.seen(await h.slash(alice, 'wallet'))!;
    await h.click(alice, wallet, /^nav:gifting$/);
    const modal = await h.select(alice, wallet, 'gift:pick', [bob.id]);
    await h.submit(alice, modal, { amount });
    const send = h.buttons(wallet).find((b) => b.custom_id?.startsWith('gift:send:'));
    expect(send).toBeDefined();
    return { wallet, sendId: send!.custom_id! };
  }

  async function players(h: CasinoHarness) {
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await h.slash(alice, 'casino');
    await h.slash(bob, 'casino');
    await h.advance(DAY);
    return { alice, bob };
  }

  const sentCount = (h: CasinoHarness) => h.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE type = 'gift_sent'")!.n;

  it('only the sender can confirm, and a double click transfers once', async () => {
    const h = harness();
    const { alice, bob } = await players(h);
    const { wallet, sendId } = await prepare(h, alice, bob);
    // Bob forges Alice's confirmation id from his own wallet message.
    const bobWallet: FakeMessage = h.seen(await h.slash(bob, 'wallet'))!;
    h.fd.clickRaw(bob, bobWallet, sendId);
    await h.settle();
    expect(h.text(bobWallet)).toContain('confirmation expired');
    expect(sentCount(h)).toBe(0);
    h.fd.clickRaw(alice, wallet, sendId);
    h.fd.clickRaw(alice, wallet, sendId);
    await h.settle();
    expect(sentCount(h)).toBe(1);
    h.fd.clickRaw(alice, wallet, sendId);
    await h.settle();
    expect(sentCount(h)).toBe(1);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('a confirmation expires after five minutes', async () => {
    const h = harness();
    const { alice, bob } = await players(h);
    const { wallet, sendId } = await prepare(h, alice, bob);
    h.clock.advance(5 * 60_000);
    h.fd.clickRaw(alice, wallet, sendId);
    await h.settle();
    expect(h.text(wallet)).toContain('confirmation expired');
    expect(sentCount(h)).toBe(0);
  });

  it('a confirmation from before a restart cannot be replayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'casino-audit-gifts-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'casino.db');
    const clock = new ManualClock();
    const first = new CasinoHarness({ dbPath, clock });
    const { alice, bob } = await players(first);
    const { wallet, sendId } = await prepare(first, alice, bob);
    await first.close();
    const second = harness({ dbPath, clock, discord: first.fd });
    second.fd.clickRaw(alice, wallet, sendId);
    await second.settle();
    expect(second.text(wallet)).toContain('confirmation expired');
    expect(sentCount(second)).toBe(0);
    expect(second.app.economy.reconcile()).toEqual([]);
  });
});
