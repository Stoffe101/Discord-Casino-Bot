/**
 * Table artwork review: renders blackjack and Hold'em fixtures (1–7 players, long hands, splits,
 * doubles, busts, surrenders, insurance, showdowns, side pots) without Discord, plus copies scaled
 * to the widths Discord actually displays (400 / 500 / 600 px), and prints a readability audit.
 *
 *   npx tsx src/scripts/render-tables-preview.ts [outDir]     (default recordings/table-review/current)
 *
 * The fixtures are exported for the readability tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeTotal, handValue, isNaturalCards } from '../games/blackjack/engine.js';
import type { Card } from '../games/cards.js';
import type { publicPokerHand } from '../games/poker/engine.js';
import { netBadge, type Badge, type HandView, type SeatView, type TableView, type TableViewMode } from '../tables/table-view.js';
import { renderTableSvg } from '../render/table-image.js';
import { pokerTableSvg } from '../render/poker-image.js';
import { myHandSvg, type MyHandImage } from '../render/hand-image.js';
import { svgToPng } from '../render/png.js';
import { CINZEL_CAP } from '../render/cards.js';
import { cardArrivalFrames, chipFrames, type Arrival } from '../render/table-animation.js';

const NAMES = ['Alex', 'Christoffer', 'Hanna', 'Maximilian_the_Great', 'Maja', 'Oskar', 'Linnea'];

const cards = (spec: string) => spec.split(' ').filter(Boolean) as Card[];

interface HandSpec {
  cards: string;
  bet?: number;
  doubled?: boolean;
  split?: boolean;
  surrendered?: boolean;
  done?: boolean;
  outcome?: 'win' | 'lose' | 'push' | 'blackjack' | 'bust' | 'surrender';
}

function hand(spec: HandSpec, mode: TableViewMode, active: boolean): HandView {
  const cs = cards(spec.cards);
  const { total } = handValue(cs);
  let badge: Badge | null = null;
  if (mode === 'results' && spec.outcome) {
    badge = {
      blackjack: { text: 'BLACKJACK', tone: 'gold' as const },
      win: { text: `${total} · WIN`, tone: 'good' as const },
      push: { text: `${total} · PUSH`, tone: 'neutral' as const },
      lose: { text: `${total} · LOSE`, tone: 'bad' as const },
      bust: { text: `BUST · ${total}`, tone: 'bad' as const },
      surrender: { text: 'SURRENDER', tone: 'neutral' as const },
    }[spec.outcome];
  } else if (spec.surrendered) badge = { text: 'SURRENDERED', tone: 'neutral' };
  else if (total > 21) badge = { text: `BUST · ${total}`, tone: 'bad' };
  else if (!spec.split && isNaturalCards(cs)) badge = { text: 'BLACKJACK', tone: 'gold' };
  else if (mode !== 'reveal' && spec.doubled) badge = { text: `${total} · DOUBLED`, tone: 'info' };
  else if (mode === 'playing' && spec.done && !active) badge = { text: `${total} · STAND`, tone: 'neutral' };
  const dim = mode === 'results' ? spec.outcome === 'lose' || spec.outcome === 'bust' : total > 21 || !!spec.surrendered;
  return {
    cards: cs,
    total: describeTotal(cs, spec.split),
    bet: spec.bet ?? 100,
    active,
    doubled: !!spec.doubled,
    badge,
    dim,
  };
}

interface SeatSpec {
  hands?: HandSpec[];
  bet?: number | null;
  status?: Badge | null;
  net?: number;
  activeHand?: number;
  insured?: SeatView['insurance'];
}

interface TableSpec {
  mode: TableViewMode;
  dealer: string;
  /** Dealer hole card hidden (playing / insurance). */
  hole?: boolean;
  dealerBadge?: Badge | null;
  seats: SeatSpec[];
  active?: number;
  maxSeats?: number;
  /** Seat indices to use (defaults to 0..n-1). */
  at?: number[];
  round?: number;
}

export function tableFixture(spec: TableSpec): TableView {
  const maxSeats = spec.maxSeats ?? 7;
  const at = spec.at ?? spec.seats.map((_, i) => i);
  const seats: SeatView[] = Array.from({ length: maxSeats }, (_, i) => ({
    seatIndex: i, userId: null, name: 'Open seat', hands: [], bet: null, status: null, active: false, net: null,
  }));
  spec.seats.forEach((s, i) => {
    const index = at[i]!;
    const active = spec.active === index;
    const hands = (s.hands ?? []).map((h, k) => hand(h, spec.mode, active && (s.activeHand ?? 0) === k));
    const bet = s.bet !== undefined ? s.bet : hands.length ? hands.reduce((sum, h) => sum + h.bet, 0) : null;
    let status: Badge | null = s.status ?? null;
    if (s.status === undefined) {
      if (spec.mode === 'results' && s.net !== undefined) status = netBadge(s.net);
      else if (active) status = { text: 'TO ACT', tone: 'gold' };
    }
    seats[index] = {
      seatIndex: index,
      userId: `u${index}`,
      name: NAMES[index % NAMES.length]!,
      hands,
      bet,
      status,
      active,
      net: spec.mode === 'results' ? (s.net ?? null) : null,
      ...(s.insured ? { insurance: s.insured } : {}),
    };
  });
  const dealerCards: (Card | null)[] = cards(spec.dealer);
  if (spec.hole) dealerCards.push(null);
  const known = dealerCards.filter((c): c is Card => c !== null);
  return {
    id: 'fixture', name: 'The Velvet Rope', number: 1, feltId: 'emerald', cardBackId: 'emerald', maxSeats,
    minBet: 10, maxBet: 1000, mode: spec.mode, roundNumber: spec.round ?? 12,
    rulesArc: 'BLACKJACK PAYS 3 TO 2  ·  DEALER STANDS ON ALL 17s  ·  INSURANCE PAYS 2 TO 1',
    dealer: { cards: dealerCards, total: known.length ? describeTotal(known) : null, badge: spec.dealerBadge ?? null },
    seats, activeUserId: spec.active !== undefined ? `u${spec.active}` : null, deadline: null,
  };
}

const done = (c: string, extra: Partial<HandSpec> = {}): HandSpec => ({ cards: c, done: true, ...extra });

/** Named blackjack fixtures, covering every state the table can show. */
export function blackjackFixtures(): Record<string, TableView> {
  const f: Record<string, TableView> = {};
  // ── 1 player ──
  f['bj1-playing'] = tableFixture({ mode: 'playing', dealer: '9S', hole: true, active: 0, seats: [{ hands: [{ cards: 'AH 6C' }] }] });
  f['bj1-long'] = tableFixture({ mode: 'playing', dealer: 'TD', hole: true, active: 0, seats: [{ hands: [{ cards: 'AS 2H 3D 2C 4S 5H' }] }] });
  f['bj1-split4-results'] = tableFixture({
    mode: 'results', dealer: 'TC 7D', seats: [{
      net: 200, hands: [
        { cards: '8S 3H TD', split: true, doubled: true, bet: 200, outcome: 'win' },
        { cards: '8H 6C', split: true, outcome: 'lose' },
        { cards: '8D TS', split: true, outcome: 'win' },
        { cards: '8C 2D 9S', split: true, outcome: 'win' },
      ],
    }],
  });
  // ── 2 players ──
  f['bj2-playing'] = tableFixture({
    mode: 'playing', dealer: '6H', hole: true, active: 1,
    seats: [{ hands: [done('5S 6D 9C', { doubled: true, bet: 200 })] }, { hands: [{ cards: 'TH 2S' }] }],
  });
  f['bj2-dealer-blackjack'] = tableFixture({
    mode: 'results', dealer: 'AS KD', dealerBadge: { text: 'BLACKJACK', tone: 'bad' },
    seats: [
      { net: 0, insured: 'paid', hands: [{ cards: 'TC 9H', outcome: 'lose' }] },
      { net: 0, hands: [{ cards: 'AH QS', outcome: 'push' }] },
    ],
  });
  // ── 3 players ──
  f['bj3-playing'] = tableFixture({
    mode: 'playing', dealer: 'TS', hole: true, active: 2,
    seats: [
      { hands: [done('TH 6C 9D')] },
      { hands: [done('9S 7H', { surrendered: true, bet: 50 })] },
      { hands: [{ cards: '8S 3D 9H', split: true, bet: 100 }, { cards: '8H 2C', split: true, bet: 100 }], activeHand: 0 },
    ],
  });
  f['bj3-dealing'] = tableFixture({ mode: 'dealing', dealer: '7C', seats: [{ hands: [{ cards: 'QH' }] }, { hands: [{ cards: '4D' }] }, { hands: [{ cards: 'AS' }] }] });
  // ── 4 players ──
  f['bj4-insurance'] = tableFixture({
    mode: 'insurance', dealer: 'AD', hole: true,
    seats: [
      { hands: [{ cards: 'TC 9C' }], status: { text: 'INSURED', tone: 'gold' } },
      { hands: [{ cards: '7H 7D' }], status: { text: 'INSURANCE?', tone: 'info' } },
      { hands: [{ cards: 'KS AC' }], status: { text: 'NO INSURANCE', tone: 'neutral' } },
      { hands: [{ cards: '5C 6S' }], status: { text: 'INSURANCE?', tone: 'info' } },
    ],
  });
  f['bj4-playing'] = tableFixture({
    mode: 'playing', dealer: '5S', hole: true, active: 3,
    seats: [
      { hands: [done('2C 3D 4H 2S 6C')] },
      { insured: 'taken', hands: [done('9S 9D', { split: true }), done('9H TC', { split: true }), done('9C 8S', { split: true })] },
      { hands: [done('KH 5C QD')] },
      { hands: [{ cards: '6D 5H' }] },
    ],
  });
  // ── 5 players ──
  for (const active of [0, 2, 4]) {
    f[`bj5-playing-a${active}`] = tableFixture({
      mode: 'playing', dealer: '8C', hole: true, active,
      seats: [0, 1, 2, 3, 4].map((i) => {
        const base = ['TS 7D', '9H 2C', '5D 5S', 'AC 7H', '3S 4C'][i]!;
        return { hands: [i < active ? done(base === '9H 2C' ? '9H 2C TD' : base, i === 1 ? { doubled: true, bet: 200 } : {}) : { cards: base }] };
      }),
    });
  }
  f['bj5-results'] = tableFixture({
    mode: 'results', dealer: '5H 3C 2D 4S 6H', dealerBadge: null,
    seats: [
      { net: 200, hands: [{ cards: '6S 5C TH', doubled: true, bet: 200, outcome: 'win' }] },
      { net: -50, hands: [{ cards: 'TC 6D', surrendered: true, outcome: 'surrender' }] },
      { net: -100, insured: 'lost', hands: [{ cards: 'KS QH 5D', outcome: 'bust' }] },
      { net: 150, hands: [{ cards: 'AH KC', outcome: 'blackjack' }] },
      { net: 0, hands: [{ cards: '9D 4C 7S', outcome: 'push' }] },
    ],
  });
  f['bj5-betting'] = tableFixture({
    mode: 'betting', dealer: '', round: 13,
    seats: [
      { bet: 100, status: { text: 'READY', tone: 'good' } },
      { bet: null, status: { text: 'NO BET YET', tone: 'info' } },
      { bet: 1000, status: { text: 'READY', tone: 'good' } },
      { bet: null, status: { text: 'SITTING OUT', tone: 'neutral' } },
      { bet: 25, status: { text: 'READY', tone: 'good' } },
    ],
  });
  // ── 6 players ──
  f['bj6-playing'] = tableFixture({
    mode: 'playing', dealer: 'QC', hole: true, active: 3,
    seats: [
      { hands: [done('TD 8S')] },
      { hands: [done('5H 4S 2D 3C 6H')] },
      { hands: [done('KC 4D 9S')] },
      { hands: [{ cards: '7S 4H' }] },
      { hands: [] , status: { text: 'NEXT HAND', tone: 'info' } },
      { hands: [{ cards: 'AD AS' }] },
    ],
  });
  // ── 7 players ──
  f['bj7-playing'] = tableFixture({
    mode: 'playing', dealer: '7D', hole: true, active: 4,
    seats: [
      { hands: [done('TS QD')] },
      { hands: [done('AS 2H 3D 2C 4S 5H')] },
      { hands: [done('8S 3C', { split: true, doubled: true, bet: 200 }), done('8D 9C', { split: true })] },
      { hands: [done('9C 9H TD')] },
      { hands: [{ cards: '6C 5S' }] },
      { hands: [{ cards: 'AH 7C' }] },
      { hands: [{ cards: 'JD 2S' }] },
    ],
  });
  f['bj7-split4'] = tableFixture({
    mode: 'playing', dealer: '6S', hole: true, active: 2,
    seats: [
      { hands: [done('TS 9D')] },
      { hands: [done('5S 6C TH', { doubled: true, bet: 200 })] },
      { hands: [done('8S 3C 7H', { split: true }), done('8D 9C', { split: true }), { cards: '8H 2D', split: true }, { cards: '8C', split: true }], activeHand: 2 },
      { hands: [{ cards: '9C 7H' }] },
      { hands: [{ cards: 'KC 2D' }] },
      { hands: [{ cards: 'AH 5C' }] },
      { hands: [{ cards: '4D 4S' }] },
    ],
  });
  // Four split hands at the fourth seat: always in a row of four, so the rank-only fallback is used.
  f['bj7-split4-seat4'] = tableFixture({
    mode: 'playing', dealer: '6S', hole: true, active: 3,
    seats: [
      { hands: [done('TS 9D')] },
      { hands: [done('5S 6C TH', { doubled: true, bet: 200 })] },
      { hands: [done('KC 7D')] },
      { hands: [done('9S 2C TH', { split: true }), done('9D 9C', { split: true }), { cards: '9H 4D 3C', split: true }, { cards: '9C', split: true }], activeHand: 2 },
      { hands: [{ cards: 'KC 2D' }] },
      { hands: [{ cards: 'AH 5C' }] },
      { hands: [{ cards: '4D 4S' }] },
    ],
  });
  f['bj7-reveal'] = tableFixture({
    mode: 'reveal', dealer: '6D 5C 3H 2S',
    seats: [
      { hands: [{ cards: 'TS QD' }] },
      { hands: [{ cards: 'AS 2H 3D 2C 4S 5H' }] },
      { hands: [{ cards: 'TH 7C KD' }] },
      { hands: [{ cards: '9C 9H' }] },
      { hands: [{ cards: '6C 5S QH', doubled: true, bet: 200 }] },
      { hands: [{ cards: 'AH 7C' }] },
      { hands: [{ cards: 'JD 2S 5S' }] },
    ],
  });
  f['bj7-results'] = tableFixture({
    mode: 'results', dealer: '6D 5C 3H 2S 9D', dealerBadge: { text: 'DEALER BUSTS · 25', tone: 'good' },
    seats: [
      { net: 100, hands: [{ cards: 'TS QD', outcome: 'win' }] },
      { net: 100, hands: [{ cards: 'AS 2H 3D 2C 4S 5H', outcome: 'win' }] },
      { net: -100, hands: [{ cards: 'TH 7C KD', outcome: 'bust' }] },
      { net: 0, hands: [{ cards: '8S 3C 9D', split: true, doubled: true, bet: 200, outcome: 'win' }, { cards: '8D 9C TS', split: true, bet: 200, outcome: 'bust' }] },
      { net: 400, hands: [{ cards: '6C 5S QH', doubled: true, bet: 400, outcome: 'win' }] },
      { net: -50, hands: [{ cards: 'TC 6H', surrendered: true, outcome: 'surrender' }] },
      { net: 150, hands: [{ cards: 'JD AS', outcome: 'blackjack' }] },
    ],
  });
  f['bj7-waiting'] = tableFixture({
    mode: 'waiting', dealer: '', round: 0,
    seats: Array.from({ length: 7 }, (_, i) => ({ bet: null, status: i === 3 ? { text: 'SITTING OUT', tone: 'neutral' } : { text: 'NO BET YET', tone: 'info' } })),
  });
  return f;
}

// ───────────────────────────── Hold'em ─────────────────────────────

type PokerView = ReturnType<typeof publicPokerHand>;

interface PokerSeatSpec {
  stack: number;
  paid?: number;
  committed?: number;
  folded?: boolean;
  cards?: string;
}

function pokerFixture(spec: {
  street: PokerView['street'];
  board: string;
  dealer: number;
  sb: number;
  bb: number;
  actor: number | null;
  seats: PokerSeatSpec[];
  result?: PokerView['result'];
  lastAction?: PokerView['lastAction'];
}): PokerView {
  return {
    seq: 3, street: spec.street, actor: spec.actor, dealer: spec.dealer, smallBlindSeat: spec.sb, bigBlindSeat: spec.bb,
    board: cards(spec.board), currentBet: Math.max(0, ...spec.seats.map((s) => s.paid ?? 0)),
    lastAction: spec.lastAction ?? null,
    seats: spec.seats.map((s, seat) => ({
      userId: String(seat), seat, stack: s.stack, streetPaid: s.paid ?? 0, committed: s.committed ?? s.paid ?? 0, folded: !!s.folded,
      cards: s.cards ? (cards(s.cards) as [Card, Card]) : null,
    })) as PokerView['seats'],
    result: spec.result ?? null,
  };
}

export const POKER_NAMES: Record<string, string> = Object.fromEntries(
  ['Alex', 'Christoffer', 'Hanna', 'Maximilian_the_Great', 'Maja', 'Oskar', 'Linnea', 'Sven', 'Ida'].map((name, i) => [String(i), name]),
);

export function pokerFixtures(): Record<string, PokerView> {
  const f: Record<string, PokerView> = {};
  f['pk2-preflop'] = pokerFixture({ street: 'preflop', board: '', dealer: 0, sb: 0, bb: 1, actor: 0, seats: [{ stack: 995, paid: 5 }, { stack: 990, paid: 10 }] });
  f['pk6-flop'] = pokerFixture({
    street: 'flop', board: 'KH 7D 2C', dealer: 2, sb: 3, bb: 4, actor: 1, lastAction: { seat: 0, type: 'raise', amount: 60 },
    seats: [
      { stack: 640, paid: 60, committed: 80 },
      { stack: 410, paid: 0, committed: 20 },
      { stack: 980, folded: true, committed: 0 },
      { stack: 1200, folded: true, committed: 5 },
      { stack: 0, paid: 30, committed: 50 },
      { stack: 755, paid: 0, committed: 20 },
    ],
  });
  f['pk6-river-allin'] = pokerFixture({
    street: 'river', board: 'QS JD 4H 9C 2S', dealer: 5, sb: 0, bb: 1, actor: 3,
    seats: [
      { stack: 0, committed: 150 },
      { stack: 0, committed: 400 },
      { stack: 320, folded: true, committed: 10 },
      { stack: 2150, paid: 200, committed: 600 },
      { stack: 88, folded: true, committed: 40 },
      { stack: 1040, paid: 200, committed: 600 },
    ],
  });
  f['pk6-showdown-sidepots'] = pokerFixture({
    street: 'complete', board: 'QS JD 4H 9C 2S', dealer: 5, sb: 0, bb: 1, actor: null,
    seats: [
      { stack: 600, committed: 150, cards: 'QH QD' },
      { stack: 0, committed: 400, cards: 'AS KS' },
      { stack: 320, folded: true, committed: 10 },
      { stack: 2270, committed: 600, cards: 'TS 8D' },
      { stack: 88, folded: true, committed: 40 },
      { stack: 440, committed: 600, cards: '9H 9D' },
    ],
    result: {
      showdown: true,
      pots: [
        { amount: 650, eligible: [0, 1, 3, 5], winners: [0] },
        { amount: 750, eligible: [1, 3, 5], winners: [3] },
        { amount: 400, eligible: [3, 5], winners: [3] },
      ],
      payouts: [{ seat: 0, amount: 650 }, { seat: 3, amount: 1150 }],
      refunds: [],
    },
  });
  f['pk7-turn'] = pokerFixture({
    street: 'turn', board: 'AH 8S 8D 3C', dealer: 6, sb: 0, bb: 1, actor: 4, lastAction: { seat: 3, type: 'check', amount: 0 },
    seats: [
      { stack: 480, paid: 0, committed: 25 },
      { stack: 0, paid: 0, committed: 300 },
      { stack: 920, folded: true, committed: 10 },
      { stack: 610, paid: 0, committed: 40 },
      { stack: 1335, paid: 0, committed: 40 },
      { stack: 75, folded: true, committed: 0 },
      { stack: 2040, paid: 0, committed: 40 },
    ],
  });
  f['pk9-preflop'] = pokerFixture({
    street: 'preflop', board: '', dealer: 8, sb: 0, bb: 1, actor: 2,
    seats: Array.from({ length: 9 }, (_, i) => ({ stack: 500 - (i === 0 ? 5 : i === 1 ? 10 : 0), paid: i === 0 ? 5 : i === 1 ? 10 : 0 })),
  });
  f['pk2-fold-win'] = pokerFixture({
    street: 'complete', board: '8C 8D 3S', dealer: 1, sb: 1, bb: 0, actor: null,
    seats: [{ stack: 1060, committed: 60 }, { stack: 940, folded: true, committed: 60 }],
    result: { showdown: false, pots: [{ amount: 120, eligible: [0], winners: [0] }], payouts: [{ seat: 0, amount: 120 }], refunds: [] },
  });
  return f;
}

// ───────────────────────────── private "My hand" view ─────────────────────────────

export function myHandFixtures(): Record<string, MyHandImage> {
  const h = (c: string, active = false, badge: Badge | null = null) => ({ cards: cards(c), total: describeTotal(cards(c)), active, badge });
  return {
    'me-single': { feltId: 'emerald', cardBackId: 'emerald', dealer: ['9S', null], dealerTotal: '9', hands: [h('AH 6C', true)] },
    'me-split4': {
      feltId: 'emerald', cardBackId: 'crimson', dealer: ['6D', null], dealerTotal: '6',
      hands: [h('8S 3H TD', false, { text: '21 · STAND', tone: 'neutral' }), h('8H 2C 9D', false, { text: 'BUST · 19', tone: 'bad' }), h('8D TS', true), h('8C')],
    },
    'me-dealer-long': { feltId: 'burgundy', cardBackId: 'emerald', dealer: cards('2C 3D 4H 2S 5C 3H'), dealerTotal: '19', hands: [h('TS 9D', false, { text: '19 · PUSH', tone: 'neutral' })] },
  };
}

// ───────────────────────────── audit + main ─────────────────────────────

/**
 * Reads every text size straight from the SVG: card corner indices (the first Cinzel text inside
 * a scaled card group, measured as cap height) and all other text (font size), at a display width.
 */
export function auditSvg(svg: string, displayWidth: number): { rankCap: number; text: number; smallest: string } {
  const virtualW = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)?.[1] ?? 960);
  const k = displayWidth / virtualW;
  const stack: Array<{ scale: number; card: boolean; seenRank: boolean }> = [];
  let rankCap = Infinity;
  let text = Infinity;
  let smallest = '';
  const re = /<(\/?)(g|text)\b([^>]*)>([^<]*)/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    const [, close, tag, attrs, content] = m as unknown as [string, string, string, string, string];
    if (tag === 'g') {
      if (close) { stack.pop(); continue; }
      const scale = /scale\(([\d.]+)(?:[ ,]([\d.]+))?\)/.exec(attrs);
      const s = scale ? Number(scale[2] ?? scale[1]) : 1;
      const card = !!scale && /translate\(/.test(attrs) && !/rotate\(180/.test(attrs);
      const parent = stack.at(-1)?.scale ?? 1;
      stack.push({ scale: parent * s, card, seenRank: false });
      continue;
    }
    if (close) continue;
    const size = Number(/font-size="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const top = stack.at(-1);
    const scale = top?.scale ?? 1;
    const cardGroup = [...stack].reverse().find((g) => g.card);
    if (cardGroup) {
      if (!cardGroup.seenRank && /Cinzel/.test(attrs)) {
        cardGroup.seenRank = true;
        rankCap = Math.min(rankCap, size * scale * CINZEL_CAP * k);
      }
      continue;
    }
    const px = size * scale * k;
    if (px < text) {
      text = px;
      smallest = content.trim() || '(textPath)';
    }
  }
  return { rankCap, text, smallest };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--only='))?.slice(7);
  const out = resolve(args.find((a) => !a.startsWith('--')) ?? join('recordings', 'table-review', 'current'));
  mkdirSync(out, { recursive: true });
  const rows: string[] = [];
  const save = async (name: string, svg: string) => {
    writeFileSync(join(out, `${name}.png`), await svgToPng(svg));
    for (const w of [400, 500, 600]) writeFileSync(join(out, `${name}@${w}.png`), await svgToPng(svg, w));
    const size = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
    const a4 = auditSvg(svg, 400);
    const a5 = auditSvg(svg, 500);
    rows.push(
      `${name.padEnd(24)} ${size[1]}x${Math.round(Number(size[2]))} (${(Number(size[1]) / Number(size[2])).toFixed(2)}:1)  ` +
        `rank@400 ${a4.rankCap === Infinity ? '  - ' : a4.rankCap.toFixed(1)}  rank@500 ${a5.rankCap === Infinity ? '  - ' : a5.rankCap.toFixed(1)}  ` +
        `text@400 ${a4.text.toFixed(1)} (${a4.smallest.slice(0, 18)})`,
    );
  };
  const wanted = (name: string) => !only || only.split(',').some((prefix) => name.startsWith(prefix));
  for (const [name, view] of Object.entries(blackjackFixtures())) if (wanted(name)) await save(name, renderTableSvg(view));
  for (const [name, view] of Object.entries(pokerFixtures())) if (wanted(name)) await save(name, pokerTableSvg(view, POKER_NAMES));
  for (const [name, view] of Object.entries(myHandFixtures())) if (wanted(name)) await save(name, myHandSvg(view));
  if (wanted('anim')) {
    // The deal and the settle, built from the same layout as the stills.
    const fx = blackjackFixtures();
    const table = fx['bj5-playing-a2']!;
    const seated = table.seats.filter((s) => s.hands.length).map((s) => s.seatIndex);
    const arrivals: Arrival[] = [];
    for (const pass of [0, 1]) {
      for (const seat of seated) arrivals.push({ to: { seat, hand: 0, card: pass } });
      arrivals.push({ to: { dealer: pass } });
    }
    const deal = cardArrivalFrames(table, arrivals, { flight: 4, stagger: 1, frameMs: 65, quiet: true });
    const { framesToGif } = await import('../render/gif.js');
    writeFileSync(join(out, 'anim-deal-mid.png'), await svgToPng(deal[Math.floor(deal.length / 2)]!.svg, 500));
    writeFileSync(join(out, 'anim-deal.gif'), (await framesToGif(deal, 560)).gif);
    const results = fx['bj5-results']!;
    const moves = results.seats.filter((s) => s.net).map((s) => ({ seat: s.seatIndex, toSeat: s.net! > 0, amount: s.bet ?? 100 }));
    const settle = chipFrames(results, moves, 7, 55);
    writeFileSync(join(out, 'anim-chips-mid.png'), await svgToPng(settle[3]!.svg, 500));
    writeFileSync(join(out, 'anim-chips.gif'), (await framesToGif(settle, 640)).gif);
  }
  if (wanted('art')) {
    // Other artwork that draws the shared card face: check it still looks right. (Loaded lazily so
    // the readability tests, which import the fixtures above, depend only on the table renderers.)
    const { bannerSvg } = await import('../render/game-images.js');
    const { floorSvg, gameBadgeSvg } = await import('../render/floor-art.js');
    const { casinoArtwork } = await import('../render/casino-art.js');
    writeFileSync(join(out, 'art-banner.png'), await svgToPng(bannerSvg('The Emerald Room'), 800));
    writeFileSync(join(out, 'art-floor.png'), await svgToPng(floorSvg({ blackjack: true, poker: true, roulette: true, slots: true, coinflip: true, events: true }), 800));
    writeFileSync(join(out, 'art-badge-blackjack.png'), await svgToPng(gameBadgeSvg('blackjack'), 300));
    for (const kind of ['blackjack', 'poker'] as const) {
      const art = await casinoArtwork(kind);
      if (art) writeFileSync(join(out, `art-medallion-${kind}.png`), art.data);
    }
  }
  console.log(rows.join('\n'));
  console.log(`\n${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
