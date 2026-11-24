import { describe, expect, it, beforeEach } from 'vitest';
import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng, type Rng } from '../src/core/random.js';
import { StaleActionError, UserError, InsufficientFundsError } from '../src/core/errors.js';
import { resolveSettings, type GuildSettings } from '../src/config/settings.js';
import { EconomyService } from '../src/domain/economy/economy-service.js';
import { StatsService } from '../src/domain/stats-service.js';
import { ProgressService } from '../src/domain/progress-service.js';
import { RoundRecorder } from '../src/domain/round-recorder.js';
import { exactReturnToPlayer, evaluateLine, spinFromStops, REEL_STRIP, WEIGHTS, STOPS } from '../src/games/slots/engine.js';
import { SlotsService } from '../src/games/slots/slots-service.js';
import { betReturn, betWins, pocketColor, WHEEL_ORDER, BET_TYPES, type RouletteBetType } from '../src/games/roulette/engine.js';
import { RouletteService } from '../src/games/roulette/roulette-service.js';
import { CoinflipService } from '../src/games/coinflip/coinflip-service.js';
import { GUILD, userId } from './helpers.js';

const u = (n: number) => userId(n);

function services(options: { db?: Database; clock?: ManualClock; rng?: Rng } = {}) {
  const db = options.db ?? new Database(':memory:');
  db.migrate();
  const clock = options.clock ?? new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const settings = new Map<string, GuildSettings>();
  const provider = (g: string) => settings.get(g) ?? (settings.set(g, resolveSettings({ economy: { startingBalance: 1000 } })), settings.get(g)!);
  const economy = new EconomyService(db, provider, clock);
  const stats = new StatsService(db);
  const progress = new ProgressService(db, economy, stats, provider, clock);
  const recorder = new RoundRecorder(db, economy, stats, progress, clock);
  const deps = { db, economy, recorder, settings: provider, clock, scheduler, logger: silentLogger, rng: options.rng ?? seededRng(11) };
  return {
    db,
    clock,
    scheduler,
    economy,
    stats,
    slots: new SlotsService(deps),
    roulette: new RouletteService(deps),
    coinflip: new CoinflipService(deps),
    settings,
  };
}

describe('slots engine', () => {
  it('uses reel strips that match the documented weights', () => {
    expect(REEL_STRIP).toHaveLength(STOPS);
    for (const [symbol, weight] of Object.entries(WEIGHTS)) {
      expect(REEL_STRIP.filter((s) => s === symbol)).toHaveLength(weight);
    }
  });

  it('has the documented exact return to player', () => {
    const { rtp, returned, outcomes, hitRate } = exactReturnToPlayer();
    expect(outcomes).toBe(32_768);
    expect(returned).toBe(31_630);
    expect(rtp).toBeCloseTo(0.9653, 4);
    expect(hitRate).toBeGreaterThan(0.2);
  });

  it('evaluates paylines', () => {
    expect(evaluateLine(['seven', 'seven', 'seven']).multiplier).toBe(200);
    expect(evaluateLine(['cherry', 'bell', 'cherry']).multiplier).toBe(2);
    expect(evaluateLine(['cherry', 'cherry', 'cherry']).multiplier).toBe(8);
    expect(evaluateLine(['cherry', 'bell', 'lemon']).multiplier).toBe(0);
    const spin = spinFromStops([5, 5, 5]);
    expect(spin.line).toEqual(['seven', 'seven', 'seven']);
    expect(spin.rows[0]).toEqual(['clover', 'clover', 'clover']);
  });
});

describe('SlotsService', () => {
  it('settles each spin atomically and rejects double-clicks', async () => {
    const s = services();
    s.economy.ensurePlayer(GUILD, u(1));
    const first = await s.slots.spin(GUILD, u(1), 25, 0);
    expect(first.spinCount).toBe(1);
    await expect(s.slots.spin(GUILD, u(1), 25, 0)).rejects.toThrow(StaleActionError);
    for (let i = 1; i < 200; i++) await s.slots.spin(GUILD, u(1), 10, i);
    expect(s.stats.get(GUILD, u(1), 'slots', 'rounds')).toBe(200);
    expect(s.economy.reconcile()).toEqual([]);
    expect(s.economy.getPlayer(GUILD, u(1))!.reserved).toBe(0);
  });

  it('enforces limits and funds', async () => {
    const s = services();
    s.economy.ensurePlayer(GUILD, u(1));
    await expect(s.slots.spin(GUILD, u(1), 1, null)).rejects.toThrow(UserError);
    s.economy.adminAdjust({ guildId: GUILD, userId: u(1), amount: -995, reason: 'setup', actorId: u(9) });
    await expect(s.slots.spin(GUILD, u(1), 10, null)).rejects.toThrow(InsufficientFundsError);
    expect(s.economy.getPlayer(GUILD, u(1))!.balance).toBe(5);
  });
});

describe('roulette engine', () => {
  it('has all 37 pockets on the wheel exactly once', () => {
    expect([...WHEEL_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    expect(pocketColor(0)).toBe('green');
    expect(Array.from({ length: 36 }, (_, i) => pocketColor(i + 1)).filter((c) => c === 'red')).toHaveLength(18);
  });

  it('pays correct odds and loses outside bets on zero', () => {
    expect(betReturn({ type: 'red', amount: 10 }, 1)).toBe(20);
    expect(betReturn({ type: 'red', amount: 10 }, 2)).toBe(0);
    expect(betReturn({ type: 'dozen2', amount: 10 }, 13)).toBe(30);
    expect(betReturn({ type: 'column3', amount: 10 }, 36)).toBe(30);
    expect(betReturn({ type: 'straight', number: 17, amount: 10 }, 17)).toBe(360);
    expect(betReturn({ type: 'straight', number: 0, amount: 10 }, 0)).toBe(360);
    for (const t of ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'column1'] as RouletteBetType[]) {
      expect(betWins({ type: t }, 0)).toBe(false);
    }
  });

  it('gives every bet type the same 2.70% house edge', () => {
    for (const info of BET_TYPES) {
      const bet = { type: info.type, number: 7, amount: 1 };
      let returned = 0;
      for (let n = 0; n <= 36; n++) returned += betReturn(bet, n);
      expect(returned / 37).toBeCloseTo(36 / 37, 10);
    }
  });
});

describe('RouletteService', () => {
  let s: ReturnType<typeof services>;
  beforeEach(() => {
    s = services();
    for (const n of [1, 2, 3]) s.economy.ensurePlayer(GUILD, u(n), `P${n}`);
  });

  it('collects bets during the window and settles everyone on the spin', async () => {
    const { wheel } = await s.roulette.open(GUILD);
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'red', amount: 100 });
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'straight', number: 17, amount: 20 });
    await s.roulette.placeBet(wheel.record.id, { userId: u(2), displayName: 'P2', type: 'dozen3', amount: 50 });
    expect(s.economy.getPlayer(GUILD, u(1))!.reserved).toBe(120);
    const deadline = s.roulette.peek(wheel.record.id)!.state.deadline!;
    s.clock.set(deadline);
    s.scheduler.runDue();
    await s.roulette.idle();
    const state = s.roulette.peek(wheel.record.id)!.state;
    expect(state.spinNumber).toBe(1);
    expect(state.bets).toEqual([]);
    const n = state.lastResult!.number;
    const expected1 = betReturn({ type: 'red', amount: 100 }, n) + betReturn({ type: 'straight', number: 17, amount: 20 }, n);
    const p1 = state.lastResult!.players.find((p) => p.userId === u(1))!;
    expect(p1.returned).toBe(expected1);
    expect(s.economy.getPlayer(GUILD, u(1))).toMatchObject({ reserved: 0, balance: 1000 - 120 + expected1 + (p1.achievements.length ? s.db.get<{ n: number }>("SELECT COALESCE(SUM(amount),0) AS n FROM ledger WHERE user_id = ? AND type = 'achievement_reward'", [u(1)])!.n : 0) });
    expect(s.economy.reconcile()).toEqual([]);
  });

  it('merges repeated bets on the same spot and enforces per-spot limits', async () => {
    const { wheel } = await s.roulette.open(GUILD);
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'black', amount: 300 });
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'black', amount: 200 });
    expect(s.roulette.peek(wheel.record.id)!.state.bets).toHaveLength(1);
    await expect(s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'black', amount: 10 })).rejects.toThrow(/more than/);
    await expect(s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'straight', number: 37, amount: 10 })).rejects.toThrow(/0 to 36/);
  });

  it('voids and refunds a spin that fails instead of leaving the wheel stuck', async () => {
    const { wheel } = await s.roulette.open(GUILD);
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'red', amount: 80 });
    const recorder = (s.roulette as unknown as { recorder: { record: (...a: unknown[]) => unknown } }).recorder;
    const original = recorder.record.bind(recorder);
    recorder.record = () => {
      throw new Error('disk full');
    };
    const deadline = s.roulette.peek(wheel.record.id)!.state.deadline!;
    s.clock.set(deadline);
    s.scheduler.runDue();
    await s.roulette.idle();
    recorder.record = original;
    const state = s.roulette.peek(wheel.record.id)!.state;
    expect(state.bets).toEqual([]);
    expect(state.deadline).toBeNull();
    expect(s.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1000, reserved: 0 });
    expect(s.economy.reconcile()).toEqual([]);
  });

  it('refunds withdrawn bets and keeps escrow across a restart', async () => {
    const { wheel } = await s.roulette.open(GUILD);
    await s.roulette.placeBet(wheel.record.id, { userId: u(1), displayName: 'P1', type: 'odd', amount: 40 });
    await s.roulette.placeBet(wheel.record.id, { userId: u(2), displayName: 'P2', type: 'even', amount: 60 });
    expect(await s.roulette.clearBets(wheel.record.id, u(1))).toBe(40);
    const again = services({ db: s.db, clock: s.clock });
    again.roulette.recoverAll();
    const restored = again.roulette.wheelFor(GUILD)!;
    expect(restored.state.bets).toEqual([{ userId: u(2), type: 'even', amount: 60 }]);
    expect(restored.state.deadline).toBeGreaterThan(s.clock.now());
    expect(again.economy.reconcile()).toEqual([]);
  });
});

describe('CoinflipService', () => {
  let s: ReturnType<typeof services>;
  beforeEach(() => {
    s = services();
    for (const n of [1, 2, 3]) s.economy.ensurePlayer(GUILD, u(n));
  });

  it('escrows both stakes and pays the winner the whole pot', async () => {
    const c = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 200, call: 'heads' });
    expect(s.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 800, reserved: 200 });
    const { challenge } = await s.coinflip.accept(c.id, u(2));
    expect(challenge.status).toBe('resolved');
    const winner = challenge.winnerId!;
    const loser = winner === u(1) ? u(2) : u(1);
    const reward = (id: string) =>
      s.db.get<{ n: number }>("SELECT COALESCE(SUM(amount),0) AS n FROM ledger WHERE user_id = ? AND type IN ('achievement_reward','mission_reward')", [id])!.n;
    expect(s.economy.getPlayer(GUILD, winner)!.balance).toBe(1200 + reward(winner));
    expect(s.economy.getPlayer(GUILD, loser)!.balance).toBe(800 + reward(loser));
    expect(s.economy.reconcile()).toEqual([]);
  });

  it('only the opponent can accept, and only once', async () => {
    const c = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 50, call: 'tails' });
    await expect(s.coinflip.accept(c.id, u(3))).rejects.toThrow(/challenged player/);
    await expect(s.coinflip.accept(c.id, u(1))).rejects.toThrow(/challenged player/);
    const results = await Promise.allSettled([s.coinflip.accept(c.id, u(2)), s.coinflip.accept(c.id, u(2))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM round_results')!.n).toBe(2);
  });

  it('refunds on decline, cancel and expiry', async () => {
    const a = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 50, call: 'heads' });
    await s.coinflip.decline(a.id, u(2));
    const b = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(3), amount: 70, call: 'heads' });
    await expect(s.coinflip.cancel(b.id, u(3))).rejects.toThrow(/challenger/);
    await s.coinflip.cancel(b.id, u(1));
    const c = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 90, call: 'tails' });
    s.clock.advance(121_000);
    s.scheduler.runDue();
    await s.coinflip.idle();
    expect(s.coinflip.get(c.id)!.status).toBe('expired');
    await expect(s.coinflip.accept(c.id, u(2))).rejects.toThrow(StaleActionError);
    expect(s.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1000, reserved: 0 });
    expect(s.economy.reconcile()).toEqual([]);
  });

  it('leaves the challenge open if the opponent cannot afford it', async () => {
    const c = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 500, call: 'heads' });
    s.economy.adminAdjust({ guildId: GUILD, userId: u(2), amount: -700, reason: 'setup', actorId: u(9) });
    await expect(s.coinflip.accept(c.id, u(2))).rejects.toThrow(InsufficientFundsError);
    expect(s.coinflip.get(c.id)!.status).toBe('pending');
  });

  it('expires overdue challenges and re-arms the rest after a restart', async () => {
    const overdue = await s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 50, call: 'heads' });
    s.clock.advance(60_000);
    const fresh = await s.coinflip.create({ guildId: GUILD, challengerId: u(3), opponentId: u(2), amount: 50, call: 'heads' });
    s.clock.advance(61_000);
    const again = services({ db: s.db, clock: s.clock });
    const report = again.coinflip.recoverAll();
    expect(report).toMatchObject({ expired: 1, pending: 1 });
    expect(again.coinflip.get(overdue.id)!.status).toBe('expired');
    expect(again.coinflip.get(fresh.id)!.status).toBe('pending');
    expect(again.scheduler.nextAt(`coinflip:${fresh.id}`)).toBe(fresh.expiresAt);
    expect(again.economy.reconcile()).toEqual([]);
  });

  it('rejects self-challenges and out-of-range stakes', async () => {
    await expect(s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(1), amount: 50, call: 'heads' })).rejects.toThrow(/yourself/);
    await expect(s.coinflip.create({ guildId: GUILD, challengerId: u(1), opponentId: u(2), amount: 5, call: 'heads' })).rejects.toThrow(/Duels are/);
  });
});
