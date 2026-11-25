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
  /** Every chip this player put in this hand, dead blinds included. */
  committed: number;
  /** Dead blind chips inside `committed`: they always play in the main pot and never count as a bet. */
  dead?: number;
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
  /** The button seat. Under the dead-button rule it can be an empty seat or a seat not dealt in. */
  dealer: number;
  /** Null when the small blind is dead (last hand's big blind is not in this hand). */
  smallBlindSeat: number | null;
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

/**
 * Who has the button and the blinds in one hand.
 *
 * Cash-game blind rule: the "dead button" rule (TDA, Robert's Rules of Poker, the large online rooms).
 * - The big blind moves forward exactly one player every hand: to the first player after last hand's
 *   big blind who is in the game. Nobody can skip it and nobody posts it twice in a row.
 * - The small blind is posted by last hand's big blind. If that player is not in this hand (left or
 *   sitting out), nobody posts a small blind: it is "dead" (`smallBlind: null`).
 * - The button goes to last hand's small-blind seat, even when that seat is now empty or not dealt in
 *   (a "dead" button). When that seat no longer sits behind the small blind (straight after a heads-up
 *   hand), the button goes to the nearest player dealt in behind the small blind.
 * - Heads-up, the button posts the small blind and acts first before the flop.
 */
export interface BlindPositions {
  button: number;
  smallBlind: number | null;
  bigBlind: number;
}

/** An out-of-turn post by a player entering the game: `live` counts toward their bet, `dead` goes into the main pot. */
export interface PokerPost {
  seat: number;
  live: number;
  dead: number;
}

function leftOf<T extends { seat: number }>(players: readonly T[], button: number): T[] {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  return [...sorted.filter((player) => player.seat > button), ...sorted.filter((player) => player.seat <= button)];
}

/** True when `seat` lies strictly after `from` and strictly before `to`, going clockwise. */
export function seatBetween(from: number, seat: number, to: number): boolean {
  return from < to ? seat > from && seat < to : seat > from || seat < to;
}

/** Positions when the blinds simply follow a seated button (the first hand at a table). */
export function livePositions(seats: readonly { seat: number }[], button: number): BlindPositions {
  const order = leftOf(seats, button);
  return seats.length === 2
    ? { button, smallBlind: button, bigBlind: order[0]!.seat }
    : { button, smallBlind: order[0]!.seat, bigBlind: order[1]!.seat };
}

/** The big blind goes to the first candidate after last hand's big blind (that seat itself comes last). */
export function nextBigBlind(candidates: readonly { seat: number }[], previousBigBlind: number): number {
  if (!candidates.length) throw new RangeError('Poker needs a player for the big blind.');
  return leftOf(candidates, previousBigBlind)[0]!.seat;
}

/**
 * Button and small blind once the big blind is chosen, under the dead-button rule. `dealtIn` are the
 * players receiving cards; `previous` holds last hand's big-blind seat and small-blind seat (the
 * seat even when that small blind was dead).
 */
export function blindPositions(
  dealtIn: readonly { seat: number }[],
  bigBlind: number,
  previous: { bigBlind: number; smallBlind?: number | null },
): BlindPositions {
  if (dealtIn.length < 2 || !dealtIn.some((player) => player.seat === bigBlind)) throw new RangeError('Poker needs two players and a seated big blind.');
  if (dealtIn.length === 2) {
    const other = dealtIn.find((player) => player.seat !== bigBlind)!.seat;
    return { button: other, smallBlind: other, bigBlind };
  }
  const smallSeat = previous.bigBlind;
  const smallBlind = smallSeat !== bigBlind && dealtIn.some((player) => player.seat === smallSeat) ? smallSeat : null;
  const lastSmall = previous.smallBlind;
  if (lastSmall !== undefined && lastSmall !== null && seatBetween(bigBlind, lastSmall, smallSeat)) return { button: lastSmall, smallBlind, bigBlind };
  const behind = leftOf(dealtIn.filter((player) => player.seat !== bigBlind && player.seat !== smallSeat), smallSeat).at(-1)!;
  return { button: behind.seat, smallBlind, bigBlind };
}

/**
 * Positions for the next hand when every seat given is dealt in. Pass last hand's button and big
 * blind, plus its small-blind seat when known; with no previous big blind the button moves one seat.
 */
export function nextDealer(seats: readonly PokerSeat[], previousDealer: number, previousBigBlind?: number, previousSmallBlind?: number | null): BlindPositions {
  if (seats.length < 2) throw new RangeError('Poker needs at least two active players.');
  if (previousBigBlind === undefined) return livePositions(seats, leftOf(seats, previousDealer)[0]!.seat);
  return blindPositions(seats, nextBigBlind(seats, previousBigBlind), { bigBlind: previousBigBlind, smallBlind: previousSmallBlind });
}

/**
 * Deal a hand. `dealer` is either a seated button (the blinds are the next players; heads-up the
 * button posts the small blind) or explicit dead-button positions. `posts` are out-of-turn blinds from
 * players entering the game; a post must leave the player at least one chip behind.
 */
export function dealPoker(
  seats: readonly PokerSeat[],
  dealer: number | BlindPositions,
  smallBlind: number,
  bigBlind: number,
  rng?: Rng,
  posts: readonly PokerPost[] = [],
): PokerHand {
  const total = seats.reduce((sum, player) => sum + player.stack, 0);
  if (!Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind) || smallBlind <= 0 || bigBlind <= smallBlind || bigBlind > Number.MAX_SAFE_INTEGER / 2) {
    throw new RangeError('Poker requires valid small and big blinds.');
  }
  const seated = (seat: number | null) => seats.some((player) => player.seat === seat);
  if (seats.length < 2 || seats.length > 9 || !Number.isSafeInteger(total)
    || new Set(seats.map((player) => player.seat)).size !== seats.length
    || new Set(seats.map((player) => player.userId)).size !== seats.length
    || (typeof dealer === 'number' && !seated(dealer))
    || seats.some((player) => !player.userId || !Number.isSafeInteger(player.seat) || player.seat < 0 || !Number.isSafeInteger(player.stack) || player.stack <= 0)) {
    throw new RangeError('Poker requires two to nine distinct, funded seats and a seated dealer.');
  }
  const { button, smallBlind: smallBlindSeat, bigBlind: bigBlindSeat } = typeof dealer === 'number' ? livePositions(seats, dealer) : dealer;
  if (!Number.isSafeInteger(button) || button < 0 || !seated(bigBlindSeat) || smallBlindSeat === bigBlindSeat
    || (smallBlindSeat !== null && !seated(smallBlindSeat))
    || (seats.length === 2 && (smallBlindSeat !== button || !seated(button)))) {
    throw new RangeError('Poker requires a seated big blind, a seated or dead small blind, and heads-up the small blind on the button.');
  }
  const stackOf = (seat: number) => seats.find((player) => player.seat === seat)?.stack ?? 0;
  if (new Set(posts.map((post) => post.seat)).size !== posts.length || posts.some((post) => !seated(post.seat)
    || post.seat === bigBlindSeat || post.seat === smallBlindSeat
    || !Number.isSafeInteger(post.live) || !Number.isSafeInteger(post.dead) || post.live < 0 || post.dead < 0
    || post.live > bigBlind || post.dead > smallBlind || post.live + post.dead === 0 || post.live + post.dead >= stackOf(post.seat))) {
    throw new RangeError('Poker posts must come from other seated players and leave chips behind.');
  }
  const deck = createShoe(1, rng);
  const order = leftOf(seats, button);
  const hand: PokerHand = {
    seq: 0, street: 'preflop', dealer: button, smallBlindSeat, bigBlindSeat, bigBlind, currentBet: bigBlind,
    fullRaise: bigBlind, actor: null, board: [], deck, cursor: seats.length * 2, refunds: [], result: null, lastAction: null,
    seats: order.map((player, i): HandSeat => ({
      ...player, cards: [deck[i]!, deck[i + seats.length]!], streetPaid: 0, committed: 0, dead: 0, actedAt: null, folded: false,
    })).sort((a, b) => a.seat - b.seat),
  };
  for (const player of hand.seats) {
    const blind = player.seat === smallBlindSeat ? smallBlind : player.seat === bigBlindSeat ? bigBlind : 0;
    pay(player, Math.min(blind, player.stack));
  }
  for (const post of posts) {
    const player = hand.seats.find((seat) => seat.seat === post.seat)!;
    // A live post is a bet: it counts toward a call, and the poster may still raise when the action reaches them.
    pay(player, post.live);
    player.stack -= post.dead;
    player.committed += post.dead;
    player.dead = post.dead;
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
  // Side pots are layered on bets only; dead blinds belong to the main pot, whoever wins it.
  const bet = (player: HandSeat) => player.committed - (player.dead ?? 0);
  const dead = hand.seats.reduce((sum, player) => sum + (player.dead ?? 0), 0);
  const levels = [...new Set(hand.seats.map(bet))].filter((total) => total > 0).sort((a, b) => a - b);
  const pots: { amount: number; eligible: HandSeat[] }[] = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = hand.seats.filter((player) => bet(player) >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    const eligible = live.length === 1 ? live : live.filter((player) => bet(player) >= level);
    if (!eligible.length) throw new Error('A poker side pot has no eligible player.');
    const last = pots.at(-1);
    // A folded player's contribution can create a layer without changing who can win it.
    if (last?.eligible.length === eligible.length) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  // Everyone folded to an uncalled big blind with no small blind: only dead money (if any) is left.
  if (!pots.length) return dead ? [{ amount: dead, eligible: live }] : [];
  pots[0]!.amount += dead;
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
