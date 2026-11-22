import { secureRng, type Rng } from '../../core/random.js';

/**
 * "Emerald Slots" — three independent reels, one payline (the middle row).
 *
 * Each reel strip has 32 stops; a symbol's chance on the payline is (copies on the strip) / 32.
 * Paytable (multiplier of the bet, stake included in the return):
 *   7 7 7 ×200 · gem ×100 · bar ×50 · bell ×25 · clover ×15 · lemon ×15
 *   three cherries ×8 · exactly two cherries ×2
 * Exact return to player (computed and verified in tests): 31,630 / 32,768 = 96.53%.
 */

export const SYMBOLS = ['seven', 'gem', 'bar', 'bell', 'clover', 'lemon', 'cherry'] as const;
export type SlotSymbol = (typeof SYMBOLS)[number];

/** Copies of each symbol per reel strip (sums to 32). */
export const WEIGHTS: Record<SlotSymbol, number> = {
  seven: 1,
  gem: 2,
  bar: 3,
  bell: 4,
  clover: 6,
  lemon: 6,
  cherry: 10,
};

export const STOPS = 32;

export const THREE_OF_A_KIND: Record<SlotSymbol, number> = {
  seven: 200,
  gem: 100,
  bar: 50,
  bell: 25,
  clover: 15,
  lemon: 15,
  cherry: 8,
};

export const TWO_CHERRIES = 2;

export const SYMBOL_NAMES: Record<SlotSymbol, string> = {
  seven: 'Lucky Seven',
  gem: 'Emerald',
  bar: 'Gold Bar',
  bell: 'Bell',
  clover: 'Clover',
  lemon: 'Lemon',
  cherry: 'Cherry',
};

/**
 * Strip order spreads high symbols apart so the visible rows look natural. The same strip
 * is used for all three reels; outcomes are independent because each reel stops independently.
 */
export const REEL_STRIP: readonly SlotSymbol[] = buildStrip();

function buildStrip(): SlotSymbol[] {
  const order: SlotSymbol[] = [
    'cherry', 'lemon', 'bell', 'cherry', 'clover', 'seven', 'cherry', 'lemon', 'bar', 'cherry', 'clover', 'gem',
    'cherry', 'lemon', 'bell', 'cherry', 'clover', 'bar', 'cherry', 'lemon', 'bell', 'cherry', 'clover', 'gem',
    'cherry', 'lemon', 'bar', 'cherry', 'clover', 'bell', 'lemon', 'clover',
  ];
  return order;
}

export interface SpinResult {
  /** Stop index per reel. */
  stops: [number, number, number];
  /** Visible window: rows[row][reel], row 1 is the payline. */
  rows: [SlotSymbol[], SlotSymbol[], SlotSymbol[]];
  line: [SlotSymbol, SlotSymbol, SlotSymbol];
  multiplier: number;
  label: string;
}

export function evaluateLine(line: readonly SlotSymbol[]): { multiplier: number; label: string } {
  const [a, b, c] = line;
  if (a === b && b === c) return { multiplier: THREE_OF_A_KIND[a!], label: `Three ${SYMBOL_NAMES[a!]}s` };
  const cherries = line.filter((s) => s === 'cherry').length;
  if (cherries === 2) return { multiplier: TWO_CHERRIES, label: 'Two Cherries' };
  return { multiplier: 0, label: 'No win' };
}

export function spinFromStops(stops: [number, number, number]): SpinResult {
  const at = (reel: number, offset: number) => REEL_STRIP[(stops[reel]! + offset + STOPS) % STOPS]!;
  const rows: SpinResult['rows'] = [
    [at(0, -1), at(1, -1), at(2, -1)],
    [at(0, 0), at(1, 0), at(2, 0)],
    [at(0, 1), at(1, 1), at(2, 1)],
  ];
  const line = rows[1] as [SlotSymbol, SlotSymbol, SlotSymbol];
  return { stops, rows, line, ...evaluateLine(line) };
}

export function spin(rng: Rng = secureRng): SpinResult {
  return spinFromStops([rng.int(STOPS), rng.int(STOPS), rng.int(STOPS)]);
}

/** Exact expected return per chip bet, by enumerating all 32³ outcomes. */
export function exactReturnToPlayer(): { rtp: number; hitRate: number; returned: number; outcomes: number } {
  let returned = 0;
  let hits = 0;
  for (let a = 0; a < STOPS; a++) {
    for (let b = 0; b < STOPS; b++) {
      for (let c = 0; c < STOPS; c++) {
        const { multiplier } = evaluateLine([REEL_STRIP[a]!, REEL_STRIP[b]!, REEL_STRIP[c]!]);
        returned += multiplier;
        if (multiplier > 0) hits++;
      }
    }
  }
  const outcomes = STOPS ** 3;
  return { rtp: returned / outcomes, hitRate: hits / outcomes, returned, outcomes };
}
