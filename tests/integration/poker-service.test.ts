import { afterEach, expect, it } from 'vitest';
import { CasinoApp } from '../../src/app/casino-app.js';
import { DAY } from '../../src/core/clock.js';
import { silentLogger } from '../../src/core/logger.js';
import { ManualScheduler } from '../../src/core/scheduler.js';
import { cardLabel } from '../../src/games/cards.js';
import { pokerActions, publicPokerHand, type PokerAction } from '../../src/games/poker/engine.js';
import { CasinoHarness } from '../harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => h.close());

function nextAction(app: CasinoApp, tableId: string) {
  const { state } = app.poker.peek(tableId)!;
  const hand = state.hand!;
  const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
  const legal = pokerActions(hand, user)!;
  return app.poker.act(tableId, user, state.handId!, hand.seq, { type: legal.check ? 'check' : 'call' });
}

it('runs a public Hold’em table inside Discord, with private actions and refundable stacks', async () => {
  h = new CasinoHarness({ allowThreads: true });
  h.app.settings.set(h.guildId, 'poker.enabled', true);
  const alice = h.user('Alice');
  const bob = h.user('Bob');
  const home = h.seen(await h.slash(alice, 'casino'))!;
  const games = h.seen(await h.click(alice, home, 'Games'))!;
  const browser = h.seen(await h.click(alice, games, 'Hold’em'))!;
  const creation = await h.click(alice, browser, 'Open a Hold’em table');
  const opened = await h.submit(alice, creation, { name: 'Green Room', visibility: ['public'], seats: '6', buyin: '200' });
  expect(h.text(h.seen(opened))).toContain('seated');
  const table = h.app.poker.tableOfUser(h.guildId, alice.id)!;
  const id = table.record.id;
  const panel = () => h.fd.messages.get(h.app.poker.peek(id)!.record.messageId!)!;
  expect(h.fd.channels.get(panel().channelId)?.parentId).toBe(h.casino);
  const join = await h.click(bob, panel(), 'Take a seat');
  await h.submit(bob, join, { buyin: '200' });
  expect(h.app.economy.getWallet(h.guildId, alice.id)).toMatchObject({ balance: 300, reserved: 200 });
  const forbidden = await h.click(bob, panel(), 'Deal (host)');
  expect(h.text(h.seen(forbidden))).toContain('Only the host');
  const started = await h.click(alice, panel(), 'Deal (host)');
  const privateAlice = h.seen(started)!;
  const initial = h.app.poker.peek(id)!.state.hand!;
  const own = initial.seats.find((seat) => seat.userId === alice.id)!.cards.map(cardLabel);
  const hidden = initial.seats.find((seat) => seat.userId === bob.id)!.cards.map(cardLabel);
  expect(privateAlice.forUser).toBe(alice.id);
  for (const card of own) expect(h.text(privateAlice)).toContain(card);
  for (const card of hidden) expect(h.text(privateAlice)).not.toContain(card);
  for (const card of [...own, ...hidden]) expect(h.text(panel())).not.toContain(card);
  expect(publicPokerHand(initial)).not.toHaveProperty('deck');
  await h.click(alice, privateAlice, 'Call 5');
  const privateBob = h.seen(await h.click(bob, panel(), 'My hand'))!;
  await h.click(bob, privateBob, 'Check');
  expect(h.text(panel())).toContain('Flop');
  while (h.app.poker.peek(id)!.state.hand) await nextAction(h.app, id);
  await h.settle();
  expect(h.text(panel())).toContain('Results');
  const played = h.app.history.page(h.guildId, alice.id, 'poker', 0, 8).results[0]!;
  expect(played.detail_json).not.toMatch(/cards|deck|hole/i);
  await h.app.poker.leave(id, alice.id);
  await h.app.poker.leave(id, bob.id);
  expect(h.app.economy.getWallet(h.guildId, alice.id).reserved + h.app.economy.getWallet(h.guildId, bob.id).reserved).toBe(0);
  expect(h.balance(alice) + h.balance(bob)).toBe(1000);
  expect(h.app.economy.reconcile()).toEqual([]);
  expect(h.guard!.blockedCount).toBe(0);
});

it('resumes every street, rejects stale or foreign turns and settles one multiway side-pot hand', async () => {
  h = new CasinoHarness();
  const ids = ['a', 'b', 'c'];
  const guildId = h.guildId;
  h.app.settings.set(guildId, 'poker.enabled', true);
  h.app.settings.set(guildId, 'poker.minBuyIn', 20);
  // Established accounts: buy-ins of 100 and 50 exceed a new account's limit of two 20-chip
  // minimums (covered in tests/poker-new-accounts.test.ts).
  for (const user of ids) h.app.economy.ensurePlayer(guildId, user, user);
  h.clock.advance(DAY);
  let app = h.app;
  const host = await app.poker.create({ guildId, userId: ids[0]!, name: 'A', buyIn: 100 });
  const id = host.record.id;
  await app.poker.join(id, ids[1]!, 'B', 50);
  await app.poker.join(id, ids[2]!, 'C', 20);
  await app.poker.start(id, ids[0]!, app.poker.peek(id)!.record.version);
  const handId = app.poker.peek(id)!.state.handId!;
  const restart = async () => {
    const before = app.poker.peek(id)!.state;
    await app.shutdown();
    app = new CasinoApp({ db: h.db, clock: h.clock, logger: silentLogger, scheduler: new ManualScheduler(h.clock) });
    expect(app.recover().poker).toMatchObject({ restored: 1, refunded: 0 });
    expect(app.poker.peek(id)!.state).toEqual(before);
  };
  for (const stage of ['preflop', 'flop', 'turn', 'river']) {
    expect(app.poker.peek(id)!.state.hand?.street).toBe(stage);
    await restart();
    const hand = app.poker.peek(id)!.state.hand!;
    await expect(app.poker.act(id, 'outsider', handId, hand.seq, { type: 'fold' })).rejects.toThrow(/seat/);
    await expect(app.poker.act(id, ids[0]!, 'previous-hand', hand.seq, { type: 'fold' })).rejects.toThrow(/Refresh/);
    while (app.poker.peek(id)!.state.hand?.street === stage) {
      if (stage !== 'river') {
        await nextAction(app, id);
      } else {
        const state = app.poker.peek(id)!.state;
        const current = state.hand!;
        const player = current.seats.find((seat) => seat.seat === current.actor)!;
        const legal = pokerActions(current, player.userId)!;
        const action: PokerAction = legal.allIn ? { type: 'all-in' } : legal.call !== null ? { type: 'call' } : { type: 'check' };
        await app.poker.act(id, player.userId, handId, current.seq, action);
      }
    }
  }
  expect(app.poker.peek(id)!.state.result?.result?.pots.length).toBeGreaterThan(1);
  await restart();
  expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game_rounds WHERE id = ?', [handId])!.n).toBe(1);
  expect(h.db.get<{ n: number }>('SELECT SUM(net) AS n FROM round_results WHERE round_id = ?', [handId])!.n).toBe(0);
  expect(app.economy.reconcile()).toEqual([]);
  expect(ids.map((id) => app.economy.getWallet(guildId, id).total).reduce((sum, total) => sum + total, 0)).toBe(1500);
  await app.shutdown();
});

it('runs two six-seat poker tables alongside Blackjack and forbids cross-game seats', async () => {
  h = new CasinoHarness();
  const { app, guildId } = h;
  app.settings.set(guildId, 'poker.enabled', true);
  const poker = ['a', 'b'].map((group) => Array.from({ length: 6 }, (_, i) => group + i));
  const tables = await Promise.all(poker.map(async ([host, ...guests]) => {
    const table = await app.poker.create({ guildId, userId: host!, name: host!, buyIn: 100, private: host === 'b0' });
    const id = table.record.id;
    if (table.record.isPrivate) await expect(app.poker.join(id, guests[0]!, guests[0]!, 100, 'UNKNOWN')).rejects.toThrow(/access code/);
    await Promise.all(guests.map((guest) => app.poker.join(id, guest, guest, 100, table.record.accessCode ?? undefined)));
    return { id, host: host! };
  }));
  app.economy.ensurePlayer(guildId, 'bj');
  const black = await app.blackjack.createTable({ guildId, ownerId: 'bj', ownerName: 'BJ' });
  await app.blackjack.placeBet(black.record.id, 'bj', 25);
  await expect(app.blackjack.join(black.record.id, 'a0', 'A0')).rejects.toThrow(/seated/);
  await Promise.all(tables.map(async ({ id, host }) => {
    await app.poker.start(id, host, app.poker.peek(id)!.record.version);
    while (app.poker.peek(id)!.state.hand) await nextAction(app, id);
    expect(app.poker.peek(id)!.state.seats).toHaveLength(6);
  }));
  expect(app.economy.reconcile()).toEqual([]);
  expect(app.blackjack.peek(black.record.id)!.state.bets['bj']).toBe(25);
});

it('returns an in-hand departure only at settlement and voids a damaged snapshot back to its opening stacks', async () => {
  h = new CasinoHarness();
  const { app, guildId, clock } = h;
  app.settings.set(guildId, 'poker.enabled', true);
  const table = await app.poker.create({ guildId, userId: 'a', name: 'A', buyIn: 100 });
  const id = table.record.id;
  await app.poker.join(id, 'b', 'B', 100);
  await app.poker.start(id, 'a', app.poker.peek(id)!.record.version);
  await app.poker.leave(id, 'a');
  // It was 'a''s turn (heads-up, the button acts first pre-flop): leaving folds at once and the hand settles.
  expect(app.economy.getWallet(guildId, 'a').reserved).toBe(0);
  await h.advance(40_000);
  expect(app.poker.tableOfUser(guildId, 'a')).toBeUndefined();
  expect(app.economy.getWallet(guildId, 'a').reserved).toBe(0);
  await app.poker.join(id, 'c', 'C', 100);
  await app.poker.start(id, 'b', app.poker.peek(id)!.record.version);
  await app.shutdown();
  h.db.run("UPDATE game_tables SET state_json = '{' WHERE id = ?", [id]);
  const recovered = new CasinoApp({ db: h.db, logger: silentLogger, clock });
  expect(recovered.recover().poker).toEqual({ restored: 0, refunded: 1 });
  expect(['a', 'b', 'c'].reduce((sum, user) => sum + recovered.economy.getWallet(guildId, user).balance, 0)).toBe(1500);
  expect(recovered.economy.reconcile()).toEqual([]);
  await recovered.shutdown();
});
