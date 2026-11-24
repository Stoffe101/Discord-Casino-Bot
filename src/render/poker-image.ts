import { chips } from '../core/format.js';
import type { publicPokerHand, Street } from '../games/poker/engine.js';
import { cardBack, cardDefs, cardFace } from './cards.js';
import { esc, fitText, svgDoc } from './svg.js';

const HEIGHT = 560;
const WIDTH = 840;
const STREETS: Record<Street, string> = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', complete: 'Result' };
const felt = '<radialGradient id="poker-felt"><stop offset="0" stop-color="#1d6f51"/><stop offset="1" stop-color="#0b3427"/></radialGradient>';
const pattern = '<pattern id="poker-grain" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 0h1v1H0zM3 3h1v1H3z" fill="#e5e7c9" opacity=".16"/></pattern>';

type PokerView = ReturnType<typeof publicPokerHand>;

/** Only a public poker projection may reach the shared image renderer. */
export function pokerTableSvg(view: PokerView, names: Readonly<Record<string, string>>): string {
  const visibleSeats = view.seats.length;
  const pot = view.seats.reduce((sum, seat) => sum + seat.committed, 0);
  const seatBoxes = view.seats.map((seat, i) => {
    const singleRow = visibleSeats <= 4;
    const columns = singleRow ? visibleSeats : Math.ceil(visibleSeats / 2);
    const position = i % columns;
    const width = (WIDTH - 72) / columns - 10;
    const x = 41 + position * (width + 10);
    const y = singleRow || i >= columns ? HEIGHT - 120 : 83;
    const active = view.actor === seat.seat;
    const name = fitText(names[seat.userId] ?? 'Player', 16, width - 18);
    const roles = [
      view.dealer === seat.seat ? 'D' : '',
      view.smallBlindSeat === seat.seat ? 'SB' : '',
      view.bigBlindSeat === seat.seat ? 'BB' : '',
    ].filter(Boolean).join(' · ');
    const status = seat.folded ? 'Folded'
      : active ? 'To act'
      : view.street !== 'complete' && seat.stack === 0 ? 'All-in'
      : seat.streetPaid ? `Bet ${chips(seat.streetPaid)}` : '';
    const cardY = y < 200 ? y + 71 : y - 49;
    const hand = seat.folded ? '' : [0, 1].map((j) => {
      const card = seat.cards?.[j];
      const cardX = x + width / 2 - 31 + j * 30;
      return card ? cardFace(card, cardX, cardY, 32) : view.street === 'complete' ? '' : cardBack(cardX, cardY, 32);
    }).join('');
    return hand +
      `<rect x="${x}" y="${y}" width="${width}" height="68" rx="13" fill="${active ? '#17392e' : '#13251f'}" stroke="${active ? '#f4d588' : '#847045'}" stroke-width="${active ? 2.5 : 1}"/>` +
      `<text x="${x + width / 2}" y="${y + 22}" text-anchor="middle" fill="#f2ede0" font-size="16" font-weight="800">${esc(name)}</text>` +
      `<text x="${x + width / 2}" y="${y + 44}" text-anchor="middle" fill="#f3d791" font-size="16">${chips(seat.stack)}</text>` +
      `<text x="${x + width / 2}" y="${y + 60}" text-anchor="middle" fill="#c5d4c8" font-size="12">${esc([roles, status].filter(Boolean).join(' · '))}</text>`;
  }).join('');
  const board = Array.from({ length: 5 }, (_, i) => {
    const x = 244 + i * 74;
    const card = view.board[i];
    return card ? cardFace(card, x, 226, 62)
      : `<rect x="${x}" y="226" width="62" height="87" rx="8" fill="#0b3f2e" stroke="#7c9d7a" stroke-dasharray="4 5"/>`;
  }).join('');
  const potLabel = view.result?.pots.length && view.result.pots.length > 1
    ? ` • ${view.result.pots.length - 1} side pots`
    : '';
  return svgDoc(WIDTH, HEIGHT,
    `<rect width="${WIDTH}" height="${HEIGHT}" rx="20" fill="#101b18"/>` +
    '<rect x="16" y="135" width="808" height="310" rx="150" fill="#261d16" stroke="#ac8644" stroke-width="3"/>' +
    '<rect x="33" y="151" width="774" height="278" rx="134" fill="url(#poker-felt)" stroke="#736044" stroke-width="2"/>' +
    '<rect x="35" y="154" width="770" height="272" rx="132" fill="url(#poker-grain)" opacity=".32"/>' +
    '<g font-family="Manrope">' +
    '<text x="28" y="40" fill="#f3d791" font-family="Cinzel" font-size="25" font-weight="800">THE EMERALD ROOM</text>' +
    `<text x="809" y="39" text-anchor="end" fill="#c5d4c8" font-size="16">NO-LIMIT HOLD’EM · ${STREETS[view.street]}</text>` +
    board +
    `<text x="420" y="348" text-anchor="middle" fill="#f3d791" font-size="20" font-weight="800">POT ${chips(pot)}${potLabel}</text>` +
    seatBoxes + '</g>', cardDefs() + felt + pattern);
}
