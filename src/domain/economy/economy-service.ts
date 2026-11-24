import type { Database } from '../../db/database.js';
import type { Clock } from '../../core/clock.js';
import { DAY, HOUR, previousUtcDayKey, startOfUtcDay, utcDayKey } from '../../core/clock.js';
import { InsufficientFundsError, UserError } from '../../core/errors.js';
import { newId } from '../../core/random.js';
import type { GuildSettings } from '../../config/settings.js';

export type LedgerType =
  | 'initial_grant'
  | 'passive_income'
  | 'daily_reward'
  | 'mission_reward'
  | 'achievement_reward'
  | 'wager'
  | 'wager_cancel'
  | 'win'
  | 'push'
  | 'loss'
  | 'refund'
  | 'admin_adjust'
  | 'emergency_relief'
  | 'gift_sent'
  | 'gift_received';

export type GameId = 'blackjack' | 'roulette' | 'slots' | 'coinflip';

export interface PlayerRow {
  guild_id: string;
  user_id: string;
  display_name: string;
  balance: number;
  reserved: number;
  highest_balance: number;
  passive_anchor_at: number;
  daily_last_day: string | null;
  daily_streak: number;
  xp: number;
  title_id: string | null;
  card_back_id: string;
  felt_id: string;
  leaderboard_opt_out: number;
  relief_title_until: number | null;
  gifts_opt_out: number;
  highlights_opt_out: number;
  created_at: number;
  last_seen_at: number;
}

export interface LedgerRow {
  id: string;
  guild_id: string;
  user_id: string;
  type: LedgerType;
  game: string | null;
  amount: number;
  balance_after: number;
  reserved_after: number;
  reference: string | null;
  idempotency_key: string;
  memo: string | null;
  actor_id: string | null;
  created_at: number;
}

export interface EscrowRow {
  id: string;
  guild_id: string;
  user_id: string;
  game: string;
  context_id: string;
  amount: number;
  status: 'held' | 'settled' | 'refunded';
  created_at: number;
  resolved_at: number | null;
}

export interface PassiveStatus {
  ratePerHour: number;
  available: number;
  cap: number;
  isFull: boolean;
  /** Epoch ms at which the cap is reached (undefined if already full or disabled). */
  fullAt: number | undefined;
}

export interface DailyStatus {
  available: boolean;
  amount: number;
  /** Streak the claim would produce (or the current streak if already claimed today). */
  streak: number;
  nextAt: number;
}

export type ReliefStatus =
  | { eligible: true; amount: number; titleOffered: boolean }
  | { eligible: false; reason: 'disabled' | 'funds' | 'rewards' | 'cooldown' | 'recent_gift'; nextAt?: number };

export const MIN_GIFT = 10;

export interface WalletView {
  balance: number;
  reserved: number;
  total: number;
  highestBalance: number;
  passive: PassiveStatus;
  daily: DailyStatus;
}

export interface ReconcileIssue {
  guildId: string;
  userId: string;
  problem: string;
}

export type SettingsProvider = (guildId: string) => GuildSettings;

/**
 * The only code allowed to change chip balances.
 *
 * Guarantees:
 *  - integer arithmetic only; balances can never go negative (CHECK constraints + validation)
 *  - every change writes an immutable ledger row; balance == SUM(ledger.amount) per player
 *  - committed chips live in escrows; reserved == SUM(held escrows) per player
 *  - idempotency keys make retried operations no-ops instead of double-applies
 */
export class EconomyService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsProvider,
    private readonly clock: Clock,
  ) {}

  // ───────────────────────────── players ─────────────────────────────

  /** Fetch or create a player's account. New players receive the starting balance (once). */
  ensurePlayer(guildId: string, userId: string, displayName?: string): PlayerRow {
    const now = this.clock.now();
    const existing = this.getPlayer(guildId, userId);
    if (existing) {
      if ((displayName && displayName !== existing.display_name) || now - existing.last_seen_at > 60_000) {
        this.db.run(
          'UPDATE players SET display_name = COALESCE(?, display_name), last_seen_at = ? WHERE guild_id = ? AND user_id = ?',
          [displayName ?? null, now, guildId, userId],
        );
        return this.getPlayer(guildId, userId)!;
      }
      return existing;
    }
    return this.db.transaction(() => {
      const again = this.getPlayer(guildId, userId);
      if (again) return again;
      this.db.run(
        `INSERT INTO players (guild_id, user_id, display_name, balance, reserved, highest_balance,
           passive_anchor_at, created_at, last_seen_at)
         VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)`,
        [guildId, userId, displayName ?? '', now, now, now],
      );
      const start = this.settings(guildId).economy.startingBalance;
      if (start > 0) {
        this.applyDelta(guildId, userId, {
          delta: start,
          reservedDelta: 0,
          type: 'initial_grant',
          key: 'initial_grant',
          memo: 'Welcome to the casino',
        });
      }
      return this.getPlayer(guildId, userId)!;
    });
  }

  getPlayer(guildId: string, userId: string): PlayerRow | undefined {
    return this.db.get<PlayerRow>('SELECT * FROM players WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  }

  requirePlayer(guildId: string, userId: string): PlayerRow {
    const player = this.getPlayer(guildId, userId);
    if (!player) throw new UserError("That player hasn't visited the casino yet.", 'unknown_player');
    return player;
  }

  // ───────────────────────────── wallet views ─────────────────────────────

  getWallet(guildId: string, userId: string): WalletView {
    const player = this.requirePlayer(guildId, userId);
    return {
      balance: player.balance,
      reserved: player.reserved,
      total: player.balance + player.reserved,
      highestBalance: player.highest_balance,
      passive: this.passiveStatus(guildId, player),
      daily: this.dailyStatus(guildId, player),
    };
  }

  passiveStatus(guildId: string, player: PlayerRow): PassiveStatus {
    const { passivePerHour: rate, passiveCapHours } = this.settings(guildId).economy;
    const cap = rate * passiveCapHours;
    if (rate <= 0 || cap <= 0) return { ratePerHour: 0, available: 0, cap: 0, isFull: false, fullAt: undefined };
    const now = this.clock.now();
    const elapsed = Math.max(0, now - player.passive_anchor_at);
    const raw = Math.floor((elapsed * rate) / HOUR);
    const available = Math.min(raw, cap);
    const isFull = raw >= cap;
    const fullAt = isFull ? undefined : player.passive_anchor_at + Math.ceil((cap * HOUR) / rate);
    return { ratePerHour: rate, available, cap, isFull, fullAt };
  }

  dailyStatus(guildId: string, player: PlayerRow): DailyStatus {
    const { dailyReward, dailyStreakBonus, dailyStreakMaxDays } = this.settings(guildId).economy;
    const now = this.clock.now();
    const today = utcDayKey(now);
    const nextAt = startOfUtcDay(now) + DAY;
    if (player.daily_last_day === today) {
      return { available: false, amount: 0, streak: player.daily_streak, nextAt };
    }
    const continuing = player.daily_last_day === previousUtcDayKey(today);
    const streak = continuing ? player.daily_streak + 1 : 1;
    const bonusDays = Math.min(streak, dailyStreakMaxDays) - 1;
    return { available: dailyReward > 0, amount: dailyReward + bonusDays * dailyStreakBonus, streak, nextAt };
  }

  // ───────────────────────────── claims ─────────────────────────────

  reliefStatus(guildId: string, userId: string): ReliefStatus {
    const settings = this.settings(guildId).economy;
    if (settings.reliefAmount === 0) return { eligible: false, reason: 'disabled' };
    const wallet = this.getWallet(guildId, userId);
    // Every current game holds unresolved wagers and potential payouts in escrow until settlement.
    if (wallet.total > 0) return { eligible: false, reason: 'funds' };
    if (wallet.passive.available > 0 || wallet.daily.available) return { eligible: false, reason: 'rewards' };
    const now = this.clock.now();
    const last = this.db.get<{ created_at: number }>(
      "SELECT created_at FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'emergency_relief' ORDER BY created_at DESC LIMIT 1",
      [guildId, userId],
    );
    const nextAt = last ? last.created_at + settings.reliefCooldownHours * HOUR : 0;
    if (last && nextAt > now) return { eligible: false, reason: 'cooldown', nextAt };
    const gift = this.db.get<{ created_at: number }>(
      "SELECT created_at FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'gift_sent' ORDER BY created_at DESC LIMIT 1",
      [guildId, userId],
    );
    if (gift && gift.created_at + DAY > now) return { eligible: false, reason: 'recent_gift', nextAt: gift.created_at + DAY };
    return { eligible: true, amount: settings.reliefAmount, titleOffered: settings.reliefTitle };
  }

  claimRelief(guildId: string, userId: string, withTitle: boolean): LedgerRow {
    return this.db.transaction(() => {
      const status = this.reliefStatus(guildId, userId);
      if (!status.eligible) {
        const guidance = {
          disabled: 'The relief fund is closed.',
          funds: 'Relief is available once you have no available or committed chips.',
          rewards: 'Collect the passive income or daily reward in your wallet first.',
          cooldown: 'You recently received relief. Check your wallet for the next eligible time.',
          recent_gift: 'Relief is available 24 hours after your last outgoing gift.',
        };
        throw new UserError(guidance[status.reason], 'relief_unavailable', 'Emerald Relief Fund');
      }
      const now = this.clock.now();
      const entry = this.applyDelta(guildId, userId, {
        delta: status.amount, reservedDelta: 0, type: 'emergency_relief', key: `relief:${now}`, memo: 'Emerald Relief Fund',
      });
      if (withTitle && status.titleOffered) {
        this.db.run('UPDATE players SET relief_title_until = ? WHERE guild_id = ? AND user_id = ?', [now + HOUR / 2, guildId, userId]);
      }
      return entry;
    });
  }

  gift(guildId: string, senderId: string, recipientId: string, amount: number, transferId: string): LedgerRow {
    return this.db.transaction(() => {
      const existing = this.findLedger(guildId, senderId, `gift:${transferId}:sent`);
      if (existing) return existing;
      const settings = this.settings(guildId).economy;
      if (!settings.giftingEnabled) throw new UserError('Chip gifting is disabled on this server.');
      if (senderId === recipientId) throw new UserError('Choose another player for your gift.');
      if (!Number.isSafeInteger(amount) || amount < MIN_GIFT || amount > settings.giftDailyLimit) {
        throw new UserError(`A gift must be between ${MIN_GIFT} and ${settings.giftDailyLimit} chips.`);
      }
      const sender = this.requirePlayer(guildId, senderId);
      const recipient = this.requirePlayer(guildId, recipientId);
      const now = this.clock.now();
      if (sender.created_at + DAY > now || recipient.created_at + DAY > now) {
        throw new UserError('Both players need a casino account at least 24 hours old.');
      }
      if (recipient.gifts_opt_out) throw new UserError('This player has turned off incoming gifts.');
      const daily = this.db.get<{ sent: number }>(
        "SELECT COALESCE(SUM(-amount), 0) AS sent FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'gift_sent' AND created_at >= ?",
        [guildId, senderId, startOfUtcDay(now)],
      )!.sent;
      if (amount > settings.giftDailyLimit - daily) throw new UserError(`You have ${Math.max(0, settings.giftDailyLimit - daily)} chips left in your daily gift limit.`);
      const sent = this.applyDelta(guildId, senderId, {
        delta: -amount, reservedDelta: 0, type: 'gift_sent', key: `gift:${transferId}:sent`, reference: transferId, memo: 'Chip gift sent',
      });
      this.applyDelta(guildId, recipientId, {
        delta: amount, reservedDelta: 0, type: 'gift_received', key: `gift:${transferId}:received`, reference: transferId, memo: 'Chip gift received',
      });
      return sent;
    });
  }

  /** Collect accrued passive income. Safe under concurrent presses: the second sees 0. */
  claimPassive(guildId: string, userId: string): { amount: number; balance: number } {
    return this.db.transaction(() => {
      const player = this.requirePlayer(guildId, userId);
      const status = this.passiveStatus(guildId, player);
      if (status.available <= 0) return { amount: 0, balance: player.balance };
      const now = this.clock.now();
      const newAnchor = status.isFull
        ? now
        : player.passive_anchor_at + Math.ceil((status.available * HOUR) / status.ratePerHour);
      const updated = this.db.run(
        'UPDATE players SET passive_anchor_at = ? WHERE guild_id = ? AND user_id = ? AND passive_anchor_at = ?',
        [newAnchor, guildId, userId, player.passive_anchor_at],
      );
      if (updated.changes !== 1) return { amount: 0, balance: player.balance };
      const row = this.applyDelta(guildId, userId, {
        delta: status.available,
        reservedDelta: 0,
        type: 'passive_income',
        key: `passive:${player.passive_anchor_at}`,
        memo: 'Passive earnings',
      });
      return { amount: status.available, balance: row.balance_after };
    });
  }

  /** Claim today's daily reward (UTC days). Exactly once per day per player. */
  claimDaily(guildId: string, userId: string): { amount: number; streak: number; balance: number } {
    return this.db.transaction(() => {
      const player = this.requirePlayer(guildId, userId);
      const status = this.dailyStatus(guildId, player);
      if (!status.available) {
        throw new UserError('You have already claimed today’s reward. It resets at midnight UTC.', 'daily_claimed', 'Already claimed');
      }
      const today = utcDayKey(this.clock.now());
      const row = this.applyDelta(guildId, userId, {
        delta: status.amount,
        reservedDelta: 0,
        type: 'daily_reward',
        key: `daily:${today}`,
        memo: `Daily reward (day ${status.streak} streak)`,
      });
      this.db.run('UPDATE players SET daily_last_day = ?, daily_streak = ? WHERE guild_id = ? AND user_id = ?', [
        today,
        status.streak,
        guildId,
        userId,
      ]);
      return { amount: status.amount, streak: status.streak, balance: row.balance_after };
    });
  }

  // ───────────────────────────── escrow ─────────────────────────────

  /**
   * Commit chips to a game. Moves `amount` from available balance into a held escrow.
   * Idempotent per (user, key): replaying returns the original escrow.
   */
  reserve(input: {
    guildId: string;
    userId: string;
    game: GameId;
    contextId: string;
    amount: number;
    key: string;
    memo?: string;
  }): EscrowRow {
    assertPositiveInt(input.amount);
    return this.db.transaction(() => {
      const fullKey = `reserve:${input.key}`;
      const previous = this.findLedger(input.guildId, input.userId, fullKey);
      if (previous) {
        const escrow = this.db.get<EscrowRow>('SELECT * FROM escrows WHERE id = ?', [previous.reference]);
        if (escrow) return escrow;
      }
      const player = this.requirePlayer(input.guildId, input.userId);
      if (player.balance < input.amount) throw new InsufficientFundsError(input.amount, player.balance);
      const escrowId = newId();
      const now = this.clock.now();
      this.db.run(
        `INSERT INTO escrows (id, guild_id, user_id, game, context_id, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?)`,
        [escrowId, input.guildId, input.userId, input.game, input.contextId, input.amount, now],
      );
      this.applyDelta(input.guildId, input.userId, {
        delta: -input.amount,
        reservedDelta: input.amount,
        type: 'wager',
        game: input.game,
        reference: escrowId,
        key: fullKey,
        memo: input.memo ?? null,
      });
      return this.db.get<EscrowRow>('SELECT * FROM escrows WHERE id = ?', [escrowId])!;
    });
  }

  /** Return every held escrow a user has in a context (e.g. withdrawing a bet before the deal). */
  cancelHeld(input: { guildId: string; userId: string; contextId: string; key: string; memo?: string; type?: 'wager_cancel' | 'refund' }): number {
    return this.db.transaction(() => {
      const fullKey = `cancel:${input.key}`;
      if (this.findLedger(input.guildId, input.userId, fullKey)) return 0;
      const held = this.heldEscrows(input.guildId, input.userId, input.contextId);
      const total = held.reduce((sum, e) => sum + e.amount, 0);
      if (total === 0) return 0;
      const now = this.clock.now();
      for (const escrow of held) {
        this.db.run("UPDATE escrows SET status = 'refunded', resolved_at = ? WHERE id = ? AND status = 'held'", [now, escrow.id]);
      }
      this.applyDelta(input.guildId, input.userId, {
        delta: total,
        reservedDelta: -total,
        type: input.type ?? 'wager_cancel',
        game: held[0]!.game,
        reference: input.contextId,
        key: fullKey,
        memo: input.memo ?? null,
      });
      return total;
    });
  }

  /**
   * Resolve all of a user's held escrows in a context and credit `payout` (stake included).
   * Exactly-once per (user, key).
   */
  settle(input: {
    guildId: string;
    userId: string;
    contextId: string;
    game: GameId;
    payout: number;
    outcome: 'win' | 'push' | 'loss';
    key: string;
    memo?: string;
    /** If provided, the held total must equal this (consistency guard against state drift). */
    expectedStake?: number;
  }): { stake: number; payout: number; balance: number } {
    if (!Number.isSafeInteger(input.payout) || input.payout < 0) throw new Error(`Invalid payout ${input.payout}`);
    return this.db.transaction(() => {
      const fullKey = `settle:${input.key}`;
      const previous = this.findLedger(input.guildId, input.userId, fullKey);
      if (previous) return { stake: 0, payout: previous.amount, balance: previous.balance_after };
      const held = this.heldEscrows(input.guildId, input.userId, input.contextId);
      const stake = held.reduce((sum, e) => sum + e.amount, 0);
      if (input.expectedStake !== undefined && input.expectedStake !== stake) {
        throw new Error(
          `Escrow mismatch for ${input.userId} in ${input.contextId}: held ${stake}, expected ${input.expectedStake}`,
        );
      }
      const now = this.clock.now();
      for (const escrow of held) {
        this.db.run("UPDATE escrows SET status = 'settled', resolved_at = ? WHERE id = ? AND status = 'held'", [now, escrow.id]);
      }
      const row = this.applyDelta(input.guildId, input.userId, {
        delta: input.payout,
        reservedDelta: -stake,
        type: input.outcome,
        game: input.game,
        reference: input.contextId,
        key: fullKey,
        memo: input.memo ?? null,
      });
      return { stake, payout: input.payout, balance: row.balance_after };
    });
  }

  /** Refund every held escrow in a context (voided round, expired challenge, crash recovery). */
  refundContext(guildId: string, contextId: string, memo: string): { userId: string; amount: number }[] {
    return this.db.transaction(() => {
      const held = this.db.all<EscrowRow>(
        "SELECT * FROM escrows WHERE guild_id = ? AND context_id = ? AND status = 'held' ORDER BY created_at",
        [guildId, contextId],
      );
      const byUser = new Map<string, number>();
      for (const escrow of held) byUser.set(escrow.user_id, (byUser.get(escrow.user_id) ?? 0) + escrow.amount);
      const refunds: { userId: string; amount: number }[] = [];
      for (const userId of byUser.keys()) {
        const amount = this.cancelHeld({ guildId, userId, contextId, key: `refund:${contextId}`, memo, type: 'refund' });
        if (amount > 0) refunds.push({ userId, amount });
      }
      return refunds;
    });
  }

  heldEscrows(guildId: string, userId: string, contextId: string): EscrowRow[] {
    return this.db.all<EscrowRow>(
      "SELECT * FROM escrows WHERE guild_id = ? AND user_id = ? AND context_id = ? AND status = 'held' ORDER BY created_at",
      [guildId, userId, contextId],
    );
  }

  heldInContext(guildId: string, contextId: string): EscrowRow[] {
    return this.db.all<EscrowRow>(
      "SELECT * FROM escrows WHERE guild_id = ? AND context_id = ? AND status = 'held' ORDER BY created_at",
      [guildId, contextId],
    );
  }

  allHeldEscrows(): EscrowRow[] {
    return this.db.all<EscrowRow>("SELECT * FROM escrows WHERE status = 'held' ORDER BY created_at");
  }

  // ───────────────────────────── credits & admin ─────────────────────────────

  /** Credit a reward (missions, achievements). Idempotent per (user, key). Returns 0 on replay. */
  credit(input: {
    guildId: string;
    userId: string;
    amount: number;
    type: 'mission_reward' | 'achievement_reward';
    key: string;
    memo: string;
  }): number {
    assertPositiveInt(input.amount);
    return this.db.transaction(() => {
      if (this.findLedger(input.guildId, input.userId, input.key)) return 0;
      this.requirePlayer(input.guildId, input.userId);
      this.applyDelta(input.guildId, input.userId, {
        delta: input.amount,
        reservedDelta: 0,
        type: input.type,
        key: input.key,
        memo: input.memo,
      });
      return input.amount;
    });
  }

  /** Administrative adjustment with a mandatory reason. Cannot push a balance below zero. */
  adminAdjust(input: { guildId: string; userId: string; amount: number; reason: string; actorId: string; key?: string }): LedgerRow {
    if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
      throw new UserError('The adjustment must be a non-zero whole number.', 'bad_amount');
    }
    const reason = input.reason.trim();
    if (reason.length < 3) throw new UserError('Please give a reason (at least 3 characters) for the audit log.', 'reason_required');
    return this.db.transaction(() => {
      const player = this.requirePlayer(input.guildId, input.userId);
      if (player.balance + input.amount < 0) {
        throw new UserError(
          `That would make the available balance negative (it is ${player.balance.toLocaleString('en-US')}).`,
          'negative_balance',
        );
      }
      return this.applyDelta(input.guildId, input.userId, {
        delta: input.amount,
        reservedDelta: 0,
        type: 'admin_adjust',
        key: input.key ?? `admin:${newId()}`,
        memo: reason.slice(0, 200),
        actorId: input.actorId,
      });
    });
  }

  // ───────────────────────────── history & audit ─────────────────────────────

  ledgerPage(guildId: string, userId: string, limit: number, offset = 0): LedgerRow[] {
    return this.db.all<LedgerRow>(
      'SELECT * FROM ledger WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
      [guildId, userId, limit, offset],
    );
  }

  ledgerCount(guildId: string, userId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger WHERE guild_id = ? AND user_id = ?', [guildId, userId])?.n ?? 0;
  }

  /** Verify the accounting invariants. Returns a list of problems (empty = healthy). */
  reconcile(guildId?: string): ReconcileIssue[] {
    const where = guildId ? 'WHERE p.guild_id = ?' : '';
    const params = guildId ? [guildId] : [];
    const rows = this.db.all<{
      guild_id: string;
      user_id: string;
      balance: number;
      reserved: number;
      ledger_sum: number | null;
      held_sum: number | null;
      last_balance: number | null;
      last_reserved: number | null;
    }>(
      `SELECT p.guild_id, p.user_id, p.balance, p.reserved,
         (SELECT SUM(amount) FROM ledger l WHERE l.guild_id = p.guild_id AND l.user_id = p.user_id) AS ledger_sum,
         (SELECT SUM(amount) FROM escrows e WHERE e.guild_id = p.guild_id AND e.user_id = p.user_id AND e.status = 'held') AS held_sum,
         (SELECT balance_after FROM ledger l WHERE l.guild_id = p.guild_id AND l.user_id = p.user_id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_balance,
         (SELECT reserved_after FROM ledger l WHERE l.guild_id = p.guild_id AND l.user_id = p.user_id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_reserved
       FROM players p ${where}`,
      params,
    );
    const issues: ReconcileIssue[] = [];
    for (const r of rows) {
      const ledgerSum = r.ledger_sum ?? 0;
      const heldSum = r.held_sum ?? 0;
      if (r.balance < 0 || r.reserved < 0) issues.push({ guildId: r.guild_id, userId: r.user_id, problem: 'negative balance' });
      if (ledgerSum !== r.balance) {
        issues.push({ guildId: r.guild_id, userId: r.user_id, problem: `balance ${r.balance} != ledger sum ${ledgerSum}` });
      }
      if (heldSum !== r.reserved) {
        issues.push({ guildId: r.guild_id, userId: r.user_id, problem: `reserved ${r.reserved} != held escrows ${heldSum}` });
      }
      if (r.last_balance !== null && r.last_balance !== r.balance) {
        issues.push({ guildId: r.guild_id, userId: r.user_id, problem: `balance ${r.balance} != last ledger balance ${r.last_balance}` });
      }
      if (r.last_reserved !== null && r.last_reserved !== r.reserved) {
        issues.push({ guildId: r.guild_id, userId: r.user_id, problem: `reserved ${r.reserved} != last ledger reserved ${r.last_reserved}` });
      }
    }
    return issues;
  }

  // ───────────────────────────── internals ─────────────────────────────

  private findLedger(guildId: string, userId: string, key: string): LedgerRow | undefined {
    return this.db.get<LedgerRow>('SELECT * FROM ledger WHERE guild_id = ? AND idempotency_key = ?', [
      guildId,
      ledgerKey(userId, key),
    ]);
  }

  /**
   * The single write path for balances. Must be called inside a transaction.
   * Updates the player row, then appends the ledger row describing the change.
   */
  private applyDelta(
    guildId: string,
    userId: string,
    change: {
      delta: number;
      reservedDelta: number;
      type: LedgerType;
      key: string;
      game?: string | null;
      reference?: string | null;
      memo?: string | null;
      actorId?: string | null;
    },
  ): LedgerRow {
    if (!this.db.inTransaction) throw new Error('applyDelta must run inside a transaction');
    if (!Number.isSafeInteger(change.delta) || !Number.isSafeInteger(change.reservedDelta)) {
      throw new Error('Chip amounts must be safe integers');
    }
    const player = this.requirePlayer(guildId, userId);
    const balance = player.balance + change.delta;
    const reserved = player.reserved + change.reservedDelta;
    if (balance < 0) throw new InsufficientFundsError(-change.delta, player.balance);
    if (reserved < 0) throw new Error(`Reserved chips would go negative for ${userId}`);
    const total = balance + reserved;
    if (![balance, reserved, total].every(Number.isSafeInteger)) {
      throw new UserError('That chip movement would exceed the supported wallet limit.', 'wallet_limit');
    }
    const highest = Math.max(player.highest_balance, total);
    this.db.run('UPDATE players SET balance = ?, reserved = ?, highest_balance = ? WHERE guild_id = ? AND user_id = ?', [
      balance,
      reserved,
      highest,
      guildId,
      userId,
    ]);
    const row: LedgerRow = {
      id: newId(),
      guild_id: guildId,
      user_id: userId,
      type: change.type,
      game: change.game ?? null,
      amount: change.delta,
      balance_after: balance,
      reserved_after: reserved,
      reference: change.reference ?? null,
      idempotency_key: ledgerKey(userId, change.key),
      memo: change.memo ?? null,
      actor_id: change.actorId ?? null,
      created_at: this.clock.now(),
    };
    this.db.run(
      `INSERT INTO ledger (id, guild_id, user_id, type, game, amount, balance_after, reserved_after,
         reference, idempotency_key, memo, actor_id, created_at)
       VALUES ($id, $guild_id, $user_id, $type, $game, $amount, $balance_after, $reserved_after,
         $reference, $idempotency_key, $memo, $actor_id, $created_at)`,
      { ...row },
    );
    return row;
  }
}

function ledgerKey(userId: string, key: string): string {
  return `${userId}|${key}`;
}

function assertPositiveInt(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new UserError('Amounts must be positive whole numbers of chips.', 'bad_amount');
  }
}
