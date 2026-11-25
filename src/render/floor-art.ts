import { createHash } from 'node:crypto';
import { cardBack, cardDefs, cardFace } from './cards.js';
import { svgToPng } from './png.js';
import { esc, n, svgDoc } from './svg.js';

/**
 * The Emerald Room's illustrated "gaming floor": one tile per game (plus Events) in a 3×2 grid
 * that mirrors the two rows of game buttons under it, so the picture and the controls line up on
 * every client width. All artwork is original vector art drawn here.
 */

export type FloorTile = 'blackjack' | 'poker' | 'roulette' | 'slots' | 'coinflip' | 'events';

export const FLOOR_ORDER: readonly FloorTile[] = ['blackjack', 'poker', 'roulette', 'slots', 'coinflip', 'events'];

const GOLD = '#d9b36a';
const GOLD_DEEP = '#a87b33';
const CREAM = '#f4e8cf';
const INK = '#0b0f0d';

const TILE_W = 300;
const TILE_H = 250;
const GAP = 15;
export const FLOOR_W = GAP + 3 * (TILE_W + GAP);
export const FLOOR_H = GAP + 2 * (TILE_H + GAP);

const TILES: Record<FloorTile, { name: string; tag: string; top: string; bottom: string }> = {
  blackjack: { name: 'Blackjack', tag: 'PLAY THE DEALER', top: '#1d6446', bottom: '#0a2a1e' },
  poker: { name: 'Hold’em', tag: 'NO-LIMIT POKER', top: '#18525a', bottom: '#082226' },
  roulette: { name: 'Roulette', tag: 'EUROPEAN WHEEL', top: '#5e2230', bottom: '#22090f' },
  slots: { name: 'Emerald Slots', tag: 'YOUR OWN MACHINE', top: '#43305f', bottom: '#150e22' },
  coinflip: { name: 'Coinflip', tag: 'HEADS OR TAILS', top: '#5c4720', bottom: '#201707' },
  events: { name: 'Events', tag: 'GAME NIGHTS', top: '#2f333a', bottom: '#111316' },
};

// ───────────────────────────── shared pieces ─────────────────────────────

function chip(x: number, y: number, r: number, body: string, edge = CREAM): string {
  const notches = Array.from({ length: 8 }, (_, i) => `<rect x="${n(-r * 0.16)}" y="${n(-r)}" width="${n(r * 0.32)}" height="${n(r * 0.28)}" fill="${edge}" transform="rotate(${i * 45})"/>`).join('');
  return `<g transform="translate(${n(x)} ${n(y)})"><circle r="${n(r)}" fill="${body}"/>${notches}<circle r="${n(r * 0.62)}" fill="none" stroke="${edge}" stroke-width="${n(r * 0.08)}" stroke-dasharray="${n(r * 0.18)} ${n(r * 0.12)}"/><circle r="${n(r * 0.44)}" fill="${body}" stroke="${GOLD}" stroke-width="1.2"/></g>`;
}

/** A short stack of chips seen at a slight angle. */
function stack(x: number, y: number, count: number, body: string): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const cy = y - i * 7;
    out += `<ellipse cx="${n(x)}" cy="${n(cy + 3)}" rx="22" ry="8" fill="#0006"/>`;
    out += `<ellipse cx="${n(x)}" cy="${n(cy)}" rx="22" ry="8" fill="${body}" stroke="${CREAM}" stroke-width="1.4" stroke-dasharray="5 4"/>`;
  }
  return out;
}

function sparkle(x: number, y: number, s: number): string {
  return `<path d="M${n(x)} ${n(y - s)} L${n(x + s * 0.25)} ${n(y - s * 0.25)} L${n(x + s)} ${n(y)} L${n(x + s * 0.25)} ${n(y + s * 0.25)} L${n(x)} ${n(y + s)} L${n(x - s * 0.25)} ${n(y + s * 0.25)} L${n(x - s)} ${n(y)} L${n(x - s * 0.25)} ${n(y - s * 0.25)} Z" fill="${GOLD}"/>`;
}

// ───────────────────────────── illustrations (drawn in a 300×180 box) ─────────────────────────────

function blackjackArt(): string {
  return `<ellipse cx="150" cy="150" rx="130" ry="26" fill="#0005"/>`
    + `<g transform="rotate(-9 118 96)">${cardFace('AS', 82, 30, 74)}</g>`
    + `<g transform="rotate(8 176 96)">${cardFace('KH', 136, 26, 74)}</g>`
    + stack(238, 146, 4, '#a8262f') + stack(62, 150, 3, '#1f5f45');
}

function pokerArt(): string {
  const cards = ['QH', 'JD', 'TS'].map((c, i) => cardFace(c as never, 30 + i * 50, 48, 44)).join('')
    + [0, 1].map((i) => cardBack(180 + i * 50, 48, 44, 'emerald')).join('');
  return `<ellipse cx="150" cy="150" rx="132" ry="24" fill="#0005"/>` + cards
    + stack(64, 150, 3, '#1f3f8f') + stack(104, 152, 2, '#a8262f')
    + `<g transform="translate(232 146)"><circle r="17" fill="${CREAM}" stroke="${GOLD_DEEP}" stroke-width="3"/><text y="7" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="20" fill="#1a1a1a">D</text></g>`;
}

function rouletteArt(): string {
  const cx = 150;
  const cy = 92;
  const sectors: string[] = [];
  const pocket = (r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  for (let i = 0; i < 37; i++) {
    const a0 = (i / 37) * Math.PI * 2;
    const a1 = ((i + 1) / 37) * Math.PI * 2;
    const [x0, y0] = pocket(66, a0);
    const [x1, y1] = pocket(66, a1);
    const [x2, y2] = pocket(46, a1);
    const [x3, y3] = pocket(46, a0);
    const fill = i === 0 ? '#1f7a4a' : i % 2 ? '#a51f2c' : '#141414';
    sectors.push(`<path d="M${n(x0!)} ${n(y0!)} A66 66 0 0 1 ${n(x1!)} ${n(y1!)} L${n(x2!)} ${n(y2!)} A46 46 0 0 0 ${n(x3!)} ${n(y3!)} Z" fill="${fill}" stroke="${GOLD}" stroke-width=".8"/>`);
  }
  const [bx, by] = pocket(56, 0.95);
  return `<ellipse cx="150" cy="166" rx="96" ry="14" fill="#0006"/>`
    + `<circle cx="${cx}" cy="${cy}" r="80" fill="url(#rouletteWood)" stroke="${GOLD}" stroke-width="2.5"/>`
    + `<circle cx="${cx}" cy="${cy}" r="68" fill="#140b07"/>` + sectors.join('')
    + `<circle cx="${cx}" cy="${cy}" r="44" fill="url(#rouletteCone)" stroke="${GOLD}" stroke-width="1.5"/>`
    + `<path d="M${cx - 26} ${cy}h52M${cx} ${cy - 26}v52" stroke="${GOLD}" stroke-width="5" stroke-linecap="round"/>`
    + `<circle cx="${cx}" cy="${cy}" r="9" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="2"/>`
    + `<circle cx="${n(bx!)}" cy="${n(by!)}" r="5.5" fill="#fbfbf7" stroke="#9a9a9a" stroke-width=".8"/>`;
}

function seven(x: number, y: number): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="46" fill="url(#sevenRed)" stroke="#5a0e18" stroke-width="1.2">7</text>`;
}

function slotsArt(): string {
  return `<ellipse cx="150" cy="168" rx="108" ry="12" fill="#0006"/>`
    + `<rect x="58" y="16" width="176" height="150" rx="20" fill="#24183a" stroke="${GOLD}" stroke-width="3"/>`
    + `<rect x="70" y="26" width="152" height="24" rx="8" fill="#140d22" stroke="${GOLD_DEEP}"/>`
    + `<text x="146" y="44" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="15" fill="${GOLD}" letter-spacing="3">JACKPOT</text>`
    + `<rect x="74" y="60" width="144" height="78" rx="9" fill="${CREAM}" stroke="${GOLD_DEEP}" stroke-width="2"/>`
    + `<path d="M122 60v78M170 60v78" stroke="#c9b48a" stroke-width="2"/>`
    + seven(98, 116) + seven(146, 116) + seven(194, 116)
    + `<path d="M68 99h156" stroke="${GOLD}" stroke-width="2.5" opacity=".85"/>`
    + `<rect x="92" y="146" width="108" height="10" rx="5" fill="#140d22" stroke="${GOLD_DEEP}"/>`
    + `<path d="M236 92 L258 50" stroke="#c9c9c9" stroke-width="6" stroke-linecap="round"/>`
    + `<circle cx="259" cy="46" r="11" fill="#c0283a" stroke="#6a0e19" stroke-width="2"/>`
    + `<circle cx="236" cy="96" r="8" fill="${GOLD_DEEP}"/>`;
}

function coinArt(): string {
  const gem = `<path d="M0 -22 L19 -11 L19 11 L0 22 L-19 11 L-19 -11 Z" fill="#2f9a68" stroke="${GOLD}" stroke-width="2"/>`
    + `<path d="M0 -22 L0 22 M-19 -11 L19 11 M19 -11 L-19 11" stroke="${GOLD}" stroke-width="1" opacity=".55"/>`;
  return `<ellipse cx="140" cy="166" rx="84" ry="12" fill="#0006"/>`
    + `<g transform="translate(128 94)"><circle r="64" fill="url(#coinGold)" stroke="${GOLD_DEEP}" stroke-width="3"/>`
    + `<circle r="53" fill="none" stroke="#fff3" stroke-width="2" stroke-dasharray="3 5"/>`
    + `<circle r="46" fill="url(#coinGreen)" stroke="${GOLD}" stroke-width="2.5"/>${gem}</g>`
    + `<g transform="translate(236 62) rotate(18)"><ellipse rx="11" ry="34" fill="url(#coinGold)" stroke="${GOLD_DEEP}" stroke-width="2"/><ellipse rx="4" ry="30" fill="#2f9a68" opacity=".8"/></g>`
    + `<path d="M210 112 q16 -30 4 -70" fill="none" stroke="${GOLD}" stroke-width="2" stroke-dasharray="3 6" opacity=".7"/>`
    + sparkle(262, 112, 8) + sparkle(204, 30, 6);
}

function eventsArt(): string {
  return `<ellipse cx="150" cy="166" rx="104" ry="12" fill="#0006"/>`
    + `<g transform="rotate(-6 150 96)">`
    + `<path d="M54 46 h192 a10 10 0 0 1 10 10 v20 a14 14 0 0 0 0 28 v20 a10 10 0 0 1 -10 10 h-192 a10 10 0 0 1 -10 -10 v-20 a14 14 0 0 0 0 -28 v-20 a10 10 0 0 1 10 -10z" fill="${CREAM}" stroke="${GOLD_DEEP}" stroke-width="2.5"/>`
    + `<path d="M206 50v82" stroke="${GOLD_DEEP}" stroke-width="2" stroke-dasharray="5 5"/>`
    + `<text x="126" y="84" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="25" fill="#1d3b2e">GAME</text>`
    + `<text x="126" y="113" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="25" fill="#1d3b2e">NIGHT</text>`
    + `<text transform="translate(229 91) rotate(90)" y="6" text-anchor="middle" font-family="Cinzel" font-weight="900" font-size="16" letter-spacing="2" fill="#8d2533">ADMIT</text>`
    + `</g>` + sparkle(52, 36, 9) + sparkle(258, 150, 7) + sparkle(250, 28, 5);
}

const ART: Record<FloorTile, () => string> = {
  blackjack: blackjackArt,
  poker: pokerArt,
  roulette: rouletteArt,
  slots: slotsArt,
  coinflip: coinArt,
  events: eventsArt,
};

const DEFS = cardDefs()
  + `<radialGradient id="floorGlow" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#123a2b"/><stop offset="1" stop-color="${INK}"/></radialGradient>`
  + `<radialGradient id="rouletteWood" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#7a4522"/><stop offset="1" stop-color="#3b1d0c"/></radialGradient>`
  + `<radialGradient id="rouletteCone" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#8a5a2b"/><stop offset="1" stop-color="#3a220f"/></radialGradient>`
  + `<linearGradient id="sevenRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5f6d"/><stop offset="1" stop-color="#a3172a"/></linearGradient>`
  + `<linearGradient id="coinGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d88d"/><stop offset=".55" stop-color="#c89a45"/><stop offset="1" stop-color="#8a6224"/></linearGradient>`
  + `<radialGradient id="coinGreen" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#22805a"/><stop offset="1" stop-color="#0b3424"/></radialGradient>`
  + (Object.entries(TILES) as [FloorTile, (typeof TILES)[FloorTile]][])
    .map(([id, t]) => `<linearGradient id="tile-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.top}"/><stop offset="1" stop-color="${t.bottom}"/></linearGradient>`)
    .join('');

function tile(id: FloorTile, x: number, y: number, open: boolean): string {
  const t = TILES[id];
  const closed = open ? ''
    : `<rect width="${TILE_W}" height="${TILE_H}" rx="18" fill="#000a"/>`
      + `<rect x="95" y="84" width="110" height="34" rx="17" fill="#141414" stroke="${GOLD}" stroke-width="1.5"/>`
      + `<text x="150" y="107" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="16" letter-spacing="3" fill="${GOLD}">CLOSED</text>`;
  return `<g transform="translate(${x} ${y})">`
    + `<rect width="${TILE_W}" height="${TILE_H}" rx="18" fill="url(#tile-${id})"/>`
    + `<path d="M0 ${TILE_H * 0.62} L${TILE_W} ${TILE_H * 0.2} V0 H0 Z" fill="#ffffff" opacity=".035"/>`
    + `<g transform="translate(0 4)">${ART[id]()}</g>`
    + `<rect x="0" y="176" width="${TILE_W}" height="${TILE_H - 176}" fill="#0000004d"/>`
    + `<path d="M110 186h80" stroke="${GOLD}" stroke-width="1.2" opacity=".7"/>`
    + `<text x="150" y="216" text-anchor="middle" font-family="Cinzel" font-weight="800" font-size="${t.name.length > 10 ? 29 : 32}" fill="${CREAM}">${esc(t.name)}</text>`
    + `<text x="150" y="238" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="13" letter-spacing="3" fill="${GOLD}">${esc(t.tag)}</text>`
    + `<rect x="5" y="5" width="${TILE_W - 10}" height="${TILE_H - 10}" rx="14" fill="none" stroke="${GOLD}" stroke-opacity=".55" stroke-width="1.5"/>`
    + closed
    + `</g>`;
}

export function floorSvg(open: Record<FloorTile, boolean>): string {
  const body = FLOOR_ORDER.map((id, i) => tile(id, GAP + (i % 3) * (TILE_W + GAP), GAP + Math.floor(i / 3) * (TILE_H + GAP), open[id])).join('');
  return svgDoc(FLOOR_W, FLOOR_H, `<rect width="${FLOOR_W}" height="${FLOOR_H}" rx="16" fill="url(#floorGlow)"/>` + body, DEFS);
}

/**
 * The Games screen's banner: one wide, decorative scene (no tiles, frames or game names, so it never
 * reads as a menu), with the title on the left and the floor's objects drifting along a felt rail.
 * 960×260: about half the height of the old 3×2 tile grid. The controls are the buttons below it.
 */
export function floorBannerSvg(): string {
  const W = 960;
  const H = 260;
  const pieces: Array<[FloorTile, number, number, number]> = [
    ['roulette', 520, 4, 0.78],
    ['poker', 738, 126, 0.44],
    ['blackjack', 640, 82, 0.6],
    ['slots', 790, 6, 0.58],
    ['coinflip', 842, 148, 0.42],
  ];
  return svgDoc(W, H,
    `<rect width="${W}" height="${H}" rx="16" fill="url(#floorGlow)"/>`
      // A curved felt rail sweeping under the objects, with a gold edge: atmosphere, not a frame.
      + `<path d="M420 ${H} C 560 ${H * 0.6}, 760 ${H * 0.5}, ${W} ${H * 0.55} V${H} Z" fill="#0f3a2a" opacity=".9"/>`
      + `<path d="M420 ${H} C 560 ${H * 0.6}, 760 ${H * 0.5}, ${W} ${H * 0.55}" fill="none" stroke="${GOLD}" stroke-opacity=".45" stroke-width="2"/>`
      + `<ellipse cx="740" cy="${H * 0.42}" rx="290" ry="${H * 0.62}" fill="#1d6b4c" opacity=".16"/>`
      + pieces.map(([id, x, y, sc]) => `<g transform="translate(${x} ${y}) scale(${sc})">${ART[id]()}</g>`).join('')
      + `<text x="46" y="84" font-family="Manrope" font-weight="800" font-size="15" letter-spacing="6" fill="${GOLD}">THE EMERALD ROOM</text>`
      + `<text x="44" y="138" font-family="Cinzel" font-weight="900" font-size="44" fill="${CREAM}">The Gaming Floor</text>`
      + `<path d="M46 160h260" stroke="${GOLD}" stroke-width="1.5" opacity=".7"/>`
      + `<text x="46" y="194" font-family="Manrope" font-weight="700" font-size="18" fill="#cfe3d8">Pull up a chair. The cards are warm.</text>`
      + `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="11" fill="none" stroke="${GOLD}" stroke-opacity=".35" stroke-width="1.2"/>`,
    DEFS);
}

export function floorBanner(): Promise<ArtFile | undefined> {
  return cached('banner', async () => ({
    name: 'emerald-gaming-floor.png',
    data: await svgToPng(floorBannerSvg(), 960),
    description: 'The Emerald Room gaming floor: a roulette wheel, playing cards, chips, a slot machine and a gold coin.',
  }));
}

/**
 * The public lobby's sign: the casino's name in gold over deep emerald, with the games laid out
 * along the right like a lit gaming floor seen through the door.
 */
export function lobbySignSvg(name: string): string {
  const W = 960;
  const H = 300;
  const pieces: Array<[FloorTile, number, number, number]> = [
    ['roulette', 585, 34, 0.8],
    ['blackjack', 694, 110, 0.64],
    ['slots', 792, 30, 0.58],
    ['coinflip', 806, 156, 0.5],
  ];
  const title = name.length > 22 ? 36 : name.length > 16 ? 44 : 50;
  return svgDoc(W, H,
    `<rect width="${W}" height="${H}" rx="18" fill="url(#floorGlow)"/>`
      + `<path d="M470 0 H${W} V${H} H400 Z" fill="#0f3a2a" opacity=".75"/>`
      + `<path d="M470 0 L400 ${H}" stroke="${GOLD}" stroke-opacity=".35" stroke-width="2"/>`
      + pieces.map(([id, x, y, s]) => `<g transform="translate(${x} ${y}) scale(${s})">${ART[id]()}</g>`).join('')
      + `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="12" fill="none" stroke="${GOLD}" stroke-opacity=".5" stroke-width="1.5"/>`
      + `<text x="48" y="92" font-family="Manrope" font-weight="800" font-size="17" letter-spacing="6" fill="${GOLD}">A PRIVATE CASINO</text>`
      + `<text x="46" y="${92 + title + 18}" font-family="Cinzel" font-weight="900" font-size="${title}" fill="${CREAM}">${esc(name)}</text>`
      + `<path d="M48 ${92 + title + 40}h300" stroke="${GOLD}" stroke-width="1.5" opacity=".7"/>`
      + `<text x="48" y="${92 + title + 74}" font-family="Manrope" font-weight="700" font-size="19" fill="#cfe3d8">Blackjack · Hold’em · Roulette · Slots · Coinflip</text>`,
    DEFS);
}

export function lobbySign(name: string): Promise<ArtFile | undefined> {
  return cached(`lobby-${name}`, async () => ({ name: `emerald-lobby-${createHash('sha1').update(name).digest('hex').slice(0, 10)}.png`, data: await svgToPng(lobbySignSvg(name), 960), description: `${name}: a private casino with Blackjack, Hold’em, Roulette, Slots and Coinflip.` }));
}

/** One game's illustration on its own, square, for thumbnails (table lobbies, events). */
export function gameBadgeSvg(id: FloorTile): string {
  return svgDoc(240, 240,
    `<rect width="240" height="240" rx="26" fill="url(#tile-${id})"/>`
      + `<g transform="translate(-30 34)">${ART[id]()}</g>`
      + `<rect x="6" y="6" width="228" height="228" rx="21" fill="none" stroke="${GOLD}" stroke-opacity=".6" stroke-width="2"/>`,
    DEFS);
}

/** A small stack-of-chips emblem for the wallet. */
export function walletBadgeSvg(): string {
  return svgDoc(240, 240,
    `<rect width="240" height="240" rx="26" fill="url(#tile-coinflip)"/>`
      + `<ellipse cx="120" cy="196" rx="90" ry="16" fill="#0006"/>`
      + stack(88, 180, 6, '#1f5f45') + stack(152, 186, 4, '#a8262f') + stack(122, 150, 3, '#1f3f8f')
      + chip(176, 70, 30, '#1f5f45') + sparkle(64, 58, 9)
      + `<rect x="6" y="6" width="228" height="228" rx="21" fill="none" stroke="${GOLD}" stroke-opacity=".6" stroke-width="2"/>`,
    DEFS);
}

// ───────────────────────────── rendered + cached ─────────────────────────────

export interface ArtFile {
  name: string;
  data: Buffer;
  description: string;
}

const cache = new Map<string, Promise<ArtFile | undefined>>();

function cached(key: string, render: () => Promise<ArtFile>): Promise<ArtFile | undefined> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = render().catch(() => {
    cache.delete(key);
    return undefined;
  });
  cache.set(key, pending);
  return pending;
}

/** The gaming floor for a given set of open games (cached per combination). */
export function floorArt(open: Record<FloorTile, boolean>): Promise<ArtFile | undefined> {
  const key = FLOOR_ORDER.map((id) => (open[id] ? '1' : '0')).join('');
  return cached(`floor-${key}`, async () => ({
    name: `emerald-floor-${key}.png`,
    data: await svgToPng(floorSvg(open), FLOOR_W),
    description: `The Emerald Room gaming floor: ${FLOOR_ORDER.map((id) => `${TILES[id].name}${open[id] ? '' : ' (closed)'}`).join(', ')}.`,
  }));
}

export function gameBadge(id: FloorTile): Promise<ArtFile | undefined> {
  return cached(`badge-${id}`, async () => ({ name: `emerald-${id}-badge.png`, data: await svgToPng(gameBadgeSvg(id), 240), description: `${TILES[id].name} illustration` }));
}

export function walletBadge(): Promise<ArtFile | undefined> {
  return cached('wallet', async () => ({ name: 'emerald-wallet-badge.png', data: await svgToPng(walletBadgeSvg(), 240), description: 'Stacks of Emerald Room chips' }));
}

export async function warmFloorArt(): Promise<void> {
  const all = Object.fromEntries(FLOOR_ORDER.map((id) => [id, true])) as Record<FloorTile, boolean>;
  await Promise.all([floorArt(all), walletBadge(), ...FLOOR_ORDER.map(gameBadge)]);
}
