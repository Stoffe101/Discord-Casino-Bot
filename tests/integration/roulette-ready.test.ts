import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';

describe('roulette ready voting', () => {
  let h: CasinoHarness;
  afterEach(async () => h.close());

  async function start() {
    h = new CasinoHarness();
    const players = Array.from({ length: 10 }, (_, i) => h.user(`Player ${i}`));
    await h.slash(players[0]!, 'roulette');
    const wheel = h.app.roulette.wheelFor(h.guildId)!;
    return { players, wheel, panel: h.fd.messages.get(wheel.record.messageId!)! };
  }

  it('requires six out of ten distinct bettors and respects the minimum window', async () => {
    const { players, wheel, panel } = await start();
    const round = wheel.state.roundId;
    const roulette = h.app.roulette;
    for (const user of players) {
      h.app.economy.ensurePlayer(h.guildId, user.id);
      await roulette.placeBet(wheel.record.id, { userId: user.id, displayName: user.username, type: 'red', amount: 10, roundId: round });
    }
    for (const user of players.slice(0, 5)) await roulette.vote(wheel.record.id, user.id, round, true);
    await roulette.vote(wheel.record.id, players[0]!.id, round, true);
    const spectator = h.user('Spectator');
    await expect(roulette.vote(wheel.record.id, spectator.id, round, true)).rejects.toThrow(/Place a bet/);
    await h.settle();
    expect(h.text(panel)).toContain('5/10');
    expect(h.text(panel)).toContain('6 required');
    await h.click(players[5]!, panel, 'Ready');
    await h.advance(7_000);
    expect(wheel.state.roundId).toBe(round);
    await h.click(players[5]!, panel, 'Withdraw vote');
    await h.advance(1_000);
    expect(wheel.state.roundId).toBe(round);
    await h.click(players[5]!, panel, 'Ready');
    await h.advance(0);
    expect(wheel.state.roundId).not.toBe(round);
    await expect(roulette.vote(wheel.record.id, players[0]!.id, round, true)).rejects.toThrow(/closed/);
    await h.advance(25_000);
    expect(wheel.state.spinNumber).toBe(1);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('rejects a submitted modal from the previous spin through the real router', async () => {
    const { players: [alice, bob], wheel, panel } = await start();
    const stale = await h.select(alice!, panel, 'rl:bet', ['red']);
    const bet = await h.select(bob!, panel, 'rl:bet', ['black']);
    await h.submit(bob!, bet, { amount: '20' });
    await h.advance(25_000);
    expect(wheel.state.spinNumber).toBe(1);
    const balance = h.balance(alice!);
    const result = await h.submit(alice!, stale, { amount: '20' });
    expect(h.text(h.seen(result))).toMatch(/current spin/i);
    expect(h.balance(alice!)).toBe(balance);
    expect(wheel.state.bets).toEqual([]);
  });
});
