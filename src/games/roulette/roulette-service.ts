import type { Database } from '../../db/database.js';
import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import type { Scheduler } from '../../core/scheduler.js';
import { StaleActionError, UserError } from '../../core/errors.js';
import { chips } from '../../core/format.js';
import { KeyedSerialQueue } from '../../core/serial-queue.js';
import { newId, secureRng, type Rng } from '../../core/random.js';
import type { EconomyService, SettingsProvider } from '../../domain/economy/economy-service.js';
import type { RoundRecorder } from '../../domain/round-recorder.js';
import { betReturn, betTypeInfo, describeBet, spinWheel, type RouletteBetType } from './engine.js';

export interface PlacedBet {
  userId: string;
  type: RouletteBetType;
  number?: number;
  amount: number;
}

export interface RoulettePlayerResult {
  userId: string;
  displayName: string;
  wagered: number;
  returned: number;
  net: number;
  bets: { label: string; amount: number; returned: number }[];
  achievements: string[];
}

export interface RouletteState {
  spinNumber: number;
  roundId: string;
  bets: PlacedBet[];
  deadline: number | null;
  history: number[];
  lastResult: { spinNumber: number; number: number; players: RoulettePlayerResult[]; at: number } | null;
  opSeq: number;
  names: Record<string, string>;
}

export interface WheelRecord {
  id: string;
  guildId: string;
  channelId: string | null;
  threadId: string | null;
  messageId: string | null;
  version: number;
  lastActivityAt: number;
}

export interface WheelSnapshot {
  record: WheelRecord;
  state: RouletteState;
}

export interface RouletteObserver {
  wheelChanged(wheelId: string, spun: boolean, origin?: object): void;
  wheelClosed(snapshot: WheelSnapshot): void;
}

export const MAX_BETS_PER_PLAYER = 10;

interface WheelRow {
  id: string;
  guild_id: string;
  channel_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  state_json: string;
  version: number;
  last_activity_at: number;
}

/**
 * One shared roulette wheel per server. Bets are escrowed when placed; the spin and every
 * payout happen in a single transaction when the betting window closes.
 */
export class RouletteService {
  private readonly wheels = new Map<string, WheelSnapshot>();
  private readonly queue = new KeyedSerialQueue();
  private observer: RouletteObserver = { wheelChanged: () => undefined, wheelClosed: () => undefined };
  private readonly db: Database;
  private readonly economy: EconomyService;
  private readonly recorder: RoundRecorder;
  private readonly settings: SettingsProvider;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly logger: Logger;
  private readonly rng: Rng;

  constructor(deps: {
    db: Database;
    economy: EconomyService;
    recorder: RoundRecorder;
    settings: SettingsProvider;
    clock: Clock;
    scheduler: Scheduler;
    logger: Logger;
    rng?: Rng;
  }) {
    this.db = deps.db;
    this.economy = deps.economy;
    this.recorder = deps.recorder;
    this.settings = deps.settings;
    this.clock = deps.clock;
    this.scheduler = deps.scheduler;
    this.logger = deps.logger.child({ component: 'roulette' });
    this.rng = deps.rng ?? secureRng;
  }

  setObserver(observer: RouletteObserver): void {
    this.observer = observer;
  }

  idle(): Promise<void> {
    return this.queue.drain();
  }

  wheelFor(guildId: string): WheelSnapshot | undefined {
    for (const w of this.wheels.values()) if (w.record.guildId === guildId) return w;
    return undefined;
  }

  peek(wheelId: string): WheelSnapshot | undefined {
    return this.wheels.get(wheelId);
  }

  /** Get the server's wheel, opening one if needed. */
  async open(guildId: string): Promise<{ wheel: WheelSnapshot; created: boolean }> {
    const s = this.settings(guildId);
    if (!s.enabled) throw new UserError('The casino is closed right now.', 'casino_closed');
    if (!s.roulette.enabled) throw new UserError('Roulette is switched off on this server.', 'game_disabled');
    return this.queue.run(`guild:${guildId}:create`, () => {
      const existing = this.wheelFor(guildId);
      if (existing) return { wheel: existing, created: false };
      const openCount =
        this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_tables WHERE guild_id = ? AND status = 'open'", [guildId])?.n ?? 0;
      if (openCount >= s.tables.maxTables) {
        throw new UserError('Every table in the casino is in use right now. Try again when one closes.', 'table_limit', 'Casino is full');
      }
      const now = this.clock.now();
      const state: RouletteState = {
        spinNumber: 0,
        roundId: newId(),
        bets: [],
        deadline: null,
        history: [],
        lastResult: null,
        opSeq: 0,
        names: {},
      };
      const record: WheelRecord = { id: newId(), guildId, channelId: null, threadId: null, messageId: null, version: 0, lastActivityAt: now };
      this.db.run(
        `INSERT INTO game_tables (id, guild_id, game, number, name, owner_id, is_private, config_json, status, state_json, version, created_at, last_activity_at)
         VALUES (?, ?, 'roulette', 1, 'Roulette', 'house', 0, '{}', 'open', ?, 0, ?, ?)`,
        [record.id, guildId, JSON.stringify(state), now, now],
      );
      const wheel = { record, state };
      this.wheels.set(record.id, wheel);
      return { wheel, created: true };
    });
  }

  async attachDiscord(wheelId: string, location: { channelId: string; threadId: string | null; messageId: string | null }): Promise<void> {
    await this.queue.run(wheelId, () => {
      const wheel = this.wheels.get(wheelId);
      if (!wheel) return;
      this.db.run('UPDATE game_tables SET channel_id = ?, thread_id = ?, message_id = ? WHERE id = ?', [
        location.channelId,
        location.threadId,
        location.messageId,
        wheelId,
      ]);
      Object.assign(wheel.record, location);
    });
  }

  async placeBet(wheelId: string, input: { userId: string; displayName: string; type: RouletteBetType; number?: number; amount: number }, origin?: object): Promise<void> {
    await this.mutate(wheelId, origin, ({ record, state, now }) => {
      const limits = this.settings(record.guildId).roulette;
      if (!Number.isSafeInteger(input.amount) || input.amount < limits.minBet || input.amount > limits.maxBet) {
        throw new UserError(`Roulette bets are **${chips(limits.minBet)}–${chips(limits.maxBet)}** chips per spot.`, 'bet_limits');
      }
      if (input.type === 'straight' && (!Number.isInteger(input.number) || input.number! < 0 || input.number! > 36)) {
        throw new UserError('Pick a number from 0 to 36.', 'bad_number');
      }
      const mine = state.bets.filter((b) => b.userId === input.userId);
      const same = mine.find((b) => b.type === input.type && (input.type !== 'straight' || b.number === input.number));
      if (same && same.amount + input.amount > limits.maxBet) {
        throw new UserError(`That would put more than **${chips(limits.maxBet)}** on one spot.`, 'bet_limits');
      }
      if (!same && mine.length >= MAX_BETS_PER_PLAYER) {
        throw new UserError(`You can have up to ${MAX_BETS_PER_PLAYER} different bets per spin.`, 'too_many_bets');
      }
      state.opSeq++;
      this.economy.reserve({
        guildId: record.guildId,
        userId: input.userId,
        game: 'roulette',
        contextId: state.roundId,
        amount: input.amount,
        key: `rl:${state.roundId}:${state.opSeq}`,
        memo: `Roulette · ${describeBet(input)}`,
      });
      if (same) same.amount += input.amount;
      else state.bets.push({ userId: input.userId, type: input.type, ...(input.type === 'straight' ? { number: input.number } : {}), amount: input.amount });
      state.names[input.userId] = input.displayName;
      if (state.deadline === null) state.deadline = now + this.settings(record.guildId).roulette.bettingSeconds * 1000;
    });
  }

  async clearBets(wheelId: string, userId: string, origin?: object): Promise<number> {
    let refunded = 0;
    await this.mutate(wheelId, origin, ({ record, state }) => {
      if (!state.bets.some((b) => b.userId === userId)) throw new UserError('You have no bets on this spin.', 'no_bets');
      state.opSeq++;
      refunded = this.economy.cancelHeld({
        guildId: record.guildId,
        userId,
        contextId: state.roundId,
        key: `rl:${state.roundId}:${state.opSeq}:clear`,
        memo: 'Roulette bets withdrawn',
      });
      state.bets = state.bets.filter((b) => b.userId !== userId);
      if (state.bets.length === 0) state.deadline = null;
    });
    return refunded;
  }

  async handleDeadline(wheelId: string, deadline: number): Promise<void> {
    try {
      await this.mutate(wheelId, undefined, (ctx) => {
        if (ctx.state.deadline !== deadline) return 'unchanged';
        if (ctx.state.bets.length === 0) {
          ctx.state.deadline = null;
          return undefined;
        }
        this.spin(ctx);
        return 'spun';
      });
    } catch (error) {
      this.logger.error('roulette deadline failed', { wheelId, error });
    }
  }

  async close(wheelId: string, reason: string): Promise<void> {
    await this.queue.run(wheelId, () => {
      const wheel = this.wheels.get(wheelId);
      if (!wheel) return;
      this.db.transaction(() => {
        this.economy.refundContext(wheel.record.guildId, wheel.state.roundId, `Roulette closed: ${reason}`);
        this.db.run("UPDATE game_tables SET status = 'closed', closed_at = ? WHERE id = ?", [this.clock.now(), wheelId]);
      });
      this.scheduler.clear(this.timerKey(wheelId));
      this.wheels.delete(wheelId);
      this.observer.wheelClosed(wheel);
    });
  }

  async sweepIdle(): Promise<void> {
    const now = this.clock.now();
    for (const wheel of [...this.wheels.values()]) {
      if (wheel.state.bets.length > 0) continue;
      const idleMs = this.settings(wheel.record.guildId).tables.idleMinutes * 60_000;
      if (now - wheel.record.lastActivityAt >= idleMs) await this.close(wheel.record.id, 'idle').catch(() => undefined);
    }
  }

  recoverAll(): { restored: number; orphanRefunds: number } {
    const rows = this.db.all<WheelRow>("SELECT * FROM game_tables WHERE status = 'open' AND game = 'roulette'");
    const now = this.clock.now();
    for (const row of rows) {
      let state: RouletteState;
      try {
        state = JSON.parse(row.state_json) as RouletteState;
        if (!Array.isArray(state.bets) || typeof state.roundId !== 'string') throw new Error('bad roulette state');
      } catch (error) {
        this.logger.error('unreadable roulette state; refunding', { wheelId: row.id, error });
        const prior = /"roundId"\s*:\s*"([^"]+)"/.exec(row.state_json)?.[1];
        this.db.transaction(() => {
          if (prior) this.economy.refundContext(row.guild_id, prior, 'Roulette reset after restart');
          this.db.run("UPDATE game_tables SET status = 'closed', closed_at = ? WHERE id = ?", [now, row.id]);
        });
        continue;
      }
      if (this.recorder.isRecorded(state.roundId)) {
        state.roundId = newId();
        state.bets = [];
      }
      state.deadline = state.bets.length > 0 ? now + this.settings(row.guild_id).roulette.bettingSeconds * 1000 : null;
      const record: WheelRecord = {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        threadId: row.thread_id,
        messageId: row.message_id,
        version: row.version,
        lastActivityAt: row.last_activity_at,
      };
      this.db.transaction(() => this.persist(record, state, row.last_activity_at));
      record.version++;
      this.wheels.set(row.id, { record, state });
      this.arm(row.id, state);
    }
    const live = new Set([...this.wheels.values()].map((w) => w.state.roundId));
    let orphanRefunds = 0;
    for (const escrow of this.economy.allHeldEscrows()) {
      if (escrow.game !== 'roulette' || live.has(escrow.context_id)) continue;
      orphanRefunds += this.economy.refundContext(escrow.guild_id, escrow.context_id, 'Refund: roulette spin could not be completed').length;
    }
    return { restored: this.wheels.size, orphanRefunds };
  }

  touchAll(): void {
    for (const id of this.wheels.keys()) this.observer.wheelChanged(id, false);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private spin(ctx: { record: WheelRecord; state: RouletteState; now: number }): void {
    const { record, state, now } = ctx;
    const number = spinWheel(this.rng);
    const byUser = new Map<string, PlacedBet[]>();
    for (const bet of state.bets) byUser.set(bet.userId, [...(byUser.get(bet.userId) ?? []), bet]);
    const results: RoulettePlayerResult[] = [];
    const outcomes = [...byUser.entries()].map(([userId, bets]) => {
      const wagered = bets.reduce((sum, b) => sum + b.amount, 0);
      const returned = bets.reduce((sum, b) => sum + betReturn(b, number), 0);
      const straightWin = bets.some((b) => b.type === 'straight' && b.number === number);
      results.push({
        userId,
        displayName: state.names[userId] ?? 'Player',
        wagered,
        returned,
        net: returned - wagered,
        bets: bets.map((b) => ({ label: describeBet(b), amount: b.amount, returned: betReturn(b, number) })),
        achievements: [],
      });
      return {
        userId,
        wagered,
        returned,
        stats: { spins: 1, bets: bets.length, winning_bets: bets.filter((b) => betReturn(b, number) > 0).length },
        maxStats: { biggest_odds_hit: Math.max(0, ...bets.filter((b) => betReturn(b, number) > 0).map((b) => betTypeInfo(b.type).odds)) },
        flags: straightWin ? ['roulette_straight_win'] : [],
        xp: 5 + (returned > wagered ? 5 : 0),
        label: returned > wagered ? 'win' : returned === wagered ? 'push' : 'lose',
        detail: { number, bets: bets.map((b) => ({ type: b.type, number: b.number, amount: b.amount })) },
      };
    });
    const recorded = this.recorder.record({
      guildId: record.guildId,
      roundId: state.roundId,
      game: 'roulette',
      title: `Roulette · spin ${state.spinNumber + 1}`,
      players: outcomes,
      tablePlayers: outcomes.length,
      summary: { number },
    });
    for (const r of results) r.achievements = recorded.players.find((p) => p.userId === r.userId)?.achievements.map((a) => a.name) ?? [];
    state.spinNumber++;
    state.history = [number, ...state.history].slice(0, 15);
    state.lastResult = { spinNumber: state.spinNumber, number, players: results.sort((a, b) => b.net - a.net), at: now };
    state.bets = [];
    state.deadline = null;
    state.roundId = newId();
    this.logger.debug('spin', { guildId: record.guildId, number });
  }

  private async mutate(
    wheelId: string,
    origin: object | undefined,
    fn: (ctx: { record: WheelRecord; state: RouletteState; now: number }) => 'unchanged' | 'spun' | undefined,
  ): Promise<void> {
    await this.queue.run(wheelId, () => {
      const wheel = this.wheels.get(wheelId);
      if (!wheel) throw new StaleActionError('This roulette wheel has closed. Open a new one from the casino.');
      const now = this.clock.now();
      const draft = structuredClone(wheel.state);
      const record = { ...wheel.record };
      const outcome = this.db.transaction(() => {
        const r = fn({ record, state: draft, now });
        if (r !== 'unchanged') this.persist(record, draft, now);
        return r;
      });
      if (outcome === 'unchanged') return;
      record.version++;
      record.lastActivityAt = now;
      wheel.record = record;
      wheel.state = draft;
      this.arm(wheelId, draft);
      this.observer.wheelChanged(wheelId, outcome === 'spun', origin);
    });
  }

  private persist(record: WheelRecord, state: RouletteState, at: number): void {
    const updated = this.db.run('UPDATE game_tables SET state_json = ?, version = version + 1, last_activity_at = ? WHERE id = ? AND version = ?', [
      JSON.stringify(state),
      at,
      record.id,
      record.version,
    ]);
    if (updated.changes !== 1) throw new Error(`Concurrent modification of wheel ${record.id}`);
  }

  private arm(wheelId: string, state: RouletteState): void {
    if (state.deadline === null) {
      this.scheduler.clear(this.timerKey(wheelId));
      return;
    }
    const deadline = state.deadline;
    this.scheduler.set(this.timerKey(wheelId), deadline, () => void this.handleDeadline(wheelId, deadline));
  }

  private timerKey(wheelId: string): string {
    return `roulette:${wheelId}`;
  }
}
