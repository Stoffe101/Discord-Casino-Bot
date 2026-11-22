import type { Card } from '../games/cards.js';
import type { TableView } from '../tables/table-view.js';
import { cardBack, cardFace } from './cards.js';
import type { GifFrame } from './gif.js';
import { n } from './svg.js';
import { SHOE, TRAY, chip, dealerLayout, renderTableSvg, seatHandLayout, seatRects } from './table-image.js';

/**
 * Card and chip motion for the blackjack table, as GIF frames.
 *
 * Every animation is laid out for the FINAL state of the table: cards still in the air are hidden
 * from the table and drawn in flight on top, so nothing shifts when they land, and the last frame
 * is exactly the final table.
 */

export type CardTarget = { seat: number; hand: number; card: number } | { dealer: number };

export interface Arrival {
  to: CardTarget;
  /** Turn a card over where it lies instead of dealing it in (the dealer's hole card). */
  flipOnly?: boolean;
}

export interface MotionTiming {
  /** Frames one card spends travelling (and turning over). */
  flight: number;
  /** Frames between two cards leaving the shoe (cards overlap in the air when < flight). */
  stagger: number;
  frameMs: number;
  /** Extra time on the frame where a card lands (dealer draws: let each card register). */
  landMs?: number;
  /** Hide turn highlights until the last card lands (the deal). */
  quiet?: boolean;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Spot {
  x: number;
  y: number;
  w: number;
  card: Card | null;
}

function locate(view: TableView, to: CardTarget): Spot | null {
  if ('dealer' in to) {
    const layout = dealerLayout(view.dealer.cards.length);
    const at = layout.cards[to.dealer];
    return at ? { x: at.x, y: at.y, w: layout.cardW, card: view.dealer.cards[to.dealer] ?? null } : null;
  }
  const seat = view.seats[to.seat];
  const rect = seatRects(view)[to.seat];
  if (!seat || !rect) return null;
  const layout = seatHandLayout(seat, rect.x, rect.y, rect.w, rect.h, view);
  const at = layout.hands[to.hand]?.cards[to.card];
  const card = seat.hands[to.hand]?.cards[to.card];
  return at && card ? { x: at.x, y: at.y, w: layout.cardW, card } : null;
}

/** A card drawn squashed horizontally around its centre (``sx`` 1 = flat, 0 = edge-on). */
function turning(svg: string, x: number, y: number, w: number, sx: number): string {
  const cx = x + w / 2;
  return `<g transform="translate(${n(cx)} 0) scale(${n(Math.max(0.04, sx))} 1) translate(${n(-cx)} 0)">${svg}</g>`;
}

function inFlight(view: TableView, arrival: Arrival, spot: Spot, p: number): string {
  const back = (x: number, y: number, w: number) => cardBack(x, y, w, view.cardBackId);
  if (arrival.flipOnly) {
    const sx = Math.abs(1 - 2 * p);
    return p < 0.5 || !spot.card ? turning(back(spot.x, spot.y, spot.w), spot.x, spot.y, spot.w, sx) : turning(cardFace(spot.card, spot.x, spot.y, spot.w), spot.x, spot.y, spot.w, sx);
  }
  // Travel for the first 70%, then turn face up (face-down cards just land).
  const m = easeOut(Math.min(1, p / 0.7));
  const x = lerp(SHOE.x, spot.x, m);
  const y = lerp(SHOE.y, spot.y, m);
  const w = lerp(SHOE.w, spot.w, m);
  if (p < 0.7 || !spot.card) {
    const tilt = (1 - m) * -16;
    return `<g transform="rotate(${n(tilt)} ${n(x + w / 2)} ${n(y + w * 0.7)})">${back(x, y, w)}</g>`;
  }
  const q = (p - 0.7) / 0.3;
  const sx = Math.abs(1 - 2 * q);
  return q < 0.5 ? turning(back(x, y, w), x, y, w, sx) : turning(cardFace(spot.card, x, y, w), x, y, w, sx);
}

/** Frames for cards arriving at the table (dealing, a hit, the dealer's reveal and draws). */
export function cardArrivalFrames(view: TableView, arrivals: Arrival[], timing: MotionTiming): GifFrame[] {
  const spots = arrivals.map((a) => locate(view, a.to));
  const total = timing.stagger * Math.max(0, arrivals.length - 1) + timing.flight + 1;
  const frames: GifFrame[] = [];
  for (let f = 0; f < total; f++) {
    const frameView = structuredClone(view);
    const pending = (a: number) => (f - a * timing.stagger) / timing.flight < 1;
    // Hide every card that hasn't landed yet (hands are dealt left to right, so a prefix stays).
    arrivals.forEach((a, i) => {
      if (!pending(i)) return;
      if ('dealer' in a.to) {
        frameView.dealer.visible = Math.min(frameView.dealer.visible ?? frameView.dealer.cards.length, a.to.dealer);
      } else {
        const hand = frameView.seats[a.to.seat]?.hands[a.to.hand];
        if (hand) hand.visible = Math.min(hand.visible ?? hand.cards.length, a.to.card);
      }
    });
    for (const seat of frameView.seats) {
      for (const hand of seat.hands) delete hand.fresh;
      if (timing.quiet) {
        seat.active = false;
        for (const hand of seat.hands) hand.active = false;
        if (seat.status?.text === 'TO ACT') seat.status = null;
      }
    }
    delete frameView.dealer.fresh;
    let overlay = '';
    let landing = false;
    arrivals.forEach((a, i) => {
      const p = (f - i * timing.stagger) / timing.flight;
      const spot = spots[i];
      if (!spot || p <= 0 || p >= 1) {
        if (p >= 1 && p < 1 + 1 / timing.flight) landing = true;
        return;
      }
      overlay += inFlight(view, a, spot, p);
    });
    const last = f === total - 1;
    frames.push({ svg: renderTableSvg(last ? view : frameView, last ? '' : overlay), delayMs: timing.frameMs + (landing && timing.landMs ? timing.landMs : 0) });
  }
  return frames;
}

export interface ChipMove {
  seat: number;
  /** true = winnings go from the tray to the seat; false = a lost bet goes to the tray. */
  toSeat: boolean;
  amount: number;
}

/** Frames for chips sliding between the dealer's tray and the seats (settling a hand). */
export function chipFrames(view: TableView, moves: ChipMove[], frames = 8, frameMs = 60): GifFrame[] {
  const rects = seatRects(view);
  const out: GifFrame[] = [];
  for (let f = 0; f <= frames; f++) {
    const t = easeOut(f / frames);
    let overlay = '';
    if (f < frames) {
      for (const move of moves) {
        const r = rects[move.seat];
        if (!r) continue;
        // Winnings land on the seat's own bet stack (top right of the seat).
        const seatX = r.x + r.w - 26;
        const seatY = r.y + 24;
        const [fromX, fromY, toX, toY] = move.toSeat ? [TRAY.x, TRAY.y, seatX, seatY] : [seatX, seatY, TRAY.x, TRAY.y];
        for (let k = 0; k < 4; k++) {
          const lag = Math.max(0, t - k * 0.07);
          overlay += chip(lerp(fromX, toX, lag) + k * 2, lerp(fromY, toY, lag) - k * 5, 19, move.amount);
        }
      }
    }
    out.push({ svg: renderTableSvg(view, overlay), delayMs: frameMs });
  }
  return out;
}
