import { cardBack, cardDefs, cardFace } from './cards.js';
import { svgToPng } from './png.js';
import { esc, svgDoc } from './svg.js';

const GOLD = '#dba968';
const INK = '#0f1d19';
const CREAM = '#f6e7c9';
const EMERALD = '#216448';
const LINE = '#62513b';

function token(x: number, y: number, r: number, fill = INK): string {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${GOLD}" stroke-width="2.5"/>`
    + `<circle cx="${x}" cy="${y}" r="${r - 7}" fill="none" stroke="${GOLD}" stroke-width="4" stroke-dasharray="4 11"/>`
    + `<circle cx="${x}" cy="${y}" r="${r - 13}" fill="none" stroke="${GOLD}" stroke-width="1"/>`
    + `<path d="M${x},${y - 11} l11,11 -11,11 -11,-11z" fill="${GOLD}"/>`;
}

function ribbon(kicker: string, title: string, wallet: boolean): string {
  const icon = wallet
    ? token(760, 124, 41, '#273e30') + token(810, 109, 37, '#4d312b') + token(794, 76, 40, EMERALD)
    : `<path d="M797 27l43 24 8 44-51 37-51-37 8-44z" fill="${EMERALD}" stroke="${GOLD}" stroke-width="2"/>`
      + `<path d="M797 27l-20 27-8 43 28 35 28-35-8-43zM754 51l23 3h40l23-3M746 95l23 2h56l23-2" fill="none" stroke="${GOLD}" opacity=".55"/>`;
  return svgDoc(900, 160,
    `<rect width="900" height="160" rx="12" fill="${INK}"/>`
      + `<path d="M665 0v160h235V0z" fill="#172b23"/><path d="M676 0h200l-40 160H630z" fill="#1c392b"/>`
      + `<path d="M30 24h840v112H30z" fill="none" stroke="${LINE}"/><path d="M46 126h391" stroke="${GOLD}" opacity=".4"/>`
      + `<text x="48" y="62" fill="${GOLD}" font-family="Manrope" font-size="18" font-weight="800" letter-spacing="4">${esc(kicker)}</text>`
      + `<text x="46" y="111" fill="${CREAM}" font-family="Cinzel" font-size="48" font-weight="800">${esc(title)}</text>`
      + icon);
}

function wheelBadge(): string {
  const spokes = Array.from({ length: 12 }, (_, i) =>
    `<path d="M0 -54v13" transform="rotate(${i * 30})" stroke="#e1b67a" stroke-width="3"/>`).join('');
  return `<g transform="translate(108 77)"><circle r="59" fill="#55292b" stroke="${GOLD}" stroke-width="3"/>`
    + `<circle r="43" fill="#172b23" stroke="${GOLD}"/><circle r="34" fill="none" stroke="${LINE}"/>`
    + spokes + `<path d="M-22 0h44M0 -22v44" stroke="${GOLD}" stroke-width="3"/><circle r="6" fill="${GOLD}"/><circle cx="22" cy="-28" r="5" fill="${CREAM}"/></g>`;
}

function gameIllustration(holdem = false): string {
  const slots = `<rect x="47" y="33" width="124" height="91" rx="19" fill="#28202e" stroke="${GOLD}" stroke-width="3"/>`
    + [62, 96, 130].map((x) => `<rect x="${x}" y="52" width="26" height="48" rx="5" fill="${CREAM}"/><text x="${x + 13}" y="87" fill="#8d3248" text-anchor="middle" font-family="Cinzel" font-size="30" font-weight="900">7</text>`).join('');
  const plaques = [
    { label: 'Blackjack', field: '#153c2e', art: cardBack(61, 27, 57) + cardFace('AS', 106, 36, 62) },
    ...(holdem ? [{ label: 'Hold’em', field: '#203b38', art: cardFace('KH', 68, 35, 65) + cardFace('KS', 112, 35, 65) }] : []),
    { label: 'Roulette', field: '#45292c', art: wheelBadge() },
    { label: 'Slots', field: '#32283e', art: slots },
    { label: 'Coinflip', field: '#3b3523', art: token(97, 77, 47, '#6a5030') + token(134, 85, 38, '#2b4033') },
  ];
  const width = plaques.length * 222 + 12;
  return svgDoc(width, 210, `<rect width="${width}" height="210" rx="13" fill="${INK}"/>`
    + plaques.map(({label, field, art}, i) =>
      `<g transform="translate(${12 + i * 222} 12)"><rect width="210" height="186" rx="11" fill="${field}" stroke="${LINE}"/><path d="M13 141h184" stroke="${GOLD}" opacity=".65"/>`
      + art + `<text x="105" y="171" fill="${CREAM}" text-anchor="middle" font-family="Manrope" font-size="26" font-weight="800">${label}</text></g>`).join(''), cardDefs());
}

const artwork = {
  home: { svg: () => ribbon('THE CASINO', 'The Emerald Room', false), alt: 'The Emerald Room wordmark with a faceted emerald.' },
  wallet: { svg: () => ribbon('THE EMERALD ROOM', 'Chip Wallet', true), alt: 'Chip Wallet wordmark with three illustrated casino chips.' },
  'games-holdem': { svg: () => gameIllustration(true), alt: 'Illustrated Blackjack cards, Hold’em hole cards, a roulette wheel, slots and coinflip tokens.' },
  games: { svg: () => gameIllustration(), alt: 'Blackjack cards, a roulette wheel, slots reels and two coinflip tokens.' },
};

type Art = keyof typeof artwork;
type RenderedArt = { name: string; data: Buffer; description: string };
const cache = new Map<Art, Promise<RenderedArt | undefined>>();

export function casinoArtwork(kind: Art): Promise<RenderedArt | undefined> {
  const current = cache.get(kind);
  if (current) return current;
  const { svg, alt } = artwork[kind];
  const rendered = svgToPng(svg(), 750)
    .then((data) => ({ name: `emerald-${kind}.png`, data, description: alt }))
    .catch(() => {
      cache.delete(kind);
      return undefined;
    });
  cache.set(kind, rendered);
  return rendered;
}

export async function warmCasinoArtwork(): Promise<void> {
  await Promise.all((Object.keys(artwork) as Art[]).map(casinoArtwork));
}
