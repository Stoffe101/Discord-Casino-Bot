import { afterEach, describe, expect, it } from 'vitest';
import { seededRng } from '../src/core/random.js';
import { cardLabel, type Card } from '../src/games/cards.js';
import { dealPoker, playPoker, pokerActions, publicPokerHand, type PokerAction, type PokerHand } from '../src/games/poker/engine.js';
import type { PokerSnapshot } from '../src/games/poker/poker-service.js';
import { pokerTableSvg } from '../src/render/poker-image.js';
import { pokerPanel } from '../src/ui/screens/poker.js';
import { CasinoHarness } from './harness/casino-harness.js';

/** Cards nobody outside the hand may know: undealt deck, burns, and hole cards not shown down. */
function hiddenCards(hand: PokerHand): Card[] {
  const shown = new Set<Card>(hand.board);
  for (const seat of hand.seats) if (hand.result?.showdown && !seat.folded) seat.cards.forEach((card) => shown.add(card));
  return hand.deck.filter((card) => !shown.has(card));
}

/** Same public situation, different private cards: every unrevealed card is swapped for another one. */
function perturb(hand: PokerHand): PokerHand {
  const copy = structuredClone(hand);
  const hidden = hiddenCards(hand);
  const swap = new Map(hidden.map((card, i) => [card, hidden[(i + 7) % hidden.length]!]));
  copy.deck = copy.deck.map((card) => swap.get(card) ?? card);
  for (const seat of copy.seats) seat.cards = seat.cards.map((card) => swap.get(card) ?? card) as [Card, Card];
  return copy;
}

const names = { 0: 'Ann', 1: 'Bo', 2: 'Cy', 3: 'Di' } as Record<string, string>;

describe('audit: nothing private reaches public output', () => {
  it('public projection and table image do not depend on any unrevealed card, on every street', () => {
    const rng = seededRng(77);
    for (let round = 0; round < 150; round++) {
      const count = 2 + rng.int(3);
      let hand = dealPoker(Array.from({ length: count }, (_, seat) => ({ seat, userId: String(seat), stack: 20 + rng.int(200) })), rng.int(count), 5, 10, rng);
      for (;;) {
        const twin = perturb(hand);
        expect(publicPokerHand(twin)).toEqual(publicPokerHand(hand));
        expect(pokerTableSvg(publicPokerHand(twin), names)).toBe(pokerTableSvg(publicPokerHand(hand), names));
        for (const options of [{ dealtSeats: 0 }, { shownBoard: 0 }, { maskShowdown: true }]) {
          expect(pokerTableSvg(publicPokerHand(twin), names, options)).toBe(pokerTableSvg(publicPokerHand(hand), names, options));
        }
        if (hand.street === 'complete') break;
        const user = String(hand.actor);
        const legal = pokerActions(hand, user)!;
        const options: PokerAction[] = [{ type: 'fold' }, legal.check ? { type: 'check' } : { type: 'call' }, { type: legal.check ? 'check' : 'call' }];
        if (legal.allIn) options.push({ type: 'all-in' });
        if (legal.minTo !== null) options.push({ type: 'raise', to: legal.minTo });
        hand = playPoker(hand, user, hand.seq, options[rng.int(options.length)]!);
      }
    }
  });
});

let h: CasinoHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('audit: panels, history, highlights and ledger', () => {
  it('the public panel and stored records never contain an unrevealed card', async () => {
    h = new CasinoHarness();
    const { app, guildId } = h;
    app.settings.set(guildId, 'poker.enabled', true);
    app.settings.set(guildId, 'highlights.minimumWager', 1);
    app.settings.set(guildId, 'highlights.bigNet', 1);
    const id = (await app.poker.create({ guildId, userId: 'a', name: 'Ann', buyIn: 100 })).record.id;
    await app.poker.join(id, 'b', 'Bo', 100);
    await app.poker.join(id, 'c', 'Cy', 100);
    for (let n = 0; n < 4; n++) {
      const hidden = new Set<Card>();
      await app.poker.start(id, app.poker.peek(id)!.record.ownerId, app.poker.peek(id)!.record.version);
      const handId = app.poker.peek(id)!.state.handId!;
      let step = 0;
      let last: PokerHand | null = null;
      while (app.poker.peek(id)!.state.hand) {
        const snapshot = app.poker.peek(id)!;
        const hand = snapshot.state.hand!;
        last = hand;
        const twin: PokerSnapshot = { record: snapshot.record, state: { ...snapshot.state, hand: perturb(hand) } };
        for (const hint of [undefined, step === 0 ? 'dealt' : 'board'] as const) {
          const [one, two] = await Promise.all([pokerPanel(app, snapshot, hint), pokerPanel(app, twin, hint)]);
          expect(JSON.stringify(two.components)).toBe(JSON.stringify(one.components));
          for (const card of hand.board) expect(JSON.stringify(one.components)).toContain(cardLabel(card));
          expect(two.files?.map((file) => [file.description, Buffer.from(file.data).toString('base64')]))
            .toEqual(one.files?.map((file) => [file.description, Buffer.from(file.data).toString('base64')]));
        }
        const user = hand.seats.find((seat) => seat.seat === hand.actor)!.userId;
        const legal = pokerActions(hand, user)!;
        // Hand 0 ends in a fold, the rest go to showdown with some folds along the way.
        const action: PokerAction = n === 0 && step === 1 ? { type: 'fold' } : n === 2 && step === 0 ? { type: 'fold' } : legal.check ? { type: 'check' } : { type: 'call' };
        await app.poker.act(id, user, snapshot.state.handId!, hand.seq, action);
        step++;
      }
      const result = app.poker.peek(id)!.state.result!;
      // Rebuild the final hidden set from the last live state and the published result.
      const showdown = result.result?.showdown;
      for (const card of last!.deck) {
        const onBoard = result.board.includes(card);
        const shownDown = showdown && result.seats.some((seat) => seat.cards?.includes(card));
        if (!onBoard && !shownDown) hidden.add(card);
      }
      const settled = { record: app.poker.peek(id)!.record, state: app.poker.peek(id)!.state };
      const panel = await pokerPanel(app, settled, 'settled');
      const panelText = JSON.stringify(panel.components);
      // Panel text prints cards as labels (A♠). After settlement it lists payouts only; the settled
      // image is covered by the engine-level invariance test at street 'complete'.
      for (const card of hidden) expect(panelText).not.toContain(cardLabel(card));
      expect(panel.files?.[0]?.description ?? '').not.toMatch(/[2-9TJQKA][SHDC]/);
      const stored = [
        ...h.db.all<{ s: string | null }>('SELECT summary_json AS s FROM game_rounds WHERE id = ?', [handId]),
        ...h.db.all<{ s: string | null }>('SELECT detail_json AS s FROM round_results WHERE round_id = ?', [handId]),
        ...h.db.all<{ s: string | null }>('SELECT text AS s FROM highlights WHERE text LIKE ?', ['%' + handId.slice(0, 8) + '%']),
        ...h.db.all<{ s: string | null }>('SELECT memo AS s FROM ledger WHERE memo LIKE ?', ['%hand ' + (n + 1) + ' %']),
      ].map((row) => row.s ?? '').join('\n');
      expect(stored.length).toBeGreaterThan(0);
      for (const card of hidden) expect(stored).not.toContain(`"${card}"`);
      expect(stored).not.toMatch(/deck|hole|cursor|cards/i);
    }
  }, 60_000);
});
