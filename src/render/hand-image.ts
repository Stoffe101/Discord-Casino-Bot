import { FELTS } from '../domain/progression.js';
import type { Card } from '../games/cards.js';
import type { Badge } from '../tables/table-view.js';
import { CARD_H, CARD_W, cardBack, cardDefs, cardFace } from './cards.js';
import { esc, n, pill, svgDoc } from './svg.js';
import { badge } from './table-image.js';

/**
 * The player's private close-up: the dealer's cards on the left, your hand(s) large on the right,
 * with totals — readable on a phone without zooming into the shared table image.
 */
export interface MyHandImage {
  feltId: string;
  cardBackId: string;
  dealer: (Card | null)[];
  dealerTotal: string | null;
  hands: Array<{ cards: Card[]; total: string; active: boolean; badge: Badge | null }>;
}

export function myHandSvg(view: MyHandImage): string {
  const W = 760;
  const H = 300;
  const felt = FELTS[view.feltId] ?? FELTS.emerald!;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="url(#hfelt)"/>`);
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="20" fill="none" stroke="${felt.line}" stroke-opacity="0.55" stroke-width="1.5"/>`);
  // Dealer, left.
  parts.push(`<text x="40" y="44" font-family="Cinzel" font-weight="900" font-size="16" fill="${felt.line}" letter-spacing="4">DEALER</text>`);
  const dW = 72;
  view.dealer.forEach((card, i) => parts.push(card ? cardFace(card, 40 + i * 34, 62, dW) : cardBack(40 + i * 34, 62, dW, view.cardBackId)));
  if (view.dealerTotal) parts.push(pill({ x: 40 + (dW + (view.dealer.length - 1) * 34) / 2, y: 62 + (dW * CARD_H) / CARD_W + 22, text: view.dealerTotal, size: 15, fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' }));
  parts.push(`<rect x="250" y="34" width="1.5" height="${H - 68}" fill="${felt.line}" opacity="0.35"/>`);
  // Your hand(s), right.
  parts.push(`<text x="282" y="44" font-family="Cinzel" font-weight="900" font-size="16" fill="${felt.line}" letter-spacing="4">YOUR HAND${view.hands.length > 1 ? 'S' : ''}</text>`);
  const count = view.hands.length;
  const cardW = count === 1 ? 110 : count === 2 ? 84 : 58;
  const offset = cardW * 0.42;
  const areaW = W - 282 - 30;
  const widths = view.hands.map((h) => cardW + (h.cards.length - 1) * offset);
  const gap = count > 1 ? Math.max(10, (areaW - widths.reduce((a, b) => a + b, 0)) / count) : 0;
  let x = 282;
  const y = 64;
  const cardH = (cardW * CARD_H) / CARD_W;
  view.hands.forEach((hand, i) => {
    if (hand.active && count > 1) parts.push(`<rect x="${n(x - 6)}" y="${n(y - 6)}" width="${n(widths[i]! + 12)}" height="${n(cardH + 12)}" rx="10" fill="none" stroke="#e8c565" stroke-width="3"/>`);
    hand.cards.forEach((card, c) => parts.push(cardFace(card, x + c * offset, y, cardW)));
    const cx = x + widths[i]! / 2;
    const by = y + cardH + 24;
    parts.push(hand.badge ? badge(hand.badge, cx, by, count > 2 ? 12 : 16) : pill({ x: cx, y: by, text: hand.total, size: count > 2 ? 14 : 19, fill: hand.active ? '#e8c565' : '#0b241b', color: hand.active ? '#1d1405' : '#f6f1e3', stroke: '#c9a54e' }));
    x += widths[i]! + gap;
  });
  if (view.hands.length === 0) parts.push(`<text x="282" y="150" font-family="Manrope" font-weight="700" font-size="20" fill="#cfe3d8">${esc('Not in this hand')}</text>`);
  const defs = cardDefs() + `<radialGradient id="hfelt" cx="50%" cy="30%" r="85%"><stop offset="0" stop-color="${felt.inner}"/><stop offset="1" stop-color="${felt.outer}"/></radialGradient>`;
  return svgDoc(W, H, parts.join(''), defs);
}
