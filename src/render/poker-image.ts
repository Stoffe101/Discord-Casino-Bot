import { chips, fontSafe } from '../core/format.js';
import type { publicPokerHand, Street } from '../games/poker/engine.js';
import { CARD_H, CARD_W, INDEX_REVEAL_X, cardBack, cardDefs, cardFace } from './cards.js';
import { esc, n, svgDoc } from './svg.js';
import { TEXT_FLOOR, TONES, clip, measure, tag, tagWidth, type CardSpot, type Rect, type Tone } from './table-image.js';

/**
 * The shared Hold'em table: the board, pot and street on a felt oval at the top, one panel per
 * seat below (name, stack, dealer button and blinds, hole cards, what they did). Built to the same
 * legibility floors as the blackjack table: every card index and every text at least 9 px tall
 * when Discord shows the image 400 px wide.
 *
 * Only a public projection reaches this renderer: other players' hole cards are face down unless
 * the engine has revealed them at showdown (`seat.cards`), and `maskShowdown` hides even those.
 */

type PokerView = ReturnType<typeof publicPokerHand>;

export const POKER_W = 960;
const RATIO = CARD_H / CARD_W;
const EDGE_X = 22;
const CONTENT_W = POKER_W - EDGE_X * 2;
const TOP = 18;
const BOTTOM = 18;
const GAP = 10;
const PAD_X = 10;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const STEP = INDEX_REVEAL_X + 0.01;

const STREETS: Record<Street, string> = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER', complete: 'RESULT' };

interface PokerTier {
  rows: number[];
  height: number;
  boardH: number;
  name: number;
  pill: number;
  cap: number;
}

const TIERS: Record<number, PokerTier> = {
  2: { rows: [2], height: 540, boardH: 206, name: 30, pill: 26, cap: 120 },
  3: { rows: [3], height: 540, boardH: 206, name: 28, pill: 24, cap: 112 },
  4: { rows: [4], height: 540, boardH: 200, name: 26, pill: 24, cap: 100 },
  5: { rows: [3, 2], height: 700, boardH: 190, name: 26, pill: 24, cap: 104 },
  6: { rows: [3, 3], height: 700, boardH: 190, name: 26, pill: 24, cap: 104 },
  7: { rows: [4, 3], height: 720, boardH: 180, name: 24, pill: 22, cap: 96 },
  8: { rows: [4, 4], height: 720, boardH: 180, name: 24, pill: 22, cap: 96 },
  9: { rows: [5, 4], height: 720, boardH: 176, name: 22, pill: 22, cap: 84 },
};

export interface PokerSeatGeom {
  seat: number;
  rect: Rect;
  nameSize: number;
  pillSize: number;
  name: { x: number; y: number };
  header: { cy: number; right: number; h: number };
  /** Dealer button and blind markers: a column left of the cards, or a row above narrow ones. */
  tokens: { x: number; y: number; dx: number; dy: number };
  cardW: number;
  cardH: number;
  cards: CardSpot[];
  pill: { cx: number; cy: number; maxW: number };
}

export interface PokerLayout {
  width: number;
  height: number;
  board: { rect: Rect; cardW: number; cardH: number; cards: CardSpot[] };
  street: { x: number; y: number; size: number; maxW: number };
  pot: { x: number; y: number; size: number; maxW: number };
  seats: PokerSeatGeom[];
}

/** Geometry for a hand: depends only on how many seats are dealt in, never on cards or actions. */
export function pokerLayout(view: PokerView): PokerLayout {
  const count = Math.min(9, Math.max(2, view.seats.length));
  const tier = TIERS[count]!;
  const board = { x: EDGE_X, y: TOP, w: CONTENT_W, h: tier.boardH };
  // Street on the left of the board, pot on the right, the five cards centred between them.
  const sideW = 178;
  const boardW = Math.floor(Math.min((CONTENT_W - 2 * (sideW + 10) - 4 * 10) / 5, (tier.boardH - 34) / RATIO));
  const boardSpan = 5 * boardW + 4 * 10;
  const boardCards = Array.from({ length: 5 }, (_, i) => ({ x: POKER_W / 2 - boardSpan / 2 + i * (boardW + 10), y: board.y + (board.h - boardW * RATIO) / 2 }));
  const seatTop = TOP + tier.boardH + GAP;
  const rowH = (tier.height - seatTop - BOTTOM - (tier.rows.length - 1) * GAP) / tier.rows.length;
  const perRow = Math.max(...tier.rows);
  const w = (CONTENT_W - (perRow - 1) * GAP) / perRow;
  const hh = Math.round(tier.name * 1.42);
  const pillH = tier.pill * 1.48;
  const tokenW = Math.round(TEXT_FLOOR * 2.4);
  const seats: PokerSeatGeom[] = [];
  let index = 0;
  tier.rows.forEach((rowCount, r) => {
    const row = view.seats.slice(index, index + rowCount);
    index += rowCount;
    const rowW = row.length * w + (row.length - 1) * GAP;
    row.forEach((seat, i) => {
      const rect = { x: (POKER_W - rowW) / 2 + i * (w + GAP), y: seatTop + r * (rowH + GAP), w, h: rowH };
      const bodyTop = rect.y + PAD_TOP + hh + 6;
      const bodyH = rect.y + rect.h - PAD_BOTTOM - (pillH / 2 + 2) - bodyTop;
      const bodyW = rect.w - PAD_X * 2;
      // Markers beside the cards, or (in narrow panels) in a row above them: whichever leaves bigger cards.
      const tokenRowH = Math.round(TEXT_FLOOR * 1.7);
      const besideW = Math.min(tier.cap, bodyH / RATIO, (bodyW - tokenW - 8) / (1 + STEP));
      const aboveW = Math.min(tier.cap, (bodyH - tokenRowH) / RATIO, bodyW / (1 + STEP));
      const beside = besideW >= aboveW;
      const cardW = beside ? besideW : aboveW;
      const cardH = cardW * RATIO;
      const fan = cardW * (1 + STEP);
      const cx = beside ? rect.x + PAD_X + tokenW + 8 + (bodyW - tokenW - 8) / 2 : rect.x + rect.w / 2;
      const y = beside ? bodyTop + (bodyH - cardH) / 2 : bodyTop + tokenRowH + (bodyH - tokenRowH - cardH) / 2;
      const cy = rect.y + PAD_TOP + hh / 2;
      seats.push({
        seat: seat.seat,
        rect,
        nameSize: tier.name,
        pillSize: tier.pill,
        name: { x: rect.x + PAD_X + 4, y: cy + tier.name * 0.36 },
        header: { cy, right: rect.x + rect.w - PAD_X, h: hh },
        tokens: beside
          ? { x: rect.x + PAD_X + tokenW / 2, y: bodyTop + TEXT_FLOOR * 0.9, dx: 0, dy: TEXT_FLOOR * 1.75 }
          : { x: rect.x + PAD_X + tokenW / 2, y: bodyTop + tokenRowH / 2, dx: tokenW + 6, dy: 0 },
        cardW,
        cardH,
        cards: [0, 1].map((c) => ({ x: cx - fan / 2 + c * cardW * STEP, y })),
        pill: { cx, cy: y + cardH, maxW: beside ? bodyW - tokenW : bodyW },
      });
    });
  });
  const potX = POKER_W / 2 + boardSpan / 2 + 22;
  return {
    width: POKER_W,
    height: tier.height,
    board: { rect: board, cardW: boardW, cardH: boardW * RATIO, cards: boardCards },
    street: { x: EDGE_X + 10 + sideW / 2, y: board.y + board.h / 2, size: 24, maxW: sideW - 12 },
    pot: { x: potX, y: board.y + 44, size: tier.pill + 2, maxW: EDGE_X + CONTENT_W - 26 - potX },
    seats,
  };
}

const ACTIVE: Tone = { fill: '#e8c565', color: '#1d1405', stroke: '#fff0bf' };
const BET: Tone = { fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' };

function seatState(view: PokerView, seat: PokerView['seats'][number]): { text: string; tone: Tone } | null {
  const result = view.result;
  if (result) {
    const won = result.payouts.find((p) => p.seat === seat.seat)?.amount ?? 0;
    if (won > 0) return { text: `WINS ${chips(won)}`, tone: TONES.good };
    if (seat.folded) return { text: 'FOLDED', tone: TONES.neutral };
    return result.showdown ? { text: 'LOSES', tone: TONES.bad } : null;
  }
  if (seat.folded) return { text: 'FOLDED', tone: TONES.neutral };
  if (view.actor === seat.seat) return { text: seat.streetPaid ? `TO ACT · ${chips(seat.streetPaid)}` : 'TO ACT', tone: ACTIVE };
  if (seat.stack === 0) return { text: `ALL-IN · ${chips(seat.committed)}`, tone: TONES.bad };
  if (seat.streetPaid) return { text: `BET ${chips(seat.streetPaid)}`, tone: BET };
  if (view.lastAction?.seat === seat.seat && view.lastAction.type === 'check') return { text: 'CHECK', tone: TONES.info };
  return null;
}

function shorter(text: string): string[] {
  const m = /^(TO ACT|ALL-IN|WINS) · ?(.+)$/.exec(text) ?? /^(WINS) (.+)$/.exec(text);
  if (!m) return [text];
  return m[1] === 'WINS' ? [text, `+${m[2]}`] : [text, m[1]!];
}

function fitPill(candidates: string[], size: number, maxW: number): { text: string; size: number } {
  for (const text of candidates) for (const s of [size, TEXT_FLOOR]) if (tagWidth(text, s) <= maxW) return { text, size: s };
  return { text: candidates.at(-1)!, size: TEXT_FLOOR };
}

/** Only a public poker projection may reach the shared image renderer. */
export function pokerTableSvg(view: PokerView, names: Readonly<Record<string, string>>, options: { dealtSeats?: number; shownBoard?: number; maskShowdown?: boolean } = {}): string {
  const L = pokerLayout(view);
  const pot = view.seats.reduce((sum, seat) => sum + seat.committed, 0);
  const parts: string[] = [];
  parts.push(`<rect width="${L.width}" height="${L.height}" fill="#0c1512"/>`);
  parts.push(`<rect x="3" y="3" width="${L.width - 6}" height="${L.height - 6}" rx="22" fill="#101b18" stroke="#3a3122" stroke-width="2"/>`);
  // The felt oval: board, pot, street.
  const b = L.board.rect;
  parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.h / 2)}" fill="#261d16" stroke="#ac8644" stroke-width="3"/>`);
  parts.push(`<rect x="${n(b.x + 10)}" y="${n(b.y + 10)}" width="${n(b.w - 20)}" height="${n(b.h - 20)}" rx="${n(b.h / 2 - 10)}" fill="url(#poker-felt)" stroke="#736044" stroke-width="2"/>`);
  parts.push(`<rect x="${n(b.x + 12)}" y="${n(b.y + 12)}" width="${n(b.w - 24)}" height="${n(b.h - 24)}" rx="${n(b.h / 2 - 12)}" fill="url(#poker-grain)" opacity=".3"/>`);
  const st = L.street;
  const streetText = view.street === 'complete' ? (view.result?.showdown ? 'SHOWDOWN' : 'RESULT') : STREETS[view.street];
  const streetSize = measure(streetText, st.size, 'display', 2) <= st.maxW ? st.size : TEXT_FLOOR;
  parts.push(`<text x="${n(st.x)}" y="${n(st.y - 4)}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="${streetSize}" fill="#f3d791" letter-spacing="2">${streetText}</text>`);
  parts.push(`<text x="${n(st.x)}" y="${n(st.y + 30)}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="${TEXT_FLOOR}" fill="#c9b37a" letter-spacing="1">HOLD’EM</text>`);
  const shown = options.shownBoard ?? view.board.length;
  L.board.cards.forEach((at, i) => {
    const card = i < shown ? view.board[i] : undefined;
    parts.push(
      card
        ? cardFace(card, at.x, at.y, L.board.cardW)
        : `<rect x="${n(at.x)}" y="${n(at.y)}" width="${n(L.board.cardW)}" height="${n(L.board.cardH)}" rx="${n(L.board.cardW * 0.09)}" fill="#0b3f2e" stroke="#7c9d7a" stroke-opacity="0.7" stroke-dasharray="5 5"/>`,
    );
  });
  // Pot, and at the end every pot that was contested (main pot first).
  const p = L.pot;
  parts.push(`<text x="${n(p.x)}" y="${n(p.y)}" font-family="Manrope" font-weight="800" font-size="${TEXT_FLOOR}" fill="#c9b37a" letter-spacing="1">POT</text>`);
  parts.push(`<text x="${n(p.x)}" y="${n(p.y + p.size + 6)}" font-family="Manrope" font-weight="800" font-size="${p.size + 4}" fill="#f3d791">${esc(clip(chips(pot), p.size + 4, p.maxW))}</text>`);
  const pots = view.result && view.result.pots.length > 1 ? view.result.pots : [];
  pots.slice(0, 3).forEach((entry, i) => {
    const label = `${i === 0 ? 'Main' : `Side${pots.length > 2 ? ` ${i}` : ''}`} ${chips(entry.amount)}`;
    parts.push(`<text x="${n(p.x)}" y="${n(p.y + p.size + 36 + i * (TEXT_FLOOR + 6))}" font-family="Manrope" font-weight="800" font-size="${TEXT_FLOOR}" fill="#d8e6dd">${esc(clip(label, TEXT_FLOOR, p.maxW))}</text>`);
  });

  view.seats.forEach((seat, i) => {
    const g = L.seats[i];
    if (!g) return;
    const r = g.rect;
    const active = view.actor === seat.seat && !view.result;
    const won = (view.result?.payouts.find((x) => x.seat === seat.seat)?.amount ?? 0) > 0;
    const stroke = active ? '#f4d588' : won ? '#34c27f' : 'rgba(201,165,78,0.45)';
    if (active) parts.push(`<rect x="${n(r.x - 4)}" y="${n(r.y - 4)}" width="${n(r.w + 8)}" height="${n(r.h + 8)}" rx="17" fill="none" stroke="#e8c565" stroke-opacity="0.4" stroke-width="7" filter="url(#pglow)"/>`);
    parts.push(`<g${seat.folded ? ' opacity="0.55"' : ''}>`);
    parts.push(`<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" rx="13" fill="#13251f" stroke="${stroke}" stroke-width="${active ? 3.5 : won ? 3 : 1.3}"/>`);
    const band = g.header.h + PAD_TOP;
    parts.push(
      `<path d="M ${n(r.x + 1.5)} ${n(r.y + band)} V ${n(r.y + 13)} Q ${n(r.x + 1.5)} ${n(r.y + 1.5)} ${n(r.x + 13)} ${n(r.y + 1.5)} H ${n(r.x + r.w - 13)} Q ${n(r.x + r.w - 1.5)} ${n(r.y + 1.5)} ${n(r.x + r.w - 1.5)} ${n(r.y + 13)} V ${n(r.y + band)} Z" fill="${active ? 'url(#pband)' : 'rgba(255,255,255,0.05)'}"/>`,
    );
    // Stack on the right of the header, the name in what is left.
    const stack = chips(seat.stack);
    const stackSize = Math.max(TEXT_FLOOR, g.nameSize - 2);
    const stackW = measure(stack, stackSize);
    parts.push(`<text x="${n(g.header.right)}" y="${n(g.header.cy + stackSize * 0.36)}" text-anchor="end" font-family="Manrope" font-weight="800" font-size="${stackSize}" fill="${active ? '#1d1405' : '#f3d791'}">${esc(stack)}</text>`);
    const name = clip(fontSafe(names[seat.userId] ?? 'Player'), g.nameSize, g.header.right - g.name.x - stackW - 10);
    parts.push(`<text x="${n(g.name.x)}" y="${n(g.name.y)}" font-family="Manrope" font-weight="800" font-size="${g.nameSize}" fill="${active ? '#1d1405' : '#f2ede0'}">${esc(name)}</text>`);
    // Dealer button and blinds.
    const tokens: string[] = [];
    if (view.dealer === seat.seat) tokens.push('D');
    if (view.smallBlindSeat === seat.seat) tokens.push('SB');
    if (view.bigBlindSeat === seat.seat) tokens.push('BB');
    tokens.forEach((t, k) => {
      const x = g.tokens.x + k * g.tokens.dx;
      const y = g.tokens.y + k * g.tokens.dy;
      if (t === 'D') {
        const radius = TEXT_FLOOR * 0.78;
        parts.push(`<circle cx="${n(x)}" cy="${n(y + 1.5)}" r="${n(radius)}" fill="#000" opacity="0.35"/><circle cx="${n(x)}" cy="${n(y)}" r="${n(radius)}" fill="#f6f1e3" stroke="#c9a54e" stroke-width="2"/>`);
        parts.push(`<text x="${n(x)}" y="${n(y + TEXT_FLOOR * 0.36)}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="${TEXT_FLOOR}" fill="#17171c">D</text>`);
      } else {
        parts.push(tag(t, x, y, TEXT_FLOOR, t === 'BB' ? { fill: '#d6ad4b', color: '#1d1405' } : { fill: '#2b5d9c', color: '#f3f6ff' }));
      }
    });
    // Hole cards: faces only when the engine has revealed them at showdown.
    const dealt = options.dealtSeats === undefined || i < options.dealtSeats;
    if (dealt && !seat.folded) {
      const faces = !options.maskShowdown && seat.cards ? seat.cards : null;
      if (faces || view.street !== 'complete' || options.maskShowdown) {
        g.cards.forEach((at, c) => {
          const card = faces?.[c];
          parts.push(card ? cardFace(card, at.x, at.y, g.cardW) : cardBack(at.x, at.y, g.cardW));
        });
      }
    }
    const state = seatState(view, seat);
    if (state) {
      const f = fitPill(shorter(state.text), g.pillSize, g.pill.maxW);
      // A folded seat has no cards left: its label sits where they were.
      parts.push(tag(f.text, g.pill.cx, seat.folded ? g.cards[0]!.y + g.cardH / 2 : g.pill.cy, f.size, state.tone));
    }
    parts.push('</g>');
  });
  const defs =
    cardDefs() +
    '<radialGradient id="poker-felt" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#1d6f51"/><stop offset="1" stop-color="#0b3427"/></radialGradient>' +
    '<pattern id="poker-grain" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 0h1v1H0zM3 3h1v1H3z" fill="#e5e7c9" opacity=".16"/></pattern>' +
    '<linearGradient id="pband" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4dc8f"/><stop offset="1" stop-color="#d6ad4b"/></linearGradient>' +
    '<filter id="pglow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="5"/></filter>';
  return svgDoc(L.width, L.height, `<g font-family="Manrope">${parts.join('')}</g>`, defs);
}
