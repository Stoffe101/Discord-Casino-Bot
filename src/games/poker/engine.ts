import { StaleActionError, UserError } from '../../core/errors.js';
import type { Rng } from '../../core/random.js';
import { createShoe, type Card } from '../cards.js';
import { bestHand } from './hand-rank.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';

export interface PokerSeat {
  userId: string;
  seat: number;
  stack: number;
}

interface HandSeat extends PokerSeat {
  cards: [Card, Card];
  streetPaid: number;
  committed: number;
  actedAt: number | null;
  folded: boolean;
}

export interface PokerPot {
  amount: number;
  eligible: number[];
  winners: number[];
}

export interface PokerResult {
  showdown: boolean;
  pots: PokerPot[];
  payouts: { seat: number; amount: number }[];
  refunds: { seat: number; amount: number }[];
}

export interface PokerHand {
  seq: number;
  street: Street;
  dealer: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  bigBlind: number;
  currentBet: number;
  fullRaise: number;
  actor: number | null;
  seats: HandSeat[];
  board: Card[];
  deck: Card[];
  cursor: number;
  refunds: { seat: number; amount: number }[];
  result: PokerResult | null;
  lastAction: { seat: number; type: PokerAction['type']; amount: number } | null;
}

export type PokerAction = { type: 'fold' | 'check' | 'call' | 'all-in' } | { type: 'raise'; to: number };

function leftOf<T extends { seat: number }>(players: readonly T[], button: number): T[] {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  return [...sorted.filter((player) => player.seat > button), ...sorted.filter((player) => player.seat <= button)];
}

/** Pass the previous big blind when a table becomes heads-up to avoid a repeated big blind. */
export function nextDealer(seats: readonly PokerSeat[], previousDealer: number, previousBigBlind?: number): number {
  if (seats.length < 2) throw new RangeError('Poker needs at least two active players.');
  if (seats.length === 2 && previousBigBlind !== undefined) {
    const nextBigBlind = leftOf(seats, previousBigBlind)[0]!;
    return seats.find((player) => player.seat !== nextBigBlind.seat)!.seat;
  }
  return leftOf(seats, previousDealer)[0]!.seat;
}

export function dealPoker(seats: readonly PokerSeat[], dealer: number, smallBlind: number, bigBlind: number, rng?: Rng): PokerHand {
  const total = seats.reduce((sum, player) => sum + player.stack, 0);
  if (!Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind) || smallBlind <= 0 || bigBlind <= smallBlind || bigBlind > Number.MAX_SAFE_INTEGER / 2) {
    throw new RangeError('Poker requires valid small and big blinds.');
  }
  if (seats.length < 2 || seats.length > 9 || !Number.isSafeInteger(total)
    || new Set(seats.map((player) => player.seat)).size !== seats.length
    || new Set(seats.map((player) => player.userId)).size !== seats.length
    || !seats.some((player) => player.seat === dealer)
    || seats.some((player) => !player.userId || !Number.isSafeInteger(player.seat) || player.seat < 0 || !Number.isSafeInteger(player.stack) || player.stack <= 0)) {
    throw new RangeError('Poker requires two to nine distinct, funded seats and a seated dealer.');
  }
  const deck = createShoe(1, rng);
  const order = leftOf(seats, dealer);
  const smallBlindSeat = order[seats.length === 2 ? 1 : 0]!.seat;
  const bigBlindSeat = order[seats.length === 2 ? 0 : 1]!.seat;
  const hand: PokerHand = {
    seq: 0, street: 'preflop', dealer, smallBlindSeat, bigBlindSeat, bigBlind, currentBet: bigBlind,
    fullRaise: bigBlind, actor: null, board: [], deck, cursor: seats.length * 2, refunds: [], result: null, lastAction: null,
    seats: order.map((player, i): HandSeat => ({
      ...player, cards: [deck[i]!, deck[i + seats.length]!], streetPaid: 0, committed: 0, actedAt: null, folded: false,
    })).sort((a, b) => a.seat - b.seat),
  };
  for (const player of hand.seats) {
    const blind = player.seat === smallBlindSeat ? smallBlind : player.seat === bigBlindSeat ? bigBlind : 0;
    pay(player, Math.min(blind, player.stack));
  }
  advance(hand, bigBlindSeat);
  return hand;
}

function pay(player: HandSeat, chips: number): void {
  player.stack -= chips;
  player.streetPaid += chips;
  player.committed += chips;
}

function liveSeats(hand: PokerHand): HandSeat[] {
  return hand.seats.filter((player) => !player.folded);
}

/** A lone funded player need only match the chips opponents actually put in this street. */
function facedBet(hand: PokerHand, live: HandSeat[]): number {
  return live.filter((player) => player.stack > 0).length > 1
    ? hand.currentBet
    : Math.max(...live.map((player) => player.streetPaid));
}

export function pokerActions(hand: PokerHand, userId: string) {
  const player = hand.seats.find((seat) => seat.userId === userId && seat.seat === hand.actor);
  if (hand.street === 'complete' || !player) return null;
  const live = liveSeats(hand);
  const target = facedBet(hand, live);
  const toCall = target - player.streetPaid;
  const maxTo = player.streetPaid + player.stack;
  const minTo = hand.currentBet + hand.fullRaise;
  const raiseAllowed = live.some((other) => other.seat !== player.seat && other.stack > 0)
    && (player.actedAt === null || hand.currentBet - player.actedAt >= hand.fullRaise);
  return {
    fold: true,
    check: toCall === 0,
    call: toCall > 0 ? Math.min(toCall, player.stack) : null,
    minTo: raiseAllowed && maxTo >= minTo ? minTo : null,
    allIn: maxTo <= target || (raiseAllowed && maxTo > hand.currentBet),
    maxTo,
  };
}

export function playPoker(hand: PokerHand, userId: string, seq: number, action: PokerAction): PokerHand {
  if (seq !== hand.seq || hand.street === 'complete') throw new StaleActionError('That poker action is out of date.');
  const legal = pokerActions(hand, userId);
  if (!legal) throw new UserError('Wait for your turn before acting.', 'not_your_turn');
  const draft = structuredClone(hand);
  const player = draft.seats.find((seat) => seat.seat === draft.actor)!;
  const illegal = () => new UserError('That action is unavailable. Refresh your hand to see your legal options.', 'illegal_action');
  let amount = 0;
  switch (action.type) {
    case 'fold':
      player.folded = true;
      break;
    case 'check':
      if (!legal.check) throw illegal();
      break;
    case 'call':
      if (legal.call === null) throw illegal();
      amount = legal.call;
      break;
    case 'raise':
      if (legal.minTo === null || !Number.isSafeInteger(action.to) || action.to < legal.minTo || action.to > legal.maxTo) throw illegal();
      amount = action.to - player.streetPaid;
      break;
    case 'all-in':
      if (!legal.allIn) throw illegal();
      amount = player.stack;
      break;
    default:
      throw illegal();
  }
  pay(player, amount);
  if (player.streetPaid > draft.currentBet) {
    const increase = player.streetPaid - draft.currentBet;
    if (increase >= draft.fullRaise) draft.fullRaise = increase;
    draft.currentBet = player.streetPaid;
  }
  player.actedAt = draft.currentBet;
  draft.seq++;
  draft.lastAction = { seat: player.seat, type: action.type, amount };
  advance(draft, player.seat);
  return draft;
}

function advance(hand: PokerHand, after: number): void {
  const live = liveSeats(hand);
  if (live.length === 1) {
    refundUncalled(hand);
    settle(hand, live);
    return;
  }
  const funded = live.filter((player) => player.stack > 0);
  const target = facedBet(hand, live);
  const pending = funded.filter((player) => player.streetPaid < target || (funded.length > 1 && player.actedAt === null));
  hand.actor = leftOf(pending, after)[0]?.seat ?? null;
  if (hand.actor !== null) return;
  refundUncalled(hand);
  if (hand.street === 'river') {
    settle(hand, live);
    return;
  }
  hand.cursor++; // Burn one card before dealing each street.
  const count = hand.street === 'preflop' ? 3 : 1;
  hand.board.push(...hand.deck.slice(hand.cursor, hand.cursor + count));
  hand.cursor += count;
  hand.street = hand.street === 'preflop' ? 'flop' : hand.street === 'flop' ? 'turn' : 'river';
  hand.currentBet = 0;
  hand.fullRaise = hand.bigBlind;
  for (const player of hand.seats) {
    player.streetPaid = 0;
    player.actedAt = null;
  }
  advance(hand, hand.dealer);
}

function refundUncalled(hand: PokerHand): void {
  const [top, next] = [...hand.seats].sort((a, b) => b.streetPaid - a.streetPaid);
  const excess = top!.streetPaid - next!.streetPaid;
  if (excess === 0) return;
  top!.committed -= excess;
  top!.streetPaid -= excess;
  top!.stack += excess;
  hand.refunds.push({ seat: top!.seat, amount: excess });
}

function potsFor(hand: PokerHand, live: HandSeat[]): { amount: number; eligible: HandSeat[] }[] {
  const levels = [...new Set(hand.seats.map((player) => player.committed))].filter((total) => total > 0).sort((a, b) => a - b);
  const pots: { amount: number; eligible: HandSeat[] }[] = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = hand.seats.filter((player) => player.committed >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    const eligible = live.length === 1 ? live : live.filter((player) => player.committed >= level);
    if (!eligible.length) throw new Error('A poker side pot has no eligible player.');
    const last = pots.at(-1);
    // A folded player's contribution can create a layer without changing who can win it.
    if (last?.eligible.length === eligible.length) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  return pots;
}

function settle(hand: PokerHand, live: HandSeat[]): void {
  const showdown = live.length > 1;
  const ranks = new Map(live.map((player) => [player.seat, showdown ? bestHand([...hand.board, ...player.cards]).score : 0]));
  const payouts = new Map<number, number>();
  const pots = potsFor(hand, live).map(({ amount, eligible }): PokerPot => {
    const best = Math.max(...eligible.map((player) => ranks.get(player.seat)!));
    const winners = leftOf(eligible.filter((player) => ranks.get(player.seat) === best), hand.dealer);
    const equal = Math.floor(amount / winners.length);
    const remainder = amount % winners.length;
    for (const [i, winner] of winners.entries()) {
      const share = equal + (i < remainder ? 1 : 0);
      winner.stack += share;
      payouts.set(winner.seat, (payouts.get(winner.seat) ?? 0) + share);
    }
    return { amount, eligible: eligible.map((player) => player.seat), winners: winners.map((player) => player.seat) };
  });
  hand.result = { showdown, pots, payouts: [...payouts].map(([seat, amount]) => ({ seat, amount })), refunds: [...hand.refunds] };
  hand.actor = null;
  hand.street = 'complete';
}

/** Explicit projection for public messages, renders, recordings and spectators. */
export function publicPokerHand(hand: PokerHand) {
  return {
    seq: hand.seq, street: hand.street, actor: hand.actor, dealer: hand.dealer,
    smallBlindSeat: hand.smallBlindSeat, bigBlindSeat: hand.bigBlindSeat,
    board: [...hand.board], currentBet: hand.currentBet, lastAction: hand.lastAction && { ...hand.lastAction },
    seats: hand.seats.map((player) => ({
      userId: player.userId, seat: player.seat, stack: player.stack, streetPaid: player.streetPaid,
      committed: player.committed, folded: player.folded,
      cards: hand.result?.showdown && !player.folded ? [...player.cards] : null,
    })),
    result: hand.result ? structuredClone(hand.result) : null,
  };
}

/** Pass the authenticated Discord viewer's ID. No method returns an opponent's private cards. */
export function privatePokerHand(hand: PokerHand, userId: string) {
  const player = hand.seats.find((seat) => seat.userId === userId);
  return player ? { cards: [...player.cards], legal: pokerActions(hand, userId) } : null;
}
