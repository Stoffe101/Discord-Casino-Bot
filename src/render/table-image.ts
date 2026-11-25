import { FELTS } from '../domain/progression.js';
import { fontSafe } from '../core/format.js';
import type { Badge, SeatView, TableView } from '../tables/table-view.js';
import { CARD_H, CARD_W, INDEX_BOX, INDEX_REVEAL_X, INDEX_REVEAL_Y, RANK_REVEAL_Y, cardBack, cardDefs, cardFace } from './cards.js';
import { esc, n, svgDoc } from './svg.js';

/**
 * The whole blackjack table as one image: a compact dealer strip on top, one panel per occupied
 * seat below, the player to act lit in gold.
 *
 * Discord shows the attachment 400–600 px wide (and caps its height), so the layout is chosen
 * from the number of occupied seats and how complex their hands are, with hard floors: every card
 * index and every piece of text stays at least 9 px tall at a 400 px display width. The geometry
 * is a pure function of the seats and their card counts (`tableLayout`), shared by the still
 * image and every animation frame, so nothing jumps between them.
 */

export const TABLE_W = 960;
/** Tallest image (4:3); the shortest is 16:9 (540). */
export const TABLE_MAX_H = 720;
const RATIO = CARD_H / CARD_W;

/** Legibility floors, in virtual pixels (× 400 / 960 at the narrowest Discord width). */
export const TEXT_FLOOR = 22;
export const CARD_FLOOR = 70;

const EDGE_X = 22;
const CONTENT_W = TABLE_W - EDGE_X * 2;
const TOP = 18;
const BOTTOM = 18;
const GAP = 10;
/** Card overlap steps: just wide / tall enough to leave the covered card's whole index visible. */
const STEP_X = INDEX_REVEAL_X + 0.01;
const STEP_Y = INDEX_REVEAL_Y + 0.01;
/** Last resort for many split hands: cascade just far enough to show each covered card's rank. */
const STEP_RANK = RANK_REVEAL_Y + 0.01;
const HAND_GAP = 14;
const PAD_X = 10;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const HEAD_GAP = 6;

export function isMultiplayerLayout(view: TableView): boolean {
  return view.seats.filter((seat) => seat.userId !== null).length >= 3;
}

// ───────────────────────────── text ─────────────────────────────

/** Advance widths (per em, ×100) of the bundled fonts, read from their hmtx tables. */
const GLYPHS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·−…×–';
const ADVANCES = {
  ui: '20,38,49,94,64,90,67,28,46,46,47,57,32,42,32,45,67,45,60,59,62,59,62,54,62,62,36,36,65,75,65,56,92,68,64,75,71,59,53,74,73,30,51,67,54,86,73,76,65,76,67,67,61,73,65,99,67,63,68,43,45,43,68,66,56,58,62,58,63,61,39,62,64,30,30,55,30,92,64,63,62,63,41,55,44,64,57,81,56,57,54,46,32,46,73,28,54,74,51,54',
  display: '25,30,39,60,62,78,91,22,48,48,39,48,26,38,25,44,69,42,66,60,64,59,68,57,64,68,25,26,50,48,48,49,100,72,73,79,84,67,63,86,89,42,42,82,65,97,88,91,71,91,79,65,70,85,72,96,77,73,67,47,44,47,57,50,60,63,63,67,74,57,54,72,75,36,36,71,56,85,78,78,61,76,68,55,61,71,62,85,67,63,61,41,27,41,49,25,48,74,41,50',
} as const;
type Font = keyof typeof ADVANCES;
const ADVANCE = Object.fromEntries(
  Object.entries(ADVANCES).map(([font, list]) => {
    const widths = list.split(',').map(Number);
    return [font, new Map(Array.from(GLYPHS, (ch, i) => [ch, widths[i]! / 100]))];
  }),
) as Record<Font, Map<string, number>>;

/** Text width in px (Manrope ExtraBold for 'ui', Cinzel Black for 'display'). */
export function measure(text: string, size: number, font: Font = 'ui', spacing = 0): number {
  let em = 0;
  let count = 0;
  for (const ch of text) {
    em += ADVANCE[font].get(ch) ?? 0.66;
    count++;
  }
  return em * size + spacing * count;
}

/** Shortens text with an ellipsis until it fits `maxW`. */
export function clip(text: string, size: number, maxW: number, font: Font = 'ui', spacing = 0): string {
  if (measure(text, size, font, spacing) <= maxW) return text;
  let chars = Array.from(text);
  while (chars.length > 1 && measure(`${chars.join('').trimEnd()}…`, size, font, spacing) > maxW) chars = chars.slice(0, -1);
  return `${chars.join('').trimEnd()}…`;
}

export interface Tone {
  fill: string;
  color: string;
  stroke?: string;
}

export const TONES: Record<Badge['tone'], Tone> = {
  gold: { fill: '#d6ad4b', color: '#1d1405' },
  good: { fill: '#1f9d63', color: '#f3fff8' },
  bad: { fill: '#b3263a', color: '#fff4f5' },
  neutral: { fill: '#3b4743', color: '#e9efe9' },
  info: { fill: '#16362b', color: '#d8e6dd', stroke: '#4f7a68' },
};
const TOTAL_TONE: Tone = { fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' };
const ACTIVE_TONE: Tone = { fill: '#e8c565', color: '#1d1405', stroke: '#fff0bf' };

const TAG_PAD = 0.5;
const TAG_H = 1.48;

export function tagWidth(text: string, size: number): number {
  return measure(text, size) + size * TAG_PAD * 2;
}

/** A rounded label with centred text; `x` is its centre, left or right edge per `anchor`. */
export function tag(text: string, x: number, cy: number, size: number, tone: Tone, anchor: 'start' | 'middle' | 'end' = 'middle'): string {
  const w = tagWidth(text, size);
  const h = size * TAG_H;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return (
    `<rect x="${n(left)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${tone.fill}"` +
    (tone.stroke ? ` stroke="${tone.stroke}" stroke-width="1.5"` : '') +
    '/>' +
    `<text x="${n(left + w / 2)}" y="${n(cy + size * 0.36)}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="${n(size)}" fill="${tone.color}">${esc(text)}</text>`
  );
}

/**
 * The longest spelling that fits `maxW`, stepping the size down towards the text floor before
 * giving up words (the last, shortest spelling at the floor if nothing fits).
 */
function fitTag(candidates: string[], size: number, maxW: number): { text: string; size: number } {
  const sizes = [...new Set([size, Math.max(TEXT_FLOOR, Math.round(size * 0.88)), Math.min(size, TEXT_FLOOR)])];
  for (const text of candidates) for (const s of sizes) if (tagWidth(text, s) <= maxW) return { text, size: s };
  return { text: candidates.at(-1)!, size: Math.min(size, TEXT_FLOOR) };
}

/** A tag with the longest spelling that fits; returns the markup and its width. */
export function fitted(candidates: string[], x: number, cy: number, size: number, maxW: number, tone: Tone, anchor: 'start' | 'middle' | 'end' = 'middle'): { svg: string; w: number } {
  const f = fitTag(candidates, size, maxW);
  return { svg: tag(f.text, x, cy, f.size, tone, anchor), w: tagWidth(f.text, f.size) };
}

export function badge(b: Badge, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end' = 'middle'): string {
  return tag(b.text, x, y, size, TONES[b.tone], anchor);
}

/** Shorter spellings of a hand's label, longest first: the renderer uses the longest that fits. */
export function handLabels(hand: { total: string; badge?: Badge | null }): string[] {
  const text = hand.badge?.text ?? hand.total;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+) · DOUBLED$/.exec(text))) return [m[1]!]; // the 2× marker says "doubled"
  if ((m = /^(\d+) · STAND$/.exec(text))) return [text, m[1]!];
  if ((m = /^BUST · (\d+)$/.exec(text) ?? /^Bust \((\d+)\)$/.exec(text))) return [`BUST · ${m[1]}`, `BUST ${m[1]}`, 'BUST'];
  if ((m = /^(\d+) · (WIN|LOSE|PUSH)$/.exec(text))) return [text, m[2]!];
  if (/^blackjack$/i.test(text)) return ['BLACKJACK', 'BJ'];
  if (text.startsWith('SURRENDER')) return [text, 'SURR.'];
  if ((m = /^soft (\d+)$/.exec(text))) return [text, `${Number(m[1]) - 10}/${m[1]}`];
  return [text];
}

function seatStatusLabels(text: string): string[] {
  if (text === 'INSURANCE?') return [text, 'INSURE?'];
  if (text === 'NO INSURANCE') return [text, 'NO INS.'];
  if (text === 'INSURED') return [text, 'INS.'];
  return [text];
}

function dealerLabels(text: string): string[] {
  const m = /^DEALER BUSTS · (\d+)$/.exec(text);
  return m ? [text, `BUSTS · ${m[1]}`, 'BUST'] : [text];
}

// ───────────────────────────── chips ─────────────────────────────

function chipColor(amount: number): { body: string; edge: string } {
  if (amount >= 500) return { body: '#1c1c22', edge: '#d6ad4b' };
  if (amount >= 100) return { body: '#156b45', edge: '#f1ead7' };
  if (amount >= 25) return { body: '#a8202f', edge: '#f1ead7' };
  return { body: '#e9e4d6', edge: '#2b5d9c' };
}

/** A casino chip with edge inserts. */
export function chip(cx: number, cy: number, r: number, amount: number): string {
  const { body, edge } = chipColor(amount);
  const inserts = Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3;
    const x = cx + Math.cos(a) * r * 0.82;
    const y = cy + Math.sin(a) * r * 0.82;
    return `<rect x="${n(x - r * 0.16)}" y="${n(y - r * 0.1)}" width="${n(r * 0.32)}" height="${n(r * 0.2)}" rx="1.5" fill="${edge}" transform="rotate(${n((a * 180) / Math.PI + 90)} ${n(x)} ${n(y)})"/>`;
  }).join('');
  return (
    `<circle cx="${n(cx)}" cy="${n(cy + 2)}" r="${n(r)}" fill="#000" opacity="0.35"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${body}"/>` +
    inserts +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.6)}" fill="none" stroke="${edge}" stroke-width="1.5" stroke-dasharray="3 2.5"/>`
  );
}

// ───────────────────────────── layout ─────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardSpot {
  x: number;
  y: number;
}

export type Arrangement = 'row' | 'column' | 'wrap' | 'grid' | 'stack';

export interface HandGeom {
  cardW: number;
  cardH: number;
  /** Every card of the hand, in deal order (laid out for the full hand, even mid-animation). */
  cards: CardSpot[];
  /** Bounds of the cards. */
  box: Rect;
  /** The total / outcome label straddles the bottom edge of the cards; `maxW` is its slot. */
  pill: { cx: number; cy: number; maxW: number };
  /** What a covered card still shows: its whole index, or (last resort) just its rank. */
  reveal: 'index' | 'rank';
}

export interface SeatGeom {
  seatIndex: number;
  rect: Rect;
  /** Where the hands go (and the seat status, when it has none). */
  body: Rect;
  nameSize: number;
  pillSize: number;
  /** Name: left edge and baseline; the header's right-hand item (bet, net, status) shares the row. */
  name: { x: number; y: number };
  header: { cy: number; left: number; right: number; h: number };
  /** Where the bet stack sits (chips fly to and from here). */
  chip: { x: number; y: number; r: number };
  arrangement: Arrangement;
  hands: HandGeom[];
}

export interface DealerGeom {
  rect: Rect;
  cardW: number;
  cardH: number;
  cards: CardSpot[];
  label: { x: number; y: number; size: number };
  total: { x: number; cy: number; size: number; maxW: number };
  /** The open felt right of the cards' anchor, used for "place your bets" between hands. */
  message: Rect;
}

export interface TableLayout {
  width: number;
  height: number;
  /** Occupied seats laid out (an empty table still shows one open seat). */
  count: number;
  rows: number[];
  dealer: DealerGeom;
  seats: Array<SeatGeom | undefined>;
  /** Where dealt cards come from, and where lost bets go. */
  shoe: { x: number; y: number; w: number };
  tray: { x: number; y: number };
  /** Rows had to share space unevenly (a seat with many split hands) or the image grew. */
  flexed: boolean;
}

interface Tier {
  rows: number[];
  height: number;
  dealerH: number;
  cap: number;
  maxPanelW: number;
  name: number;
  pill: number;
}

/** One layout tier per occupied-seat count: rows of panels, image height, type sizes. */
const TIERS: Record<number, Tier> = {
  1: { rows: [1], height: 540, dealerH: 184, cap: 170, maxPanelW: 620, name: 32, pill: 28 },
  2: { rows: [2], height: 540, dealerH: 184, cap: 150, maxPanelW: 453, name: 30, pill: 26 },
  3: { rows: [3], height: 540, dealerH: 160, cap: 128, maxPanelW: 300, name: 28, pill: 25 },
  4: { rows: [4], height: 540, dealerH: 154, cap: 116, maxPanelW: 222, name: 26, pill: 24 },
  5: { rows: [3, 2], height: 680, dealerH: 150, cap: 112, maxPanelW: 300, name: 26, pill: 24 },
  6: { rows: [3, 3], height: 680, dealerH: 150, cap: 112, maxPanelW: 300, name: 26, pill: 24 },
  7: { rows: [4, 3], height: 720, dealerH: 150, cap: 104, maxPanelW: 222, name: 24, pill: 22 },
};

const fanUnits = (k: number) => 1 + Math.max(0, k - 1) * STEP_X;
const wrapUnits = (counts: number[]) => counts.reduce((sum, k) => sum + fanUnits(Math.ceil(k / 2)), 0);
const cascadeUnits = (k: number, step = STEP_Y) => RATIO * (1 + Math.max(0, k - 1) * step);

interface Plan {
  kind: Arrangement;
  cw: number;
}

/** Each way of arranging a seat's hands in a W × H area, with the largest card width it allows. */
function plans(counts: number[], W: number, H: number, cap: number, pillH: number, compact = false): Plan[] {
  const nh = counts.length;
  if (nh === 0) return [{ kind: 'row', cw: cap }];
  const out: Plan[] = [];
  const gaps = (nh - 1) * HAND_GAP;
  const units = counts.reduce((sum, k) => sum + fanUnits(k), 0);
  out.push({ kind: 'row', cw: Math.min(cap, (W - gaps) / units, H / RATIO) });
  if (nh >= 2) {
    // Split hands as vertical cascades side by side (narrow and tall).
    out.push({ kind: 'column', cw: Math.min(cap, (W - gaps) / nh, H / cascadeUnits(Math.max(...counts))) });
    // Split hands in two rows of side-by-side fans.
    const perRow = Math.ceil(nh / 2);
    const rowUnits = Math.max(...[counts.slice(0, perRow), counts.slice(perRow)].map((r) => r.reduce((s, k) => s + fanUnits(k), 0)));
    out.push({ kind: 'grid', cw: Math.min(cap, (W - (perRow - 1) * HAND_GAP) / rowUnits, (H - pillH / 2 - 6) / (2 * RATIO)) });
    if (compact) out.push({ kind: 'stack', cw: Math.min(cap, (W - gaps) / nh, H / cascadeUnits(Math.max(...counts), STEP_RANK)) });
  }
  if (Math.max(...counts) >= 4) {
    // Long hands wrapped onto two overlapping rows each, side by side.
    out.push({ kind: 'wrap', cw: Math.min(cap, (W - gaps) / wrapUnits(counts), H / (RATIO * (1 + STEP_Y))) });
  }
  return out;
}

function bestPlan(counts: number[], W: number, H: number, cap: number, pillH: number, compact = false): Plan {
  // Prefer the plain row unless another arrangement gives clearly larger cards.
  const best = plans(counts, W, H, cap, pillH).reduce((a, p) => (p.cw > a.cw + 0.5 ? p : a));
  // Rank-only cascades only when nothing that shows whole indices stays legible.
  if (!compact || best.cw >= CARD_FLOOR) return best;
  return plans(counts, W, H, cap, pillH, true).reduce((a, p) => (p.cw > a.cw + 0.5 ? p : a));
}

/** Narrowest panel that fits a seat's hands at card width `cw` (Infinity if its height can't). */
function needWidth(counts: number[], cw: number, H: number, pillH: number, compact = false): number {
  const nh = counts.length;
  if (nh === 0) return 0;
  const gaps = (nh - 1) * HAND_GAP;
  const options: number[] = [];
  if (cw * RATIO <= H) options.push(counts.reduce((s, k) => s + fanUnits(k), 0) * cw + gaps);
  if (nh >= 2) {
    if (cw * cascadeUnits(Math.max(...counts)) <= H) options.push(nh * cw + gaps);
    if (compact && cw * cascadeUnits(Math.max(...counts), STEP_RANK) <= H) options.push(nh * cw + gaps);
    const perRow = Math.ceil(nh / 2);
    if (2 * RATIO * cw + pillH / 2 + 6 <= H) {
      const rowUnits = Math.max(...[counts.slice(0, perRow), counts.slice(perRow)].map((r) => r.reduce((s, k) => s + fanUnits(k), 0)));
      options.push(rowUnits * cw + (perRow - 1) * HAND_GAP);
    }
  }
  if (Math.max(...counts) >= 4 && cw * RATIO * (1 + STEP_Y) <= H) options.push(wrapUnits(counts) * cw + gaps);
  return options.length ? Math.min(...options) + PAD_X * 2 : Infinity;
}

/** Lays the cards of every hand out inside `body` for the chosen arrangement. */
function placeHands(counts: number[], plan: Plan, body: Rect, pillH: number): HandGeom[] {
  const cw = plan.cw;
  const ch = cw * RATIO;
  const stepX = cw * STEP_X;
  const stepY = ch * STEP_Y;
  const fan = (k: number) => cw + Math.max(0, k - 1) * stepX;
  const rankStep = ch * STEP_RANK;
  const hand = (k: number, x: number, y: number, mode: 'fan' | 'cascade' | 'stack' | 'wrap', slot: number): HandGeom => {
    let cards: CardSpot[];
    if (mode === 'fan') cards = Array.from({ length: k }, (_, c) => ({ x: x + c * stepX, y }));
    else if (mode === 'cascade' || mode === 'stack') cards = Array.from({ length: k }, (_, c) => ({ x, y: y + c * (mode === 'stack' ? rankStep : stepY) }));
    else {
      const k1 = Math.ceil(k / 2);
      cards = Array.from({ length: k }, (_, c) => (c < k1 ? { x: x + c * stepX, y } : { x: x + (c - k1) * stepX, y: y + stepY }));
    }
    const right = Math.max(...cards.map((c) => c.x)) + cw;
    const bottom = Math.max(...cards.map((c) => c.y)) + ch;
    const box = { x, y, w: right - x, h: bottom - y };
    return { cardW: cw, cardH: ch, cards, box, pill: { cx: x + box.w / 2, cy: bottom, maxW: Math.max(slot, box.w) }, reveal: mode === 'stack' ? 'rank' : 'index' };
  };
  const cx = body.x + body.w / 2;
  if (plan.kind === 'row') {
    const total = counts.reduce((s, k) => s + fan(k), 0) + (counts.length - 1) * HAND_GAP;
    // A single hand is anchored as if it held three cards, so a hit adds a card on the right
    // without the cards already on the table moving; longer hands slide left only as needed.
    let x = counts.length === 1 ? Math.max(body.x, Math.min(cx - fan(3) / 2, body.x + body.w - total)) : cx - total / 2;
    const y = body.y + (body.h - ch) / 2;
    return counts.map((k) => {
      const g = hand(k, x, y, 'fan', counts.length > 1 ? fan(k) + HAND_GAP : body.w);
      x += fan(k) + HAND_GAP;
      return g;
    });
  }
  if (plan.kind === 'column' || plan.kind === 'stack') {
    const total = counts.length * cw + (counts.length - 1) * HAND_GAP;
    const h = ch + (Math.max(...counts) - 1) * (plan.kind === 'stack' ? rankStep : stepY);
    const y = body.y + (body.h - h) / 2;
    return counts.map((k, i) => hand(k, cx - total / 2 + i * (cw + HAND_GAP), y, plan.kind === 'stack' ? 'stack' : 'cascade', cw + HAND_GAP));
  }
  if (plan.kind === 'wrap') {
    const widths = counts.map((k) => fan(Math.ceil(k / 2)));
    const total = widths.reduce((a, b) => a + b, 0) + (counts.length - 1) * HAND_GAP;
    const y = body.y + (body.h - (ch + stepY)) / 2;
    let x = cx - total / 2;
    return counts.map((k, i) => {
      const g = hand(k, x, y, 'wrap', counts.length > 1 ? widths[i]! + HAND_GAP : body.w);
      x += widths[i]! + HAND_GAP;
      return g;
    });
  }
  const perRow = Math.ceil(counts.length / 2);
  const rows = [counts.slice(0, perRow), counts.slice(perRow)];
  const rowStep = ch + pillH / 2 + 6;
  const top = body.y + (body.h - (rowStep + ch)) / 2;
  return rows.flatMap((row, r) => {
    const total = row.reduce((s, k) => s + fan(k), 0) + (row.length - 1) * HAND_GAP;
    let x = cx - total / 2;
    return row.map((k) => {
      const g = hand(k, x, top + r * rowStep, 'fan', fan(k) + HAND_GAP);
      x += fan(k) + HAND_GAP;
      return g;
    });
  });
}

/** Lays hands (given their card counts) out in `body` with the largest legible cards that fit. */
export function arrangeHands(counts: number[], body: Rect, cap: number, pillSize: number): HandGeom[] {
  const pillH = pillHeight(pillSize);
  return placeHands(counts, bestPlan(counts, body.w, body.h, cap, pillH), body, pillH);
}

/** Overlap step between cards (fraction of the card width) that keeps every index visible. */
export const CARD_STEP = STEP_X;

interface PanelSpec {
  seat: SeatView;
  counts: number[];
}

function headerHeight(nameSize: number): number {
  return Math.round(nameSize * 1.42);
}

function pillHeight(pillSize: number): number {
  return pillSize * TAG_H;
}

/** Vertical space a panel of height `h` leaves for its cards. */
function bodyHeight(h: number, tier: Tier): number {
  return h - PAD_TOP - headerHeight(tier.name) - HEAD_GAP - (pillHeight(tier.pill) / 2 + 2) - PAD_BOTTOM;
}

function seatGeom(spec: PanelSpec, rect: Rect, tier: Tier, compact = false): SeatGeom {
  const hh = headerHeight(tier.name);
  const pillH = pillHeight(tier.pill);
  const body: Rect = { x: rect.x + PAD_X, y: rect.y + PAD_TOP + hh + HEAD_GAP, w: rect.w - PAD_X * 2, h: bodyHeight(rect.h, tier) };
  const plan = bestPlan(spec.counts, body.w, body.h, tier.cap, pillH, compact);
  const cy = rect.y + PAD_TOP + hh / 2;
  const chipR = Math.round(tier.name * 0.5);
  return {
    seatIndex: spec.seat.seatIndex,
    rect,
    body,
    nameSize: tier.name,
    pillSize: tier.pill,
    name: { x: rect.x + PAD_X + 4, y: cy + tier.name * 0.36 },
    header: { cy, left: rect.x + PAD_X, right: rect.x + rect.w - PAD_X, h: hh },
    chip: { x: rect.x + rect.w - PAD_X - chipR - 2, y: cy, r: chipR },
    arrangement: plan.kind,
    hands: placeHands(spec.counts, plan, body, pillH),
  };
}

interface RowFit {
  widths: number[];
  ok: boolean;
  flexed: boolean;
  compact: boolean;
  /** Smallest card width the row reaches. */
  t: number;
}

/**
 * Panel widths for one row: even by default; shared by need when a seat can't stay legible in an
 * even share; and only then, rank-only cascades for seats with many split hands.
 */
function rowWidths(specs: PanelSpec[], uniform: number, bodyH: number, tier: Tier): RowFit {
  const full = fitRow(specs, uniform, bodyH, tier, false);
  if (full.ok) return full;
  const tight = fitRow(specs, uniform, bodyH, tier, true);
  return tight.t > full.t ? tight : full;
}

function fitRow(specs: PanelSpec[], uniform: number, bodyH: number, tier: Tier, compact: boolean): RowFit {
  const pillH = pillHeight(tier.pill);
  const even = Math.min(...specs.map((s) => (s.counts.length ? bestPlan(s.counts, uniform - PAD_X * 2, bodyH, tier.cap, pillH, compact).cw : tier.cap)));
  if (even >= CARD_FLOOR) return { widths: specs.map(() => uniform), ok: true, flexed: compact, compact, t: even };
  const available = CONTENT_W - (specs.length - 1) * GAP;
  const minW = Math.min(uniform, Math.round(tier.name * 6.5));
  const total = (t: number) => specs.reduce((sum, s) => sum + Math.max(minW, needWidth(s.counts, Math.min(t, tier.cap), bodyH, pillH, compact)), 0);
  let lo = 0;
  let hi = tier.cap;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) <= available) lo = mid;
    else hi = mid;
  }
  // The seats that need room get just enough to clear the floor (plus a little); the rest goes
  // back to everyone else, up to an even share, so their names stay readable.
  const best = lo;
  const t = Math.min(best, CARD_FLOOR + 6);
  const widths = specs.map((s) => Math.max(minW, needWidth(s.counts, t, bodyH, pillH, compact)));
  let spare = available - widths.reduce((x, y) => x + y, 0);
  for (let round = 0; round < specs.length && spare > 0.01; round++) {
    const short = widths.flatMap((w, i) => (w < uniform - 0.01 ? [i] : []));
    if (!short.length) break;
    const share = spare / short.length;
    for (const i of short) {
      const add = Math.min(share, uniform - widths[i]!);
      widths[i]! += add;
      spare -= add;
    }
  }
  return { widths: widths.map((w) => w + Math.max(0, spare) / specs.length), ok: best >= CARD_FLOOR - 0.01, flexed: true, compact, t: best };
}

/** Where a table's dealer, seats, cards, shoe and chip tray go. Depends only on who is seated and how many cards each hand holds. */
export function tableLayout(view: TableView): TableLayout {
  const occupied = view.seats.filter((seat) => seat.userId !== null);
  const visible = occupied.length ? occupied : view.seats.slice(0, 1);
  const specs: PanelSpec[] = visible.map((seat) => ({ seat, counts: seat.hands.map((h) => h.cards.length) }));
  const count = Math.min(7, Math.max(1, specs.length));
  const tier = TIERS[count]!;
  // The tier's own rows and height first; only if a seat's hands can't stay legible there, a
  // taller image, then the same seats split differently across rows.
  let best: { layout: TableLayout; minCard: number } | null = null;
  for (const rows of ROW_OPTIONS[count]!) {
    for (let height = rows.length > tier.rows.length ? Math.max(tier.height, 640) : tier.height; height <= TABLE_MAX_H; height += 40) {
      const attempt = gridLayout(view, specs, tier, rows, height);
      if (attempt.ok) return attempt.layout;
      if (!best || attempt.minCard > best.minCard) best = attempt;
    }
  }
  return best!.layout;
}

/** Row splits to try per seat count, the tier's own first. */
const ROW_OPTIONS: Record<number, number[][]> = {
  1: [[1]],
  2: [[2]],
  3: [[3], [2, 1]],
  4: [[4], [2, 2]],
  5: [[3, 2], [2, 3]],
  6: [[3, 3], [4, 2], [2, 4]],
  7: [[4, 3], [3, 4]],
};

function gridLayout(view: TableView, specs: PanelSpec[], tier: Tier, rows: number[], height: number): { layout: TableLayout; ok: boolean; minCard: number } {
  const perRow = Math.max(...rows);
  const uniform = Math.min(tier.maxPanelW, (CONTENT_W - (perRow - 1) * GAP) / perRow);
  const seatTop = TOP + tier.dealerH + GAP;
  const rowH = (height - seatTop - BOTTOM - (rows.length - 1) * GAP) / rows.length;
  const seats: TableLayout['seats'] = [];
  let ok = true;
  let flexed = height > tier.height || rows.join() !== tier.rows.join();
  let minCard = Infinity;
  let index = 0;
  rows.forEach((count, r) => {
    const row = specs.slice(index, index + count);
    index += count;
    if (!row.length) return;
    const fit = rowWidths(row, uniform, bodyHeight(rowH, tier), tier);
    ok &&= fit.ok;
    flexed ||= fit.flexed;
    const rowW = fit.widths.reduce((a, b) => a + b, 0) + (row.length - 1) * GAP;
    let x = (TABLE_W - rowW) / 2;
    row.forEach((spec, i) => {
      const w = fit.widths[i]!;
      const geom = seatGeom(spec, { x, y: seatTop + r * (rowH + GAP), w, h: rowH }, tier, fit.compact);
      for (const hand of geom.hands) minCard = Math.min(minCard, hand.cardW);
      seats[spec.seat.seatIndex] = geom;
      x += w + GAP;
    });
  });
  const layout = { width: TABLE_W, height, count: specs.length, rows, dealer: dealerGeom(view, tier), seats, ...fixtures(tier), flexed };
  return { layout, ok: ok && minCard >= CARD_FLOOR - 0.01, minCard };
}

function fixtures(tier: Tier): Pick<TableLayout, 'shoe' | 'tray'> {
  return { shoe: { x: TABLE_W - EDGE_X - 96, y: TOP + 16, w: 62 }, tray: { x: EDGE_X + 118, y: TOP + tier.dealerH - 24 } };
}

const DEALER_CARDS_X = 300;

function dealerGeom(view: TableView, tier: Tier): DealerGeom {
  const rect = { x: EDGE_X, y: TOP, w: CONTENT_W, h: tier.dealerH };
  const cardW = Math.min(tier.cap, Math.floor((tier.dealerH - 24) / RATIO));
  const cardH = cardW * RATIO;
  const y = rect.y + (rect.h - cardH) / 2;
  const label = Math.max(TEXT_FLOOR, Math.round(tier.name * 0.95));
  return {
    rect,
    cardW,
    cardH,
    cards: view.dealer.cards.map((_, i) => ({ x: DEALER_CARDS_X + i * cardW * STEP_X, y })),
    label: { x: EDGE_X + 20, y: rect.y + 22 + label * 0.7, size: label },
    total: { x: EDGE_X + 18, cy: rect.y + 22 + label * 0.7 + 14 + pillHeight(tier.pill + 2) / 2, size: tier.pill + 2, maxW: DEALER_CARDS_X - EDGE_X - 18 - 20 },
    message: { x: DEALER_CARDS_X - 20, y: rect.y, w: TABLE_W - EDGE_X - 120 - (DEALER_CARDS_X - 20), h: rect.h },
  };
}

/** Panel rectangles by seat index (seats nobody occupies have none). */
export function seatRects(view: TableView): Array<Rect | undefined> {
  return tableLayout(view).seats.map((seat) => seat?.rect);
}

// ───────────────────────────── drawing ─────────────────────────────

/** Soft gold halo behind the card that just arrived. */
function freshGlow(x: number, y: number, w: number, h: number): string {
  return (
    `<rect x="${n(x - 5)}" y="${n(y - 5)}" width="${n(w + 10)}" height="${n(h + 10)}" rx="${n(w * 0.12)}" fill="#f2d78a" fill-opacity="0.55" filter="url(#glow)"/>` +
    `<rect x="${n(x - 2.5)}" y="${n(y - 2.5)}" width="${n(w + 5)}" height="${n(h + 5)}" rx="${n(w * 0.1)}" fill="none" stroke="#f2d78a" stroke-width="2.5"/>`
  );
}

/** Insurance decisions are shown beside the hand's total (there is exactly one hand at that point). */
const INSURANCE_STATUS = new Set(['INSURANCE?', 'INSURED', 'NO INSURANCE']);

function insuranceTag(seat: SeatView): { text: string; tone: Tone } | null {
  switch (seat.insurance) {
    case 'taken':
      return { text: 'INS', tone: TONES.gold };
    case 'paid':
      return { text: 'INS', tone: TONES.good };
    case 'lost':
      return { text: 'INS', tone: { fill: '#2b3431', color: '#aab8b1', stroke: '#56645e' } };
    default:
      return null;
  }
}

/** Name on the left; on the right the result or the bet, and an insurance tag. */
function headerItems(seat: SeatView, g: SeatGeom, results: boolean): string[] {
  const occupied = seat.userId !== null;
  const items: Array<{ w: number; draw: (right: number) => string }> = [];
  const statusInHeader = results && !!seat.status;
  if (statusInHeader && seat.status) {
    const f = fitTag([seat.status.text], g.pillSize, g.rect.w * 0.55);
    const tone = TONES[seat.status.tone];
    items.push({ w: tagWidth(f.text, f.size), draw: (x) => tag(f.text, x, g.header.cy, f.size, tone, 'end') });
  }
  // (While insurance is being decided, the decision shows beside the hand instead.)
  const deciding = !!seat.status && INSURANCE_STATUS.has(seat.status.text);
  const ins = deciding ? null : insuranceTag(seat);
  if (ins) items.push({ w: tagWidth(ins.text, g.pillSize), draw: (x) => tag(ins.text, x, g.header.cy, g.pillSize, ins.tone, 'end') });
  const money = !statusInHeader && seat.bet ? seat.bet.toLocaleString('en-US') : null;
  const moneySize = Math.max(TEXT_FLOOR, g.nameSize - 2);
  const moneyW = money ? measure(money, moneySize) : 0;
  const name = fontSafe(seat.name);
  const gaps = (count: number) => count * 8;
  const room = (withChip: boolean) =>
    g.header.right - g.name.x - items.reduce((s, i) => s + i.w, 0) - (money ? moneyW + (withChip ? g.chip.r * 2 + 6 : 0) : 0) - gaps(items.length + (money ? 1 : 0));
  // The chip graphic is the first thing to go when a long name needs the room.
  const withChip = !!money && measure(name, g.nameSize) > room(true) ? false : !!money;
  const out: string[] = [];
  let right = g.header.right;
  if (money) {
    if (withChip) {
      out.push(chip(right - g.chip.r - 2, g.chip.y, g.chip.r, seat.bet!));
      right -= g.chip.r * 2 + 8;
    }
    out.push(
      `<text x="${n(right)}" y="${n(g.header.cy + moneySize * 0.36)}" text-anchor="end" font-family="Manrope" font-weight="800" font-size="${moneySize}" fill="${seat.active ? '#1d1405' : '#e8c565'}">${esc(money)}</text>`,
    );
    right -= moneyW + 8;
  }
  for (const item of items) {
    out.push(item.draw(right));
    right -= item.w + 8;
  }
  out.push(
    `<text x="${n(g.name.x)}" y="${n(g.name.y)}" font-family="Manrope" font-weight="800" font-size="${g.nameSize}" fill="${seat.active ? '#1d1405' : occupied ? '#f6f1e3' : '#8fae9f'}">${esc(clip(name, g.nameSize, room(withChip)))}</text>`,
  );
  return out;
}

function seatPanel(seat: SeatView, g: SeatGeom, view: TableView): string {
  const parts: string[] = [];
  const { rect: r } = g;
  const occupied = seat.userId !== null;
  const results = view.mode === 'results' && seat.net !== null;
  const outcome = results ? (seat.net! > 0 ? '#34c27f' : seat.net! < 0 ? '#d0505f' : 'rgba(232,217,168,0.6)') : null;
  const stroke = seat.active ? '#e8c565' : (outcome ?? (occupied ? 'rgba(232,197,101,0.32)' : 'rgba(255,255,255,0.14)'));
  if (seat.active) {
    parts.push(`<rect x="${n(r.x - 4)}" y="${n(r.y - 4)}" width="${n(r.w + 8)}" height="${n(r.h + 8)}" rx="18" fill="none" stroke="#e8c565" stroke-opacity="0.4" stroke-width="7" filter="url(#glow)"/>`);
  }
  parts.push(
    `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" rx="14" fill="${occupied ? 'rgba(3,17,12,0.6)' : 'rgba(3,17,12,0.25)'}" stroke="${stroke}" stroke-width="${seat.active ? 3.5 : outcome ? 3 : 1.5}"${occupied ? '' : ' stroke-dasharray="6 6"'}/>`,
  );
  // Header band: gold for the player to act, so the spotlight reads at a glance.
  const band = g.header.h + PAD_TOP;
  parts.push(
    `<path d="M ${n(r.x + 1.5)} ${n(r.y + band)} V ${n(r.y + 14)} Q ${n(r.x + 1.5)} ${n(r.y + 1.5)} ${n(r.x + 14)} ${n(r.y + 1.5)} H ${n(r.x + r.w - 14)} Q ${n(r.x + r.w - 1.5)} ${n(r.y + 1.5)} ${n(r.x + r.w - 1.5)} ${n(r.y + 14)} V ${n(r.y + band)} Z" fill="${seat.active ? 'url(#activeBand)' : 'rgba(255,255,255,0.045)'}"/>`,
  );
  parts.push(...headerItems(seat, g, results));
  if (seat.hands.length > 0) {
    seat.hands.forEach((hand, i) => {
      const hg = g.hands[i];
      if (!hg) return;
      const shown = hand.visible ?? hand.cards.length;
      if (hand.active && seat.hands.length > 1) {
        parts.push(`<rect x="${n(hg.box.x - 5)}" y="${n(hg.box.y - 5)}" width="${n(hg.box.w + 10)}" height="${n(hg.box.h + 10)}" rx="9" fill="none" stroke="#e8c565" stroke-width="3"/>`);
      }
      hand.cards.slice(0, shown).forEach((card, c) => {
        const at = hg.cards[c]!;
        if (c === hand.fresh) parts.push(freshGlow(at.x, at.y, hg.cardW, hg.cardH));
        parts.push(cardFace(card, at.x, at.y, hg.cardW, { dim: hand.dim }));
      });
      // Totals appear once every card of the hand has landed.
      if (shown < hand.cards.length) return;
      const tone = hand.badge ? TONES[hand.badge.tone] : hand.active ? ACTIVE_TONE : TOTAL_TONE;
      const decision = i === 0 && seat.status && INSURANCE_STATUS.has(seat.status.text) ? seat.status : null;
      if (decision) {
        // Total and insurance decision side by side under the (single) hand.
        const total = fitTag(handLabels(hand), g.pillSize, hg.pill.maxW / 2);
        const tw = tagWidth(total.text, total.size);
        const said = fitTag(seatStatusLabels(decision.text), g.pillSize, g.body.w - tw - 8);
        const left = hg.pill.cx - (tw + 8 + tagWidth(said.text, said.size)) / 2;
        parts.push(tag(total.text, left, hg.pill.cy, total.size, tone, 'start'));
        parts.push(tag(said.text, left + tw + 8, hg.pill.cy, said.size, TONES[decision.tone], 'start'));
      } else {
        parts.push(fitted(handLabels(hand), hg.pill.cx, hg.pill.cy, g.pillSize, hg.pill.maxW, tone).svg);
      }
      if (hand.doubled) {
        // Doubled: a gold "2×" on the last card, just right of its index.
        const at = doubleTag(hg);
        parts.push(tag('2×', at.x, at.cy, at.size, { fill: '#1d1405', color: '#f4dc8f', stroke: '#e8c565' }, 'start'));
      }
    });
  } else if (occupied) {
    const cw = Math.min(64, g.body.h / RATIO / 1.15);
    const ch = cw * RATIO;
    const cx = g.body.x + g.body.w / 2 - cw * 0.75;
    const cy = g.body.y + (g.body.h - ch) / 2;
    for (let i = 0; i < 2; i++) {
      parts.push(`<rect x="${n(cx + i * cw * 0.5)}" y="${n(cy)}" width="${n(cw)}" height="${n(ch)}" rx="7" fill="none" stroke="rgba(232,197,101,0.3)" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    }
    if (seat.status) parts.push(fitted([seat.status.text], g.body.x + g.body.w / 2, g.body.y + g.body.h / 2 + 6, g.pillSize, g.body.w, TONES[seat.status.tone]).svg);
  } else {
    parts.push(
      `<text x="${n(r.x + r.w / 2)}" y="${n(g.body.y + g.body.h / 2 + 8)}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="${TEXT_FLOOR}" fill="rgba(232,217,168,0.5)" letter-spacing="3">OPEN SEAT</text>`,
    );
  }
  return parts.join('');
}

/**
 * Where a doubled hand's "2×" goes: on its last card, clear of that card's index, at the text
 * floor so it never reaches past the gap into a neighbouring hand.
 */
export function doubleTag(hand: HandGeom): { x: number; cy: number; w: number; h: number; size: number } {
  const last = hand.cards.at(-1)!;
  const size = TEXT_FLOOR;
  const h = size * TAG_H;
  return { x: last.x + (INDEX_BOX.x1 * hand.cardW) / CARD_W + 3, cy: last.y + h / 2 + 3, w: tagWidth('2×', size), h, size };
}

/** The dealer's chip rack: where lost bets go and winnings come from. */
function tray(x: number, y: number): string {
  const parts = [`<rect x="${n(x - 92)}" y="${n(y - 13)}" width="184" height="26" rx="6" fill="#1b120a" stroke="#6b4a24" stroke-width="1.5"/>`];
  const colors = ['#1c1c22', '#156b45', '#a8202f', '#e9e4d6', '#a8202f', '#156b45', '#1c1c22'];
  colors.forEach((c, i) => {
    parts.push(`<rect x="${n(x - 84 + i * 24)}" y="${n(y - 8)}" width="20" height="16" rx="3" fill="${c}" stroke="#d6ad4b" stroke-opacity="0.5" stroke-width="1"/>`);
  });
  return parts.join('');
}

function dealerStrip(view: TableView, L: TableLayout, felt: { line: string }): string {
  const d = L.dealer;
  const parts: string[] = [];
  // A gold line where the dealer's side of the felt ends.
  const lineY = d.rect.y + d.rect.h + GAP / 2;
  parts.push(`<path d="M ${EDGE_X + 30} ${n(lineY)} H ${TABLE_W - EDGE_X - 30}" stroke="${felt.line}" stroke-opacity="0.35" stroke-width="1.2"/>`);
  parts.push(
    `<text x="${n(d.label.x)}" y="${n(d.label.y)}" font-family="Cinzel" font-weight="900" font-size="${d.label.size}" fill="#e8c565" letter-spacing="4">DEALER</text>`,
  );
  parts.push(tray(L.tray.x, L.tray.y));
  // The shoe (where cards come from).
  for (let i = 0; i < 3; i++) parts.push(cardBack(L.shoe.x - 8 + i * 4, L.shoe.y - 6 + i * 3, L.shoe.w, view.cardBackId, { shadow: i === 2 }));
  parts.push(`<rect x="${n(L.shoe.x - 16)}" y="${n(L.shoe.y + L.shoe.w * RATIO - 6)}" width="${n(L.shoe.w + 28)}" height="18" rx="5" fill="#1d120a" stroke="#6b4a24" stroke-width="1.5"/>`);
  const cards = view.dealer.cards;
  if (cards.length === 0) {
    const m = d.message;
    const title = view.mode === 'betting' ? 'BETS ARE OPEN' : view.mode === 'dealing' ? 'DEALING' : 'PLACE YOUR BETS';
    const cy = m.y + m.h / 2;
    const bets = `Bets ${view.minBet.toLocaleString('en-US')} – ${view.maxBet.toLocaleString('en-US')}`;
    parts.push(
      `<text x="${n(m.x + m.w / 2)}" y="${n(cy - 14)}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="34" fill="rgba(246,241,227,0.94)" letter-spacing="3">${title}</text>`,
    );
    parts.push(
      `<text x="${n(m.x + m.w / 2)}" y="${n(cy + 22)}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="${TEXT_FLOOR}" fill="rgba(232,217,168,0.9)">${esc(clip(bets, TEXT_FLOOR, m.w))}</text>`,
    );
    parts.push(
      `<text x="${n(m.x + m.w / 2)}" y="${n(cy + 54)}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="${TEXT_FLOOR}" fill="${felt.line}" fill-opacity="0.75" letter-spacing="1.5">${esc(clip(view.rulesArc.split('  ·  ')[0] ?? '', TEXT_FLOOR, m.w, 'display', 1.5))}</text>`,
    );
    return parts.join('');
  }
  // Printed on the felt, like a real table, where the dealer's cards leave room for it.
  const cardsRight = d.cards.at(-1)!.x + d.cardW;
  const textRight = L.shoe.x - 34;
  const lines = [view.roundNumber > 0 ? `HAND ${view.roundNumber}` : '', view.rulesArc.split('  ·  ')[0] ?? ''].filter(
    (line) => line && measure(line, TEXT_FLOOR, 'display', 1.5) <= textRight - cardsRight - 30,
  );
  {
    lines.forEach((line, i) => {
      parts.push(
        `<text x="${n(textRight)}" y="${n(d.rect.y + d.rect.h / 2 + (i - (lines.length - 1) / 2) * 34 + 8)}" text-anchor="end" font-family="Cinzel" font-weight="700" font-size="${TEXT_FLOOR}" fill="${felt.line}" fill-opacity="0.7" letter-spacing="1.5">${esc(line)}</text>`,
      );
    });
  }
  const shown = view.dealer.visible ?? cards.length;
  cards.slice(0, shown).forEach((card, i) => {
    const at = d.cards[i]!;
    if (i === view.dealer.fresh && card) parts.push(freshGlow(at.x, at.y, d.cardW, d.cardH));
    parts.push(card ? cardFace(card, at.x, at.y, d.cardW) : cardBack(at.x, at.y, d.cardW, view.cardBackId));
  });
  if (shown < cards.length) return parts.join(''); // cards still arriving: no total yet
  const t = d.total;
  if (view.dealer.badge) parts.push(fitted(dealerLabels(view.dealer.badge.text), t.x, t.cy, t.size, t.maxW, TONES[view.dealer.badge.tone], 'start').svg);
  else if (view.dealer.total) parts.push(fitted(handLabels({ total: view.dealer.total }), t.x, t.cy, t.size, t.maxW, TOTAL_TONE, 'start').svg);
  return parts.join('');
}

/** `overlay` is drawn on top of everything (cards and chips in motion, for animations). */
export function renderTableSvg(view: TableView, overlay = ''): string {
  const felt = FELTS[view.feltId] ?? FELTS.emerald!;
  const L = tableLayout(view);
  const { width: W, height: H } = L;
  const defs =
    cardDefs() +
    `<radialGradient id="felt" cx="50%" cy="18%" r="90%"><stop offset="0" stop-color="${felt.inner}"/><stop offset="1" stop-color="${felt.outer}"/></radialGradient>` +
    '<linearGradient id="activeBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4dc8f"/><stop offset="1" stop-color="#d6ad4b"/></linearGradient>' +
    '<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="5"/></filter>';
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#06120d"/>`);
  parts.push(`<rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="26" fill="url(#felt)"/>`);
  // Padded rail and gold pinstripe.
  parts.push(`<rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="24" fill="none" stroke="${felt.rail}" stroke-width="8"/>`);
  parts.push(`<rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="19" fill="none" stroke="${felt.line}" stroke-opacity="0.5" stroke-width="1.3"/>`);
  parts.push(dealerStrip(view, L, felt));
  view.seats.forEach((seat) => {
    const g = L.seats[seat.seatIndex];
    if (g) parts.push(seatPanel(seat, g, view));
  });
  parts.push(overlay);
  return svgDoc(W, H, parts.join(''), defs);
}
