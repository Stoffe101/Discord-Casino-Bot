/**
 * Audit: big-win highlights. Every announcement must be derived from authoritative round data
 * (the escrowed wager, the poker stack before the hand, refunds, net profit rather than gross
 * payout) and must respect the configured thresholds, the per-player cooldown and privacy.
 *
 * Tests wrapped in `it.fails` reproduce a CONFIRMED bug that could not be fixed inside the
 * audited files and assert the CORRECT behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng, type Rng } from '../src/core/random.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { recentCasinoActivity } from '../src/domain/casino-activity.js';
import { pokerActions, type PokerAction } from '../src/games/poker/engine.js';
import { REEL_STRIP } from '../src/games/slots/engine.js';

const G = '100000000000000001';
const apps: CasinoApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.shutdown();
    app.db.close();
  }
});

function makeApp(rng: Rng = seededRng(11)) {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler, rng });
  apps.push(app);
  return { app, db, clock, scheduler };
}

/** Rng that always stops every slot reel on the Lucky Seven (the ×200 jackpot). */
const jackpotRng: Rng = { int: (n) => (n === REEL_STRIP.length ? REEL_STRIP.indexOf('seven') : 0) };

function allHighlights(app: CasinoApp) {
  return app.db.all<{ kind: string; user_id: string; text: string }>('SELECT kind, user_id, text FROM highlights ORDER BY id');
}

function bigWins(app: CasinoApp) {
  return app.db.all<{ user_id: string; text: string }>("SELECT user_id, text FROM highlights WHERE kind = 'big_win' ORDER BY id");
}

function fund(app: CasinoApp, userId: string, total: number) {
  const player = app.economy.ensurePlayer(G, userId, userId);
  if (total !== player.balance) {
    app.economy.adminAdjust({ guildId: G, userId, actorId: 'audit', reason: 'Audit fixture', amount: total - player.balance });
  }
}

describe('wager floor applies to every big-win tier', () => {
  it('does not announce a 10-chip slots jackpot (real SlotsService, ×200 = 2,000 gross)', async () => {
    const { app } = makeApp(jackpotRng);
    fund(app, 'alice', 500);
    const outcome = await app.slots.spin(G, 'alice', 10, null);
    expect(outcome.payout).toBe(2000);
    expect(outcome.net).toBe(1990);
    // minimumWager defaults to 50: a 10-chip stake must not become a "Major win". The only lobby
    // line is the one-time secret "Jackpot!" achievement unlock, which has no wager floor.
    expect(allHighlights(app)).toEqual([{ kind: 'achievement', user_id: 'alice', text: 'unlocked **Jackpot!**' }]);
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('announces a 50-chip jackpot exactly once with the authoritative net from round_results', async () => {
    const { app } = makeApp(jackpotRng);
    fund(app, 'alice', 500);
    await app.slots.spin(G, 'alice', 50, null);
    const net = app.db.get<{ net: number }>("SELECT net FROM round_results WHERE user_id = 'alice'")!.net;
    expect(net).toBe(9950);
    const rows = bigWins(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('Slots jackpot');
    expect(rows[0]!.text).toContain('won **9,950**');
  });

  it('does not announce a 30-chip roulette straight-up hit (35:1, +1,050 net)', () => {
    const { app } = makeApp();
    fund(app, 'alice', 500);
    app.economy.reserve({ guildId: G, userId: 'alice', game: 'roulette', contextId: 'spin-1', amount: 30, key: 'spin-1' });
    app.recorder.record({ guildId: G, roundId: 'spin-1', game: 'roulette', title: 'Roulette',
      players: [{ userId: 'alice', wagered: 30, returned: 1080, flags: ['roulette_straight_win'], label: 'win', stats: {}, xp: 0 }] });
    expect(allHighlights(app)).toEqual([]);
  });

  it('keeps the wager floor when an admin sets the major threshold below the big-win threshold', () => {
    const { app } = makeApp();
    app.settings.set(G, 'highlights.majorNet', 5);
    // A 10-chip Hold’em all-in that wins a three-way main pot (+20 net).
    const stacks = [
      { userId: 'short', before: 10, after: 30 },
      { userId: 'b', before: 500, after: 490 },
      { userId: 'c', before: 500, after: 490 },
    ];
    for (const s of stacks) {
      fund(app, s.userId, 500);
      app.economy.reserve({ guildId: G, userId: s.userId, game: 'poker', contextId: 'table-1', amount: s.before, key: 'buy-in' });
    }
    app.recorder.recordPoker({ guildId: G, tableId: 'table-1', roundId: 'hand-1', game: 'poker', title: 'Hold’em',
      players: stacks.map((s) => ({ userId: s.userId, wagered: 10, returned: s.userId === 'short' ? 30 : 0, flags: [], label: 'x', stats: {}, xp: 0 })) }, stacks);
    expect(allHighlights(app)).toEqual([]);
    expect(app.economy.reconcile()).toEqual([]);
  });
});

describe('Hold’em highlights through the real PokerTableService', () => {
  async function headsUpShove(seed: number, bigStack: number, shortStack: number) {
    const { app, clock } = makeApp(seededRng(seed));
    app.settings.set(G, 'poker.enabled', true);
    app.settings.set(G, 'poker.maxBuyIn', Math.max(bigStack, shortStack));
    fund(app, 'big', bigStack);
    fund(app, 'short', shortStack);
    // Established accounts: this is about highlight labels, not the first-day Hold'em limit.
    clock.advance(25 * 3_600_000);
    const table = await app.poker.create({ guildId: G, userId: 'big', name: 'Big', buyIn: bigStack });
    const id = table.record.id;
    await app.poker.join(id, 'short', 'Short', shortStack);
    await app.poker.start(id, 'big', app.poker.peek(id)!.record.version);
    let shoved = false;
    while (app.poker.peek(id)!.state.hand) {
      const { state } = app.poker.peek(id)!;
      const hand = state.hand!;
      const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
      const legal = pokerActions(hand, user)!;
      const action: PokerAction = !shoved && legal.allIn ? { type: 'all-in' as const } : legal.call !== null ? { type: 'call' as const } : { type: 'check' as const };
      shoved ||= action.type === 'all-in';
      await app.poker.act(id, user, state.handId!, hand.seq, action);
    }
    const results = app.db.all<{ user_id: string; wagered: number; returned: number; net: number }>(
      "SELECT user_id, wagered, returned, net FROM round_results WHERE game = 'poker'");
    return { app, results };
  }

  it('labels a big stack shoving into a short stack by the chips actually at risk (uncalled chips refunded)', async () => {
    const winners = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const { app, results } = await headsUpShove(seed, 2000, 600);
      const big = results.find((r) => r.user_id === 'big')!;
      // The uncalled 1,400 went back to the stack; only 600 was wagered.
      expect(big.wagered).toBe(600);
      const rows = bigWins(app);
      const winner = results.find((r) => r.net > 0);
      if (!winner) {
        expect(rows).toEqual([]);
        continue;
      }
      winners.add(winner.user_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.user_id).toBe(winner.user_id);
      expect(rows[0]!.text).toContain(`won **${winner.net}**`);
      // Only the short stack really committed its entire stack.
      if (winner.user_id === 'big') expect(rows[0]!.text).not.toContain('All-in');
      else expect(rows[0]!.text).toContain('All-in win');
      expect(app.economy.reconcile()).toEqual([]);
    }
    // Both branches (big stack wins: not an all-in; short stack wins: all-in) were exercised.
    expect([...winners].sort()).toEqual(['big', 'short']);
  });

  it('never announces a 10-chip all-in, even when it doubles up', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { app } = await (async () => {
        const made = makeApp(seededRng(seed));
        made.app.settings.set(G, 'poker.enabled', true);
        made.app.settings.set(G, 'poker.minBuyIn', 10);
        made.app.settings.set(G, 'poker.smallBlind', 1);
        made.app.settings.set(G, 'poker.bigBlind', 2);
        made.app.settings.set(G, 'highlights.majorNet', 1);
        made.app.settings.set(G, 'highlights.bigNet', 1);
        made.app.settings.set(G, 'highlights.allInStake', 1);
        return made;
      })();
      fund(app, 'a', 500);
      fund(app, 'b', 500);
      const table = await app.poker.create({ guildId: G, userId: 'a', name: 'A', buyIn: 10 });
      const id = table.record.id;
      await app.poker.join(id, 'b', 'B', 10);
      await app.poker.start(id, 'a', app.poker.peek(id)!.record.version);
      while (app.poker.peek(id)!.state.hand) {
        const { state } = app.poker.peek(id)!;
        const hand = state.hand!;
        const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
        const legal = pokerActions(hand, user)!;
        await app.poker.act(id, user, state.handId!, hand.seq, legal.allIn ? { type: 'all-in' } : legal.call !== null ? { type: 'call' } : { type: 'check' });
      }
      // minimumWager (50) still applies even with every other threshold at its minimum.
      expect(allHighlights(app)).toEqual([]);
    }
  });

  it('does not duplicate a highlight when the same hand is recorded twice', () => {
    const { app } = makeApp();
    const stacks = [{ userId: 'a', before: 600, after: 1200 }, { userId: 'b', before: 600, after: 0 }];
    for (const s of stacks) {
      fund(app, s.userId, 600);
      app.economy.reserve({ guildId: G, userId: s.userId, game: 'poker', contextId: 'table-1', amount: 600, key: 'buy-in' });
    }
    const input = { guildId: G, tableId: 'table-1', roundId: 'hand-1', game: 'poker' as const, title: 'Hold’em',
      players: [
        { userId: 'a', wagered: 600, returned: 1200, flags: [], label: 'win', stats: {}, xp: 0 },
        { userId: 'b', wagered: 600, returned: 0, flags: [], label: 'lose', stats: {}, xp: 0 },
      ] };
    expect(app.recorder.recordPoker(input, stacks).duplicate).toBe(false);
    expect(app.recorder.recordPoker(input, stacks).duplicate).toBe(true);
    const rows = bigWins(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('All-in win');
  });
});

describe('coinflip, blackjack-shaped rounds, privacy and pings', () => {
  it('announces only the coinflip winner, and nothing for expired or declined duels', async () => {
    const { app, clock, scheduler } = makeApp();
    for (const id of ['a', 'b']) fund(app, id, 2000);
    const declined = await app.coinflip.create({ guildId: G, challengerId: 'a', opponentId: 'b', amount: 600, call: 'heads' });
    await app.coinflip.decline(declined.id, 'b');
    await app.coinflip.create({ guildId: G, challengerId: 'a', opponentId: 'b', amount: 600, call: 'heads' });
    clock.advance(10 * 60_000);
    scheduler.runDue();
    await app.coinflip.idle();
    expect(bigWins(app)).toEqual([]);
    const live = await app.coinflip.create({ guildId: G, challengerId: 'a', opponentId: 'b', amount: 600, call: 'heads' });
    const { challenge } = await app.coinflip.accept(live.id, 'b');
    const rows = bigWins(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(challenge.winnerId);
    expect(rows[0]!.text).toContain('won **600**');
    expect(app.economy.reconcile()).toEqual([]);
  });

  it('uses net profit, not gross payout, for a blackjack-shaped round', () => {
    const { app } = makeApp();
    fund(app, 'alice', 2000);
    app.economy.reserve({ guildId: G, userId: 'alice', game: 'blackjack', contextId: 'r1', amount: 1000, key: 'r1' });
    // 1,000 staked across split hands, 1,400 back: gross 1,400 but only +400 net (< bigNet 500).
    app.recorder.record({ guildId: G, roundId: 'r1', game: 'blackjack', title: 'BJ',
      players: [{ userId: 'alice', wagered: 1000, returned: 1400, flags: ['bj_split_both_won'], label: 'win', stats: {}, xp: 0 }] });
    expect(bigWins(app)).toEqual([]);
  });

  it('honours a zero cooldown, the opt-out at write and read time, and the master switch', () => {
    const { app, clock } = makeApp();
    app.settings.set(G, 'highlights.cooldownSeconds', 0);
    fund(app, 'alice', 5000);
    let n = 0;
    const win = () => {
      const id = 'round-' + ++n;
      app.economy.reserve({ guildId: G, userId: 'alice', game: 'slots', contextId: id, amount: 100, key: id });
      app.recorder.record({ guildId: G, roundId: id, game: 'slots', title: 'Slots',
        players: [{ userId: 'alice', wagered: 100, returned: 700, flags: [], label: 'win', stats: {}, xp: 0 }] });
      clock.advance(1);
    };
    win();
    win();
    expect(bigWins(app)).toHaveLength(2);
    app.db.run("UPDATE players SET highlights_opt_out = 1 WHERE user_id = 'alice'");
    win();
    expect(bigWins(app)).toHaveLength(2);
    expect(recentCasinoActivity(app, G, 5)).toEqual([]);
    app.db.run("UPDATE players SET highlights_opt_out = 0 WHERE user_id = 'alice'");
    app.settings.set(G, 'highlights.enabled', false);
    win();
    expect(bigWins(app)).toHaveLength(2);
    expect(recentCasinoActivity(app, G, 5)).toEqual([]);
  });

  it('cannot ping anyone through a display name', () => {
    const { app } = makeApp();
    app.economy.ensurePlayer(G, 'alice', '@everyone <@&123456789012345678> <@234567890123456789> @here');
    fund(app, 'alice', 2000);
    app.economy.reserve({ guildId: G, userId: 'alice', game: 'slots', contextId: 'r', amount: 100, key: 'r' });
    app.recorder.record({ guildId: G, roundId: 'r', game: 'slots', title: 'Slots',
      players: [{ userId: 'alice', wagered: 100, returned: 900, flags: [], label: 'win', stats: {}, xp: 0 }] });
    const [line] = recentCasinoActivity(app, G, 1);
    expect(line).toBeDefined();
    expect(line).not.toMatch(/@everyone|@here|<@&?\d/);
  });
});
