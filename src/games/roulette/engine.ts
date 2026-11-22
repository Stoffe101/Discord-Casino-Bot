import { secureRng, type Rng } from '../../core/random.js';

/**
 * European single-zero roulette (37 pockets, house edge 2.70%). Zero loses every outside bet;
 * there is no "la partage" rule. Payouts are quoted as profit odds; returns include the stake.
 */

export const WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35,
  3, 26,
];

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type PocketColor = 'red' | 'black' | 'green';

export function pocketColor(n: number): PocketColor {
  if (n === 0) return 'green';
  return RED.has(n) ? 'red' : 'black';
}

export type RouletteBetType =
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low'
  | 'high'
  | 'dozen1'
  | 'dozen2'
  | 'dozen3'
  | 'column1'
  | 'column2'
  | 'column3'
  | 'straight';

export interface RouletteBet {
  userId: string;
  type: RouletteBetType;
  /** Only for straight-up bets. */
  number?: number;
  amount: number;
}

export interface BetTypeInfo {
  type: RouletteBetType;
  label: string;
  /** Profit odds (35 means 35:1). */
  odds: number;
  description: string;
}

export const BET_TYPES: readonly BetTypeInfo[] = [
  { type: 'red', label: 'Red', odds: 1, description: 'Any red number · pays 1:1' },
  { type: 'black', label: 'Black', odds: 1, description: 'Any black number · pays 1:1' },
  { type: 'odd', label: 'Odd', odds: 1, description: '1, 3, 5 … 35 · pays 1:1' },
  { type: 'even', label: 'Even', odds: 1, description: '2, 4, 6 … 36 · pays 1:1' },
  { type: 'low', label: '1 – 18', odds: 1, description: 'Low numbers · pays 1:1' },
  { type: 'high', label: '19 – 36', odds: 1, description: 'High numbers · pays 1:1' },
  { type: 'dozen1', label: '1st dozen', odds: 2, description: '1 – 12 · pays 2:1' },
  { type: 'dozen2', label: '2nd dozen', odds: 2, description: '13 – 24 · pays 2:1' },
  { type: 'dozen3', label: '3rd dozen', odds: 2, description: '25 – 36 · pays 2:1' },
  { type: 'column1', label: 'Column 1', odds: 2, description: '1, 4, 7 … 34 · pays 2:1' },
  { type: 'column2', label: 'Column 2', odds: 2, description: '2, 5, 8 … 35 · pays 2:1' },
  { type: 'column3', label: 'Column 3', odds: 2, description: '3, 6, 9 … 36 · pays 2:1' },
  { type: 'straight', label: 'Single number', odds: 35, description: 'One number, 0 – 36 · pays 35:1' },
];

export function betTypeInfo(type: RouletteBetType): BetTypeInfo {
  return BET_TYPES.find((b) => b.type === type)!;
}

export function isBetType(value: string): value is RouletteBetType {
  return BET_TYPES.some((b) => b.type === value);
}

export function betWins(bet: Pick<RouletteBet, 'type' | 'number'>, n: number): boolean {
  if (bet.type === 'straight') return bet.number === n;
  if (n === 0) return false;
  switch (bet.type) {
    case 'red':
      return RED.has(n);
    case 'black':
      return !RED.has(n);
    case 'odd':
      return n % 2 === 1;
    case 'even':
      return n % 2 === 0;
    case 'low':
      return n <= 18;
    case 'high':
      return n >= 19;
    case 'dozen1':
      return n <= 12;
    case 'dozen2':
      return n >= 13 && n <= 24;
    case 'dozen3':
      return n >= 25;
    case 'column1':
      return n % 3 === 1;
    case 'column2':
      return n % 3 === 2;
    case 'column3':
      return n % 3 === 0;
  }
}

/** Chips returned for a bet (stake + winnings), 0 if it loses. */
export function betReturn(bet: Pick<RouletteBet, 'type' | 'number' | 'amount'>, n: number): number {
  return betWins(bet, n) ? bet.amount * (betTypeInfo(bet.type).odds + 1) : 0;
}

export function spinWheel(rng: Rng = secureRng): number {
  return rng.int(37);
}

export function describeBet(bet: Pick<RouletteBet, 'type' | 'number'>): string {
  return bet.type === 'straight' ? `Number ${bet.number}` : betTypeInfo(bet.type).label;
}

export function describeNumber(n: number): string {
  if (n === 0) return '0 · Green';
  const parts = [pocketColor(n) === 'red' ? 'Red' : 'Black', n % 2 ? 'Odd' : 'Even', n <= 18 ? '1–18' : '19–36'];
  return `${n} · ${parts.join(' · ')}`;
}
