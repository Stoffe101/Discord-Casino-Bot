import { describeTotal, handValue, isNaturalCards } from '../games/blackjack/engine.js';
import type { BlackjackRules, HandOutcome } from '../games/blackjack/engine.js';
import type { Card } from '../games/cards.js';
import { signedChips } from '../core/format.js';
import type { TableSnapshot } from './types.js';

export type BadgeTone = 'gold' | 'good' | 'bad' | 'neutral' | 'info';

export interface Badge {
  text: string;
  tone: BadgeTone;
}

export interface HandView {
  cards: Card[];
  total: string;
  bet: number;
  active: boolean;
  doubled: boolean;
  badge: Badge | null;
  dim: boolean;
}

export interface SeatView {
  seatIndex: number;
  userId: string | null;
  name: string;
  hands: HandView[];
  bet: number | null;
  status: Badge | null;
  active: boolean;
  net: number | null;
}

export interface DealerView {
  /** null entries are face-down cards. */
  cards: (Card | null)[];
  total: string | null;
  badge: Badge | null;
}

export type TableViewMode = 'waiting' | 'betting' | 'insurance' | 'playing' | 'reveal' | 'results';

export interface TableView {
  id: string;
  name: string;
  number: number;
  feltId: string;
  cardBackId: string;
  maxSeats: number;
  minBet: number;
  maxBet: number;
  mode: TableViewMode;
  roundNumber: number;
  rulesArc: string;
  dealer: DealerView;
  seats: SeatView[];
  activeUserId: string | null;
  deadline: number | null;
}

const OUTCOME_BADGE: Record<HandOutcome, (total: number) => Badge> = {
  blackjack: () => ({ text: 'BLACKJACK', tone: 'gold' }),
  win: (total) => ({ text: `${total} · WIN`, tone: 'good' }),
  push: (total) => ({ text: `${total} · PUSH`, tone: 'neutral' }),
  lose: (total) => ({ text: `${total} · LOSE`, tone: 'bad' }),
  bust: (total) => ({ text: `BUST · ${total}`, tone: 'bad' }),
  surrender: () => ({ text: 'SURRENDER', tone: 'neutral' }),
};

export function netBadge(net: number): Badge {
  if (net > 0) return { text: signedChips(net), tone: 'good' };
  if (net < 0) return { text: signedChips(net), tone: 'bad' };
  return { text: 'EVEN', tone: 'neutral' };
}

export function rulesArcText(rules: Pick<BlackjackRules, 'blackjackPayout' | 'dealerHitsSoft17' | 'insurance'>): string {
  const { numerator, denominator } = rules.blackjackPayout;
  return [
    `BLACKJACK PAYS ${numerator} TO ${denominator}`,
    rules.dealerHitsSoft17 ? 'DEALER HITS SOFT 17' : 'DEALER STANDS ON ALL 17s',
    rules.insurance ? 'INSURANCE PAYS 2 TO 1' : 'NO INSURANCE',
  ].join('  ·  ');
}

/**
 * Build the presentation model for a table. `revealStep` renders an intermediate frame of the
 * dealer's reveal (0 = hole card turned, 1 = first extra card, ...) from the last result.
 */
export function buildTableView(
  snapshot: Readonly<TableSnapshot>,
  rules: Pick<BlackjackRules, 'blackjackPayout' | 'dealerHitsSoft17' | 'insurance'>,
  options: { revealStep?: number } = {},
): TableView {
  const { record, state } = snapshot;
  const base = {
    id: record.id,
    name: record.name,
    number: record.number,
    feltId: record.config.feltId,
    cardBackId: record.config.cardBackId,
    maxSeats: record.config.maxSeats,
    minBet: record.config.minBet,
    maxBet: record.config.maxBet,
    rulesArc: rulesArcText(rules),
    deadline: state.deadline,
  };
  const emptySeat = (seatIndex: number): SeatView => ({
    seatIndex,
    userId: null,
    name: 'Open seat',
    hands: [],
    bet: null,
    status: null,
    active: false,
    net: null,
  });
  const seats: SeatView[] = Array.from({ length: record.config.maxSeats }, (_, i) => emptySeat(i));

  // ── A round is in progress ──
  if ((state.phase === 'playing' || state.phase === 'insurance') && state.round) {
    const round = state.round;
    const activeUser = round.turn ? round.seats[round.turn.seat]!.userId : null;
    for (const seat of state.seats) {
      if (seat.seatIndex >= seats.length) continue;
      const rs = round.seats.find((r) => r.userId === seat.userId);
      const view = seats[seat.seatIndex]!;
      view.userId = seat.userId;
      view.name = seat.displayName;
      if (!rs) {
        view.status = { text: seat.leaving ? 'LEAVING' : 'NEXT HAND', tone: 'info' };
        continue;
      }
      view.bet = rs.hands.reduce((sum, h) => sum + h.bet, 0);
      view.active = rs.userId === activeUser;
      view.hands = rs.hands.map((hand, index) => {
        const active = view.active && round.turn?.hand === index;
        const { total } = handValue(hand.cards);
        let badge: Badge | null = null;
        if (hand.surrendered) badge = { text: 'SURRENDERED', tone: 'neutral' };
        else if (total > 21) badge = { text: `BUST · ${total}`, tone: 'bad' };
        else if (!hand.fromSplit && isNaturalCards(hand.cards)) badge = { text: 'BLACKJACK', tone: 'gold' };
        else if (hand.doubled) badge = { text: `${total} · DOUBLED`, tone: 'info' };
        else if (hand.done && !active) badge = { text: `${total} · STAND`, tone: 'neutral' };
        return {
          cards: hand.cards,
          total: describeTotal(hand.cards, hand.fromSplit),
          bet: hand.bet,
          active,
          doubled: hand.doubled,
          badge,
          dim: total > 21 || hand.surrendered,
        };
      });
      if (state.phase === 'insurance') {
        const d = rs.insurance.decision;
        view.status =
          d === 'pending' ? { text: 'INSURANCE?', tone: 'info' } : d === 'taken' ? { text: 'INSURED', tone: 'gold' } : { text: 'NO INSURANCE', tone: 'neutral' };
      } else if (view.active) {
        view.status = { text: 'TO ACT', tone: 'gold' };
      }
    }
    const dealerCards: (Card | null)[] = round.holeRevealed ? [...round.dealer] : [round.dealer[0]!, null];
    const upTotal = round.holeRevealed ? describeTotal(round.dealer) : describeTotal([round.dealer[0]!]);
    return {
      ...base,
      mode: state.phase,
      roundNumber: state.roundNumber,
      dealer: { cards: dealerCards, total: upTotal, badge: null },
      seats,
      activeUserId: activeUser,
    };
  }

  // ── Between rounds: show the last result (or its reveal frames) ──
  const result = state.lastResult;
  if (result && !result.voided) {
    const reveal = options.revealStep;
    const revealing = reveal !== undefined;
    const shownDealer = revealing ? result.dealerCards.slice(0, Math.min(result.dealerCards.length, 2 + reveal)) : result.dealerCards;
    const finalFrame = !revealing || shownDealer.length >= result.dealerCards.length;
    for (const rs of result.seats) {
      if (rs.seatIndex >= seats.length) continue;
      const view = seats[rs.seatIndex]!;
      view.userId = rs.userId;
      view.name = rs.displayName;
      view.bet = rs.wagered;
      view.net = revealing ? null : rs.net;
      view.hands = rs.hands.map((hand) => {
        // Outcome badges appear only on the final (non-reveal) results frame.
        const show = !revealing;
        const naturalOrBust: Badge | null =
          hand.total > 21 ? { text: `BUST · ${hand.total}`, tone: 'bad' } : hand.outcome === 'blackjack' ? { text: 'BLACKJACK', tone: 'gold' } : null;
        return {
          cards: hand.cards,
          total: describeTotal(hand.cards, hand.fromSplit),
          bet: hand.bet,
          active: false,
          doubled: hand.doubled,
          badge: show ? OUTCOME_BADGE[hand.outcome](hand.total) : naturalOrBust,
          dim: show ? hand.outcome === 'lose' || hand.outcome === 'bust' : hand.total > 21,
        };
      });
      if (!revealing) view.status = netBadge(rs.net);
    }
    // Seated players who sat this hand out still appear in their seats.
    for (const seat of state.seats) {
      const view = seats[seat.seatIndex];
      if (!view || view.userId) continue;
      view.userId = seat.userId;
      view.name = seat.displayName;
      view.status = seat.sittingOut ? { text: 'SITTING OUT', tone: 'neutral' } : { text: 'NEXT HAND', tone: 'info' };
    }
    const dealerTotal = describeTotal(shownDealer);
    const dealerBadge: Badge | null = !finalFrame
      ? null
      : result.dealerBlackjack
        ? { text: 'BLACKJACK', tone: 'bad' }
        : result.dealerBust
          ? { text: 'DEALER BUSTS', tone: 'good' }
          : null;
    return {
      ...base,
      mode: revealing ? 'reveal' : 'results',
      roundNumber: result.roundNumber,
      dealer: { cards: shownDealer, total: dealerTotal, badge: dealerBadge },
      seats,
      activeUserId: null,
    };
  }

  // ── Fresh table waiting for bets ──
  for (const seat of state.seats) {
    const view = seats[seat.seatIndex];
    if (!view) continue;
    view.userId = seat.userId;
    view.name = seat.displayName;
    const bet = state.bets[seat.userId] ?? null;
    view.bet = bet;
    view.status = bet
      ? { text: 'READY', tone: 'good' }
      : seat.sittingOut
        ? { text: 'SITTING OUT', tone: 'neutral' }
        : { text: 'NO BET YET', tone: 'info' };
  }
  return {
    ...base,
    mode: Object.keys(state.bets).length > 0 ? 'betting' : 'waiting',
    roundNumber: state.roundNumber,
    dealer: { cards: [], total: null, badge: null },
    seats,
    activeUserId: null,
  };
}

/** Plain-text description of the table for image alt text (screen readers). */
export function describeTableForAlt(view: TableView): string {
  const parts: string[] = [];
  const dealer = view.dealer.cards.length
    ? `Dealer: ${view.dealer.cards.map((c) => c ?? 'face-down card').join(', ')}${view.dealer.total ? ` (${view.dealer.total})` : ''}.`
    : 'Dealer waiting.';
  parts.push(dealer);
  for (const seat of view.seats) {
    if (!seat.userId) continue;
    const hands = seat.hands.map((h) => `${h.cards.join(' ')} = ${h.total}${h.badge ? ` ${h.badge.text}` : ''}`).join('; ');
    parts.push(`${seat.name}: ${hands || (seat.status?.text ?? '')}`);
  }
  return parts.join(' ').slice(0, 1000);
}
