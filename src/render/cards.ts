import { rankLabel, rankOf, suitOf, type Card, type Suit } from '../games/cards.js';
import { CARD_BACKS, type CardBackStyle } from '../domain/progression.js';
import { n } from './svg.js';

/**
 * Original playing-card artwork, drawn as vector shapes so it stays crisp at any size.
 * Design goals: a jumbo corner index (rank over suit, readable on phones when cards overlap),
 * one bold centre motif instead of tiny pips, and an ornamented court-card frame that keeps
 * clear of the index.
 */

export const CARD_W = 100;
export const CARD_H = 140;

/** The corner index, in card units (100 × 140). Everything a covered card must still show. */
export const INDEX = { cx: 25, baseline: 43, size: 46, suitCy: 60, suitSize: 26 } as const;
/** Cinzel's cap height as a fraction of the font size (measured from the bundled font). */
export const CINZEL_CAP = 0.7;
/** Height of the corner rank glyph as a fraction of the card width. */
export const RANK_CAP = (INDEX.size * CINZEL_CAP) / CARD_W;
/**
 * How much of a covered card must stay uncovered for its whole index (rank and suit) to show:
 * a fraction of the width when cards overlap sideways, of the height when they cascade down.
 */
export const INDEX_REVEAL_X = 0.48;
export const INDEX_REVEAL_Y = 0.54;
/** The index's bounding box in card units (the widest rank is a condensed "10" or K). */
export const INDEX_BOX = { x0: 4, y0: 8.5, x1: 46.5, y1: 73.5 } as const;
/** The rank alone (descenders included); a last-resort cascade keeps just this visible. */
export const RANK_BOX = { x0: 4, y0: 8.5, x1: 46.5, y1: 53 } as const;
export const RANK_REVEAL_Y = 0.385;

const RED = '#c22a3a';
const BLACK = '#17171c';
const PAPER = '#fbf8f0';
const PAPER_EDGE = '#d9d1bf';

/** Suit outlines in a 100×100 box. */
export const SUIT_PATHS: Record<Suit, string> = {
  H: 'M50 90 C30 74 4 56 4 31 C4 15 16 5 30 5 C40 5 47 11 50 19 C53 11 60 5 70 5 C84 5 96 15 96 31 C96 56 70 74 50 90 Z',
  D: 'M50 3 C60 20 74 36 92 50 C74 64 60 80 50 97 C40 80 26 64 8 50 C26 36 40 20 50 3 Z',
  S: 'M50 4 C60 20 96 38 96 61 C96 75 86 83 74 83 C65 83 58 79 54 72 C55 82 59 90 68 96 L32 96 C41 90 45 82 46 72 C42 79 35 83 26 83 C14 83 4 75 4 61 C4 38 40 20 50 4 Z',
  C: 'M50 6 C61 6 70 15 70 26 C70 33 67 39 62 43 C66 41 70 40 74 40 C86 40 96 49 96 61 C96 73 86 82 74 82 C65 82 58 78 54 71 C55 82 59 90 68 96 L32 96 C41 90 45 82 46 71 C42 78 35 82 26 82 C14 82 4 73 4 61 C4 49 14 40 26 40 C30 40 34 41 38 43 C33 39 30 33 30 26 C30 15 39 6 50 6 Z',
};

export function suitColor(suit: Suit): string {
  return suit === 'H' || suit === 'D' ? RED : BLACK;
}

/** A suit glyph centred on (cx, cy) with the given size. */
export function suitShape(suit: Suit, cx: number, cy: number, size: number, fill = suitColor(suit)): string {
  const s = size / 100;
  return `<path d="${SUIT_PATHS[suit]}" fill="${fill}" transform="translate(${n(cx - size / 2)} ${n(cy - size / 2)}) scale(${n(s)})"/>`;
}

/** Shared <defs> used by cards (gradients, patterns). Include once per document. */
export function cardDefs(): string {
  const backs = Object.entries(CARD_BACKS)
    .map(([id, style]) => cardBackPattern(id, style))
    .join('');
  return (
    `<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="${PAPER}"/></linearGradient>` +
    '<linearGradient id="courtRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe9e4"/><stop offset="1" stop-color="#f3d3cc"/></linearGradient>' +
    '<linearGradient id="courtBlack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eceff3"/><stop offset="1" stop-color="#d7dce4"/></linearGradient>' +
    '<clipPath id="courtClip"><rect x="53" y="16" width="36" height="108" rx="3"/></clipPath>' +
    '<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4dc8f"/><stop offset="0.5" stop-color="#d6ad4b"/><stop offset="1" stop-color="#a87c27"/></linearGradient>' +
    backs
  );
}

function cardBackPattern(id: string, style: CardBackStyle): string {
  return (
    `<pattern id="back-${id}" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="14" height="14" fill="${style.base}"/>` +
    `<rect width="7" height="7" fill="${style.pattern}"/><rect x="7" y="7" width="7" height="7" fill="${style.pattern}"/>` +
    '</pattern>'
  );
}

/** Soft two-layer offset shadow; much cheaper to rasterise than a blur filter. */
const SHADOW =
  `<rect x="1" y="4" width="${CARD_W}" height="${CARD_H}" rx="10" fill="#000" opacity="0.22"/>` +
  `<rect x="0.5" y="2" width="${CARD_W}" height="${CARD_H}" rx="9.5" fill="#000" opacity="0.25"/>`;

const CROWN = 'M10 34 L4 10 L22 22 L32 4 L42 22 L60 10 L54 34 Z';

/**
 * The jumbo corner index in card units: rank over suit, inside the strip a covering card leaves
 * visible. "10" is condensed so it fits the same strip as the single-character ranks.
 */
export function cardIndex(card: Card): string {
  const label = rankLabel(rankOf(card));
  const color = suitColor(suitOf(card));
  const condensed = label.length > 1 ? ' scale(0.74 1)' : '';
  return (
    `<text class="ix" transform="translate(${INDEX.cx} ${INDEX.baseline})${condensed}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="${INDEX.size}" fill="${color}">${label}</text>` +
    suitShape(suitOf(card), INDEX.cx, INDEX.suitCy, INDEX.suitSize)
  );
}

/**
 * A face-up card at (x, y) with width `w` (height follows the 5:7 ratio).
 * Optional `dim` greys the card (used for losing hands on the results screen).
 */
export function cardFace(card: Card, x: number, y: number, w: number, options: { dim?: boolean; shadow?: boolean } = {}): string {
  const s = w / CARD_W;
  const rank = rankOf(card);
  const suit = suitOf(card);
  const color = suitColor(suit);
  const label = rankLabel(rank);
  const isCourt = rank === 'J' || rank === 'Q' || rank === 'K';
  const isAce = rank === 'A';
  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="url(#paper)" stroke="${PAPER_EDGE}" stroke-width="1.4"/>`,
  );
  parts.push(cardIndex(card));
  if (isCourt) {
    const fill = color === RED ? 'url(#courtRed)' : 'url(#courtBlack)';
    parts.push(`<rect x="49" y="12" width="44" height="116" rx="5" fill="${fill}" stroke="${color}" stroke-width="1.6" stroke-opacity="0.55"/>`);
    parts.push(`<rect x="53" y="16" width="36" height="108" rx="3" fill="none" stroke="#c9a54e" stroke-width="1.1"/>`);
    parts.push(`<path d="${CROWN}" fill="url(#gold)" stroke="#8a6420" stroke-width="1" transform="translate(56.5 24) scale(0.48)"/>`);
    parts.push(
      `<g clip-path="url(#courtClip)"><text x="71" y="94" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="40" fill="${color}">${label}</text></g>`,
    );
    parts.push(suitShape(suit, 71, 111, 14));
  } else if (isAce) {
    parts.push(`<circle cx="67" cy="100" r="27" fill="none" stroke="#c9a54e" stroke-width="1.4" stroke-dasharray="2 3"/>`);
    parts.push(suitShape(suit, 67, 100, 40));
  } else {
    parts.push(suitShape(suit, 67, 101, 48));
  }
  const shadow = options.shadow === false ? '' : SHADOW;
  // Dimmed (losing) cards stay readable: a light veil, not a blackout.
  const dim = options.dim ? `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="#0b1a14" opacity="0.3"/>` : '';
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})">${shadow}${parts.join('')}${dim}</g>`;
}

/** A face-down card using one of the unlockable card-back styles. */
export function cardBack(x: number, y: number, w: number, backId = 'emerald', options: { shadow?: boolean } = {}): string {
  const style = CARD_BACKS[backId] ?? CARD_BACKS.emerald!;
  const id = CARD_BACKS[backId] ? backId : 'emerald';
  const s = w / CARD_W;
  const shadow = options.shadow === false ? '' : SHADOW;
  return (
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})">${shadow}` +
    `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="#fbf8f0" stroke="${PAPER_EDGE}" stroke-width="1.4"/>` +
    `<rect x="6" y="6" width="${CARD_W - 12}" height="${CARD_H - 12}" rx="6" fill="url(#back-${id})"/>` +
    `<rect x="10" y="10" width="${CARD_W - 20}" height="${CARD_H - 20}" rx="4" fill="none" stroke="${style.accent}" stroke-width="1.6"/>` +
    `<circle cx="50" cy="70" r="20" fill="${style.base}" stroke="${style.accent}" stroke-width="2"/>` +
    suitShape('S', 50, 70, 22, style.accent) +
    '</g>'
  );
}
