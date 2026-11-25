import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Scheduler } from '../core/scheduler.js';
import { KeyedSerialQueue } from '../core/serial-queue.js';
import { NotYourTurnError, StaleActionError, UserError } from '../core/errors.js';
import { COUNTDOWN_CUTOFF_MS, chips } from '../core/format.js';
import { newId, secureRng, shortCode, type Rng } from '../core/random.js';
import type { GuildSettings } from '../config/settings.js';
import type { EconomyService, SettingsProvider } from '../domain/economy/economy-service.js';
import type { RoundRecorder, PlayerRoundOutcome } from '../domain/round-recorder.js';
import { cardLabel, isCard, type Card } from '../games/cards.js';
import {
  act as engineAct,
  availableActions,
  currentTurnUserId,
  decideInsurance as engineDecideInsurance,
  describeTotal,
  expireInsurance,
  extraStakeFor,
  handValue,
  insuranceCost,
  isNaturalHand,
  playDealer,
  settleRound,
  standAllHands,
  startRound,
  type BlackjackRules,
  type PlayerAction,
  type RoundEvent,
  type RoundSettlement,
  type RoundState,
} from '../games/blackjack/engine.js';
import type {
  BlackjackTableState,
  LastRoundResult,
  LogEntry,
  RenderHint,
  SeatInfo,
  TableConfig,
  TableObserver,
  TableRecord,
  TableSnapshot,
} from './types.js';

/** Extra time after a visible turn deadline before the timeout fires (network latency). */
export const TURN_GRACE_MS = 2_000;
/** When every seated player has bet, the deal happens this soon (lets people change their bet). */
export const ALL_IN_DEAL_DELAY_MS = 1_500;
/** A solo player's deal follows their bet after this beat (enough to add another chip). */
export const SOLO_DEAL_DELAY_MS = 700;
/** Consecutive timeouts before a player is automatically sat out. */
export const TIMEOUTS_BEFORE_SIT_OUT = 2;
/** Consecutive hands dealt without this player betting before they are sat out. */
export const MISSED_ROUNDS_BEFORE_SIT_OUT = 2;
const LOG_LIMIT = 6;

interface TableRow {
  id: string;
  guild_id: string;
  game: string;
  number: number;
  name: string;
  owner_id: string;
  is_private: number;
  access_code: string | null;
  config_json: string;
  channel_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  status: 'open' | 'closed';
  state_json: string;
  version: number;
  created_at: number;
  last_activity_at: number;
}

interface Runtime {
  record: TableRecord;
  state: BlackjackTableState;
}

interface MutationResult<T> {
  value: T;
  hint?: RenderHint;
  /** Skip persisting/notifying (pure validation failures never reach here — they throw). */
  unchanged?: boolean;
}

export interface CreateTableInput {
  guildId: string;
  ownerId: string;
  ownerName: string;
  name?: string;
  isPrivate?: boolean;
  maxSeats?: number;
  minBet?: number;
  maxBet?: number;
  feltId?: string;
  cardBackId?: string;
}

/**
 * Asked before an otherwise idle table is closed: true keeps it open (e.g. it is assigned to a
 * casino event that is due). Implementations must be bounded in time — never a permanent hold.
 */
export type IdleExemption = (tableId: string, guildId: string, now: number) => boolean;

/** Throws a UserError when a table may not be opened (checked before anything is created). */
export type CreationCheck = (guildId: string, options: { isPrivate: boolean }) => void;

export const PRIVATE_TABLES_NEED_THREADS =
  'Private tables live in private threads, and table threads are not available on this server. Open a public table instead, or ask a server manager to turn table threads on.';

export interface TableServiceDeps {
  db: Database;
  economy: EconomyService;
  recorder: RoundRecorder;
  settings: SettingsProvider;
  clock: Clock;
  scheduler: Scheduler;
  logger: Logger;
  rng?: Rng;
  idleExempt?: IdleExemption;
}

export function rulesFromSettings(s: GuildSettings['blackjack']): BlackjackRules {
  return {
    decks: s.decks,
    dealerHitsSoft17: s.dealerHitsSoft17,
    blackjackPayout: s.blackjackPayout === '6:5' ? { numerator: 6, denominator: 5 } : { numerator: 3, denominator: 2 },
    doubleAfterSplit: s.doubleAfterSplit,
    surrender: s.surrender,
    insurance: s.insurance,
    maxSplitHands: s.maxSplitHands,
    resplitAces: s.resplitAces,
    penetration: s.penetrationPercent / 100,
  };
}

/**
 * Owns every blackjack table: seats, bets, turns, timers, settlement and restart recovery.
 *
 * Concurrency model: each table has its own serial queue, and every mutation
 *   1. clones the current state,
 *   2. applies the change (engine + economy) inside ONE database transaction that also
 *      persists the new state with an optimistic version check,
 *   3. only then swaps the in-memory state and notifies the presenter.
 * A failure at any point leaves both the database and memory untouched.
 */
export class BlackjackTableService {
  private readonly tables = new Map<string, Runtime>();
  private readonly queue = new KeyedSerialQueue();
  private readonly db: Database;
  private readonly economy: EconomyService;
  private readonly recorder: RoundRecorder;
  private readonly settings: SettingsProvider;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly logger: Logger;
  private readonly rng: Rng;
  private readonly idleExempt: IdleExemption | undefined;
  private observer: TableObserver = { tableChanged: () => undefined, tableClosed: () => undefined };
  /** Without a Discord adapter, private tables still require table threads to be enabled. */
  private creationCheck: CreationCheck = (guildId, { isPrivate }) => {
    if (isPrivate && !this.settings(guildId).tables.useThreads) throw new UserError(PRIVATE_TABLES_NEED_THREADS, 'private_unavailable', 'Private tables unavailable');
  };

  constructor(deps: TableServiceDeps) {
    this.db = deps.db;
    this.economy = deps.economy;
    this.recorder = deps.recorder;
    this.settings = deps.settings;
    this.clock = deps.clock;
    this.scheduler = deps.scheduler;
    this.logger = deps.logger.child({ component: 'blackjack' });
    this.rng = deps.rng ?? secureRng;
    this.idleExempt = deps.idleExempt;
  }

  setObserver(observer: TableObserver): void {
    this.observer = observer;
  }

  /** The Discord adapter refuses tables it could not host (no casino channel, no private threads). */
  setCreationCheck(check: CreationCheck): void {
    this.creationCheck = check;
  }

  // ───────────────────────────── queries ─────────────────────────────

  snapshot(tableId: string): TableSnapshot | undefined {
    const rt = this.tables.get(tableId);
    return rt ? { record: structuredClone(rt.record), state: structuredClone(rt.state) } : undefined;
  }

  /** Cheap read-only access for renderers (do not mutate). */
  peek(tableId: string): Readonly<TableSnapshot> | undefined {
    const rt = this.tables.get(tableId);
    return rt ? { record: rt.record, state: rt.state } : undefined;
  }

  openTables(guildId: string): TableSnapshot[] {
    return [...this.tables.values()]
      .filter((rt) => rt.record.guildId === guildId && rt.record.status === 'open')
      .sort((a, b) => a.record.number - b.record.number)
      .map((rt) => ({ record: rt.record, state: rt.state }));
  }

  allOpenTables(): TableSnapshot[] {
    return [...this.tables.values()].map((rt) => ({ record: rt.record, state: rt.state }));
  }

  tableOfUser(guildId: string, userId: string): TableSnapshot | undefined {
    const row = this.db.get<{ table_id: string }>('SELECT table_id FROM table_seats WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    if (!row) return undefined;
    return this.peek(row.table_id) as TableSnapshot | undefined;
  }

  findByThread(threadOrChannelId: string, messageId?: string): TableSnapshot | undefined {
    for (const rt of this.tables.values()) {
      if (rt.record.threadId === threadOrChannelId || (messageId && rt.record.messageId === messageId)) {
        return { record: rt.record, state: rt.state };
      }
    }
    return undefined;
  }

  /** Which actions the given user may take right now, including affordability. */
  playerOptions(tableId: string, userId: string) {
    const rt = this.tables.get(tableId);
    const round = rt?.state.round;
    if (!rt || !round || rt.state.phase !== 'playing') return null;
    if (currentTurnUserId(round) !== userId) return null;
    const legal = availableActions(round, userId);
    const balance = this.economy.getPlayer(rt.record.guildId, userId)?.balance ?? 0;
    const extra = extraStakeFor(round, 'double');
    return {
      ...legal,
      canAffordDouble: balance >= extra,
      canAffordSplit: balance >= extra,
      extraStake: extra,
      balance,
    };
  }

  /** Resolves once every queued table operation has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue.drain();
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async createTable(input: CreateTableInput): Promise<TableSnapshot> {
    const settings = this.settings(input.guildId);
    if (!settings.enabled) throw new UserError('The casino is closed right now.', 'casino_closed');
    if (!settings.blackjack.enabled) throw new UserError('Blackjack is disabled on this server.', 'game_disabled');
    this.creationCheck(input.guildId, { isPrivate: input.isPrivate ?? false });
    return this.queue.run(`guild:${input.guildId}:create`, () => {
      const openCount =
        this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_tables WHERE guild_id = ? AND status = 'open'", [input.guildId])
          ?.n ?? 0;
      if (openCount >= settings.tables.maxTables) {
        throw new UserError(
          `All ${settings.tables.maxTables} tables are in use. Join an existing table or ask an admin to raise the limit.`,
          'table_limit',
          'Casino is full',
        );
      }
      const seated = this.tableOfUser(input.guildId, input.ownerId);
      if (seated) {
        throw new UserError(
          `You're already seated at **${seated.record.name}**. Leave that table before opening a new one.`,
          'already_seated',
        );
      }
      const bj = settings.blackjack;
      const minBet = clamp(input.minBet ?? bj.minBet, bj.minBet, bj.maxBet);
      const maxBet = clamp(input.maxBet ?? bj.maxBet, minBet, bj.maxBet);
      const config: TableConfig = {
        minBet,
        maxBet,
        maxSeats: clamp(input.maxSeats ?? bj.maxSeats, 1, bj.maxSeats),
        feltId: input.feltId ?? 'emerald',
        cardBackId: input.cardBackId ?? 'emerald',
      };
      const used = new Set(
        this.db
          .all<{ number: number }>("SELECT number FROM game_tables WHERE guild_id = ? AND game = 'blackjack' AND status = 'open'", [
            input.guildId,
          ])
          .map((r) => r.number),
      );
      let number = 1;
      while (used.has(number)) number++;
      const now = this.clock.now();
      const name = sanitizeTableName(input.name) ?? `Table ${String(number).padStart(2, '0')}`;
      const record: TableRecord = {
        id: newId(),
        guildId: input.guildId,
        game: 'blackjack',
        number,
        name,
        ownerId: input.ownerId,
        isPrivate: input.isPrivate ?? false,
        accessCode: input.isPrivate ? shortCode(5, this.rng) : null,
        config,
        channelId: null,
        threadId: null,
        messageId: null,
        status: 'open',
        version: 0,
        createdAt: now,
        lastActivityAt: now,
      };
      const state: BlackjackTableState = {
        phase: 'betting',
        roundNumber: 0,
        roundId: newId(),
        seats: [],
        bets: {},
        round: null,
        shoe: [],
        shoeSize: 0,
        deadline: null,
        opSeq: 0,
        log: [],
        lastResult: null,
      };
      this.seatPlayer(record, state, input.ownerId, input.ownerName, now);
      pushLog(state, now, `${input.ownerName} opened the table`, 'info');
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO game_tables (id, guild_id, game, number, name, owner_id, is_private, access_code, config_json,
             status, state_json, version, created_at, last_activity_at)
           VALUES (?, ?, 'blackjack', ?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?)`,
          [record.id, record.guildId, record.number, record.name, record.ownerId, record.isPrivate, record.accessCode,
            JSON.stringify(config), JSON.stringify(state), now, now],
        );
        this.insertSeatRow(record, state.seats[0]!);
      });
      this.tables.set(record.id, { record, state });
      this.logger.info('table created', { tableId: record.id, guildId: record.guildId, number });
      return { record: structuredClone(record), state: structuredClone(state) };
    });
  }

  /** Store where the table lives in Discord (thread/channel + panel message). */
  async attachDiscord(tableId: string, location: { channelId: string; threadId: string | null; messageId: string | null }): Promise<void> {
    await this.queue.run(tableId, () => {
      const rt = this.require(tableId);
      this.db.run('UPDATE game_tables SET channel_id = ?, thread_id = ?, message_id = ? WHERE id = ?', [
        location.channelId,
        location.threadId,
        location.messageId,
        tableId,
      ]);
      rt.record.channelId = location.channelId;
      rt.record.threadId = location.threadId;
      rt.record.messageId = location.messageId;
    });
  }

  /**
   * Close a table. Allowed between rounds; `force` (admins, unrecoverable errors) also voids a
   * round in progress, refunding every stake atomically.
   */
  async closeTable(tableId: string, reason: string, options: { force?: boolean; actorId?: string; idleAsOf?: number } = {}): Promise<void> {
    await this.queue.run(tableId, () => {
      const rt = this.tables.get(tableId);
      if (!rt) return;
      const { record, state } = rt;
      if (options.idleAsOf !== undefined && !this.idleReason(record, state, options.idleAsOf)) return;
      // The host must still be seated: an old "Close table" control of someone who left is refused.
      const actorIsHost = options.actorId === record.ownerId && state.seats.some((s) => s.userId === options.actorId);
      if (options.actorId && !actorIsHost && !options.force) {
        throw new UserError('Only the table host can close this table.', 'not_host');
      }
      if (state.phase !== 'betting' && !options.force) {
        throw new UserError('Finish the current round first — the table can close between rounds.', 'round_in_progress');
      }
      this.db.transaction(() => {
        if (state.round) {
          this.recorder.voidRound(record.guildId, state.roundId, 'blackjack', record.id, `Table closed: ${reason}`);
        } else {
          this.economy.refundContext(record.guildId, state.roundId, `Table closed: ${reason}`);
        }
        this.db.run('DELETE FROM table_seats WHERE table_id = ?', [tableId]);
        this.db.run("UPDATE game_tables SET status = 'closed', closed_at = ?, version = version + 1 WHERE id = ?", [
          this.clock.now(),
          tableId,
        ]);
      });
      this.scheduler.clear(this.timerKey(tableId));
      this.scheduler.clear(this.countdownKey(tableId));
      this.tables.delete(tableId);
      record.status = 'closed';
      this.logger.info('table closed', { tableId, reason });
      this.observer.tableClosed({ record, state }, reason);
    });
  }

  // ───────────────────────────── seats ─────────────────────────────

  async join(tableId: string, userId: string, displayName: string, accessCode?: string, origin?: object): Promise<SeatInfo> {
    return this.mutate(tableId, origin, ({ record, state, now }) => {
      if (state.seats.some((s) => s.userId === userId)) {
        throw new UserError("You're already seated here.", 'already_here');
      }
      if (record.isPrivate && userId !== record.ownerId) {
        if (!accessCode || accessCode.trim().toUpperCase() !== record.accessCode) {
          throw new UserError('That access code is not right. Ask the table host for the code.', 'bad_code', 'Private table');
        }
      }
      const elsewhere = this.db.get<{ table_id: string }>('SELECT table_id FROM table_seats WHERE guild_id = ? AND user_id = ?', [
        record.guildId,
        userId,
      ]);
      if (elsewhere) {
        const other = this.tables.get(elsewhere.table_id);
        throw new UserError(
          `You're seated at **${other?.record.name ?? 'another table'}**. Leave it first (you can switch between rounds).`,
          'already_seated',
        );
      }
      if (state.seats.length >= record.config.maxSeats) {
        throw new UserError('This table is full. You can spectate, or open a new table.', 'table_full', 'Table full');
      }
      // An emptied table keeps its departed host's id; whoever sits down first takes over.
      const hostSeated = state.seats.some((s) => s.userId === record.ownerId);
      const seat = this.seatPlayer(record, state, userId, displayName, now);
      this.insertSeatRow(record, seat);
      const inRound = state.phase !== 'betting';
      pushLog(state, now, inRound ? `${displayName} sat down — playing from the next hand` : `${displayName} sat down`, 'info');
      if (!hostSeated && record.ownerId !== userId) {
        record.ownerId = userId;
        pushLog(state, now, `${displayName} is now the table host`, 'info');
      }
      return { value: { ...seat } };
    });
  }

  /**
   * Leave the table. Between rounds this is immediate (an open bet is refunded). During a
   * round the player's remaining hands stand and the seat frees up when the round ends.
   */
  async leave(tableId: string, userId: string, origin?: object): Promise<'left' | 'leaving'> {
    return this.mutate(tableId, origin, (ctx) => {
      const { state, now } = ctx;
      const seat = state.seats.find((s) => s.userId === userId);
      if (!seat) throw new UserError("You aren't seated at this table.", 'not_seated');
      const inRound = state.round?.seats.some((s) => s.userId === userId) ?? false;
      if (inRound) {
        seat.leaving = true;
        pushLog(state, now, `${seat.displayName} will leave after this hand`, 'info');
        if (state.round && currentTurnUserId(state.round) === userId) {
          this.applyRound(ctx, standAllHands(state.round, userId, 'leaving'));
        } else if (state.round?.phase === 'insurance') {
          this.applyRound(ctx, standAllHands(state.round, userId, 'leaving'));
        }
        return { value: 'leaving' as const };
      }
      this.removeSeat(ctx, seat, 'left the table');
      return { value: 'left' as const };
    });
  }

  async setSittingOut(tableId: string, userId: string, sittingOut: boolean, origin?: object): Promise<void> {
    await this.mutate(tableId, origin, (ctx) => {
      const seat = ctx.state.seats.find((s) => s.userId === userId);
      if (!seat) throw new UserError("You aren't seated at this table.", 'not_seated');
      if (seat.sittingOut === sittingOut) return { value: undefined, unchanged: true };
      seat.sittingOut = sittingOut;
      seat.timeouts = 0;
      seat.missedRounds = 0;
      if (sittingOut && ctx.state.bets[userId]) this.cancelBet(ctx, userId);
      pushLog(ctx.state, ctx.now, sittingOut ? `${seat.displayName} is sitting out` : `${seat.displayName} is back in`, 'info');
      if (!sittingOut) this.maybeShortenBetting(ctx);
      return { value: undefined };
    });
  }

  /** Host removes a player between rounds (or after their current hand). */
  async kick(tableId: string, hostId: string, targetId: string, origin?: object): Promise<void> {
    await this.mutate(tableId, origin, (ctx) => {
      if (ctx.record.ownerId !== hostId) throw new UserError('Only the table host can do that.', 'not_host');
      if (hostId === targetId) throw new UserError('Use Leave to leave your own table.', 'self_kick');
      const seat = ctx.state.seats.find((s) => s.userId === targetId);
      if (!seat) throw new UserError('That player is not seated here.', 'not_seated');
      const inRound = ctx.state.round?.seats.some((s) => s.userId === targetId) ?? false;
      if (inRound) {
        seat.leaving = true;
        pushLog(ctx.state, ctx.now, `${seat.displayName} will be removed after this hand`, 'info');
        // Don't make the table wait out the turn timer of someone being removed.
        const round = ctx.state.round!;
        if (currentTurnUserId(round) === targetId || round.phase === 'insurance') {
          return { value: undefined, hint: this.applyRound(ctx, standAllHands(round, targetId, 'leaving')) };
        }
      } else {
        this.removeSeat(ctx, seat, 'was removed by the host');
      }
      return { value: undefined };
    });
  }

  // ───────────────────────────── betting ─────────────────────────────

  async placeBet(tableId: string, userId: string, amount: number, displayName?: string, origin?: object): Promise<number> {
    return this.mutate(tableId, origin, (ctx) => {
      const { record, state } = ctx;
      if (state.phase !== 'betting') {
        throw new StaleActionError('Bets are closed for this hand — you can bet again when it finishes.');
      }
      const seat = state.seats.find((s) => s.userId === userId);
      if (!seat) throw new UserError('Take a seat first, then place your bet.', 'not_seated');
      if (seat.leaving) throw new UserError("You're leaving this table.", 'leaving');
      if (displayName) seat.displayName = displayName;
      if (!Number.isSafeInteger(amount) || amount < record.config.minBet || amount > record.config.maxBet) {
        throw new UserError(
          `Bets at this table are **${chips(record.config.minBet)}–${chips(record.config.maxBet)}** chips.`,
          'bet_limits',
          'Outside table limits',
        );
      }
      if (state.bets[userId] === amount) return { value: amount, unchanged: true };
      if (state.bets[userId]) this.cancelBet(ctx, userId, true);
      this.economy.reserve({
        guildId: record.guildId,
        userId,
        game: 'blackjack',
        contextId: state.roundId,
        amount,
        key: this.opKey(state, 'bet'),
        memo: `${record.name} · bet`,
      });
      state.bets[userId] = amount;
      seat.lastBet = amount;
      seat.sittingOut = false;
      seat.missedRounds = 0;
      if (state.deadline === null) {
        state.deadline = ctx.now + this.settings(record.guildId).blackjack.bettingSeconds * 1000;
      }
      this.maybeShortenBetting(ctx);
      return { value: amount };
    });
  }

  async clearBet(tableId: string, userId: string, origin?: object): Promise<void> {
    await this.mutate(tableId, origin, (ctx) => {
      if (ctx.state.phase !== 'betting') throw new StaleActionError('Bets are locked for this hand.');
      if (!ctx.state.bets[userId]) return { value: undefined, unchanged: true };
      this.cancelBet(ctx, userId);
      if (Object.keys(ctx.state.bets).length === 0) ctx.state.deadline = null;
      return { value: undefined };
    });
  }

  /** Deal the displayed betting round once, even when the automatic timer wins the race. */
  async dealNow(tableId: string, userId: string, origin?: object, expectedRoundId?: string): Promise<'dealt' | 'refresh'> {
    return this.mutate<'dealt' | 'refresh'>(tableId, origin, (ctx) => {
      if (ctx.record.ownerId !== userId) throw new UserError('Only the table host can deal early.', 'not_host');
      const { state } = ctx;
      if (state.phase !== 'betting' || (expectedRoundId !== undefined && expectedRoundId !== state.roundId)) {
        return { value: 'refresh', unchanged: true };
      }
      if (Object.keys(state.bets).length === 0) throw new UserError('Nobody has bet yet.', 'no_bets');
      return { value: 'dealt', hint: this.deal(ctx) };
    });
  }

  // ───────────────────────────── play ─────────────────────────────

  async decideInsurance(tableId: string, userId: string, take: boolean, origin?: object): Promise<void> {
    await this.mutate(tableId, origin, (ctx) => {
      const { record, state } = ctx;
      const round = state.round;
      if (state.phase !== 'insurance' || !round) throw new StaleActionError('Insurance is no longer on offer.');
      const seat = round.seats.find((s) => s.userId === userId);
      if (!seat) throw new UserError("You don't have a hand this round.", 'not_in_round');
      if (seat.insurance.decision !== 'pending') throw new StaleActionError('You already made your insurance decision.');
      if (take) {
        const cost = insuranceCost(seat.hands[0]!.bet);
        if (cost <= 0) throw new UserError('Your bet is too small to insure.', 'too_small');
        this.economy.reserve({
          guildId: record.guildId,
          userId,
          game: 'blackjack',
          contextId: state.roundId,
          amount: cost,
          key: this.opKey(state, 'insurance'),
          memo: `${record.name} · insurance`,
        });
      }
      const next = engineDecideInsurance(round, userId, take);
      return { value: undefined, hint: this.applyRound(ctx, next) };
    });
  }

  /**
   * A player decision. `expectedSeq` is the round sequence the button was rendered for —
   * a double-click or an old message carries an outdated sequence and is rejected.
   */
  async act(tableId: string, userId: string, action: PlayerAction, expectedSeq: number | null, origin?: object): Promise<void> {
    await this.mutate(tableId, origin, (ctx) => {
      const { record, state } = ctx;
      const round = state.round;
      if (state.phase !== 'playing' || !round) throw new StaleActionError('That hand is already over.');
      const turnUser = currentTurnUserId(round);
      if (turnUser !== userId) {
        if (!round.seats.some((s) => s.userId === userId)) {
          throw new NotYourTurnError("You don't have a hand in this round — the buttons are for the player whose turn it is.");
        }
        throw new NotYourTurnError(`It's ${this.nameOf(state, turnUser)}'s turn — hang tight, yours is coming.`);
      }
      if (expectedSeq !== null && expectedSeq !== round.seq) throw new StaleActionError();
      const extra = extraStakeFor(round, action);
      if (extra > 0) {
        this.economy.reserve({
          guildId: record.guildId,
          userId,
          game: 'blackjack',
          contextId: state.roundId,
          amount: extra,
          key: this.opKey(state, action),
          memo: `${record.name} · ${action}`,
        });
      }
      const next = engineAct(round, userId, action, this.rng);
      const seat = state.seats.find((s) => s.userId === userId);
      if (seat) seat.timeouts = 0;
      return { value: undefined, hint: this.applyRound(ctx, next) };
    });
  }

  // ───────────────────────────── timers & maintenance ─────────────────────────────

  /** Called by the scheduler when a deadline passes. Stale deadlines are ignored. */
  async handleDeadline(tableId: string, deadline: number): Promise<void> {
    try {
      await this.mutate(tableId, undefined, (ctx) => {
        const { state, now } = ctx;
        if (state.deadline !== deadline) return { value: undefined, unchanged: true };
        if (state.phase === 'betting') {
          if (Object.keys(state.bets).length === 0) {
            state.deadline = null;
            return { value: undefined };
          }
          return { value: undefined, hint: this.deal(ctx) };
        }
        if (state.phase === 'insurance' && state.round) {
          return { value: undefined, hint: this.applyRound(ctx, expireInsurance(state.round)) };
        }
        if (state.phase === 'playing' && state.round) {
          const who = currentTurnUserId(state.round);
          if (!who) return { value: undefined, unchanged: true };
          const seat = state.seats.find((s) => s.userId === who);
          if (seat) {
            seat.timeouts++;
            seat.timedOutRound = state.roundNumber;
            if (seat.timeouts >= TIMEOUTS_BEFORE_SIT_OUT && !seat.sittingOut) {
              seat.sittingOut = true;
              pushLog(state, now, `${seat.displayName} seems to be away — sitting out from the next hand`, 'info');
            }
          }
          return { value: undefined, hint: this.applyRound(ctx, standAllHands(state.round, who, 'timeout')) };
        }
        return { value: undefined, unchanged: true };
      });
    } catch (error) {
      this.logger.error('deadline handling failed', { tableId, error });
    }
  }

  private idleReason(record: TableRecord, state: BlackjackTableState, now: number): string | undefined {
    if (state.phase !== 'betting' || Object.keys(state.bets).length > 0) return;
    const { idleEmptyMinutes, idleMinutes } = this.settings(record.guildId).tables;
    const empty = state.seats.length === 0;
    if (now - record.lastActivityAt < (empty ? idleEmptyMinutes : idleMinutes) * 60_000) return;
    if (this.idleExempt?.(record.id, record.guildId, now)) return;
    return empty ? 'empty table' : 'closed after inactivity';
  }

  /** Close idle tables without racing a queued wager or a seating change. */
  async sweepIdle(): Promise<string[]> {
    const closed: string[] = [];
    const now = this.clock.now();
    for (const { record, state } of this.allOpenTables()) {
      const reason = this.idleReason(record, state, now);
      if (!reason) continue;
      try {
        await this.closeTable(record.id, reason, { idleAsOf: now });
        if (!this.tables.has(record.id)) closed.push(record.id);
      } catch (error) {
        this.logger.warn('idle close failed', { tableId: record.id, error });
      }
    }
    return closed;
  }

  /**
   * Load every open table after a restart and continue deterministically:
   *  - betting: bets stay escrowed; a fresh betting window starts
   *  - insurance / playing: the round resumes exactly where it was, with a fresh timer
   *  - unreadable state: the round is voided and every stake refunded
   * Also refunds orphaned blackjack escrows that no live table references.
   */
  recoverAll(): { restored: number; voided: number; orphanRefunds: number } {
    const rows = this.db.all<TableRow>("SELECT * FROM game_tables WHERE status = 'open' AND game = 'blackjack'");
    let restored = 0;
    let voided = 0;
    const now = this.clock.now();
    for (const row of rows) {
      let record: TableRecord;
      try {
        record = rowToRecord(row);
      } catch (error) {
        this.logger.error('unreadable table row; closing', { tableId: row.id, error });
        this.db.transaction(() => {
          this.db.run('DELETE FROM table_seats WHERE table_id = ?', [row.id]);
          this.db.run("UPDATE game_tables SET status = 'closed', closed_at = ? WHERE id = ?", [now, row.id]);
        });
        continue;
      }
      let state: BlackjackTableState | null = null;
      try {
        state = parseState(row.state_json);
      } catch (error) {
        this.logger.error('unreadable table state; voiding round', { tableId: row.id, error });
      }
      if (!state) {
        const prior = safeRoundId(row.state_json);
        state = this.freshStateFromSeats(record);
        if (prior) this.recorder.voidRound(record.guildId, prior, 'blackjack', record.id, 'Unrecoverable state after restart');
        pushLog(state, now, 'The table was reset after a restart — all open bets were refunded', 'info');
        voided++;
      }
      // Defensive: a round that was already settled must not be played again.
      if (state.round && this.recorder.isRecorded(state.round.id)) {
        state.round = null;
        state.phase = 'betting';
        state.bets = {};
        state.roundId = newId();
      }
      const settings = this.settings(record.guildId).blackjack;
      if (state.phase === 'betting') {
        state.deadline = Object.keys(state.bets).length > 0 ? now + settings.bettingSeconds * 1000 : null;
      } else if (state.phase === 'insurance') {
        state.deadline = now + settings.insuranceSeconds * 1000;
      } else {
        state.deadline = now + settings.turnSeconds * 1000;
      }
      pushLog(state, now, 'The dealer is back — the game continues where it left off', 'info');
      this.db.transaction(() => this.persist(record, state!, record.lastActivityAt));
      record.version++;
      this.tables.set(record.id, { record, state });
      this.armTimer(record.id, state);
      restored++;
    }
    const orphanRefunds = this.refundOrphans();
    this.logger.info('blackjack tables recovered', { restored, voided, orphanRefunds });
    return { restored, voided, orphanRefunds };
  }

  /** Refund held blackjack escrows whose round no open table is playing. */
  refundOrphans(): number {
    const live = new Set([...this.tables.values()].map((rt) => rt.state.roundId));
    let count = 0;
    const orphans = this.economy.allHeldEscrows().filter((e) => e.game === 'blackjack' && !live.has(e.context_id));
    const contexts = new Map<string, string>();
    for (const e of orphans) contexts.set(e.context_id, e.guild_id);
    for (const [contextId, guildId] of contexts) {
      const refunds = this.recorder.voidRound(guildId, contextId, 'blackjack', null, 'Refund: round could not be resumed');
      const fallback = refunds.length === 0 ? this.economy.refundContext(guildId, contextId, 'Refund: orphaned wager') : [];
      count += refunds.length + fallback.length;
    }
    return count;
  }

  /** Re-render every table (e.g. after reconnecting to Discord). */
  touchAll(hint: RenderHint = { kind: 'restored' }): void {
    for (const id of this.tables.keys()) this.observer.tableChanged(id, hint);
  }

  shutdown(): void {
    this.scheduler.clearAll();
  }

  /**
   * TEST/SIMULATION ONLY: replace the shoe so the next deal uses known cards.
   * `drawOrder` lists cards in the order they will be dealt.
   */
  async debugSetShoe(tableId: string, drawOrder: Card[]): Promise<void> {
    await this.queue.run(tableId, () => {
      const rt = this.require(tableId);
      const shoe = [...drawOrder].reverse();
      rt.state.shoe = shoe;
      rt.state.shoeSize = this.settings(rt.record.guildId).blackjack.decks * 52;
      // Keep the rigged cards above the reshuffle point.
      const rules = rulesFromSettings(this.settings(rt.record.guildId).blackjack);
      while ((rt.state.shoeSize - rt.state.shoe.length) / rt.state.shoeSize >= rules.penetration) {
        rt.state.shoe.unshift('2C');
      }
      this.db.transaction(() => this.persist(rt.record, rt.state, rt.record.lastActivityAt));
      rt.record.version++;
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private require(tableId: string): Runtime {
    const rt = this.tables.get(tableId);
    if (!rt) throw new UserError('That table has closed. Open the lobby to find another one.', 'table_closed', 'Table closed');
    return rt;
  }

  private async mutate<T>(
    tableId: string,
    origin: object | undefined,
    fn: (ctx: { record: TableRecord; state: BlackjackTableState; now: number }) => MutationResult<T>,
  ): Promise<T> {
    return this.queue.run(tableId, () => {
      const rt = this.require(tableId);
      const now = this.clock.now();
      const draft = structuredClone(rt.state);
      const record = { ...rt.record };
      const result = this.db.transaction(() => {
        const r = fn({ record, state: draft, now });
        if (!r.unchanged) this.persist(record, draft, now);
        return r;
      });
      if (result.unchanged) return result.value;
      if (draft.roundNumber > rt.state.roundNumber) {
        this.logger.debug('blackjack deal committed', { tableId, hand: draft.roundNumber, phase: draft.phase, at: Date.now() });
      }
      record.version++;
      record.lastActivityAt = now;
      rt.record = record;
      rt.state = draft;
      this.armTimer(tableId, draft);
      this.observer.tableChanged(tableId, result.hint ?? { kind: 'update' }, origin);
      return result.value;
    });
  }

  private persist(record: TableRecord, state: BlackjackTableState, activityAt: number): void {
    const updated = this.db.run(
      `UPDATE game_tables SET state_json = ?, owner_id = ?, version = version + 1, last_activity_at = ?
       WHERE id = ? AND version = ?`,
      [JSON.stringify(state), record.ownerId, activityAt, record.id, record.version],
    );
    if (updated.changes !== 1) throw new Error(`Concurrent modification of table ${record.id}`);
  }

  private armTimer(tableId: string, state: BlackjackTableState): void {
    const key = this.timerKey(tableId);
    if (state.deadline === null) {
      this.scheduler.clear(key);
      this.scheduler.clear(this.countdownKey(tableId));
      return;
    }
    const deadline = state.deadline;
    const fireAt = state.phase === 'betting' ? deadline : deadline + TURN_GRACE_MS;
    this.scheduler.set(key, fireAt, () => void this.handleDeadline(tableId, deadline));
    // Shortly before the visible deadline the panel is redrawn without its live countdown, so it
    // never reads "1 seconds ago" while the deal (or the timeout) is on its way.
    const redrawAt = deadline - COUNTDOWN_CUTOFF_MS;
    if (redrawAt > this.clock.now()) {
      this.scheduler.set(this.countdownKey(tableId), redrawAt, () => {
        const rt = this.tables.get(tableId);
        if (rt && rt.state.deadline === deadline) this.observer.tableChanged(tableId, { kind: 'update' });
      });
    } else {
      this.scheduler.clear(this.countdownKey(tableId));
    }
  }

  private timerKey(tableId: string): string {
    return `table:${tableId}`;
  }

  private countdownKey(tableId: string): string {
    return `table:${tableId}:countdown`;
  }

  private opKey(state: BlackjackTableState, label: string): string {
    state.opSeq++;
    return `bj:${state.roundId}:${state.opSeq}:${label}`;
  }

  private seatPlayer(record: TableRecord, state: BlackjackTableState, userId: string, displayName: string, now: number): SeatInfo {
    const taken = new Set(state.seats.map((s) => s.seatIndex));
    let seatIndex = 0;
    while (taken.has(seatIndex)) seatIndex++;
    if (seatIndex >= record.config.maxSeats) throw new UserError('This table is full.', 'table_full');
    const seat: SeatInfo = {
      userId,
      seatIndex,
      displayName,
      joinedAt: now,
      sittingOut: false,
      leaving: false,
      timeouts: 0,
      missedRounds: 0,
      lastBet: null,
    };
    state.seats.push(seat);
    state.seats.sort((a, b) => a.seatIndex - b.seatIndex);
    return seat;
  }

  private insertSeatRow(record: TableRecord, seat: SeatInfo): void {
    try {
      this.db.run('INSERT INTO table_seats (table_id, guild_id, user_id, seat_index, joined_at) VALUES (?, ?, ?, ?, ?)', [
        record.id,
        record.guildId,
        seat.userId,
        seat.seatIndex,
        seat.joinedAt,
      ]);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        throw new UserError("You're already seated at another table.", 'already_seated');
      }
      throw error;
    }
  }

  private removeSeat(ctx: { record: TableRecord; state: BlackjackTableState; now: number }, seat: SeatInfo, verb: string): void {
    const { record, state, now } = ctx;
    if (state.bets[seat.userId]) this.cancelBet(ctx, seat.userId);
    state.seats = state.seats.filter((s) => s.userId !== seat.userId);
    this.db.run('DELETE FROM table_seats WHERE table_id = ? AND user_id = ?', [record.id, seat.userId]);
    pushLog(state, now, `${seat.displayName} ${verb}`, 'info');
    if (record.ownerId === seat.userId && state.seats.length > 0) {
      record.ownerId = state.seats[0]!.userId;
      pushLog(state, now, `${state.seats[0]!.displayName} is now the table host`, 'info');
    }
    if (Object.keys(state.bets).length === 0 && state.phase === 'betting') state.deadline = null;
    else this.maybeShortenBetting(ctx);
  }

  private cancelBet(ctx: { record: TableRecord; state: BlackjackTableState }, userId: string, replacing = false): void {
    const { record, state } = ctx;
    this.economy.cancelHeld({
      guildId: record.guildId,
      userId,
      contextId: state.roundId,
      key: this.opKey(state, replacing ? 'rebet' : 'cancel'),
      memo: `${record.name} · bet ${replacing ? 'changed' : 'withdrawn'}`,
    });
    delete state.bets[userId];
  }

  /** Once every active seat has a bet, deal shortly instead of waiting out the full timer. */
  private maybeShortenBetting(ctx: { state: BlackjackTableState; now: number }): void {
    const { state, now } = ctx;
    if (state.phase !== 'betting' || state.deadline === null) return;
    const active = state.seats.filter((s) => !s.sittingOut && !s.leaving);
    if (active.length > 0 && active.every((s) => state.bets[s.userId])) {
      // Alone at the table there is nobody to wait for: a short beat to stack another chip, then deal.
      state.deadline = Math.min(state.deadline, now + (state.seats.length === 1 ? SOLO_DEAL_DELAY_MS : ALL_IN_DEAL_DELAY_MS));
    }
  }

  /** Lock bets and deal. Returns a render hint. */
  private deal(ctx: { record: TableRecord; state: BlackjackTableState; now: number }): RenderHint {
    const { record, state, now } = ctx;
    const settings = this.settings(record.guildId);
    const rules = rulesFromSettings(settings.blackjack);
    const seats = state.seats
      .filter((s) => state.bets[s.userId])
      .map((s) => ({ userId: s.userId, seatIndex: s.seatIndex, bet: state.bets[s.userId]! }));
    // Seated players who keep skipping hands are sat out so they don't delay everyone else.
    for (const seat of state.seats) {
      if (state.bets[seat.userId] || seat.sittingOut || seat.leaving) continue;
      seat.missedRounds = (seat.missedRounds ?? 0) + 1;
      if (seat.missedRounds >= MISSED_ROUNDS_BEFORE_SIT_OUT) {
        seat.sittingOut = true;
        pushLog(state, now, `${seat.displayName} is sitting out — place a bet to jump back in`, 'info');
      }
    }
    // Verify each bet against the escrow actually held (money is the source of truth).
    for (const seat of seats) {
      const held = this.economy.heldEscrows(record.guildId, seat.userId, state.roundId).reduce((a, e) => a + e.amount, 0);
      if (held !== seat.bet) {
        this.logger.error('bet/escrow mismatch at deal; using escrow amount', { tableId: record.id, userId: seat.userId, held, bet: seat.bet });
        seat.bet = held;
      }
    }
    const playable = seats.filter((s) => s.bet > 0);
    if (playable.length === 0) {
      state.bets = {};
      state.deadline = null;
      return { kind: 'update' };
    }
    if (state.shoe.length === 0 || state.shoeSize === 0 || rules.decks * 52 !== state.shoeSize) {
      // New table, or the deck count changed: start from a fresh shoe.
      state.shoe = [];
      state.shoeSize = 0;
    }
    this.logger.debug('blackjack deal started', { tableId: record.id, hand: state.roundNumber + 1, deadline: state.deadline, at: Date.now() });
    const round = startRound({ id: state.roundId, rules, shoe: state.shoe, shoeSize: state.shoeSize, seats: playable }, this.rng);
    state.roundNumber++;
    state.bets = {};
    state.round = round;
    state.lastResult = null;
    pushLog(state, now, `Hand ${state.roundNumber} is dealt — ${playable.length} ${playable.length === 1 ? 'player' : 'players'}`, 'info');
    const hint = this.applyRound(ctx, round, true);
    return hint.kind === 'round_settled' ? { ...hint, dealt: true } : { kind: 'dealt' };
  }

  /**
   * Install a new engine state and drive the table forward: auto-stand leaving players,
   * set the right timer, and — when every hand is finished — play the dealer and settle.
   */
  private applyRound(
    ctx: { record: TableRecord; state: BlackjackTableState; now: number },
    next: RoundState,
    fromDeal = false,
  ): RenderHint {
    const { state, now } = ctx;
    const previousEvents = fromDeal ? 0 : (state.round?.events.length ?? 0);
    let round = next;
    // Players who are leaving never hold up the table.
    for (let guard = 0; guard < 20 && round.phase === 'playing'; guard++) {
      const who = currentTurnUserId(round);
      const seat = who ? state.seats.find((s) => s.userId === who) : undefined;
      if (!seat?.leaving) break;
      round = standAllHands(round, seat.userId, 'leaving');
    }
    const newEvents = round.events.slice(previousEvents);
    this.logEvents(state, newEvents, now);
    state.round = round;
    // The card a player just drew, so the presenter can deal it in.
    const draw = fromDeal ? undefined : [...newEvents].reverse().find((e) => e.t === 'hit' || e.t === 'double' || e.t === 'bust');
    const lastDraw = draw && 'userId' in draw && 'hand' in draw ? { userId: draw.userId, hand: draw.hand } : undefined;
    const settings = this.settings(ctx.record.guildId).blackjack;
    if (round.phase === 'insurance') {
      state.phase = 'insurance';
      if (fromDeal || state.deadline === null) state.deadline = now + settings.insuranceSeconds * 1000;
      return { kind: 'update' };
    }
    if (round.phase === 'playing') {
      state.phase = 'playing';
      state.deadline = now + settings.turnSeconds * 1000;
      return lastDraw ? { kind: 'drawn', ...lastDraw } : { kind: 'update' };
    }
    // Dealer's turn and settlement happen atomically with the action that finished the round.
    const before = round.dealer.length;
    const finished = round.phase === 'dealer' ? playDealer(round, this.rng) : round;
    this.logEvents(state, finished.events.slice(round.events.length), now);
    const dealerSteps = 1 + Math.max(0, finished.dealer.length - before);
    this.settle(ctx, finished);
    return { kind: 'round_settled', dealerSteps, ...(lastDraw ? { lastDraw } : {}) };
  }

  private settle(ctx: { record: TableRecord; state: BlackjackTableState; now: number }, finished: RoundState): void {
    const { record, state, now } = ctx;
    const { state: settledRound, settlement } = settleRound(finished);
    const tablePlayers = settlement.seats.length;
    const outcomes = settlement.seats.map((seat) => buildOutcome(seat, tablePlayers));
    let result: LastRoundResult;
    try {
      const recorded = this.db.transaction(() =>
        this.recorder.record({
          guildId: record.guildId,
          roundId: state.roundId,
          game: 'blackjack',
          tableId: record.id,
          title: `${record.name} · hand ${state.roundNumber}`,
          players: outcomes,
          tablePlayers,
          summary: { dealer: settlement.dealerCards, dealerTotal: settlement.dealerTotal, players: tablePlayers },
        }),
      );
      result = this.resultFromSettlement(state, settlement, now, recorded.players);
    } catch (error) {
      // Should never happen; if the books don't balance we refund everything rather than guess.
      this.logger.error('settlement failed; voiding round', { tableId: record.id, roundId: state.roundId, error });
      this.recorder.voidRound(record.guildId, state.roundId, 'blackjack', record.id, 'Settlement error — stakes refunded');
      result = { ...this.resultFromSettlement(state, settlement, now, []), voided: true };
      pushLog(state, now, 'Something went wrong settling this hand — all stakes were refunded', 'bad');
    }
    state.lastResult = result;
    state.shoe = settledRound.shoe;
    state.shoeSize = settledRound.shoeSize;
    state.round = null;
    state.phase = 'betting';
    state.deadline = null;
    state.roundId = newId();
    state.bets = {};
    for (const line of resultLines(result)) pushLog(state, now, line.text, line.tone);
    // Free seats of players who asked to leave.
    for (const seat of [...state.seats]) {
      if (seat.leaving) this.removeSeat(ctx, seat, 'left the table');
    }
  }

  private resultFromSettlement(
    state: BlackjackTableState,
    settlement: RoundSettlement,
    now: number,
    recorded: { userId: string; xp: { gained: number; before: { level: number }; after: { level: number } }; achievements: { name: string }[]; missions: { name: string }[] }[],
  ): LastRoundResult {
    return {
      roundId: settlement.roundId,
      roundNumber: state.roundNumber,
      dealerCards: settlement.dealerCards,
      dealerTotal: settlement.dealerTotal,
      dealerBust: settlement.dealerBust,
      dealerBlackjack: settlement.dealerBlackjack,
      settledAt: now,
      seats: settlement.seats.map((s) => {
        const rec = recorded.find((r) => r.userId === s.userId);
        return {
          userId: s.userId,
          seatIndex: s.seatIndex,
          displayName: this.nameOf(state, s.userId),
          hands: s.hands.map((h) => ({
            cards: h.cards,
            bet: h.bet,
            outcome: h.outcome,
            payout: h.payout,
            total: h.total,
            doubled: h.doubled,
            fromSplit: h.fromSplit,
          })),
          insurance: s.insurance,
          wagered: s.wagered,
          returned: s.returned,
          net: s.net,
          xpGained: rec?.xp.gained ?? 0,
          levelUp: rec && rec.xp.after.level > rec.xp.before.level ? rec.xp.after.level : null,
          achievements: rec?.achievements.map((a) => a.name) ?? [],
          missions: rec?.missions.map((m) => m.name) ?? [],
          ...(state.seats.find((x) => x.userId === s.userId)?.timedOutRound === state.roundNumber ? { timedOut: true } : {}),
        };
      }),
    };
  }

  private freshStateFromSeats(record: TableRecord): BlackjackTableState {
    const seats = this.db
      .all<{ user_id: string; seat_index: number; joined_at: number; display_name: string | null }>(
        `SELECT s.user_id, s.seat_index, s.joined_at, p.display_name FROM table_seats s
         LEFT JOIN players p ON p.guild_id = s.guild_id AND p.user_id = s.user_id
         WHERE s.table_id = ? ORDER BY s.seat_index`,
        [record.id],
      )
      .map((r) => ({
        userId: r.user_id,
        seatIndex: r.seat_index,
        displayName: r.display_name || 'Player',
        joinedAt: r.joined_at,
        sittingOut: false,
        leaving: false,
        timeouts: 0,
        missedRounds: 0,
        lastBet: null,
      }));
    return {
      phase: 'betting',
      roundNumber: 0,
      roundId: newId(),
      seats,
      bets: {},
      round: null,
      shoe: [],
      shoeSize: 0,
      deadline: null,
      opSeq: 0,
      log: [],
      lastResult: null,
    };
  }

  private nameOf(state: BlackjackTableState, userId: string | null): string {
    if (!userId) return 'Someone';
    return state.seats.find((s) => s.userId === userId)?.displayName ?? 'A player';
  }

  private logEvents(state: BlackjackTableState, events: RoundEvent[], now: number): void {
    const handLabel = (userId: string, hand: number) => {
      const seat = state.round?.seats.find((s) => s.userId === userId);
      return seat && seat.hands.length > 1 ? ` (hand ${hand + 1})` : '';
    };
    for (const e of events) {
      const name = 'userId' in e ? this.nameOf(state, e.userId) : 'Dealer';
      switch (e.t) {
        case 'reshuffle':
          pushLog(state, now, 'Fresh shoe — the dealer shuffles', 'info');
          break;
        case 'natural':
          pushLog(state, now, `${name} is dealt BLACKJACK!`, 'gold');
          break;
        case 'insurance':
          if (e.taken) pushLog(state, now, `${name} takes insurance (${chips(e.amount)})`, 'info');
          break;
        case 'peek':
          pushLog(state, now, e.dealerBlackjack ? 'Dealer peeks… and has BLACKJACK' : 'Dealer peeks — no blackjack', e.dealerBlackjack ? 'bad' : 'info');
          break;
        case 'hit':
          pushLog(state, now, `${name} draws ${cardLabel(e.card)} → ${e.soft && e.total < 21 ? `soft ${e.total}` : e.total}${handLabel(e.userId, e.hand)}`, 'info');
          break;
        case 'stand':
          if (e.reason === 'timeout') pushLog(state, now, `${name} ran out of time — stands on ${e.total}`, 'info');
          else if (e.reason === 'leaving') pushLog(state, now, `${name} stands on ${e.total} and leaves`, 'info');
          else if (e.reason !== 'twentyone') pushLog(state, now, `${name} stands on ${e.total}${handLabel(e.userId, e.hand)}`, 'info');
          break;
        case 'bust':
          pushLog(state, now, `${name} draws ${cardLabel(e.card)} and busts with ${e.total}`, 'bad');
          break;
        case 'double':
          pushLog(state, now, `${name} doubles down — draws ${cardLabel(e.card)} for ${e.total}`, 'info');
          break;
        case 'split':
          pushLog(state, now, `${name} splits the ${rankName(e.rank)}`, 'info');
          break;
        case 'surrender':
          pushLog(state, now, `${name} surrenders half the bet`, 'info');
          break;
        case 'dealer_reveal':
          pushLog(state, now, `Dealer reveals ${cardLabel(e.card)} — ${e.soft && e.total < 21 ? `soft ${e.total}` : e.total}`, 'info');
          break;
        case 'dealer_hit':
          pushLog(state, now, `Dealer draws ${cardLabel(e.card)} → ${e.total}`, 'info');
          break;
        case 'dealer_bust':
          pushLog(state, now, `Dealer busts with ${e.total}!`, 'good');
          break;
        case 'dealer_stand':
        case 'deal':
          break;
      }
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function pushLog(state: BlackjackTableState, at: number, text: string, tone: LogEntry['tone']): void {
  state.log.push({ at, text, tone });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

function rankName(rank: string): string {
  const names: Record<string, string> = { A: 'aces', T: 'tens', J: 'jacks', Q: 'queens', K: 'kings' };
  return names[rank] ?? `${rank}s`;
}

export function sanitizeTableName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/[\n\r\t`*_~|<>@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return cleaned.length >= 2 ? cleaned : undefined;
}

function resultLines(result: LastRoundResult): { text: string; tone: LogEntry['tone'] }[] {
  if (result.voided) return [];
  const dealer = result.dealerBust ? `Dealer busts (${result.dealerTotal})` : result.dealerBlackjack ? 'Dealer has blackjack' : `Dealer stands on ${result.dealerTotal}`;
  const lines: { text: string; tone: LogEntry['tone'] }[] = [{ text: dealer, tone: 'info' }];
  for (const seat of result.seats) {
    const verb = seat.net > 0 ? `wins ${chips(seat.net)}` : seat.net < 0 ? `loses ${chips(-seat.net)}` : 'pushes';
    lines.push({ text: `${seat.displayName} ${verb}`, tone: seat.net > 0 ? 'good' : seat.net < 0 ? 'bad' : 'info' });
  }
  return lines;
}

/** Turn an engine settlement into the generic round outcome the recorder understands. */
export function buildOutcome(seat: RoundSettlement['seats'][number], tablePlayers: number): PlayerRoundOutcome {
  const hands = seat.hands;
  const won = hands.filter((h) => h.outcome === 'win' || h.outcome === 'blackjack');
  const flags: string[] = [];
  const naturals = hands.filter((h) => h.outcome === 'blackjack' || (h.outcome === 'push' && !h.fromSplit && h.cards.length === 2 && h.total === 21)).length;
  if (won.some((h) => h.bet >= 500)) flags.push('bj_big_win');
  const splitHands = hands.filter((h) => h.fromSplit);
  if (splitHands.length >= 2 && splitHands.every((h) => h.outcome === 'win')) flags.push('bj_split_both_won');
  if (won.some((h) => h.cards.length >= 3 && h.total === 21)) flags.push('bj_multi_card_21_win');
  if (hands.some((h) => h.cards.length >= 5 && h.total <= 21)) flags.push('bj_five_cards');
  if (seat.insurance && seat.insurance.payout > 0) flags.push('bj_insurance_paid');
  if (tablePlayers >= 5) flags.push('bj_full_table');
  const biggestHandWin = Math.max(0, ...won.map((h) => h.payout - h.bet));
  const net = seat.returned - seat.wagered;
  const label = hands.length === 1 ? hands[0]!.outcome : net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
  return {
    userId: seat.userId,
    wagered: seat.wagered,
    returned: seat.returned,
    stats: {
      hands: hands.length,
      hands_won: won.length,
      hands_lost: hands.filter((h) => h.outcome === 'lose' || h.outcome === 'bust').length,
      hands_pushed: hands.filter((h) => h.outcome === 'push').length,
      blackjacks: naturals,
      doubles: hands.filter((h) => h.doubled).length,
      doubles_won: hands.filter((h) => h.doubled && h.outcome === 'win').length,
      splits: Math.max(0, hands.length - 1),
      busts: hands.filter((h) => h.outcome === 'bust').length,
      surrenders: hands.filter((h) => h.outcome === 'surrender').length,
      insurance_taken: seat.insurance ? 1 : 0,
    },
    maxStats: { biggest_hand_win: biggestHandWin },
    flags,
    xp: 10 + (net > 0 ? 5 : 0) + naturals * 10,
    label,
    detail: { hands: hands.map((h) => ({ cards: h.cards, bet: h.bet, outcome: h.outcome })), insurance: seat.insurance },
  };
}

function rowToRecord(row: TableRow): TableRecord {
  const config = JSON.parse(row.config_json) as TableConfig;
  return {
    id: row.id,
    guildId: row.guild_id,
    game: 'blackjack',
    number: row.number,
    name: row.name,
    ownerId: row.owner_id,
    isPrivate: row.is_private === 1,
    accessCode: row.access_code,
    config,
    channelId: row.channel_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

/** Parse and validate persisted state. Throws if anything essential is malformed. */
export function parseState(json: string): BlackjackTableState {
  const state = JSON.parse(json) as BlackjackTableState;
  if (!state || typeof state !== 'object') throw new Error('state is not an object');
  if (!['betting', 'insurance', 'playing'].includes(state.phase)) throw new Error(`bad phase ${String(state.phase)}`);
  if (typeof state.roundId !== 'string' || !Array.isArray(state.seats)) throw new Error('missing roundId/seats');
  if (!Array.isArray(state.shoe) || !state.shoe.every(isCard)) throw new Error('corrupt shoe');
  if (state.phase !== 'betting') {
    const round = state.round;
    if (!round || !Array.isArray(round.seats) || !Array.isArray(round.dealer) || !round.dealer.every(isCard)) {
      throw new Error('missing or corrupt round');
    }
    if (round.id !== state.roundId) throw new Error('round id mismatch');
    if (!['insurance', 'playing'].includes(round.phase)) throw new Error(`unexpected round phase ${round.phase}`);
    for (const seat of round.seats) {
      for (const hand of seat.hands) {
        if (!hand.cards.every(isCard) || !Number.isSafeInteger(hand.bet)) throw new Error('corrupt hand');
      }
    }
  }
  state.bets ??= {};
  state.log ??= [];
  state.opSeq ??= 0;
  for (const seat of state.seats) {
    seat.missedRounds ??= 0;
    seat.timeouts ??= 0;
  }
  return state;
}

function safeRoundId(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { roundId?: unknown };
    return typeof parsed.roundId === 'string' ? parsed.roundId : null;
  } catch {
    const match = /"roundId"\s*:\s*"([^"]+)"/.exec(json);
    return match?.[1] ?? null;
  }
}

/** Summaries used by renderers and the lobby. */
export function seatHandSummary(round: RoundState, userId: string): string {
  const seat = round.seats.find((s) => s.userId === userId);
  if (!seat) return '';
  return seat.hands.map((h) => describeTotal(h.cards, h.fromSplit)).join(' / ');
}

export { handValue, isNaturalHand, type Card };
