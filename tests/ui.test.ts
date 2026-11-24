import { beforeEach, describe, expect, it } from 'vitest';
import { ButtonStyle, ComponentType } from 'discord.js';
import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { CasinoApp } from '../src/app/casino-app.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import { currentTurnUserId } from '../src/games/blackjack/engine.js';
import type { Card } from '../src/games/cards.js';
import { validateScreen } from '../src/ui/validate.js';
import { parseCid } from '../src/ui/custom-id.js';
import type { Screen } from '../src/ui/kit.js';
import type { Viewer } from '../src/ui/screens/common.js';
import { homeScreen, walletScreen, historyScreen } from '../src/ui/screens/home.js';
import { profileScreen, achievementsScreen, styleScreen } from '../src/ui/screens/profile.js';
import { leaderboardScreen } from '../src/ui/screens/leaderboard.js';
import { rewardsScreen } from '../src/ui/screens/rewards.js';
import { blackjackPanel, chipPresets, closedTablePanel, createTableModal, mySeatScreen, rulesScreen, tablesScreen } from '../src/ui/screens/blackjack.js';
import { coinflipMessage, gamesHubScreen, paytableScreen, rouletteHelpScreen, roulettePanel, slotsScreen } from '../src/ui/screens/games.js';
import { lobbyScreen } from '../src/ui/screens/lobby.js';
import { helpScreen, HELP_TOPICS } from '../src/ui/screens/help.js';
import { adminScreen, adminTablesScreen, auditScreen } from '../src/ui/screens/admin.js';
import { LEADERBOARD_CATEGORIES } from '../src/domain/leaderboard-service.js';
import { commandDefinitions } from '../src/discord/commands.js';
import { GUILD, userId } from './helpers.js';

interface AnyComponent {
  type: number;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  style?: number;
  components?: AnyComponent[];
  accessory?: AnyComponent;
  content?: string;
}

function walk(screen: Screen): AnyComponent[] {
  const out: AnyComponent[] = [];
  const visit = (c: AnyComponent) => {
    out.push(c);
    c.components?.forEach(visit);
    if (c.accessory) visit(c.accessory);
  };
  (screen.components as AnyComponent[]).forEach(visit);
  return out;
}
const buttons = (s: Screen) => walk(s).filter((c) => c.type === ComponentType.Button);
const byAction = (s: Screen, scope: string, action: string) =>
  buttons(s).filter((b) => b.custom_id && parseCid(b.custom_id).scope === scope && parseCid(b.custom_id).action === action);
const allText = (s: Screen) => walk(s).filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content).join('\n');

function expectValid(screen: Screen): void {
  const report = validateScreen(screen);
  expect(report.errors).toEqual([]);
}

describe('UI payloads', () => {
  let app: CasinoApp;
  let clock: ManualClock;
  let scheduler: ManualScheduler;
  const viewer = (n: number, admin = false): Viewer => ({
    guildId: GUILD,
    userId: userId(n),
    displayName: `Player ${n}`,
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    isAdmin: admin,
  });
  const tick = async (ms: number) => {
    clock.advance(ms);
    scheduler.runDue();
    await app.blackjack.idle();
  };

  beforeEach(() => {
    const db = new Database(':memory:');
    db.migrate();
    clock = new ManualClock();
    scheduler = new ManualScheduler(clock);
    app = new CasinoApp({ db, logger: silentLogger, clock, scheduler, rng: seededRng(77) });
    for (let n = 1; n <= 6; n++) app.economy.ensurePlayer(GUILD, userId(n), `Player ${n}`);
  });

  it('every personal screen fits Discord limits for new and active players', async () => {
    const v = viewer(1);
    const screens: Screen[] = [
      homeScreen(app, v),
      walletScreen(app, v),
      historyScreen(app, v, 0),
      historyScreen(app, v, 99),
      profileScreen(app, v, { userId: v.userId, displayName: v.displayName, avatarUrl: v.avatarUrl }),
      profileScreen(app, v, { userId: userId(2), displayName: 'Player 2', avatarUrl: v.avatarUrl }),
      profileScreen(app, v, { userId: '999', displayName: 'Stranger', avatarUrl: v.avatarUrl }),
      achievementsScreen(app, v, v.userId, v.displayName, 0),
      achievementsScreen(app, v, v.userId, v.displayName, 5),
      await styleScreen(app, v),
      rewardsScreen(app, v),
      tablesScreen(app, v),
      gamesHubScreen(app, v),
      await slotsScreen(app, v, 25),
      paytableScreen(25),
      rouletteHelpScreen(),
      rulesScreen(app, GUILD),
      ...HELP_TOPICS.map((t) => helpScreen(app, v, t)),
      ...LEADERBOARD_CATEGORIES.flatMap((c) => c.periods.map((p) => leaderboardScreen(app, v, c.id, p, 0))),
      adminScreen(app, GUILD, 'general'),
      adminScreen(app, GUILD, 'blackjack'),
      adminScreen(app, GUILD, 'economy'),
      adminScreen(app, GUILD, 'tables'),
      adminScreen(app, GUILD, 'games'),
      auditScreen(app, GUILD),
      adminTablesScreen(app, GUILD),
      await lobbyScreen(app, GUILD),
      closedTablePanel('Table 01', 'idle'),
    ];
    for (const s of screens) expectValid(s);
  });

  it('modals use labelled inputs with valid ids', () => {
    const modal = createTableModal(app, GUILD);
    expect(modal.components.length).toBeLessThanOrEqual(5);
    for (const c of modal.components) expect(c.type === ComponentType.Label || c.type === ComponentType.TextDisplay).toBe(true);
  });

  it('chip presets span the table limits', () => {
    expect(chipPresets(10, 500)).toEqual([10, 25, 100, 250, 500]);
    expect(chipPresets(5, 20)).toEqual([5, 10, 20]);
    expect(chipPresets(100, 100)).toEqual([100]);
    for (const [min, max] of [[1, 1_000_000], [10, 500], [7, 13]] as const) {
      const presets = chipPresets(min, max);
      expect(presets.length).toBeLessThanOrEqual(5);
      expect(presets[0]).toBe(min);
      expect(presets.at(-1)).toBe(max);
    }
  });

  describe('blackjack table panel', () => {
    let tableId: string;

    beforeEach(async () => {
      const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
      tableId = t.record.id;
      await app.blackjack.join(tableId, userId(2), 'Player 2');
    });

    it('shows betting controls before the deal and no turn controls', async () => {
      const panel = await blackjackPanel(app, app.blackjack.peek(tableId)!);
      expectValid(panel);
      expect(byAction(panel, 'bj', 'bet').map((b) => b.label)).toEqual(['10', '25', '100', '250', '500']);
      expect(byAction(panel, 'bj', 'act')).toHaveLength(0);
      expect(byAction(panel, 'bj', 'rebet')).toHaveLength(1);
      expect(panel.files).toHaveLength(1);
    });

    it('shows the active player, sequence-stamped actions and disables illegal moves', async () => {
      // p1: T,9 (19)  p2: 8,8  dealer 7 / T
      await app.blackjack.debugSetShoe(tableId, ['TS', '8S', '7H', '9D', '8D', 'TH', '3C', 'TC'] as Card[]);
      await app.blackjack.placeBet(tableId, userId(1), 100);
      await app.blackjack.placeBet(tableId, userId(2), 100);
      await tick(ALL_IN_DEAL_DELAY_MS);
      let snap = app.blackjack.peek(tableId)!;
      expect(currentTurnUserId(snap.state.round!)).toBe(userId(1));
      let panel = await blackjackPanel(app, snap);
      expectValid(panel);
      expect(allText(panel)).toContain('Player 1 to act');
      const acts = byAction(panel, 'bj', 'act');
      expect(acts.map((b) => parseCid(b.custom_id!).args[1])).toEqual(['hit', 'stand', 'double', 'split', 'surrender']);
      for (const b of acts) expect(parseCid(b.custom_id!).args[2]).toBe(String(snap.state.round!.seq));
      const split = acts.find((b) => parseCid(b.custom_id!).args[1] === 'split')!;
      expect(split.disabled).toBe(true); // T,9 is not a pair
      expect(acts.find((b) => parseCid(b.custom_id!).args[1] === 'hit')!.style).toBe(ButtonStyle.Success);
      expect(byAction(panel, 'bj', 'bet')).toHaveLength(0);

      await app.blackjack.act(tableId, userId(1), 'stand', snap.state.round!.seq);
      snap = app.blackjack.peek(tableId)!;
      panel = await blackjackPanel(app, snap);
      expect(allText(panel)).toContain('Player 2 to act');
      const split2 = byAction(panel, 'bj', 'act').find((b) => parseCid(b.custom_id!).args[1] === 'split')!;
      expect(split2.disabled).toBeFalsy(); // 8,8 can split
      // A player who cannot afford it sees Double/Split disabled with an explanation.
      app.economy.adminAdjust({ guildId: GUILD, userId: userId(2), amount: 50 - app.economy.requirePlayer(GUILD, userId(2)).balance, reason: 'test', actorId: userId(9) });
      panel = await blackjackPanel(app, app.blackjack.peek(tableId)!);
      const dbl = byAction(panel, 'bj', 'act').find((b) => parseCid(b.custom_id!).args[1] === 'double')!;
      expect(dbl.disabled).toBe(true);
      expect(dbl.label).toContain('no chips');
    });

    it('renders reveal frames without controls, then results with betting controls', async () => {
      await app.blackjack.debugSetShoe(tableId, ['TS', '9S', '6H', '7D', '8D', 'TH', '5C', 'TC'] as Card[]);
      await app.blackjack.placeBet(tableId, userId(1), 50);
      await app.blackjack.placeBet(tableId, userId(2), 50);
      await tick(ALL_IN_DEAL_DELAY_MS);
      for (let g = 0; g < 4; g++) {
        const s = app.blackjack.peek(tableId)!.state;
        if (s.phase !== 'playing') break;
        await app.blackjack.act(tableId, currentTurnUserId(s.round!)!, 'stand', s.round!.seq);
      }
      const snap = app.blackjack.peek(tableId)!;
      expect(snap.state.lastResult).not.toBeNull();
      const frame = await blackjackPanel(app, snap, { revealStep: 0 });
      expectValid(frame);
      expect(byAction(frame, 'bj', 'bet')).toHaveLength(0);
      expect(allText(frame)).toContain("Dealer's turn");
      const final = await blackjackPanel(app, snap);
      expectValid(final);
      expect(allText(final)).toMatch(/Hand 1 · results/);
      expect(byAction(final, 'bj', 'bet').length).toBeGreaterThan(0);
    });

    it('caches identical table images (no re-render, same attachment name)', async () => {
      const a = await blackjackPanel(app, app.blackjack.peek(tableId)!);
      await app.blackjack.placeBet(tableId, userId(1), 25); // bets show in text and on the felt
      const b = await blackjackPanel(app, app.blackjack.peek(tableId)!);
      const c = await blackjackPanel(app, app.blackjack.peek(tableId)!);
      expect(b.files![0]!.name).toBe(c.files![0]!.name);
      expect(a.files![0]!.name).not.toBe(b.files![0]!.name);
      expect(app.images.hits).toBeGreaterThan(0);
    });

    it('offers host tools only to the host in the seat panel', () => {
      const host = mySeatScreen(app, viewer(1), tableId);
      const guest = mySeatScreen(app, viewer(2), tableId);
      const stranger = mySeatScreen(app, viewer(5), tableId);
      for (const s of [host, guest, stranger]) expectValid(s);
      expect(byAction(host, 'bj', 'close')).toHaveLength(1);
      expect(byAction(guest, 'bj', 'close')).toHaveLength(0);
      expect(byAction(stranger, 'bj', 'join')).toHaveLength(1);
    });

    it('stays within limits with seven seats and a full lobby', async () => {
      app.settings.set(GUILD, 'blackjack.maxSeats', 7);
      app.settings.set(GUILD, 'tables.maxTables', 25);
      for (let t = 0; t < 8; t++) {
        app.economy.ensurePlayer(GUILD, `host${t}`, `Host with a really quite long display name ${t}`);
        await app.blackjack.createTable({ guildId: GUILD, ownerId: `host${t}`, ownerName: `Host with a really quite long display name ${t}`, name: `A very long table name ${t}` });
      }
      expectValid(await lobbyScreen(app, GUILD));
      expectValid(tablesScreen(app, viewer(3)));
      expectValid(adminTablesScreen(app, GUILD));
    });
  });

  it('roulette and coinflip screens are valid in every state', async () => {
    const { wheel } = await app.roulette.open(GUILD);
    expectValid(await roulettePanel(app, app.roulette.peek(wheel.record.id)!));
    for (let n = 1; n <= 6; n++) {
      await app.roulette.placeBet(wheel.record.id, { userId: userId(n), displayName: `Player ${n}`, type: 'straight', number: n, amount: 10 });
      await app.roulette.placeBet(wheel.record.id, { userId: userId(n), displayName: `Player ${n}`, type: 'red', amount: 10 });
    }
    expectValid(await roulettePanel(app, app.roulette.peek(wheel.record.id)!));
    clock.advance(30_000);
    scheduler.runDue();
    await app.roulette.idle();
    expectValid(await roulettePanel(app, app.roulette.peek(wheel.record.id)!));

    const c = await app.coinflip.create({ guildId: GUILD, challengerId: userId(1), opponentId: userId(2), amount: 50, call: 'heads' });
    expectValid(await coinflipMessage(app, c, { challenger: 'A', opponent: 'B' }));
    const { challenge } = await app.coinflip.accept(c.id, userId(2));
    expectValid(await coinflipMessage(app, challenge, { challenger: 'A', opponent: 'B' }));
  });

  it('slot screen spin buttons carry the spin counter (double-click protection)', async () => {
    const v = viewer(1);
    const before = await slotsScreen(app, v, 10);
    const spin = byAction(before, 'sl', 'spin')[0]!;
    expect(parseCid(spin.custom_id!).args).toEqual(['10', '0']);
    await app.slots.spin(GUILD, v.userId, 10, 0);
    const after = await slotsScreen(app, v, 10);
    expect(parseCid(byAction(after, 'sl', 'spin')[0]!.custom_id!).args).toEqual(['10', '1']);
    expectValid(after);
  });

  it('leaderboards paginate and highlight the viewer', async () => {
    for (let n = 1; n <= 25; n++) {
      app.economy.ensurePlayer(GUILD, `lb${n}`, `Ranked ${n}`);
      app.economy.adminAdjust({ guildId: GUILD, userId: `lb${n}`, amount: n * 10, reason: 'seed', actorId: 'admin' });
    }
    const v = viewer(1);
    const page0 = leaderboardScreen(app, v, 'richest', 'all', 0);
    const page2 = leaderboardScreen(app, v, 'richest', 'all', 2);
    expectValid(page0);
    expectValid(page2);
    expect(allText(page0)).toContain('Ranked 25');
    expect(allText(page0)).toMatch(/You: \*\*#\d+\*\*/);
    const pager = buttons(page0).filter((b) => b.custom_id?.startsWith('nav:lb:richest:all:'));
    expect(pager.find((b) => b.custom_id === 'nav:lb:richest:all:-1')?.disabled).toBe(true);
    expect(buttons(page2).some((b) => b.label === 'Page 3 of 4')).toBe(true);
    // Asking for a page past the end clamps to the last page, whose "next" is disabled.
    const last = leaderboardScreen(app, v, 'richest', 'all', 99);
    expect(buttons(last).some((b) => b.label === 'Page 4 of 4')).toBe(true);
    expect(buttons(last).find((b) => b.custom_id === 'nav:lb:richest:all:4')?.disabled).toBe(true);
  });

  it('slash command definitions are valid and guild-only', () => {
    const commands = commandDefinitions();
    const names = commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['casino', 'wallet', 'daily', 'blackjack', 'leaderboard', 'profile', 'coinflip', 'casinoadmin', 'Casino profile']));
    expect(new Set(names).size).toBe(names.length);
    for (const c of commands) expect(c.contexts).toEqual([0]);
    const admin = commands.find((c) => c.name === 'casinoadmin')!;
    expect(admin.default_member_permissions).toBe(String(1n << 5n));
  });
});
