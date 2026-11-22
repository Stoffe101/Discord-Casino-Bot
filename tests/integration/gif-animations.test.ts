/**
 * Animated GIFs (production mode) and the private "My hand" view, through the full stack:
 * every animation is a GIF frame followed by a static PNG, controls never wait on it, and the
 * private view acts privately while the shared panel keeps up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { basicStrategy } from '../../src/games/blackjack/strategy.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents, type TimelineEntry } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

const kinds = (entries: TimelineEntry[]) => entries.map((e) => (e.image?.filename.endsWith('.gif') ? 'gif' : e.image ? 'png' : 'none'));
const isGif = (data: Uint8Array | undefined) => !!data && Buffer.from(data.slice(0, 6)).toString('latin1') === 'GIF89a';

describe('animated GIFs', () => {
  it('deals, draws and settles blackjack as GIFs, each followed by a static table', async () => {
    h = new CasinoHarness({ allowThreads: true, animations: true });
    h.fd.recording = true;
    const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
    await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
    const panelId = h.tablePanel(tableId).id;
    await h.app.blackjack.debugSetShoe(tableId, ['TS', '5C', '6D', '4H', '6S', 'TD', '3C', '2H', 'KD'] as Card[]);
    await h.click(alex, h.tablePanel(tableId), '25');
    await h.click(hanna, h.tablePanel(tableId), '25');
    h.fd.timeline.length = 0;
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    let frames = h.fd.timeline.filter((e) => e.messageId === panelId);
    expect(kinds(frames)).toEqual(['gif', 'png']); // deal animation, then the table
    expect(isGif(frames[0]!.image!.data)).toBe(true);
    expect(frames[0]!.text).toContain('Dealing hand 1');
    // A hit: the card flies in (GIF), then the still. The click itself carries the GIF.
    h.fd.timeline.length = 0;
    const hit = await h.click(alex, h.tablePanel(tableId), 'Hit');
    expect(hit.callbacks).toEqual([7]);
    frames = h.fd.timeline.filter((e) => e.messageId === panelId);
    expect(kinds(frames)).toEqual(['gif', 'png']);
    expect(frames[0]!.buttons.map((b) => b.label)).toContain('Stand'); // controls don't wait for the animation
    // Finish: the dealer's turn and the payout are one GIF, then the static results.
    await h.click(alex, h.tablePanel(tableId), 'Stand');
    h.fd.timeline.length = 0;
    await h.click(hanna, h.tablePanel(tableId), 'Stand');
    frames = h.fd.timeline.filter((e) => e.messageId === panelId);
    expect(kinds(frames)).toEqual(['gif', 'png']);
    expect(frames[0]!.text).toContain("Dealer's turn");
    expect(frames[0]!.text).not.toMatch(/won|lost|results/);
    expect(frames[1]!.text).toContain('results');
    expect(h.fd.problems).toEqual([]);
    expect(h.app.economy.reconcile()).toEqual([]);
  }, 30_000);

  it('spins roulette, slots and the coin as GIFs before the result', async () => {
    h = new CasinoHarness({ animations: true });
    h.fd.recording = true;
    const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
    const hub = async (u: typeof alex) => h.seen(await h.click(u, h.seen(await h.slash(u, 'casino'))!, 'More Games'))!;
    // Slots: the click answers with rolling reels, then the result.
    const machine = h.seen(await h.click(alex, await hub(alex), 'Play slots'))!;
    h.fd.timeline.length = 0;
    await h.click(alex, machine, h.buttons(machine).find((b) => b.label?.startsWith('Spin'))!.label!);
    expect(kinds(h.fd.timeline.filter((e) => e.messageId === machine.id))).toEqual(['gif', 'png']);
    // Roulette.
    await h.click(alex, await hub(alex), 'Open the wheel');
    const wheel = h.app.roulette.wheelFor(h.guildId)!.record;
    const panel = () => h.fd.messages.get(h.app.roulette.peek(wheel.id)!.record.messageId!)!;
    const select = findComponents(panel().components, 3)[0]!;
    await h.submit(alex, await h.select(alex, panel(), select.custom_id, ['red']), { amount: '20' });
    h.fd.timeline.length = 0;
    await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 + 500);
    await h.app.roulette.idle();
    await h.settle();
    expect(kinds(h.fd.timeline.filter((e) => e.messageId === panel().id))).toEqual(['gif', 'png']);
    // Coinflip.
    const card = h.seen(await h.submit(alex, await h.select(alex, await hub(alex), 'cf:pick', [hanna.id]), { amount: '25', call: 'tails' }))!;
    h.fd.timeline.length = 0;
    await h.click(hanna, card, /^Accept/);
    expect(kinds(h.fd.timeline.filter((e) => e.messageId === card.id))).toEqual(['gif', 'png']);
    expect(h.fd.problems).toEqual([]);
  }, 30_000);
});

describe('My hand (private view)', () => {
  it('shows your hand with a tip, acts privately, and keeps the table panel in step', async () => {
    h = new CasinoHarness({ allowThreads: true });
    const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
    await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
    // Alex 8,8 vs dealer 10 → basic strategy: split.
    await h.app.blackjack.debugSetShoe(tableId, ['8S', '9C', 'TD', '8H', '9H', '7C', '3D', '2S'] as Card[]);
    await h.click(alex, h.tablePanel(tableId), '25');
    await h.click(hanna, h.tablePanel(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    const open = await h.click(alex, h.tablePanel(tableId), 'My hand');
    const view = h.seen(open)!;
    expect(view.forUser).toBe(alex.id);
    expect(h.text(view)).toContain('8♠ 8♥ → **16**');
    expect(h.text(view)).toContain('Your turn');
    expect(h.text(view)).toMatch(/Basic strategy says \*\*Split\*\*/);
    expect(h.text(view)).toContain('Dealer shows 10♦');
    expect(view.attachments).toHaveLength(1);
    // Hanna's private view says she's waiting.
    const hView = h.seen(await h.click(hanna, h.tablePanel(tableId), 'My hand'))!;
    expect(h.text(hView)).toMatch(/waiting for \*\*Alex\*\*/);
    // Alex splits from the private view: it refreshes in place; the shared panel updates too.
    const split = await h.click(alex, view, 'Split');
    expect(split.callbacks).toEqual([7]);
    expect(split.original!.id).toBe(view.id);
    expect(h.text(view)).toContain('Hand 1');
    expect(h.text(h.tablePanel(tableId))).toContain('hand 1 of 2');
    expect(h.fd.problems).toEqual([]);
  });

  it.each([
    [['8S', '8H'], 'TD', 'split'],
    [['TS', '6H'], 'TD', 'surrender'],
    [['TS', '6H'], '5D', 'stand'],
    [['6S', '5H'], '9D', 'double'],
    [['AS', '7H'], '5D', 'double'],
    [['AS', '7H'], 'TD', 'hit'],
    [['TS', '2H'], '4D', 'stand'],
    [['TS', '7H'], 'AD', 'stand'],
  ] as const)('basic strategy: %s vs %s → %s', (cards, up, move) => {
    expect(basicStrategy([...cards] as Card[], up as Card, { double: true, split: true, surrender: true }).move).toBe(move);
  });

  it('only suggests moves that are available', () => {
    expect(basicStrategy(['6S', '5H', '2C'] as Card[], '9D' as Card, { double: false, split: false, surrender: false }).move).toBe('hit');
    expect(basicStrategy(['8S', '8H'] as Card[], 'TD' as Card, { double: false, split: false, surrender: false }).move).toBe('hit');
  });
});
