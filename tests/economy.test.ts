import { describe, expect, it, beforeEach } from 'vitest';
import { HOUR, MINUTE, DAY } from '../src/core/clock.js';
import { InsufficientFundsError, UserError } from '../src/core/errors.js';
import { createTestEnv, GUILD, OTHER_GUILD, userId, type TestEnv } from './helpers.js';

describe('EconomyService', () => {
  let env: TestEnv;
  const alice = userId(1);
  const bob = userId(2);

  beforeEach(() => {
    env = createTestEnv();
  });

  describe('accounts', () => {
    it('grants the starting balance exactly once', () => {
      const p1 = env.economy.ensurePlayer(GUILD, alice, 'Alice');
      const p2 = env.economy.ensurePlayer(GUILD, alice, 'Alice');
      expect(p1.balance).toBe(1000);
      expect(p2.balance).toBe(1000);
      expect(env.economy.ledgerCount(GUILD, alice)).toBe(1);
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('keeps separate accounts per server', () => {
      env.economy.ensurePlayer(GUILD, alice);
      env.setSettings(OTHER_GUILD, (s) => (s.economy.startingBalance = 50));
      env.economy.ensurePlayer(OTHER_GUILD, alice);
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(1000);
      expect(env.economy.getPlayer(OTHER_GUILD, alice)!.balance).toBe(50);
    });

    it('uses the configured starting balance', () => {
      env.setSettings(GUILD, (s) => (s.economy.startingBalance = 2500));
      expect(env.economy.ensurePlayer(GUILD, alice).balance).toBe(2500);
    });

    it('refreshes the cached display name without changing identity', () => {
      env.economy.ensurePlayer(GUILD, alice, 'Alice');
      env.economy.ensurePlayer(GUILD, alice, 'Alice the Great');
      expect(env.economy.getPlayer(GUILD, alice)!.display_name).toBe('Alice the Great');
    });
  });

  describe('passive earnings', () => {
    it('accrues from timestamps while offline', () => {
      env.economy.ensurePlayer(GUILD, alice);
      env.clock.advance(3 * HOUR);
      expect(env.economy.getWallet(GUILD, alice).passive.available).toBe(150);
      const claim = env.economy.claimPassive(GUILD, alice);
      expect(claim.amount).toBe(150);
      expect(claim.balance).toBe(1150);
    });

    it('caps accrual at the configured number of hours', () => {
      env.economy.ensurePlayer(GUILD, alice);
      env.clock.advance(5 * DAY);
      const w = env.economy.getWallet(GUILD, alice);
      expect(w.passive.available).toBe(50 * 24);
      expect(w.passive.isFull).toBe(true);
      expect(env.economy.claimPassive(GUILD, alice).amount).toBe(1200);
      // After a capped claim the clock restarts from now.
      env.clock.advance(HOUR);
      expect(env.economy.getWallet(GUILD, alice).passive.available).toBe(50);
    });

    it('preserves fractional progress between claims and never over-credits', () => {
      env.economy.ensurePlayer(GUILD, alice);
      let total = 0;
      // 50/hour = one chip every 72 seconds. Claim every 100 seconds for 10 hours.
      for (let i = 0; i < 360; i++) {
        env.clock.advance(100_000);
        total += env.economy.claimPassive(GUILD, alice).amount;
      }
      // 36,000 seconds = 10 hours = 500 chips exactly.
      expect(total).toBe(500);
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('cannot be claimed twice by rapid concurrent presses', async () => {
      env.economy.ensurePlayer(GUILD, alice);
      env.clock.advance(2 * HOUR);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => Promise.resolve().then(() => env.economy.claimPassive(GUILD, alice))),
      );
      expect(results.map((r) => r.amount).reduce((a, b) => a + b, 0)).toBe(100);
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(1100);
    });

    it('reports when the cap will be reached', () => {
      env.economy.ensurePlayer(GUILD, alice);
      const start = env.clock.now();
      env.clock.advance(30 * MINUTE);
      expect(env.economy.getWallet(GUILD, alice).passive.fullAt).toBe(start + 24 * HOUR);
    });

    it('is disabled when the rate is zero', () => {
      env.setSettings(GUILD, (s) => (s.economy.passivePerHour = 0));
      env.economy.ensurePlayer(GUILD, alice);
      env.clock.advance(DAY);
      expect(env.economy.claimPassive(GUILD, alice).amount).toBe(0);
    });
  });

  describe('daily reward', () => {
    it('can be claimed once per UTC day', () => {
      env.economy.ensurePlayer(GUILD, alice);
      expect(env.economy.claimDaily(GUILD, alice).amount).toBe(250);
      expect(() => env.economy.claimDaily(GUILD, alice)).toThrow(UserError);
      env.clock.advance(DAY);
      expect(env.economy.claimDaily(GUILD, alice).amount).toBe(275); // streak day 2
    });

    it('resets at UTC midnight, not 24 hours after the last claim', () => {
      env.clock.set(Date.UTC(2026, 5, 1, 23, 50));
      env.economy.ensurePlayer(GUILD, alice);
      env.economy.claimDaily(GUILD, alice);
      env.clock.set(Date.UTC(2026, 5, 2, 0, 5));
      expect(env.economy.getWallet(GUILD, alice).daily.available).toBe(true);
    });

    it('builds and caps the streak bonus, and resets it after a missed day', () => {
      env.economy.ensurePlayer(GUILD, alice);
      const amounts: number[] = [];
      for (let day = 0; day < 9; day++) {
        amounts.push(env.economy.claimDaily(GUILD, alice).amount);
        env.clock.advance(DAY);
      }
      expect(amounts).toEqual([250, 275, 300, 325, 350, 375, 400, 400, 400]);
      env.clock.advance(DAY); // skipped a day
      const again = env.economy.claimDaily(GUILD, alice);
      expect(again.streak).toBe(1);
      expect(again.amount).toBe(250);
    });

    it('survives concurrent claims with a single payout', async () => {
      env.economy.ensurePlayer(GUILD, alice);
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => Promise.resolve().then(() => env.economy.claimDaily(GUILD, alice))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(1250);
    });
  });

  describe('escrow and settlement', () => {
    beforeEach(() => {
      env.economy.ensurePlayer(GUILD, alice);
      env.economy.ensurePlayer(GUILD, bob);
    });

    it('moves wagered chips from available to reserved', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 300, key: 'r1:bet' });
      const w = env.economy.getWallet(GUILD, alice);
      expect(w.balance).toBe(700);
      expect(w.reserved).toBe(300);
      expect(w.total).toBe(1000);
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('rejects wagers larger than the available balance (reserved chips are not spendable)', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 800, key: 'a' });
      expect(() =>
        env.economy.reserve({ guildId: GUILD, userId: alice, game: 'roulette', contextId: 'w1', amount: 201, key: 'b' }),
      ).toThrow(InsufficientFundsError);
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(200);
    });

    it('prevents double-spending the same chips across games', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 600, key: 'x1' });
      expect(() =>
        env.economy.reserve({ guildId: GUILD, userId: alice, game: 'slots', contextId: 's1', amount: 600, key: 'x2' }),
      ).toThrow(InsufficientFundsError);
    });

    it('is idempotent for replayed reservations', () => {
      const a = env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'same' });
      const b = env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'same' });
      expect(b.id).toBe(a.id);
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(900);
    });

    it('settles a win, push and loss with correct balances', () => {
      for (const [user, ctx] of [
        [alice, 'r1'],
        [bob, 'r1'],
      ] as const) {
        env.economy.reserve({ guildId: GUILD, userId: user, game: 'blackjack', contextId: ctx, amount: 100, key: `${ctx}:bet` });
      }
      env.economy.settle({ guildId: GUILD, userId: alice, contextId: 'r1', game: 'blackjack', payout: 250, outcome: 'win', key: 'r1' });
      env.economy.settle({ guildId: GUILD, userId: bob, contextId: 'r1', game: 'blackjack', payout: 0, outcome: 'loss', key: 'r1' });
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 1150, reserved: 0 });
      expect(env.economy.getPlayer(GUILD, bob)).toMatchObject({ balance: 900, reserved: 0 });
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('settles exactly once even if the settlement is retried', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'bet' });
      for (let i = 0; i < 3; i++) {
        env.economy.settle({ guildId: GUILD, userId: alice, contextId: 'r1', game: 'blackjack', payout: 200, outcome: 'win', key: 'r1' });
      }
      expect(env.economy.getPlayer(GUILD, alice)!.balance).toBe(1100);
    });

    it('includes split and double wagers in the same settlement', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'bet' });
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'split' });
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'double' });
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 700, reserved: 300 });
      const s = env.economy.settle({
        guildId: GUILD,
        userId: alice,
        contextId: 'r1',
        game: 'blackjack',
        payout: 400,
        outcome: 'win',
        key: 'r1',
        expectedStake: 300,
      });
      expect(s.stake).toBe(300);
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 1100, reserved: 0 });
    });

    it('refuses to settle when the escrow does not match the game state', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'bet' });
      expect(() =>
        env.economy.settle({
          guildId: GUILD,
          userId: alice,
          contextId: 'r1',
          game: 'blackjack',
          payout: 0,
          outcome: 'loss',
          key: 'r1',
          expectedStake: 200,
        }),
      ).toThrow(/mismatch/);
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 900, reserved: 100 });
    });

    it('refunds a whole context atomically', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r9', amount: 120, key: 'a' });
      env.economy.reserve({ guildId: GUILD, userId: bob, game: 'blackjack', contextId: 'r9', amount: 80, key: 'b' });
      const refunds = env.economy.refundContext(GUILD, 'r9', 'Round voided');
      expect(refunds).toEqual(
        expect.arrayContaining([
          { userId: alice, amount: 120 },
          { userId: bob, amount: 80 },
        ]),
      );
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 1000, reserved: 0 });
      // Refunding again is a no-op.
      expect(env.economy.refundContext(GUILD, 'r9', 'Round voided')).toEqual([]);
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('cancels a held bet and allows re-betting in the same context', () => {
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'bet:1' });
      expect(env.economy.cancelHeld({ guildId: GUILD, userId: alice, contextId: 'r1', key: 'change:1' })).toBe(100);
      env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 250, key: 'bet:2' });
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 750, reserved: 250 });
      expect(env.economy.reconcile()).toEqual([]);
    });

    it('rolls back everything when a transaction fails midway', () => {
      expect(() =>
        env.db.transaction(() => {
          env.economy.reserve({ guildId: GUILD, userId: alice, game: 'blackjack', contextId: 'r1', amount: 100, key: 'k1' });
          throw new Error('crash in the middle');
        }),
      ).toThrow('crash in the middle');
      expect(env.economy.getPlayer(GUILD, alice)).toMatchObject({ balance: 1000, reserved: 0 });
      expect(env.economy.ledgerCount(GUILD, alice)).toBe(1);
    });
  });

  describe('safety rails', () => {
    beforeEach(() => {
      env.economy.ensurePlayer(GUILD, alice);
    });

    it('rejects non-integer and non-positive amounts', () => {
      for (const amount of [0, -5, 1.5, Number.NaN]) {
        expect(() =>
          env.economy.reserve({ guildId: GUILD, userId: alice, game: 'slots', contextId: 'c', amount, key: `k${amount}` }),
        ).toThrow(UserError);
      }
    });

    it('enforces non-negative balances at the database level', () => {
      expect(() => env.db.run('UPDATE players SET balance = -1 WHERE user_id = ?', [alice])).toThrow(/CHECK/);
    });

    it('keeps the ledger append-only', () => {
      expect(() => env.db.run('UPDATE ledger SET amount = 999999')).toThrow(/append-only/);
      expect(() => env.db.run('DELETE FROM ledger')).toThrow(/append-only/);
    });

    it('requires a reason for admin adjustments and records the actor', () => {
      expect(() => env.economy.adminAdjust({ guildId: GUILD, userId: alice, amount: 50, reason: '', actorId: bob })).toThrow(
        /reason/,
      );
      const row = env.economy.adminAdjust({ guildId: GUILD, userId: alice, amount: 50, reason: 'Tournament prize', actorId: bob });
      expect(row).toMatchObject({ type: 'admin_adjust', amount: 50, actor_id: bob, memo: 'Tournament prize' });
      expect(() =>
        env.economy.adminAdjust({ guildId: GUILD, userId: alice, amount: -5000, reason: 'oops', actorId: bob }),
      ).toThrow(/negative/);
    });

    it('detects tampering during reconciliation', () => {
      env.db.run('UPDATE players SET balance = balance + 10 WHERE user_id = ?', [alice]);
      expect(env.economy.reconcile(GUILD).length).toBeGreaterThan(0);
    });

    it('credits rewards idempotently', () => {
      const first = env.economy.credit({ guildId: GUILD, userId: alice, amount: 100, type: 'mission_reward', key: 'm:1', memo: 'x' });
      const second = env.economy.credit({ guildId: GUILD, userId: alice, amount: 100, type: 'mission_reward', key: 'm:1', memo: 'x' });
      expect([first, second]).toEqual([100, 0]);
    });

    it('tracks the highest total balance reached', () => {
      env.economy.adminAdjust({ guildId: GUILD, userId: alice, amount: 500, reason: 'bonus', actorId: bob });
      env.economy.adminAdjust({ guildId: GUILD, userId: alice, amount: -800, reason: 'correction', actorId: bob });
      expect(env.economy.getPlayer(GUILD, alice)!.highest_balance).toBe(1500);
    });
  });
});
