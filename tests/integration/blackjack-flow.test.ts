/**
 * Blackjack through the real Discord surface: players only press buttons that are visible and
 * enabled on the messages they can see. Every assertion about controls is made on the actual
 * component payload the bot sent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents, type FakeUser } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

async function openTable(host: FakeUser): Promise<string> {
  const home = h.seen(await h.slash(host, 'casino'));
  const rec = await h.openBlackjack(host, home);
  expect(rec.errors).toEqual([]);
  return h.app.blackjack.tableOfUser(h.guildId, host.id)!.record.id;
}

const panelOf = (tableId: string) => h.tablePanel(tableId);
const button = (tableId: string, label: string) => h.buttons(panelOf(tableId)).find((b) => b.label === label);
const rewardsOf = (u: FakeUser) =>
  h.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE guild_id = ? AND user_id = ? AND type IN ('achievement_reward', 'mission_reward')", [h.guildId, u.id])!.n;
const turnOf = (tableId: string) => {
  const s = h.app.blackjack.peek(tableId)!.state;
  return s.round?.turn ? s.round.seats[s.round.turn.seat]!.userId : null;
};

describe('blackjack via the Discord panel', () => {
  it('plays a two-player hand: dynamic controls, wrong-turn clicks, stale and double clicks', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const bob = h.user('Bob');
    const tableId = await openTable(alice);
    expect(panelOf(tableId).channelId).toBe(h.casino);
    // Alice 10+6, Bob 9+2, dealer 7 up / 10 hole; then Alice draws 4 (20), Bob doubles into 9 (20).
    await h.app.blackjack.debugSetShoe(tableId, ['TS', '9C', '7S', '6H', '2D', 'TD', '4C', '9H'] as Card[]);

    // Bob is standing at the rail: pressing a chip seats him and bets.
    const bobBet = await h.click(bob, panelOf(tableId), '25');
    expect(bobBet.errors).toEqual([]);
    expect(bobBet.callbacks).toEqual([7]); // the click updated the panel in place
    await h.click(alice, panelOf(tableId), '100');
    expect(h.text(panelOf(tableId))).toContain('Bets in: Alice **100** · Bob **25**');
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(100);

    await h.advance(ALL_IN_DEAL_DELAY_MS);
    expect(h.app.blackjack.peek(tableId)!.state.phase).toBe('playing');
    expect(turnOf(tableId)).toBe(alice.id);
    // Only legal actions are enabled; chips are gone while a hand is in play.
    expect(h.enabled(panelOf(tableId))).toEqual(expect.arrayContaining(['Hit', 'Stand', 'Double']));
    expect(button(tableId, 'Split')?.disabled).toBe(true);
    expect(button(tableId, '25')).toBeUndefined();
    expect(h.text(panelOf(tableId))).toContain('Alice to act');

    // Bob presses Alice's Hit: private refusal, nothing changes.
    const wrong = await h.click(bob, panelOf(tableId), 'Hit');
    expect(wrong.callbacks).toEqual([4]);
    expect(h.seen(wrong)!.forUser).toBe(bob.id);
    expect(h.text(h.seen(wrong))).toMatch(/turn/i);
    expect(turnOf(tableId)).toBe(alice.id);

    // Alice hits (20). Keep the Stand button's id from this render to replay it later.
    await h.click(alice, panelOf(tableId), 'Hit');
    expect(h.text(panelOf(tableId))).toContain('**20**');
    const staleStand = button(tableId, 'Stand')!.custom_id!;

    // A double click on Stand: two interactions arrive before either is handled.
    h.fd.click(alice, panelOf(tableId), 'Stand');
    h.fd.click(alice, panelOf(tableId), 'Stand');
    await h.settle();
    expect(turnOf(tableId)).toBe(bob.id);
    const handsAfter = h.app.blackjack.peek(tableId)!.state.round!.seats.find((s) => s.userId === bob.id)!.hands;
    expect(handsAfter[0]!.cards).toHaveLength(2); // Bob was not affected by the duplicate click

    // Replaying the old Stand button later fails safely.
    const replay = h.fd.clickRaw(alice, panelOf(tableId), staleStand);
    await h.settle();
    expect(h.text(h.seen(replay))).toMatch(/already|out of date|turn/i);
    expect(turnOf(tableId)).toBe(bob.id);

    // Bob doubles: Double is enabled for him; the hand ends and the dealer stands on 17.
    expect(h.enabled(panelOf(tableId))).toContain('Double');
    await h.click(bob, panelOf(tableId), 'Double');
    const state = h.app.blackjack.peek(tableId)!.state;
    expect(state.phase).toBe('betting');
    expect(state.lastResult!.seats.map((s) => [s.displayName, s.net])).toEqual([
      ['Alice', 100],
      ['Bob', 50],
    ]);
    // Results are on the panel; turn controls are gone and chips are back.
    expect(h.text(panelOf(tableId))).toContain('results');
    expect(button(tableId, 'Hit')).toBeUndefined();
    expect(h.enabled(panelOf(tableId))).toEqual(expect.arrayContaining(['10', '25', 'Rebet']));
    // Balance = start + game result + any achievement/mission rewards credited along the way.
    const start = h.app.settings.get(h.guildId).economy.startingBalance;
    expect(h.balance(alice)).toBe(start + 100 + rewardsOf(alice));
    expect(h.balance(bob)).toBe(start + 50 + rewardsOf(bob));
    expect(h.app.economy.reconcile()).toEqual([]);
    expect(h.fd.problems).toEqual([]);
    expect(h.guard!.blockedCount).toBe(0);
  });

  it('splits, surrenders and pays a natural through the panel', async () => {
    h = new CasinoHarness();
    const [a, b, c] = [h.user('Ana'), h.user('Ben'), h.user('Cleo')];
    const tableId = await openTable(a);
    // Ana 8,8 → split → 8+3 and 8+9 · Ben 10+6 vs dealer 10 → surrender · Cleo A+K natural; dealer 10+7.
    // Deal order: Ana, Ben, Cleo, dealer up; Ana, Ben, Cleo, dealer hole; then draws.
    await h.app.blackjack.debugSetShoe(tableId, ['8S', 'TC', 'AH', 'TD', '8H', '6C', 'KS', '7D', '3C', '9C'] as Card[]);
    for (const [u, amount] of [[a, '100'], [b, '100'], [c, '100']] as const) await h.click(u, panelOf(tableId), amount);
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    expect(turnOf(tableId)).toBe(a.id);
    expect(button(tableId, 'Split')).toBeDefined();
    expect(button(tableId, 'Split')!.disabled ?? false).toBe(false);
    await h.click(a, panelOf(tableId), 'Split');
    expect(h.text(panelOf(tableId))).toContain('hand 1 of 2');
    await h.click(a, panelOf(tableId), 'Stand'); // 8+3 = 11
    await h.click(a, panelOf(tableId), 'Stand'); // 8+9 = 17
    expect(turnOf(tableId)).toBe(b.id);
    expect(button(tableId, 'Surrender')).toBeDefined();
    expect(button(tableId, 'Surrender')!.disabled ?? false).toBe(false);
    await h.click(b, panelOf(tableId), 'Surrender');
    const result = h.app.blackjack.peek(tableId)!.state.lastResult!;
    const net = Object.fromEntries(result.seats.map((s) => [s.displayName, s.net]));
    // Dealer 17: Ana's 11 loses and her 17 pushes (−100), Ben gets half back, Cleo is paid 3:2.
    expect(net).toEqual({ Ana: -100, Ben: -50, Cleo: 150 });
    expect(h.text(panelOf(tableId))).toContain('A♥  K♠ → **Blackjack**');
    expect(h.app.economy.reconcile()).toEqual([]);
    expect(h.fd.problems).toEqual([]);
  });

  it('offers insurance on a dealer ace and settles it', async () => {
    h = new CasinoHarness();
    const [a, b] = [h.user('Ana'), h.user('Ben')];
    const tableId = await openTable(a);
    // Ana 10+9, Ben 10+7, dealer A up, K hole → dealer blackjack.
    await h.app.blackjack.debugSetShoe(tableId, ['TS', 'TC', 'AH', '9D', '7S', 'KD'] as Card[]);
    await h.click(a, panelOf(tableId), '100');
    await h.click(b, panelOf(tableId), '100');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    expect(h.app.blackjack.peek(tableId)!.state.phase).toBe('insurance');
    expect(h.enabled(panelOf(tableId))).toEqual(expect.arrayContaining(['Take insurance', 'No insurance']));
    await h.click(a, panelOf(tableId), 'Take insurance');
    await h.click(b, panelOf(tableId), 'No insurance');
    const result = h.app.blackjack.peek(tableId)!.state.lastResult!;
    const net = Object.fromEntries(result.seats.map((s) => [s.displayName, s.net]));
    expect(result.dealerBlackjack).toBe(true);
    expect(net).toEqual({ Ana: 0, Ben: -100 }); // insurance 50 pays 100, main bet −100
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('stands an absent player on timeout and sits them out after repeated misses', async () => {
    h = new CasinoHarness();
    const [a, b] = [h.user('Ana'), h.user('Ben')];
    const tableId = await openTable(a);
    const turnMs = h.app.settings.get(h.guildId).blackjack.turnSeconds * 1000 + 2_500;
    for (let hand = 0; hand < 2; hand++) {
      await h.click(a, panelOf(tableId), '10');
      await h.click(b, panelOf(tableId), '10');
      await h.advance(ALL_IN_DEAL_DELAY_MS);
      for (let i = 0; i < 4 && h.app.blackjack.peek(tableId)!.state.phase !== 'betting'; i++) {
        if (turnOf(tableId) === a.id) await h.click(a, panelOf(tableId), 'Stand');
        else await h.advance(turnMs); // Ben never acts
      }
    }
    const ben = h.app.blackjack.peek(tableId)!.state.seats.find((s) => s.userId === b.id)!;
    expect(ben.sittingOut).toBe(true);
    expect(h.text(panelOf(tableId))).toMatch(/Sitting out: Ben/);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('lets a player leave mid-hand: their hands stand and the seat frees afterwards', async () => {
    h = new CasinoHarness();
    const [a, b] = [h.user('Ana'), h.user('Ben')];
    const tableId = await openTable(a);
    await h.app.blackjack.debugSetShoe(tableId, ['TS', 'TC', '7H', '9D', '7S', 'TD'] as Card[]);
    await h.click(a, panelOf(tableId), '25');
    await h.click(b, panelOf(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    const leave = await h.click(b, panelOf(tableId), 'Leave');
    expect(h.text(h.seen(leave))).toMatch(/after this hand/);
    await h.click(a, panelOf(tableId), 'Stand');
    if (h.app.blackjack.peek(tableId)!.state.phase === 'playing') await h.advance(120_000);
    const state = h.app.blackjack.peek(tableId)!.state;
    expect(state.phase).toBe('betting');
    expect(state.seats.map((s) => s.userId)).toEqual([a.id]);
    expect(h.app.economy.getWallet(h.guildId, b.id).reserved).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('protects private tables and host-only controls', async () => {
    h = new CasinoHarness();
    const [host, guest, stranger] = [h.user('Host'), h.user('Guest'), h.user('Stranger')];
    const tables = h.seen(await h.slash(host, 'blackjack'));
    const opener = await h.click(host, tables, 'Open Blackjack');
    expect(opener.modal).not.toBeNull();
    const visibility = findComponents(opener.modal.components, 3).find((s) => s.custom_id === 'visibility')!;
    expect(visibility.options.map((o: { value: string }) => o.value)).toEqual(['public', 'private']);
    const created = await h.submit(host, opener, { name: 'Back Room', visibility: 'private' });
    expect(created.errors).toEqual([]);
    const tableId = h.app.blackjack.tableOfUser(h.guildId, host.id)!.record.id;
    const record = h.app.blackjack.peek(tableId)!.record;
    expect(record.isPrivate).toBe(true);
    // Chips don't seat strangers at a private table.
    const sneak = await h.click(stranger, panelOf(tableId), '25');
    expect(h.text(h.seen(sneak))).toMatch(/private table/i);
    // Take a seat asks for the code; a wrong code is refused, the right one seats the guest.
    const ask = await h.click(guest, panelOf(tableId), 'Take a seat');
    expect(ask.modal).not.toBeNull();
    const wrong = await h.submit(guest, ask, { code: 'WRONG' });
    expect(h.text(h.seen(wrong))).toMatch(/code/i);
    const ask2 = await h.click(guest, panelOf(tableId), 'Take a seat');
    await h.submit(guest, ask2, { code: record.accessCode! });
    expect(h.app.blackjack.peek(tableId)!.state.seats.map((s) => s.userId)).toContain(guest.id);
    // Only the host may deal early.
    await h.click(guest, panelOf(tableId), '25');
    const deal = await h.click(guest, panelOf(tableId), 'Deal now (host)');
    expect(h.text(h.seen(deal))).toMatch(/host/i);
    expect(h.app.blackjack.peek(tableId)!.state.phase).toBe('betting');
    expect(h.fd.problems).toEqual([]);
  });
});
