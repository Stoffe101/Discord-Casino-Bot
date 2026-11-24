/**
 * Full-stack test harness: the real CasinoApp + CasinoBot (router, panel sync, outbound guard,
 * discord.js) wired to the in-memory FakeDiscord. Simulated players act only through what they
 * could do in Discord: run slash commands, press visible enabled buttons, pick select options and
 * submit modals.
 */
import { Database } from '../../src/db/database.js';
import { ManualClock } from '../../src/core/clock.js';
import { ManualScheduler } from '../../src/core/scheduler.js';
import { silentLogger, type Logger } from '../../src/core/logger.js';
import { seededRng } from '../../src/core/random.js';
import type { NicknameMembers } from '../../src/domain/sosse-nicknames.js';
import { CasinoApp } from '../../src/app/casino-app.js';
import { CasinoBot } from '../../src/discord/bot.js';
import { OutboundGuard } from '../../src/discord/outbound-guard.js';
import { FakeDiscord, textOf, buttonsOf, type FakeMessage, type FakeUser, type InteractionRecord } from './fake-discord.js';

export interface HarnessOptions {
  /** Enable test-mode outbound guard restricted to #casino (default true). */
  guard?: boolean;
  /** With the guard on: also allow verified child threads of #casino. */
  allowThreads?: boolean;
  /** 'real' keeps the bot's production animation timings (recordings); default 'instant'. */
  timing?: 'real' | 'instant';
  /** Animated GIFs (default: on with real timing, off for instant tests). */
  animations?: boolean;
  /** Database file (default in-memory); pass the same path to simulate a restart. */
  dbPath?: string;
  seed?: number;
  /** Reuse a FakeDiscord (to simulate a bot restart against the same server state). */
  discord?: FakeDiscord;
  clock?: ManualClock;
  logger?: Logger;
  nicknameMembers?: NicknameMembers;
}

export class CasinoHarness {
  readonly fd: FakeDiscord;
  readonly db: Database;
  readonly clock: ManualClock;
  readonly scheduler: ManualScheduler;
  readonly app: CasinoApp;
  readonly bot: CasinoBot;
  readonly guard: OutboundGuard | null;
  readonly guildId: string;
  readonly casino: string;
  readonly general: string;

  constructor(options: HarnessOptions = {}) {
    this.fd = options.discord ?? new FakeDiscord();
    if (!options.discord) {
      const guild = this.fd.addGuild('Test Server');
      this.fd.addChannel(guild, 'casino');
      this.fd.addChannel(guild, 'general');
    }
    const [guild] = [...this.fd.guilds.keys()];
    this.guildId = guild!;
    const channels = [...this.fd.channels.values()].filter((c) => c.guildId === this.guildId && c.type === 0);
    this.casino = channels.find((c) => c.name === 'casino')!.id;
    this.general = channels.find((c) => c.name === 'general')!.id;
    const logger = options.logger ?? silentLogger;
    this.db = new Database(options.dbPath ?? ':memory:');
    this.db.migrate();
    this.clock = options.clock ?? new ManualClock(Date.now());
    this.scheduler = new ManualScheduler(this.clock);
    this.app = new CasinoApp({ db: this.db, logger, clock: this.clock, scheduler: this.scheduler, rng: seededRng(options.seed ?? 7) });
    this.guard = options.guard === false ? null : new OutboundGuard({ guildId: this.guildId, channelId: this.casino, applicationId: this.fd.appId, allowThreads: options.allowThreads ?? false }, logger);
    this.bot = new CasinoBot(this.app, logger, {
      guard: this.guard,
      ...(options.nicknameMembers ? { nicknameGuildId: this.guildId, nicknameMembers: options.nicknameMembers } : {}),
      animations: options.animations ?? options.timing === 'real',
      makeRequest: this.fd.makeRequest as never,
      ...(options.timing === 'real' ? {} : { timing: { frameDelayMs: 0, dealFrameMs: 0, spinFrameMs: 0, animationScale: 0, tableMinIntervalMs: 0, wheelMinIntervalMs: 0, lobbyDebounceMs: 0 } }),
    });
    this.fd.attach(this.bot.client);
  }

  /** What the bot does after login: recover games, re-attach panels, post/refresh lobbies. */
  async boot(): Promise<void> {
    this.app.recover();
    await this.bot.onReady('Emerald Room#0000');
    await this.bot.idle();
  }

  async close(): Promise<void> {
    await this.bot.stop();
    await this.app.shutdown();
    this.db.close();
  }

  user(name: string, admin = false): FakeUser {
    return this.fd.user(name, { admin });
  }

  async settle(): Promise<void> {
    await this.bot.idle();
  }

  async slash(user: FakeUser, name: string, options: Parameters<FakeDiscord['slash']>[3] = {}, channelId = this.casino): Promise<InteractionRecord> {
    const rec = this.fd.slash(user, channelId, name, options);
    await this.bot.idle();
    return rec;
  }

  async click(user: FakeUser, message: FakeMessage | null, match: string | RegExp): Promise<InteractionRecord> {
    if (!message) throw new Error(`no message to click "${String(match)}" on`);
    const rec = this.fd.click(user, message, match);
    await this.bot.idle();
    return rec;
  }

  async select(user: FakeUser, message: FakeMessage | null, prefix: string, values: string[]): Promise<InteractionRecord> {
    if (!message) throw new Error('no message');
    const rec = this.fd.select(user, message, prefix, values);
    await this.bot.idle();
    return rec;
  }

  async submit(user: FakeUser, opener: InteractionRecord, values: Record<string, string | string[]>): Promise<InteractionRecord> {
    const rec = this.fd.submitModal(user, opener, values);
    await this.bot.idle();
    return rec;
  }

  /** Let game time pass (turn timers, betting windows) and run what became due. */
  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    this.scheduler.runDue();
    await this.bot.idle();
  }

  /** The live public panel message of a table. */
  tablePanel(tableId: string): FakeMessage {
    const record = this.app.blackjack.peek(tableId)?.record;
    if (!record?.messageId) throw new Error('table has no panel');
    const message = this.fd.messages.get(record.messageId);
    if (!message || message.deleted) throw new Error('table panel message missing');
    return message;
  }

  lobby(): FakeMessage | null {
    const { messageId } = this.app.settings.lobby(this.guildId);
    return messageId ? (this.fd.messages.get(messageId) ?? null) : null;
  }

  seen(rec: InteractionRecord): FakeMessage | null {
    return this.fd.seen(rec);
  }

  text(message: FakeMessage | null): string {
    return textOf(message);
  }

  buttons(message: FakeMessage | null) {
    return message ? buttonsOf(message) : [];
  }

  /** Labels of enabled buttons on a message. */
  enabled(message: FakeMessage | null): string[] {
    return this.buttons(message)
      .filter((b) => !b.disabled && b.custom_id)
      .map((b) => b.label ?? b.custom_id!);
  }

  balance(user: FakeUser): number {
    return this.app.economy.getWallet(this.guildId, user.id).balance;
  }
}
