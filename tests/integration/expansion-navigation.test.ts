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

  it('opens game-specific screens and keeps Home and My table free of quick seating', async () => {
    h = new CasinoHarness({ allowThreads: true });
    await h.boot();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const user = h.user('Player');
    const home = h.seen(await h.slash(user, 'casino'))!;
    expect(h.enabled(home)).not.toContain('Quick seat');
    expect(h.enabled(home)).not.toContain('Play Blackjack');
    await h.click(user, home, 'My table');
    expect(h.text(home)).toContain('You don’t have a seat');

    await h.click(user, home, 'Games');
    await h.click(user, home, 'Hold’em tables');
    expect(h.text(home)).toContain('Hold’em tables');
    expect(h.buttons(home).map((button) => button.label)).not.toContain('Open Blackjack');
    expect(h.buttons(home).map((button) => button.label)).not.toContain('Quick seat');
    const modal = await h.click(user, home, 'Open Hold’em');
    await h.submit(user, modal, { buyin: '100', visibility: 'public', seats: '6' });
    const poker = h.app.poker.tableOfUser(h.guildId, user.id)!;
    expect(poker.record.threadId).toBeTruthy();
    expect(h.app.blackjack.tableOfUser(h.guildId, user.id)).toBeUndefined();

    await h.click(user, home, 'Home');
    await h.click(user, home, 'My table');
    expect(h.buttons(home).some((button) => button.url?.endsWith('/' + poker.record.threadId))).toBe(true);
    await h.click(user, home, 'Games');
    await h.click(user, home, 'Blackjack tables');
    expect(h.text(home)).toContain('You already have a seat in Hold’em');
    expect(h.enabled(home)).not.toContain('Open Blackjack');
    expect(h.buttons(home).map((button) => button.label)).not.toContain('Open Hold’em');

    await h.click(user, home, 'Games');
    await h.click(user, home, 'Play slots');
    expect(h.text(home)).toMatch(/Slots/);
    await h.click(user, home, 'Games');
    await h.click(user, home, 'Choose opponent');
    expect(h.text(home)).toContain('Pick a friend');
    await h.click(user, home, 'Games');
    const roulette = h.seen(await h.click(user, home, 'Open the wheel'))!;
    expect(h.text(roulette)).toContain('The wheel is ready');
    expect(h.fd.channelMessages(h.casino)).toHaveLength(1);
    expect(h.guard!.blockedCount).toBe(0);
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
