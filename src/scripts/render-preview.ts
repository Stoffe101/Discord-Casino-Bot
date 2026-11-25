/**
 * Renders sample artwork without Discord, for design review and the README.
 *   npm run render-preview            → ./render-preview/*.png
 *   npm run render-preview -- --docs  → ./docs/images/*.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../db/database.js';
import { ManualClock } from '../core/clock.js';
import { ManualScheduler } from '../core/scheduler.js';
import { Logger } from '../core/logger.js';
import { seededRng } from '../core/random.js';
import { CasinoApp } from '../app/casino-app.js';
import { ALL_IN_DEAL_DELAY_MS, rulesFromSettings } from '../tables/blackjack-table-service.js';
import { buildTableView } from '../tables/table-view.js';
import { renderTableSvg } from '../render/table-image.js';
import { bannerSvg, coinSvg, rouletteSvg, slotsSvg, stylePreviewSvg } from '../render/game-images.js';
import { svgToPng } from '../render/png.js';
import { currentTurnUserId } from '../games/blackjack/engine.js';
import { spinFromStops } from '../games/slots/engine.js';
import { dealPoker, playPoker, publicPokerHand } from '../games/poker/engine.js';
import { pokerTableSvg } from '../render/poker-image.js';
import { framesToGif } from '../render/gif.js';
import type { Card } from '../games/cards.js';

async function main(): Promise<void> {
  const out = process.argv.includes('--docs') ? join('docs', 'images') : 'render-preview';
  mkdirSync(out, { recursive: true });
  const save = async (name: string, svg: string, width: number) => {
    const png = await svgToPng(svg, width);
    writeFileSync(join(out, `${name}.png`), png);
    console.log(`${join(out, `${name}.png`)}  ${Math.round(png.length / 1024)} KB`);
  };

  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(Date.now());
  const scheduler = new ManualScheduler(clock);
  const app = new CasinoApp({ db, logger: new Logger({ level: 'error' }), clock, scheduler, rng: seededRng(3) });
  const G = 'preview';
  app.settings.set(G, 'economy.startingBalance', 1000);
  const names = ['Alex', 'Hanna', 'Christoffer', 'Maja', 'Oskar'];
  names.forEach((name, i) => app.economy.ensurePlayer(G, `u${i}`, name));
  const table = await app.blackjack.createTable({ guildId: G, ownerId: 'u0', ownerName: 'Alex', name: 'The Velvet Rope' });
  const id = table.record.id;
  for (let i = 1; i < names.length; i++) await app.blackjack.join(id, `u${i}`, names[i]!);
  const rules = rulesFromSettings(app.settings.get(G).blackjack);
  const tableImage = (name: string, revealStep?: number) =>
    save(name, renderTableSvg(buildTableView(app.blackjack.peek(id)!, rules, revealStep === undefined ? {} : { revealStep })), 800);

  await app.blackjack.placeBet(id, 'u0', 150);
  await app.blackjack.placeBet(id, 'u2', 250);
  await tableImage('table-betting');
  // Alex 8,8 (split, double) · Hanna natural · Christoffer 16 · Maja 9 · Oskar 16 · dealer 6 / 10
  await app.blackjack.debugSetShoe(id, ['8S', 'AH', 'TD', '5C', '9H', '6D', '8C', 'KS', '6S', '4D', '7C', 'TH', '3H', 'TC', '2D', 'QS', '5S', '9D'] as Card[]);
  for (const [i, bet] of [[1, 100], [3, 25], [4, 500]] as const) await app.blackjack.placeBet(id, `u${i}`, bet);
  await app.blackjack.placeBet(id, 'u0', 75);
  clock.advance(ALL_IN_DEAL_DELAY_MS);
  scheduler.runDue();
  await app.blackjack.idle();
  let round = app.blackjack.peek(id)!.state.round!;
  await app.blackjack.act(id, 'u0', 'split', round.seq);
  round = app.blackjack.peek(id)!.state.round!;
  await app.blackjack.act(id, 'u0', 'double', round.seq);
  await tableImage('table-playing');
  for (let guard = 0; guard < 20; guard++) {
    const s = app.blackjack.peek(id)!.state;
    if (s.phase !== 'playing') break;
    const who = currentTurnUserId(s.round!)!;
    await app.blackjack.act(id, who, who === 'u3' ? 'hit' : 'stand', s.round!.seq);
  }
  await tableImage('table-reveal', 0);
  await tableImage('table-results');

  await save('banner', bannerSvg('The Emerald Room'), 800);
  await save('roulette', rouletteSvg({ result: 17, history: [17, 0, 32, 5, 21, 36, 9, 14], spinNumber: 8 }), 760);
  const jackpot = spinFromStops([5, 5, 5]);
  await save('slots', slotsSvg({ rows: jackpot.rows, win: true, label: jackpot.label, bet: 10, payout: 2000 }), 640);
  await save('coin', coinSvg('heads'), 420);
  await save('cosmetics', stylePreviewSvg('burgundy', 'royal'), 560);
  const roster = ['Alex', 'Hanna', 'Chris', 'Maja', 'Oskar', 'Linnea'];
  const pokerNames = Object.fromEntries(roster.map((name, i) => [String(i), name]));
  let poker = dealPoker(roster.map((_, seat) => ({ seat, userId: String(seat), stack: 250 })), 0, 5, 10, seededRng(8));
  const firstFrame = pokerTableSvg(publicPokerHand(poker), pokerNames);
  await save('poker-preflop', firstFrame, 840);
  while (poker.street === 'preflop') {
    poker = playPoker(poker, String(poker.actor), poker.seq, { type: poker.actor === poker.bigBlindSeat ? 'check' : 'call' });
  }
  const flopFrame = pokerTableSvg(publicPokerHand(poker), pokerNames);
  await save('poker-flop', flopFrame, 840);
  if (!process.argv.includes('--docs')) {
    const { gif } = await framesToGif([{ svg: firstFrame, delayMs: 1200 }, { svg: flopFrame, delayMs: 1800 }], 640);
    writeFileSync(join(out, 'poker-streets.gif'), gif);
  }
  db.close();
}

void main();
