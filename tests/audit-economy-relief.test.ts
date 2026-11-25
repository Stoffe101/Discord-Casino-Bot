/**
 * Audit: Emerald Relief Fund eligibility and farming resistance, plus the starting balance.
 *
 * Relief is for players who cannot afford the cheapest enabled game and have nothing on the way:
 * no committed chips (tables, poker stacks, pending duels), no rewards that would get them playing
 * again, no recent relief and no recent outgoing gift.
 *
 * Every test here asserts the CORRECT behaviour and passes (problems found were fixed in
 * src/domain/economy/economy-service.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { DAY, HOUR, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { pokerActions, type PokerAction } from '../src/games/poker/engine.js';

const G = '100000000000000001';
const apps: CasinoApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.shutdown();
    app.db.close();
  }
});

function makeApp() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock), rng: seededRng(3) });
  apps.push(app);
  return { app, clock };
}

function noRewards(app: CasinoApp) {
  app.settings.set(G, 'economy.passivePerHour', 0);
  app.settings.set(G, 'economy.dailyReward', 0);
}

function setBalance(app: CasinoApp, userId: string, balance: number) {
  const player = app.economy.ensurePlayer(G, userId, userId);
  if (player.balance !== balance) {
    app.economy.adminAdjust({ guildId: G, userId, actorId: 'audit', reason: 'Audit fixture', amount: balance - player.balance });
  }
}

const status = (app: CasinoApp, userId: string) => app.economy.reliefStatus(G, userId);

describe('eligibility', () => {
  it('is available below the cheapest enabled stake (slots 5) and not at it', () => {
    const { app } = makeApp();
    noRewards(app);
    for (const balance of [0, 1, 2, 4]) {
      setBalance(app, 'p' + balance, balance);
      expect(status(app, 'p' + balance)).toMatchObject({ eligible: true, amount: 50 });
    }
    setBalance(app, 'p5', 5);
    expect(status(app, 'p5')).toMatchObject({ eligible: false, reason: 'funds' });
  });

  it('follows the enabled games: poker-only uses the minimum buy-in; nothing enabled or a closed casino means closed', () => {
    const { app } = makeApp();
    noRewards(app);
    for (const game of ['blackjack', 'roulette', 'slots', 'coinflip']) app.settings.set(G, `${game}.enabled`, false);
    setBalance(app, 'a', 99);
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'disabled' });
    app.settings.set(G, 'poker.enabled', true);
    expect(status(app, 'a')).toMatchObject({ eligible: true });
    setBalance(app, 'a', 100);
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'funds' });
    setBalance(app, 'a', 0);
    app.settings.set(G, 'enabled', false);
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'disabled' });
  });

  it('counts committed chips: a table escrow, a pending coinflip and a seated poker stack', async () => {
    const { app } = makeApp();
    noRewards(app);
    // Table bet waiting for the deal.
    setBalance(app, 'bettor', 10);
    app.economy.reserve({ guildId: G, userId: 'bettor', game: 'blackjack', contextId: 'round', amount: 10, key: 'bet' });
    expect(status(app, 'bettor')).toMatchObject({ reason: 'funds' });
    // Pending coinflip challenge.
    setBalance(app, 'flipper', 10);
    setBalance(app, 'other', 10);
    await app.coinflip.create({ guildId: G, challengerId: 'flipper', opponentId: 'other', amount: 10, call: 'heads' });
    expect(app.economy.requirePlayer(G, 'flipper').balance).toBe(0);
    expect(status(app, 'flipper')).toMatchObject({ reason: 'funds' });
    // Entire wallet sitting at a poker table.
    app.settings.set(G, 'poker.enabled', true);
    setBalance(app, 'shark', 100);
    await app.poker.create({ guildId: G, userId: 'shark', name: 'Shark', buyIn: 100 });
    expect(app.economy.getWallet(G, 'shark')).toMatchObject({ balance: 0, reserved: 100 });
    expect(status(app, 'shark')).toMatchObject({ reason: 'funds' });
  });

  it('asks for rewards first when they would get the player playing again (daily 100, full passive)', () => {
    const { app, clock } = makeApp();
    setBalance(app, 'a', 0);
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'rewards' }); // daily reward ready
    app.economy.claimDaily(G, 'a');
    setBalance(app, 'a', 0);
    expect(status(app, 'a')).toMatchObject({ eligible: true });
    clock.advance(HOUR); // 20 passive chips
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'rewards' });
  });

  it('does not let a tiny claimable reward that cannot reach any stake block relief', () => {
    const { app, clock } = makeApp();
    setBalance(app, 'a', 0);
    app.economy.claimDaily(G, 'a');
    setBalance(app, 'a', 0);
    expect(status(app, 'a')).toMatchObject({ eligible: true });
    // The wallet showed a claim button; 7.5 minutes later (8/h) one passive chip has accrued.
    clock.advance(HOUR / 8);
    expect(app.economy.getWallet(G, 'a').passive.available).toBe(1);
    // 0 + 1 chip still cannot afford the cheapest game (5), so relief must not be refused.
    expect(status(app, 'a')).toMatchObject({ eligible: true });
    app.economy.claimRelief(G, 'a', false);
    expect(app.economy.requirePlayer(G, 'a').balance).toBe(50);
    // Relief cannot be repeated by collecting the chip afterwards.
    app.economy.claimPassive(G, 'a');
    setBalance(app, 'a', 0);
    expect(status(app, 'a')).toMatchObject({ eligible: false, reason: 'cooldown' });
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('grants exactly once under repeated claims, honours the cooldown, and a plain claim sets no title', () => {
    const { app, clock } = makeApp();
    noRewards(app);
    setBalance(app, 'a', 0);
    app.economy.claimRelief(G, 'a', false);
    expect(() => app.economy.claimRelief(G, 'a', false)).toThrow();
    expect(app.economy.requirePlayer(G, 'a')).toMatchObject({ balance: 50, relief_title_until: null });
    setBalance(app, 'a', 0);
    expect(() => app.economy.claimRelief(G, 'a', false)).toThrow(/recently received relief/);
    clock.advance(DAY - 1);
    expect(status(app, 'a')).toMatchObject({ reason: 'cooldown' });
    clock.advance(1);
    expect(status(app, 'a')).toMatchObject({ eligible: true });
    app.economy.claimRelief(G, 'a', true);
    expect(app.economy.requirePlayer(G, 'a').relief_title_until).toBe(clock.now() + HOUR / 2);
    expect(app.economy.ledgerPage(G, 'a', 20).filter((row) => row.type === 'emergency_relief')).toHaveLength(2);
  });
});

describe('gifts and farming', () => {
  it('blocks relief for 24 hours after giving chips away', () => {
    const { app, clock } = makeApp();
    noRewards(app);
    setBalance(app, 'alt', 0);
    setBalance(app, 'main', 0);
    clock.advance(DAY);
    setBalance(app, 'alt', 60);
    app.economy.gift(G, 'alt', 'main', 60, 'dump');
    expect(status(app, 'alt')).toMatchObject({ eligible: false, reason: 'recent_gift', nextAt: clock.now() + DAY });
    clock.advance(DAY - 1);
    expect(status(app, 'alt')).toMatchObject({ reason: 'recent_gift' });
    clock.advance(1);
    expect(status(app, 'alt')).toMatchObject({ eligible: true });
  });

  it('caps the relief → gift cycle at one grant per alt per day (with passive and daily switched off)', () => {
    const { app, clock } = makeApp();
    noRewards(app);
    setBalance(app, 'alt', 0);
    setBalance(app, 'main', 0);
    clock.advance(DAY);
    const start = clock.now();
    let claims = 0;
    // Try every hour for a week: claim when allowed, then gift the relief straight to the main.
    for (let hour = 0; hour < 7 * 24; hour++) {
      if (status(app, 'alt').eligible) {
        app.economy.claimRelief(G, 'alt', false);
        app.economy.gift(G, 'alt', 'main', 50, 'cycle-' + hour);
        claims++;
      }
      clock.advance(HOUR);
    }
    const days = (clock.now() - start) / DAY;
    expect(claims).toBeLessThanOrEqual(Math.ceil(days));
    expect(app.economy.requirePlayer(G, 'main').balance).toBe(claims * 50);
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('with default rewards on, an idle alt never becomes relief-eligible without giving chips away', () => {
    const { app, clock } = makeApp();
    setBalance(app, 'alt', 0);
    app.economy.claimDaily(G, 'alt');
    setBalance(app, 'alt', 0);
    app.economy.claimRelief(G, 'alt', false);
    setBalance(app, 'alt', 0); // the relief chips are lost (not gifted)
    clock.advance(DAY + 1);
    expect(status(app, 'alt')).toMatchObject({ eligible: false, reason: 'rewards' });
    app.economy.claimPassive(G, 'alt');
    app.economy.claimDaily(G, 'alt');
    expect(status(app, 'alt')).toMatchObject({ eligible: false, reason: 'funds' });
  });

  // Control for any future anti-dumping rule. Design note from this audit (not asserted): Hold’em
  // moves chips between players without the gift safeguards (24 h account age, daily limit,
  // relief block). Running this same hand with a seconds-old account moved 499 of its 500 starting
  // chips to the other player and left it relief-eligible at once. A fix must not deny relief to an
  // honest player who simply busts, which this test pins down.
  it('keeps relief open for an established player who busts at Hold’em', async () => {
    const { app, clock } = makeApp();
    noRewards(app);
    app.settings.set(G, 'poker.enabled', true);
    app.economy.ensurePlayer(G, 'main', 'main');
    app.economy.ensurePlayer(G, 'loser', 'loser');
    clock.advance(DAY);
    const table = await app.poker.create({ guildId: G, userId: 'main', name: 'Main', buyIn: 500 });
    const id = table.record.id;
    await app.poker.join(id, 'loser', 'Loser', 500);
    await app.poker.start(id, 'main', app.poker.peek(id)!.record.version);
    while (app.poker.peek(id)!.state.hand) {
      const { state } = app.poker.peek(id)!;
      const hand = state.hand!;
      const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
      const legal = pokerActions(hand, user)!;
      // The loser raises nearly everything, the main shoves over it, the loser folds.
      const raised = hand.currentBet > 100;
      const action: PokerAction = user === 'loser'
        ? (raised ? { type: 'fold' } : { type: 'raise', to: legal.maxTo - 1 })
        : raised ? { type: 'all-in' } : legal.call !== null ? { type: 'call' } : { type: 'check' };
      await app.poker.act(id, user, state.handId!, hand.seq, action);
    }
    await app.poker.leave(id, 'loser');
    expect(app.economy.requirePlayer(G, 'loser').balance).toBe(1);
    expect(app.economy.getWallet(G, 'main').total).toBe(999);
    expect(status(app, 'loser')).toMatchObject({ eligible: true });
    expect(app.economy.reconcile()).toEqual([]);
  });
});

describe('starting balance', () => {
  it('grants 500 once to new players and never resets existing balances', () => {
    const { app } = makeApp();
    const first = app.economy.ensurePlayer(G, 'new');
    expect(first.balance).toBe(500);
    expect(app.economy.ledgerPage(G, 'new', 5).map((row) => row.type)).toEqual(['initial_grant']);
    setBalance(app, 'new', 37);
    app.settings.set(G, 'economy.startingBalance', 1000);
    expect(app.economy.ensurePlayer(G, 'new').balance).toBe(37);
    app.settings.resetAll(G);
    expect(app.economy.ensurePlayer(G, 'new').balance).toBe(37);
    expect(app.economy.ensurePlayer(G, 'second').balance).toBe(500);
    expect(app.economy.ledgerPage(G, 'new', 5).filter((row) => row.type === 'initial_grant')).toHaveLength(1);
  });
});
