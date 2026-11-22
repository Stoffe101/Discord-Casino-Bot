import { rankLabel, rankOf, suitOf, type Card, type Suit } from '../games/cards.js';
import { CARD_BACKS, type CardBackStyle } from '../domain/progression.js';
import { n } from './svg.js';

/**
 * Original playing-card artwork, drawn as vector shapes so it stays crisp at any size.
 * Design goals: oversized corner indices (readable on phones when cards overlap),
 * one bold centre motif instead of tiny pips, and an ornamented court-card frame.
 */

export const CARD_W = 100;
export const CARD_H = 140;

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

/** Shared <defs> used by cards (gradients, shadow filter). Include once per document. */
export function cardDefs(): string {
  const backs = Object.entries(CARD_BACKS)
    .map(([id, style]) => cardBackPattern(id, style))
    .join('');
  return (
    '<filter id="cardShadow" x="-20%" y="-20%" width="140%" height="150%">' +
    '<feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#000" flood-opacity="0.45"/></filter>' +
    `<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="${PAPER}"/></linearGradient>` +
    '<linearGradient id="courtRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe9e4"/><stop offset="1" stop-color="#f3d3cc"/></linearGradient>' +
    '<linearGradient id="courtBlack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eceff3"/><stop offset="1" stop-color="#d7dce4"/></linearGradient>' +
    '<clipPath id="courtClip"><rect x="40" y="18" width="44" height="88" rx="3"/></clipPath>' +
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

const CROWN = 'M10 34 L4 10 L22 22 L32 4 L42 22 L60 10 L54 34 Z';

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
  const indexSize = label.length > 1 ? 31 : 36;
  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="url(#paper)" stroke="${PAPER_EDGE}" stroke-width="1.4"/>`,
  );
  // Corner index (top-left) — oversized for legibility when hands overlap.
  parts.push(
    `<text x="${label.length > 1 ? 6 : 9}" y="36" font-family="Cinzel" font-weight="900" font-size="${indexSize}" fill="${color}" letter-spacing="${label.length > 1 ? -2 : 0}">${label}</text>`,
  );
  parts.push(suitShape(suit, 20, 52, 22));
  // Mirrored small index (bottom-right).
  parts.push(
    `<g transform="rotate(180 ${CARD_W / 2} ${CARD_H / 2})"><text x="${label.length > 1 ? 7 : 9}" y="27" font-family="Cinzel" font-weight="900" font-size="22" fill="${color}" letter-spacing="${label.length > 1 ? -1.5 : 0}">${label}</text>${suitShape(suit, 16, 38, 13)}</g>`,
  );
  if (isCourt) {
    const fill = color === RED ? 'url(#courtRed)' : 'url(#courtBlack)';
    parts.push(`<rect x="36" y="14" width="52" height="96" rx="5" fill="${fill}" stroke="${color}" stroke-width="1.6" stroke-opacity="0.55"/>`);
    parts.push(`<rect x="40" y="18" width="44" height="88" rx="3" fill="none" stroke="#c9a54e" stroke-width="1.1"/>`);
    parts.push(`<path d="${CROWN}" fill="url(#gold)" stroke="#8a6420" stroke-width="1" transform="translate(44.5 26) scale(0.55)"/>`);
    parts.push(
      `<g clip-path="url(#courtClip)"><text x="62" y="83" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="38" fill="${color}">${label}</text></g>`,
    );
    parts.push(suitShape(suit, 62, 96, 12));
  } else if (isAce) {
    parts.push(`<circle cx="60" cy="80" r="30" fill="none" stroke="#c9a54e" stroke-width="1.4" stroke-dasharray="2 3"/>`);
    parts.push(suitShape(suit, 60, 80, 46));
  } else {
    parts.push(suitShape(suit, 60, 82, 48));
  }
  const filter = options.shadow === false ? '' : ' filter="url(#cardShadow)"';
  const dim = options.dim ? `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="#0b1a14" opacity="0.42"/>` : '';
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})"${filter}>${parts.join('')}${dim}</g>`;
}

/** A face-down card using one of the unlockable card-back styles. */
export function cardBack(x: number, y: number, w: number, backId = 'emerald', options: { shadow?: boolean } = {}): string {
  const style = CARD_BACKS[backId] ?? CARD_BACKS.emerald!;
  const id = CARD_BACKS[backId] ? backId : 'emerald';
  const s = w / CARD_W;
  const filter = options.shadow === false ? '' : ' filter="url(#cardShadow)"';
  return (
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})"${filter}>` +
    `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="9" fill="#fbf8f0" stroke="${PAPER_EDGE}" stroke-width="1.4"/>` +
    `<rect x="6" y="6" width="${CARD_W - 12}" height="${CARD_H - 12}" rx="6" fill="url(#back-${id})"/>` +
    `<rect x="10" y="10" width="${CARD_W - 20}" height="${CARD_H - 20}" rx="4" fill="none" stroke="${style.accent}" stroke-width="1.6"/>` +
    `<circle cx="50" cy="70" r="20" fill="${style.base}" stroke="${style.accent}" stroke-width="2"/>` +
    suitShape('S', 50, 70, 22, style.accent) +
    '</g>'
  );
}
