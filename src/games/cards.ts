import { secureRng, shuffleInPlace, type Rng } from '../core/random.js';

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
/** Compact, serialisable card code: rank + suit, e.g. "AS", "TH", "7C". */
export type Card = `${Rank}${Suit}`;

const SUIT_SYMBOLS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAMES: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const RANK_NAMES: Record<Rank, string> = {
  A: 'Ace',
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
};

export function isCard(value: unknown): value is Card {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    (RANKS as readonly string[]).includes(value[0]!) &&
    (SUITS as readonly string[]).includes(value[1]!)
  );
}

export function rankOf(card: Card): Rank {
  return card[0] as Rank;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function isRed(card: Card): boolean {
  const s = suitOf(card);
  return s === 'H' || s === 'D';
}

/** Display rank: "10" for tens, otherwise the code character. */
export function rankLabel(rank: Rank): string {
  return rank === 'T' ? '10' : rank;
}

export function suitSymbol(suit: Suit): string {
  return SUIT_SYMBOLS[suit];
}

/** Short label such as "10♥" or "A♠". */
export function cardLabel(card: Card): string {
  return `${rankLabel(rankOf(card))}${suitSymbol(suitOf(card))}`;
}

/** Spoken name such as "Queen of hearts" (alt text, screen readers). */
export function cardName(card: Card): string {
  return `${RANK_NAMES[rankOf(card)]} of ${SUIT_NAMES[suitOf(card)]}`;
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank}${suit}`);
  return deck;
}

/** A freshly shuffled shoe of `decks` standard 52-card decks (cryptographically secure shuffle). */
export function createShoe(decks: number, rng: Rng = secureRng): Card[] {
  if (!Number.isInteger(decks) || decks < 1 || decks > 8) throw new RangeError('decks must be 1-8');
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) cards.push(...createDeck());
  return shuffleInPlace(cards, rng);
}
