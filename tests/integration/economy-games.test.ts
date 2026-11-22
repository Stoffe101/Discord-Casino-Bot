/**
 * Economy and the other games through the Discord surface: claims, duplicate clicks, insufficient
 * funds, slots, roulette and coinflip (accept / decline / cancel / expiry), all reconciled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents, type FakeMessage } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

const healthy = () => {
  expect(h.app.economy.reconcile()).toEqual([]);
  expect(h.fd.problems).toEqual([]);
  expect(h.guard!.blockedCount).toBe(0);
  expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM escrows WHERE status = 'held'")!.n).toBe(0);
};
const ledgerCount = (userId: string, type: string) => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND type = ?', [userId, type])!.n;

describe('economy through Discord', () => {
  it('claims the daily reward once, even when the button is double-clicked', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const home = h.seen(await h.slash(alice, 'casino'))!;
    expect(h.enabled(home)).toContain('Daily 250');
    h.fd.click(alice, home, 'Daily 250');
    h.fd.click(alice, home, 'Daily 250');
    await h.settle();
    expect(ledgerCount(alice.id, 'daily_reward')).toBe(1);
    expect(h.balance(alice)).toBe(1250 + h.db.get<{ n: number }>("SELECT COALESCE(SUM(amount),0) AS n FROM ledger WHERE user_id = ? AND type IN ('achievement_reward','mission_reward')", [alice.id])!.n);
    // The refreshed home screen now shows the countdown instead.
    const after = h.seen(await h.slash(alice, 'casino'))!;
    expect(h.buttons(after).find((b) => b.label?.startsWith('Daily in'))?.disabled).toBe(true);
    healthy();
  });

  it('accrues passive income by the hour, capped at 24 hours', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    await h.slash(alice, 'casino');
    await h.advance(3 * 3600_000);
    let home = h.seen(await h.slash(alice, 'casino'))!;
    expect(h.enabled(home)).toContain('Collect 150');
    await h.click(alice, home, 'Collect 150');
    expect(ledgerCount(alice.id, 'passive_income')).toBe(1);
    await h.advance(72 * 3600_000);
    home = h.seen(await h.slash(alice, 'casino'))!;
    expect(h.enabled(home)).toContain('Collect 1,200');
    healthy();
  });

  it('refuses a bet larger than the wallet with a helpful private message', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    h.app.settings.set(h.guildId, 'economy.startingBalance', 50);
    const home = h.seen(await h.slash(alice, 'casino'))!;
    await h.click(alice, home, 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record.id;
    const rec = await h.click(alice, h.tablePanel(tableId), '100');
    const notice = h.seen(rec)!;
    expect(notice.forUser).toBe(alice.id);
    expect(h.text(notice)).toMatch(/chips/i);
    expect(h.enabled(notice)).toContain('Open wallet');
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(0);
    healthy();
  });
});

describe('other games through Discord', () => {
  async function gamesHub(user: ReturnType<CasinoHarness['user']>): Promise<FakeMessage> {
    const home = h.seen(await h.slash(user, 'casino'))!;
    return h.seen(await h.click(user, home, 'More Games'))!;
  }

  it('spins the slots and ignores a duplicate spin click', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const machine = h.seen(await h.click(alice, await gamesHub(alice), 'Play slots'))!;
    const spin = h.buttons(machine).find((b) => b.label?.startsWith('Spin'))!;
    h.fd.click(alice, machine, spin.label!);
    h.fd.click(alice, machine, spin.label!);
    await h.settle();
    expect(h.app.slots.spinCount(h.guildId, alice.id)).toBe(1);
    expect(machine.attachments.length).toBe(1);
    healthy();
  });

  it('runs a shared roulette wheel: select → modal → spin → payout', async () => {
    h = new CasinoHarness();
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    const opened = await h.click(alice, await gamesHub(alice), 'Open the wheel');
    expect(opened.errors).toEqual([]);
    const wheel = h.app.roulette.wheelFor(h.guildId)!;
    const panel = () => h.fd.messages.get(h.app.roulette.peek(wheel.record.id)!.record.messageId!)!;
    expect(panel().channelId).toBe(h.casino);
    const betSelect = findComponents(panel().components, 3)[0]!;
    const types = betSelect.options.map((o: { value: string }) => o.value);
    expect(types).toEqual(expect.arrayContaining(['red', 'black', 'straight']));
    const a1 = await h.select(alice, panel(), betSelect.custom_id, ['red']);
    await h.submit(alice, a1, { amount: '50' });
    const b1 = await h.select(bob, panel(), betSelect.custom_id, ['straight']);
    await h.submit(bob, b1, { number: '17', amount: '20' });
    expect(h.app.roulette.peek(wheel.record.id)!.state.bets).toHaveLength(2);
    await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 + 500);
    await h.app.roulette.idle();
    await h.settle();
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE game = 'roulette' AND status = 'settled'")!.n).toBe(1);
    expect(h.text(panel())).toMatch(/Spin 2|won|lost/);
    healthy();
  });

  it('plays coinflip duels: accept pays the winner, decline/cancel/expiry refund', async () => {
    h = new CasinoHarness();
    const [alice, bob, carol] = [h.user('Alice'), h.user('Bob'), h.user('Carol')];
    const challenge = async (from: typeof alice, to: typeof bob, amount: string) => {
      const pick = await h.select(from, await gamesHub(from), 'cf:pick', [to.id]);
      expect(pick.modal).not.toBeNull();
      const sent = await h.submit(from, pick, { amount, call: 'heads' });
      expect(sent.errors).toEqual([]);
      return h.seen(sent)!;
    };
    // Accept.
    const card = await challenge(alice, bob, '100');
    expect(card.forUser).toBeNull(); // a public card in #casino
    expect(card.channelId).toBe(h.casino);
    const intruder = await h.click(carol, card, /^Accept/);
    expect(h.text(h.seen(intruder))).toMatch(/not|only|challenge/i);
    await h.click(bob, card, /^Accept/);
    const flips = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE game = 'coinflip' AND status = 'settled'")!.n;
    expect(flips).toBe(1);
    expect(h.buttons(card).some((b) => b.label?.startsWith('Accept'))).toBe(false);
    // Decline and cancel refund the challenger's stake.
    const before = h.balance(alice);
    await h.click(bob, await challenge(alice, bob, '50'), 'Decline');
    await h.click(alice, await challenge(alice, bob, '50'), 'Cancel');
    expect(h.balance(alice)).toBe(before);
    // Expiry refunds too.
    await challenge(alice, carol, '75');
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(75);
    await h.advance(60 * 60_000);
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(0);
    expect(h.balance(alice)).toBe(before);
    healthy();
  });
});
