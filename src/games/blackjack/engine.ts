/**
 * Blackjack rules engine — pure TypeScript, no Discord, no database.
 *
 * Every exported operation takes a RoundState and returns a NEW RoundState (the input is
 * never mutated), so callers can compute a transition, persist it atomically, and only then
 * make it visible. Illegal moves throw BlackjackRuleError (a UserError with a friendly text).
 *
 * House rules implemented (all configurable through BlackjackRules):
 *   - multi-deck shoe (default 6), reshuffle at a penetration threshold
 *   - dealer stands on soft 17 by default (H17 optional)
 *   - natural blackjack pays 3:2 (6:5 optional); fractions of a chip are rounded down
 *   - US hole-card game: the dealer peeks with an ace or ten up, so a dealer blackjack only
 *     ever takes the original bets (no doubles/splits are lost to it)
 *   - double on any first two cards; double after split optional (default on)
 *   - split identical ranks up to N hands (default 4); split aces receive one card each and
 *     cannot be hit; resplitting aces optional (default off); 21 after a split is not blackjack
 *   - late surrender on the first two cards (returns half the bet, rounded down)
 *   - insurance when the dealer shows an ace: costs half the bet (rounded down), pays 2:1
 */
import { UserError } from '../../core/errors.js';
import { secureRng, type Rng } from '../../core/random.js';
import { createShoe, rankOf, type Card } from '../cards.js';

export interface BlackjackRules {
  decks: number;
  dealerHitsSoft17: boolean;
  blackjackPayout: { numerator: number; denominator: number };
  doubleAfterSplit: boolean;
  surrender: boolean;
  insurance: boolean;
  /** Maximum number of hands a player can hold after splitting (2 = no resplits). */
  maxSplitHands: number;
  resplitAces: boolean;
  /** Fraction of the shoe dealt before a reshuffle (0.5 – 0.9). */
  penetration: number;
}

export const DEFAULT_RULES: BlackjackRules = {
  decks: 6,
  dealerHitsSoft17: false,
  blackjackPayout: { numerator: 3, denominator: 2 },
  doubleAfterSplit: true,
  surrender: true,
  insurance: true,
  maxSplitHands: 4,
  resplitAces: false,
  penetration: 0.75,
};

export type PlayerAction = 'hit' | 'stand' | 'double' | 'split' | 'surrender';
export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'surrender';

export interface HandResult {
  outcome: HandOutcome;
  /** Total chips returned to the player for this hand, stake included. */
  payout: number;
}

export interface PlayerHand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  fromSplit: boolean;
  splitAces: boolean;
  surrendered: boolean;
  done: boolean;
  result?: HandResult;
}

export interface InsuranceState {
  decision: 'none' | 'pending' | 'taken' | 'declined';
  amount: number;
  payout?: number;
}

export interface RoundSeat {
  userId: string;
  seatIndex: number;
  hands: PlayerHand[];
  insurance: InsuranceState;
}

export type RoundPhase = 'insurance' | 'playing' | 'dealer' | 'complete';

export type RoundEvent =
  | { t: 'reshuffle' }
  | { t: 'deal' }
  | { t: 'natural'; userId: string }
  | { t: 'insurance'; userId: string; taken: boolean; amount: number; auto?: boolean }
  | { t: 'peek'; dealerBlackjack: boolean }
  | { t: 'hit'; userId: string; hand: number; card: Card; total: number; soft: boolean }
  | { t: 'stand'; userId: string; hand: number; total: number; reason?: 'timeout' | 'leaving' | 'twentyone' }
  | { t: 'bust'; userId: string; hand: number; card: Card; total: number }
  | { t: 'double'; userId: string; hand: number; card: Card; total: number }
  | { t: 'split'; userId: string; hand: number; rank: string }
  | { t: 'surrender'; userId: string; hand: number }
  | { t: 'dealer_reveal'; card: Card; total: number; soft: boolean }
  | { t: 'dealer_hit'; card: Card; total: number }
  | { t: 'dealer_stand'; total: number }
  | { t: 'dealer_bust'; total: number };

export interface RoundState {
  id: string;
  rules: BlackjackRules;
  phase: RoundPhase;
  dealer: Card[];
  holeRevealed: boolean;
  dealerBlackjack: boolean;
  seats: RoundSeat[];
  turn: { seat: number; hand: number } | null;
  /** Remaining shoe; cards are drawn from the END of the array. */
  shoe: Card[];
  /** Total size of the shoe when it was last shuffled (for penetration). */
  shoeSize: number;
  events: RoundEvent[];
  /** Increments on every accepted state change (used to reject stale button presses). */
  seq: number;
}

export interface SeatSettlement {
  userId: string;
  seatIndex: number;
  /** Sum of all stakes committed: hand bets (incl. doubles/splits) plus insurance. */
  wagered: number;
  /** Total chips returned (stakes + winnings). */
  returned: number;
  net: number;
  hands: (HandResult & { cards: Card[]; bet: number; doubled: boolean; fromSplit: boolean; total: number })[];
  insurance: { amount: number; payout: number } | null;
}

export interface RoundSettlement {
  roundId: string;
  dealerCards: Card[];
  dealerTotal: number;
  dealerBlackjack: boolean;
  dealerBust: boolean;
  seats: SeatSettlement[];
}

export class BlackjackRuleError extends UserError {
  constructor(message: string, code = 'illegal_move') {
    super(message, code, 'Not allowed');
    this.name = 'BlackjackRuleError';
  }
}

// ───────────────────────────── hand maths ─────────────────────────────

export function cardPoints(card: Card): number {
  const rank = rankOf(card);
  if (rank === 'A') return 1;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

export function isTenValue(card: Card): boolean {
  return cardPoints(card) === 10;
}

/** Best blackjack total. `soft` means an ace is currently counted as 11. */
export function handValue(cards: readonly Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardPoints(card);
    if (rankOf(card) === 'A') aces++;
  }
  if (aces > 0 && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

export function isNaturalCards(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** A natural blackjack: first two cards totalling 21, not on a split hand. */
export function isNaturalHand(hand: PlayerHand): boolean {
  return !hand.fromSplit && isNaturalCards(hand.cards);
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

/** Display string such as "17", "soft 18", "Blackjack" or "Bust (24)". */
export function describeTotal(cards: readonly Card[], fromSplit = false): string {
  if (cards.length === 0) return '—';
  const { total, soft } = handValue(cards);
  if (!fromSplit && isNaturalCards(cards)) return 'Blackjack';
  if (total > 21) return `Bust (${total})`;
  return soft && total < 21 ? `soft ${total}` : String(total);
}

// ───────────────────────────── rules helpers ─────────────────────────────

export function needsReshuffle(shoe: readonly Card[], shoeSize: number, rules: BlackjackRules): boolean {
  if (shoeSize <= 0) return true;
  const dealt = shoeSize - shoe.length;
  return dealt / shoeSize >= rules.penetration;
}

export function blackjackWinnings(bet: number, rules: BlackjackRules): number {
  return Math.floor((bet * rules.blackjackPayout.numerator) / rules.blackjackPayout.denominator);
}

export function insuranceCost(bet: number): number {
  return Math.floor(bet / 2);
}

export function describeRules(rules: BlackjackRules): string[] {
  const { numerator, denominator } = rules.blackjackPayout;
  return [
    `${rules.decks}-deck shoe · reshuffle at ${Math.round(rules.penetration * 100)}%`,
    `Blackjack pays ${numerator}:${denominator}`,
    rules.dealerHitsSoft17 ? 'Dealer hits soft 17' : 'Dealer stands on all 17s',
    'Dealer peeks for blackjack',
    `Double on any two cards${rules.doubleAfterSplit ? ', also after splitting' : ''}`,
    `Split to ${rules.maxSplitHands} hands${rules.resplitAces ? ', aces may be resplit' : ''} · split aces get one card`,
    rules.surrender ? 'Late surrender (half back)' : 'No surrender',
    rules.insurance ? 'Insurance pays 2:1' : 'No insurance',
  ];
}

// ───────────────────────────── round lifecycle ─────────────────────────────

export interface StartRoundInput {
  id: string;
  rules: BlackjackRules;
  shoe: Card[];
  shoeSize: number;
  seats: { userId: string; seatIndex: number; bet: number }[];
}

/** Shuffle a fresh shoe if the penetration point was reached, deal two cards to everyone. */
export function startRound(input: StartRoundInput, rng: Rng = secureRng): RoundState {
  if (input.seats.length === 0) throw new BlackjackRuleError('Nobody has placed a bet.', 'no_bets');
  const seen = new Set<string>();
  for (const seat of input.seats) {
    if (!Number.isSafeInteger(seat.bet) || seat.bet <= 0) throw new BlackjackRuleError('Bets must be positive whole numbers.');
    if (seen.has(seat.userId)) throw new Error(`Player ${seat.userId} appears twice in one round`);
    seen.add(seat.userId);
  }
  const state: RoundState = {
    id: input.id,
    rules: structuredClone(input.rules),
    phase: 'playing',
    dealer: [],
    holeRevealed: false,
    dealerBlackjack: false,
    seats: [...input.seats]
      .sort((a, b) => a.seatIndex - b.seatIndex)
      .map((s) => ({
        userId: s.userId,
        seatIndex: s.seatIndex,
        hands: [{ cards: [], bet: s.bet, doubled: false, fromSplit: false, splitAces: false, surrendered: false, done: false }],
        insurance: { decision: 'none', amount: 0 },
      })),
    turn: null,
    shoe: [...input.shoe],
    shoeSize: input.shoeSize,
    events: [],
    seq: 0,
  };

  if (needsReshuffle(state.shoe, state.shoeSize, state.rules)) {
    state.shoe = createShoe(state.rules.decks, rng);
    state.shoeSize = state.shoe.length;
    state.events.push({ t: 'reshuffle' });
  }

  // Two passes: each player in seat order, then the dealer (up card first, hole card second).
  for (let pass = 0; pass < 2; pass++) {
    for (const seat of state.seats) seat.hands[0]!.cards.push(draw(state, rng));
    state.dealer.push(draw(state, rng));
  }
  state.events.push({ t: 'deal' });

  for (const seat of state.seats) {
    const hand = seat.hands[0]!;
    if (isNaturalHand(hand)) {
      hand.done = true;
      state.events.push({ t: 'natural', userId: seat.userId });
    }
  }

  const upCard = state.dealer[0]!;
  if (state.rules.insurance && rankOf(upCard) === 'A') {
    state.phase = 'insurance';
    for (const seat of state.seats) seat.insurance = { decision: 'pending', amount: 0 };
    return state;
  }
  peekAndContinue(state);
  return state;
}

/** Record one player's insurance decision. When everybody has decided, play continues. */
export function decideInsurance(round: RoundState, userId: string, take: boolean): RoundState {
  const state = structuredClone(round);
  if (state.phase !== 'insurance') throw new BlackjackRuleError('Insurance is not being offered right now.', 'stale');
  const seat = findSeat(state, userId);
  if (seat.insurance.decision !== 'pending') throw new BlackjackRuleError('You have already decided on insurance.', 'stale');
  const cost = insuranceCost(seat.hands[0]!.bet);
  if (take && cost <= 0) throw new BlackjackRuleError('Your bet is too small to insure.');
  seat.insurance = take ? { decision: 'taken', amount: cost } : { decision: 'declined', amount: 0 };
  state.events.push({ t: 'insurance', userId, taken: take, amount: take ? cost : 0 });
  state.seq++;
  if (state.seats.every((s) => s.insurance.decision !== 'pending')) peekAndContinue(state);
  return state;
}

/** Insurance window expired: everyone who has not decided declines. */
export function expireInsurance(round: RoundState): RoundState {
  const state = structuredClone(round);
  if (state.phase !== 'insurance') return state;
  for (const seat of state.seats) {
    if (seat.insurance.decision === 'pending') {
      seat.insurance = { decision: 'declined', amount: 0 };
      state.events.push({ t: 'insurance', userId: seat.userId, taken: false, amount: 0, auto: true });
    }
  }
  state.seq++;
  peekAndContinue(state);
  return state;
}

export interface ActionAvailability {
  hit: boolean;
  stand: boolean;
  double: boolean;
  split: boolean;
  surrender: boolean;
}

const NO_ACTIONS: ActionAvailability = { hit: false, stand: false, double: false, split: false, surrender: false };

/** Which actions the rules allow for this player right now (affordability is checked by the caller). */
export function availableActions(state: RoundState, userId: string): ActionAvailability {
  if (state.phase !== 'playing' || !state.turn) return NO_ACTIONS;
  const seat = state.seats[state.turn.seat]!;
  if (seat.userId !== userId) return NO_ACTIONS;
  const hand = seat.hands[state.turn.hand]!;
  if (hand.done) return NO_ACTIONS;
  const { total } = handValue(hand.cards);
  const twoCards = hand.cards.length === 2;
  const canSplit =
    twoCards &&
    rankOf(hand.cards[0]!) === rankOf(hand.cards[1]!) &&
    seat.hands.length < state.rules.maxSplitHands &&
    (!hand.splitAces || state.rules.resplitAces);
  if (hand.splitAces) {
    // A split ace that drew another ace may only be resplit or stood.
    return { hit: false, stand: true, double: false, split: canSplit, surrender: false };
  }
  return {
    hit: total < 21,
    stand: true,
    double: twoCards && (!hand.fromSplit || state.rules.doubleAfterSplit),
    split: canSplit,
    surrender: state.rules.surrender && twoCards && !hand.fromSplit && seat.hands.length === 1,
  };
}

/** Extra chips an action commits (double and split both match the hand's current bet). */
export function extraStakeFor(state: RoundState, action: PlayerAction): number {
  if (action !== 'double' && action !== 'split') return 0;
  if (!state.turn) return 0;
  return state.seats[state.turn.seat]!.hands[state.turn.hand]!.bet;
}

export function currentTurnUserId(state: RoundState): string | null {
  if (state.phase !== 'playing' || !state.turn) return null;
  return state.seats[state.turn.seat]!.userId;
}

/** Apply a player decision for the active hand. */
export function act(round: RoundState, userId: string, action: PlayerAction, rng: Rng = secureRng): RoundState {
  if (round.phase !== 'playing' || !round.turn) throw new BlackjackRuleError('There is no decision to make right now.', 'stale');
  const turnSeat = round.seats[round.turn.seat]!;
  if (turnSeat.userId !== userId) throw new BlackjackRuleError("It isn't your turn.", 'not_your_turn');
  const allowed = availableActions(round, userId);
  if (!allowed[action]) throw new BlackjackRuleError(illegalActionMessage(action));

  const state = structuredClone(round);
  const seat = state.seats[state.turn!.seat]!;
  const handIndex = state.turn!.hand;
  const hand = seat.hands[handIndex]!;

  switch (action) {
    case 'hit': {
      const card = draw(state, rng);
      hand.cards.push(card);
      const { total, soft } = handValue(hand.cards);
      if (total > 21) {
        hand.done = true;
        state.events.push({ t: 'bust', userId, hand: handIndex, card, total });
      } else {
        state.events.push({ t: 'hit', userId, hand: handIndex, card, total, soft });
        if (total === 21) {
          hand.done = true;
          state.events.push({ t: 'stand', userId, hand: handIndex, total, reason: 'twentyone' });
        }
      }
      break;
    }
    case 'stand': {
      hand.done = true;
      state.events.push({ t: 'stand', userId, hand: handIndex, total: handValue(hand.cards).total });
      break;
    }
    case 'double': {
      hand.bet *= 2;
      hand.doubled = true;
      const card = draw(state, rng);
      hand.cards.push(card);
      hand.done = true;
      const { total } = handValue(hand.cards);
      state.events.push({ t: 'double', userId, hand: handIndex, card, total });
      if (total > 21) state.events.push({ t: 'bust', userId, hand: handIndex, card, total });
      break;
    }
    case 'split': {
      const [first, second] = hand.cards as [Card, Card];
      const aces = rankOf(first) === 'A';
      const make = (card: Card): PlayerHand => ({
        cards: [card],
        bet: hand.bet,
        doubled: false,
        fromSplit: true,
        splitAces: aces,
        surrendered: false,
        done: false,
      });
      const left = make(first);
      const right = make(second);
      seat.hands.splice(handIndex, 1, left, right);
      state.events.push({ t: 'split', userId, hand: handIndex, rank: rankOf(first) });
      for (const h of [left, right]) {
        h.cards.push(draw(state, rng));
        const { total } = handValue(h.cards);
        if (aces) {
          const canResplit =
            state.rules.resplitAces && rankOf(h.cards[1]!) === 'A' && seat.hands.length < state.rules.maxSplitHands;
          h.done = !canResplit;
        } else if (total === 21) {
          h.done = true;
        }
      }
      break;
    }
    case 'surrender': {
      hand.surrendered = true;
      hand.done = true;
      state.events.push({ t: 'surrender', userId, hand: handIndex });
      break;
    }
  }
  state.seq++;
  advanceTurn(state);
  return state;
}

/** Stand every unfinished hand of a player (turn timer expired, or the player is leaving). */
export function standAllHands(round: RoundState, userId: string, reason: 'timeout' | 'leaving'): RoundState {
  const state = structuredClone(round);
  const seat = state.seats.find((s) => s.userId === userId);
  if (!seat) return state;
  if (state.phase === 'insurance' && seat.insurance.decision === 'pending') {
    seat.insurance = { decision: 'declined', amount: 0 };
    state.events.push({ t: 'insurance', userId, taken: false, amount: 0, auto: true });
    if (state.seats.every((s) => s.insurance.decision !== 'pending')) peekAndContinue(state);
  }
  let changed = false;
  seat.hands.forEach((hand, index) => {
    if (!hand.done) {
      hand.done = true;
      changed = true;
      state.events.push({ t: 'stand', userId, hand: index, total: handValue(hand.cards).total, reason });
    }
  });
  if (changed) {
    state.seq++;
    if (state.phase === 'playing') advanceTurn(state);
  }
  return state;
}

/** Reveal the hole card and draw to the dealer's rule. Requires every player hand finished. */
export function playDealer(round: RoundState, rng: Rng = secureRng): RoundState {
  if (round.phase !== 'dealer') throw new Error(`playDealer called in phase ${round.phase}`);
  const state = structuredClone(round);
  state.holeRevealed = true;
  const reveal = handValue(state.dealer);
  state.events.push({ t: 'dealer_reveal', card: state.dealer[1]!, total: reveal.total, soft: reveal.soft });

  const live = state.seats.some((seat) => seat.hands.some((h) => !h.surrendered && !isBust(h.cards) && !isNaturalHand(h)));
  if (live) {
    for (;;) {
      const { total, soft } = handValue(state.dealer);
      const mustHit = total < 17 || (total === 17 && soft && state.rules.dealerHitsSoft17);
      if (!mustHit) break;
      const card = draw(state, rng);
      state.dealer.push(card);
      state.events.push({ t: 'dealer_hit', card, total: handValue(state.dealer).total });
    }
  }
  const final = handValue(state.dealer).total;
  state.events.push(final > 21 ? { t: 'dealer_bust', total: final } : { t: 'dealer_stand', total: final });
  state.phase = 'complete';
  state.seq++;
  return state;
}

/** Compute every hand's outcome and payout. Pure: the economy applies the numbers. */
export function settleRound(round: RoundState): { state: RoundState; settlement: RoundSettlement } {
  if (round.phase !== 'complete') throw new Error(`settleRound called in phase ${round.phase}`);
  const state = structuredClone(round);
  state.holeRevealed = true;
  const dealer = handValue(state.dealer);
  const dealerBust = dealer.total > 21;
  const dealerBlackjack = isNaturalCards(state.dealer);

  const seats: SeatSettlement[] = state.seats.map((seat) => {
    let wagered = 0;
    let returned = 0;
    const hands = seat.hands.map((hand) => {
      const result = resolveHand(hand, dealer.total, dealerBust, dealerBlackjack, state.rules);
      hand.result = result;
      wagered += hand.bet;
      returned += result.payout;
      return {
        ...result,
        cards: [...hand.cards],
        bet: hand.bet,
        doubled: hand.doubled,
        fromSplit: hand.fromSplit,
        total: handValue(hand.cards).total,
      };
    });
    let insurance: SeatSettlement['insurance'] = null;
    if (seat.insurance.decision === 'taken' && seat.insurance.amount > 0) {
      const payout = dealerBlackjack ? seat.insurance.amount * 3 : 0;
      seat.insurance.payout = payout;
      wagered += seat.insurance.amount;
      returned += payout;
      insurance = { amount: seat.insurance.amount, payout };
    }
    return { userId: seat.userId, seatIndex: seat.seatIndex, wagered, returned, net: returned - wagered, hands, insurance };
  });

  return {
    state,
    settlement: {
      roundId: state.id,
      dealerCards: [...state.dealer],
      dealerTotal: dealer.total,
      dealerBlackjack,
      dealerBust,
      seats,
    },
  };
}

function resolveHand(
  hand: PlayerHand,
  dealerTotal: number,
  dealerBust: boolean,
  dealerBlackjack: boolean,
  rules: BlackjackRules,
): HandResult {
  if (hand.surrendered) return { outcome: 'surrender', payout: Math.floor(hand.bet / 2) };
  const { total } = handValue(hand.cards);
  if (total > 21) return { outcome: 'bust', payout: 0 };
  const natural = isNaturalHand(hand);
  if (natural && dealerBlackjack) return { outcome: 'push', payout: hand.bet };
  if (natural) return { outcome: 'blackjack', payout: hand.bet + blackjackWinnings(hand.bet, rules) };
  if (dealerBlackjack) return { outcome: 'lose', payout: 0 };
  if (dealerBust || total > dealerTotal) return { outcome: 'win', payout: hand.bet * 2 };
  if (total === dealerTotal) return { outcome: 'push', payout: hand.bet };
  return { outcome: 'lose', payout: 0 };
}

// ───────────────────────────── internals ─────────────────────────────

function findSeat(state: RoundState, userId: string): RoundSeat {
  const seat = state.seats.find((s) => s.userId === userId);
  if (!seat) throw new BlackjackRuleError("You aren't playing in this round.", 'not_in_round');
  return seat;
}

function peekAndContinue(state: RoundState): void {
  const upCard = state.dealer[0]!;
  const peeks = rankOf(upCard) === 'A' || isTenValue(upCard);
  state.dealerBlackjack = peeks && isNaturalCards(state.dealer);
  if (peeks) state.events.push({ t: 'peek', dealerBlackjack: state.dealerBlackjack });
  if (state.dealerBlackjack) {
    state.holeRevealed = true;
    for (const seat of state.seats) for (const hand of seat.hands) hand.done = true;
    state.turn = null;
    state.phase = 'complete';
    return;
  }
  state.phase = 'playing';
  advanceTurn(state);
}

function advanceTurn(state: RoundState): void {
  for (let s = 0; s < state.seats.length; s++) {
    const hands = state.seats[s]!.hands;
    for (let h = 0; h < hands.length; h++) {
      if (!hands[h]!.done) {
        state.turn = { seat: s, hand: h };
        state.phase = 'playing';
        return;
      }
    }
  }
  state.turn = null;
  state.phase = 'dealer';
}

/** Draw from the shoe. If it somehow runs dry mid-round, shuffle a new shoe without the cards in play. */
function draw(state: RoundState, rng: Rng): Card {
  if (state.shoe.length === 0) {
    const inPlay = [...state.dealer, ...state.seats.flatMap((s) => s.hands.flatMap((h) => h.cards))];
    const fresh = createShoe(state.rules.decks, rng);
    for (const card of inPlay) {
      const idx = fresh.indexOf(card);
      if (idx >= 0) fresh.splice(idx, 1);
    }
    state.shoe = fresh;
    state.shoeSize = fresh.length + inPlay.length;
    state.events.push({ t: 'reshuffle' });
  }
  return state.shoe.pop()!;
}

function illegalActionMessage(action: PlayerAction): string {
  switch (action) {
    case 'hit':
      return "You can't take another card on this hand.";
    case 'stand':
      return 'This hand is already finished.';
    case 'double':
      return 'Doubling is only allowed on your first two cards.';
    case 'split':
      return 'Only a pair of matching cards can be split (and only up to the hand limit).';
    case 'surrender':
      return 'Surrender is only allowed as your first decision on an unsplit hand.';
  }
}
