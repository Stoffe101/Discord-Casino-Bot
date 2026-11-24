import { afterEach, describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../../src/core/clock.js';
import { CasinoApp } from '../../src/app/casino-app.js';
import { silentLogger } from '../../src/core/logger.js';
import { recentCasinoActivity } from '../../src/domain/casino-activity.js';
import { CasinoHarness } from '../harness/casino-harness.js';

describe('expanded wallet', () => {
  let h: CasinoHarness;
  afterEach(async () => h.close());

  function disableOtherRewards() {
    h.app.settings.set(h.guildId, 'economy.passivePerHour', 0);
    h.app.settings.set(h.guildId, 'economy.dailyReward', 0);
  }

  it('checks escrow and available rewards before granting relief exactly once', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const { economy } = h.app;
    await h.slash(alice, 'casino');
    const balance = h.balance(alice);
    economy.reserve({ guildId: h.guildId, userId: alice.id, contextId: 'pending', game: 'roulette', key: 'bet', amount: balance });
    expect(economy.reliefStatus(h.guildId, alice.id)).toMatchObject({ reason: 'funds' });
    economy.settle({ guildId: h.guildId, userId: alice.id, contextId: 'pending', game: 'roulette', key: 'lost', payout: 0, expectedStake: balance, outcome: 'loss' });
    expect(economy.reliefStatus(h.guildId, alice.id)).toMatchObject({ reason: 'rewards' });
    disableOtherRewards();
    const wallet = h.seen(await h.slash(alice, 'wallet'))!;
    h.fd.click(alice, wallet, 'Claim with Sosse title');
    h.fd.click(alice, wallet, 'Claim with Sosse title');
    await h.settle();
    expect(h.balance(alice)).toBe(50);
    expect(economy.ledgerPage(h.guildId, alice.id, 10).filter((row) => row.type === 'emergency_relief')).toHaveLength(1);
    let profile = h.seen(await h.slash(alice, 'profile'));
    expect(h.text(profile)).toContain('Sosse');

    const restarted = new CasinoApp({ db: h.db, clock: h.clock, logger: silentLogger });
    economy.adminAdjust({ guildId: h.guildId, userId: alice.id, actorId: 'admin', reason: 'Testing cooldown', amount: -50 });
    expect(restarted.economy.reliefStatus(h.guildId, alice.id)).toMatchObject({ reason: 'cooldown' });
    await h.advance(HOUR / 2);
    profile = h.seen(await h.slash(alice, 'profile'));
    expect(h.text(profile)).not.toContain('Sosse');
    await h.advance(DAY - HOUR / 2);
    expect(restarted.economy.reliefStatus(h.guildId, alice.id)).toMatchObject({ eligible: true });
    expect(economy.reconcile()).toEqual([]);
    await restarted.shutdown();
  });

  it('grants relief before players have to lose their last one or two chips', () => {
    h = new CasinoHarness();
    disableOtherRewards();
    const { economy } = h.app;
    for (const balance of [1, 2]) {
      const player = h.user('Short stack ' + balance);
      economy.ensurePlayer(h.guildId, player.id);
      economy.adminAdjust({ guildId: h.guildId, userId: player.id, actorId: 'admin',
        reason: 'Set the test balance', amount: balance - h.balance(player) });
      expect(economy.reliefStatus(h.guildId, player.id)).toMatchObject({ eligible: true });
      economy.claimRelief(h.guildId, player.id, false);
      expect(h.balance(player)).toBe(50 + balance);
    }
    expect(economy.reconcile()).toEqual([]);
  });

  it('confirms gifts privately and conserves chips under duplicate clicks', async () => {
    h = new CasinoHarness();
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await h.slash(alice, 'casino');
    await h.slash(bob, 'casino');
    await h.advance(DAY);
    const before = h.balance(alice) + h.balance(bob);
    const { economy } = h.app;
    expect(h.app.settings.get(h.guildId).economy.giftingEnabled).toBe(true);
    h.app.settings.set(h.guildId, 'economy.giftingEnabled', false);
    expect(() => economy.gift(h.guildId, alice.id, bob.id, 50, 'disabled')).toThrow(/disabled/);
    h.app.settings.set(h.guildId, 'economy.giftingEnabled', true);
    const wallet = h.seen(await h.slash(alice, 'wallet'))!;
    await h.click(alice, wallet, 'Gifting');
    const modal = await h.select(alice, wallet, 'gift:pick', [bob.id]);
    await h.submit(alice, modal, { amount: '50' });
    expect(h.text(wallet)).toContain('Confirm chip gift');
    h.fd.click(alice, wallet, 'Confirm gift');
    h.fd.click(alice, wallet, 'Confirm gift');
    await h.settle();
    const sent = economy.ledgerPage(h.guildId, alice.id, 10).filter((row) => row.type === 'gift_sent');
    const received = economy.ledgerPage(h.guildId, bob.id, 10).filter((row) => row.type === 'gift_received');
    expect(sent).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.reference).toBe(sent[0]!.reference);
    expect(h.balance(alice) + h.balance(bob)).toBe(before);
    expect(h.app.history.page(h.guildId, alice.id, undefined, 0, 10).total).toBe(0);
    expect(economy.reconcile()).toEqual([]);
    expect(h.guard!.blockedCount).toBe(0);
  });

  it('limits gifts and blocks relief after an outgoing gift', async () => {
    h = new CasinoHarness();
    const { economy } = h.app;
    const [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map((name) => h.user(name));
    const [sender, recipient, other] = [alice!.id, bob!.id, carol!.id];
    for (const user of [sender, recipient, other]) economy.ensurePlayer(h.guildId, user);
    h.app.settings.set(h.guildId, 'economy.giftingEnabled', true);
    expect(() => economy.gift(h.guildId, sender, recipient, 50, 'new')).toThrow(/24 hours/);
    await h.advance(DAY);
    expect(() => economy.gift(h.guildId, sender, sender, 50, 'self')).toThrow(/another/);
    expect(() => economy.gift('other-guild', sender, recipient, 50, 'foreign')).toThrow();
    h.db.run('UPDATE players SET gifts_opt_out = 1 WHERE guild_id = ? AND user_id = ?', [h.guildId, recipient]);
    expect(() => economy.gift(h.guildId, sender, recipient, 50, 'optout')).toThrow(/turned off/);
    economy.gift(h.guildId, sender, other, 500, 'allowed');
    economy.gift(h.guildId, sender, other, 500, 'allowed');
    expect(() => economy.gift(h.guildId, sender, other, 10, 'limit')).toThrow(/daily gift limit/);
    disableOtherRewards();
    const remaining = economy.requirePlayer(h.guildId, sender).balance;
    if (remaining > 0) economy.adminAdjust({ guildId: h.guildId, userId: sender, actorId: 'admin', reason: 'Testing relief', amount: -remaining });
    expect(economy.reliefStatus(h.guildId, sender)).toMatchObject({ reason: 'recent_gift' });
  });

  it('restores slot stops from history and scopes match inspection to the player and guild', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const bob = h.user('Bob');
    await h.slash(alice, 'casino');
    await h.slash(bob, 'casino');
    const outcome = await h.app.slots.spin(h.guildId, alice.id, 25, null);
    const restarted = new CasinoApp({ db: h.db, clock: h.clock, logger: silentLogger });
    expect(restarted.slots.lastSpin(h.guildId, alice.id)?.spin.rows).toEqual(outcome.spin.rows);
    const result = restarted.history.page(h.guildId, alice.id, 'slots', 0, 8).results[0]!;
    expect(restarted.history.get(h.guildId, bob.id, result.round_id)).toBeUndefined();
    expect(restarted.history.get('another-guild', alice.id, result.round_id)).toBeUndefined();
    const wallet = h.seen(await h.slash(alice, 'wallet'))!;
    await h.click(alice, wallet, 'Match history');
    await h.select(alice, wallet, 'match:filter', ['slots']);
    await h.select(alice, wallet, 'match:open', [result.round_id]);
    expect(h.text(wallet)).toContain('Payline');
    await h.click(alice, wallet, 'Back to results');
    expect(h.text(wallet)).toContain('1 recorded round');
    h.db.run("UPDATE round_results SET detail_json = json_remove(detail_json, '$.stops') WHERE round_id = ?", [result.round_id]);
    expect(restarted.slots.lastSpin(h.guildId, alice.id)?.spin.line).toEqual(outcome.spin.line);
    expect(restarted.slots.lastSpin(h.guildId, alice.id)?.spin.rows).toBeNull();
    await restarted.shutdown();
  });

  it('uses net profit, a wager floor, cooldown, and the current privacy preference', () => {
    h = new CasinoHarness();
    const { economy, recorder } = h.app;
    const user = h.user('Alice');
    economy.ensurePlayer(h.guildId, user.id, user.name);
    const round = (id: string, stake: number, returned: number, flags: string[] = []) => {
      economy.reserve({ guildId: h.guildId, userId: user.id, contextId: id, game: 'slots', key: id, amount: stake });
      recorder.record({ guildId: h.guildId, game: 'slots', roundId: id, title: 'Fixture',
        players: [{ userId: user.id, wagered: stake, returned, flags, label: 'win', stats: {}, xp: 0 }] });
    };
    const count = () => h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM highlights WHERE kind = 'big_win'")!.n;
    round('small-stake', 10, 750, ['slots_jackpot']);
    round('low-net', 500, 600);
    expect(count()).toBe(0);
    round('big-win', 500, 1000);
    round('cooldown', 500, 1500);
    expect(count()).toBe(1);
    expect(recentCasinoActivity(h.app, h.guildId, 3).some((text) => text.includes('+500 net'))).toBe(true);
    h.db.run('UPDATE players SET highlights_opt_out = 1 WHERE guild_id = ? AND user_id = ?', [h.guildId, user.id]);
    h.clock.advance(HOUR);
    round('private', 500, 1500);
    expect(count()).toBe(1);
    expect(recentCasinoActivity(h.app, h.guildId, 3)).toEqual([]);
  });
});
