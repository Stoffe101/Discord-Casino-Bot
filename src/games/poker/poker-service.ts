import type { Database } from '../../db/database.js';
import type { Clock } from '../../core/clock.js';
import { StaleActionError, UserError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { newId, shortCode, type Rng } from '../../core/random.js';
import type { Scheduler } from '../../core/scheduler.js';
import { KeyedSerialQueue } from '../../core/serial-queue.js';
import type { IdleExemption } from '../../tables/blackjack-table-service.js';
import type { EconomyService, SettingsProvider } from '../../domain/economy/economy-service.js';
import type { RoundRecorder } from '../../domain/round-recorder.js';
import { isCard } from '../cards.js';
import { dealPoker, nextDealer, playPoker, pokerActions, publicPokerHand, type PokerAction, type PokerHand, type PokerSeat } from './engine.js';

export interface PokerConfig {
  maxSeats: number;
  minBuyIn: number;
  maxBuyIn: number;
  smallBlind: number;
  bigBlind: number;
  turnSeconds: number;
}

export interface PokerTableRecord {
  id: string;
  guildId: string;
  number: number;
  name: string;
  ownerId: string;
  isPrivate: boolean;
  accessCode: string | null;
  config: PokerConfig;
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
  version: number;
  lastActivityAt: number;
}

export interface PokerTableSeat extends PokerSeat {
  name: string;
  sittingOut: boolean;
  leaving: boolean;
}

export interface PokerTableState {
  seats: PokerTableSeat[];
  hand: PokerHand | null;
  handId: string | null;
  number: number;
  dealer: number;
  lastBigBlind: number | null;
  deadline: number | null;
  result: ReturnType<typeof publicPokerHand> | null;
}

export interface PokerSnapshot {
  record: PokerTableRecord;
  state: PokerTableState;
}

interface TableRow {
  id: string; guild_id: string; number: number; name: string; owner_id: string; is_private: number;
  access_code: string | null; config_json: string; state_json: string; channel_id: string | null;
  thread_id: string | null; message_id: string | null; version: number; last_activity_at: number;
}

type Location = Pick<PokerTableRecord, 'channelId' | 'threadId' | 'messageId'>;
export type PokerRenderHint = 'update' | 'dealt' | 'board' | 'settled';

interface Observer {
  changed(id: string, hint: PokerRenderHint, origin?: object): void;
  closed(snapshot: PokerSnapshot, reason: string): void;
}

export class PokerTableService {
  private readonly tables = new Map<string, PokerSnapshot>();
  private readonly queue = new KeyedSerialQueue();
  private observer: Observer = { changed: () => undefined, closed: () => undefined };

  constructor(private readonly deps: {
    db: Database; economy: EconomyService; recorder: RoundRecorder; settings: SettingsProvider;
    clock: Clock; scheduler: Scheduler; logger: Logger; rng: Rng;
    /** Keeps an otherwise idle table open (e.g. assigned to a due casino event); always bounded. */
    idleExempt?: IdleExemption;
  }) {}

  setObserver(observer: Observer): void { this.observer = observer; }

  idle(): Promise<void> { return this.queue.drain(); }

  peek(id: string): PokerSnapshot | undefined { return this.tables.get(id); }

  openTables(guildId?: string): PokerSnapshot[] {
    return [...this.tables.values()].filter(({ record }) => guildId === undefined || record.guildId === guildId);
  }

  tableOfUser(guildId: string, userId: string): PokerSnapshot | undefined {
    return this.openTables(guildId).find(({ state }) => state.seats.some((seat) => seat.userId === userId));
  }

  create(input: { guildId: string; userId: string; name: string; tableName?: string; private?: boolean; seats?: number; buyIn: number }): Promise<PokerSnapshot> {
    return this.queue.run('create:' + input.guildId, () => {
      const { guildId, userId } = input;
      const { db, clock, settings } = this.deps;
      const guild = settings(guildId);
      if (!guild.enabled || !guild.poker.enabled) throw new UserError('Hold’em is closed on this server.');
      const maxSeats = input.seats ?? guild.poker.maxSeats;
      if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > guild.poker.maxSeats) throw new UserError('Choose a supported seat count.');
      const config: PokerConfig = {
        maxSeats, minBuyIn: guild.poker.minBuyIn, maxBuyIn: guild.poker.maxBuyIn,
        smallBlind: guild.poker.smallBlind, bigBlind: guild.poker.bigBlind, turnSeconds: guild.poker.turnSeconds,
      };
      const now = clock.now();
      const snapshot = db.transaction(() => {
        const rows = db.all<{ number: number; game: string }>("SELECT number, game FROM game_tables WHERE guild_id = ? AND status = 'open'", [guildId]);
        if (rows.length >= guild.tables.maxTables) throw new UserError('The casino has reached its open table limit.');
        let number = 1;
        const used = new Set(rows.filter((row) => row.game === 'poker').map((row) => row.number));
        while (used.has(number)) number++;
        const record: PokerTableRecord = {
          id: newId(), guildId, number, name: input.tableName?.trim().slice(0, 32) || 'Hold’em ' + String(number).padStart(2, '0'),
          ownerId: userId, isPrivate: input.private === true, accessCode: input.private ? shortCode() : null,
          config, channelId: null, threadId: null, messageId: null, version: 0, lastActivityAt: now,
        };
        db.run(`INSERT INTO game_tables (id, guild_id, game, number, name, owner_id, is_private, access_code, config_json, status, state_json, created_at, last_activity_at)
                 VALUES (?, ?, 'poker', ?, ?, ?, ?, ?, ?, 'open', '{}', ?, ?)`,
        [record.id, guildId, number, record.name, userId, record.isPrivate, record.accessCode, JSON.stringify(config), now, now]);
        const state: PokerTableState = { seats: [], hand: null, handId: null, number: 0, dealer: -1, lastBigBlind: null, deadline: null, result: null };
        this.addSeat(record, state, userId, input.name, input.buyIn, now);
        db.run('UPDATE game_tables SET state_json = ? WHERE id = ?', [JSON.stringify(state), record.id]);
        return { record, state };
      });
      this.tables.set(snapshot.record.id, snapshot);
      return snapshot;
    });
  }

  attach(id: string, location: Location): Promise<void> {
    return this.queue.run(id, () => {
      const snapshot = this.tables.get(id);
      if (!snapshot) throw new StaleActionError('This poker table has closed.');
      const { channelId, threadId, messageId } = location;
      this.deps.db.run('UPDATE game_tables SET channel_id = ?, thread_id = ?, message_id = ? WHERE id = ?', [channelId, threadId, messageId, id]);
      snapshot.record = { ...snapshot.record, ...location };
    });
  }

  join(id: string, userId: string, name: string, buyIn: number, code?: string): Promise<void> {
    return this.mutate(id, undefined, (record, state, now) => {
      if (record.isPrivate && record.accessCode !== code?.trim().toUpperCase()) throw new UserError('That table access code did not match.');
      this.addSeat(record, state, userId, name, buyIn, now);
      return 'update';
    });
  }

  private addSeat(record: PokerTableRecord, state: PokerTableState, userId: string, name: string, amount: number, now: number): void {
    const { db, economy, settings } = this.deps;
    const { guildId, id, config } = record;
    if (!settings(guildId).enabled || !settings(guildId).poker.enabled) throw new UserError('Hold’em is closed on this server.');
    if (db.get('SELECT table_id FROM table_seats WHERE guild_id = ? AND user_id = ?', [guildId, userId])) {
      throw new UserError('You already have a casino seat. Leave that table before joining another.', 'already_seated');
    }
    if (!Number.isSafeInteger(amount) || amount < config.minBuyIn || amount > config.maxBuyIn) throw new UserError('Choose a buy-in inside the table limits.');
    const taken = new Set(state.seats.map((seat) => seat.seat));
    const seat = Array.from({ length: config.maxSeats }, (_, i) => i).find((index) => !taken.has(index));
    if (seat === undefined) throw new UserError('All seats are taken.');
    economy.ensurePlayer(guildId, userId, name);
    economy.reserve({ guildId, userId, game: 'poker', contextId: id, amount, key: 'buy-in:' + newId(), memo: 'Hold’em buy-in' });
    db.run('INSERT INTO table_seats (table_id, guild_id, user_id, seat_index, joined_at) VALUES (?, ?, ?, ?, ?)', [id, guildId, userId, seat, now]);
    if (!state.seats.length) record.ownerId = userId;
    state.seats.push({ userId, seat, name, stack: amount, sittingOut: false, leaving: false });
  }

  leave(id: string, userId: string): Promise<void> {
    return this.mutate(id, undefined, (record, state, now) => {
      const seat = this.requireSeat(state, userId);
      if (state.hand?.seats.some((player) => player.seat === seat.seat)) {
        seat.leaving = true;
        // Leaving on your own turn acts for you at once (check if possible, otherwise fold) instead
        // of making everyone wait for the turn timer.
        return state.hand.actor === seat.seat ? this.advance(record, state, now, 'update') : 'update';
      }
      this.cashOut(record, state, seat);
      return 'update';
    });
  }

  sitOut(id: string, userId: string, value: boolean): Promise<void> {
    return this.mutate(id, undefined, (_record, state) => {
      const seat = this.requireSeat(state, userId);
      if (seat.leaving) throw new UserError('You’re cashing out after this hand.');
      if (seat.sittingOut === value) return null;
      seat.sittingOut = value;
      return 'update';
    });
  }

  start(id: string, userId: string, version: number, origin?: object): Promise<void> {
    return this.mutate(id, origin, (record, state, now) => {
      this.requireHost(record, userId);
      const guild = this.deps.settings(record.guildId);
      if (!guild.enabled || !guild.poker.enabled) throw new UserError('Hold’em is closed on this server.');
      if (record.version !== version || state.hand) throw new StaleActionError('Refresh the poker table before starting a hand.');
      const ready = state.seats.filter((seat) => !seat.sittingOut && !seat.leaving && seat.stack > 0);
      if (ready.length < 2) throw new UserError('Two funded players need to be ready.');
      const { config } = record;
      state.dealer = nextDealer(ready, state.dealer, state.lastBigBlind ?? undefined);
      state.hand = dealPoker(ready.map(({ userId, seat, stack }) => ({ userId, seat, stack })), state.dealer, config.smallBlind, config.bigBlind, this.deps.rng);
      state.lastBigBlind = state.hand.bigBlindSeat;
      state.handId = newId().replaceAll('-', '');
      state.number++;
      state.result = null;
      return this.advance(record, state, now, 'dealt');
    });
  }

  act(id: string, userId: string, handId: string, seq: number, action: PokerAction, origin?: object): Promise<void> {
    return this.mutate(id, origin, (record, state, now) => {
      const hand = state.hand;
      if (!hand || handId !== state.handId || state.deadline !== null && now >= state.deadline) throw new StaleActionError('Refresh your poker hand.');
      if (this.requireSeat(state, userId).leaving) throw new UserError('You’re cashing out after this hand.');
      state.hand = playPoker(hand, userId, seq, action);
      return this.advance(record, state, now, hand.street === state.hand.street ? 'update' : 'board');
    });
  }

  private advance(record: PokerTableRecord, state: PokerTableState, now: number, hint: PokerRenderHint): PokerRenderHint {
    let hand = state.hand!;
    // Players cashing out after this hand are blocked from acting: check if possible, otherwise fold, at once.
    while (!hand.result) {
      const actor = hand.seats.find((player) => player.seat === hand.actor)!;
      if (!this.requireSeat(state, actor.userId).leaving) break;
      const street = hand.street;
      hand = playPoker(hand, actor.userId, hand.seq, { type: pokerActions(hand, actor.userId)!.check ? 'check' : 'fold' });
      if (hand.street !== street && hint === 'update') hint = 'board';
    }
    state.hand = hand;
    if (!hand.result) {
      state.deadline = now + record.config.turnSeconds * 1000;
      return hint;
    }
    const result = publicPokerHand(hand);
    const stacks = hand.seats.map((player) => ({
      userId: player.userId, before: this.requireSeat(state, player.userId).stack, after: player.stack,
    }));
    const settled = this.deps.recorder.recordPoker({
      guildId: record.guildId, tableId: record.id, roundId: state.handId!, game: 'poker',
      title: record.name + ' · hand ' + state.number, summary: { board: result.board, pots: result.result!.pots.map((pot) => pot.amount) },
      players: hand.seats.map((player) => {
        const returned = hand.result!.payouts.find((entry) => entry.seat === player.seat)?.amount ?? 0;
        return {
          userId: player.userId, wagered: player.committed, returned, xp: 3,
          stats: { hands: 1, showdowns: !player.folded && hand.result!.showdown ? 1 : 0 },
          flags: [], label: returned > player.committed ? 'win' : returned < player.committed ? 'lose' : 'push',
          detail: { board: result.board, pots: result.result!.pots.map((pot) => pot.amount) },
        };
      }),
    }, stacks);
    if (settled.duplicate) throw new Error('A pending poker hand was already settled.');
    for (const player of stacks) this.requireSeat(state, player.userId).stack = player.after;
    state.result = result;
    state.hand = null;
    state.handId = null;
    state.deadline = null;
    for (const seat of [...state.seats]) if (seat.leaving || seat.stack === 0) this.cashOut(record, state, seat);
    return 'settled';
  }

  private requireSeat(state: PokerTableState, userId: string): PokerTableSeat {
    const seat = state.seats.find((player) => player.userId === userId);
    if (!seat) throw new UserError('Take a seat before using your poker controls.');
    return seat;
  }

  private requireHost(record: PokerTableRecord, userId: string): void {
    if (record.ownerId !== userId) throw new UserError('Only the host can use this control.');
  }

  private cashOut(record: PokerTableRecord, state: PokerTableState, seat: PokerTableSeat): void {
    const amount = this.deps.economy.cancelHeld({
      guildId: record.guildId, userId: seat.userId, contextId: record.id, key: 'cash-out:' + newId(), memo: 'Hold’em cash-out',
    });
    if (amount !== seat.stack) throw new Error('Poker cash-out did not match the reserved stack.');
    this.deps.db.run('DELETE FROM table_seats WHERE table_id = ? AND user_id = ?', [record.id, seat.userId]);
    state.seats = state.seats.filter((player) => player !== seat);
    if (record.ownerId === seat.userId && state.seats.length) record.ownerId = state.seats[0]!.userId;
  }

  close(id: string, reason: string, userId?: string): Promise<void> {
    return this.queue.run(id, () => {
      const table = this.tables.get(id);
      if (!table) return;
      if (userId !== undefined) {
        this.requireHost(table.record, userId);
        if (table.state.hand) throw new UserError('Wait for the active hand to finish before closing the table.');
      }
      this.deps.db.transaction(() => this.refundAndClose(table.record.guildId, id, reason));
      this.tables.delete(id);
      this.deps.scheduler.clear('poker:' + id);
      this.observer.closed(table, reason);
    });
  }

  private refundAndClose(guildId: string, id: string, reason: string): void {
    const { economy, db, clock } = this.deps;
    economy.refundContext(guildId, id, 'Hold’em · ' + reason);
    db.run('DELETE FROM table_seats WHERE table_id = ?', [id]);
    db.run("UPDATE game_tables SET status = 'closed', closed_at = ?, state_json = '{}' WHERE id = ?", [clock.now(), id]);
  }

  private isIdle(table: PokerSnapshot, now: number): boolean {
    if (table.state.hand) return false;
    const { idleMinutes, idleEmptyMinutes } = this.deps.settings(table.record.guildId).tables;
    const limit = table.state.seats.length ? idleMinutes : idleEmptyMinutes;
    if (now - table.record.lastActivityAt < limit * 60_000) return false;
    return !this.deps.idleExempt?.(table.record.id, table.record.guildId, now);
  }

  async sweepIdle(): Promise<void> {
    const now = this.deps.clock.now();
    for (const table of this.openTables()) {
      if (!this.isIdle(table, now)) continue;
      const { id } = table.record;
      await this.queue.run(id, () => {
        const current = this.tables.get(id);
        if (!current || !this.isIdle(current, now)) return;
        const reason = 'closed after inactivity';
        this.deps.db.transaction(() => this.refundAndClose(current.record.guildId, id, reason));
        this.tables.delete(id);
        this.deps.scheduler.clear('poker:' + id);
        this.observer.closed(current, reason);
      }).catch(() => this.deps.logger.warn('Poker idle close failed', { tableId: id }));
    }
  }

  recover(): { restored: number; refunded: number } {
    const { db, economy } = this.deps;
    let refunded = 0;
    for (const row of db.all<TableRow>("SELECT * FROM game_tables WHERE status = 'open' AND game = 'poker'")) {
      try {
        const state = JSON.parse(row.state_json) as PokerTableState;
        const config = JSON.parse(row.config_json) as PokerConfig;
        this.validateRestored(row, state, config);
        const record: PokerTableRecord = {
          id: row.id, guildId: row.guild_id, number: row.number, name: row.name, ownerId: row.owner_id,
          isPrivate: row.is_private !== 0, accessCode: row.access_code, config,
          channelId: row.channel_id, threadId: row.thread_id, messageId: row.message_id, version: row.version, lastActivityAt: row.last_activity_at,
        };
        const snapshot = { record, state };
        this.tables.set(row.id, snapshot);
        this.arm(snapshot);
      } catch {
        this.deps.logger.warn('Poker snapshot could not be restored; refunding original table stacks', { tableId: row.id });
        db.transaction(() => this.refundAndClose(row.guild_id, row.id, 'voided during recovery'));
        refunded++;
      }
    }
    for (const escrow of economy.allHeldEscrows()) if (escrow.game === 'poker' && !this.tables.has(escrow.context_id)) {
      economy.refundContext(escrow.guild_id, escrow.context_id, 'Orphaned poker stack');
    }
    return { restored: this.tables.size, refunded };
  }

  private validateRestored(row: TableRow, state: PokerTableState, config: PokerConfig): void {
    const safe = (amount: number) => Number.isSafeInteger(amount) && amount >= 0;
    const indexed = this.deps.db.all<{ user_id: string; seat_index: number }>('SELECT user_id, seat_index FROM table_seats WHERE table_id = ? AND guild_id = ?', [row.id, row.guild_id]);
    const escrows = this.deps.economy.heldInContext(row.guild_id, row.id);
    if (!safe(config.maxSeats) || config.maxSeats < 2 || config.maxSeats > 7 || !safe(config.bigBlind) || config.bigBlind <= config.smallBlind
      || !safe(state.number) || !Array.isArray(state.seats) || state.seats.length !== indexed.length
      || indexed.some((entry) => !state.seats.some((seat) => seat.userId === entry.user_id && seat.seat === entry.seat_index))
      || state.seats.some((seat) => !safe(seat.seat) || seat.seat >= config.maxSeats || !safe(seat.stack)
        || escrows.filter((escrow) => escrow.user_id === seat.userId).reduce((sum, entry) => sum + entry.amount, 0) !== seat.stack)
      || escrows.some((escrow) => escrow.game !== 'poker' || !state.seats.some((seat) => seat.userId === escrow.user_id))) {
      throw new Error('Invalid poker stacks or seats.');
    }
    const hand = state.hand;
    if (!hand) return;
    if (!state.handId || this.deps.recorder.isRecorded(state.handId) || state.deadline === null || !safe(state.deadline)
      || !Array.isArray(hand.deck) || hand.deck.length !== 52 || !hand.deck.every(isCard) || new Set(hand.deck).size !== 52
      || !Array.isArray(hand.board) || !hand.board.every(isCard) || !safe(hand.seq) || !safe(hand.cursor) || hand.cursor > hand.deck.length
      || !hand.seats.some((player) => player.seat === hand.actor && !player.folded && player.stack > 0)
      || hand.seats.some((player) => !safe(player.committed) || !safe(player.stack) || !safe(player.streetPaid)
        || player.streetPaid > player.committed || !Array.isArray(player.cards) || player.cards.length !== 2 || !player.cards.every(isCard)
        || !state.seats.some((seat) => seat.userId === player.userId && seat.seat === player.seat && seat.stack === player.committed + player.stack))) {
      throw new Error('Invalid active poker hand.');
    }
  }

  private mutate(
    id: string,
    origin: object | undefined,
    fn: (record: PokerTableRecord, state: PokerTableState, now: number) => PokerRenderHint | null,
  ): Promise<void> {
    return this.queue.run(id, () => {
      const current = this.tables.get(id);
      if (!current) throw new StaleActionError('This poker table has closed.');
      const { db, clock } = this.deps;
      const record = { ...current.record };
      const state = structuredClone(current.state);
      const now = clock.now();
      const hint = db.transaction(() => {
        const changed = fn(record, state, now);
        if (!changed) return null;
        const written = db.run('UPDATE game_tables SET state_json = ?, owner_id = ?, version = version + 1, last_activity_at = ? WHERE id = ? AND version = ?',
          [JSON.stringify(state), record.ownerId, now, id, record.version]);
        if (written.changes !== 1) throw new Error('Concurrent poker table update.');
        return changed;
      });
      if (!hint) return;
      record.version++;
      record.lastActivityAt = now;
      const snapshot = { record, state };
      this.tables.set(id, snapshot);
      this.arm(snapshot);
      this.observer.changed(id, hint, origin);
    });
  }

  private arm(snapshot: PokerSnapshot): void {
    const { record, state } = snapshot;
    const key = 'poker:' + record.id;
    const { deadline, handId } = state;
    if (deadline === null || !state.hand) {
      this.deps.scheduler.clear(key);
      return;
    }
    const seq = state.hand.seq;
    this.deps.scheduler.set(key, deadline, () => {
      void this.mutate(record.id, undefined, (record, state, now) => {
        const hand = state.hand;
        if (!hand || state.handId !== handId || hand.seq !== seq || state.deadline !== deadline || now < deadline) return null;
        const player = hand.seats.find((seat) => seat.seat === hand.actor)!;
        const legal = pokerActions(hand, player.userId)!;
        state.hand = playPoker(hand, player.userId, seq, { type: legal.check ? 'check' : 'fold' });
        return this.advance(record, state, now, hand.street === state.hand.street ? 'update' : 'board');
      }).catch(async () => {
        if (!this.tables.has(record.id)) return;
        this.deps.logger.warn('Poker timeout could not complete; refunding this table', { tableId: record.id });
        await this.close(record.id, 'voided after a timeout failure').catch(() => undefined);
      });
    });
  }
}
