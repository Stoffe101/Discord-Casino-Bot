import type { Card } from '../cards.js';
import { handValue } from './engine.js';

/**
 * Basic strategy for multi-deck blackjack (dealer stands or hits soft 17, double after split, late
 * surrender), as a learning aid in the player's private "My hand" view. It only suggests among
 * the moves the player can actually make right now.
 */
export type Move = 'hit' | 'stand' | 'double' | 'split' | 'surrender';

export interface Legal {
  double: boolean;
  split: boolean;
  surrender: boolean;
}

const rankValue = (card: Card): number => {
  const r = card.slice(0, -1);
  return r === 'A' ? 11 : ['T', 'J', 'Q', 'K'].includes(r) ? 10 : Number(r);
};

export function basicStrategy(cards: Card[], dealerUp: Card, legal: Legal, dealerHitsSoft17 = false): { move: Move; why: string } {
  const up = rankValue(dealerUp); // 2–11
  const upLabel = up === 11 ? 'an ace' : String(up);
  const { total, soft } = handValue(cards);
  const pair = cards.length === 2 && rankValue(cards[0]!) === rankValue(cards[1]!);
  const weak = up >= 2 && up <= 6; // dealer likely to bust

  if (pair && legal.split) {
    const v = rankValue(cards[0]!);
    const split =
      v === 11 || v === 8 || (v === 9 && ![7, 10, 11].includes(up)) || (v === 7 && up <= 7) || (v === 6 && up <= 6) || (v === 4 && (up === 5 || up === 6)) || ((v === 2 || v === 3) && up <= 7);
    if (split) return { move: 'split', why: v === 11 ? 'two aces are two strong starts' : v === 8 ? '16 is the worst hand; two 8s are better' : `two ${v}s play better apart against ${upLabel}` };
  }
  if (legal.surrender && !soft && cards.length === 2) {
    if ((total === 16 && up >= 9) || (total === 15 && up === 10) || (dealerHitsSoft17 && total === 15 && up === 11)) {
      return { move: 'surrender', why: `${total} against ${upLabel} loses more often than not — save half` };
    }
  }
  if (soft && total < 21) {
    if (total >= 19) return { move: 'stand', why: `soft ${total} is already strong` };
    if (total === 18) {
      if (legal.double && up >= 3 && up <= 6) return { move: 'double', why: `soft 18 can't bust and ${upLabel} is a weak dealer card` };
      return up >= 9 ? { move: 'hit', why: `soft 18 is behind against ${upLabel}, and a soft hand can't bust on one card` } : { move: 'stand', why: 'soft 18 is good enough here' };
    }
    const doubleFrom = total === 17 ? 3 : total >= 15 ? 4 : 5;
    if (legal.double && up >= doubleFrom && up <= 6) return { move: 'double', why: `the dealer's ${upLabel} is weak and a soft hand can't bust` };
    return { move: 'hit', why: `soft ${total} can't bust on one card` };
  }
  if (total >= 17) return { move: 'stand', why: `${total} is a standing hand` };
  if (total >= 13) return weak ? { move: 'stand', why: `let the dealer's ${upLabel} risk busting` } : { move: 'hit', why: `${total} is unlikely to win against ${upLabel}` };
  if (total === 12) return up >= 4 && up <= 6 ? { move: 'stand', why: `the dealer's ${upLabel} busts often` } : { move: 'hit', why: 'only a 10-value card can bust 12' };
  if (total === 11) return legal.double && up !== 11 ? { move: 'double', why: '11 is the best hand to double on' } : { move: 'hit', why: '11 can\'t bust' };
  if (total === 10) return legal.double && up <= 9 ? { move: 'double', why: `10 against ${upLabel} is a strong double` } : { move: 'hit', why: "10 can't bust" };
  if (total === 9) return legal.double && up >= 3 && up <= 6 ? { move: 'double', why: `9 against a weak ${upLabel}` } : { move: 'hit', why: "9 can't bust" };
  return { move: 'hit', why: `${total} can't bust` };
}
