/**
 * The full screen catalogue validates, plus regression tests for UI bugs found in live testing.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { CasinoApp } from '../src/app/casino-app.js';
import { validateScreen } from '../src/ui/validate.js';
import { homeScreen } from '../src/ui/screens/home.js';
import { blackjackPanel, closedTablePanel } from '../src/ui/screens/blackjack.js';
import { profileScreen } from '../src/ui/screens/profile.js';
import { buildScreens } from '../src/scripts/bench-screens.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import type { Card } from '../src/games/cards.js';
import type { Screen } from '../src/ui/kit.js';

const G = '573000000000000001';
const C = '157400000000000001';

function textOf(screen: Screen): string {
  const out: string[] = [];
  const walk = (cs: unknown[]) => {
    for (const c of cs as Array<Record<string, unknown>>) {
      if (c.type === 10) out.push(String(c.content));
      for (const key of ['components', 'items']) if (Array.isArray(c[key])) walk(c[key] as unknown[]);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk(screen.components);
  return out.join('\n');
}

function makeApp() {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(Date.now());
  const scheduler = new ManualScheduler(clock);
  return { app: new CasinoApp({ db, logger: silentLogger, clock, scheduler, rng: seededRng(4) }), clock, scheduler };
}

describe('screen catalogue', () => {
  it('every screen in every simulated state is a valid Discord payload', async () => {
    const screens = await buildScreens(G, C);
    expect(screens.length).toBeGreaterThanOrEqual(30);
    for (const [name, screen] of screens) expect(validateScreen(screen).errors, name).toEqual([]);
  }, 30_000);
});

describe('UI regressions from live testing', () => {
  it('home: a seated player whose table has no panel yet gets unique button ids', async () => {
    const { app } = makeApp();
    app.economy.ensurePlayer(G, '1', 'Alex');
    await app.blackjack.createTable({ guildId: G, ownerId: '1', ownerName: 'Alex' });
    const screen = await homeScreen(app, { guildId: G, userId: '1', displayName: 'Alex', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', isAdmin: false });
    expect(validateScreen(screen).errors).toEqual([]);
    await app.shutdown();
  });

  it('results: no duplicated result log, one extras line per player, clear bet status', async () => {
    const { app, clock, scheduler } = makeApp();
    for (const [id, name] of [['1', 'Alex'], ['2', 'Hanna'], ['3', 'Maja']] as const) app.economy.ensurePlayer(G, id, name);
    const table = await app.blackjack.createTable({ guildId: G, ownerId: '1', ownerName: 'Alex' });
    const t = table.record.id;
    await app.blackjack.join(t, '2', 'Hanna');
    await app.blackjack.join(t, '3', 'Maja');
    await app.blackjack.debugSetShoe(t, ['TS', 'AH', '9C', '7D', '9H', 'KS', 'TC', 'TD'] as Card[]);
    for (const id of ['1', '2', '3']) await app.blackjack.placeBet(t, id, 50);
    clock.advance(ALL_IN_DEAL_DELAY_MS);
    scheduler.runDue();
    await app.blackjack.idle();
    for (let i = 0; i < 6 && app.blackjack.peek(t)!.state.phase === 'playing'; i++) {
      const s = app.blackjack.peek(t)!.state;
      const r = s.round!;
      await app.blackjack.act(t, r.seats[r.turn!.seat]!.userId, 'stand', r.seq);
    }
    const text = textOf(await blackjackPanel(app, app.blackjack.peek(t)!));
    expect(text).toContain('results');
    // Result lines appear once (in the results block), not again in the activity log.
    expect(text.match(/Hanna won|Hanna wins/g)).toHaveLength(1);
    // Achievements are grouped per player, never "X unlocked … · X unlocked …".
    expect(text).not.toMatch(/Alex unlocked \*\*[^*]+\*\* · Alex unlocked/);
    // No cryptic dashes for players without a bet.
    expect(text).not.toMatch(/Alex —/);
    await app.blackjack.placeBet(t, '2', 25);
    const betting = textOf(await blackjackPanel(app, app.blackjack.peek(t)!));
    expect(betting).toContain('Bets in: Hanna **25**');
    expect(betting).toContain('Still deciding: Alex, Maja');
    await app.shutdown();
  });

  it('closed tables read naturally', () => {
    const { app } = makeApp();
    expect(textOf(closedTablePanel(app, { guildId: G, channelId: null, name: 'Table 01' }, 'empty table'))).toContain('Empty table. Remaining chips were returned to Wallet.');
  });

  it('profile: singular/plural counts', async () => {
    const { app } = makeApp();
    app.economy.ensurePlayer(G, '1', 'Alex');
    await app.slots.spin(G, '1', 10, null);
    const text = textOf(profileScreen(app, { guildId: G, userId: '1', displayName: 'Alex', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', isAdmin: false }, { userId: '1', displayName: 'Alex', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' }));
    expect(text).toMatch(/Slots — 1 spin\b/);
    expect(text).not.toMatch(/\b1 days\b/);
    expect(text).not.toContain('best ×0');
    await app.shutdown();
  });
});
