import type { Database } from '../../db/database.js';
import { DAY, type Clock } from '../../core/clock.js';
import { StaleActionError, UserError } from '../../core/errors.js';
import { chips, discordTime } from '../../core/format.js';
import type { Logger } from '../../core/logger.js';
import { newId, shortCode, type Rng } from '../../core/random.js';
import type { Scheduler } from '../../core/scheduler.js';
import { KeyedSerialQueue } from '../../core/serial-queue.js';
import type { IdleExemption } from '../../tables/blackjack-table-service.js';
import type { EconomyService, SettingsProvider } from '../../domain/economy/economy-service.js';
import type { RoundRecorder } from '../../domain/round-recorder.js';
import { isCard } from '../cards.js';
import {
  blindPositions, dealPoker, nextBigBlind, nextDealer, playPoker, pokerActions, publicPokerHand, seatBetween,
  type BlindPositions, type PokerAction, type PokerHand, type PokerPost, type PokerSeat,
} from './engine.js';

/**
 * Chip-dumping safeguard. Gifts need accounts at least 24 hours old (EconomyService.gift() checks
 * `created_at + DAY`); without a matching rule a brand-new account could sit at Hold'em and lose its
 * starting chips to a friend in one hand. Until an account is this old...
 */
export const NEW_ACCOUNT_AGE_MS = DAY;
/**
 * ...its Hold'em buy-in plus its net Hold'em losses so far may total at most this many table-minimum
 * buy-ins (200 chips at the default settings). Winning players and accounts a day old are unaffected.
 */
export const NEW_ACCOUNT_HOLDEM_BUY_INS = 2;

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

/**
 * Entering a game in progress (missed-blind rule). The blinds themselves follow the dead-button rule
 * described on BlindPositions in engine.ts.
 * - A player who joins a table that has already dealt, or whom the big blind passed while they sat
 *   out, owes a live big blind; the second case also owes a dead small blind. Sitting out on the hand
 *   where your small blind was due owes a dead small blind.
 * - By default they post what they owe and are dealt in on the next hand, from any seat except the
 *   small-blind seat. A live post counts toward their bet; a dead blind goes straight into the pot.
 * - Or they choose to wait: they are dealt in when the big blind reaches them, owing nothing more.
 * - When fewer than two players are already in the game (a new table, or everyone else left), there
 *   is no game to buy into: everyone ready is dealt in and nothing is owed.
 */
export interface PokerTableSeat extends PokerSeat {
  name: string;
  sittingOut: boolean;
  leaving: boolean;
  /** Owes a live big blind before being dealt in anywhere but the big blind. */
  owesBigBlind: boolean;
  /** Owes a dead small blind before being dealt in anywhere but the big blind. */
  owesSmallBlind: boolean;
  /** Chose to wait for the big blind instead of posting what they owe. */
  waitForBigBlind: boolean;
}

export interface PokerTableState {
  seats: PokerTableSeat[];
  hand: PokerHand | null;
  handId: string | null;
  number: number;
  /** Last hand's button (possibly a dead seat), or -1 before the first hand. */
  dealer: number;
  lastBigBlind: number | null;
  /** Last hand's small-blind seat, live or dead (heads-up, the button): next hand's button goes here. */
  lastSmallBlind: number | null;
  deadline: number | null;
  result: ReturnType<typeof publicPokerHand> | null;
}

/** What a seated player must post to be dealt in before the big blind reaches them. */
export function blindsOwed(seat: Pick<PokerTableSeat, 'owesBigBlind' | 'owesSmallBlind'>, config: Pick<PokerConfig, 'smallBlind' | 'bigBlind'>): { live: number; dead: number } {
  return { live: seat.owesBigBlind ? config.bigBlind : 0, dead: seat.owesSmallBlind ? config.smallBlind : 0 };
}

/**
 * For the private screen: null when the player owes nothing (they play the next hand as usual).
 * Otherwise what posting costs, and whether they chose to wait for the big blind instead.
 */
export function pendingBlinds(table: PokerSnapshot, userId: string): { live: number; dead: number; waiting: boolean } | null {
  const seat = table.state.seats.find((player) => player.userId === userId);
  if (!seat || (!seat.owesBigBlind && !seat.owesSmallBlind)) return null;
  return { ...blindsOwed(seat, table.record.config), waiting: seat.waitForBigBlind };
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
        const state: PokerTableState = {
          seats: [], hand: null, handId: null, number: 0, dealer: -1, lastBigBlind: null, lastSmallBlind: null, deadline: null, result: null,
        };
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
    const player = economy.ensurePlayer(guildId, userId, name);
    this.checkNewAccountLimit(record, userId, player.created_at, amount, now);
    economy.reserve({ guildId, userId, game: 'poker', contextId: id, amount, key: 'buy-in:' + newId(), memo: 'Hold’em buy-in' });
    db.run('INSERT INTO table_seats (table_id, guild_id, user_id, seat_index, joined_at) VALUES (?, ?, ?, ?, ?)', [id, guildId, userId, seat, now]);
    if (!state.seats.length) record.ownerId = userId;
    // Joining a game that has already dealt means posting a big blind or waiting for it.
    const joining = state.lastBigBlind !== null;
    state.seats.push({ userId, seat, name, stack: amount, sittingOut: false, leaving: false, owesBigBlind: joining, owesSmallBlind: false, waitForBigBlind: false });
  }

  /**
   * See NEW_ACCOUNT_HOLDEM_BUY_INS. Reads only the existing round_results rows; records nothing.
   * Collusion between established accounts is not something a buy-in rule can stop.
   */
  private checkNewAccountLimit(record: PokerTableRecord, userId: string, createdAt: number, amount: number, now: number): void {
    const until = createdAt + NEW_ACCOUNT_AGE_MS;
    if (now >= until) return;
    const { config, guildId } = record;
    const limit = config.minBuyIn * NEW_ACCOUNT_HOLDEM_BUY_INS;
    const { net } = this.deps.db.get<{ net: number }>(
      "SELECT COALESCE(SUM(net), 0) AS net FROM round_results WHERE guild_id = ? AND user_id = ? AND game = 'poker'", [guildId, userId],
    )!;
    const room = limit - Math.max(0, -net);
    if (amount <= room) return;
    const why = `Brand-new casino accounts can put up to ${chips(limit)} chips at risk at Hold’em during their first 24 hours: your buy-in plus anything you’ve already lost at Hold’em. Like the 24-hour rule for gifts, this stops new accounts passing their starting chips to friends.`;
    throw new UserError(room >= config.minBuyIn
      ? `${why}\nYou can buy in for up to ${chips(room)} chips now. The limit lifts ${discordTime(until)}.`
      : `${why}\nYou’ve reached it for today. You can sit down again ${discordTime(until)}.`, 'new_account_limit');
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

  /**
   * A player who owes blinds (see PokerTableSeat) either posts them and plays the next hand (the
   * default, `false`) or waits until the big blind reaches them (`true`). Harmless when nothing is owed.
   */
  waitForBigBlind(id: string, userId: string, value: boolean): Promise<void> {
    return this.mutate(id, undefined, (_record, state) => {
      const seat = this.requireSeat(state, userId);
      if (seat.leaving) throw new UserError('You’re cashing out after this hand.');
      if (seat.waitForBigBlind === value) return null;
      seat.waitForBigBlind = value;
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
      const { positions, dealtIn, posts } = this.planBlinds(record, state, ready);
      state.hand = dealPoker(dealtIn.map(({ userId, seat, stack }) => ({ userId, seat, stack })), positions, config.smallBlind, config.bigBlind, this.deps.rng, posts);
      state.lastSmallBlind = positions.smallBlind ?? state.lastBigBlind;
      state.lastBigBlind = positions.bigBlind;
      state.dealer = positions.button;
      state.handId = newId().replaceAll('-', '');
      state.number++;
      state.result = null;
      return this.advance(record, state, now, 'dealt');
    });
  }

  /**
   * Choose the blinds (dead-button rule) and who is dealt in (missed-blind rule) for the next hand, and
   * update what every seat owes. Mutates `state.seats` only; the caller stores the positions.
   */
  private planBlinds(record: PokerTableRecord, state: PokerTableState, ready: PokerTableSeat[]): { positions: BlindPositions; dealtIn: PokerTableSeat[]; posts: PokerPost[] } {
    const previous = state.lastBigBlind;
    if (previous === null) return { positions: nextDealer(ready, state.dealer), dealtIn: ready, posts: [] };
    const owes = (seat: PokerTableSeat) => seat.owesBigBlind || seat.owesSmallBlind;
    // Players who owe nothing can take the big blind; so can players owing blinds, which settles them.
    const bigBlind = nextBigBlind(ready, previous);
    for (const seat of state.seats) {
      if (!seat.sittingOut || seat.leaving || seat.owesBigBlind) continue;
      if (seatBetween(previous, seat.seat, bigBlind)) {
        // The big blind passed them while they sat out: both blinds are owed (big live, small dead).
        seat.owesBigBlind = true;
        seat.owesSmallBlind = true;
      } else if (seat.seat === previous) {
        // Last hand's big blind sat out the hand where their small blind was due.
        seat.owesSmallBlind = true;
      }
    }
    // With fewer than two players already in the game there is nothing to buy into.
    const fresh = ready.filter((seat) => !owes(seat)).length < 2;
    const canPost = (seat: PokerTableSeat) => {
      const { live, dead } = blindsOwed(seat, record.config);
      return !seat.waitForBigBlind && seat.seat !== previous && seat.stack > live + dead;
    };
    const dealtIn = fresh ? ready : ready.filter((seat) => !owes(seat) || seat.seat === bigBlind || canPost(seat));
    const positions = blindPositions(dealtIn, bigBlind, { bigBlind: previous, smallBlind: state.lastSmallBlind });
    const posts = fresh ? [] : dealtIn
      .filter((seat) => owes(seat) && seat.seat !== bigBlind)
      .map((seat): PokerPost => ({ seat: seat.seat, ...blindsOwed(seat, record.config) }));
    for (const seat of dealtIn) {
      seat.owesBigBlind = false;
      seat.owesSmallBlind = false;
      seat.waitForBigBlind = false;
    }
    return { positions, dealtIn, posts };
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
        // Tables saved before the blind rules existed: nobody owes anything and the button simply moves on.
        state.lastBigBlind ??= null;
        state.lastSmallBlind ??= null;
        for (const seat of state.seats) {
          seat.owesBigBlind ??= false;
          seat.owesSmallBlind ??= false;
          seat.waitForBigBlind ??= false;
        }
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
      || (state.lastSmallBlind !== null && !safe(state.lastSmallBlind)) || (state.lastBigBlind !== null && !safe(state.lastBigBlind))
      || state.seats.some((seat) => !safe(seat.seat) || seat.seat >= config.maxSeats || !safe(seat.stack)
        || typeof seat.owesBigBlind !== 'boolean' || typeof seat.owesSmallBlind !== 'boolean' || typeof seat.waitForBigBlind !== 'boolean'
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
        || (player.dead !== undefined && (!safe(player.dead) || player.streetPaid + player.dead > player.committed))
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
