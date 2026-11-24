/**
 * Test mode with #casino child threads enabled — the mode the live bot runs in — through the
 * full stack: restarts, concurrent tables, roulette, background work and foreign threads.
 * Every scenario asserts that nothing was written outside #casino and its verified threads.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents } from '../harness/fake-discord.js';
import { driveTables } from '../harness/table-driver.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'casino-threads-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'casino.db');
}

/** Every write targets #casino, a thread whose parent is #casino, or an admitted interaction. */
function assertContained(h: CasinoHarness) {
  for (const r of h.fd.log) {
    if (r.method === 'GET') continue;
    const channel = /^\/channels\/(\d+)/.exec(r.route)?.[1];
    if (channel) {
      const c = h.fd.channels.get(channel)!;
      expect(channel === h.casino || c.parentId === h.casino, `${r.method} ${r.route}`).toBe(true);
    } else {
      expect(r.route.startsWith('/interactions/') || r.route.startsWith(`/webhooks/${h.fd.appId}/`), `${r.method} ${r.route}`).toBe(true);
    }
  }
}

describe('thread mode (full stack)', () => {
  it('resumes a hand after a crash: the thread is looked up, verified and the same message edited', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ allowThreads: true, dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const [alice, bob] = [first.user('Alice'), first.user('Bob')];
    await first.openBlackjack(alice);
    const tableId = first.app.blackjack.tableOfUser(first.guildId, alice.id)!.record.id;
    await first.app.blackjack.debugSetShoe(tableId, ['TS', '9C', '7S', '6H', '8D', 'TD', '4C', '2H'] as Card[]);
    await first.click(alice, first.tablePanel(tableId), '100');
    await first.click(bob, first.tablePanel(tableId), '100');
    await first.advance(ALL_IN_DEAL_DELAY_MS);
    await first.click(alice, first.tablePanel(tableId), 'Hit');
    const { threadId, messageId } = first.app.blackjack.peek(tableId)!.record;
    const threadMessages = first.fd.channelMessages(threadId!).length;
    // Crash, then a new process with an empty cache.
    const second = new CasinoHarness({ allowThreads: true, discord: first.fd, dbPath, clock: first.clock });
    cleanup.push(() => second.close());
    second.fd.log.length = 0;
    await second.boot();
    expect(second.guard!.knownThreads.has(threadId!)).toBe(true); // learned from Discord's lookup
    expect(second.app.blackjack.peek(tableId)!.record.messageId).toBe(messageId);
    expect(second.fd.log.some((r) => r.method === 'PATCH' && r.route === `/channels/${threadId}/messages/${messageId}`)).toBe(true);
    // Nothing re-posted in the thread (the only new message is the lobby, which test mode posts on boot).
    expect(second.fd.channelMessages(threadId!).length).toBe(threadMessages);
    expect(second.fd.log.some((r) => r.method === 'POST' && r.route === `/channels/${threadId}/messages`)).toBe(false);
    await second.click(alice, second.tablePanel(tableId), 'Stand');
    await second.click(bob, second.tablePanel(tableId), 'Stand');
    expect(second.app.blackjack.peek(tableId)!.state.phase).toBe('betting');
    expect(second.guard!.blockedCount).toBe(0);
    expect(second.app.economy.reconcile()).toEqual([]);
    assertContained(second);
  });

  it('runs 10 players on 2 tables concurrently, each in its own #casino thread', async () => {
    const h = harness({ seed: 31 });
    const report = await driveTables(h, { tables: 2, players: 5, rounds: 2 });
    expect(report.interactionErrors).toEqual([]);
    expect(report.lateAcks).toBe(0);
    expect(report.reconcile).toEqual([]);
    expect(report.conserved).toBe(true);
    expect(report.tableIsolation).toBe(true);
    expect(h.guard!.blockedCount).toBe(0);
    expect(h.guard!.knownThreads.size).toBe(2);
    expect(h.fd.channelMessages(h.casino)).toHaveLength(0);
    assertContained(h);
  }, 60_000);

  it('opens roulette in its own #casino thread and settles a spin', async () => {
    const h = harness();
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    const hub = h.seen(await h.click(alice, h.seen(await h.slash(alice, 'casino')), 'Games'))!;
    await h.click(alice, hub, 'Open the wheel');
    const record = h.app.roulette.wheelFor(h.guildId)!.record;
    expect(h.fd.channels.get(record.threadId!)?.parentId).toBe(h.casino);
    const panel = () => h.fd.messages.get(h.app.roulette.peek(record.id)!.record.messageId!)!;
    const select = findComponents(panel().components, 3)[0]!;
    await h.submit(alice, await h.select(alice, panel(), select.custom_id, ['red']), { amount: '50' });
    await h.submit(bob, await h.select(bob, panel(), select.custom_id, ['odd']), { amount: '30' });
    await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 + 500);
    await h.app.roulette.idle();
    await h.settle();
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE game = 'roulette' AND status = 'settled'")!.n).toBe(1);
    expect(h.fd.channelMessages(h.casino)).toHaveLength(0); // its thread notice was removed too
    expect(h.guard!.blockedCount).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
    assertContained(h);
  });

  it('keeps timeouts, settlement and the idle close inside #casino threads', async () => {
    const h = harness();
    const admin = h.user('Admin', true);
    await h.slash(admin, 'casinoadmin', { subcommand: 'setup' });
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await h.openBlackjack(alice);
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    await h.click(alice, h.tablePanel(record.id), '25');
    await h.click(bob, h.tablePanel(record.id), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    await h.advance(120_000); // nobody acts: both hands stand on timeout, dealer plays, hand settles
    await h.advance(120_000);
    expect(h.app.blackjack.peek(record.id)!.state.lastResult).not.toBeNull();
    // Everyone drifts away; the idle sweep closes the table and archives its thread.
    await h.app.blackjack.leave(record.id, alice.id);
    await h.app.blackjack.leave(record.id, bob.id);
    h.clock.advance(6 * 3600_000);
    await h.app.blackjack.sweepIdle();
    await h.settle();
    expect(h.app.blackjack.peek(record.id)).toBeUndefined();
    const thread = h.fd.channels.get(record.threadId!)!;
    expect(thread.archived && thread.locked).toBe(true);
    expect(h.lobby()?.channelId).toBe(h.casino);
    expect(h.guard!.blockedCount).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
    assertContained(h);
  });

  it('links leave and close to the lobby, archives a closed table without its panel, and refunds idle Hold’em seats', async () => {
    const h = harness();
    const host = h.user('Host', true);
    const guest = h.user('Guest');
    await h.slash(host, 'casinoadmin', { subcommand: 'setup' });
    const lobby = h.lobby()!;
    await h.openBlackjack(host);
    const table = h.app.blackjack.tableOfUser(h.guildId, host.id)!;
    const panel = h.tablePanel(table.record.id);
    await h.click(guest, panel, 'Take a seat');
    const receipt = h.seen(await h.click(guest, panel, 'Leave'))!;
    expect(h.buttons(receipt).find((button) => button.label === 'Return to casino')?.url).toBe('https://discord.com/channels/' + h.guildId + '/' + h.casino + '/' + lobby.id);
    const controls = h.seen(await h.click(host, panel, 'My seat'))!;
    panel.deleted = true;
    const closed = h.seen(await h.click(host, controls, 'Close table'))!;
    expect(h.buttons(closed).find((button) => button.label === 'Return to casino')?.url).toBe('https://discord.com/channels/' + h.guildId + '/' + h.casino + '/' + lobby.id);
    const closedThread = h.fd.channels.get(table.record.threadId!)!;
    expect(closedThread).toMatchObject({ archived: true, locked: true });

    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const poker = await h.app.poker.create({ guildId: h.guildId, userId: host.id, name: 'Host', buyIn: 100 });
    await h.bot.createTablePanel(poker.record.id, h.casino, host.id);
    await h.app.poker.join(poker.record.id, guest.id, 'Guest', 100);
    const threadId = h.app.poker.peek(poker.record.id)!.record.threadId!;
    h.clock.advance(5 * 60_000 - 1);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(poker.record.id)).toBeDefined();
    h.clock.advance(1);
    await h.app.poker.sweepIdle();
    await h.settle();
    expect(h.app.poker.peek(poker.record.id)).toBeUndefined();
    expect(h.fd.channels.get(threadId)).toMatchObject({ archived: true, locked: true });
    expect(h.app.economy.getWallet(h.guildId, host.id).reserved + h.app.economy.getWallet(h.guildId, guest.id).reserved).toBe(0);
    expect(h.fd.channelMessages(h.casino)).toHaveLength(1);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('never writes to a table thread under another channel; the table is re-homed under #casino', async () => {
    const dbPath = tempDb();
    // Session 1, no guard: someone plays from #general, so the table thread lives under #general.
    const before = new CasinoHarness({ guard: false, dbPath });
    const alice = before.user('Alice');
    await before.openBlackjack(alice, null, before.general);
    const tableId = before.app.blackjack.tableOfUser(before.guildId, alice.id)!.record.id;
    const foreign = before.app.blackjack.peek(tableId)!.record.threadId!;
    expect(before.fd.channels.get(foreign)?.parentId).toBe(before.general);
    await before.close();
    // Session 2 in thread test mode.
    const h = harness({ discord: before.fd, dbPath });
    h.fd.log.length = 0;
    await h.boot();
    expect(h.guard!.knownThreads.has(foreign)).toBe(false);
    expect(h.fd.log.some((r) => r.route.startsWith(`/channels/${foreign}`) && r.method !== 'GET')).toBe(false);
    const moved = h.app.blackjack.peek(tableId)!.record;
    expect(h.fd.channels.get(moved.threadId!)?.parentId).toBe(h.casino);
    expect(h.guard!.blockedCount).toBe(1); // the one refused edit in the foreign thread
    assertContained(h);
  });
});
