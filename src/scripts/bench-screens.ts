/**
 * Every casino screen, rendered from a believable simulated casino (in-memory database).
 * Used by the live payload bench and by the screen-catalogue test.
 */
import { Database } from '../db/database.js';
import { ManualClock } from '../core/clock.js';
import { ManualScheduler } from '../core/scheduler.js';
import { Logger } from '../core/logger.js';
import { seededRng } from '../core/random.js';
import { CasinoApp } from '../app/casino-app.js';
import { ALL_IN_DEAL_DELAY_MS } from '../tables/blackjack-table-service.js';
import { currentTurnUserId } from '../games/blackjack/engine.js';
import type { Card } from '../games/cards.js';
import type { Screen } from '../ui/kit.js';
import type { Viewer } from '../ui/screens/common.js';
import { noticeScreen, errorScreen } from '../ui/screens/common.js';
import { homeScreen, walletScreen, historyScreen } from '../ui/screens/home.js';
import { rewardsScreen } from '../ui/screens/rewards.js';
import { profileScreen, achievementsScreen, styleScreen } from '../ui/screens/profile.js';
import { leaderboardScreen } from '../ui/screens/leaderboard.js';
import { helpScreen } from '../ui/screens/help.js';
import { tablesScreen, blackjackPanel, mySeatScreen, myHandScreen, rulesScreen, closedTablePanel } from '../ui/screens/blackjack.js';
import { gamesHubScreen, slotsScreen, paytableScreen, roulettePanel, coinflipMessage } from '../ui/screens/games.js';
import { lobbyScreen } from '../ui/screens/lobby.js';
import { adminScreen, auditScreen, adminTablesScreen } from '../ui/screens/admin.js';

const AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
const NAMES = ['Alex', 'Hanna', 'Christoffer', 'Maja', 'Oskar', 'Linnea', 'Viktor'];

/** Build a believable casino in memory and collect every screen along the way. */
export async function buildScreens(guildId: string, channelId: string): Promise<Array<[string, Screen]>> {
  const db = new Database(':memory:');
  db.migrate();
  // Start in the past: the history below advances the clock to roughly now, so timers look real.
  const clock = new ManualClock(Date.now() - 5 * 3600_000 - 60_000);
  const scheduler = new ManualScheduler(clock);
  const app = new CasinoApp({ db, logger: new Logger({ level: 'error' }), clock, scheduler, rng: seededRng(11) });
  app.settings.setLobby(guildId, channelId, null);
  const id = (i: number) => `90000000000000000${i}`;
  NAMES.forEach((n, i) => app.economy.ensurePlayer(guildId, id(i), n));
  const viewer: Viewer = { guildId, userId: id(0), displayName: NAMES[0]!, avatarUrl: AVATAR, isAdmin: true };
  const screens: Array<[string, Screen]> = [];
  const add = async (name: string, screen: Screen | Promise<Screen>) => screens.push([name, await screen]);

  // A bit of history: rewards, passive income, some wins and losses.
  app.economy.claimDaily(guildId, id(0));
  clock.advance(5 * 3600_000);
  app.economy.claimPassive(guildId, id(0));
  for (let i = 0; i < 6; i++) await app.slots.spin(guildId, id(i % 3), 25, null).catch(() => undefined);

  // Blackjack: one full five-seat table and a second quieter one.
  const table = await app.blackjack.createTable({ guildId, ownerId: id(0), ownerName: NAMES[0]!, name: 'The Velvet Rope' });
  const t = table.record.id;
  for (let i = 1; i < 5; i++) await app.blackjack.join(t, id(i), NAMES[i]!);
  const side = await app.blackjack.createTable({ guildId, ownerId: id(5), ownerName: NAMES[5]! });
  await app.blackjack.join(side.record.id, id(6), NAMES[6]!);
  await app.blackjack.placeBet(t, id(0), 150);
  await app.blackjack.placeBet(t, id(2), 250);
  await add('bj-betting', blackjackPanel(app, app.blackjack.peek(t)!));
  await app.blackjack.debugSetShoe(t, ['8S', 'AH', 'TD', '5C', '9H', '6D', '8C', 'KS', '6S', '4D', '7C', 'TH', '3H', 'TC', '2D', 'QS', '5S', '9D'] as Card[]);
  for (const [i, bet] of [[1, 100], [3, 25], [4, 500]] as const) await app.blackjack.placeBet(t, id(i), bet);
  clock.advance(ALL_IN_DEAL_DELAY_MS);
  scheduler.runDue();
  await app.blackjack.idle();
  await add('bj-dealing', blackjackPanel(app, app.blackjack.peek(t)!, { dealStep: 0 }));
  await add('bj-deal-gif', blackjackPanel(app, app.blackjack.peek(t)!, { animation: { kind: 'dealt' } }));
  let round = app.blackjack.peek(t)!.state.round!;
  await app.blackjack.act(t, id(0), 'split', round.seq);
  round = app.blackjack.peek(t)!.state.round!;
  await app.blackjack.act(t, id(0), 'double', round.seq);
  await add('bj-playing', blackjackPanel(app, app.blackjack.peek(t)!));
  await add('my-seat', mySeatScreen(app, viewer, t));
  await add('my-hand', myHandScreen(app, viewer, t));
  for (let guard = 0; guard < 20; guard++) {
    const s = app.blackjack.peek(t)!.state;
    if (s.phase !== 'playing') break;
    const who = currentTurnUserId(s.round!)!;
    await app.blackjack.act(t, who, who === id(3) ? 'hit' : 'stand', s.round!.seq);
  }
  await add('bj-reveal', blackjackPanel(app, app.blackjack.peek(t)!, { revealStep: 0 }));
  await add('bj-results', blackjackPanel(app, app.blackjack.peek(t)!));

  // Roulette with a few bets, then the spin.
  const { wheel } = await app.roulette.open(guildId);
  await app.roulette.placeBet(wheel.record.id, { userId: id(0), displayName: NAMES[0]!, type: 'red', amount: 50 });
  await app.roulette.placeBet(wheel.record.id, { userId: id(1), displayName: NAMES[1]!, type: 'straight', number: 17, amount: 20 });
  await app.roulette.placeBet(wheel.record.id, { userId: id(2), displayName: NAMES[2]!, type: 'odd', amount: 30 });
  await add('roulette-betting', roulettePanel(app, app.roulette.peek(wheel.record.id)!));
  clock.advance(app.settings.get(guildId).roulette.bettingSeconds * 1000 + 100);
  scheduler.runDue();
  await app.roulette.idle();
  await add('roulette-spinning', roulettePanel(app, app.roulette.peek(wheel.record.id)!, { spinFrame: 0 }));
  await add('roulette-spin-gif', roulettePanel(app, app.roulette.peek(wheel.record.id)!, { animate: true }));
  await add('roulette-spun', roulettePanel(app, app.roulette.peek(wheel.record.id)!));

  // Coinflip challenge, then accepted.
  const challenge = await app.coinflip.create({ guildId, challengerId: id(0), opponentId: id(1), amount: 100, call: 'heads' });
  const names = { challenger: NAMES[0]!, opponent: NAMES[1]! };
  await add('coinflip-pending', coinflipMessage(app, challenge, names));
  const accepted = await app.coinflip.accept(challenge.id, id(1));
  await add('coinflip-flipping', coinflipMessage(app, accepted.challenge, names, { flipping: true }));
  await add('coinflip-toss-gif', coinflipMessage(app, accepted.challenge, names, { flipping: true, animate: true }));
  await add('coinflip-result', coinflipMessage(app, accepted.challenge, names));

  await add('lobby', lobbyScreen(app, guildId));
  await add('home', homeScreen(app, viewer));
  await add('wallet', walletScreen(app, viewer));
  await add('history', historyScreen(app, viewer, 0));
  await add('rewards', rewardsScreen(app, viewer));
  await add('profile', profileScreen(app, viewer, { userId: viewer.userId, displayName: viewer.displayName, avatarUrl: AVATAR }));
  await add('achievements', achievementsScreen(app, viewer, viewer.userId, viewer.displayName, 0));
  await add('style', styleScreen(app, viewer));
  await add('leaderboard', leaderboardScreen(app, viewer, 'net', 'week', 0));
  await add('leaderboard-richest', leaderboardScreen(app, viewer, 'richest', 'all', 0));
  await add('tables', tablesScreen(app, viewer));
  await add('rules', rulesScreen(app, guildId, t));
  await add('games', gamesHubScreen(app, viewer));
  await add('slots-spinning', slotsScreen(app, viewer, 25, { stopped: 1 }));
  await add('slots-reels-gif', slotsScreen(app, viewer, 25, { animate: true }));
  await add('slots', slotsScreen(app, viewer, 25));
  await add('paytable', paytableScreen(25));
  await add('help', helpScreen(app, viewer, 'start'));
  await add('help-blackjack', helpScreen(app, viewer, 'blackjack'));
  await add('admin', adminScreen(app, guildId, 'general'));
  await add('admin-blackjack', adminScreen(app, guildId, 'blackjack'));
  await add('admin-audit', auditScreen(app, guildId));
  await add('admin-tables', adminTablesScreen(app, guildId));
  await add('notice', noticeScreen({ title: 'Bet placed', body: 'You have **150** chips on the table.', tone: 'success' }));
  await add('error', errorScreen('Something went wrong', "That didn't work — sorry about that. Nothing was charged."));
  await add('closed-table', closedTablePanel('The Velvet Rope', 'the host closed the table'));
  await app.shutdown();
  db.close();
  return screens;
}
