/**
 * Game feel: dealing, reveals, spins and flips arrive as a short sequence of frames, never leak
 * the outcome early, and keep controls out of reach until the result is final.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { parseChipAmount } from '../../src/core/format.js';
import { buildTableView } from '../../src/tables/table-view.js';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents, type TimelineEntry } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

const framesOf = (messageId: string): TimelineEntry[] => h.fd.timeline.filter((e) => e.messageId === messageId);

describe('blackjack animation frames', () => {
  it('deals in two passes, then reveals the dealer without spoiling the result', async () => {
    h = new CasinoHarness({ allowThreads: true });
    h.fd.recording = true;
    const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
    await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
    const panelId = h.tablePanel(tableId).id;
    // Alex 10+9, Hanna 10+7 · dealer 6 up, 10 hole, then draws 5 (21).
    await h.app.blackjack.debugSetShoe(tableId, ['TS', 'TC', '6D', '9H', '7S', 'TD', '5C'] as Card[]);
    await h.click(alex, h.tablePanel(tableId), '100');
    await h.click(hanna, h.tablePanel(tableId), '100');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    let frames = framesOf(panelId);
    const dealIndex = frames.findIndex((f) => f.text.includes('Dealing hand 1'));
    expect(dealIndex).toBeGreaterThan(-1);
    expect(frames[dealIndex]!.buttons.map((b) => b.label)).not.toContain('Hit'); // no controls mid-deal
    expect(frames.at(-1)!.text).toContain('Alex to act');
    expect(frames.at(-1)!.text).toContain('Hanna — 10♣ 7♠ **17**'); // every hand in the summary
    expect(frames.at(-1)!.text).toContain('dealer shows 6♦');

    await h.click(alex, h.tablePanel(tableId), 'Stand');
    await h.click(hanna, h.tablePanel(tableId), 'Stand');
    frames = framesOf(panelId);
    const reveal = frames.filter((f) => f.text.includes("Dealer's turn"));
    expect(reveal.length).toBeGreaterThanOrEqual(2); // hole card, then the drawn card
    for (const f of reveal) {
      expect(f.text).not.toMatch(/wins|won|lost|loses|results/); // no spoilers while cards turn
      expect(f.buttons.map((b) => b.label)).not.toContain('25'); // betting reopens only after
    }
    expect(frames.at(-1)!.text).toContain('Hand 1 · results');
    expect(h.app.economy.reconcile()).toEqual([]);
    expect(h.fd.problems).toEqual([]);
  });

  it('marks the card that just arrived', async () => {
    h = new CasinoHarness();
    const alex = h.user('Alex');
    await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
    await h.app.blackjack.debugSetShoe(tableId, ['5S', '9D', '4H', 'TD', '3C'] as Card[]);
    await h.click(alex, h.tablePanel(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    const rules = { blackjackPayout: { numerator: 3, denominator: 2 }, dealerHitsSoft17: false, insurance: true };
    expect(buildTableView(h.app.blackjack.peek(tableId)!, rules).seats[0]!.hands[0]!.fresh).toBeUndefined();
    await h.click(alex, h.tablePanel(tableId), 'Hit');
    expect(buildTableView(h.app.blackjack.peek(tableId)!, rules).seats[0]!.hands[0]!.fresh).toBe(2);
  });
});

describe('other game animations', () => {
  async function hub(user: ReturnType<CasinoHarness['user']>) {
    return h.seen(await h.click(user, h.seen(await h.slash(user, 'casino'))!, 'Games'))!;
  }

  it('slots: reels stop in turn, controls locked and balance unchanged until the result', async () => {
    h = new CasinoHarness();
    h.fd.recording = true;
    const alex = h.user('Alex');
    const machine = h.seen(await h.click(alex, await hub(alex), 'Play slots'))!;
    const before = h.balance(alex);
    const spin = h.buttons(machine).find((b) => b.label?.startsWith('Spin'))!;
    const rec = await h.click(alex, machine, spin.label!);
    expect(rec.errors).toEqual([]);
    const frames = framesOf(machine.id).slice(-3);
    expect(frames.map((f) => f.text.includes('Spinning…'))).toEqual([true, true, false]);
    for (const f of frames.slice(0, 2)) {
      expect(f.buttons.every((b) => b.disabled)).toBe(true);
      expect(f.text).toContain(`Balance **${(before - h.app.slots.lastSpin(h.guildId, alex.id)!.bet).toLocaleString('en-US')}**`);
    }
    expect(frames[2]!.buttons.find((b) => b.label.startsWith('Spin'))!.disabled).toBe(false);
  });

  it('roulette: "no more bets" frames come before the number is shown', async () => {
    h = new CasinoHarness();
    h.fd.recording = true;
    const alex = h.user('Alex');
    await h.click(alex, await hub(alex), 'Open the wheel');
    const record = h.app.roulette.wheelFor(h.guildId)!.record;
    const panel = () => h.fd.messages.get(h.app.roulette.peek(record.id)!.record.messageId!)!;
    const select = findComponents(panel().components, 3)[0]!;
    await h.submit(alex, await h.select(alex, panel(), select.custom_id, ['red']), { amount: 'half' });
    expect(h.app.roulette.peek(record.id)!.state.bets[0]!.amount).toBe(Math.min(500, Math.floor(1000 / 2)));
    await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 + 500);
    await h.app.roulette.idle();
    await h.settle();
    const frames = framesOf(panel().id);
    const spinning = frames.filter((f) => f.text.includes('No more bets') || f.text.includes('slowing down'));
    expect(spinning).toHaveLength(2);
    const number = h.app.roulette.peek(record.id)!.state.lastResult!.number;
    for (const f of spinning) expect(f.text).not.toMatch(new RegExp(`### .* ${number} ·`));
    expect(frames.at(-1)!.text).toMatch(new RegExp(`${number} ·`));
  });

  it('coinflip: the coin goes up before it lands', async () => {
    h = new CasinoHarness();
    h.fd.recording = true;
    const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
    const sent = await h.submit(alex, await h.select(alex, await hub(alex), 'cf:pick', [hanna.id]), { amount: '1k', call: 'heads' });
    const card = h.seen(sent)!;
    expect(h.app.economy.getWallet(h.guildId, alex.id).reserved).toBe(Math.min(1000, h.app.settings.get(h.guildId).coinflip.maxBet));
    await h.click(hanna, card, /^Accept/);
    const frames = framesOf(card.id);
    expect(frames.at(-2)!.text).toContain('in the air');
    expect(frames.at(-1)!.text).toMatch(/Heads!|Tails!/);
  });
});

describe('animation safety', () => {
  it('slots never stay stuck mid-spin when an animation edit fails', async () => {
    h = new CasinoHarness();
    const alex = h.user('Alex');
    const hubMessage = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino'))!, 'Games'))!;
    const machine = h.seen(await h.click(alex, hubMessage, 'Play slots'))!;
    // Every edit of the interaction's message fails (e.g. a network blip after the first frame).
    h.fd.fault = (method, route) => (method === 'PATCH' && route.startsWith('/webhooks/') ? { status: 500, body: { code: 0, message: 'boom' } } : null);
    const spin = h.buttons(machine).find((b) => b.label?.startsWith('Spin'))!;
    const rec = await h.click(alex, machine, spin.label!);
    h.fd.fault = null;
    // The final result still reached the player, with working controls.
    const final = h.seen(rec)!;
    expect(final.forUser).toBe(alex.id);
    expect(h.text(final)).not.toContain('Spinning…');
    expect(h.buttons(final).find((b) => b.label?.startsWith('Spin'))!.disabled ?? false).toBe(false);
  });

  it('roulette spin frames carry no information about the result', async () => {
    const { rouletteSvg } = await import('../../src/render/game-images.js');
    const frame = (winner: number) => rouletteSvg({ result: null, history: [winner, 4, 19], spinNumber: 3, spin: { frame: 0, wheelAngle: 40, ballAngle: 120 } });
    expect(frame(7)).toBe(frame(32)); // identical whatever the winning number is
  });

  it('a full table of long names and split hands still fits Discord limits', async () => {
    const { validateScreen } = await import('../../src/ui/validate.js');
    const { blackjackPanel } = await import('../../src/ui/screens/blackjack.js');
    h = new CasinoHarness();
    h.app.settings.set(h.guildId, 'blackjack.maxSeats', 7);
    const players = Array.from({ length: 7 }, (_, i) => h.user(`${'W'.repeat(28)}${i}`));
    await h.click(players[0]!, h.seen(await h.slash(players[0]!, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.tableOfUser(h.guildId, players[0]!.id)!.record.id;
    for (const p of players) await h.click(p, h.tablePanel(tableId), '25');
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    const snap = structuredClone(h.app.blackjack.peek(tableId)!);
    // Worst case: everyone has four split hands of six cards.
    for (const seat of snap.state.round!.seats) {
      seat.hands = Array.from({ length: 4 }, () => ({ ...seat.hands[0]!, cards: ['2C', '2D', '2H', '3S', '3C', 'AD'] as Card[], fromSplit: true }));
    }
    const screen = await blackjackPanel(h.app, snap);
    expect(validateScreen(screen).errors).toEqual([]);
  });
});

describe('typed chip amounts', () => {
  it.each([
    ['250', 250],
    ['1,000', 1000],
    ['2k', 2000],
    ['1.5k', 1500],
    ['1m', 1_000_000],
    [' 3 000 ', 3000],
    ['1.2345k', null],
    ['ten', null],
    ['', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseChipAmount(raw)).toBe(expected);
  });

  it('understands all / max / half when a wallet applies', () => {
    expect(parseChipAmount('all', { available: 730, max: 500 })).toBe(500);
    expect(parseChipAmount('max', { available: 120, max: 500 })).toBe(120);
    expect(parseChipAmount('half', { available: 731, max: 500 })).toBe(365);
    expect(parseChipAmount('all')).toBeNull();
  });
});
