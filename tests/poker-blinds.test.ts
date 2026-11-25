/**
 * Cash-game blind rules: the dead-button rule (the big blind moves one player per hand, the small
 * blind and button follow and can be dead) and the missed-blind rule (players entering a game in
 * progress post a big blind, plus a dead small blind if they skipped one, or wait for the big blind).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { DAY, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import {
  dealPoker, nextDealer, playPoker, pokerActions, seatBetween,
  type PokerAction, type PokerHand,
} from '../src/games/poker/engine.js';
import { pendingBlinds } from '../src/games/poker/poker-service.js';

const stacks = (...amounts: number[]) => amounts.map((stack, seat) => ({ seat, stack, userId: String(seat) }));
const act = (hand: PokerHand, action: PokerAction): PokerHand => playPoker(hand, String(hand.actor), hand.seq, action);
const potTotal = (hand: PokerHand) => hand.result!.pots.reduce((sum, pot) => sum + pot.amount, 0);

describe('dead-button positions (engine)', () => {
  it('a departed big blind leaves a dead small blind; the button goes to last hand’s small blind', () => {
    const four = stacks(100, 100, 100, 100);
    const first = dealPoker(four, 0, 5, 10, seededRng(1)); // button 0, SB 1, BB 2
    const remaining = four.filter((seat) => seat.seat !== 2);
    const positions = nextDealer(remaining, first.dealer, first.bigBlindSeat, first.smallBlindSeat);
    expect(positions).toEqual({ button: 1, smallBlind: null, bigBlind: 3 });
    const hand = dealPoker(remaining, positions, 5, 10, seededRng(2));
    expect(hand.seats.map((seat) => seat.committed)).toEqual([0, 0, 10]);
    expect(hand.actor).toBe(0); // first to act is left of the big blind
    let next = act(act(hand, { type: 'call' }), { type: 'call' }); // seat 0, seat 1
    next = act(next, { type: 'check' }); // big blind
    expect(next.street).toBe('flop');
    expect(next.actor).toBe(3); // after the flop: first live seat left of the button (seat 1)
  });

  it('a departed small blind leaves a dead button, so nobody keeps the button twice', () => {
    const four = stacks(100, 100, 100, 100);
    const first = dealPoker(four, 0, 5, 10, seededRng(1)); // button 0, SB 1, BB 2
    const remaining = four.filter((seat) => seat.seat !== 1);
    const positions = nextDealer(remaining, first.dealer, first.bigBlindSeat, first.smallBlindSeat);
    expect(positions).toEqual({ button: 1, smallBlind: 2, bigBlind: 3 });
    const hand = dealPoker(remaining, positions, 5, 10, seededRng(3));
    expect(hand.dealer).toBe(1);
    expect(hand.seats.map((seat) => [seat.seat, seat.committed])).toEqual([[0, 0], [2, 5], [3, 10]]);
  });

  it('a dead small blind is followed by a dead button on the same empty seat', () => {
    const four = stacks(100, 100, 100, 100);
    const first = dealPoker(four, 0, 5, 10, seededRng(1));
    const three = four.filter((seat) => seat.seat !== 2);
    const second = nextDealer(three, first.dealer, first.bigBlindSeat, first.smallBlindSeat); // SB dead on seat 2
    const third = nextDealer(three, second.button, second.bigBlind, second.smallBlind ?? first.bigBlindSeat);
    expect(third).toEqual({ button: 2, smallBlind: 3, bigBlind: 0 });
    const fourth = nextDealer(three, third.button, third.bigBlind, third.smallBlind);
    expect(fourth).toEqual({ button: 3, smallBlind: 0, bigBlind: 1 });
  });

  it('heads-up to three-handed: the big blind keeps moving and a new player can take the button', () => {
    // Heads-up: seat 1 is the button and small blind, seat 0 the big blind. A player sits down in seat 2,
    // which the big blind reaches only after seat 1: the newcomer ends up on the button.
    const three = stacks(100, 100, 100);
    expect(nextDealer(three, 1, 0, 1)).toEqual({ button: 2, smallBlind: 0, bigBlind: 1 });
    // Heads-up the other way round (seat 0 button, seat 1 big blind): the big blind reaches seat 2 first.
    expect(nextDealer(three, 0, 1, 0)).toEqual({ button: 0, smallBlind: 1, bigBlind: 2 });
  });

  it('three-handed to heads-up: the button posts the small blind and nobody repeats the big blind', () => {
    for (const leaving of [0, 1, 2]) {
      const three = stacks(100, 100, 100);
      const first = dealPoker(three, 0, 5, 10, seededRng(leaving)); // button 0, SB 1, BB 2
      const two = three.filter((seat) => seat.seat !== leaving);
      const positions = nextDealer(two, first.dealer, first.bigBlindSeat, first.smallBlindSeat);
      expect(positions.smallBlind).toBe(positions.button);
      expect(positions.bigBlind).not.toBe(first.bigBlindSeat);
      expect(positions.bigBlind).toBe(two.find((seat) => seat.seat > first.bigBlindSeat)?.seat ?? two[0]!.seat);
    }
  });

  it('dead blinds always play in the main pot and are never returned', () => {
    // Seat 0 enters the game owing both blinds: 10 live (a bet) and 5 dead.
    let hand = dealPoker(stacks(100, 100, 30), { button: 0, smallBlind: 1, bigBlind: 2 }, 5, 10, seededRng(4), [{ seat: 0, live: 10, dead: 5 }]);
    expect(hand.seats.map((seat) => [seat.committed, seat.streetPaid, seat.dead])).toEqual([[15, 10, 5], [5, 5, 0], [10, 10, 0]]);
    expect(pokerActions(hand, '0')).toMatchObject({ check: true }); // the live post counts toward the call
    for (let i = 0; i < 3; i++) hand = act(hand, { type: 'all-in' });
    expect(hand.result!.refunds).toEqual([{ seat: 1, amount: 5 }]);
    expect(hand.result!.pots.map(({ amount, eligible }) => ({ amount, eligible }))).toEqual([
      { amount: 95, eligible: [0, 1, 2] }, // 3 × 30 + the dead 5
      { amount: 130, eligible: [0, 1] },
    ]);
    expect(hand.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(230);
  });

  it('the big blind wins the dead money when everyone folds to it', () => {
    let hand = dealPoker(stacks(100, 100, 100, 100), { button: 0, smallBlind: null, bigBlind: 2 }, 5, 10, seededRng(4), [{ seat: 3, live: 10, dead: 5 }]);
    expect(hand.actor).toBe(3);
    hand = act(hand, { type: 'fold' }); // the poster folds: 15 stay in the pot
    hand = act(hand, { type: 'fold' }); // seat 0
    hand = act(hand, { type: 'fold' }); // seat 1
    expect(hand.result).toMatchObject({ showdown: false, payouts: [{ seat: 2, amount: 25 }], refunds: [] });
    expect(hand.seats.map((seat) => seat.stack)).toEqual([100, 100, 115, 85]);
  });

  it('with a dead small blind, folding round to the big blind returns it and the pot is empty', () => {
    let hand = dealPoker(stacks(100, 100, 100, 100), { button: 1, smallBlind: null, bigBlind: 3 }, 5, 10, seededRng(6));
    for (let i = 0; i < 3; i++) hand = act(hand, { type: 'fold' });
    expect(hand.result).toEqual({ showdown: false, pots: [], payouts: [], refunds: [{ seat: 3, amount: 10 }] });
    expect(hand.seats.map((seat) => seat.stack)).toEqual([100, 100, 100, 100]);
  });

  it('rejects impossible positions and posts', () => {
    const three = stacks(100, 100, 100);
    expect(() => dealPoker(three, { button: 0, smallBlind: 1, bigBlind: 1 }, 5, 10)).toThrow(RangeError);
    expect(() => dealPoker(three, { button: 0, smallBlind: 1, bigBlind: 5 }, 5, 10)).toThrow(RangeError);
    expect(() => dealPoker(stacks(100, 100), { button: 0, smallBlind: null, bigBlind: 1 }, 5, 10)).toThrow(RangeError);
    expect(() => dealPoker(three, { button: 0, smallBlind: 1, bigBlind: 2 }, 5, 10, undefined, [{ seat: 2, live: 10, dead: 0 }])).toThrow(RangeError);
    expect(() => dealPoker(stacks(100, 100, 15), { button: 0, smallBlind: 0, bigBlind: 1 }, 5, 10, undefined, [{ seat: 2, live: 10, dead: 5 }])).toThrow(RangeError);
    expect(() => dealPoker(three, { button: 0, smallBlind: 1, bigBlind: 2 }, 5, 10, undefined, [{ seat: 0, live: 20, dead: 0 }])).toThrow(RangeError);
  });

  it('over many hands with players coming and going, the big blind never skips or repeats a seat', () => {
    const rng = seededRng(77);
    let seats = stacks(100, 100, 100);
    let hand = dealPoker(seats, 0, 5, 10, rng);
    let lastSmall: number = hand.smallBlindSeat!;
    for (let n = 0; n < 600; n++) {
      // Between hands, someone leaves or a seat fills (two to seven players).
      const roll = rng.int(3);
      if (roll === 0 && seats.length > 2) {
        const out = rng.int(seats.length);
        seats = seats.filter((_, i) => i !== out);
      }
      if (roll === 1 && seats.length < 7) {
        const free = [0, 1, 2, 3, 4, 5, 6].filter((index) => !seats.some((seat) => seat.seat === index));
        const seat = free[rng.int(free.length)]!;
        seats = [...seats, { seat, stack: 50 + rng.int(100), userId: 'p' + n }];
      }
      const previous = hand;
      const positions = nextDealer(seats, previous.dealer, previous.bigBlindSeat, lastSmall);
      const sorted = seats.map((seat) => seat.seat).sort((a, b) => a - b);
      const expectedBig = sorted.find((seat) => seat > previous.bigBlindSeat) ?? sorted[0]!;
      expect(positions.bigBlind).toBe(expectedBig);
      expect(positions.bigBlind).not.toBe(previous.bigBlindSeat);
      if (seats.length === 2) {
        expect(positions.smallBlind).toBe(positions.button);
      } else {
        expect(positions.smallBlind).toBe(sorted.includes(previous.bigBlindSeat) ? previous.bigBlindSeat : null);
        // Clockwise: button, small-blind seat, big blind, with nobody between the small blind and big blind.
        expect(seatBetween(positions.button, previous.bigBlindSeat, positions.bigBlind)).toBe(true);
        expect(sorted.some((seat) => seatBetween(previous.bigBlindSeat, seat, positions.bigBlind))).toBe(false);
      }
      const total = seats.reduce((sum, seat) => sum + seat.stack, 0);
      hand = dealPoker(seats, positions, 5, 10, rng);
      for (let turn = 0; hand.street !== 'complete' && turn < 200; turn++) {
        const legal = pokerActions(hand, String(hand.seats.find((seat) => seat.seat === hand.actor)!.userId))!;
        const options: PokerAction[] = [{ type: 'fold' }, legal.check ? { type: 'check' } : { type: 'call' }];
        if (legal.allIn) options.push({ type: 'all-in' });
        hand = playPoker(hand, hand.seats.find((seat) => seat.seat === hand.actor)!.userId, hand.seq, options[rng.int(options.length)]!);
      }
      expect(hand.street).toBe('complete');
      expect(potTotal(hand)).toBe(hand.seats.reduce((sum, seat) => sum + seat.committed, 0));
      expect(hand.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(total);
      lastSmall = hand.smallBlindSeat ?? previous.bigBlindSeat;
      seats = hand.seats.filter((seat) => seat.stack > 0).map(({ seat, stack, userId }) => ({ seat, stack, userId }));
      while (seats.length < 2) seats.push({ seat: [0, 1, 2, 3, 4, 5, 6].find((index) => !seats.some((s) => s.seat === index))!, stack: 100, userId: 'r' + n + seats.length });
    }
  });
});

// ─────────────────────────────── table service ───────────────────────────────

const G = '200000000000000001';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const boot = (seed: number) => {
    const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock), rng: seededRng(seed) });
    cleanup.push(() => app.shutdown());
    return app;
  };
  cleanup.push(() => db.close()); // runs last
  let app = boot(1);
  app.settings.set(G, 'poker.enabled', true);
  app.settings.set(G, 'economy.passivePerHour', 0);
  return {
    db, clock,
    get app() { return app; },
    async restart(seed = 2) {
      const before = structuredClone(app.poker.openTables().map((table) => table.state));
      await app.shutdown();
      app = boot(seed);
      expect(app.recover().poker).toMatchObject({ refunded: 0 });
      expect(app.poker.openTables().map((table) => table.state)).toEqual(before);
    },
  };
}

type Setup = ReturnType<typeof setup>;

/** Seats users in order (seat 0, 1, 2, ...) at one table with 100 chips each. */
async function table(t: Setup, users: string[]) {
  for (const user of users) t.app.economy.ensurePlayer(G, user, user);
  t.clock.advance(DAY); // established accounts (the new-account limit has its own tests)
  const id = (await t.app.poker.create({ guildId: G, userId: users[0]!, name: users[0]!, buyIn: 100 })).record.id;
  for (const user of users.slice(1)) await t.app.poker.join(id, user, user, 100);
  const peek = () => t.app.poker.peek(id)!;
  const hand = () => peek().state.hand!;
  const seatOf = (user: string) => peek().state.seats.find((seat) => seat.userId === user)!;
  const inHand = (user: string) => peek().state.hand?.seats.find((seat) => seat.userId === user);
  const userAt = (seat: number | null) => peek().state.seats.find((player) => player.seat === seat)?.userId ?? null;
  const deal = async () => {
    await t.app.poker.start(id, peek().record.ownerId, peek().record.version);
    // Blinds can put every player all-in, in which case the hand has already settled.
    const current = peek().state.hand ?? peek().state.result!;
    return { button: current.dealer, small: userAt(current.smallBlindSeat), big: userAt(current.bigBlindSeat), players: current.seats.map((seat) => seat.userId) };
  };
  /** Everyone checks when they can and folds otherwise. */
  const playOut = async () => {
    while (peek().state.hand) {
      const current = hand();
      const user = current.seats.find((seat) => seat.seat === current.actor)!.userId;
      await t.app.poker.act(id, user, peek().state.handId!, current.seq, { type: pokerActions(current, user)!.check ? 'check' : 'fold' });
    }
  };
  const conserved = (everyone: string[]) => {
    expect(t.app.economy.reconcile()).toEqual([]);
    // Achievement and mission rewards are the only chips that enter during play.
    const rewards = t.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward', 'mission_reward')")!.n;
    expect(everyone.reduce((sum, user) => sum + t.app.economy.getWallet(G, user).total, 0) - rewards).toBe(500 * everyone.length);
  };
  return { id, peek, hand, seatOf, inHand, deal, playOut, conserved };
}

describe('missed blinds and entering a game (table service)', () => {
  it('sitting out past the big blind owes both blinds; sitting back in posts them on the next hand', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c']);
    expect(await p.deal()).toMatchObject({ button: 0, small: 'b', big: 'c' });
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'a', true); // 'a' is due the big blind next
    expect(await p.deal()).toMatchObject({ small: 'c', big: 'b', players: ['b', 'c'] }); // heads-up: the button posts the small blind
    expect(p.seatOf('a')).toMatchObject({ owesBigBlind: true, owesSmallBlind: true });
    expect(pendingBlinds(p.peek(), 'a')).toEqual({ live: 10, dead: 5, waiting: false });
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'a', false);
    expect(await p.deal()).toMatchObject({ button: 0, small: 'b', big: 'c', players: ['a', 'b', 'c'] });
    // 10 live (counts toward the call) and 5 dead (straight into the pot).
    expect(p.inHand('a')).toMatchObject({ committed: 15, streetPaid: 10, dead: 5 });
    expect(p.seatOf('a')).toMatchObject({ owesBigBlind: false, owesSmallBlind: false });
    expect(pendingBlinds(p.peek(), 'a')).toBeNull();
    await p.playOut();
    // The big blind reaches 'a' next, as for everyone else.
    expect(await p.deal()).toMatchObject({ big: 'a', small: 'c', button: 1 });
    await p.playOut();
    p.conserved(['a', 'b', 'c']);
  });

  it('a returning player can wait for the big blind instead and then owes nothing', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c']);
    await p.deal();
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'a', true);
    await p.deal();
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'a', false);
    await t.app.poker.waitForBigBlind(p.id, 'a', true);
    expect(pendingBlinds(p.peek(), 'a')).toEqual({ live: 10, dead: 5, waiting: true });
    expect(await p.deal()).toMatchObject({ big: 'c', small: 'b', button: 1, players: ['b', 'c'] });
    await p.playOut();
    expect(await p.deal()).toMatchObject({ big: 'a', small: 'c', button: 1, players: ['a', 'b', 'c'] });
    expect(p.inHand('a')).toMatchObject({ committed: 10, dead: 0 });
    expect(p.seatOf('a')).toMatchObject({ owesBigBlind: false, owesSmallBlind: false, waitForBigBlind: false });
    await p.playOut();
    p.conserved(['a', 'b', 'c']);
  });

  it('sitting out the hand where your small blind was due owes a dead small blind', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c', 'd']);
    expect(await p.deal()).toMatchObject({ button: 0, small: 'b', big: 'c' });
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'c', true);
    expect(await p.deal()).toMatchObject({ button: 1, small: null, big: 'd' }); // dead small blind
    expect(p.seatOf('c')).toMatchObject({ owesBigBlind: false, owesSmallBlind: true });
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'c', false);
    expect(await p.deal()).toMatchObject({ button: 2, small: 'd', big: 'a' });
    expect(p.inHand('c')).toMatchObject({ committed: 5, streetPaid: 0, dead: 5 });
    await p.playOut();
    p.conserved(['a', 'b', 'c', 'd']);
  });

  it('a new player at a running table posts a big blind to play at once, or waits for it', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c', 'd']);
    t.app.economy.ensurePlayer(G, 'e', 'e');
    t.app.economy.ensurePlayer(G, 'f', 'f');
    t.clock.advance(DAY);
    await p.deal(); // button 0, SB 1, BB 2
    await p.playOut();
    await t.app.poker.leave(p.id, 'a');
    await t.app.poker.join(p.id, 'e', 'e', 100); // takes seat 0, under the gun next hand
    expect(p.seatOf('e')).toMatchObject({ seat: 0, owesBigBlind: true, owesSmallBlind: false });
    expect(await p.deal()).toMatchObject({ button: 1, small: 'c', big: 'd', players: ['e', 'b', 'c', 'd'] });
    expect(p.inHand('e')).toMatchObject({ committed: 10, streetPaid: 10, dead: 0 });
    expect(pokerActions(p.hand(), 'e')).toMatchObject({ check: true }); // a live post keeps its option
    await p.playOut();
    // A second newcomer chooses to wait: dealt in only when the big blind reaches seat 0's neighbour.
    await t.app.poker.leave(p.id, 'b');
    await t.app.poker.join(p.id, 'f', 'f', 100); // seat 1
    await t.app.poker.waitForBigBlind(p.id, 'f', true);
    expect(await p.deal()).toMatchObject({ big: 'e', players: ['e', 'c', 'd'] });
    await p.playOut();
    expect(await p.deal()).toMatchObject({ big: 'f', small: 'e', players: ['e', 'f', 'c', 'd'] });
    expect(p.inHand('f')).toMatchObject({ committed: 10, dead: 0 });
    await p.playOut();
    p.conserved(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('when the big blind leaves, the small blind and then the button are dead for one hand each', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c', 'd']);
    expect(await p.deal()).toMatchObject({ button: 0, small: 'b', big: 'c' });
    await p.playOut();
    await t.app.poker.leave(p.id, 'c');
    expect(await p.deal()).toMatchObject({ button: 1, small: null, big: 'd' });
    expect(p.hand().seats.reduce((sum, seat) => sum + seat.committed, 0)).toBe(10);
    await p.playOut();
    expect(await p.deal()).toMatchObject({ button: 2, small: 'd', big: 'a' }); // dead button on the empty seat
    await p.playOut();
    expect(await p.deal()).toMatchObject({ button: 3, small: 'a', big: 'b' });
    await p.playOut();
    p.conserved(['a', 'b', 'c', 'd']);
  });

  it('heads-up transitions both ways never skip the big blind or give it to the same player twice', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c']);
    t.app.economy.ensurePlayer(G, 'd', 'd');
    t.clock.advance(DAY);
    const bigs: string[] = [];
    const play = async () => {
      const dealt = await p.deal();
      bigs.push(dealt.big!);
      await p.playOut();
      return dealt;
    };
    expect(await play()).toMatchObject({ small: 'b', big: 'c' });
    await t.app.poker.leave(p.id, 'a'); // three-handed to heads-up
    expect(await play()).toMatchObject({ button: 2, small: 'c', big: 'b' });
    expect(await play()).toMatchObject({ button: 1, small: 'b', big: 'c' });
    await t.app.poker.join(p.id, 'd', 'd', 100); // heads-up to three-handed: 'd' takes seat 0
    expect(await play()).toMatchObject({ button: 1, small: 'c', big: 'd', players: ['d', 'b', 'c'] }); // the big blind reaches 'd'
    expect(await play()).toMatchObject({ button: 2, small: 'd', big: 'b' });
    await t.app.poker.leave(p.id, 'c');
    expect(await play()).toMatchObject({ small: 'b', big: 'd' });
    for (let i = 1; i < bigs.length; i++) expect(bigs[i]).not.toBe(bigs[i - 1]);
    p.conserved(['a', 'b', 'c', 'd']);
  });

  it('with fewer than two players already in the game, newcomers are dealt in without posting', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c']);
    t.app.economy.ensurePlayer(G, 'd', 'd');
    t.clock.advance(DAY);
    await p.deal();
    await p.playOut();
    await t.app.poker.leave(p.id, 'b');
    await t.app.poker.leave(p.id, 'c');
    await t.app.poker.join(p.id, 'd', 'd', 100);
    expect(p.seatOf('d').owesBigBlind).toBe(true);
    // Even choosing to wait cannot stall the table: Deal works whenever two players are ready.
    await t.app.poker.waitForBigBlind(p.id, 'd', true);
    const dealt = await p.deal();
    expect(dealt.players).toEqual(['a', 'd']);
    expect(p.hand().seats.map((seat) => seat.committed).sort((x, y) => x - y)).toEqual([5, 10]);
    expect(p.seatOf('d').owesBigBlind).toBe(false);
    await p.playOut();
    p.conserved(['a', 'b', 'c', 'd']);
  });
});

describe('restarts keep the blind state', () => {
  it('restores owed blinds between hands and a hand with dead money in progress', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c', 'd']);
    await p.deal(); // button 0, SB 1, BB 2
    await p.playOut();
    await t.app.poker.sitOut(p.id, 'a', true);
    await p.deal(); // BB 3
    await p.playOut();
    await p.deal(); // BB passes 'a' (sitting out) to 'b'
    await p.playOut();
    expect(p.seatOf('a')).toMatchObject({ owesBigBlind: true, owesSmallBlind: true });
    await t.restart(3);
    expect(p.seatOf('a')).toMatchObject({ owesBigBlind: true, owesSmallBlind: true, sittingOut: true });
    expect(p.peek().state).toMatchObject({ lastBigBlind: 1, lastSmallBlind: 3 });
    await t.app.poker.sitOut(p.id, 'a', false);
    await p.deal();
    expect(p.inHand('a')).toMatchObject({ committed: 15, dead: 5 });
    // Mid-hand restart: the dead blind, positions and owed state all survive.
    await t.app.poker.act(p.id, p.hand().seats.find((seat) => seat.seat === p.hand().actor)!.userId, p.peek().state.handId!, p.hand().seq, { type: 'call' });
    await t.restart(4);
    expect(p.inHand('a')).toMatchObject({ committed: 15, dead: 5 });
    await p.playOut();
    p.conserved(['a', 'b', 'c', 'd']);
  });

  it('a table saved before the blind rules existed is restored with nothing owed', async () => {
    const t = setup();
    const p = await table(t, ['a', 'b', 'c']);
    await p.deal();
    await p.playOut();
    const row = t.db.get<{ state_json: string }>('SELECT state_json FROM game_tables WHERE id = ?', [p.id])!;
    const legacy = JSON.parse(row.state_json) as Record<string, unknown> & { seats: Record<string, unknown>[] };
    delete legacy.lastSmallBlind;
    for (const seat of legacy.seats) {
      delete seat.owesBigBlind;
      delete seat.owesSmallBlind;
      delete seat.waitForBigBlind;
    }
    t.db.run('UPDATE game_tables SET state_json = ? WHERE id = ?', [JSON.stringify(legacy), p.id]);
    await t.app.shutdown();
    const app = new CasinoApp({ db: t.db, clock: t.clock, logger: silentLogger, scheduler: new ManualScheduler(t.clock), rng: seededRng(9) });
    cleanup.push(() => app.shutdown());
    expect(app.recover().poker).toEqual({ restored: 1, refunded: 0 });
    const state = app.poker.peek(p.id)!.state;
    expect(state.lastSmallBlind).toBeNull();
    expect(state.seats.every((seat) => !seat.owesBigBlind && !seat.owesSmallBlind && !seat.waitForBigBlind)).toBe(true);
    await app.poker.start(p.id, app.poker.peek(p.id)!.record.ownerId, app.poker.peek(p.id)!.record.version);
    expect(app.poker.peek(p.id)!.state.hand!.bigBlindSeat).toBe(0); // the big blind still moves on from seat 2
    expect(app.economy.reconcile()).toEqual([]);
  });
});

describe('chips are conserved through every blind situation', () => {
  it('random sit-outs, waits, joins, leaves, posts and restarts', async () => {
    const seen = { hands: 0, posts: 0, dead: 0, waited: 0, restarts: 0, headsUp: 0 };
    for (const seed of [2024, 7, 99, 31337]) await simulate(seed, seen);
    expect(seen.hands).toBeGreaterThanOrEqual(200);
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });

  async function simulate(seed: number, seen: Record<'hands' | 'posts' | 'dead' | 'waited' | 'restarts' | 'headsUp', number>) {
    const t = setup();
    const everyone = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const p = await table(t, everyone.slice(0, 4));
    for (const user of everyone.slice(4)) t.app.economy.ensurePlayer(G, user, user);
    t.clock.advance(DAY);
    const rng = seededRng(seed);
    let lastBig: number | null = null;
    for (let n = 0; n < 60; n++) {
      const seated = p.peek().state.seats.map((seat) => seat.userId);
      const away = everyone.filter((user) => !seated.includes(user) && t.app.economy.getWallet(G, user).balance >= 100);
      const roll = rng.int(6);
      if (roll === 0 && away.length && seated.length < 6) {
        const user = away[rng.int(away.length)]!;
        await t.app.poker.join(p.id, user, 'x', 100);
        if (rng.int(2) === 0) await t.app.poker.waitForBigBlind(p.id, user, true);
      }
      if (roll === 1 && seated.length > 3) await t.app.poker.leave(p.id, seated[rng.int(seated.length)]!);
      if (roll === 2) { const user = seated[rng.int(seated.length)]!; await t.app.poker.sitOut(p.id, user, !p.seatOf(user)?.sittingOut).catch(() => undefined); }
      if (roll === 3) { const user = seated[rng.int(seated.length)]!; await t.app.poker.waitForBigBlind(p.id, user, rng.int(3) === 0).catch(() => undefined); }
      if (!t.app.poker.peek(p.id)) break;
      const state = p.peek().state;
      const ready = state.seats.filter((seat) => !seat.sittingOut && seat.stack > 0);
      if (ready.length < 2) {
        for (const seat of state.seats) if (seat.sittingOut) await t.app.poker.sitOut(p.id, seat.userId, false);
        const spare = away.find((user) => !p.peek().state.seats.some((s) => s.userId === user));
        if (p.peek().state.seats.length < 2) {
          if (!spare) break;
          await t.app.poker.join(p.id, spare, 'x', 100);
        }
      }
      const before = p.peek().state;
      const readyNow = before.seats.filter((seat) => !seat.sittingOut && seat.stack > 0).map((seat) => seat.seat);
      await p.deal();
      const live = p.peek().state.hand;
      const big = (live ?? p.peek().state.result!).bigBlindSeat;
      if (lastBig !== null) {
        // Never skipped: no ready player sat strictly between last hand's big blind and this one.
        expect(readyNow.some((seat) => seatBetween(lastBig!, seat, big))).toBe(false);
        expect(big).not.toBe(lastBig);
      }
      lastBig = big;
      seen.hands++;
      if (live) {
        if (live.seats.length === 2) seen.headsUp++;
        if (live.seats.some((seat) => seat.dead)) seen.dead++;
        if (live.seats.some((seat) => seat.seat !== big && seat.seat !== live.smallBlindSeat && seat.committed > 0)) seen.posts++;
        if (p.peek().state.seats.some((seat) => seat.waitForBigBlind && !seat.sittingOut && !p.inHand(seat.userId))) seen.waited++;
        expect(live.seats.reduce((sum, seat) => sum + seat.stack + seat.committed, 0))
          .toBe(live.seats.reduce((sum, seat) => sum + p.seatOf(seat.userId).stack, 0));
      }
      if (live && n % 7 === 3) {
        await t.restart(10 + n);
        seen.restarts++;
      }
      for (let step = 0; p.peek().state.hand && step < 100; step++) {
        const current = p.hand();
        const user = current.seats.find((seat) => seat.seat === current.actor)!.userId;
        const legal = pokerActions(current, user)!;
        const options: PokerAction[] = [legal.check ? { type: 'check' } : { type: 'call' }, { type: 'fold' }];
        if (legal.allIn && rng.int(4) === 0) options.push({ type: 'all-in' });
        await t.app.poker.act(p.id, user, p.peek().state.handId!, current.seq, options[rng.int(options.length)]!);
      }
      expect(p.peek().state.hand).toBeNull();
      expect(t.app.economy.reconcile()).toEqual([]);
      // Achievement and mission rewards are the only chips that enter during play.
      const rewards = t.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward', 'mission_reward')")!.n;
      expect(everyone.reduce((sum, user) => sum + t.app.economy.getWallet(G, user).total, 0) - rewards).toBe(500 * everyone.length);
    }
  }
});
