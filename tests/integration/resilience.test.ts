/**
 * Restarts, message ordering and Discord failures, through the full stack.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { CasinoHarness } from '../harness/casino-harness.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'casino-resilience-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'casino.db');
}

describe('resilience through Discord', () => {
  it('resumes a hand after a crash on the same panel message, without duplicates', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ dbPath });
    // The crashed instance never shuts down; release its file handle once the test is over.
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const [alice, bob] = [first.user('Alice'), first.user('Bob')];
    const admin = first.user('Admin', true);
    await first.slash(admin, 'casinoadmin', { subcommand: 'setup' });
    await first.click(alice, first.seen(await first.slash(alice, 'casino')), 'Play Blackjack');
    const tableId = first.app.blackjack.tableOfUser(first.guildId, alice.id)!.record.id;
    await first.app.blackjack.debugSetShoe(tableId, ['TS', '9C', '7S', '6H', '8D', 'TD', '4C', '2H'] as Card[]);
    await first.click(alice, first.tablePanel(tableId), '100');
    await first.click(bob, first.tablePanel(tableId), '100');
    await first.advance(ALL_IN_DEAL_DELAY_MS);
    await first.click(alice, first.tablePanel(tableId), 'Hit'); // Alice 20
    const before = first.app.blackjack.peek(tableId)!.state.round!;
    const panelId = first.tablePanel(tableId).id;
    const publicMessages = first.fd.channelMessages(first.casino).length;
    // Crash: the process disappears without any shutdown work.
    const second = new CasinoHarness({ discord: first.fd, dbPath, clock: first.clock });
    cleanup.push(() => second.close());
    await second.boot();
    const after = second.app.blackjack.peek(tableId)!.state.round!;
    expect(after.seats.map((s) => s.hands.map((h) => h.cards))).toEqual(before.seats.map((s) => s.hands.map((h) => h.cards)));
    expect(second.tablePanel(tableId).id).toBe(panelId); // same message, edited in place
    expect(second.fd.channelMessages(second.casino).length).toBe(publicMessages); // nothing re-posted (lobby reused too)
    // Play continues from the same buttons.
    await second.click(alice, second.tablePanel(tableId), 'Stand');
    await second.click(bob, second.tablePanel(tableId), 'Stand');
    expect(second.app.blackjack.peek(tableId)!.state.phase).toBe('betting');
    expect(second.app.economy.reconcile()).toEqual([]);
    expect(second.fd.problems).toEqual([]);
  });

  it('never lets an older panel render overwrite a newer one under network latency', async () => {
    const h = new CasinoHarness();
    cleanup.push(() => h.close());
    h.fd.latencyMs = 60;
    const players = Array.from({ length: 5 }, (_, i) => h.user(`P${i}`));
    await h.click(players[0]!, h.seen(await h.slash(players[0]!, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, players[0]!.id)!.record.id;
    // Five bets land at once; renders overlap with in-flight edits.
    for (const [i, p] of players.entries()) h.fd.click(p, h.tablePanel(tableId), ['10', '25', '100', '250', '500'][i]!);
    await h.settle();
    const text = h.text(h.tablePanel(tableId));
    for (const p of players) expect(text).toContain(p.name);
    expect(Object.keys(h.app.blackjack.peek(tableId)!.state.bets)).toHaveLength(5);
    expect(text).toMatch(/Bets in: P0 \*\*10\*\* · P1 \*\*25\*\* · P2 \*\*100\*\* · P3 \*\*250\*\* · P4 \*\*500\*\*/);
  });

  it('recreates a table panel that was deleted from the channel', async () => {
    const h = new CasinoHarness();
    cleanup.push(() => h.close());
    const alice = h.user('Alice');
    await h.click(alice, h.seen(await h.slash(alice, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record.id;
    const original = h.tablePanel(tableId);
    original.deleted = true; // a moderator deleted the message
    // The next state change can't edit it, so a fresh panel is posted.
    await h.app.blackjack.placeBet(tableId, alice.id, 25);
    await h.settle();
    const replacement = h.tablePanel(tableId);
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.channelId).toBe(h.casino);
    expect(h.text(replacement)).toContain('Alice **25**');
  });

  it('keeps the table playable when Discord briefly fails panel edits', async () => {
    const h = new CasinoHarness();
    cleanup.push(() => h.close());
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await h.click(alice, h.seen(await h.slash(alice, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record.id;
    await h.click(alice, h.tablePanel(tableId), '25');
    await h.click(bob, h.tablePanel(tableId), '25');
    let failures = 0;
    h.fd.fault = (method, route) => (method === 'PATCH' && route.startsWith('/channels/') && failures++ < 3 ? { status: 500, body: { code: 0, message: 'Internal Server Error' } } : null);
    await h.advance(ALL_IN_DEAL_DELAY_MS); // the deal's panel edit fails (discord.js retries 500s)
    h.fd.fault = null;
    expect(h.app.blackjack.peek(tableId)!.state.phase).toBe('playing');
    // The next click repairs the panel through the interaction itself.
    const who = h.app.blackjack.peek(tableId)!.state.round!;
    const active = who.seats[who.turn!.seat]!.userId === alice.id ? alice : bob;
    const rec = await h.click(active, h.tablePanel(tableId), 'Stand');
    expect(rec.errors).toEqual([]);
    expect(h.app.economy.reconcile()).toEqual([]);
  });
});
