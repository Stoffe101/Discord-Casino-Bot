import { describe, expect, it } from 'vitest';
import { seededRng } from '../src/core/random.js';
import { createDeck, type Card } from '../src/games/cards.js';
import { bestHand, HAND_CATEGORIES } from '../src/games/poker/hand-rank.js';
import {
  dealPoker, nextDealer, playPoker, pokerActions, privatePokerHand, publicPokerHand,
  type PokerAction, type PokerHand,
} from '../src/games/poker/engine.js';

const cards = (value: string): Card[] => value.split(' ') as Card[];
const stacks = (...amounts: number[]) => amounts.map((stack, seat) => ({ seat, stack, userId: String(seat) }));
const act = (hand: PokerHand, action: PokerAction): PokerHand => playPoker(hand, String(hand.actor), hand.seq, action);

describe('Hold’em hand rankings', () => {
  it.each([
    ['AS 2H 4D 8S TC', 'High card'],
    ['AS AH 4D 8S TC', 'Pair'],
    ['AS AH 4D 4S TC', 'Two pair'],
    ['AS AH AD 8S TC', 'Three of a kind'],
    ['AS 2H 3D 4S 5C', 'Straight'],
    ['AS 2S 4S 8S TS', 'Flush'],
    ['AS AH AD 8S 8C', 'Full house'],
    ['AS AH AD AC TC', 'Four of a kind'],
    ['AS 2S 3S 4S 5S', 'Straight flush'],
  ])('ranks %s as %s', (codes, category) => {
    expect(bestHand(cards(codes)).category).toBe(category);
  });

  it('takes the best five and compares kickers, wheels and board ties', () => {
    const score = (codes: string) => bestHand(cards(codes)).score;
    expect(score('AS AH AC KS KH KC AD')).toBeGreaterThan(score('AS AH AC KS KH KC KD'));
    expect(score('AS AH KC QH TS 4D 2D')).toBeGreaterThan(score('AS AH KC JH TS 4D 2D'));
    expect(score('AS AH 2C 3D 4C 5H 6S')).toBeGreaterThan(score('AS AH KC 2D 3S 4H 5S'));
    expect(score('AS KS QS JS TS 2C 7H')).toBe(score('AS KS QS JS TS AD AH'));
    expect(() => bestHand(cards('AS AS KD KC KH'))).toThrow(/distinct/);
  });

  it('matches the exact standard five-card distribution across all 2,598,960 hands', () => {
    const deck = createDeck();
    const counts = Object.fromEntries(HAND_CATEGORIES.map((category) => [category, 0]));
    for (let a = 0; a < 48; a++) {
      for (let b = a + 1; b < 49; b++) {
        for (let c = b + 1; c < 50; c++) {
          for (let d = c + 1; d < 51; d++) {
            for (let e = d + 1; e < 52; e++) {
              const category = bestHand([deck[a]!, deck[b]!, deck[c]!, deck[d]!, deck[e]!]).category;
              counts[category] = counts[category]! + 1;
            }
          }
        }
      }
    }
    expect(Object.values(counts)).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  }, 30_000);
});

describe('No-Limit Hold’em betting', () => {
  it('uses heads-up blind positions, order, and checks through four streets', () => {
    let hand = dealPoker(stacks(100, 100), 0, 5, 10, seededRng(17));
    expect([hand.smallBlindSeat, hand.bigBlindSeat, hand.actor]).toEqual([0, 1, 0]);
    expect(pokerActions(hand, '0')).toMatchObject({ check: false, call: 5, minTo: 20 });
    hand = act(hand, { type: 'call' });
    expect(pokerActions(hand, '1')).toMatchObject({ check: true, call: null, minTo: 20 });
    hand = act(hand, { type: 'check' });
    expect([hand.street, hand.actor, hand.board.length, hand.cursor]).toEqual(['flop', 1, 3, 8]);
    for (let i = 0; i < 6; i++) hand = act(hand, { type: 'check' });
    expect(hand.board).toHaveLength(5);
    expect(hand.result).toMatchObject({ showdown: true, pots: [{ amount: 20 }] });
    expect(nextDealer(stacks(100, 100), hand.dealer, hand.bigBlindSeat)).toBe(1);
  });

  it('keeps the full blind in multiway play with a short BB and checks legal action and sequence', () => {
    const hand = dealPoker(stacks(100, 100, 3), 0, 5, 10, seededRng(1));
    expect(hand.actor).toBe(0);
    expect(pokerActions(hand, '0')).toMatchObject({ call: 10, minTo: 20 });
    expect(() => playPoker(hand, '1', hand.seq, { type: 'call' })).toThrow(/turn/);
    expect(() => act(hand, { type: 'raise', to: 19 })).toThrow(/unavailable/);
    expect(() => act(hand, { type: 'raise', to: 20.5 })).toThrow(/unavailable/);
    const next = act(hand, { type: 'raise', to: 20 });
    expect(pokerActions(next, '1')).toMatchObject({ call: 15, minTo: 30 });
    expect(() => playPoker(next, '0', hand.seq, { type: 'raise', to: 20 })).toThrow(/out of date/);
    expect(hand.seats[0]!.stack).toBe(100);
  });

  it('reopens after cumulative short all-ins but retains the prior full raise size', () => {
    let hand = dealPoker(stacks(25, 30, 200, 200, 200), 0, 5, 10, seededRng(5));
    hand = act(hand, { type: 'raise', to: 20 }); // seat 3
    hand = act(hand, { type: 'call' }); // seat 4
    hand = act(hand, { type: 'all-in' }); // seat 0 raises by 5
    const short = act(act(hand, { type: 'fold' }), { type: 'call' });
    expect(pokerActions(short, '3')).toMatchObject({ call: 5, minTo: null, allIn: false });
    hand = act(hand, { type: 'all-in' }); // seat 1 raises by 5 more
    hand = act(hand, { type: 'call' }); // seat 2
    expect(pokerActions(hand, '3')).toMatchObject({ call: 10, minTo: 40, allIn: true });
  });

  it('builds two side pots, restores the uncalled amount, and pays the right hands', () => {
    let hand = dealPoker(stacks(10, 20, 30, 40), 0, 2, 4, seededRng(11));
    hand.seats[0]!.cards = ['AS', 'AC'];
    hand.seats[1]!.cards = ['KS', 'KC'];
    hand.seats[2]!.cards = ['QS', 'QC'];
    hand.seats[3]!.cards = ['JS', 'JC'];
    for (const [offset, card] of [[1, '2H'], [2, '3S'], [3, '5D'], [5, '7C'], [7, '9H']] as const) {
      hand.deck[hand.cursor + offset] = card;
    }
    for (let i = 0; i < 4; i++) hand = act(hand, { type: 'all-in' });
    expect(hand.result).toEqual({
      showdown: true,
      refunds: [{ seat: 3, amount: 10 }],
      pots: [
        { amount: 40, eligible: [0, 1, 2, 3], winners: [0] },
        { amount: 30, eligible: [1, 2, 3], winners: [1] },
        { amount: 20, eligible: [2, 3], winners: [2] },
      ],
      payouts: [{ seat: 0, amount: 40 }, { seat: 1, amount: 30 }, { seat: 2, amount: 20 }],
    });
    expect(hand.seats.map((seat) => seat.stack)).toEqual([40, 30, 20, 10]);
  });

  it('includes folded chips and awards an odd chip to the first tied player left of the button', () => {
    let hand = dealPoker(stacks(100, 100, 100), 0, 5, 10, seededRng(10));
    const hole = ['2C', '3C', '4C', '5C', '6C', '7C'] as const;
    for (let i = 0; i < 3; i++) hand.seats[i]!.cards = [hole[i * 2]!, hole[i * 2 + 1]!];
    for (const [offset, card] of [[1, 'AS'], [2, 'KS'], [3, 'QS'], [5, 'JS'], [7, 'TS']] as const) {
      hand.deck[hand.cursor + offset] = card;
    }
    hand = act(hand, { type: 'call' }); // button
    hand = act(hand, { type: 'fold' }); // small blind leaves 5 chips
    for (let i = 0; i < 7; i++) hand = act(hand, { type: 'check' });
    expect(hand.result?.pots).toEqual([{ amount: 25, eligible: [0, 2], winners: [2, 0] }]);
    expect(hand.result?.payouts).toEqual([{ seat: 2, amount: 13 }, { seat: 0, amount: 12 }]);
    expect(publicPokerHand(hand).seats[1]!.cards).toBeNull();
  });

  it('keeps the deck and unrevealed cards out of public snapshots', () => {
    let hand = dealPoker(stacks(100, 100), 0, 5, 10, seededRng(5));
    const view = publicPokerHand(hand);
    expect(view.board).toEqual([]);
    expect(view.seats.every((seat) => seat.cards === null)).toBe(true);
    expect(view).not.toHaveProperty('deck');
    expect(privatePokerHand(hand, 'visitor')).toBeNull();
    expect(privatePokerHand(hand, '0')?.cards).toEqual(hand.seats[0]!.cards);
    hand = act(hand, { type: 'fold' });
    expect(publicPokerHand(hand).seats.every((seat) => seat.cards === null)).toBe(true);
    expect(hand.result?.refunds).toEqual([{ seat: 1, amount: 5 }]);
  });

  it('conserves chips across varied stacks, folds and all-ins in seeded hands', () => {
    const rng = seededRng(120);
    for (let i = 0; i < 500; i++) {
      const opening = Array.from({ length: 2 + rng.int(7) }, () => 1 + rng.int(180));
      const total = opening.reduce((sum, stack) => sum + stack, 0);
      let hand = dealPoker(stacks(...opening), rng.int(opening.length), 5, 10, rng);
      for (let turn = 0; hand.street !== 'complete' && turn < 300; turn++) {
        expect(hand.seats.reduce((sum, seat) => sum + seat.stack + seat.committed, 0)).toBe(total);
        const legal = pokerActions(hand, String(hand.actor))!;
        const actions: PokerAction[] = [{ type: 'fold' }, legal.check ? { type: 'check' } : { type: 'call' }];
        if (legal.allIn) actions.push({ type: 'all-in' });
        if (legal.minTo !== null) actions.push({ type: 'raise', to: legal.minTo });
        hand = act(hand, actions[rng.int(actions.length)]!);
      }
      expect(hand.street).toBe('complete');
      expect(hand.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(total);
      expect(hand.result!.payouts.reduce((sum, payout) => sum + payout.amount, 0))
        .toBe(hand.seats.reduce((sum, seat) => sum + seat.committed, 0));
    }
  });
});
