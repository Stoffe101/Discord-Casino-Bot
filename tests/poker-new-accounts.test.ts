/**
 * Chip-dumping safeguard: gifts need accounts at least 24 hours old, so a brand-new account must not
 * be able to pass its starting chips to a friend by losing them at Hold'em either. Until it is 24
 * hours old, its buy-in plus its net Hold'em losses may total at most two table minimums.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { DAY, HOUR, ManualClock } from '../src/core/clock.js';
import { UserError } from '../src/core/errors.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { NEW_ACCOUNT_AGE_MS, NEW_ACCOUNT_HOLDEM_BUY_INS } from '../src/games/poker/poker-service.js';

const G = '300000000000000001';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock), rng: seededRng(3) });
  cleanup.push(() => db.close(), () => app.shutdown());
  app.settings.set(G, 'poker.enabled', true);
  app.settings.set(G, 'economy.passivePerHour', 0);
  // An established host (8 days old) and a brand-new account created now (any interaction creates it).
  app.economy.ensurePlayer(G, 'host', 'Host');
  clock.advance(8 * DAY);
  app.economy.ensurePlayer(G, 'fresh', 'Fresh');
  return { db, clock, app };
}

async function hostTable(app: CasinoApp) {
  return (await app.poker.create({ guildId: G, userId: 'host', name: 'Host', buyIn: 500 })).record.id;
}

async function rejection(promise: Promise<unknown>): Promise<UserError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(UserError);
  return error as UserError;
}

/** A past Hold'em result for `userId`, as the round recorder stores it. */
function pokerResult(db: Database, userId: string, net: number, at: number) {
  db.run(
    `INSERT INTO round_results (round_id, guild_id, user_id, game, wagered, returned, net, outcome, detail_json, created_at)
     VALUES (?, ?, ?, 'poker', ?, ?, ?, ?, NULL, ?)`,
    [randomUUID(), G, userId, Math.max(0, -net), Math.max(0, net), net, net > 0 ? 'win' : 'lose', at],
  );
}

const unchanged = (app: CasinoApp, userId: string) => {
  expect(app.economy.getWallet(G, userId)).toMatchObject({ balance: 500, reserved: 0 });
  expect(app.poker.tableOfUser(G, userId)).toBeUndefined();
  expect(app.economy.reconcile()).toEqual([]);
};

describe('new accounts at Hold’em', () => {
  it('matches the gift rule’s 24 hours and allows two table minimums', () => {
    expect(NEW_ACCOUNT_AGE_MS).toBe(DAY);
    expect(NEW_ACCOUNT_HOLDEM_BUY_INS).toBe(2);
  });

  it('caps a brand-new account’s buy-in and explains why, without moving any chips', async () => {
    const { app, clock } = setup();
    const id = await hostTable(app);
    const created = clock.now();
    const error = await rejection(app.poker.join(id, 'fresh', 'Fresh', 500));
    expect(error.code).toBe('new_account_limit');
    expect(error.message).toContain('Brand-new casino accounts can put up to 200 chips at risk at Hold’em during their first 24 hours');
    expect(error.message).toContain('your buy-in plus anything you’ve already lost at Hold’em');
    expect(error.message).toContain('Like the 24-hour rule for gifts, this stops new accounts passing their starting chips to friends.');
    expect(error.message).toContain(`You can buy in for up to 200 chips now. The limit lifts <t:${Math.floor((created + DAY) / 1000)}:R>.`);
    unchanged(app, 'fresh');
    // Within the limit they play normally.
    await app.poker.join(id, 'fresh', 'Fresh', 200);
    expect(app.economy.getWallet(G, 'fresh')).toMatchObject({ balance: 300, reserved: 200 });
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('applies when a new account opens a table too', async () => {
    const { app } = setup();
    await rejection(app.poker.create({ guildId: G, userId: 'fresh', name: 'Fresh', buyIn: 300 }));
    unchanged(app, 'fresh');
    await app.poker.create({ guildId: G, userId: 'fresh', name: 'Fresh', buyIn: 200 });
    expect(app.economy.getWallet(G, 'fresh').reserved).toBe(200);
  });

  it('leaves accounts 24 hours old alone, however much they have lost before', async () => {
    const { app, clock, db } = setup();
    const id = await hostTable(app);
    app.economy.ensurePlayer(G, 'veteran', 'Veteran');
    pokerResult(db, 'veteran', -400, clock.now());
    clock.advance(DAY - 1);
    await rejection(app.poker.join(id, 'veteran', 'Veteran', 300));
    clock.advance(1);
    await app.poker.join(id, 'veteran', 'Veteran', 500);
    expect(app.economy.getWallet(G, 'veteran')).toMatchObject({ balance: 0, reserved: 500 });
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('counts Hold’em losses, so leaving and buying in again cannot pass on more', async () => {
    const { app, clock, db } = setup();
    const id = await hostTable(app);
    const created = clock.now();
    await app.poker.join(id, 'fresh', 'Fresh', 200);
    // A real hand: the host raises and the new account folds its big blind.
    await app.poker.start(id, 'host', app.poker.peek(id)!.record.version);
    const hand = () => app.poker.peek(id)!.state.hand!;
    expect(hand().seats.find((seat) => seat.userId === 'fresh')!.seat).toBe(hand().bigBlindSeat);
    await app.poker.act(id, 'host', app.poker.peek(id)!.state.handId!, hand().seq, { type: 'raise', to: 30 });
    await app.poker.act(id, 'fresh', app.poker.peek(id)!.state.handId!, hand().seq, { type: 'fold' });
    await app.poker.leave(id, 'fresh');
    expect(app.economy.getWallet(G, 'fresh')).toMatchObject({ balance: 490, reserved: 0 });
    const error = await rejection(app.poker.join(id, 'fresh', 'Fresh', 200));
    expect(error.message).toContain('You can buy in for up to 190 chips now.');
    await app.poker.join(id, 'fresh', 'Fresh', 190);
    await app.poker.leave(id, 'fresh');
    // Once the losses leave less than a table minimum, Hold'em waits until the account is a day old.
    pokerResult(db, 'fresh', -95, clock.now());
    const blocked = await rejection(app.poker.join(id, 'fresh', 'Fresh', 100));
    expect(blocked.message).toContain(`You’ve reached it for today. You can sit down again <t:${Math.floor((created + DAY) / 1000)}:R>.`);
    expect(app.poker.tableOfUser(G, 'fresh')).toBeUndefined();
    clock.advance(DAY);
    await app.poker.join(id, 'fresh', 'Fresh', 395);
    expect(app.economy.reconcile()).toEqual([]);
    expect(app.economy.getWallet(G, 'fresh').total + app.economy.getWallet(G, 'host').total).toBe(1000);
  });

  it('winnings do not raise the limit, and other tables’ settings set their own minimum', async () => {
    const { app, clock, db } = setup();
    app.economy.ensurePlayer(G, 'lucky', 'Lucky');
    pokerResult(db, 'lucky', 300, clock.now());
    const id = await hostTable(app);
    const error = await rejection(app.poker.join(id, 'lucky', 'Lucky', 300));
    expect(error.message).toContain('up to 200 chips now');
    // A server with a higher table minimum allows proportionally more (two of its minimums).
    app.settings.set(G, 'poker.minBuyIn', 150);
    app.economy.ensurePlayer(G, 'other', 'Other');
    clock.advance(HOUR);
    const bigger = (await app.poker.create({ guildId: G, userId: 'other', name: 'Other', buyIn: 300 })).record;
    expect(bigger.config.minBuyIn).toBe(150);
    expect(app.economy.getWallet(G, 'other').reserved).toBe(300);
    expect(app.economy.reconcile()).toEqual([]);
  });
});
