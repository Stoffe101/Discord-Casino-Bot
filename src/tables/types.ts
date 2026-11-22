import type { Card } from '../games/cards.js';
import type { HandOutcome, RoundState } from '../games/blackjack/engine.js';

export interface SeatInfo {
  userId: string;
  seatIndex: number;
  displayName: string;
  joinedAt: number;
  /** Skipped when waiting for bets (set after repeated timeouts or by the player). */
  sittingOut: boolean;
  /** Leave as soon as the current round finishes. */
  leaving: boolean;
  /** Consecutive turn timeouts. */
  timeouts: number;
  /** Consecutive hands dealt without this player betting. */
  missedRounds: number;
  lastBet: number | null;
}

export interface TableConfig {
  minBet: number;
  maxBet: number;
  maxSeats: number;
  feltId: string;
  cardBackId: string;
}

export interface LogEntry {
  at: number;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'gold';
}

export interface ResultHand {
  cards: Card[];
  bet: number;
  outcome: HandOutcome;
  payout: number;
  total: number;
  doubled: boolean;
  fromSplit: boolean;
}

export interface ResultSeat {
  userId: string;
  seatIndex: number;
  displayName: string;
  hands: ResultHand[];
  insurance: { amount: number; payout: number } | null;
  wagered: number;
  returned: number;
  net: number;
  xpGained: number;
  levelUp: number | null;
  achievements: string[];
  missions: string[];
}

export interface LastRoundResult {
  roundId: string;
  roundNumber: number;
  dealerCards: Card[];
  dealerTotal: number;
  dealerBust: boolean;
  dealerBlackjack: boolean;
  seats: ResultSeat[];
  settledAt: number;
  /** True if the round was voided (all stakes refunded) instead of settled. */
  voided?: boolean;
}

export type TablePhase = 'betting' | 'insurance' | 'playing';

export interface BlackjackTableState {
  phase: TablePhase;
  /** Rounds dealt so far at this table (display numbering). */
  roundNumber: number;
  /** Escrow context of the current/next round. Bets are held against it. */
  roundId: string;
  seats: SeatInfo[];
  /** Bets placed for the upcoming deal (betting phase). */
  bets: Record<string, number>;
  /** Engine state while a round is in progress. */
  round: RoundState | null;
  shoe: Card[];
  shoeSize: number;
  /** Visible deadline of the current timer (epoch ms), or null when nothing is pending. */
  deadline: number | null;
  /** Monotonic counter used to build unique, replay-safe idempotency keys. */
  opSeq: number;
  log: LogEntry[];
  lastResult: LastRoundResult | null;
}

export interface TableRecord {
  id: string;
  guildId: string;
  game: 'blackjack';
  number: number;
  name: string;
  ownerId: string;
  isPrivate: boolean;
  accessCode: string | null;
  config: TableConfig;
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
  status: 'open' | 'closed';
  version: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface TableSnapshot {
  record: TableRecord;
  state: BlackjackTableState;
}

/** Why a render was requested — lets the presenter add tasteful transitions. */
/**
 * What changed, so the presenter can animate it: 'dealt' = a hand was just dealt (cards go out in
 * passes); 'round_settled' = the dealer played and the hand settled (`dealt` if that happened at
 * the deal itself, e.g. a dealer blackjack).
 */
export type RenderHint =
  | { kind: 'update' }
  | { kind: 'dealt' }
  /** A player just drew a card (hit, double or bust) and play goes on. */
  | { kind: 'drawn'; userId: string; hand: number }
  /** `lastDraw`: the card a player drew in the action that ended the round, if any. */
  | { kind: 'round_settled'; dealerSteps: number; dealt?: boolean; lastDraw?: { userId: string; hand: number } }
  | { kind: 'restored' };

/** Notifications from the table service to whatever presents tables (Discord or tests). */
export interface TableObserver {
  /** `origin` is the opaque token passed by whoever triggered the change (e.g. a Discord click). */
  tableChanged(tableId: string, hint: RenderHint, origin?: object): void;
  tableClosed(snapshot: TableSnapshot, reason: string): void;
}

export const nullObserver: TableObserver = {
  tableChanged: () => undefined,
  tableClosed: () => undefined,
};
