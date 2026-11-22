import type { Database } from '../../db/database.js';
import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import { StaleActionError, UserError } from '../../core/errors.js';
import { chips } from '../../core/format.js';
import { KeyedSerialQueue } from '../../core/serial-queue.js';
import { newId, secureRng, type Rng } from '../../core/random.js';
import type { EconomyService, SettingsProvider } from '../../domain/economy/economy-service.js';
import type { RecordedPlayer, RoundRecorder } from '../../domain/round-recorder.js';
import { spin, type SpinResult } from './engine.js';

export interface SlotsSpinOutcome {
  spin: SpinResult;
  bet: number;
  payout: number;
  net: number;
  balance: number;
  recorded: RecordedPlayer | undefined;
  spinCount: number;
}

/**
 * Personal slot machine. Each spin is one atomic transaction: escrow the bet, spin with the
 * CSPRNG, settle through the round recorder. A per-player spin counter in the button makes
 * double-clicks harmless.
 */
export class SlotsService {
  private readonly queue = new KeyedSerialQueue();
  private readonly db: Database;
  private readonly economy: EconomyService;
  private readonly recorder: RoundRecorder;
  private readonly settings: SettingsProvider;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly rng: Rng;
  private readonly lastSpins = new Map<string, SlotsSpinOutcome>();

  constructor(deps: { db: Database; economy: EconomyService; recorder: RoundRecorder; settings: SettingsProvider; clock: Clock; logger: Logger; rng?: Rng }) {
    this.db = deps.db;
    this.economy = deps.economy;
    this.recorder = deps.recorder;
    this.settings = deps.settings;
    this.clock = deps.clock;
    this.logger = deps.logger.child({ component: 'slots' });
    this.rng = deps.rng ?? secureRng;
  }

  spinCount(guildId: string, userId: string): number {
    return (
      this.db.get<{ value: number }>("SELECT value FROM player_stats WHERE guild_id = ? AND user_id = ? AND game = 'slots' AND stat = 'rounds'", [
        guildId,
        userId,
      ])?.value ?? 0
    );
  }

  lastSpin(guildId: string, userId: string): SlotsSpinOutcome | undefined {
    return this.lastSpins.get(`${guildId}:${userId}`);
  }

  async spin(guildId: string, userId: string, bet: number, expectedCount: number | null): Promise<SlotsSpinOutcome> {
    const s = this.settings(guildId);
    if (!s.enabled) throw new UserError('The casino is closed right now.', 'casino_closed');
    if (!s.slots.enabled) throw new UserError('The slot machine is switched off on this server.', 'game_disabled');
    if (!Number.isSafeInteger(bet) || bet < s.slots.minBet || bet > s.slots.maxBet) {
      throw new UserError(`Spins are **${chips(s.slots.minBet)}–${chips(s.slots.maxBet)}** chips.`, 'bet_limits');
    }
    return this.queue.run(`${guildId}:${userId}`, () => {
      const count = this.spinCount(guildId, userId);
      if (expectedCount !== null && expectedCount !== count) {
        throw new StaleActionError('That spin was already played.');
      }
      const spinId = newId();
      const result = spin(this.rng);
      const payout = bet * result.multiplier;
      const outcome = this.db.transaction(() => {
        this.economy.reserve({ guildId, userId, game: 'slots', contextId: spinId, amount: bet, key: `slots:${spinId}`, memo: 'Slots spin' });
        const flags: string[] = [];
        if (result.line.every((sym) => sym === 'seven')) flags.push('slots_jackpot');
        const recorded = this.recorder.record({
          guildId,
          roundId: spinId,
          game: 'slots',
          title: 'Slots',
          players: [
            {
              userId,
              wagered: bet,
              returned: payout,
              stats: { spins: 1, line_wins: payout > 0 ? 1 : 0 },
              maxStats: { biggest_multiplier: result.multiplier },
              flags,
              xp: 2,
              label: result.multiplier > 0 ? 'win' : 'lose',
              detail: { line: result.line, multiplier: result.multiplier },
            },
          ],
        });
        return recorded.players[0];
      });
      const balance = this.economy.getPlayer(guildId, userId)!.balance;
      const spinOutcome: SlotsSpinOutcome = {
        spin: result,
        bet,
        payout,
        net: payout - bet,
        balance,
        recorded: outcome,
        spinCount: count + 1,
      };
      this.lastSpins.set(`${guildId}:${userId}`, spinOutcome);
      if (this.lastSpins.size > 2000) this.lastSpins.delete(this.lastSpins.keys().next().value!);
      this.logger.debug('spin', { guildId, userId, bet, multiplier: result.multiplier });
      void this.clock;
      return spinOutcome;
    });
  }
}
