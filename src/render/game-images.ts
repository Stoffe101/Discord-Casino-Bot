import { CARD_BACKS, FELTS } from '../domain/progression.js';
import { fontSafe } from '../core/format.js';
import { WHEEL_ORDER, pocketColor } from '../games/roulette/engine.js';
import type { SlotSymbol } from '../games/slots/engine.js';
import { cardBack, cardDefs, cardFace, suitShape } from './cards.js';
import { chip } from './table-image.js';
import { esc, fitText, n, svgDoc } from './svg.js';

// ───────────────────────────── banner ─────────────────────────────

/** Wide header for the lobby: casino name in gold over emerald felt with a fanned hand. */
export function bannerSvg(casinoName: string): string {
  const W = 960;
  const H = 260;
  const name = fitText(fontSafe(casinoName, 'The Emerald Room').toUpperCase(), 40, 520, 'display');
  const defs =
    cardDefs() +
    '<radialGradient id="bfelt" cx="30%" cy="40%" r="90%"><stop offset="0" stop-color="#17704f"/><stop offset="1" stop-color="#05261a"/></radialGradient>';
  const fan = [
    cardFace('AS', 650, 70, 104),
    cardFace('KH', 700, 52, 104),
    cardFace('QD', 752, 44, 104),
    cardBack(806, 52, 104, 'emerald'),
  ]
    .map((c, i) => `<g transform="rotate(${-12 + i * 8} ${740} ${260})">${c}</g>`)
    .join('');
  const chips = [chip(600, 214, 22, 500), chip(632, 222, 22, 100), chip(616, 196, 22, 25), chip(880, 220, 20, 1000)].join('');
  const body =
    `<rect width="${W}" height="${H}" fill="url(#bfelt)"/>` +
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="18" fill="none" stroke="#d6ad4b" stroke-opacity="0.55" stroke-width="1.5"/>` +
    `<text x="56" y="92" font-family="Cinzel" font-weight="700" font-size="16" fill="#d6ad4b" letter-spacing="6">PRIVATE CASINO</text>` +
    `<text x="54" y="150" font-family="Cinzel" font-weight="900" font-size="40" fill="#f2d78a" letter-spacing="2">${esc(name)}</text>` +
    `<rect x="56" y="170" width="120" height="2" fill="#d6ad4b"/>` +
    `<text x="56" y="204" font-family="Manrope" font-weight="700" font-size="17" fill="#cfe3d8">Blackjack · Roulette · Slots · Duels</text>` +
    fan +
    chips;
  return svgDoc(W, H, body, defs);
}

// ───────────────────────────── roulette ─────────────────────────────

const POCKET_FILL = { red: '#b3263a', black: '#16181b', green: '#13784f' } as const;

/** Wheel graphic with the winning pocket under the pointer, plus the big result number. */
export function rouletteSvg(options: { result: number | null; history: number[]; spinNumber: number }): string {
  const W = 900;
  const H = 420;
  const cx = 220;
  const cy = 210;
  const R = 180;
  const pockets = WHEEL_ORDER.length;
  const step = 360 / pockets;
  const index = options.result === null ? 0 : WHEEL_ORDER.indexOf(options.result);
  const rotation = -index * step; // winning pocket at the top
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="url(#rfelt)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${R + 14}" fill="#2a170b" stroke="#c9a54e" stroke-width="3"/>`);
  const wedges: string[] = [];
  WHEEL_ORDER.forEach((num, i) => {
    const a0 = ((i * step - step / 2 - 90) * Math.PI) / 180;
    const a1 = ((i * step + step / 2 - 90) * Math.PI) / 180;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    wedges.push(`<path d="M ${cx} ${cy} L ${n(x0)} ${n(y0)} A ${R} ${R} 0 0 1 ${n(x1)} ${n(y1)} Z" fill="${POCKET_FILL[pocketColor(num)]}" stroke="#c9a54e" stroke-width="0.8"/>`);
    const am = ((i * step - 90) * Math.PI) / 180;
    const tx = cx + (R - 18) * Math.cos(am);
    const ty = cy + (R - 18) * Math.sin(am);
    wedges.push(
      `<text x="${n(tx)}" y="${n(ty + 5)}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="13" fill="#f6f1e3" transform="rotate(${n(i * step)} ${n(tx)} ${n(ty)})">${num}</text>`,
    );
  });
  parts.push(`<g transform="rotate(${n(rotation)} ${cx} ${cy})">${wedges.join('')}</g>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${R - 38}" fill="#3b2212" stroke="#c9a54e" stroke-width="2"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${R - 70}" fill="url(#hub)"/>`);
  for (let i = 0; i < 4; i++) {
    parts.push(`<rect x="${cx - 4}" y="${cy - (R - 42)}" width="8" height="${R - 42}" rx="4" fill="#d6ad4b" transform="rotate(${i * 90 + 45} ${cx} ${cy})"/>`);
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="#f2d78a" stroke="#8a6420" stroke-width="2"/>`);
  // Pointer and ball at the top.
  parts.push(`<path d="M ${cx - 14} ${cy - R - 26} L ${cx + 14} ${cy - R - 26} L ${cx} ${cy - R - 4} Z" fill="#f2d78a" stroke="#8a6420" stroke-width="1.5"/>`);
  if (options.result !== null) parts.push(`<circle cx="${cx}" cy="${cy - R + 40}" r="9" fill="#fdfcf8" stroke="#9aa0a6" stroke-width="1"/>`);

  // Result panel.
  const px = 470;
  if (options.result !== null) {
    const color = pocketColor(options.result);
    parts.push(
      `<text x="${px}" y="92" font-family="Cinzel" font-weight="700" font-size="18" fill="#d6ad4b" letter-spacing="5">SPIN ${options.spinNumber}</text>`,
    );
    parts.push(`<rect x="${px}" y="112" width="150" height="150" rx="22" fill="${POCKET_FILL[color]}" stroke="#d6ad4b" stroke-width="3"/>`);
    parts.push(
      `<text x="${px + 75}" y="${options.result >= 10 ? 218 : 222}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="${options.result >= 10 ? 84 : 96}" fill="#fdfcf8">${options.result}</text>`,
    );
    const facts =
      options.result === 0
        ? ['GREEN', 'ZERO']
        : [color.toUpperCase(), options.result % 2 ? 'ODD' : 'EVEN', options.result <= 18 ? '1 – 18' : '19 – 36'];
    facts.forEach((f, i) => {
      parts.push(`<text x="${px + 176}" y="${150 + i * 40}" font-family="Manrope" font-weight="800" font-size="24" fill="#f6f1e3">${esc(f)}</text>`);
    });
  } else {
    parts.push(`<text x="${px}" y="170" font-family="Cinzel" font-weight="900" font-size="38" fill="#f2d78a" letter-spacing="2">PLACE</text>`);
    parts.push(`<text x="${px}" y="220" font-family="Cinzel" font-weight="900" font-size="38" fill="#f2d78a" letter-spacing="2">YOUR BETS</text>`);
    parts.push(`<text x="${px}" y="258" font-family="Manrope" font-weight="700" font-size="17" fill="#cfe3d8">European wheel · single zero</text>`);
  }
  // History strip.
  const history = options.history.slice(options.result === null ? 0 : 1, 13);
  if (history.length) {
    parts.push(`<text x="${px}" y="318" font-family="Cinzel" font-weight="700" font-size="13" fill="#d6ad4b" letter-spacing="3">PREVIOUS</text>`);
    history.forEach((num, i) => {
      const x = px + i * 33;
      parts.push(`<circle cx="${x + 13}" cy="350" r="14" fill="${POCKET_FILL[pocketColor(num)]}" stroke="#c9a54e" stroke-width="1"/>`);
      parts.push(`<text x="${x + 13}" y="355" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="13" fill="#f6f1e3">${num}</text>`);
    });
  }
  const defs =
    '<radialGradient id="rfelt" cx="25%" cy="50%" r="90%"><stop offset="0" stop-color="#17704f"/><stop offset="1" stop-color="#05261a"/></radialGradient>' +
    '<radialGradient id="hub" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#7a5326"/><stop offset="1" stop-color="#3b2212"/></radialGradient>';
  return svgDoc(W, H, parts.join(''), defs);
}

// ───────────────────────────── slots ─────────────────────────────

function slotSymbol(symbol: SlotSymbol, cx: number, cy: number, size: number): string {
  const s = size / 100;
  const g = (inner: string) => `<g transform="translate(${n(cx - size / 2)} ${n(cy - size / 2)}) scale(${n(s)})">${inner}</g>`;
  switch (symbol) {
    case 'seven':
      return g(
        '<text x="50" y="86" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="96" fill="url(#sevenGrad)" stroke="#7a1420" stroke-width="3">7</text>',
      );
    case 'gem':
      return g(
        '<path d="M20 36 L35 16 L65 16 L80 36 L50 88 Z" fill="#1fa36b" stroke="#0b4f35" stroke-width="3"/>' +
          '<path d="M20 36 L80 36 M35 16 L42 36 L50 88 L58 36 L65 16" fill="none" stroke="#a8f0cf" stroke-width="2" stroke-opacity="0.8"/>',
      );
    case 'bar':
      return g(
        '<rect x="8" y="30" width="84" height="40" rx="6" fill="url(#gold)" stroke="#7a5a1c" stroke-width="3"/>' +
          '<text x="50" y="62" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="28" fill="#3b2a08">BAR</text>',
      );
    case 'bell':
      return g(
        '<path d="M50 12 C30 12 24 30 24 50 C24 62 18 68 12 74 L88 74 C82 68 76 62 76 50 C76 30 70 12 50 12 Z" fill="url(#gold)" stroke="#7a5a1c" stroke-width="3"/>' +
          '<circle cx="50" cy="82" r="8" fill="#b8892b" stroke="#7a5a1c" stroke-width="2"/>',
      );
    case 'clover':
      return g(
        ['M50 48 C36 20 14 34 28 48 C14 62 36 76 50 48', 'M50 48 C64 20 86 34 72 48 C86 62 64 76 50 48', 'M50 48 C22 34 36 12 50 26 C64 12 78 34 50 48', 'M50 48 C22 62 36 84 50 70 C64 84 78 62 50 48']
          .map((d) => `<path d="${d}" fill="#2e9d5b" stroke="#145a32" stroke-width="2"/>`)
          .join('') + '<path d="M50 50 C54 70 60 82 70 92" stroke="#145a32" stroke-width="5" fill="none"/>',
      );
    case 'lemon':
      return g('<ellipse cx="50" cy="52" rx="38" ry="28" fill="#f2cf3a" stroke="#a88a12" stroke-width="3"/><ellipse cx="38" cy="44" rx="10" ry="5" fill="#fff3a8" opacity="0.8"/>');
    case 'cherry':
      return g(
        '<path d="M34 64 C40 40 50 22 70 12 M66 62 C64 40 66 26 70 12" stroke="#2f6b2a" stroke-width="5" fill="none"/>' +
          '<circle cx="32" cy="70" r="18" fill="#c8243a" stroke="#7a1420" stroke-width="3"/><circle cx="66" cy="70" r="18" fill="#c8243a" stroke="#7a1420" stroke-width="3"/>' +
          '<circle cx="26" cy="64" r="5" fill="#f7a0a8"/><circle cx="60" cy="64" r="5" fill="#f7a0a8"/>',
      );
  }
}

export function slotsSvg(options: { rows: SlotSymbol[][] | null; win: boolean; label: string; bet: number; payout: number }): string {
  const W = 720;
  const H = 400;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="url(#sfelt)"/>`);
  parts.push(`<rect x="60" y="40" width="600" height="300" rx="28" fill="#2a170b" stroke="url(#gold)" stroke-width="6"/>`);
  const reelW = 168;
  const reelH = 252;
  for (let r = 0; r < 3; r++) {
    const x = 84 + r * (reelW + 12);
    parts.push(`<rect x="${x}" y="64" width="${reelW}" height="${reelH}" rx="12" fill="url(#reel)" stroke="#8a6420" stroke-width="2"/>`);
    for (let row = 0; row < 3; row++) {
      const symbol = options.rows?.[row]?.[r];
      const cy = 64 + 42 + row * 84;
      if (symbol) {
        const g = slotSymbol(symbol, x + reelW / 2, cy, 70);
        parts.push(row === 1 ? g : `<g opacity="0.4">${g}</g>`);
      } else {
        parts.push(suitShape((['S', 'H', 'D'] as const)[r]!, x + reelW / 2, cy, 40, '#c9a54e'));
      }
    }
  }
  // Payline.
  const lineColor = options.win ? '#f2d78a' : 'rgba(242,215,138,0.55)';
  parts.push(`<rect x="72" y="${64 + 84 + 2}" width="576" height="80" rx="10" fill="none" stroke="${lineColor}" stroke-width="${options.win ? 4 : 2}"/>`);
  parts.push(`<path d="M 48 190 L 64 180 L 64 200 Z" fill="${lineColor}"/><path d="M 672 190 L 656 180 L 656 200 Z" fill="${lineColor}"/>`);
  // Caption.
  const caption = options.rows ? (options.win ? `${options.label.toUpperCase()} · WIN ${options.payout.toLocaleString('en-US')}` : 'NO WIN · SPIN AGAIN') : 'EMERALD SLOTS';
  parts.push(
    `<text x="${W / 2}" y="378" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="24" fill="${options.win ? '#f2d78a' : '#cfe3d8'}" letter-spacing="3">${esc(caption)}</text>`,
  );
  const defs =
    cardDefs() +
    '<radialGradient id="sfelt" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#17704f"/><stop offset="1" stop-color="#05261a"/></radialGradient>' +
    '<linearGradient id="reel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9d3c2"/><stop offset="0.2" stop-color="#fbf8f0"/><stop offset="0.8" stop-color="#fbf8f0"/><stop offset="1" stop-color="#d9d3c2"/></linearGradient>' +
    '<linearGradient id="sevenGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5c6c"/><stop offset="1" stop-color="#b3172b"/></linearGradient>';
  return svgDoc(W, H, parts.join(''), defs);
}

// ───────────────────────────── coin ─────────────────────────────

export function coinSvg(side: 'heads' | 'tails' | null): string {
  const W = 520;
  const H = 300;
  const cx = 260;
  const cy = 150;
  const face =
    side === 'heads'
      ? '<path d="M-44 18 L-54 -30 L-22 -8 L0 -44 L22 -8 L54 -30 L44 18 Z" fill="#8a6420"/><text x="0" y="62" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="26" fill="#6b4a14">HEADS</text>'
      : side === 'tails'
        ? `${suitShape('S', 0, -8, 76, '#8a6420')}<text x="0" y="62" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="26" fill="#6b4a14">TAILS</text>`
        : '<text x="0" y="18" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="48" fill="#6b4a14">?</text>';
  const body =
    `<rect width="${W}" height="${H}" fill="url(#cfelt)"/>` +
    `<ellipse cx="${cx}" cy="${cy + 112}" rx="90" ry="12" fill="#000" opacity="0.35"/>` +
    `<circle cx="${cx}" cy="${cy}" r="112" fill="url(#gold)" stroke="#7a5a1c" stroke-width="4"/>` +
    `<circle cx="${cx}" cy="${cy}" r="96" fill="none" stroke="#7a5a1c" stroke-width="2" stroke-dasharray="4 5"/>` +
    `<g transform="translate(${cx} ${cy})">${face}</g>`;
  const defs =
    cardDefs() +
    '<radialGradient id="cfelt" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#17704f"/><stop offset="1" stop-color="#05261a"/></radialGradient>';
  return svgDoc(W, H, body, defs);
}

// ───────────────────────────── cosmetics preview ─────────────────────────────

export function stylePreviewSvg(feltId: string, cardBackId: string): string {
  const W = 640;
  const H = 240;
  const felt = FELTS[feltId] ?? FELTS.emerald!;
  const backId = CARD_BACKS[cardBackId] ? cardBackId : 'emerald';
  const body =
    `<rect width="${W}" height="${H}" fill="url(#pfelt)"/>` +
    `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="18" fill="none" stroke="${felt.line}" stroke-opacity="0.6" stroke-width="1.5"/>` +
    cardBack(150, 46, 106, backId) +
    cardBack(190, 52, 106, backId) +
    cardFace('AS', 360, 46, 106) +
    cardFace('KH', 410, 52, 106);
  const defs =
    cardDefs() +
    `<radialGradient id="pfelt" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="${felt.inner}"/><stop offset="1" stop-color="${felt.outer}"/></radialGradient>`;
  return svgDoc(W, H, body, defs);
}
