import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { silentLogger } from '../src/core/logger.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { seededRng } from '../src/core/random.js';
import { pokerActions } from '../src/games/poker/engine.js';
import { CasinoHarness } from './harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => h.close());

async function table(users: string[], buyIn = 100) {
  h = new CasinoHarness();
  const { app, guildId } = h;
  app.settings.set(guildId, 'poker.enabled', true);
  const created = await app.poker.create({ guildId, userId: users[0]!, name: users[0]!, buyIn });
  const id = created.record.id;
  for (const user of users.slice(1)) await app.poker.join(id, user, user, buyIn);
  return id;
}

const peek = (id: string) => h.app.poker.peek(id)!;
const actorOf = (id: string) => {
  const hand = peek(id).state.hand!;
  return hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
};


describe('audit: poker service', () => {
  it('a double-submitted buy-in reserves once', async () => {
    const id = await table(['a', 'b']);
    const results = await Promise.allSettled([h.app.poker.join(id, 'c', 'C', 100), h.app.poker.join(id, 'c', 'C', 100)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.app.economy.getWallet(h.guildId, 'c')).toMatchObject({ reserved: 100, balance: 400 });
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('concurrent buy-ins at two different tables reserve once', async () => {
    const id = await table(['a', 'b']);
    const other = await h.app.poker.create({ guildId: h.guildId, userId: 'x', name: 'X', buyIn: 100 });
    const results = await Promise.allSettled([h.app.poker.join(id, 'c', 'C', 100), h.app.poker.join(other.record.id, 'c', 'C', 100)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.app.economy.getWallet(h.guildId, 'c').reserved).toBe(100);
  });

  it('times out to check when possible and to fold otherwise', async () => {
    const id = await table(['a', 'b', 'c']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const first = actorOf(id);
    await h.advance(40_000);
    expect(peek(id).state.hand!.seats.find((seat) => seat.userId === first)!.folded).toBe(true);
    // Everyone calls, then the big blind times out with a free check.
    await h.app.poker.act(id, actorOf(id), peek(id).state.handId!, peek(id).state.hand!.seq, { type: 'call' });
    const bb = actorOf(id);
    expect(pokerActions(peek(id).state.hand!, bb)!.check).toBe(true);
    await h.advance(40_000);
    expect(peek(id).state.hand!.street).toBe('flop');
    expect(peek(id).state.hand!.seats.find((seat) => seat.userId === bb)!.folded).toBe(false);
  });

  it('rejects stale buttons from a previous hand that share the sequence number', async () => {
    const id = await table(['a', 'b']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const oldHand = peek(id).state.handId!;
    await h.app.poker.act(id, actorOf(id), oldHand, 0, { type: 'fold' });
    await h.app.poker.start(id, 'a', peek(id).record.version);
    await expect(h.app.poker.act(id, actorOf(id), oldHand, 0, { type: 'fold' })).rejects.toThrow(/Refresh/);
    await expect(h.app.poker.start(id, 'a', peek(id).record.version - 1)).rejects.toThrow(/Refresh/);
  });

  it('keeps chips conserved with joins, leaves and restarts across many hands', async () => {
    const users = ['a', 'b', 'c', 'd'];
    const id = await table(users.slice(0, 3));
    h.app.economy.ensurePlayer(h.guildId, 'd', 'D');
    let app = h.app;
    let scheduler = h.scheduler;
    let restarts = 0;
    for (let n = 0; n < 12; n++) {
      if (n === 2) await app.poker.join(id, 'd', 'D', 100);
      const state = app.poker.peek(id)?.state;
      if (!state || state.seats.filter((s) => !s.sittingOut && s.stack > 0).length < 2) break;
      await app.poker.start(id, app.poker.peek(id)!.record.ownerId, app.poker.peek(id)!.record.version);
      for (let step = 0; app.poker.peek(id)?.state.hand && step < 80; step++) {
        const snap = app.poker.peek(id)!;
        const hand = snap.state.hand!;
        if (step === 1 && n % 3 === 0) {
          await app.shutdown();
          scheduler = new ManualScheduler(h.clock);
          app = new CasinoApp({ db: h.db, clock: h.clock, logger: silentLogger, scheduler, rng: seededRng(100 + n) });
          expect(app.recover().poker).toMatchObject({ restored: 1, refunded: 0 });
          restarts++;
          continue;
        }
        if (step === 2 && n === 4) await app.poker.leave(id, hand.seats[0]!.userId);
        const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
        if (app.poker.peek(id)!.state.seats.find((s) => s.userId === user)!.leaving) {
          h.clock.advance(40_000);
          scheduler.runDue();
          await app.poker.idle();
          continue;
        }
        const legal = pokerActions(hand, user)!;
        const action = step === 3 && n % 4 === 3 && legal.allIn ? { type: 'all-in' as const } : legal.check ? { type: 'check' as const } : { type: 'call' as const };
        await app.poker.act(id, user, snap.state.handId!, hand.seq, action);
      }
      expect(app.poker.peek(id)?.state.hand ?? null).toBeNull();
      expect(app.economy.reconcile()).toEqual([]);
      // Achievements and missions can credit chips during play; everything else must be conserved.
      const rewards = h.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward', 'mission_reward')")!.n;
      expect(users.reduce((sum, user) => sum + app.economy.getWallet(h.guildId, user).total, 0) - rewards).toBe(2000);
    }
    expect(restarts).toBeGreaterThanOrEqual(2);
    await app.shutdown();
  });
});

describe('audit: leaving mid-hand', () => {
  // Bug: a player who pressed Leave mid-hand cannot act (act() refuses leaving seats), so each of
  // their turns stalled the table for the full turn timer before an auto check/fold.
  // Later turns are fixed in PokerTableService.advance(). The turn that is current when they press
  // Leave still waits for the timer: resolving it in leave() (call this.advance(record, state, now,
  // 'update') when state.hand.actor === seat.seat) is a two-line change, but it contradicts
  // tests/integration/poker-service.test.ts › 'returns an in-hand departure only at settlement…',
  // which asserts reserved === 100 right after the acting player leaves and needs updating with it.
  it('acts at once for a leaving player instead of stalling the table until the turn timer', async () => {
    const id = await table(['a', 'b', 'c']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const leaver = actorOf(id);
    const handId = peek(id).state.handId!;
    await h.app.poker.leave(id, leaver);
    await expect(h.app.poker.act(id, leaver, handId, peek(id).state.hand?.seq ?? 0, { type: 'fold' })).rejects.toThrow();
    // No time passes: the leaving player's turn is already resolved (fold, since they face the big blind).
    const hand = peek(id).state.hand!;
    expect(hand.seats.find((seat) => seat.userId === leaver)!.folded).toBe(true);
    expect(actorOf(id)).not.toBe(leaver);
    // Later the hand settles normally and the leaver's untouched stack goes back to the wallet.
    while (peek(id).state.hand) {
      const current = peek(id).state.hand!;
      const user = actorOf(id);
      const legal = pokerActions(current, user)!;
      await h.app.poker.act(id, user, peek(id).state.handId!, current.seq, { type: legal.check ? 'check' : 'call' });
    }
    expect(h.app.poker.tableOfUser(h.guildId, leaver)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, leaver)).toMatchObject({ reserved: 0, balance: 500 });
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('auto-checks a leaving player whose turn comes later, without waiting for the timer', async () => {
    const id = await table(['a', 'b']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    // Heads-up: the button (small blind) acts first; the big blind leaves before acting.
    const button = actorOf(id);
    const bigBlind = peek(id).state.hand!.seats.find((seat) => seat.userId !== button)!.userId;
    await h.app.poker.leave(id, bigBlind);
    await h.app.poker.act(id, button, peek(id).state.handId!, peek(id).state.hand!.seq, { type: 'call' });
    // The big blind's free option is checked at once and the flop is dealt with the button to act.
    const hand = peek(id).state.hand!;
    expect(hand.street).toBe('flop');
    expect(actorOf(id)).toBe(button);
    expect(peek(id).state.deadline).toBe(h.clock.now() + 40_000);
    await h.app.poker.act(id, button, peek(id).state.handId!, hand.seq, { type: 'raise', to: 10 });
    // Facing a bet, the leaving player folds at once and the hand settles.
    expect(peek(id).state.hand).toBeNull();
    expect(h.app.poker.tableOfUser(h.guildId, bigBlind)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, bigBlind).total).toBe(490);
    expect(h.app.economy.getWallet(h.guildId, button).total).toBe(510);
    expect(h.app.economy.reconcile()).toEqual([]);
  });
});

describe('audit: blinds and the button', () => {
  // Rule deviation (not fixed): the button simply moves to the next ready seat, and sitting out has no
  // missed-blind bookkeeping. A player can sit out for the one hand where the big blind would reach
  // them and sit back in on the button, skipping both blinds for that orbit. Established rules
  // (TDA dead-button / missed-blind rules) require the big blind to advance one seat per hand and a
  // returning player to post the missed blinds or wait for the big blind. Fixing it needs dealPoker()
  // to accept a dead small blind / empty button seat plus per-seat missed-blind state in
  // PokerTableState, which is a design change for the owner to approve.
  it.fails('a player cannot dodge the big blind by sitting out for one hand', async () => {
    const id = await table(['a', 'b', 'c']);
    const playOut = async () => {
      while (peek(id).state.hand) {
        const hand = peek(id).state.hand!;
        const user = actorOf(id);
        await h.app.poker.act(id, user, peek(id).state.handId!, hand.seq, { type: pokerActions(hand, user)!.check ? 'check' : 'fold' });
      }
    };
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const first = peek(id).state.hand!;
    expect([first.dealer, first.smallBlindSeat, first.bigBlindSeat]).toEqual([0, 1, 2]);
    await playOut();
    // Seat 0 ('a') is due the big blind next. They sit out for exactly one hand.
    await h.app.poker.sitOut(id, 'a', true);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    await playOut();
    await h.app.poker.sitOut(id, 'a', false);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const third = peek(id).state.hand!;
    const posted = third.seats.find((seat) => seat.userId === 'a')!.committed;
    expect(posted).toBeGreaterThan(0); // fails: 'a' is on the button and pays nothing
  });
});

describe('audit: host transfer and voided hands', () => {
  it('transfers the host when the host leaves mid-hand, only after settlement', async () => {
    const id = await table(['a', 'b', 'c']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const host = 'a';
    if (actorOf(id) !== host) await h.app.poker.leave(id, host);
    else await h.app.poker.act(id, host, peek(id).state.handId!, peek(id).state.hand!.seq, { type: 'fold' }).then(() => h.app.poker.leave(id, host));
    expect(peek(id).record.ownerId).toBe(host);
    while (peek(id).state.hand) {
      const hand = peek(id).state.hand!;
      const user = actorOf(id);
      if (user === host) { await h.advance(40_000); continue; }
      await h.app.poker.act(id, user, peek(id).state.handId!, hand.seq, { type: pokerActions(hand, user)!.check ? 'check' : 'call' });
    }
    expect(peek(id).state.seats.map((seat) => seat.userId)).toEqual(['b', 'c']);
    expect(peek(id).record.ownerId).toBe('b');
    await expect(h.app.poker.start(id, 'a', peek(id).record.version)).rejects.toThrow(/host/);
    await h.app.poker.start(id, 'b', peek(id).record.version);
    expect(peek(id).state.hand).not.toBeNull();
    expect(h.db.get<{ owner_id: string }>('SELECT owner_id FROM game_tables WHERE id = ?', [id])!.owner_id).toBe('b');
  });

  it('voids a hand whose timeout settlement fails and refunds the opening stacks', async () => {
    const id = await table(['a', 'b']);
    await h.app.poker.start(id, 'a', peek(id).record.version);
    const user = actorOf(id);
    await h.app.poker.act(id, user, peek(id).state.handId!, peek(id).state.hand!.seq, { type: 'raise', to: 40 });
    const recorder = (h.app.poker as unknown as { deps: { recorder: { recordPoker: unknown } } }).deps.recorder;
    recorder.recordPoker = () => { throw new Error('simulated settlement failure'); };
    await h.advance(40_000); // the big blind times out facing a raise -> fold -> settlement throws
    await h.app.poker.idle();
    expect(h.app.poker.peek(id)).toBeUndefined();
    for (const player of ['a', 'b']) expect(h.app.economy.getWallet(h.guildId, player)).toMatchObject({ reserved: 0, balance: 500 });
    expect(h.app.economy.reconcile()).toEqual([]);
  });
});
