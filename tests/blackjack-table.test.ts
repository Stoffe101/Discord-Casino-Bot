import { describe, expect, it, beforeEach } from 'vitest';
import { NotYourTurnError, StaleActionError, UserError, InsufficientFundsError } from '../src/core/errors.js';
import { currentTurnUserId, availableActions } from '../src/games/blackjack/engine.js';
import type { Card } from '../src/games/cards.js';
import { ALL_IN_DEAL_DELAY_MS, TURN_GRACE_MS } from '../src/tables/blackjack-table-service.js';
import { createHarness, type Harness } from './table-harness.js';
import { GUILD, userId } from './helpers.js';

const u = (n: number) => userId(n);

async function seatPlayers(h: Harness, count: number, offset = 0) {
  const owner = u(offset + 1);
  h.economy.ensurePlayer(GUILD, owner, `Player ${offset + 1}`);
  const table = await h.tables.createTable({ guildId: GUILD, ownerId: owner, ownerName: `Player ${offset + 1}` });
  for (let i = 2; i <= count; i++) {
    const id = u(offset + i);
    h.economy.ensurePlayer(GUILD, id, `Player ${offset + i}`);
    await h.tables.join(table.record.id, id, `Player ${offset + i}`);
  }
  return table.record.id;
}

/** Everyone stands whenever it is their turn until the round is over. */
async function standOut(h: Harness, tableId: string) {
  for (let guard = 0; guard < 50; guard++) {
    const snap = h.tables.peek(tableId)!;
    if (snap.state.phase === 'insurance') {
      for (const seat of snap.state.round!.seats) {
        if (seat.insurance.decision === 'pending') await h.tables.decideInsurance(tableId, seat.userId, false);
      }
      continue;
    }
    if (snap.state.phase !== 'playing') return;
    const who = currentTurnUserId(snap.state.round!)!;
    await h.tables.act(tableId, who, 'stand', snap.state.round!.seq);
  }
  throw new Error('round did not finish');
}

describe('BlackjackTableService', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  describe('tables and seats', () => {
    it('creates numbered tables with the host seated', async () => {
      const t1 = await seatPlayers(h, 1);
      h.economy.ensurePlayer(GUILD, u(9));
      const t2 = await h.tables.createTable({ guildId: GUILD, ownerId: u(9), ownerName: 'Nine' });
      expect(h.tables.peek(t1)!.record.number).toBe(1);
      expect(t2.record.number).toBe(2);
      expect(t2.record.name).toBe('Table 02');
      expect(t2.state.seats.map((s) => s.userId)).toEqual([u(9)]);
    });

    it('enforces the open-table limit', async () => {
      h.settings.set(GUILD, { ...structuredClone(h.settings.get(GUILD) ?? (await import('../src/config/settings.js')).resolveSettings({})) });
      h.settings.get(GUILD)!.tables.maxTables = 1;
      await seatPlayers(h, 1);
      h.economy.ensurePlayer(GUILD, u(9));
      await expect(h.tables.createTable({ guildId: GUILD, ownerId: u(9), ownerName: 'Nine' })).rejects.toThrow(/tables are in use/);
    });

    it('seats five players and refuses a sixth', async () => {
      const t = await seatPlayers(h, 5);
      h.economy.ensurePlayer(GUILD, u(6));
      await expect(h.tables.join(t, u(6), 'Six')).rejects.toThrow(/full/);
      expect(h.tables.peek(t)!.state.seats.map((s) => s.seatIndex)).toEqual([0, 1, 2, 3, 4]);
    });

    it('never lets a player occupy two tables', async () => {
      const t1 = await seatPlayers(h, 2);
      h.economy.ensurePlayer(GUILD, u(9));
      const t2 = await h.tables.createTable({ guildId: GUILD, ownerId: u(9), ownerName: 'Nine' });
      await expect(h.tables.join(t2.record.id, u(2), 'Two')).rejects.toThrow(/seated at/);
      // Concurrent joins to two different tables: exactly one succeeds.
      h.economy.ensurePlayer(GUILD, u(7));
      const results = await Promise.allSettled([h.tables.join(t1, u(7), 'Seven'), h.tables.join(t2.record.id, u(7), 'Seven')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('requires the access code for private tables', async () => {
      h.economy.ensurePlayer(GUILD, u(1));
      h.economy.ensurePlayer(GUILD, u(2));
      const t = await h.tables.createTable({ guildId: GUILD, ownerId: u(1), ownerName: 'One', isPrivate: true });
      expect(t.record.accessCode).toMatch(/^[A-Z2-9]{5}$/);
      await expect(h.tables.join(t.record.id, u(2), 'Two')).rejects.toThrow(/access code/);
      await expect(h.tables.join(t.record.id, u(2), 'Two', 'WRONG')).rejects.toThrow(/access code/);
      await h.tables.join(t.record.id, u(2), 'Two', t.record.accessCode!.toLowerCase());
      expect(h.tables.peek(t.record.id)!.state.seats).toHaveLength(2);
    });

    it('transfers hosting when the host leaves', async () => {
      const t = await seatPlayers(h, 3);
      await h.tables.leave(t, u(1));
      expect(h.tables.peek(t)!.record.ownerId).toBe(u(2));
    });
  });

  describe('betting', () => {
    it('escrows bets immediately and replaces them on change', async () => {
      const t = await seatPlayers(h, 1);
      await h.tables.placeBet(t, u(1), 100);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 900, reserved: 100 });
      await h.tables.placeBet(t, u(1), 250);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 750, reserved: 250 });
      await h.tables.clearBet(t, u(1));
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1000, reserved: 0 });
      expect(h.economy.reconcile()).toEqual([]);
    });

    it('enforces table limits and available funds', async () => {
      const t = await seatPlayers(h, 1);
      await expect(h.tables.placeBet(t, u(1), 5)).rejects.toThrow(/Bets at this table/);
      await expect(h.tables.placeBet(t, u(1), 501)).rejects.toThrow(/Bets at this table/);
      h.economy.adminAdjust({ guildId: GUILD, userId: u(1), amount: -950, reason: 'test setup', actorId: u(9) });
      await expect(h.tables.placeBet(t, u(1), 100)).rejects.toThrow(InsufficientFundsError);
    });

    it('keeps the old bet if a bigger replacement cannot be afforded', async () => {
      const t = await seatPlayers(h, 1);
      await h.tables.placeBet(t, u(1), 400);
      h.economy.adminAdjust({ guildId: GUILD, userId: u(1), amount: -550, reason: 'test setup', actorId: u(9) });
      // Replacing 400 with 500 needs 500 of the 450 the player would have after the swap.
      await expect(h.tables.placeBet(t, u(1), 500)).rejects.toThrow(InsufficientFundsError);
      expect(h.tables.peek(t)!.state.bets[u(1)]).toBe(400);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 50, reserved: 400 });
      // A replacement that the freed chips cover is fine.
      await h.tables.placeBet(t, u(1), 450);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 0, reserved: 450 });
    });

    it('sits out players who keep skipping hands so the rest are not delayed', async () => {
      const t = await seatPlayers(h, 2);
      for (let round = 0; round < 2; round++) {
        await h.tables.placeBet(t, u(1), 20);
        await h.tick(20_000);
        await standOut(h, t);
      }
      expect(h.tables.peek(t)!.state.seats.find((s) => s.userId === u(2))!.sittingOut).toBe(true);
      // Now player 1 alone is "everyone": the deal comes after the short all-in delay.
      await h.tables.placeBet(t, u(1), 20);
      expect(h.tables.peek(t)!.state.deadline).toBe(h.clock.now() + ALL_IN_DEAL_DELAY_MS);
      // Betting brings player 2 straight back in.
      await h.tables.placeBet(t, u(2), 20);
      expect(h.tables.peek(t)!.state.seats.find((s) => s.userId === u(2))!.sittingOut).toBe(false);
    });

    it('starts the betting timer on the first bet and deals early once everyone is in', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.placeBet(t, u(1), 50);
      const first = h.tables.peek(t)!.state.deadline!;
      expect(first).toBe(h.clock.now() + 12_000);
      await h.tables.placeBet(t, u(2), 50);
      expect(h.tables.peek(t)!.state.deadline).toBe(h.clock.now() + ALL_IN_DEAL_DELAY_MS);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      expect(h.tables.peek(t)!.state.phase).not.toBe('betting');
    });

    it('deals to only the players who bet when the timer runs out', async () => {
      const t = await seatPlayers(h, 3);
      await h.tables.placeBet(t, u(2), 50);
      await h.tick(20_000);
      const snap = h.tables.peek(t)!;
      if (snap.state.round) expect(snap.state.round.seats.map((s) => s.userId)).toEqual([u(2)]);
      else expect(snap.state.lastResult!.seats.map((s) => s.userId)).toEqual([u(2)]);
    });

    it('rejects bets while a hand is in progress', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.debugSetShoe(t, ['TS', '9S', '7H', 'TD', '9D', 'TH'] as Card[]);
      await h.tables.placeBet(t, u(1), 50);
      await h.tables.placeBet(t, u(2), 50);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      await expect(h.tables.placeBet(t, u(1), 60)).rejects.toThrow(StaleActionError);
    });
  });

  describe('playing a round', () => {
    it('plays a complete round with correct accounting', async () => {
      const t = await seatPlayers(h, 2);
      // p1: T,9 (19)  p2: 9,9 (18)  dealer: 7 / T (17)
      await h.tables.debugSetShoe(t, ['TS', '9S', '7H', '9C', '9D', 'TH'] as Card[]);
      await h.tables.placeBet(t, u(1), 100);
      await h.tables.placeBet(t, u(2), 40);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      await standOut(h, t);
      const result = h.tables.peek(t)!.state.lastResult!;
      expect(result.dealerTotal).toBe(17);
      expect(result.seats.map((s) => s.net)).toEqual([100, 40]);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 1100 + 100, reserved: 0 }); // +100 First Hand reward
      expect(h.economy.reconcile()).toEqual([]);
      expect(h.tables.peek(t)!.state.phase).toBe('betting');
    });

    it('only lets the active player act and rejects stale double-clicks', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.debugSetShoe(t, ['2S', '9S', '7H', '3C', '9D', 'TH', '4H', '5H'] as Card[]);
      await h.tables.placeBet(t, u(1), 50);
      await h.tables.placeBet(t, u(2), 50);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      const round = h.tables.peek(t)!.state.round!;
      expect(currentTurnUserId(round)).toBe(u(1));
      await expect(h.tables.act(t, u(2), 'hit', round.seq)).rejects.toThrow(NotYourTurnError);
      await expect(h.tables.act(t, u(9), 'hit', round.seq)).rejects.toThrow(NotYourTurnError);
      // Double-click: both presses carry the same sequence number; only one card is drawn.
      const results = await Promise.allSettled([h.tables.act(t, u(1), 'hit', round.seq), h.tables.act(t, u(1), 'hit', round.seq)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(h.tables.peek(t)!.state.round!.seats[0]!.hands[0]!.cards).toHaveLength(3);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(StaleActionError);
    });

    it('reserves extra chips for doubles and splits, and refuses what cannot be afforded', async () => {
      const t = await seatPlayers(h, 1);
      // p1: 8,8 ; dealer 6/T ; split cards 3 and T, then doubles' card
      await h.tables.debugSetShoe(t, ['8S', '6H', '8D', 'TD', '3C', 'TC', '9H'] as Card[]);
      await h.tables.placeBet(t, u(1), 400);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      let snap = h.tables.peek(t)!;
      expect(h.tables.playerOptions(t, u(1))).toMatchObject({ split: true, canAffordSplit: true });
      await h.tables.act(t, u(1), 'split', snap.state.round!.seq);
      expect(h.economy.getPlayer(GUILD, u(1))).toMatchObject({ balance: 200, reserved: 800 });
      snap = h.tables.peek(t)!;
      // Hand 1 is 8+3 = 11: doubling needs another 400 but only 200 is available.
      expect(h.tables.playerOptions(t, u(1))).toMatchObject({ double: true, canAffordDouble: false });
      await expect(h.tables.act(t, u(1), 'double', snap.state.round!.seq)).rejects.toThrow(InsufficientFundsError);
      expect(h.tables.peek(t)!.state.round!.seats[0]!.hands[0]!.cards).toHaveLength(2);
      await standOut(h, t);
      expect(h.economy.reconcile()).toEqual([]);
      expect(h.economy.getPlayer(GUILD, u(1))!.reserved).toBe(0);
    });

    it('auto-stands on timeout and sits out repeat offenders', async () => {
      const t = await seatPlayers(h, 2);
      for (let round = 0; round < 2; round++) {
        // p1: T,5  p2: T,6  dealer: 9 / 8 — nobody has a natural, so p1 must decide.
        await h.tables.debugSetShoe(t, ['TS', 'TH', '9S', '5C', '6D', '8H'] as Card[]);
        await h.tables.placeBet(t, u(1), 20);
        await h.tables.placeBet(t, u(2), 20);
        await h.tick(ALL_IN_DEAL_DELAY_MS);
        // Player 1 never acts; player 2 always stands.
        for (let guard = 0; guard < 10; guard++) {
          const snap = h.tables.peek(t)!;
          if (snap.state.phase === 'betting') break;
          if (snap.state.phase === 'insurance') {
            await h.tick(13_000 + TURN_GRACE_MS);
            continue;
          }
          const who = currentTurnUserId(snap.state.round!);
          if (who === u(2)) await h.tables.act(t, u(2), 'stand', snap.state.round!.seq);
          else await h.tick(30_000 + TURN_GRACE_MS);
        }
      }
      const seat = h.tables.peek(t)!.state.seats.find((s) => s.userId === u(1))!;
      expect(seat.sittingOut).toBe(true);
      expect(h.tables.peek(t)!.state.log.some((l) => l.text.includes('ran out of time'))).toBe(true);
      expect(h.economy.reconcile()).toEqual([]);
    });

    it('lets a player leave mid-round without holding up the table', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.debugSetShoe(t, ['TS', '9S', '7H', '8C', '9D', 'TH'] as Card[]);
      await h.tables.placeBet(t, u(1), 50);
      await h.tables.placeBet(t, u(2), 50);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      expect(await h.tables.leave(t, u(2))).toBe('leaving');
      const snap = h.tables.peek(t)!;
      await h.tables.act(t, u(1), 'stand', snap.state.round!.seq);
      // Player 2 was auto-stood; the round settled and the seat is free.
      const after = h.tables.peek(t)!;
      expect(after.state.phase).toBe('betting');
      expect(after.state.seats.map((s) => s.userId)).toEqual([u(1)]);
      expect(h.db.get('SELECT 1 AS x FROM table_seats WHERE user_id = ?', [u(2)])).toBeUndefined();
      expect(h.economy.getPlayer(GUILD, u(2))!.reserved).toBe(0);
      expect(h.economy.reconcile()).toEqual([]);
    });

    it('removing the player whose turn it is stands their hand at once', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.debugSetShoe(t, ['TS', '9S', '7H', '6C', '9D', 'TH'] as Card[]);
      await h.tables.placeBet(t, u(1), 50);
      await h.tables.placeBet(t, u(2), 50);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      // Make player 2 the host so they can remove player 1, whose turn it is.
      await h.tables.leave(t, u(1)).catch(() => undefined);
      const snap = h.tables.peek(t)!;
      // Player 1 chose to leave mid-turn: their hand stood immediately and play moved on.
      expect(currentTurnUserId(snap.state.round!)).toBe(u(2));
      await h.tables.act(t, u(2), 'stand', snap.state.round!.seq);
      expect(h.tables.peek(t)!.state.seats.map((s) => s.userId)).toEqual([u(2)]);

      // Now a real kick: host (player 2) removes a newcomer during the newcomer's turn.
      h.economy.ensurePlayer(GUILD, u(3), 'Player 3');
      await h.tables.join(t, u(3), 'Player 3');
      await h.tables.debugSetShoe(t, ['TS', '5S', '7H', '9C', '6D', 'TH'] as Card[]);
      await h.tables.placeBet(t, u(2), 20);
      await h.tables.placeBet(t, u(3), 20);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      // The newcomer took the free first seat, so it is their turn.
      expect(currentTurnUserId(h.tables.peek(t)!.state.round!)).toBe(u(3));
      await h.tables.kick(t, u(2), u(3));
      const r = h.tables.peek(t)!.state.round!;
      expect(currentTurnUserId(r)).toBe(u(2)); // no waiting for the removed player's timer
      await h.tables.act(t, u(2), 'stand', r.seq);
      const after = h.tables.peek(t)!;
      expect(after.state.phase).toBe('betting');
      expect(after.state.seats.map((s) => s.userId)).toEqual([u(2)]);
      expect(h.economy.reconcile()).toEqual([]);
    });

    it('refunds an open bet when leaving between rounds', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.placeBet(t, u(2), 75);
      expect(await h.tables.leave(t, u(2))).toBe('left');
      expect(h.economy.getPlayer(GUILD, u(2))).toMatchObject({ balance: 1000, reserved: 0 });
    });

    it('plays many consecutive rounds without rejoining', async () => {
      const t = await seatPlayers(h, 3);
      for (let round = 0; round < 25; round++) {
        for (let i = 1; i <= 3; i++) await h.tables.placeBet(t, u(i), 10 + i);
        await h.tick(ALL_IN_DEAL_DELAY_MS);
        await standOut(h, t);
      }
      expect(h.tables.peek(t)!.state.roundNumber).toBe(25);
      expect(h.stats.get(GUILD, u(1), 'blackjack', 'rounds')).toBe(25);
      expect(h.economy.reconcile()).toEqual([]);
    });

    it('honours insurance decisions with escrowed stakes', async () => {
      const t = await seatPlayers(h, 1);
      // p1 T,9 ; dealer A / K (blackjack)
      await h.tables.debugSetShoe(t, ['TS', 'AH', '9S', 'KD'] as Card[]);
      await h.tables.placeBet(t, u(1), 100);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      expect(h.tables.peek(t)!.state.phase).toBe('insurance');
      await h.tables.decideInsurance(t, u(1), true);
      const result = h.tables.peek(t)!.state.lastResult!;
      expect(result.dealerBlackjack).toBe(true);
      expect(result.seats[0]).toMatchObject({ wagered: 150, returned: 150, net: 0 });
      expect(h.economy.reconcile()).toEqual([]);
    });
  });

  describe('two tables, ten players', () => {
    it('runs two five-player tables concurrently without interference', async () => {
      const t1 = await seatPlayers(h, 5, 0);
      const t2 = await seatPlayers(h, 5, 5);
      const totalBefore = sumChips(h);
      for (let round = 0; round < 10; round++) {
        // All ten players bet at the same time.
        await Promise.all([
          ...[1, 2, 3, 4, 5].map((i) => h.tables.placeBet(t1, u(i), 10 * i)),
          ...[6, 7, 8, 9, 10].map((i) => h.tables.placeBet(t2, u(i), 5 * i)),
        ]);
        await h.tick(ALL_IN_DEAL_DELAY_MS);
        // Interleave actions across both tables, with stray clicks from the wrong players.
        for (let guard = 0; guard < 60; guard++) {
          const moves: Promise<unknown>[] = [];
          for (const t of [t1, t2]) {
            const snap = h.tables.peek(t)!;
            if (snap.state.phase === 'insurance') {
              for (const seat of snap.state.round!.seats) {
                if (seat.insurance.decision === 'pending') moves.push(h.tables.decideInsurance(t, seat.userId, false));
              }
            } else if (snap.state.phase === 'playing') {
              const round = snap.state.round!;
              const who = currentTurnUserId(round)!;
              const legal = availableActions(round, who);
              moves.push(h.tables.act(t, who, legal.hit && round.seq % 3 === 0 ? 'hit' : 'stand', round.seq));
              const other = snap.state.seats.find((s) => s.userId !== who)!;
              moves.push(h.tables.act(t, other.userId, 'hit', round.seq).catch((e: unknown) => e));
            }
          }
          if (moves.length === 0) break;
          await Promise.all(moves);
        }
        expect(h.tables.peek(t1)!.state.phase).toBe('betting');
        expect(h.tables.peek(t2)!.state.phase).toBe('betting');
      }
      // Tables kept their own players and rounds.
      expect(h.tables.peek(t1)!.state.seats.map((s) => s.userId)).toEqual([1, 2, 3, 4, 5].map(u));
      expect(h.tables.peek(t2)!.state.seats.map((s) => s.userId)).toEqual([6, 7, 8, 9, 10].map(u));
      expect(h.tables.peek(t1)!.state.roundNumber).toBe(10);
      expect(h.tables.peek(t2)!.state.roundNumber).toBe(10);
      // Every chip is accounted for: total change == game nets + rewards credited.
      const gameNet = h.db.get<{ n: number }>('SELECT COALESCE(SUM(net), 0) AS n FROM round_results')!.n;
      const rewards = h.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward','mission_reward')")!.n;
      expect(sumChips(h) - totalBefore).toBe(gameNet + rewards);
      expect(h.economy.reconcile()).toEqual([]);
      expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM escrows WHERE status = 'held'")!.n).toBe(0);
    });
  });

  describe('maintenance', () => {
    it('ignores stale timers', async () => {
      const t = await seatPlayers(h, 1);
      await h.tables.placeBet(t, u(1), 50);
      const before = h.tables.peek(t)!.state;
      await h.tables.handleDeadline(t, 12345);
      expect(h.tables.peek(t)!.state.phase).toBe(before.phase);
    });

    it('closes idle tables but never during a round', async () => {
      const t = await seatPlayers(h, 1);
      h.clock.advance(31 * 60_000);
      expect(await h.tables.sweepIdle()).toEqual([t]);
      expect(h.closed).toHaveLength(1);
      expect(h.db.get('SELECT 1 AS x FROM table_seats')).toBeUndefined();

      const t2 = await seatPlayers(h, 1);
      await h.tables.debugSetShoe(t2, ['TS', '9S', '7H', 'TD'] as Card[]);
      await h.tables.placeBet(t2, u(1), 50);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      expect(h.tables.peek(t2)!.state.phase).toBe('playing');
      h.clock.advance(2 * 60 * 60_000);
      expect(await h.tables.sweepIdle()).toEqual([]);
    });

    it('refunds open bets when a table closes and refuses to close mid-round without force', async () => {
      const t = await seatPlayers(h, 2);
      await h.tables.placeBet(t, u(2), 80);
      await h.tables.closeTable(t, 'host closed', { actorId: u(1) });
      expect(h.economy.getPlayer(GUILD, u(2))).toMatchObject({ balance: 1000, reserved: 0 });

      const t2 = await seatPlayers(h, 2, 2);
      await h.tables.debugSetShoe(t2, ['TS', '9S', '7H', 'TD', '9D', 'TH'] as Card[]);
      await h.tables.placeBet(t2, u(3), 80);
      await h.tables.placeBet(t2, u(4), 80);
      await h.tick(ALL_IN_DEAL_DELAY_MS);
      await expect(h.tables.closeTable(t2, 'nope', { actorId: u(3) })).rejects.toThrow(UserError);
      await h.tables.closeTable(t2, 'admin', { force: true });
      expect(h.economy.getPlayer(GUILD, u(3))).toMatchObject({ balance: 1000, reserved: 0 });
      expect(h.economy.reconcile()).toEqual([]);
    });
  });
});

function sumChips(h: Harness): number {
  return h.db.get<{ n: number }>('SELECT SUM(balance + reserved) AS n FROM players')!.n;
}
