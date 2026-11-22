/**
 * Regressions for what live play on Discord showed (round 5): countdowns that read "1 seconds ago"
 * while the deal was on its way, a private view that told the result before the dealer's turn had
 * played on the table, a timed-out hand with no trace in the results, a slot machine that showed
 * an old spin as if it had just happened, and a Collect button with no confirmation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { COUNTDOWN_CUTOFF_MS } from '../../src/core/format.js';
import type { Card } from '../../src/games/cards.js';
import { ALL_IN_DEAL_DELAY_MS, TURN_GRACE_MS } from '../../src/tables/blackjack-table-service.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

const RELATIVE = /<t:\d+:R>/;

async function soloTable(shoe: string[]) {
  const alex = h.user('Alex');
  await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
  const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
  await h.app.blackjack.debugSetShoe(tableId, shoe as Card[]);
  return { alex, tableId };
}

describe('countdowns never outlive their deadline', () => {
  it('blackjack betting: the live countdown gives way to "dealing now" shortly before the deal', async () => {
    h = new CasinoHarness();
    const { alex, tableId } = await soloTable(['TS', '9C', '8D', '8H']);
    const hanna = h.user('Hanna');
    await h.click(hanna, h.tablePanel(tableId), 'Take a seat'); // seated but undecided: the full window runs
    await h.click(alex, h.tablePanel(tableId), '25');
    expect(h.text(h.tablePanel(tableId))).toMatch(/dealing <t:\d+:R>/);
    const windowMs = h.app.settings.get(h.guildId).blackjack.bettingSeconds * 1000;
    await h.advance(windowMs - COUNTDOWN_CUTOFF_MS + 50);
    expect(h.text(h.tablePanel(tableId))).toContain('dealing now…');
    expect(h.text(h.tablePanel(tableId))).not.toMatch(RELATIVE);
    await h.advance(COUNTDOWN_CUTOFF_MS);
    expect(h.text(h.tablePanel(tableId))).toContain('Alex to act');
    expect(h.fd.problems).toEqual([]);
  });

  it('when everyone is in, the short wait shows no countdown at all', async () => {
    h = new CasinoHarness();
    const { alex, tableId } = await soloTable(['TS', '9C', '8D', '8H']);
    await h.click(alex, h.tablePanel(tableId), '25');
    expect(ALL_IN_DEAL_DELAY_MS).toBeLessThanOrEqual(COUNTDOWN_CUTOFF_MS);
    expect(h.text(h.tablePanel(tableId))).toContain('dealing now…');
    expect(h.text(h.tablePanel(tableId))).not.toMatch(RELATIVE);
  });

  it('turn timer: "time is nearly up" before it runs out, and the results say the hand timed out', async () => {
    h = new CasinoHarness();
    // Alex 10+8 = 18; dealer 9+8 = 17 stands.
    const { alex, tableId } = await soloTable(['TS', '9C', '8D', '8H', '2C']);
    await h.click(alex, h.tablePanel(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    expect(h.text(h.tablePanel(tableId))).toMatch(/decide <t:\d+:R>/);
    const turnMs = h.app.settings.get(h.guildId).blackjack.turnSeconds * 1000;
    await h.advance(turnMs - COUNTDOWN_CUTOFF_MS + 50);
    expect(h.text(h.tablePanel(tableId))).toContain('time is nearly up');
    expect(h.text(h.tablePanel(tableId))).not.toMatch(RELATIVE);
    await h.advance(COUNTDOWN_CUTOFF_MS + TURN_GRACE_MS);
    const results = h.text(h.tablePanel(tableId));
    expect(results).toContain('Hand 1 · results');
    expect(results).toMatch(/Alex won \*\*25\*\* · 18 · ran out of time/);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('roulette: "spinning now" replaces the countdown before the spin', async () => {
    h = new CasinoHarness();
    const alex = h.user('Alex');
    const hub = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino'))!, 'More Games'))!;
    await h.click(alex, hub, 'Open the wheel');
    const wheel = h.app.roulette.wheelFor(h.guildId)!.record;
    const panel = () => h.fd.messages.get(h.app.roulette.peek(wheel.id)!.record.messageId!)!;
    const pick = findComponents(panel().components, 3)[0]!;
    await h.submit(alex, await h.select(alex, panel(), pick.custom_id, ['red']), { amount: '20' });
    expect(h.text(panel())).toMatch(/spinning <t:\d+:R>/);
    await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 - COUNTDOWN_CUTOFF_MS + 50);
    expect(h.text(panel())).toContain('spinning now — last bets!');
    expect(h.text(panel())).not.toMatch(RELATIVE);
  });
});

describe('My hand after the hand ends', () => {
  it("does not run ahead of the dealer's turn on the table, then shows how the hand went", async () => {
    h = new CasinoHarness({ allowThreads: true });
    const { alex, tableId } = await soloTable(['TS', '9C', '8D', '8H', '2C']);
    await h.click(alex, h.tablePanel(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    const view = h.seen(await h.click(alex, h.tablePanel(tableId), 'My hand'))!;
    expect(h.text(view)).toContain('Your turn');
    // Standing ends the hand; the table is still playing the dealer's turn when the view refreshes.
    const stand = await h.click(alex, view, 'Stand');
    expect(stand.original!.id).toBe(view.id);
    const during = h.text(view);
    expect(during).toContain("Dealer's turn");
    expect(during).toContain('10♠ 8♦ → **18**');
    expect(during).not.toMatch(/won|lost|Balance|17/);
    // Once the table has shown the result, Refresh tells it (and the seat menu is back).
    await h.click(alex, view, 'Refresh');
    const after = h.text(view);
    expect(after).toContain('Hand 1 · You won **25**');
    expect(after).toContain('Dealer stood on **17**');
    expect(after).toContain('Balance');
    expect(h.fd.problems).toEqual([]);
  });
});

describe('slots', () => {
  it('a reopened machine only mentions the last spin; a spin shows its result', async () => {
    h = new CasinoHarness();
    const alex = h.user('Alex');
    const hub = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino'))!, 'More Games'))!;
    const machine = h.seen(await h.click(alex, hub, 'Play slots'))!;
    expect(h.text(machine)).toContain('Pull the lever');
    await h.click(alex, machine, /^Spin/);
    expect(h.text(machine)).toMatch(/No win this time|\*\*\+\d/);
    expect(h.text(machine)).not.toContain('Pull the lever');
    // Changing the bet re-draws the machine: the old spin is history, not a fresh result.
    await h.click(alex, machine, '25');
    expect(h.text(machine)).toContain('Pull the lever');
    expect(h.text(machine)).toMatch(/Last spin: .* · bet 5/);
    expect(h.text(machine)).not.toContain('No win this time');
  });
});

describe('rewards', () => {
  it('collecting passive income says how much was collected', async () => {
    h = new CasinoHarness();
    const alex = h.user('Alex');
    await h.slash(alex, 'casino'); // first visit creates the player
    await h.advance(3 * 3_600_000);
    const home = h.seen(await h.slash(alex, 'casino'))!;
    const before = h.balance(alex);
    await h.click(alex, home, /^Collect/);
    const gained = h.balance(alex) - before;
    expect(gained).toBeGreaterThan(0);
    expect(h.text(home)).toContain(`✓ Collected ${gained} chip`);
  });
});
