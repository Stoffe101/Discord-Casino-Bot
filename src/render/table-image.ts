import { FELTS } from '../domain/progression.js';
import { fontSafe } from '../core/format.js';
import type { Badge, HandView, SeatView, TableView } from '../tables/table-view.js';
import { CARD_H, CARD_W, cardBack, cardDefs, cardFace } from './cards.js';
import { esc, fitText, n, pill, svgDoc } from './svg.js';

/**
 * Renders the whole blackjack table as one image: dealer on top, seats below, the active
 * player highlighted in gold. Sized so it stays legible when Discord shrinks it on phones.
 */

export const TABLE_W = 960;
const DEALER_H = 262;
const ROW_H = 236;
const MARGIN = 22;
const GAP = 14;

const TONES: Record<Badge['tone'], { fill: string; color: string; stroke?: string }> = {
  gold: { fill: '#d6ad4b', color: '#1d1405' },
  good: { fill: '#1f9d63', color: '#f3fff8' },
  bad: { fill: '#b3263a', color: '#fff4f5' },
  neutral: { fill: '#3b4743', color: '#e9efe9' },
  info: { fill: '#16362b', color: '#d8e6dd', stroke: '#4f7a68' },
};

function badge(b: Badge, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end' = 'middle'): string {
  const t = TONES[b.tone];
  return pill({ x, y, text: b.text, size, fill: t.fill, color: t.color, stroke: t.stroke, anchor });
}

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

function handsLayout(hands: HandView[], areaW: number): { cardW: number; offset: number; handW: number[]; gap: number } {
  const gap = hands.length > 1 ? 12 : 0;
  let cardW = hands.length === 1 ? 84 : hands.length === 2 ? 70 : 54;
  for (;;) {
    const offset = cardW * 0.36;
    const handW = hands.map((h) => cardW + Math.max(0, h.cards.length - 1) * offset);
    const total = handW.reduce((a, b) => a + b, 0) + gap * (hands.length - 1);
    if (total <= areaW || cardW <= 34) return { cardW, offset, handW, gap };
    cardW -= 4;
  }
}

function seatPanel(seat: SeatView, x: number, y: number, w: number, h: number, view: TableView): string {
  const parts: string[] = [];
  const occupied = seat.userId !== null;
  const strokeColor = seat.active ? '#e8c565' : occupied ? 'rgba(232,197,101,0.28)' : 'rgba(255,255,255,0.12)';
  const strokeWidth = seat.active ? 3.5 : 1.5;
  if (seat.active) {
    parts.push(`<rect x="${n(x - 4)}" y="${n(y - 4)}" width="${n(w + 8)}" height="${n(h + 8)}" rx="20" fill="none" stroke="#e8c565" stroke-opacity="0.35" stroke-width="8" filter="url(#glow)"/>`);
  }
  parts.push(
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="16" fill="${occupied ? 'rgba(4,20,14,0.55)' : 'rgba(4,20,14,0.25)'}" stroke="${strokeColor}" stroke-width="${strokeWidth}"${occupied ? '' : ' stroke-dasharray="6 6"'}/>`,
  );
  // Seat number medallion.
  parts.push(`<circle cx="${n(x + 22)}" cy="${n(y + 24)}" r="12" fill="${seat.active ? '#e8c565' : '#0c2a1f'}" stroke="#c9a54e" stroke-width="1.2"/>`);
  parts.push(
    `<text x="${n(x + 22)}" y="${n(y + 29)}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="13" fill="${seat.active ? '#1d1405' : '#e8d9a8'}">${seat.seatIndex + 1}</text>`,
  );
  const name = fitText(fontSafe(seat.name), 19, w - (seat.bet ? 140 : 60));
  parts.push(
    `<text x="${n(x + 42)}" y="${n(y + 31)}" font-family="Manrope" font-weight="800" font-size="19" fill="${occupied ? '#f6f1e3' : '#8fae9f'}">${esc(name)}</text>`,
  );
  if (seat.bet) {
    const label = seat.bet.toLocaleString('en-US');
    parts.push(chip(x + w - 26, y + 24, 12, seat.bet));
    parts.push(
      `<text x="${n(x + w - 44)}" y="${n(y + 30)}" text-anchor="end" font-family="Manrope" font-weight="800" font-size="17" fill="#e8c565">${esc(label)}</text>`,
    );
  }
  const areaTop = y + 50;
  const areaH = h - 50 - 40;
  if (seat.hands.length > 0) {
    const { cardW, offset, handW, gap } = handsLayout(seat.hands, w - 28);
    const cardH = (cardW * CARD_H) / CARD_W;
    const totalW = handW.reduce((a, b) => a + b, 0) + gap * (seat.hands.length - 1);
    let hx = x + (w - totalW) / 2;
    const cy = areaTop + (areaH - cardH) / 2;
    seat.hands.forEach((hand, i) => {
      if (hand.active && seat.hands.length > 1) {
        parts.push(`<rect x="${n(hx - 5)}" y="${n(cy - 5)}" width="${n(handW[i]! + 10)}" height="${n(cardH + 10)}" rx="9" fill="none" stroke="#e8c565" stroke-width="2.5"/>`);
      }
      hand.cards.forEach((card, c) => parts.push(cardFace(card, hx + c * offset, cy, cardW, { dim: hand.dim })));
      const totalText = hand.total;
      const badgeY = cy + cardH + 2;
      if (hand.badge) {
        parts.push(badge(hand.badge, hx + handW[i]! / 2, badgeY + 12, seat.hands.length > 2 ? 10 : 12));
      } else {
        parts.push(pill({ x: hx + handW[i]! / 2, y: badgeY + 12, text: totalText, size: seat.hands.length > 2 ? 11 : 13, fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' }));
      }
      hx += handW[i]! + gap;
    });
  } else if (occupied) {
    // Empty card outlines to show the seat is ready for the next deal.
    const cw = 64;
    const ch = (cw * CARD_H) / CARD_W;
    const cx = x + w / 2 - cw * 0.8;
    const cy = areaTop + (areaH - ch) / 2;
    for (let i = 0; i < 2; i++) {
      parts.push(`<rect x="${n(cx + i * cw * 0.6)}" y="${n(cy)}" width="${cw}" height="${n(ch)}" rx="7" fill="none" stroke="rgba(232,197,101,0.35)" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    }
  } else {
    parts.push(
      `<text x="${n(x + w / 2)}" y="${n(areaTop + areaH / 2 + 6)}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="16" fill="rgba(232,217,168,0.45)" letter-spacing="3">OPEN SEAT</text>`,
    );
  }
  if (seat.status) {
    parts.push(badge(seat.status, x + w / 2, y + h - 18, 12));
  }
  void view;
  return parts.join('');
}

function dealerArea(view: TableView): string {
  const parts: string[] = [];
  const cardW = 96;
  const cardH = (cardW * CARD_H) / CARD_W;
  const offset = 46;
  const cards = view.dealer.cards;
  const cy = 50;
  parts.push(
    `<text x="${TABLE_W / 2}" y="40" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="20" fill="#e8c565" letter-spacing="6">DEALER</text>`,
  );
  if (cards.length === 0) {
    const message = view.mode === 'betting' ? 'BETS ARE OPEN' : 'PLACE YOUR BETS';
    parts.push(
      `<text x="${TABLE_W / 2}" y="${cy + cardH / 2 + 4}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="34" fill="rgba(246,241,227,0.92)" letter-spacing="4">${message}</text>`,
    );
    parts.push(
      `<text x="${TABLE_W / 2}" y="${cy + cardH / 2 + 36}" text-anchor="middle" font-family="Manrope" font-weight="700" font-size="16" fill="rgba(232,217,168,0.8)" letter-spacing="1">${esc(`Bets ${view.minBet.toLocaleString('en-US')} – ${view.maxBet.toLocaleString('en-US')}`)}</text>`,
    );
  } else {
    const totalW = cardW + (cards.length - 1) * offset;
    const startX = TABLE_W / 2 - totalW / 2;
    cards.forEach((card, i) => {
      parts.push(card ? cardFace(card, startX + i * offset, cy, cardW) : cardBack(startX + i * offset, cy, cardW, view.cardBackId));
    });
    const badgeY = cy + cardH + 18;
    if (view.dealer.badge) parts.push(badge(view.dealer.badge, TABLE_W / 2, badgeY, 14));
    else if (view.dealer.total) {
      parts.push(pill({ x: TABLE_W / 2, y: badgeY, text: view.dealer.total, size: 15, fill: '#0b241b', color: '#f6f1e3', stroke: '#c9a54e' }));
    }
  }
  return parts.join('');
}

function shoeDecor(view: TableView): string {
  // A card shoe (top right) and discard stack (top left) for atmosphere.
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) parts.push(cardBack(TABLE_W - 118 + i * 4, 30 + i * 3, 58, view.cardBackId, { shadow: i === 2 }));
  parts.push(`<rect x="${TABLE_W - 126}" y="104" width="84" height="18" rx="5" fill="#1d120a" stroke="#6b4a24" stroke-width="1.5"/>`);
  for (let i = 0; i < 2; i++) parts.push(cardBack(46 + i * 3, 36 + i * 2, 50, view.cardBackId, { shadow: false }));
  return parts.join('');
}

export function renderTableSvg(view: TableView): string {
  const felt = FELTS[view.feltId] ?? FELTS.emerald!;
  const perRow = view.maxSeats <= 3 ? view.maxSeats : view.maxSeats === 4 ? 2 : view.maxSeats <= 6 ? 3 : 4;
  const rows = Math.ceil(view.maxSeats / perRow);
  const height = DEALER_H + rows * ROW_H + (rows - 1) * GAP + MARGIN;
  const defs =
    cardDefs() +
    `<radialGradient id="felt" cx="50%" cy="22%" r="85%"><stop offset="0" stop-color="${felt.inner}"/><stop offset="1" stop-color="${felt.outer}"/></radialGradient>` +
    '<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="5"/></filter>' +
    `<path id="arc" d="M ${TABLE_W * 0.1} ${DEALER_H - 62} Q ${TABLE_W / 2} ${DEALER_H + 26} ${TABLE_W * 0.9} ${DEALER_H - 62}"/>`;
  const parts: string[] = [];
  parts.push(`<rect width="${TABLE_W}" height="${height}" fill="url(#felt)"/>`);
  // Padded rail and gold pinstripe.
  parts.push(`<rect x="5" y="5" width="${TABLE_W - 10}" height="${height - 10}" rx="26" fill="none" stroke="${felt.rail}" stroke-width="10"/>`);
  parts.push(`<rect x="13" y="13" width="${TABLE_W - 26}" height="${height - 26}" rx="20" fill="none" stroke="${felt.line}" stroke-opacity="0.55" stroke-width="1.5"/>`);
  parts.push(
    `<text font-family="Cinzel" font-weight="700" font-size="13" fill="${felt.line}" fill-opacity="0.75" letter-spacing="2.5"><textPath href="#arc" startOffset="50%" text-anchor="middle">${esc(view.rulesArc)}</textPath></text>`,
  );
  parts.push(
    `<text x="34" y="${DEALER_H - 14}" font-family="Cinzel" font-weight="900" font-size="15" fill="${felt.line}" fill-opacity="0.85" letter-spacing="3">${esc(fitText(fontSafe(view.name, 'TABLE').toUpperCase(), 15, 300, 'display'))}</text>`,
  );
  if (view.roundNumber > 0) {
    parts.push(
      `<text x="${TABLE_W - 34}" y="${DEALER_H - 14}" text-anchor="end" font-family="Cinzel" font-weight="900" font-size="15" fill="${felt.line}" fill-opacity="0.85" letter-spacing="3">HAND ${view.roundNumber}</text>`,
    );
  }
  parts.push(shoeDecor(view));
  parts.push(dealerArea(view));
  const panelW = (TABLE_W - MARGIN * 2 - GAP * (perRow - 1)) / perRow;
  for (let r = 0; r < rows; r++) {
    const rowSeats = view.seats.slice(r * perRow, (r + 1) * perRow);
    const rowW = rowSeats.length * panelW + (rowSeats.length - 1) * GAP;
    const startX = (TABLE_W - rowW) / 2;
    const y = DEALER_H + r * (ROW_H + GAP);
    rowSeats.forEach((seat, i) => parts.push(seatPanel(seat, startX + i * (panelW + GAP), y, panelW, ROW_H, view)));
  }
  return svgDoc(TABLE_W, height, parts.join(''), defs);
}
