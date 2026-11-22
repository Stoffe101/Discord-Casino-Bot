import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type ClientOptions,
  type GuildTextBasedChannel,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import type { Logger } from '../core/logger.js';
import type { RenderHint, TableSnapshot } from '../tables/types.js';
import type { WheelSnapshot } from '../games/roulette/roulette-service.js';
import { blackjackPanel, closedTablePanel } from '../ui/screens/blackjack.js';
import { roulettePanel, coinflipMessage } from '../ui/screens/games.js';
import { lobbyScreen } from '../ui/screens/lobby.js';
import { assertValidScreen } from '../ui/validate.js';
import type { Screen } from '../ui/kit.js';
import { container, text } from '../ui/kit.js';
import { COLORS } from '../ui/theme.js';
import { PanelSync, sleep } from './panel-sync.js';
import { DISCORD_ERRORS, createOptions, discordErrorCode, editOptions, primaryFileName } from './payload.js';
import { InteractionRouter } from './router.js';
import type { OutboundGuard } from './outbound-guard.js';

export interface BotTiming {
  /** Delay between dealer-reveal frames. */
  frameDelayMs: number;
  /** Minimum gap between two edits of the same table/wheel panel (when no click is waiting). */
  tableMinIntervalMs: number;
  wheelMinIntervalMs: number;
  /** Lobby refreshes are debounced so bursts of table activity become one edit. */
  lobbyDebounceMs: number;
}

export const DEFAULT_TIMING: BotTiming = { frameDelayMs: 850, tableMinIntervalMs: 350, wheelMinIntervalMs: 500, lobbyDebounceMs: 2_500 };

export interface CasinoBotOptions {
  guard?: OutboundGuard | null;
  /** Replace the HTTP layer (tests use an in-memory Discord). */
  makeRequest?: NonNullable<ClientOptions['rest']>['makeRequest'];
  timing?: Partial<BotTiming>;
}

export const REQUIRED_CHANNEL_PERMISSIONS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['AttachFiles', PermissionFlagsBits.AttachFiles],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
  ['CreatePublicThreads', PermissionFlagsBits.CreatePublicThreads],
  ['CreatePrivateThreads', PermissionFlagsBits.CreatePrivateThreads],
  ['SendMessagesInThreads', PermissionFlagsBits.SendMessagesInThreads],
  ['ManageThreads', PermissionFlagsBits.ManageThreads],
] as const;

/**
 * The Discord adapter: owns the gateway client, keeps every persistent panel (tables, roulette,
 * lobby) in sync with the game services, and routes interactions. Game rules and money never
 * live here.
 */
export class CasinoBot {
  readonly client: Client;
  readonly tablePanels: PanelSync<RenderHint>;
  readonly wheelPanels: PanelSync<boolean>;
  readonly router: InteractionRouter;
  private readonly lobbyTimers = new Map<string, NodeJS.Timeout>();
  private readonly lobbyFiles = new Map<string, string | null>();
  private readonly lobbyBusy = new Map<string, Promise<void>>();
  private readonly intervals: NodeJS.Timeout[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private stopping = false;
  readonly guard: OutboundGuard | null;
  readonly timing: BotTiming;

  constructor(
    readonly app: CasinoApp,
    readonly logger: Logger,
    options: CasinoBotOptions = {},
  ) {
    this.guard = options.guard ?? null;
    const timing = { ...DEFAULT_TIMING, ...options.timing };
    this.timing = timing;
    // Only the Guilds intent: no message content, no member lists, no presences.
    // Mentions never ping unless a message explicitly allows it (the coinflip challenge does).
    this.client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [], repliedUser: false }, ...(options.makeRequest ? { rest: { makeRequest: options.makeRequest } } : {}) });
    // Test mode: every outgoing request passes the allowlist check before it reaches the network.
    this.guard?.install(this.client.rest);
    const guard = this.guard;
    this.tablePanels = new PanelSync<RenderHint>({
      name: 'table',
      client: this.client,
      logger,
      locate: (id) => app.blackjack.peek(id)?.record,
      render: async (id, frame) => {
        const snap = app.blackjack.peek(id);
        if (!snap) return null;
        return this.checked(await blackjackPanel(app, snap, frame === undefined ? {} : { revealStep: frame }));
      },
      frames: (id, hint) => {
        if (!hint || hint.kind !== 'round_settled') return 0;
        const snap = app.blackjack.peek(id);
        return snap && app.settings.get(snap.record.guildId).blackjack.dealerAnimation ? Math.min(hint.dealerSteps, 5) : 0;
      },
      frameDelayMs: timing.frameDelayMs,
      minIntervalMs: timing.tableMinIntervalMs,
      onMissing: (id) => this.recreateTablePanel(id),
    });
    this.wheelPanels = new PanelSync<boolean>({
      name: 'roulette',
      client: this.client,
      logger,
      locate: (id) => {
        const w = app.roulette.peek(id);
        return w ? { channelId: w.record.channelId, threadId: w.record.threadId, messageId: w.record.messageId } : undefined;
      },
      render: async (id) => {
        const w = app.roulette.peek(id);
        return w ? this.checked(await roulettePanel(app, w)) : null;
      },
      minIntervalMs: timing.wheelMinIntervalMs,
      onMissing: (id) => this.recreateWheelPanel(id),
    });
    this.router = new InteractionRouter(app, this);

    app.blackjack.setObserver({
      tableChanged: (id, hint, origin) => {
        if (this.stopping) return;
        this.tablePanels.request(id, hint, this.router.claim(origin));
        const snap = app.blackjack.peek(id);
        if (snap) this.requestLobby(snap.record.guildId);
      },
      tableClosed: (snap, reason) => void this.onTableClosed(snap, reason),
    });
    app.roulette.setObserver({
      wheelChanged: (id, spun, origin) => {
        if (this.stopping) return;
        this.wheelPanels.request(id, spun, this.router.claim(origin));
        const w = app.roulette.peek(id);
        if (w) this.requestLobby(w.record.guildId);
      },
      wheelClosed: (w) => void this.onWheelClosed(w),
    });
    app.coinflip.setObserver({
      challengeChanged: (challenge) => void this.router.refreshChallenge(challenge),
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (guard && !guard.admitInteraction(interaction)) return;
      const handled: Promise<void> = this.router.handle(interaction).finally(() => this.inflight.delete(handled));
      this.inflight.add(handled);
    });
    this.client.on(Events.Error, (error) => logger.error('discord client error', { error }));
    this.client.on(Events.Warn, (message) => logger.warn('discord client warning', { message }));
    this.client.rest.on('rateLimited', (info) => logger.debug('rate limited', { route: info.route, timeToReset: info.timeToReset }));
    this.client.once(Events.ClientReady, (c) => void this.onReady(c.user.tag));
  }

  async start(token: string): Promise<void> {
    const recovery = this.app.recover();
    this.logger.info('recovery complete', recovery);
    await this.client.login(token);
  }

  /** Runs once the gateway is ready (tests call it directly): re-attach panels, refresh lobbies, start upkeep. */
  async onReady(tag: string): Promise<void> {
    this.logger.info(`logged in as ${tag}`, { guilds: this.client.guilds.cache.size });
    if (this.guard) {
      const { guildId, channelId } = this.guard.allow;
      this.logger.info('TEST MODE: outgoing Discord actions are limited to one channel; threads are disabled', { guildId, channelId });
      if (!this.app.settings.lobby(guildId).channelId) this.app.settings.setLobby(guildId, channelId, null);
    }
    // Re-attach every restored panel (recreating missing ones) and refresh lobbies.
    for (const snap of this.app.blackjack.allOpenTables()) {
      if (!snap.record.messageId) await this.recreateTablePanel(snap.record.id);
      else this.tablePanels.request(snap.record.id, { kind: 'restored' });
    }
    this.app.roulette.touchAll();
    for (const { guildId } of this.app.settings.guildsWithLobby()) this.requestLobby(guildId, 0);
    this.intervals.push(
      setInterval(() => void this.maintenance(), 60_000),
      setInterval(() => this.auditBooks(), 60 * 60_000),
    );
    this.auditBooks();
  }

  private async maintenance(): Promise<void> {
    try {
      await this.app.blackjack.sweepIdle();
      await this.app.roulette.sweepIdle();
    } catch (error) {
      this.logger.error('maintenance failed', { error });
    }
  }

  private auditBooks(): void {
    const issues = this.app.economy.reconcile();
    if (issues.length) this.logger.error('LEDGER RECONCILIATION FAILED', { issues: issues.slice(0, 20), count: issues.length });
    else this.logger.debug('ledger reconciled');
  }

  /** Resolves once every in-flight interaction, game action and panel/lobby update has finished. */
  async idle(): Promise<void> {
    for (let pass = 0; pass < 100; pass++) {
      await Promise.all([...this.inflight]);
      await this.app.blackjack.idle();
      await Promise.all([this.tablePanels.idle(), this.wheelPanels.idle()]);
      await Promise.all([...this.lobbyBusy.values()]);
      if (this.inflight.size === 0 && this.lobbyTimers.size === 0) return;
      await sleep(5);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.intervals) clearInterval(t);
    for (const t of this.lobbyTimers.values()) clearTimeout(t);
    // Let interactions that are already being handled finish before disconnecting.
    await Promise.race([Promise.all([...this.inflight]), sleep(5_000)]);
    await Promise.race([Promise.all([this.tablePanels.idle(), this.wheelPanels.idle()]), sleep(5_000)]);
    await this.client.destroy();
  }

  /** In development, refuse to send payloads that break Discord's documented limits. */
  checked(screen: Screen): Screen {
    try {
      assertValidScreen(screen);
    } catch (error) {
      this.logger.error('invalid payload generated', { error });
      if (process.env.NODE_ENV !== 'production') throw error;
    }
    return screen;
  }

  // ───────────────────────────── channels & threads ─────────────────────────────

  /** Threads are separate channels; in test mode they are never used. */
  get threadsAllowed(): boolean {
    return this.guard?.threadsAllowed ?? true;
  }

  /** In test mode only the allowlisted channel may host panels. */
  allowsChannel(channelId: string): boolean {
    return this.guard ? this.guard.allowsLocation({ channelId, threadId: null }) : true;
  }

  /** The channel new tables are created in: the lobby channel if set, else where the user is. */
  async casinoChannel(guildId: string, fallbackChannelId: string | null): Promise<TextChannel | null> {
    const lobby = this.app.settings.lobby(guildId).channelId;
    for (const id of [lobby, fallbackChannelId]) {
      if (!id || !this.allowsChannel(id)) continue;
      const channel = await this.client.channels.fetch(id).catch(() => null);
      if (channel?.isThread()) {
        const parent = channel.parent;
        if (parent?.type === ChannelType.GuildText) return parent;
      }
      if (channel?.type === ChannelType.GuildText) return channel;
    }
    return null;
  }

  missingPermissions(channel: GuildTextBasedChannel): string[] {
    const me = channel.guild.members.me;
    if (!me) return ['(bot member not cached)'];
    const perms = channel.permissionsFor(me);
    return REQUIRED_CHANNEL_PERMISSIONS.filter(([, flag]) => !perms?.has(flag)).map(([label]) => label);
  }

  /** Create the thread (or channel message) that hosts a new table's panel. */
  async createTablePanel(tableId: string, fallbackChannelId: string | null, creatorId: string): Promise<{ url: string | null }> {
    const snap = this.app.blackjack.peek(tableId);
    if (!snap) return { url: null };
    const channel = await this.casinoChannel(snap.record.guildId, fallbackChannelId);
    if (!channel) throw new Error('No usable text channel for the table');
    const screen = this.checked(await blackjackPanel(this.app, snap));
    const useThreads = this.app.settings.get(snap.record.guildId).tables.useThreads && this.threadsAllowed;
    let thread: ThreadChannel | null = null;
    if (useThreads) {
      try {
        thread = await channel.threads.create({
          name: `blackjack-table-${String(snap.record.number).padStart(2, '0')}`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          type: snap.record.isPrivate ? ChannelType.PrivateThread : ChannelType.PublicThread,
          ...(snap.record.isPrivate ? { invitable: false } : {}),
          reason: `Blackjack table opened by ${creatorId}`,
        });
      } catch (error) {
        this.logger.warn('thread creation failed; using the channel instead', { tableId, code: discordErrorCode(error) });
      }
    }
    const target = thread ?? channel;
    const message = await target.send(createOptions(screen));
    await this.app.blackjack.attachDiscord(tableId, { channelId: channel.id, threadId: thread?.id ?? null, messageId: message.id });
    if (thread && snap.record.isPrivate) await thread.members.add(creatorId).catch(() => undefined);
    this.requestLobby(snap.record.guildId);
    return { url: thread ? thread.url : message.url };
  }

  async addToTableThread(tableId: string, userId: string): Promise<string | null> {
    const snap = this.app.blackjack.peek(tableId);
    if (!snap) return null;
    if (!snap.record.threadId) {
      return snap.record.channelId && snap.record.messageId
        ? `https://discord.com/channels/${snap.record.guildId}/${snap.record.channelId}/${snap.record.messageId}`
        : null;
    }
    const thread = await this.client.channels.fetch(snap.record.threadId).catch(() => null);
    if (thread?.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => undefined);
      // Private threads need explicit membership. Public threads are open to everyone, so we don't
      // add people there (that would post an "X added Y" system line for every join).
      if (snap.record.isPrivate) {
        await thread.members.add(userId).catch((error: unknown) => this.logger.warn('could not add member to thread', { tableId, code: discordErrorCode(error) }));
      }
      return thread.url;
    }
    return null;
  }

  private async recreateTablePanel(tableId: string): Promise<void> {
    const snap = this.app.blackjack.peek(tableId);
    if (!snap) return;
    const { record } = snap;
    // Try to post a fresh panel in the existing thread first.
    if (record.threadId && this.threadsAllowed) {
      const thread = await this.client.channels.fetch(record.threadId).catch(() => null);
      if (thread?.isThread()) {
        if (thread.archived) await thread.setArchived(false).catch(() => undefined);
        const screen = this.checked(await blackjackPanel(this.app, snap));
        const message = await thread.send(createOptions(screen));
        await this.app.blackjack.attachDiscord(tableId, { channelId: record.channelId ?? thread.parentId ?? thread.id, threadId: thread.id, messageId: message.id });
        return;
      }
    }
    try {
      await this.createTablePanel(tableId, record.channelId, record.ownerId);
    } catch (error) {
      this.logger.error('could not recreate table panel; closing table with refunds', { tableId, error });
      await this.app.blackjack.closeTable(tableId, 'the table could not be shown in Discord', { force: true });
    }
  }

  private async onTableClosed(snap: TableSnapshot, reason: string): Promise<void> {
    this.tablePanels.forget(snap.record.id);
    this.requestLobby(snap.record.guildId);
    const channelId = snap.record.threadId ?? snap.record.channelId;
    if (!channelId || !snap.record.messageId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      if (channel.isThread() && channel.archived) await channel.setArchived(false).catch(() => undefined);
      await channel.messages.edit(snap.record.messageId, editOptions(this.checked(closedTablePanel(snap.record.name, reason))));
      if (channel.isThread()) {
        await channel.setLocked(true).catch(() => undefined);
        await channel.setArchived(true, 'Table closed').catch(() => undefined);
      }
    } catch (error) {
      this.logger.debug('closing panel update failed', { code: discordErrorCode(error) });
    }
  }

  // ───────────────────────────── roulette ─────────────────────────────

  async createWheelPanel(wheelId: string, fallbackChannelId: string | null): Promise<string | null> {
    const wheel = this.app.roulette.peek(wheelId);
    if (!wheel) return null;
    const channel = await this.casinoChannel(wheel.record.guildId, fallbackChannelId);
    if (!channel) throw new Error('No usable text channel for roulette');
    const screen = this.checked(await roulettePanel(this.app, wheel));
    let thread: ThreadChannel | null = null;
    if (this.app.settings.get(wheel.record.guildId).tables.useThreads && this.threadsAllowed) {
      thread = await channel.threads
        .create({ name: 'roulette-wheel', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, type: ChannelType.PublicThread, reason: 'Roulette wheel opened' })
        .catch(() => null);
    }
    const message = await (thread ?? channel).send(createOptions(screen));
    await this.app.roulette.attachDiscord(wheelId, { channelId: channel.id, threadId: thread?.id ?? null, messageId: message.id });
    this.requestLobby(wheel.record.guildId);
    return thread?.url ?? message.url;
  }

  private async recreateWheelPanel(wheelId: string): Promise<void> {
    const wheel = this.app.roulette.peek(wheelId);
    if (!wheel) return;
    try {
      await this.createWheelPanel(wheelId, wheel.record.channelId);
    } catch (error) {
      this.logger.error('could not recreate roulette panel; closing with refunds', { wheelId, error });
      await this.app.roulette.close(wheelId, 'panel unavailable');
    }
  }

  private async onWheelClosed(wheel: WheelSnapshot): Promise<void> {
    this.wheelPanels.forget(wheel.record.id);
    this.requestLobby(wheel.record.guildId);
    const channelId = wheel.record.threadId ?? wheel.record.channelId;
    if (!channelId || !wheel.record.messageId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      await channel.messages.edit(
        wheel.record.messageId,
        editOptions({ components: [container(COLORS.charcoal, [text('## 🎡 Roulette — closed\n-# The wheel closed after a quiet spell. Open it again from the casino.')])] }),
      );
      if (channel.isThread()) await channel.setArchived(true).catch(() => undefined);
    } catch {
      // Best effort.
    }
  }

  async coinflipScreen(challengeId: string): Promise<Screen | null> {
    const c = this.app.coinflip.get(challengeId);
    if (!c) return null;
    const names = {
      challenger: this.app.economy.getPlayer(c.guildId, c.challengerId)?.display_name || 'Challenger',
      opponent: this.app.economy.getPlayer(c.guildId, c.opponentId)?.display_name || 'Opponent',
    };
    return this.checked(await coinflipMessage(this.app, c, names));
  }

  // ───────────────────────────── lobby ─────────────────────────────

  /** Debounced lobby refresh (coalesces bursts of table activity into one edit). */
  requestLobby(guildId: string, delayMs = this.timing.lobbyDebounceMs): void {
    if (this.stopping || !this.app.settings.lobby(guildId).channelId) return;
    if (this.lobbyTimers.has(guildId)) return;
    const timer = setTimeout(() => {
      this.lobbyTimers.delete(guildId);
      const previous = this.lobbyBusy.get(guildId) ?? Promise.resolve();
      const next = previous
        .then(async () => {
          await this.syncLobby(guildId);
        })
        .catch((error: unknown) => this.logger.warn('lobby sync failed', { guildId, error }));
      this.lobbyBusy.set(guildId, next);
    }, delayMs);
    timer.unref?.();
    this.lobbyTimers.set(guildId, timer);
  }

  /** Edit the stored lobby message; if it was deleted, post a new one (never duplicates). */
  async syncLobby(guildId: string): Promise<string | null> {
    const { channelId, messageId } = this.app.settings.lobby(guildId);
    if (!channelId) return null;
    if (!this.allowsChannel(channelId)) {
      this.logger.warn('test mode: lobby channel is outside the allowlist; not updating it', { guildId, channelId });
      return null;
    }
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      this.logger.warn('lobby channel unavailable', { guildId, channelId });
      return null;
    }
    const screen = this.checked(await lobbyScreen(this.app, guildId));
    const file = primaryFileName(screen);
    if (messageId) {
      try {
        const reuse = this.lobbyFiles.get(guildId) === file;
        await channel.messages.edit(messageId, editOptions(screen, reuse));
        this.lobbyFiles.set(guildId, file);
        return messageId;
      } catch (error) {
        const code = discordErrorCode(error);
        if (code !== DISCORD_ERRORS.unknownMessage) {
          this.logger.warn('lobby edit failed', { guildId, code });
          return messageId;
        }
      }
    }
    const message = await channel.send(createOptions(screen));
    this.app.settings.setLobby(guildId, channel.id, message.id);
    this.lobbyFiles.set(guildId, file);
    return message.id;
  }

  /** `/casinoadmin setup`: move or create the lobby in a channel. */
  async setupLobby(guildId: string, channel: TextChannel): Promise<{ url: string; missing: string[] }> {
    const missing = this.missingPermissions(channel);
    const blocking = missing.filter((p) => ['ViewChannel', 'SendMessages', 'AttachFiles', 'EmbedLinks'].includes(p));
    if (blocking.length) return { url: '', missing };
    const previous = this.app.settings.lobby(guildId);
    if (previous.channelId && previous.channelId !== channel.id && previous.messageId) {
      const old = await this.client.channels.fetch(previous.channelId).catch(() => null);
      if (old?.isTextBased()) await old.messages.delete(previous.messageId).catch(() => undefined);
      this.app.settings.setLobby(guildId, channel.id, null);
    } else if (!previous.channelId) {
      this.app.settings.setLobby(guildId, channel.id, null);
    }
    this.lobbyFiles.delete(guildId);
    const messageId = await this.syncLobby(guildId);
    return { url: `https://discord.com/channels/${guildId}/${channel.id}/${messageId ?? ''}`, missing };
  }
}
