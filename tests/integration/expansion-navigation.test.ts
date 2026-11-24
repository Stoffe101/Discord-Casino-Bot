import { afterEach, describe, expect, it } from 'vitest';
import { LEADERBOARD_CATEGORIES } from '../../src/domain/leaderboard-service.js';
import { boardComponent, readBoardLocation } from '../../src/ui/navigation.js';
import { CasinoHarness } from '../harness/casino-harness.js';

describe('casino navigation', () => {
  let h: CasinoHarness;
  afterEach(async () => h.close());

  it('keeps all five destinations in order and highlights the active one', async () => {
    h = new CasinoHarness();
    const user = h.user('Alice');
    let message = h.seen(await h.slash(user, 'casino'));
    const order = ['Home', 'Games', 'Wallet', 'Leaderboards', 'Profile'];
    for (const label of order) {
      if (label !== 'Home') message = h.seen(await h.click(user, message, label));
      const nav = h.buttons(message).slice(0, 5);
      expect(nav.map((b) => b.label)).toEqual(order);
      expect(nav.find((b) => b.style === 1)?.label).toBe(label);
    }
  });

  it('returns to the exact weekly leaderboard page after a profile visit', async () => {
    h = new CasinoHarness();
    const viewer = h.user('Viewer');
    const players = Array.from({ length: 31 }, (_, i) => h.user(`Player ${i}`));
    for (const [i, player] of players.entries()) {
      h.app.economy.ensurePlayer(h.guildId, player.id, player.name);
      h.app.recorder.record({
        guildId: h.guildId, roundId: `fixture-${i}`, title: 'Fixture', game: 'blackjack',
        players: [{ userId: player.id, wagered: 0, returned: 0, stats: { wins: 1 }, flags: [], xp: 0, label: 'win' }],
      });
    }
    const home = h.seen(await h.slash(viewer, 'casino'));
    const board = h.seen(await h.click(viewer, home, 'Leaderboards'));
    await h.click(viewer, board, 'This week');
    await h.click(viewer, board, /^nav:lb:net:week:1$/);
    await h.click(viewer, board, /^nav:lb:net:week:2$/);
    const data = h.app.leaderboards.page(h.guildId, 'net', 'week', 2, 10, viewer.id);
    expect(data.entries.length).toBeGreaterThan(0);
    await h.select(viewer, board, 'lbpro', [data.entries[0]!.userId]);
    expect(h.text(board)).toContain(data.entries[0]!.displayName);
    await h.click(viewer, board, 'Back to leaderboard');
    expect(h.text(board)).toContain('This week');
    expect(h.buttons(board).some((button) => button.label === 'Page 3 of 4')).toBe(true);
  });

  it('rejects a navigation context belonging to a different player or guild', () => {
    h = new CasinoHarness();
    const owner = { guildId: h.guildId, userId: h.user('Owner').id, displayName: 'Owner', avatarUrl: '', isAdmin: false };
    const location = { category: LEADERBOARD_CATEGORIES[1]!.id, period: 'week', page: 2 } as const;
    const id = boardComponent('lbback', owner, location);
    expect(readBoardLocation(id, owner)).toEqual(location);
    expect(readBoardLocation(id, { ...owner, userId: h.user('Other').id })).toBeNull();
    expect(readBoardLocation(id, { ...owner, guildId: 'other' })).toBeNull();
    expect(readBoardLocation(id.replace(/:2$/, ':NaN'), owner)).toBeNull();
  });
});
