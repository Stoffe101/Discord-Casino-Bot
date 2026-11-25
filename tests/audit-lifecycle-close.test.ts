/**
 * Audit: leaving and closing tables — seat release, refunds, host transfer, close-exactly-once,
 * closed panels, and the Discord side of a close (lock + archive) across failures and restarts.
 *
 * Tests marked "Fixed bug" were written as failing reproductions during the lifecycle audit and
 * now guard the fixes.
 * Controls are pressed by custom id (clickRaw) so the tests survive the concurrent UI redesign.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from './harness/casino-harness.js';
import type { FakeMessage, FakeUser } from './harness/fake-discord.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function harness(options: ConstructorParameters<typeof CasinoHarness>[0] = {}): CasinoHarness {
  const h = new CasinoHarness({ allowThreads: true, ...options });
  cleanup.push(() => h.close());
  return h;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'casino-audit-close-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'casino.db');
}

const refused = { status: 403, body: { code: 50013, message: 'Missing Permissions' } };

/** A member who has visited the casino (has a wallet), as every real player has. */
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

async function press(h: CasinoHarness, user: FakeUser, message: FakeMessage, customId: string) {
  const rec = h.fd.clickRaw(user, message, customId);
  await h.settle();
  return rec;
}

describe('audit: closing tables', () => {
  // Fixed bug (was bot.ts closePanel + onReady): the lock/archive PATCH is attempted once; a
  // failure is only logged. SQLite already says 'closed', onReady only walks OPEN tables, so the
  // thread is never locked/archived — not by maintenance, not after a restart.
  it('a thread whose lock/archive failed at close is locked and archived after a restart', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ allowThreads: true, dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const alice = player(first, 'Alice');
    const id = await openTable(first, alice);
    const { threadId } = first.app.blackjack.peek(id)!.record;
    first.fd.fault = (method, route) => (method === 'PATCH' && route === `/channels/${threadId}` ? refused : null);
    await first.app.blackjack.closeTable(id, 'closed by the host', { actorId: alice.id });
    await first.settle();
    expect(first.db.get<{ status: string }>('SELECT status FROM game_tables WHERE id = ?', [id])!.status).toBe('closed');
    expect(first.fd.channels.get(threadId!)!.archived).toBe(false); // the failed archive (precondition)
    first.fd.fault = null; // Discord recovers
    await first.app.blackjack.sweepIdle(); // the next maintenance pass does nothing for closed tables
    const second = harness({ discord: first.fd, dbPath, clock: first.clock });
    await second.boot();
    // Accept a fix in onReady or in the periodic maintenance pass (private; called if present).
    const maintenance = (second.bot as unknown as { maintenance?: () => Promise<void> }).maintenance;
    if (maintenance) await maintenance.call(second.bot);
    await second.settle();
    expect(first.fd.channels.get(threadId!)).toMatchObject({ archived: true, locked: true });
  });

  // Fixed bug (was blackjack-table-service.ts removeSeat / join→seatPlayer): when the last player
  // leaves, ownerId keeps pointing at them; join never reassigns it (Hold'em's addSeat does).
  // The new occupant has no host controls, and the departed host can still close the table
  // under them with the "Close table" button of their old private seat view.
  it('a player who sits at an emptied Blackjack table becomes host; the departed host cannot close it', async () => {
    const h = harness({ allowThreads: false });
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const id = await openTable(h, alice);
    const controls = h.seen(await press(h, alice, h.tablePanel(id), `bj:seat:${id}`))!;
    expect(h.buttons(controls).some((b) => b.custom_id === `bj:close:${id}` && !b.disabled)).toBe(true);
    await h.app.blackjack.leave(id, alice.id);
    await h.app.blackjack.join(id, bob.id, 'Bob');
    await h.app.blackjack.placeBet(id, bob.id, 100);
    expect(h.app.blackjack.peek(id)!.record.ownerId).toBe(bob.id);
    await press(h, alice, controls, `bj:close:${id}`); // Alice's stale host control
    expect(h.app.blackjack.peek(id)).toBeDefined();
  });

  it('a failed lock/archive is retried by the next maintenance sweep and recorded as done', async () => {
    const h = harness();
    const alice = player(h, 'Alice');
    const id = await openTable(h, alice);
    const { threadId } = h.app.blackjack.peek(id)!.record;
    h.fd.fault = (method, route) => (method === 'PATCH' && route === `/channels/${threadId}` ? refused : null);
    await h.app.blackjack.closeTable(id, 'closed by the host', { actorId: alice.id });
    await h.settle();
    const marker = () => h.db.get<{ at: number | null }>('SELECT discord_closed_at AS at FROM game_tables WHERE id = ?', [id])!.at;
    expect(marker()).toBeNull();
    h.fd.fault = null;
    await (h.bot as unknown as { maintenance(): Promise<void> }).maintenance();
    await h.settle();
    expect(h.fd.channels.get(threadId!)).toMatchObject({ archived: true, locked: true });
    expect(marker()).not.toBeNull();
  });

  it('a closed table whose thread was deleted counts as closed (10003), and a normal close is recorded at once', async () => {
    const h = harness();
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const gone = await openTable(h, alice);
    const goneThread = h.app.blackjack.peek(gone)!.record.threadId!;
    h.fd.fault = (method, route) => (method === 'PATCH' && route === `/channels/${goneThread}` ? refused : null);
    await h.app.blackjack.closeTable(gone, 'closed by the host', { actorId: alice.id });
    await h.settle();
    h.fd.fault = null;
    h.fd.channels.delete(goneThread);
    h.bot.client.channels.cache.delete(goneThread);
    expect(await h.bot.reconcileClosedTables()).toBe(1);
    const fine = await openTable(h, bob);
    await h.app.blackjack.closeTable(fine, 'closed by the host', { actorId: bob.id });
    await h.settle();
    const marked = h.db.all<{ id: string }>('SELECT id FROM game_tables WHERE discord_closed_at IS NOT NULL').map((r) => r.id).sort();
    expect(marked).toEqual([gone, fine].sort());
    expect(await h.bot.reconcileClosedTables()).toBe(0);
  });

  it('closing finalizes once, refunds open bets, frees seats, retires controls, locks the thread and updates the lobby (verified)', async () => {
    const h = harness();
    await h.boot();
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const id = await openTable(h, alice);
    await h.app.blackjack.join(id, bob.id, 'Bob');
    const before = h.balance(alice) + h.balance(bob);
    await h.app.blackjack.placeBet(id, alice.id, 100);
    await h.app.blackjack.placeBet(id, bob.id, 50);
    const { threadId, messageId, name } = h.app.blackjack.peek(id)!.record;
    await h.settle();
    expect(h.text(h.lobby())).toContain(name);
    h.fd.log.length = 0;
    await Promise.all([
      h.app.blackjack.closeTable(id, 'closed by the host', { actorId: alice.id }),
      h.app.blackjack.closeTable(id, 'closed by an admin', { force: true }),
      h.app.blackjack.sweepIdle(),
    ]);
    await h.settle();
    expect(h.app.blackjack.peek(id)).toBeUndefined();
    expect(h.balance(alice) + h.balance(bob)).toBe(before);
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved + h.app.economy.getWallet(h.guildId, bob.id).reserved).toBe(0);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM table_seats WHERE table_id = ?', [id])!.n).toBe(0);
    expect(h.fd.log.filter((r) => r.method === 'PATCH' && r.route === `/channels/${threadId}`)).toHaveLength(1);
    expect(h.fd.channels.get(threadId!)).toMatchObject({ archived: true, locked: true });
    expect(h.enabled(h.fd.messages.get(messageId!)!)).toEqual([]); // only the "Return to casino" link remains
    expect(h.text(h.lobby())).not.toContain(name);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('leaving between rounds returns the open bet; the host seat passes to the next player (verified)', async () => {
    const h = harness({ allowThreads: false });
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const id = await openTable(h, alice);
    await h.app.blackjack.join(id, bob.id, 'Bob');
    const start = h.balance(alice);
    await h.app.blackjack.placeBet(id, alice.id, 100);
    expect(await h.app.blackjack.leave(id, alice.id)).toBe('left');
    expect(h.balance(alice)).toBe(start);
    expect(h.app.blackjack.peek(id)!.record.ownerId).toBe(bob.id);
    expect(h.app.blackjack.tableOfUser(h.guildId, alice.id)).toBeUndefined();
  });

  it('a forced Hold’em close during a hand voids it and returns the pre-hand stacks (verified)', async () => {
    const h = harness({ allowThreads: false });
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const before = h.balance(alice) + h.balance(bob);
    const table = await h.app.poker.create({ guildId: h.guildId, userId: alice.id, name: 'Alice', buyIn: 200 });
    const id = table.record.id;
    await h.app.poker.join(id, bob.id, 'Bob', 200);
    await h.app.poker.start(id, alice.id, h.app.poker.peek(id)!.record.version);
    expect(h.app.poker.peek(id)!.state.hand).not.toBeNull();
    await expect(h.app.poker.close(id, 'closed by the host', alice.id)).rejects.toThrow(/active hand/);
    await h.app.poker.close(id, 'voided by an admin');
    await h.settle();
    expect(h.app.poker.peek(id)).toBeUndefined();
    expect(h.balance(alice) + h.balance(bob)).toBe(before);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM table_seats WHERE table_id = ?', [id])!.n).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

});
