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

const games = {
  blackjack: { field: '#143d30', light: '#235841', draw: () => cardBack(58, 25, 61) + cardFace('AS', 106, 40, 63) },
  poker: { field: '#163437', light: '#24585b', draw: () => cardFace('KH', 54, 38, 67) + cardFace('KS', 104, 26, 67) },
  roulette: { field: '#41222b', light: '#693740', draw: wheelBadge },
  slots: { field: '#2d2341', light: '#48345e', draw: () =>
    '<rect x="39" y="30" width="138" height="96" rx="19" fill="#231b30" stroke="' + GOLD + '" stroke-width="3"/>'
    + [52, 94, 136].map((x) => '<rect x="' + x + '" y="52" width="28" height="48" rx="5" fill="' + CREAM
      + '"/><text x="' + (x + 14) + '" y="87" fill="#8d3248" text-anchor="middle" font-family="Cinzel" font-size="31" font-weight="900">7</text>').join('') },
  coinflip: { field: '#382e1b', light: '#63502d', draw: () => token(87, 69, 45, '#755631') + token(130, 92, 38, '#254234') },
};

function gameMedallion(game: keyof typeof games): string {
  const { field, light, draw } = games[game];
  return svgDoc(192, 192,
    '<rect width="192" height="192" rx="21" fill="' + field + '"/>'
    + '<path d="M0 150 140 0h52v34L40 192H0Z" fill="' + light + '"/>'
    + '<rect x="8" y="8" width="176" height="176" rx="15" fill="none" stroke="' + GOLD + '" stroke-opacity=".65" stroke-width="2"/>'
    + '<path d="M27 33h16M35 25v16m114 120h16m-8-8v16" stroke="' + GOLD + '" stroke-width="2"/>'
    + '<g transform="translate(-7 22) scale(.95)">' + draw() + '</g>',
    cardDefs());
}

const artwork = {
  home: { svg: () => ribbon('THE CASINO', 'The Emerald Room', false), alt: 'The Emerald Room wordmark with a faceted emerald.' },
  wallet: { svg: () => ribbon('THE EMERALD ROOM', 'Chip Wallet', true), alt: 'Chip Wallet wordmark with three illustrated casino chips.' },
  blackjack: { svg: () => gameMedallion('blackjack'), alt: 'An ace of spades beside an Emerald Room card back.' },
  poker: { svg: () => gameMedallion('poker'), alt: 'Two kings on teal felt.' },
  roulette: { svg: () => gameMedallion('roulette'), alt: 'A brass and burgundy roulette wheel.' },
  slots: { svg: () => gameMedallion('slots'), alt: 'Three sevens in a framed slot machine.' },
  coinflip: { svg: () => gameMedallion('coinflip'), alt: 'Two gold-edged casino tokens.' },
};

type Art = keyof typeof artwork;
type RenderedArt = { name: string; data: Buffer; description: string };
const cache = new Map<Art, Promise<RenderedArt | undefined>>();

export function casinoArtwork(kind: Art): Promise<RenderedArt | undefined> {
  const current = cache.get(kind);
  if (current) return current;
  const { svg, alt } = artwork[kind];
  const rendered = svgToPng(svg(), kind === 'home' || kind === 'wallet' ? 750 : 192)
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
