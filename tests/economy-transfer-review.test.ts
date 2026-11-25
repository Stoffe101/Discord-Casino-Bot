/**
 * The admin "unusual transfers" review: read-only, explainable, bounded and guild-isolated.
 * Real gifts, coinflips and a real Hold'em hand go through production code; a few multiway and
 * house-game shapes are written straight into round_results, which is all the query reads.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { DAY, HOUR, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng, type Rng } from '../src/core/random.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { pokerActions } from '../src/games/poker/engine.js';
import { REVIEW_LIMIT, reviewTransfers } from '../src/domain/economy/transfer-review.js';
import { adminScreen, unusualTransfersScreen } from '../src/ui/screens/admin.js';

const G = '100000000000000001';
const OTHER = '100000000000000002';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** By default every coin lands heads, so whoever calls tails loses. */
function makeApp(rng: Rng = { int: () => 0 }) {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock), rng });
  cleanup.push(() => db.close(), () => app.shutdown());
  for (const guild of [G, OTHER]) app.settings.set(guild, 'economy.passivePerHour', 0);
  return { app, db, clock };
}

/** An established account (8 days old) and a brand-new one, in the given guild. */
function accounts(app: CasinoApp, clock: ManualClock, guild = G) {
  app.economy.ensurePlayer(guild, 'main', 'Main');
  clock.advance(8 * DAY);
  app.economy.ensurePlayer(guild, 'alt', 'Alt');
}

/** Write one player-vs-player (or house) round straight into round_results. */
function round(db: Database, guild: string, game: string, nets: Record<string, number>, at: number, roundId = randomUUID()) {
  for (const [user, net] of Object.entries(nets)) {
    db.run(
      `INSERT INTO round_results (round_id, guild_id, user_id, game, wagered, returned, net, outcome, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [roundId, guild, user, game, Math.max(0, -net), Math.max(0, net), net, net > 0 ? 'win' : net < 0 ? 'lose' : 'push', at],
    );
  }
  return roundId;
}

describe('unusual transfers: new accounts', () => {
  it('flags a new account that lost its whole starting stack to one player in a real Hold’em hand', async () => {
    const { app, clock, db } = makeApp(seededRng(2)); // this deck gives the established account the better hand
    app.settings.set(G, 'poker.enabled', true);
    accounts(app, clock);
    const joined = clock.now();
    // Day two: past any first-day Hold'em limit, still inside the 48-hour review window.
    clock.advance(25 * HOUR);
    const table = await app.poker.create({ guildId: G, userId: 'main', name: 'Main', buyIn: 500 });
    await app.poker.join(table.record.id, 'alt', 'Alt', 500);
    await app.poker.start(table.record.id, 'main', app.poker.peek(table.record.id)!.record.version);
    while (app.poker.peek(table.record.id)!.state.hand) {
      const { state } = app.poker.peek(table.record.id)!;
      const hand = state.hand!;
      const actor = hand.seats.find((seat) => seat.seat === hand.actor)!;
      const legal = pokerActions(hand, actor.userId)!;
      // Both players shove or call: one hand settles the whole stack.
      const action = legal.allIn ? { type: 'all-in' as const } : legal.check ? { type: 'check' as const } : { type: 'call' as const };
      await app.poker.act(table.record.id, actor.userId, state.handId!, hand.seq, action);
    }
    const nets = Object.fromEntries(db.all<{ user_id: string; net: number }>("SELECT user_id, net FROM round_results WHERE game = 'poker'").map((r) => [r.user_id, r.net]));
    expect(nets).toEqual({ main: 500, alt: -500 });
    const review = reviewTransfers(db, G, clock.now());
    expect(review.newAccounts).toEqual([{ userId: 'alt', counterpartyId: 'main', amount: 500, startingGrant: 500, via: ['poker'], joinedAt: joined }]);
  });

  it('flags a gift dump on the first day gifts are allowed', () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock);
    const joined = clock.now();
    clock.advance(25 * HOUR);
    app.economy.gift(G, 'alt', 'main', 300, 'gift-1');
    expect(reviewTransfers(db, G, clock.now()).newAccounts).toEqual([
      { userId: 'alt', counterpartyId: 'main', amount: 300, startingGrant: 500, via: ['gift'], joinedAt: joined },
    ]);
  });

  it('nets out chips won back from the same player (real coinflips)', async () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock);
    // The coin always lands heads: whoever calls tails loses.
    const lost = await app.coinflip.create({ guildId: G, challengerId: 'alt', opponentId: 'main', amount: 300, call: 'tails' });
    await app.coinflip.accept(lost.id, 'main');
    expect(reviewTransfers(db, G, clock.now()).newAccounts.map((f) => [f.userId, f.counterpartyId, f.amount, f.via])).toEqual([['alt', 'main', 300, ['coinflip']]]);
    const won = await app.coinflip.create({ guildId: G, challengerId: 'main', opponentId: 'alt', amount: 200, call: 'tails' });
    await app.coinflip.accept(won.id, 'alt');
    expect(reviewTransfers(db, G, clock.now()).newAccounts).toEqual([]); // 300 − 200 = 100 net, under half of 500
  });

  it('splits a multiway pot by what each winner actually took', () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock);
    app.economy.ensurePlayer(G, 'other', 'Other');
    round(db, G, 'poker', { alt: -400, main: 300, other: 100 }, clock.now());
    const flagged = reviewTransfers(db, G, clock.now()).newAccounts;
    expect(flagged.map((f) => [f.userId, f.counterpartyId, f.amount])).toEqual([['alt', 'main', 300]]);
  });

  it('ignores spread-out, small, late, old-account and house-game losses', () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock);
    const joined = clock.now();
    app.economy.ensurePlayer(G, 'other', 'Other');
    // Spread: 300 lost, but only 150 to each winner.
    round(db, G, 'poker', { alt: -300, main: 150, other: 150 }, joined + HOUR);
    // Small: 200 of 500 to one player.
    app.economy.ensurePlayer(G, 'small', 'Small');
    round(db, G, 'coinflip', { small: -200, main: 200 }, joined + HOUR);
    // House games never count, not even a shared roulette round.
    app.economy.ensurePlayer(G, 'house', 'House');
    round(db, G, 'roulette', { house: -400, main: 400 }, joined + HOUR);
    round(db, G, 'blackjack', { house: -300, main: 300 }, joined + HOUR);
    // Late: the dump happened more than 48 hours after joining.
    app.economy.ensurePlayer(G, 'late', 'Late');
    round(db, G, 'poker', { late: -500, main: 500 }, joined + 49 * HOUR);
    // Old: the account is older than the 7-day window, whatever it did on day one.
    round(db, G, 'poker', { main: -500, alt: 500 }, joined - 8 * DAY + HOUR);
    clock.advance(50 * HOUR);
    expect(reviewTransfers(db, G, clock.now()).newAccounts).toEqual([]);
  });

  it('stays inside one guild, even when a round id is shared across guilds', () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock, G);
    accounts(app, clock, OTHER);
    // The same user ids dump in OTHER only.
    round(db, OTHER, 'poker', { alt: -450, main: 450 }, clock.now());
    // A forged pairing: the loss is in G, the "winner" row lives in OTHER under the same round id.
    const shared = round(db, G, 'poker', { alt: -500 }, clock.now());
    round(db, OTHER, 'poker', { thief: 500 }, clock.now(), shared);
    expect(reviewTransfers(db, G, clock.now()).newAccounts).toEqual([]);
    expect(reviewTransfers(db, OTHER, clock.now()).newAccounts.map((f) => [f.userId, f.counterpartyId, f.amount])).toEqual([['alt', 'main', 450]]);
  });
});

describe('unusual transfers: repeated gifts', () => {
  function gifting() {
    const made = makeApp();
    for (const guild of [G, OTHER]) for (const user of ['a', 'b', 'c', 'd', 'e']) made.app.economy.ensurePlayer(guild, user, user);
    made.clock.advance(2 * DAY);
    return made;
  }

  it('lists a pair with three gifts in seven days and nothing below that', () => {
    const { app, clock, db } = gifting();
    app.economy.gift(G, 'a', 'e', 50, 'old-1'); // falls out of the window below
    clock.advance(8 * DAY);
    for (let i = 0; i < 3; i++) {
      app.economy.gift(G, 'a', 'b', 40 + i, `ab-${i}`);
      clock.advance(HOUR);
    }
    app.economy.gift(G, 'b', 'a', 20, 'ba-1'); // the reverse direction is its own pair
    app.economy.gift(G, 'c', 'd', 50, 'cd-1');
    app.economy.gift(G, 'c', 'd', 50, 'cd-2');
    app.economy.gift(G, 'a', 'e', 50, 'ae-1');
    app.economy.gift(G, 'a', 'e', 50, 'ae-2');
    const pairs = reviewTransfers(db, G, clock.now()).giftPairs;
    expect(pairs.map((p) => [p.senderId, p.recipientId, p.count, p.total])).toEqual([['a', 'b', 3, 123]]);
    expect(pairs[0]!.lastAt).toBe(clock.now() - HOUR);
  });

  it('is bounded and guild-isolated', () => {
    const { app, clock, db } = gifting();
    const users = Array.from({ length: 13 }, (_, i) => `u${i}`);
    for (const user of users) app.economy.ensurePlayer(OTHER, user, user);
    clock.advance(2 * DAY);
    for (let i = 0; i < 12; i++) {
      for (let n = 0; n < 3; n++) app.economy.gift(OTHER, users[i]!, users[i + 1]!, 10 + i, `p${i}-${n}`);
    }
    for (let n = 0; n < 3; n++) app.economy.gift(G, 'c', 'd', 10, `g-${n}`);
    const other = reviewTransfers(db, OTHER, clock.now()).giftPairs;
    expect(other).toHaveLength(REVIEW_LIMIT);
    expect(other[0]).toMatchObject({ senderId: 'u11', recipientId: 'u12', count: 3, total: 63 });
    expect(other.some((p) => p.senderId === 'c')).toBe(false);
    expect(reviewTransfers(db, G, clock.now()).giftPairs.map((p) => [p.senderId, p.recipientId])).toEqual([['c', 'd']]);
  });
});

describe('unusual transfers screen', () => {
  it('is reachable from the admin panel and renders without touching a wallet', async () => {
    const { app, clock, db } = makeApp();
    accounts(app, clock);
    clock.advance(25 * HOUR);
    app.economy.gift(G, 'alt', 'main', 400, 'dump');
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger')!.n;
    const panel = JSON.stringify(adminScreen(app, G, 'general'));
    expect(panel).toContain('"custom_id":"adm:transfers"');
    const screen = unusualTransfersScreen(app, G);
    const json = JSON.stringify(screen);
    expect(json).toContain('<@alt> → <@main>');
    expect(json).toContain('400** of 500 starting chips');
    expect(json).toContain('Repeated gifts');
    expect(json).toContain('"custom_id":"adm:group:economy"');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger')!.n).toBe(before);
    for (const match of json.matchAll(/"custom_id":"([^"]*)"/g)) expect(match[1]!.length).toBeLessThanOrEqual(100);
    const rows = (screen.components[0] as { components: { type: number; components?: unknown[] }[] }).components.filter((c) => c.type === 1);
    for (const r of rows) expect(r.components!.length).toBeLessThanOrEqual(5);
  });

  it('stays inside Discord’s 4,000-character text budget with both lists full', () => {
    const { app, clock, db } = makeApp();
    const id = (n: number) => `3${String(n).padStart(17, '0')}`; // real snowflakes are 17–19 digits
    for (let i = 0; i < 20; i++) app.economy.ensurePlayer(G, id(i), 'Player');
    clock.advance(2 * DAY);
    for (let i = 0; i < 10; i++) for (let n = 0; n < 3; n++) app.economy.gift(G, id(i), id(i + 10), 100 + i, `budget-${i}-${n}`);
    for (let i = 0; i < 12; i++) {
      app.economy.ensurePlayer(G, id(100 + i), 'Newcomer');
      round(db, G, 'poker', { [id(100 + i)]: -500, [id(i)]: 500 }, clock.now());
    }
    const review = reviewTransfers(db, G, clock.now());
    expect([review.newAccounts.length, review.giftPairs.length]).toEqual([REVIEW_LIMIT, REVIEW_LIMIT]);
    const container = unusualTransfersScreen(app, G).components[0] as { components: { type: number; content?: string }[] };
    const textLength = container.components.reduce((sum, c) => sum + (c.content?.length ?? 0), 0);
    expect(textLength).toBeLessThan(4000);
  });
});
