/**
 * Two servers on one bot (production mode, no test-mode guard): wallets, tables and controls stay
 * separate, and custom ids copied from another server's message are refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';
import { FakeDiscord } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

describe('multiple servers', () => {
  it('keeps wallets and tables per server and refuses cross-server controls', async () => {
    const fd = new FakeDiscord();
    const a = fd.addGuild('Server A');
    fd.addChannel(a, 'casino');
    fd.addChannel(a, 'general');
    const b = fd.addGuild('Server B');
    const bCasino = fd.addChannel(b, 'casino');
    h = new CasinoHarness({ discord: fd, guard: false });
    // Tables open only in a server's configured casino channel.
    await h.slash(h.user('Admin B', true), 'casinoadmin', { subcommand: 'setup' }, bCasino);
    const alice = h.user('Alice');

    // Alice plays in both servers: two independent wallets.
    const homeA = h.seen(await h.slash(alice, 'casino'))!;
    await h.click(alice, homeA, 'Daily 100');
    await h.openBlackjack(alice, null, bCasino);
    expect(h.app.economy.getWallet(a, alice.id).balance).toBeGreaterThanOrEqual(600);
    expect(h.app.economy.getWallet(b, alice.id).balance).toBeLessThan(600);

    // Server B's table panel was posted in server B (a thread, since threads are on in production).
    const tableB = h.app.blackjack.tableOfUser(b, alice.id)!;
    expect(tableB.record.guildId).toBe(b);
    expect(h.fd.channels.get(tableB.record.threadId!)?.guildId).toBe(b);

    // A forged button in server A pointing at server B's table is refused.
    const bob = h.user('Bob');
    const forged = h.fd.clickRaw(bob, homeA, `bj:bet:${tableB.record.id}:25`);
    await h.settle();
    expect(h.text(h.seen(forged))).toMatch(/closed/i);
    expect(h.app.blackjack.peek(tableB.record.id)!.state.seats.map((s) => s.userId)).toEqual([alice.id]);
    expect(h.app.economy.reconcile()).toEqual([]);
    expect(h.fd.problems).toEqual([]);
  });
});
