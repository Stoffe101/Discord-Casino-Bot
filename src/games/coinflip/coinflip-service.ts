import type { Database } from '../../db/database.js';
import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import type { Scheduler } from '../../core/scheduler.js';
import { StaleActionError, UserError } from '../../core/errors.js';
import { chips } from '../../core/format.js';
import { KeyedSerialQueue } from '../../core/serial-queue.js';
import { newId, secureRng, type Rng } from '../../core/random.js';
import type { EconomyService, SettingsProvider } from '../../domain/economy/economy-service.js';
import type { RecordedPlayer, RoundRecorder } from '../../domain/round-recorder.js';

export type CoinSide = 'heads' | 'tails';
export type ChallengeStatus = 'pending' | 'resolved' | 'declined' | 'cancelled' | 'expired';

export interface Challenge {
  id: string;
  guildId: string;
  challengerId: string;
  opponentId: string;
  amount: number;
  call: CoinSide;
  status: ChallengeStatus;
  result: CoinSide | null;
  winnerId: string | null;
  channelId: string | null;
  messageId: string | null;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

interface ChallengeRow {
  id: string;
  guild_id: string;
  challenger_id: string;
  opponent_id: string;
  amount: number;
  challenger_call: CoinSide;
  status: ChallengeStatus;
  result: CoinSide | null;
  winner_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

export interface CoinflipObserver {
  challengeChanged(challenge: Challenge, recorded?: RecordedPlayer[]): void;
}

const MAX_PENDING_PER_PLAYER = 3;

/**
 * Player-vs-player coin flips. The challenger's stake is escrowed when the challenge is made;
 * the opponent's when they accept, and the flip and payout happen in that same transaction.
 * Declines, cancellations, expiry and restarts all refund atomically.
 */
export class CoinflipService {
  private readonly queue = new KeyedSerialQueue();
  private observer: CoinflipObserver = { challengeChanged: () => undefined };
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
    this.logger = deps.logger.child({ component: 'coinflip' });
    this.rng = deps.rng ?? secureRng;
  }

  setObserver(observer: CoinflipObserver): void {
    this.observer = observer;
  }

  get(id: string): Challenge | undefined {
    const row = this.db.get<ChallengeRow>('SELECT * FROM coinflip_challenges WHERE id = ?', [id]);
    return row ? toChallenge(row) : undefined;
  }

  idle(): Promise<void> {
    return this.queue.drain();
  }

  async create(input: { guildId: string; challengerId: string; opponentId: string; amount: number; call: CoinSide }): Promise<Challenge> {
    const s = this.settings(input.guildId);
    if (!s.enabled) throw new UserError('The casino is closed right now.', 'casino_closed');
    if (!s.coinflip.enabled) throw new UserError('Coinflip duels are switched off on this server.', 'game_disabled');
    if (input.challengerId === input.opponentId) throw new UserError("You can't flip against yourself.", 'self');
    if (!Number.isSafeInteger(input.amount) || input.amount < s.coinflip.minBet || input.amount > s.coinflip.maxBet) {
      throw new UserError(`Duels are **${chips(s.coinflip.minBet)}–${chips(s.coinflip.maxBet)}** chips.`, 'bet_limits');
    }
    return this.queue.run(`challenger:${input.guildId}:${input.challengerId}`, () => {
      const pending =
        this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM coinflip_challenges WHERE guild_id = ? AND challenger_id = ? AND status = 'pending'", [
          input.guildId,
          input.challengerId,
        ])?.n ?? 0;
      if (pending >= MAX_PENDING_PER_PLAYER) {
        throw new UserError(`You already have ${pending} open challenges. Wait for an answer or cancel one.`, 'too_many');
      }
      const now = this.clock.now();
      const challenge: Challenge = {
        id: newId(),
        guildId: input.guildId,
        challengerId: input.challengerId,
        opponentId: input.opponentId,
        amount: input.amount,
        call: input.call,
        status: 'pending',
        result: null,
        winnerId: null,
        channelId: null,
        messageId: null,
        createdAt: now,
        expiresAt: now + s.coinflip.expirySeconds * 1000,
        resolvedAt: null,
      };
      this.db.transaction(() => {
        this.economy.reserve({
          guildId: input.guildId,
          userId: input.challengerId,
          game: 'coinflip',
          contextId: challenge.id,
          amount: input.amount,
          key: `coinflip:${challenge.id}:challenger`,
          memo: 'Coinflip challenge',
        });
        this.db.run(
          `INSERT INTO coinflip_challenges (id, guild_id, challenger_id, opponent_id, amount, challenger_call, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [challenge.id, challenge.guildId, challenge.challengerId, challenge.opponentId, challenge.amount, challenge.call, now, challenge.expiresAt],
        );
      });
      this.armExpiry(challenge);
      return challenge;
    });
  }

  async attachMessage(id: string, channelId: string, messageId: string): Promise<void> {
    this.db.run('UPDATE coinflip_challenges SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, id]);
  }

  async accept(id: string, userId: string): Promise<{ challenge: Challenge; recorded: RecordedPlayer[] }> {
    return this.queue.run(`challenge:${id}`, () => {
      const challenge = this.requirePending(id);
      if (challenge.opponentId !== userId) throw new UserError('Only the challenged player can accept this duel.', 'not_opponent');
      if (this.clock.now() >= challenge.expiresAt) {
        this.expireNow(challenge);
        throw new StaleActionError('This challenge has expired — the stake was refunded.');
      }
      const result: CoinSide = this.rng.int(2) === 0 ? 'heads' : 'tails';
      const winnerId = result === challenge.call ? challenge.challengerId : challenge.opponentId;
      const loserId = winnerId === challenge.challengerId ? challenge.opponentId : challenge.challengerId;
      const recorded = this.db.transaction(() => {
        this.economy.reserve({
          guildId: challenge.guildId,
          userId,
          game: 'coinflip',
          contextId: challenge.id,
          amount: challenge.amount,
          key: `coinflip:${challenge.id}:opponent`,
          memo: 'Coinflip duel',
        });
        const updated = this.db.run(
          "UPDATE coinflip_challenges SET status = 'resolved', result = ?, winner_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
          [result, winnerId, this.clock.now(), challenge.id],
        );
        if (updated.changes !== 1) throw new StaleActionError('This challenge was already answered.');
        const base = { stats: { flips: 1 }, flags: [] as string[], xp: 5 };
        return this.recorder.record({
          guildId: challenge.guildId,
          roundId: challenge.id,
          game: 'coinflip',
          title: 'Coinflip duel',
          players: [
            { ...base, userId: winnerId, wagered: challenge.amount, returned: challenge.amount * 2, label: 'win', xp: 10, detail: { result } },
            { ...base, userId: loserId, wagered: challenge.amount, returned: 0, label: 'lose', detail: { result } },
          ],
          tablePlayers: 2,
        }).players;
      });
      this.scheduler.clear(this.timerKey(id));
      const resolved = this.get(id)!;
      this.observer.challengeChanged(resolved, recorded);
      return { challenge: resolved, recorded };
    });
  }

  async decline(id: string, userId: string): Promise<Challenge> {
    return this.queue.run(`challenge:${id}`, () => {
      const challenge = this.requirePending(id);
      if (challenge.opponentId !== userId) throw new UserError('Only the challenged player can decline.', 'not_opponent');
      return this.close(challenge, 'declined', 'Coinflip declined');
    });
  }

  async cancel(id: string, userId: string): Promise<Challenge> {
    return this.queue.run(`challenge:${id}`, () => {
      const challenge = this.requirePending(id);
      if (challenge.challengerId !== userId) throw new UserError('Only the challenger can cancel this duel.', 'not_challenger');
      return this.close(challenge, 'cancelled', 'Coinflip cancelled');
    });
  }

  async expire(id: string): Promise<void> {
    await this.queue.run(`challenge:${id}`, () => {
      const challenge = this.get(id);
      if (!challenge || challenge.status !== 'pending') return;
      if (this.clock.now() < challenge.expiresAt) {
        this.armExpiry(challenge);
        return;
      }
      this.expireNow(challenge);
    });
  }

  /** After a restart: expire overdue challenges, re-arm the rest, refund orphaned stakes. */
  recoverAll(): { pending: number; expired: number; orphanRefunds: number } {
    const rows = this.db.all<ChallengeRow>("SELECT * FROM coinflip_challenges WHERE status = 'pending'");
    let expired = 0;
    for (const row of rows) {
      const challenge = toChallenge(row);
      if (this.clock.now() >= challenge.expiresAt) {
        this.expireNow(challenge);
        expired++;
      } else {
        this.armExpiry(challenge);
      }
    }
    const pendingIds = new Set(rows.map((r) => r.id));
    let orphanRefunds = 0;
    for (const escrow of this.economy.allHeldEscrows()) {
      if (escrow.game !== 'coinflip' || pendingIds.has(escrow.context_id)) continue;
      orphanRefunds += this.recorder.voidRound(escrow.guild_id, escrow.context_id, 'coinflip', null, 'Refund: duel could not be completed').length;
      orphanRefunds += this.economy.refundContext(escrow.guild_id, escrow.context_id, 'Refund: orphaned duel stake').length;
    }
    return { pending: rows.length - expired, expired, orphanRefunds };
  }

  private requirePending(id: string): Challenge {
    const challenge = this.get(id);
    if (!challenge) throw new UserError('That challenge no longer exists.', 'unknown_challenge');
    if (challenge.status !== 'pending') throw new StaleActionError('This challenge has already been settled.');
    return challenge;
  }

  private expireNow(challenge: Challenge): void {
    this.close(challenge, 'expired', 'Coinflip expired');
  }

  private close(challenge: Challenge, status: 'declined' | 'cancelled' | 'expired', memo: string): Challenge {
    this.db.transaction(() => {
      const updated = this.db.run("UPDATE coinflip_challenges SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", [
        status,
        this.clock.now(),
        challenge.id,
      ]);
      if (updated.changes !== 1) throw new StaleActionError('This challenge was already answered.');
      this.recorder.voidRound(challenge.guildId, challenge.id, 'coinflip', null, memo);
    });
    this.scheduler.clear(this.timerKey(challenge.id));
    const closed = this.get(challenge.id)!;
    this.observer.challengeChanged(closed);
    this.logger.debug('challenge closed', { id: challenge.id, status });
    return closed;
  }

  private armExpiry(challenge: Challenge): void {
    this.scheduler.set(this.timerKey(challenge.id), challenge.expiresAt, () => {
      this.expire(challenge.id).catch((error: unknown) => this.logger.error('expiry failed', { id: challenge.id, error }));
    });
  }

  private timerKey(id: string): string {
    return `coinflip:${id}`;
  }
}

function toChallenge(row: ChallengeRow): Challenge {
  return {
    id: row.id,
    guildId: row.guild_id,
    challengerId: row.challenger_id,
    opponentId: row.opponent_id,
    amount: row.amount,
    call: row.challenger_call,
    status: row.status,
    result: row.result,
    winnerId: row.winner_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}
