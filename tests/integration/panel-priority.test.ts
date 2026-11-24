/**
 * The newest playable state always wins the table panel: a change that arrives without a click on
 * the panel (a hit from the private My hand view) cuts an older animation's hold short, and an
 * animation that has already been overtaken is never encoded or shown.
 */
import { afterEach, expect, it } from 'vitest';
import type { Card } from '../../src/games/cards.js';
import { ALL_IN_DEAL_DELAY_MS, SOLO_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import type { TimelineEntry } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

const kinds = (entries: TimelineEntry[]) => entries.map((e) => (e.image?.filename.endsWith('.gif') ? 'gif' : e.image ? 'png' : 'none'));

it('a hit from the private view interrupts the previous card animation instead of queueing behind it', async () => {
  h = new CasinoHarness({ timing: 'real', allowThreads: true });
  h.fd.recording = true;
  h.fd.latencyMs = 60;
  const alex = h.user('Alex');
  await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Games');
  const home = h.seen(await h.slash(alex, 'casino'))!;
  await h.click(alex, home, 'Games');
  await h.click(alex, home, 'Blackjack');
  const opener = await h.click(alex, home, 'Open a Blackjack table');
  await h.submit(alex, opener, { name: 'Priority', visibility: 'public' });
  const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
  const panelId = h.tablePanel(tableId).id;
  // Alex 2+3 vs dealer 9 (7 in the hole); hits draw 2 then 4.
  await h.app.blackjack.debugSetShoe(tableId, ['2S', '9C', '3D', '7H', '2C', '4C', '5H'] as Card[]);
  await h.click(alex, h.tablePanel(tableId), '25');
  await h.advance(ALL_IN_DEAL_DELAY_MS);
  const privateView = h.seen(await h.click(alex, h.tablePanel(tableId), 'My hand'))!;
  h.fd.timeline.length = 0;
  // First hit from the private view: the table's card GIF goes up and is held for its length, and
  // the private view refreshes in place (with the next action's controls).
  const first = h.fd.click(alex, privateView, 'Hit');
  for (let i = 0; i < 150 && !(h.fd.timeline.some((e) => e.messageId === panelId) && first.callbacks.includes(7)); i++) await new Promise((r) => setTimeout(r, 20));
  const firstShownAt = Date.now();
  // Second hit, again from the private view: no click on the panel, but it must not wait out the hold.
  const second = h.fd.click(alex, privateView, 'Hit');
  await h.settle();
  expect(first.errors).toEqual([]);
  expect(second.errors).toEqual([]);
  const frames = h.fd.timeline.filter((e) => e.messageId === panelId);
  // Two card animations and one final still: the first card's own still was superseded.
  expect(kinds(frames)).toEqual(['gif', 'gif', 'png']);
  const secondGifAt = frames[1]!.at;
  expect(secondGifAt - firstShownAt).toBeLessThan(700); // well inside the first GIF's ~1.2 s hold
  expect(h.app.blackjack.peek(tableId)!.state.round!.seats[0]!.hands[0]!.cards).toHaveLength(4);
  expect(h.fd.problems).toEqual([]);
}, 30_000);

it('a solo player is dealt shortly after their bet, a table with others waits a little longer', async () => {
  h = new CasinoHarness();
  const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
  await h.app.blackjack.createTable({ guildId: h.guildId, ownerId: alex.id, ownerName: 'Alex', feltId: 'emerald', cardBackId: 'emerald' });
  const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
  h.app.economy.ensurePlayer(h.guildId, alex.id, 'Alex');
  await h.app.blackjack.placeBet(tableId, alex.id, 25, 'Alex');
  expect(h.app.blackjack.peek(tableId)!.state.deadline).toBe(h.clock.now() + SOLO_DEAL_DELAY_MS);
  // With a second seat at the table, "everyone is in" uses the longer multiplayer beat.
  await h.app.blackjack.clearBet(tableId, alex.id);
  h.app.economy.ensurePlayer(h.guildId, hanna.id, 'Hanna');
  await h.app.blackjack.join(tableId, hanna.id, 'Hanna');
  await h.app.blackjack.placeBet(tableId, alex.id, 25, 'Alex');
  await h.app.blackjack.placeBet(tableId, hanna.id, 25, 'Hanna');
  expect(h.app.blackjack.peek(tableId)!.state.deadline).toBe(h.clock.now() + ALL_IN_DEAL_DELAY_MS);
});
