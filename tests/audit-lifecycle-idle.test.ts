/**
 * Audit: idle closure with the manual clock. Policy: empty table ~3 min, occupied but inactive
 * ~5 min, never during an active hand or with unresolved wagers; Hold'em stacks are returned.
 * Only real player mutations may count as activity — renders, lobby syncs and spectators must not.
 *
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_INTERVAL_MS } from '../src/discord/bot.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import { CasinoHarness } from './harness/casino-harness.js';
import type { FakeUser } from './harness/fake-discord.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function harness(options: ConstructorParameters<typeof CasinoHarness>[0] = {}): CasinoHarness {
  const h = new CasinoHarness(options);
  cleanup.push(() => h.close());
  return h;
}

function player(h: CasinoHarness, name: string): FakeUser {
  const user = h.user(name);
  h.app.economy.ensurePlayer(h.guildId, user.id, name);
  return user;
}

async function openTable(h: CasinoHarness, host: FakeUser) {
  const table = await h.app.blackjack.createTable({ guildId: h.guildId, ownerId: host.id, ownerName: host.name });
  await h.bot.createTablePanel(table.record.id, h.casino, host.id);
  await h.settle();
  return table.record.id;
}

const MIN = 60_000;

describe('audit: idle closure', () => {
  it('an empty Blackjack table closes 3:00 after the last player left, not before (verified)', async () => {
    const h = harness();
    const alice = player(h, 'Alice');
    const id = await openTable(h, alice);
    h.clock.advance(MIN);
    await h.app.blackjack.leave(id, alice.id); // activity: the table became empty now
    h.clock.advance(3 * MIN - 1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    h.clock.advance(1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([id]);
  });

  it('an occupied idle Blackjack table closes at 5:00, and spectators, renders and lobby syncs do not keep it alive (verified)', async () => {
    const h = harness();
    await h.boot();
    const alice = player(h, 'Alice');
    const bob = player(h, 'Bob'); // a spectator, never seated
    const id = await openTable(h, alice);
    const seatedAt = h.app.blackjack.peek(id)!.record.lastActivityAt;
    h.clock.advance(4 * MIN);
    const panel = h.tablePanel(id);
    for (const customId of [`bj:rules:${id}`, `bj:seat:${id}`, `bj:leave:${id}`, `bj:clear:${id}`, `bj:deal:${id}:x`, `bj:act:${id}:hit:0`]) {
      const rec = h.fd.clickRaw(bob, panel, customId); // rejected or read-only for a spectator
      await h.settle();
      expect(rec.ackedAt, customId).not.toBeNull(); // the router really handled it
      expect(rec.errors, customId).toEqual([]);
    }
    h.app.blackjack.touchAll();
    h.bot.refreshIdleTable(id);
    await h.bot.syncLobby(h.guildId);
    await h.settle();
    expect(h.app.blackjack.peek(id)!.record.lastActivityAt).toBe(seatedAt);
    expect(h.db.get<{ t: number }>('SELECT last_activity_at AS t FROM game_tables WHERE id = ?', [id])!.t).toBe(seatedAt);
    h.clock.advance(MIN - 1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    h.clock.advance(1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([id]);
    // Positive control: a seated player's own action does count as activity.
    const other = await openTable(h, bob);
    const openedAt = h.app.blackjack.peek(other)!.record.lastActivityAt;
    h.clock.advance(4 * MIN);
    h.fd.clickRaw(bob, h.tablePanel(other), `bj:sit:${other}:1`);
    await h.settle();
    expect(h.app.blackjack.peek(other)!.record.lastActivityAt).toBe(openedAt + 4 * MIN);
  });

  it('pending bets and an active hand keep a Blackjack table open indefinitely (verified)', async () => {
    const h = harness();
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const betting = await openTable(h, alice);
    await h.app.blackjack.placeBet(betting, alice.id, 100);
    const playing = await openTable(h, bob);
    await h.app.blackjack.placeBet(playing, bob.id, 100);
    await h.advance(ALL_IN_DEAL_DELAY_MS); // both deal; keep whichever reached 'playing'
    const active = [betting, playing].filter((id) => h.app.blackjack.peek(id)!.state.phase !== 'betting');
    expect(active.length).toBeGreaterThan(0);
    h.clock.advance(6 * 3600_000); // timers not run: a stalled hand
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    for (const id of active) expect(h.app.blackjack.peek(id)).toBeDefined();
  });

  it('a betting table with an open bet never idle-closes, even with its deal timer stalled (verified)', async () => {
    const h = harness();
    const alice = player(h, 'Alice');
    const id = await openTable(h, alice);
    await h.app.blackjack.placeBet(id, alice.id, 100);
    h.clock.advance(6 * 3600_000);
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(100);
  });

  it('a Hold’em hand in progress is never idle-closed; between hands the stacks are refunded at 5:00 (verified)', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const table = await h.app.poker.create({ guildId: h.guildId, userId: alice.id, name: 'Alice', buyIn: 200 });
    const id = table.record.id;
    await h.app.poker.join(id, bob.id, 'Bob', 200);
    await h.app.poker.start(id, alice.id, h.app.poker.peek(id)!.record.version);
    h.clock.advance(6 * 3600_000);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(id)?.state.hand).toBeTruthy();
    await h.app.poker.close(id, 'voided by an admin');
    const again = await h.app.poker.create({ guildId: h.guildId, userId: alice.id, name: 'Alice', buyIn: 200 });
    h.clock.advance(5 * MIN - 1);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(again.record.id)).toBeDefined();
    h.clock.advance(1);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(again.record.id)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  // The sweep is a real timer started in onReady — not driven by the game clock. The first sweep
  // runs 5 s after ready, then every 60 s, so a table that crosses its threshold closes within
  // one interval (empty: 3:00–4:00, occupied: 5:00–6:00 after the last activity).
  it('idle sweeps run 5 s after ready and then on the 60 s maintenance interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const h = harness();
      expect(h.bot.timing.firstSweepMs).toBe(5_000);
      expect(MAINTENANCE_INTERVAL_MS).toBe(60_000);
      await h.boot();
      const alice = player(h, 'Alice');
      const id = await openTable(h, alice);
      await h.app.blackjack.leave(id, alice.id);
      h.clock.advance(3 * MIN); // past the empty threshold
      await h.settle();
      vi.advanceTimersByTime(59_999);
      await h.settle();
      expect(h.app.blackjack.peek(id)).toBeDefined(); // still open: no sweep has run yet
      vi.advanceTimersByTime(1);
      await h.settle();
      expect(h.app.blackjack.peek(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
