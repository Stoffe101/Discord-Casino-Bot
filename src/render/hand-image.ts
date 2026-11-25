import { FELTS } from '../domain/progression.js';
import type { Card } from '../games/cards.js';
import type { Badge } from '../tables/table-view.js';
import { CARD_H, CARD_W, cardBack, cardDefs, cardFace } from './cards.js';
import { esc, n, svgDoc } from './svg.js';
import { CARD_STEP, TONES, arrangeHands, fitted, handLabels } from './table-image.js';

/**
 * The player's private close-up: the dealer's cards on the left, your hand(s) large on the right,
 * with totals — readable on a phone without zooming into the shared table image. Text is at
 * least 20 px and card indices at least 9 px tall when the 760 px image is shown 400 px wide.
 */
export interface MyHandImage {
  feltId: string;
  cardBackId: string;
  dealer: (Card | null)[];
  dealerTotal: string | null;
  hands: Array<{ cards: Card[]; total: string; active: boolean; badge: Badge | null }>;
}

const W = 760;
const H = 300;
const TEXT = 20;
const DEALER_W = 206;
const HANDS_X = 282;

export function myHandSvg(view: MyHandImage): string {
  const felt = FELTS[view.feltId] ?? FELTS.emerald!;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="url(#hfelt)"/>`);
  parts.push(`<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="20" fill="none" stroke="${felt.line}" stroke-opacity="0.55" stroke-width="1.5"/>`);
  // Dealer, left.
  parts.push(`<text x="36" y="46" font-family="Cinzel" font-weight="900" font-size="${TEXT}" fill="${felt.line}" letter-spacing="3">DEALER</text>`);
  const count = Math.max(1, view.dealer.length);
  const dW = Math.min(76, DEALER_W / (1 + (count - 1) * CARD_STEP));
  const dH = (dW * CARD_H) / CARD_W;
  view.dealer.forEach((card, i) => {
    const x = 36 + i * dW * CARD_STEP;
    parts.push(card ? cardFace(card, x, 66, dW) : cardBack(x, 66, dW, view.cardBackId));
  });
  if (view.dealerTotal) {
    const span = dW * (1 + (count - 1) * CARD_STEP);
    parts.push(fitted(handLabels({ total: view.dealerTotal }), 36 + span / 2, 66 + dH, TEXT + 2, DEALER_W, { fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' }).svg);
  }
  parts.push(`<rect x="252" y="34" width="1.5" height="${H - 68}" fill="${felt.line}" opacity="0.35"/>`);
  // Your hand(s), right.
  parts.push(`<text x="${HANDS_X}" y="46" font-family="Cinzel" font-weight="900" font-size="${TEXT}" fill="${felt.line}" letter-spacing="3">YOUR HAND${view.hands.length > 1 ? 'S' : ''}</text>`);
  const geoms = arrangeHands(view.hands.map((h) => h.cards.length), { x: HANDS_X, y: 62, w: W - HANDS_X - 30, h: H - 62 - 34 }, 118, TEXT + 2);
  view.hands.forEach((hand, i) => {
    const g = geoms[i]!;
    if (hand.active && view.hands.length > 1) {
      parts.push(`<rect x="${n(g.box.x - 6)}" y="${n(g.box.y - 6)}" width="${n(g.box.w + 12)}" height="${n(g.box.h + 12)}" rx="10" fill="none" stroke="#e8c565" stroke-width="3"/>`);
    }
    hand.cards.forEach((card, c) => parts.push(cardFace(card, g.cards[c]!.x, g.cards[c]!.y, g.cardW)));
    const tone = hand.badge ? TONES[hand.badge.tone] : hand.active ? { fill: '#e8c565', color: '#1d1405', stroke: '#fff0bf' } : { fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' };
    const labels = handLabels(hand);
    parts.push(fitted(labels, g.pill.cx, g.pill.cy, TEXT + 2, g.pill.maxW, tone).svg);
  });
  if (view.hands.length === 0) parts.push(`<text x="${HANDS_X}" y="150" font-family="Manrope" font-weight="700" font-size="${TEXT}" fill="#cfe3d8">${esc('Not in this hand')}</text>`);
  const defs = cardDefs() + `<radialGradient id="hfelt" cx="50%" cy="30%" r="85%"><stop offset="0" stop-color="${felt.inner}"/><stop offset="1" stop-color="${felt.outer}"/></radialGradient>`;
  return svgDoc(W, H, parts.join(''), defs);
}
