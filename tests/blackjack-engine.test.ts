import { describe, expect, it } from 'vitest';
import { seededRng } from '../src/core/random.js';
import { createShoe, type Card } from '../src/games/cards.js';
import {
  act,
  availableActions,
  BlackjackRuleError,
  currentTurnUserId,
  decideInsurance,
  DEFAULT_RULES,
  describeTotal,
  expireInsurance,
  extraStakeFor,
  handValue,
  needsReshuffle,
  playDealer,
  settleRound,
  standAllHands,
  startRound,
  type BlackjackRules,
  type PlayerAction,
  type RoundState,
} from '../src/games/blackjack/engine.js';

const rng = seededRng(42);

/** Build a shoe that deals `order` first (cards are drawn from the end). Padded so no reshuffle triggers. */
function rig(order: string[], padding = 40): { shoe: Card[]; shoeSize: number } {
  const filler: Card[] = Array.from({ length: padding }, () => '2C' as Card);
  const shoe = [...filler, ...([...order].reverse() as Card[])];
  return { shoe, shoeSize: shoe.length };
}

function start(
  order: string[],
  bets: number[],
  rules: Partial<BlackjackRules> = {},
): RoundState {
  const { shoe, shoeSize } = rig(order);
  return startRound(
    {
      id: 'round-1',
      rules: { ...DEFAULT_RULES, ...rules },
      shoe,
      shoeSize,
      seats: bets.map((bet, i) => ({ userId: `p${i + 1}`, seatIndex: i, bet })),
    },
    rng,
  );
}

function finish(state: RoundState) {
  let s = state;
  if (s.phase === 'dealer') s = playDealer(s, rng);
  return settleRound(s);
}

function play(state: RoundState, moves: [string, PlayerAction][]): RoundState {
  let s = state;
  for (const [user, move] of moves) s = act(s, user, move, rng);
  return s;
}

describe('hand values', () => {
  it.each([
    [['AS', 'KH'], 21, true],
    [['AS', 'AH'], 12, true],
    [['AS', 'AH', '9D'], 21, true],
    [['AS', '6H', 'KD'], 17, false],
    [['5S', '6H'], 11, false],
    [['KS', 'QH', '5D'], 25, false],
    [['AS', 'AH', 'AD', 'AC'], 14, true],
    [['AS', '5H', '5D', 'AC'], 12, false],
  ] as [Card[], number, boolean][])('%j totals %i (soft=%s)', (cards, total, soft) => {
    expect(handValue(cards)).toEqual({ total, soft });
  });

  it('describes totals for display', () => {
    expect(describeTotal(['AS', 'KH'])).toBe('Blackjack');
    expect(describeTotal(['AS', 'KH'], true)).toBe('21');
    expect(describeTotal(['AS', '6H'])).toBe('soft 17');
    expect(describeTotal(['KS', 'QH', '5D'])).toBe('Bust (25)');
  });
});

describe('dealing and naturals', () => {
  it('deals two cards to each player then the dealer, in seat order', () => {
    // p1, p2, dealer-up, p1, p2, dealer-hole
    const s = start(['5S', '6S', '9H', '7S', '8S', 'KD'], [10, 10]);
    expect(s.seats[0]!.hands[0]!.cards).toEqual(['5S', '7S']);
    expect(s.seats[1]!.hands[0]!.cards).toEqual(['6S', '8S']);
    expect(s.dealer).toEqual(['9H', 'KD']);
    expect(s.holeRevealed).toBe(false);
    expect(currentTurnUserId(s)).toBe('p1');
  });

  it('pays a natural 3:2 and rounds odd payouts down', () => {
    const s = start(['AS', '9H', 'KS', '7D'], [15]);
    expect(s.phase).toBe('dealer');
    const { settlement } = finish(s);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('blackjack');
    expect(settlement.seats[0]!.returned).toBe(15 + 22);
    expect(settlement.seats[0]!.net).toBe(22);
  });

  it('supports a 6:5 blackjack payout', () => {
    const s = start(['AS', '9H', 'KS', '7D'], [100], { blackjackPayout: { numerator: 6, denominator: 5 } });
    expect(finish(s).settlement.seats[0]!.returned).toBe(220);
  });

  it('pushes a natural against a dealer natural', () => {
    // Dealer shows a ten (no insurance offered), peeks and has blackjack.
    const s = start(['AS', 'KH', 'KS', 'AD'], [50]);
    expect(s.phase).toBe('complete');
    expect(s.dealerBlackjack).toBe(true);
    const { settlement } = settleRound(s);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('push');
    expect(settlement.seats[0]!.returned).toBe(50);
  });

  it('dealer blackjack with a ten up ends the round and only takes original bets', () => {
    const s = start(['9S', '5S', 'KH', '9D', '7S', 'AD'], [40, 60]);
    expect(s.phase).toBe('complete');
    const { settlement } = settleRound(s);
    expect(settlement.seats.map((x) => x.returned)).toEqual([0, 0]);
    expect(settlement.seats.map((x) => x.wagered)).toEqual([40, 60]);
  });

  it('a natural 21 beats a dealer multi-card 21', () => {
    // p1 natural, p2 stands on 19 so the dealer must draw: 6+5+K = 21.
    let s = start(['AS', 'TS', '6H', 'KS', '9S', '5D', 'KC'], [100, 10], { insurance: false });
    s = act(s, 'p2', 'stand', rng);
    const { settlement } = finish(s);
    expect(settlement.dealerTotal).toBe(21);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('blackjack');
    expect(settlement.seats[1]!.hands[0]!.outcome).toBe('lose');
  });

  it('the dealer does not draw when only naturals remain', () => {
    const s = start(['AS', '6H', 'KS', '5D', 'KC'], [100], { insurance: false });
    expect(s.phase).toBe('dealer');
    const { settlement } = finish(s);
    expect(settlement.dealerCards).toHaveLength(2);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('blackjack');
  });
});

describe('insurance', () => {
  it('offers insurance on an ace and pays 2:1 when the dealer has blackjack', () => {
    let s = start(['TS', 'AH', '9S', 'KD'], [100]);
    expect(s.phase).toBe('insurance');
    expect(s.seats[0]!.insurance.decision).toBe('pending');
    s = decideInsurance(s, 'p1', true);
    expect(s.phase).toBe('complete');
    const { settlement } = settleRound(s);
    expect(settlement.seats[0]!.insurance).toEqual({ amount: 50, payout: 150 });
    expect(settlement.seats[0]!.wagered).toBe(150);
    expect(settlement.seats[0]!.returned).toBe(150); // insurance exactly offsets the lost hand
    expect(settlement.seats[0]!.net).toBe(0);
  });

  it('loses insurance when the dealer has no blackjack, then play continues', () => {
    let s = start(['TS', 'AH', '9S', '7D'], [100]);
    s = decideInsurance(s, 'p1', true);
    expect(s.phase).toBe('playing');
    s = act(s, 'p1', 'stand', rng); // 19 vs dealer soft 18
    const { settlement } = finish(s);
    expect(settlement.seats[0]!.insurance).toEqual({ amount: 50, payout: 0 });
    expect(settlement.seats[0]!.returned).toBe(200);
    expect(settlement.seats[0]!.net).toBe(50);
  });

  it('waits for every player and auto-declines on expiry', () => {
    let s = start(['TS', '8S', 'AH', '9S', '9H', '7D'], [100, 100]);
    s = decideInsurance(s, 'p1', false);
    expect(s.phase).toBe('insurance');
    expect(() => decideInsurance(s, 'p1', true)).toThrow(BlackjackRuleError);
    s = expireInsurance(s);
    expect(s.seats[1]!.insurance.decision).toBe('declined');
    expect(s.phase).toBe('playing');
  });

  it('is skipped entirely when disabled', () => {
    const s = start(['TS', 'AH', '9S', '7D'], [100], { insurance: false });
    expect(s.phase).toBe('playing');
  });
});

describe('player decisions', () => {
  it('hits, updates totals and busts', () => {
    let s = start(['TS', '9H', '5S', '7D', '9C'], [20]);
    s = act(s, 'p1', 'hit', rng);
    expect(s.seats[0]!.hands[0]!.cards).toEqual(['TS', '5S', '9C']);
    expect(s.seats[0]!.hands[0]!.done).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ t: 'bust', total: 24 });
    const { settlement } = finish(s);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('bust');
    // Dealer does not draw when nobody is left to beat.
    expect(settlement.dealerCards).toHaveLength(2);
  });

  it('auto-stands on 21', () => {
    let s = start(['TS', '9H', '5S', '7D', '6C'], [20]);
    s = act(s, 'p1', 'hit', rng);
    expect(s.seats[0]!.hands[0]!.done).toBe(true);
    expect(s.phase).toBe('dealer');
  });

  it('rejects actions from anyone but the active player', () => {
    const s = start(['TS', '8S', '9H', '5S', '9S', '7D'], [20, 20]);
    expect(() => act(s, 'p2', 'hit', rng)).toThrow(/your turn/);
    expect(() => act(s, 'stranger', 'stand', rng)).toThrow(BlackjackRuleError);
    expect(availableActions(s, 'p2')).toEqual({ hit: false, stand: false, double: false, split: false, surrender: false });
  });

  it('doubles: doubles the bet, takes exactly one card and pays on the doubled stake', () => {
    let s = start(['6S', '9H', '5S', '7D', 'TC', '4H'], [50]);
    expect(extraStakeFor(s, 'double')).toBe(50);
    s = act(s, 'p1', 'double', rng);
    const hand = s.seats[0]!.hands[0]!;
    expect(hand).toMatchObject({ bet: 100, doubled: true, done: true, cards: ['6S', '5S', 'TC'] });
    const { settlement } = finish(s); // dealer 16 draws 4 → 20; player 21
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('win');
    expect(settlement.seats[0]!.returned).toBe(200);
    expect(settlement.seats[0]!.net).toBe(100);
  });

  it('only allows doubling on the first two cards', () => {
    let s = start(['2S', '9H', '3S', '7D', '2D'], [50]);
    s = act(s, 'p1', 'hit', rng);
    expect(availableActions(s, 'p1').double).toBe(false);
    expect(() => act(s, 'p1', 'double', rng)).toThrow(BlackjackRuleError);
  });

  it('surrenders for half the bet (rounded down)', () => {
    let s = start(['TS', '9H', '6S', 'TD'], [15]);
    expect(availableActions(s, 'p1').surrender).toBe(true);
    s = act(s, 'p1', 'surrender', rng);
    const { settlement } = finish(s);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('surrender');
    expect(settlement.seats[0]!.returned).toBe(7);
  });

  it('does not offer surrender when disabled or after hitting', () => {
    const off = start(['TS', '9H', '6S', 'TD'], [15], { surrender: false });
    expect(availableActions(off, 'p1').surrender).toBe(false);
    let s = start(['2S', '9H', '3S', 'TD', '2C'], [15]);
    s = act(s, 'p1', 'hit', rng);
    expect(availableActions(s, 'p1').surrender).toBe(false);
  });
});

describe('splitting', () => {
  it('splits a pair into two independent hands with separate wagers', () => {
    // p1: 8,8 ; dealer 6 / T. After split: hand A gets 3, hand B gets T.
    let s = start(['8S', '6H', '8D', 'TD', '3C', 'TC'], [25]);
    expect(availableActions(s, 'p1').split).toBe(true);
    expect(extraStakeFor(s, 'split')).toBe(25);
    s = act(s, 'p1', 'split', rng);
    const hands = s.seats[0]!.hands;
    expect(hands).toHaveLength(2);
    expect(hands.map((h) => h.cards)).toEqual([
      ['8S', '3C'],
      ['8D', 'TC'],
    ]);
    expect(hands.map((h) => h.bet)).toEqual([25, 25]);
    expect(s.turn).toEqual({ seat: 0, hand: 0 });
    // Double after split on 11.
    expect(availableActions(s, 'p1').double).toBe(true);
    expect(availableActions(s, 'p1').surrender).toBe(false);
  });

  it('settles split hands independently', () => {
    // p1 8,8 vs dealer 9/8 (17). Hand A: 8+T = 18 (win). Hand B: 8+9 = 17 (push).
    let s = start(['8S', '9H', '8D', '8C', 'TC', '9D'], [25]);
    s = act(s, 'p1', 'split', rng);
    s = play(s, [
      ['p1', 'stand'],
      ['p1', 'stand'],
    ]);
    const { settlement } = finish(s);
    expect(settlement.seats[0]!.hands.map((h) => h.outcome)).toEqual(['win', 'push']);
    expect(settlement.seats[0]!.wagered).toBe(50);
    expect(settlement.seats[0]!.returned).toBe(75);
  });

  it('gives split aces one card each, and 21 on a split ace is not blackjack', () => {
    let s = start(['AS', '9H', 'AD', '7D', 'KC', '5C'], [40]);
    s = act(s, 'p1', 'split', rng);
    expect(s.seats[0]!.hands.every((h) => h.done)).toBe(true);
    expect(s.phase).toBe('dealer');
    const { settlement } = finish(s); // dealer 16 → draws filler 2C → 18
    const [a, b] = settlement.seats[0]!.hands;
    expect(a!.total).toBe(21);
    expect(a!.outcome).toBe('win');
    expect(a!.payout).toBe(80); // 1:1, not 3:2
    expect(b!.total).toBe(16);
    expect(b!.outcome).toBe('lose');
  });

  it('allows resplitting up to the hand limit', () => {
    let s = start(['8S', '9H', '8D', '7D', '8C', '8H', '2D', '3D', '4D', '5D'], [10]);
    s = act(s, 'p1', 'split', rng); // hands: 8S+8C, 8D+8H
    expect(availableActions(s, 'p1').split).toBe(true);
    s = act(s, 'p1', 'split', rng); // 3 hands
    expect(s.seats[0]!.hands).toHaveLength(3);
    const limited = start(['8S', '9H', '8D', '7D', '8C', '8H'], [10], { maxSplitHands: 2 });
    const afterOne = act(limited, 'p1', 'split', rng);
    expect(availableActions(afterOne, 'p1').split).toBe(false);
  });

  it('respects double-after-split being disabled', () => {
    let s = start(['8S', '6H', '8D', 'TD', '3C', 'TC'], [25], { doubleAfterSplit: false });
    s = act(s, 'p1', 'split', rng);
    expect(availableActions(s, 'p1').double).toBe(false);
  });

  it('can resplit aces only when the rule allows it', () => {
    const order = ['AS', '9H', 'AD', '7D', 'AC', '5C', '9C', '9D'];
    let off = start(order, [10]);
    off = act(off, 'p1', 'split', rng);
    expect(off.seats[0]!.hands.every((h) => h.done)).toBe(true);
    let on = start(order, [10], { resplitAces: true });
    on = act(on, 'p1', 'split', rng);
    expect(on.seats[0]!.hands[0]!.done).toBe(false);
    expect(availableActions(on, 'p1')).toMatchObject({ split: true, hit: false, double: false, stand: true });
  });

  it('refuses to split non-pairs', () => {
    const s = start(['KS', '9H', 'QD', '7D'], [10]);
    expect(availableActions(s, 'p1').split).toBe(false);
    expect(() => act(s, 'p1', 'split', rng)).toThrow(/matching/);
  });
});

describe('dealer rules', () => {
  it('stands on soft 17 by default', () => {
    let s = start(['TS', 'AH', '8S', '6D'], [10], { insurance: false });
    s = act(s, 'p1', 'stand', rng);
    const { settlement } = finish(s);
    expect(settlement.dealerCards).toHaveLength(2);
    expect(settlement.dealerTotal).toBe(17);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('win');
  });

  it('hits soft 17 when configured', () => {
    let s = start(['TS', 'AH', '8S', '6D', '3C'], [10], { insurance: false, dealerHitsSoft17: true });
    s = act(s, 'p1', 'stand', rng);
    const { settlement } = finish(s);
    expect(settlement.dealerCards).toEqual(['AH', '6D', '3C']);
    expect(settlement.dealerTotal).toBe(20);
    expect(settlement.seats[0]!.hands[0]!.outcome).toBe('lose');
  });

  it('draws until 17 and pays everyone when the dealer busts', () => {
    let s = start(['TS', '9S', '6H', '2S', '8S', 'TD', '9C'], [10, 30]);
    s = play(s, [
      ['p1', 'stand'],
      ['p2', 'stand'],
    ]);
    const { settlement } = finish(s);
    expect(settlement.dealerBust).toBe(true);
    expect(settlement.seats.map((x) => x.returned)).toEqual([20, 60]);
  });
});

describe('turn order and timeouts', () => {
  it('runs a five-player round in seat order', () => {
    const order = ['TS', 'TH', 'TD', 'TC', '9S', '7H', '8S', '8H', '8D', '8C', '9H', 'KD'];
    let s = start(order, [10, 20, 30, 40, 50]);
    const seen: string[] = [];
    while (s.phase === 'playing') {
      const who = currentTurnUserId(s)!;
      seen.push(who);
      s = act(s, who, 'stand', rng);
    }
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    const { settlement } = finish(s); // dealer 7+K = 17
    expect(settlement.seats.map((x) => x.hands[0]!.outcome)).toEqual(['win', 'win', 'win', 'win', 'win']);
    expect(settlement.seats.map((x) => x.net)).toEqual([10, 20, 30, 40, 50]);
  });

  it('stands every remaining hand of a player on timeout', () => {
    let s = start(['8S', '9S', '6H', '8D', '9D', 'TD', '3C', '4C'], [10, 10]);
    s = act(s, 'p1', 'split', rng);
    s = standAllHands(s, 'p1', 'timeout');
    expect(s.seats[0]!.hands.every((h) => h.done)).toBe(true);
    expect(currentTurnUserId(s)).toBe('p2');
    expect(s.events.filter((e) => e.t === 'stand' && e.reason === 'timeout')).toHaveLength(2);
  });

  it('increments the sequence number on every change (for stale-click detection)', () => {
    let s = start(['2S', '9H', '3S', 'TD', '2D', '2H'], [10]);
    const before = s.seq;
    s = act(s, 'p1', 'hit', rng);
    expect(s.seq).toBe(before + 1);
  });
});

describe('shoe management', () => {
  it('reshuffles at the penetration point', () => {
    const shoe = createShoe(1, rng);
    expect(needsReshuffle(shoe, 52, DEFAULT_RULES)).toBe(false);
    expect(needsReshuffle(shoe.slice(0, 13), 52, DEFAULT_RULES)).toBe(true);
    const s = startRound(
      { id: 'r', rules: { ...DEFAULT_RULES, decks: 2 }, shoe: shoe.slice(0, 10), shoeSize: 52, seats: [{ userId: 'a', seatIndex: 0, bet: 5 }] },
      rng,
    );
    expect(s.events[0]).toEqual({ t: 'reshuffle' });
    expect(s.shoeSize).toBe(104);
  });

  it('recovers from an exhausted shoe mid-round without duplicating cards in play', () => {
    let s = startRound(
      {
        id: 'r',
        rules: { ...DEFAULT_RULES, decks: 1 },
        shoe: ['5C', '2D', '2C', '3H', '2H', '3S', '2S'].reverse() as Card[],
        shoeSize: 60,
        seats: [{ userId: 'a', seatIndex: 0, bet: 5 }],
      },
      rng,
    );
    // a: 2S 2H (4) ; dealer 3S 3H. Remaining shoe: 2C, 2D, 5C
    for (let i = 0; i < 4 && s.phase === 'playing'; i++) s = act(s, 'a', 'hit', rng);
    const inPlay = [...s.dealer, ...s.seats[0]!.hands[0]!.cards];
    expect(s.events.some((e) => e.t === 'reshuffle')).toBe(true);
    const all = [...inPlay, ...s.shoe];
    expect(new Set(all).size).toBe(all.length);
  });

  it('a full shoe contains each card exactly `decks` times', () => {
    const shoe = createShoe(6, rng);
    expect(shoe).toHaveLength(312);
    const counts = new Map<string, number>();
    for (const c of shoe) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(52);
    expect([...counts.values()].every((n) => n === 6)).toBe(true);
  });
});

describe('randomised invariants', () => {
  it('keeps payouts within legal bounds over thousands of random rounds', () => {
    const r = seededRng(7);
    const actions: PlayerAction[] = ['hit', 'stand', 'double', 'split', 'surrender'];
    let shoe = createShoe(6, r);
    let shoeSize = shoe.length;
    let totalWagered = 0;
    let totalReturned = 0;
    for (let round = 0; round < 3000; round++) {
      const players = 1 + r.int(5);
      let s = startRound(
        {
          id: `r${round}`,
          rules: DEFAULT_RULES,
          shoe,
          shoeSize,
          seats: Array.from({ length: players }, (_, i) => ({ userId: `u${i}`, seatIndex: i, bet: 1 + r.int(500) })),
        },
        r,
      );
      if (s.phase === 'insurance') {
        for (const seat of s.seats) s = decideInsurance(s, seat.userId, r.int(2) === 0 && seat.hands[0]!.bet > 1);
      }
      let guard = 0;
      while (s.phase === 'playing') {
        const who = currentTurnUserId(s)!;
        const legal = availableActions(s, who);
        const options = actions.filter((a) => legal[a]);
        s = act(s, who, options[r.int(options.length)]!, r);
        if (++guard > 200) throw new Error('round did not terminate');
      }
      const { settlement } = finish(s);
      for (const seat of settlement.seats) {
        for (const hand of seat.hands) {
          const legalPayouts = [0, Math.floor(hand.bet / 2), hand.bet, hand.bet * 2, hand.bet + Math.floor((hand.bet * 3) / 2)];
          expect(legalPayouts).toContain(hand.payout);
        }
        expect(seat.returned).toBeGreaterThanOrEqual(0);
        totalWagered += seat.wagered;
        totalReturned += seat.returned;
      }
      shoe = s.shoe;
      shoeSize = s.shoeSize;
    }
    // Random play is bad strategy, but the return must still be in a sane band.
    const rtp = totalReturned / totalWagered;
    expect(rtp).toBeGreaterThan(0.5);
    expect(rtp).toBeLessThan(1.1);
  });
});
