import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { currentTurnUserId } from '../src/games/blackjack/engine.js';
import type { Card } from '../src/games/cards.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import { createHarness, type Harness } from './table-harness.js';
import { GUILD, userId } from './helpers.js';
import type { GuildSettings } from '../src/config/settings.js';

const u = (n: number) => userId(n);

/**
 * "Crash" = a second process opens the same database file while the first one simply stops
 * (no graceful shutdown, timers lost). Everything the first process committed must be enough
 * for the second to continue or refund deterministically.
 */
describe('restart recovery', () => {
  let dir: string;
  let path: string;
  let clock: ManualClock;
  let settings: Map<string, GuildSettings>;
  let first: Harness;
  const open: Database[] = [];

  function boot(): Harness {
    const db = new Database(path);
    open.push(db);
    const h = createHarness({ db, clock, settings, seed: 99 });
    h.tables.recoverAll();
    return h;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'casino-recovery-'));
    path = join(dir, 'casino.db');
    clock = new ManualClock();
    settings = new Map();
    const db = new Database(path);
    open.push(db);
    first = createHarness({ db, clock, settings, seed: 5 });
    for (const n of [1, 2]) first.economy.ensurePlayer(GUILD, u(n), `P${n}`);
  });

  afterEach(() => {
    for (const db of open.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function twoPlayerTable(h: Harness): Promise<string> {
    const t = await h.tables.createTable({ guildId: GUILD, ownerId: u(1), ownerName: 'P1' });
    await h.tables.join(t.record.id, u(2), 'P2');
    return t.record.id;
  }

  it('keeps escrowed bets through a crash during betting and deals after restart', async () => {
    const t = await twoPlayerTable(first);
    await first.tables.placeBet(t, u(1), 120);
    clock.advance(5_000);
    const second = boot();
    const snap = second.tables.peek(t)!;
    expect(snap.state.phase).toBe('betting');
    expect(snap.state.bets[u(1)]).toBe(120);
    expect(second.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 880, reserved: 120 });
    // A fresh betting window was armed; when it passes the hand is dealt.
    await second.tick(20_000);
    expect(second.tables.peek(t)!.state.roundNumber).toBe(1);
    expect(second.economy.reconcile()).toEqual([]);
  });

  it('resumes a hand mid-play with the exact same cards', async () => {
    const t = await twoPlayerTable(first);
    await first.tables.debugSetShoe(t, ['TS', '9S', '7H', '6C', '9D', 'TH', '5D', '3C'] as Card[]);
    await first.tables.placeBet(t, u(1), 100);
    await first.tables.placeBet(t, u(2), 50);
    await first.tick(ALL_IN_DEAL_DELAY_MS);
    const before = first.tables.peek(t)!.state.round!;
    expect(currentTurnUserId(before)).toBe(u(1));
    await first.tables.act(t, u(1), 'hit', before.seq); // T+6+5 = 21 → auto-stand, turn passes to P2
    const mid = structuredClone(first.tables.peek(t)!.state.round!);

    const second = boot();
    const resumed = second.tables.peek(t)!.state.round!;
    expect(resumed.seats).toEqual(mid.seats);
    expect(resumed.dealer).toEqual(mid.dealer);
    expect(resumed.shoe).toEqual(mid.shoe);
    expect(currentTurnUserId(resumed)).toBe(u(2));
    // The turn timer was re-armed with a fresh deadline.
    expect(second.tables.peek(t)!.state.deadline).toBeGreaterThan(clock.now());
    await second.tables.act(t, u(2), 'stand', resumed.seq);
    const result = second.tables.peek(t)!.state.lastResult!;
    expect(result.dealerCards).toEqual(['7H', 'TH']);
    expect(result.seats.map((s) => s.net)).toEqual([100, 50]);
    expect(second.economy.reconcile()).toEqual([]);
  });

  it('a crash before the settling action commits replays nothing: the last decision is simply re-made', async () => {
    const t = await twoPlayerTable(first);
    await first.tables.debugSetShoe(t, ['TS', '9S', '7H', '8C', '9D', 'TH'] as Card[]);
    await first.tables.placeBet(t, u(1), 100);
    await first.tables.placeBet(t, u(2), 100);
    await first.tick(ALL_IN_DEAL_DELAY_MS);
    const round = first.tables.peek(t)!.state.round!;
    await first.tables.act(t, u(1), 'stand', round.seq);
    // P2's stand (which would settle the round) never commits: the process dies first.
    const second = boot();
    expect(second.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game_rounds')!.n).toBe(0);
    expect(second.economy.getPlayer(GUILD, u(2))!.reserved).toBe(100);
    const resumed = second.tables.peek(t)!.state.round!;
    await second.tables.act(t, u(2), 'stand', resumed.seq);
    expect(second.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game_rounds')!.n).toBe(1);
    expect(second.economy.reconcile()).toEqual([]);
    expect(second.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM escrows WHERE status = 'held'")!.n).toBe(0);
  });

  it('never settles a round twice, even if state and records disagree after a crash', async () => {
    const t = await twoPlayerTable(first);
    await first.tables.debugSetShoe(t, ['TS', '9S', '7H', '8C', '9D', 'TH'] as Card[]);
    await first.tables.placeBet(t, u(1), 100);
    await first.tables.placeBet(t, u(2), 100);
    await first.tick(ALL_IN_DEAL_DELAY_MS);
    const roundId = first.tables.peek(t)!.state.roundId;
    // Simulate a foreign settlement of this round id (e.g. a manual repair).
    first.recorder.voidRound(GUILD, roundId, 'blackjack', t, 'test');
    const balances = [u(1), u(2)].map((id) => first.economy.getPlayer(GUILD, id)!.balance);
    const second = boot();
    const snap = second.tables.peek(t)!;
    expect(snap.state.phase).toBe('betting');
    expect(snap.state.round).toBeNull();
    expect(snap.state.roundId).not.toBe(roundId);
    expect([u(1), u(2)].map((id) => second.economy.getPlayer(GUILD, id)!.balance)).toEqual(balances);
    expect(second.economy.reconcile()).toEqual([]);
  });

  it('voids the round and refunds everyone when the saved state is unreadable', async () => {
    const t = await twoPlayerTable(first);
    await first.tables.placeBet(t, u(1), 100);
    await first.tables.placeBet(t, u(2), 60);
    await first.tick(ALL_IN_DEAL_DELAY_MS);
    // Corrupt the persisted round (e.g. a bad manual edit or disk issue).
    first.db.run("UPDATE game_tables SET state_json = replace(state_json, '\"phase\":\"playing\"', '\"phase\":\"warp\"') WHERE id = ?", [t]);
    first.db.run("UPDATE game_tables SET state_json = replace(state_json, '\"phase\":\"insurance\"', '\"phase\":\"warp\"') WHERE id = ?", [t]);
    const second = boot();
    const snap = second.tables.peek(t)!;
    expect(snap.state.phase).toBe('betting');
    expect(snap.state.seats.map((s) => s.userId)).toEqual([u(1), u(2)]);
    expect(second.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1000, reserved: 0 });
    expect(second.economy.getPlayer(GUILD, u(2))).toMatchObject({ balance: 1000, reserved: 0 });
    expect(second.economy.reconcile()).toEqual([]);
  });

  it('refunds orphaned wagers that no table references', async () => {
    first.economy.reserve({ guildId: GUILD, userId: u(1), game: 'blackjack', contextId: 'lost-round', amount: 70, key: 'x' });
    const second = boot();
    expect(second.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1000, reserved: 0 });
    expect(second.economy.reconcile()).toEqual([]);
  });

  it('survives repeated crash/restart cycles across many rounds with consistent books', async () => {
    let h = first;
    const t = await twoPlayerTable(h);
    for (let round = 0; round < 12; round++) {
      await h.tables.placeBet(t, u(1), 25);
      await h.tables.placeBet(t, u(2), 35);
      if (round % 3 === 0) h = boot(); // crash during betting
      await h.tick(ALL_IN_DEAL_DELAY_MS + 20_000);
      for (let guard = 0; guard < 20; guard++) {
        const snap = h.tables.peek(t)!;
        if (snap.state.phase === 'betting') break;
        if (snap.state.phase === 'insurance') {
          for (const s of snap.state.round!.seats) if (s.insurance.decision === 'pending') await h.tables.decideInsurance(t, s.userId, false);
          continue;
        }
        if (guard === 0 && round % 3 === 1) h = boot(); // crash mid-hand
        const r = h.tables.peek(t)!.state.round!;
        if (h.tables.peek(t)!.state.phase !== 'playing') continue;
        await h.tables.act(t, currentTurnUserId(r)!, 'stand', r.seq);
      }
    }
    expect(h.tables.peek(t)!.state.roundNumber).toBe(12);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE status = 'settled'")!.n).toBe(12);
    expect(h.economy.reconcile()).toEqual([]);
  });
});
