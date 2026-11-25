/**
 * Every way into every game lands in that game: slash commands, the Games floor, the rules menu,
 * the lobby, and what happens when a player is already seated in the other card game.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';
import { findComponents } from '../harness/fake-discord.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

function setup() {
  h = new CasinoHarness({ allowThreads: true });
  h.app.settings.set(h.guildId, 'poker.enabled', true);
  return h.user('Alex');
}

describe('entry routes', () => {
  it('slash commands open the matching screens', async () => {
    const alex = setup();
    expect(h.text(h.seen(await h.slash(alex, 'games')))).toContain('The Gaming Floor');
    const bj = h.seen(await h.slash(alex, 'blackjack'))!;
    expect(h.text(bj)).toContain('Blackjack tables');
    expect(h.buttons(bj).map((b) => b.label)).toContain('Open a Blackjack table');
    expect(h.buttons(bj).map((b) => b.label)).not.toContain('Open a Hold’em table');
    const pk = h.seen(await h.slash(alex, 'holdem'))!;
    expect(h.text(pk)).toContain('Hold’em tables');
    expect(h.buttons(pk).map((b) => b.label)).toContain('Open a Hold’em table');
    expect(h.buttons(pk).map((b) => b.label)).not.toContain('Open a Blackjack table');
    expect(h.fd.problems).toEqual([]);
  });

  it('the Games floor opens each game, and its rules menu opens each game’s rules', async () => {
    const alex = setup();
    const screen = h.seen(await h.slash(alex, 'games'))!;
    const expectations: Array<[string, RegExp]> = [
      ['Blackjack', /Blackjack tables/],
      ['Hold’em', /Hold’em tables/],
      ['Slots', /Emerald Slots/],
      ['Coinflip', /Coinflip/],
      ['Events', /Casino events/],
    ];
    for (const [label, expected] of expectations) {
      await h.click(alex, screen, 'Games');
      await h.click(alex, screen, label);
      expect(h.text(screen), label).toMatch(expected);
    }
    // Roulette opens (or points to) the shared wheel.
    await h.click(alex, screen, 'Games');
    const wheel = await h.click(alex, screen, 'Roulette');
    expect(wheel.errors).toEqual([]);
    expect(h.app.roulette.wheelFor(h.guildId)).toBeTruthy();
    // Rules for every game from the one menu.
    for (const [game, expected] of [['blackjack', /blackjack/i], ['poker', /Hold’em/], ['roulette', /roulette/i], ['slots', /Paytable/], ['coinflip', /Coinflip/]] as const) {
      await h.click(alex, screen, 'Games');
      const menu = findComponents(screen.components, 3).find((c) => c.custom_id === 'nav:rules')!;
      await h.select(alex, screen, menu.custom_id, [game]);
      expect(h.text(screen), game).toMatch(expected);
    }
    expect(h.fd.problems).toEqual([]);
  });

  it('opening Hold’em creates Hold’em, never Blackjack', async () => {
    const alex = setup();
    const screen = h.seen(await h.slash(alex, 'holdem'))!;
    const modal = await h.click(alex, screen, 'Open a Hold’em table');
    await h.submit(alex, modal, { buyin: '100', visibility: 'public', seats: '6' });
    expect(h.app.poker.tableOfUser(h.guildId, alex.id)).toBeTruthy();
    expect(h.app.blackjack.tableOfUser(h.guildId, alex.id)).toBeUndefined();
  });

  it('seated at Blackjack, asking for Hold’em explains why and offers the way back, out and to Games', async () => {
    const alex = setup();
    const bj = h.seen(await h.slash(alex, 'blackjack'))!;
    const opener = await h.click(alex, bj, 'Open a Blackjack table');
    await h.submit(alex, opener, { name: 'Felt', visibility: 'public' });
    const table = h.app.blackjack.tableOfUser(h.guildId, alex.id)!;
    const pk = h.seen(await h.slash(alex, 'holdem'))!;
    expect(h.text(pk)).toContain('You already have a seat');
    expect(h.text(pk)).toContain('(Blackjack)');
    const labels = h.buttons(pk).map((b) => b.label);
    expect(labels).not.toContain('Open a Hold’em table');
    expect(labels).toContain('Leave Felt'); // nothing in play: leaving is safe
    expect(labels).toContain('Games');
    expect(h.buttons(pk).some((b) => b.url?.endsWith('/' + table.record.threadId))).toBe(true);
    // Home shows the table and links straight back into its thread.
    const home = h.seen(await h.slash(alex, 'casino'))!;
    expect(h.text(home)).toContain('Felt');
    expect(h.buttons(home).some((b) => b.url?.endsWith('/' + table.record.threadId))).toBe(true);
    // Leaving from the explanation frees the seat; Hold'em can then be opened.
    await h.click(alex, pk, 'Leave Felt');
    expect(h.app.blackjack.tableOfUser(h.guildId, alex.id)).toBeUndefined();
    expect(h.fd.problems).toEqual([]);
  });

  it('the lobby’s My table shows the table or a useful empty state', async () => {
    const alex = setup();
    await h.boot();
    const lobby = h.lobby()!;
    const mine = h.seen(await h.click(alex, lobby, 'My table'))!;
    expect(h.text(mine)).toContain('not seated');
    expect(h.buttons(mine).map((b) => b.label)).toContain('Games');
  });
});
