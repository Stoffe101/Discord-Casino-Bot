import { describe, expect, it } from 'vitest';
import { seededRng } from '../src/core/random.js';
import type { Card } from '../src/games/cards.js';
import {
  dealPoker, nextDealer, playPoker, pokerActions, publicPokerHand,
  type PokerAction, type PokerHand,
} from '../src/games/poker/engine.js';

const stacks = (...amounts: number[]) => amounts.map((stack, seat) => ({ seat, stack, userId: String(seat) }));
const act = (hand: PokerHand, action: PokerAction): PokerHand => playPoker(hand, String(hand.actor), hand.seq, action);

/** Replace hole cards and the five board cards (burns stay where the engine expects them). */
function rig(hand: PokerHand, holes: Record<number, [Card, Card]>, board: [Card, Card, Card, Card, Card]): void {
  const used = new Set<Card>([...Object.values(holes).flat(), ...board]);
  for (const seat of hand.seats) if (holes[seat.seat]) seat.cards = holes[seat.seat]!;
  // Keep the deck a permutation: move the rigged cards out of the way first.
  const spare = hand.deck.filter((card) => !used.has(card) && !hand.seats.some((seat) => seat.cards.includes(card)));
  const slots = [1, 2, 3, 5, 7].map((offset) => hand.cursor + offset);
  for (let i = hand.cursor; i < hand.deck.length; i++) hand.deck[i] = spare.shift()!;
  slots.forEach((slot, i) => { hand.deck[slot] = board[i]!; });
}

describe('audit: No-Limit Hold’em rules', () => {
  it('minimum raise is the size of the last full raise across re-raises and streets', () => {
    let hand = dealPoker(stacks(1000, 1000, 1000, 1000), 0, 5, 10, seededRng(3));
    // seat 3 is UTG (dealer 0, SB 1, BB 2)
    expect(hand.actor).toBe(3);
    expect(pokerActions(hand, '3')).toMatchObject({ call: 10, minTo: 20 });
    hand = act(hand, { type: 'raise', to: 30 }); // raise by 20
    expect(pokerActions(hand, '0')).toMatchObject({ call: 30, minTo: 50 });
    hand = act(hand, { type: 'raise', to: 100 }); // raise by 70
    expect(pokerActions(hand, '1')).toMatchObject({ call: 95, minTo: 170 });
    hand = act(hand, { type: 'fold' });
    hand = act(hand, { type: 'fold' });
    hand = act(hand, { type: 'call' }); // seat 3 calls 100
    expect(hand.street).toBe('flop');
    // Postflop: first to act left of the button; minimum bet is the big blind.
    expect(hand.actor).toBe(3);
    expect(pokerActions(hand, '3')).toMatchObject({ check: true, minTo: 10 });
    hand = act(hand, { type: 'raise', to: 25 });
    expect(pokerActions(hand, '0')).toMatchObject({ call: 25, minTo: 50 });
  });

  it('returns an uncalled river bet and keeps folded chips in the pot', () => {
    let hand = dealPoker(stacks(500, 500, 500), 0, 5, 10, seededRng(9));
    hand = act(hand, { type: 'call' }); // button
    hand = act(hand, { type: 'call' }); // SB
    hand = act(hand, { type: 'check' }); // BB
    for (let i = 0; i < 6; i++) hand = act(hand, { type: 'check' });
    expect(hand.street).toBe('river');
    hand = act(hand, { type: 'raise', to: 200 });
    hand = act(hand, { type: 'fold' });
    hand = act(hand, { type: 'fold' });
    expect(hand.result?.showdown).toBe(false);
    expect(hand.result?.refunds).toEqual([{ seat: hand.result!.payouts[0]!.seat, amount: 200 }]);
    expect(hand.result?.pots).toEqual([{ amount: 30, eligible: [hand.result!.payouts[0]!.seat], winners: [hand.result!.payouts[0]!.seat] }]);
    expect(hand.seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(1500);
  });

  it('gives the big blind the walk and returns the uncalled part of the big blind', () => {
    let hand = dealPoker(stacks(100, 100, 100), 0, 5, 10, seededRng(4));
    hand = act(hand, { type: 'fold' });
    hand = act(hand, { type: 'fold' });
    expect(hand.result).toMatchObject({ showdown: false, refunds: [{ seat: 2, amount: 5 }], payouts: [{ seat: 2, amount: 10 }] });
    expect(hand.seats.map((seat) => seat.stack)).toEqual([100, 95, 105]);
  });

  it('heads-up: button posts the small blind, acts first pre-flop and last after the flop', () => {
    let hand = dealPoker(stacks(100, 100), 1, 5, 10, seededRng(2));
    expect([hand.dealer, hand.smallBlindSeat, hand.bigBlindSeat, hand.actor]).toEqual([1, 1, 0, 1]);
    // Cards are dealt starting left of the button: the big blind gets the first card.
    expect(hand.seats.find((seat) => seat.seat === 0)!.cards[0]).toBe(hand.deck[0]);
    hand = act(hand, { type: 'call' });
    hand = act(hand, { type: 'check' });
    expect(hand.actor).toBe(0);
    hand = act(hand, { type: 'check' });
    expect(hand.actor).toBe(1);
  });

  it('an under-raise all-in does not reopen betting for a player who checked', () => {
    let hand = dealPoker(stacks(500, 500, 15), 0, 5, 10, seededRng(8));
    hand = act(hand, { type: 'call' }); // button
    hand = act(hand, { type: 'call' }); // SB
    hand = act(hand, { type: 'check' }); // BB (5 behind)
    expect(hand.street).toBe('flop');
    hand = act(hand, { type: 'check' }); // SB
    hand = act(hand, { type: 'all-in' }); // BB bets 5 (< big blind)
    expect(pokerActions(hand, '0')).toMatchObject({ call: 5, minTo: 15 });
    hand = act(hand, { type: 'call' });
    expect(pokerActions(hand, '1')).toMatchObject({ call: 5, minTo: null });
  });

  it('splits a three-way pot with the odd chips going left of the button in order', () => {
    let hand = dealPoker(stacks(100, 100, 100, 100), 3, 5, 10, seededRng(12));
    rig(hand, { 0: ['TC', '2D'], 1: ['TD', '3H'], 2: ['TH', '2S'], 3: ['4C', '4D'] }, ['AH', 'KD', 'QC', 'JS', '5H']);
    // dealer 3, SB 0, BB 1, UTG 2
    expect(() => act(hand, { type: 'raise', to: 11 })).toThrow(/unavailable/);
    hand = act(hand, { type: 'call' }); // 2
    hand = act(hand, { type: 'call' }); // 3
    hand = act(hand, { type: 'call' }); // 0
    hand = act(hand, { type: 'check' }); // 1
    hand = act(hand, { type: 'check' }); // 0
    hand = act(hand, { type: 'check' }); // 1
    hand = act(hand, { type: 'check' }); // 2
    hand = act(hand, { type: 'raise', to: 13 }); // 3
    for (let i = 0; i < 3; i++) hand = act(hand, { type: 'call' });
    while (hand.street !== 'complete') hand = act(hand, { type: 'check' });
    expect(hand.result?.pots).toEqual([{ amount: 92, eligible: [0, 1, 2, 3], winners: [0, 1, 2] }]);
    expect(hand.result?.payouts).toEqual([{ seat: 0, amount: 31 }, { seat: 1, amount: 31 }, { seat: 2, amount: 30 }]);
  });
});

describe('audit: button movement', () => {
  // Fixed: nextDealer() used to move the button to the next live seat, so when the previous big blind
  // left, the player after them posted the small blind instead of the big blind. It now returns
  // dead-button positions (BlindPositions in engine.ts) that dealPoker() accepts: the big blind always
  // advances exactly one seat, with a dead small blind / dead button where needed. More cases live in
  // tests/poker-blinds.test.ts.
  it('the big blind advances one seat when the previous big blind leaves (dead button)', () => {
    const four = stacks(100, 100, 100, 100);
    const first = dealPoker(four, 0, 5, 10, seededRng(1));
    expect([first.smallBlindSeat, first.bigBlindSeat]).toEqual([1, 2]);
    const remaining = four.filter((seat) => seat.seat !== 2);
    const dealer = nextDealer(remaining, first.dealer, first.bigBlindSeat);
    const second = dealPoker(remaining, dealer, 5, 10, seededRng(2));
    // Before the fix: dealer 1, small blind 3, big blind 0, so seat 3 skipped the big blind.
    expect(second.bigBlindSeat).toBe(3);
  });

  it('heads-up transitions never give the same player the big blind twice in a row', () => {
    const three = stacks(100, 100, 100);
    for (const leaving of [0, 1, 2]) {
      const first = dealPoker(three, 0, 5, 10, seededRng(leaving));
      const remaining = three.filter((seat) => seat.seat !== leaving);
      const dealer = nextDealer(remaining, first.dealer, first.bigBlindSeat);
      const second = dealPoker(remaining, dealer, 5, 10, seededRng(9));
      expect(second.bigBlindSeat).not.toBe(first.bigBlindSeat);
      expect(second.smallBlindSeat).toBe(second.dealer);
      const third = dealPoker(remaining, nextDealer(remaining, second.dealer, second.bigBlindSeat), 5, 10, seededRng(3));
      expect(third.bigBlindSeat).toBe(second.smallBlindSeat);
    }
    void publicPokerHand;
  });
});
