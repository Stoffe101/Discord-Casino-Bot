import { isCard, rankOf, suitOf, type Card } from '../cards.js';

export const HAND_CATEGORIES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
] as const;

export interface HandRank {
  category: typeof HAND_CATEGORIES[number];
  score: number;
}

const RANK_VALUES = '23456789TJQKA';
const CATEGORY_WEIGHT = 15 ** 5;

function encode(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (ranks[i] ?? 0);
  return score;
}

function scoreFive(cards: readonly Card[]): number {
  const ranks = cards.map((card) => RANK_VALUES.indexOf(rankOf(card)) + 2).sort((a, b) => b - a);
  const groups = new Map<number, number>();
  for (const rank of ranks) groups.set(rank, (groups.get(rank) ?? 0) + 1);
  const flush = cards.every((card) => suitOf(card) === suitOf(cards[0]!));
  const straight = groups.size === 5
    ? ranks[0]! - ranks[4]! === 4 ? ranks[0]! : ranks[0] === 14 && ranks[1] === 5 ? 5 : 0
    : 0;
  if (straight && flush) return encode(8, [straight]);
  const sets = [...groups].sort(([a, countA], [b, countB]) => countB - countA || b - a);
  const ordered = sets.map(([rank]) => rank);
  if (sets[0]![1] === 4) return encode(7, ordered);
  if (sets[0]![1] === 3 && sets[1]![1] === 2) return encode(6, ordered);
  if (flush) return encode(5, ranks);
  if (straight) return encode(4, [straight]);
  if (sets[0]![1] === 3) return encode(3, ordered);
  if (sets[0]![1] === 2) return encode(sets[1]![1] === 2 ? 2 : 1, ordered);
  return encode(0, ranks);
}

/** Higher scores win. Suits never break a tie. The board can supply all five cards. */
export function bestHand(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7 || !cards.every(isCard) || new Set(cards).size !== cards.length) {
    throw new RangeError('A poker hand needs five to seven distinct cards.');
  }
  let score = 0;
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            score = Math.max(score, scoreFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]));
          }
        }
      }
    }
  }
  return { category: HAND_CATEGORIES[Math.floor(score / CATEGORY_WEIGHT)]!, score };
}
