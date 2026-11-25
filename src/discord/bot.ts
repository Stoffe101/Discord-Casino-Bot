import { warmCasinoArtwork } from '../render/casino-art.js';
import { warmFloorArt } from '../render/floor-art.js';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type ClientOptions,
  type Interaction,
  type GuildTextBasedChannel,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import { UserError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { RenderHint, TableSnapshot } from '../tables/types.js';
import { PRIVATE_TABLES_NEED_THREADS } from '../tables/blackjack-table-service.js';
import type { PokerRenderHint, PokerSnapshot } from '../games/poker/poker-service.js';
import { pokerPanel } from '../ui/screens/poker.js';
import type { WheelSnapshot } from '../games/roulette/roulette-service.js';
import { blackjackPanel, closedTablePanel } from '../ui/screens/blackjack.js';
import { roulettePanel, coinflipMessage } from '../ui/screens/games.js';
import { lobbyScreen } from '../ui/screens/lobby.js';
import { assertValidScreen } from '../ui/validate.js';
import type { Screen } from '../ui/kit.js';
import { PanelSync, sleep, type PanelLocation } from './panel-sync.js';
import { DISCORD_ERRORS, createOptions, discordErrorCode, editOptions, primaryFileName, screenDigest } from './payload.js';
import { InteractionRouter } from './router.js';
import type { AdmissionCandidate, OutboundGuard } from './outbound-guard.js';
import { tidyCasinoChannels } from './channel-tidy.js';

/** The casino channel is tidied this long after startup, once panels and the lobby have settled. */
const TIDY_DELAY_MS = 30_000;
import { RestMetrics } from './rest-metrics.js';
import { SosseNicknames, type NicknameMembers } from '../domain/sosse-nicknames.js';
import { discordNicknameMembers } from './sosse-members.js';

export interface BotTiming {
  /** Delay between dealer-reveal frames. */
  frameDelayMs: number;
  /** Delay after the first pass of the deal. */
  dealFrameMs: number;
  /** Delay between roulette spin frames. */
  spinFrameMs: number;
  /** Multiplier for animated frames' own length (1 = real time; 0 in fast tests). */
  animationScale: number;
  /** Minimum gap between two edits of the same table/wheel panel (when no click is waiting). */
  tableMinIntervalMs: number;
  wheelMinIntervalMs: number;
  /** Lobby refreshes are debounced so bursts of table activity become one edit. */
  lobbyDebounceMs: number;
  /**
   * The first maintenance sweep (idle closes, close reconciliation) runs this soon after ready;
   * then every MAINTENANCE_INTERVAL_MS. A table therefore closes within one interval of its idle
   * threshold: empty tables 3:00–4:00 and occupied ones 5:00–6:00 after the last activity
   * (default settings).
   */
  firstSweepMs: number;
}

export const DEFAULT_TIMING: BotTiming = { frameDelayMs: 700, dealFrameMs: 450, spinFrameMs: 650, animationScale: 1, tableMinIntervalMs: 350, wheelMinIntervalMs: 500, lobbyDebounceMs: 2_500, firstSweepMs: 5_000 };

/** An unchanged lobby is still re-sent this often (which also notices a deleted lobby message). */
const LOBBY_RECHECK_MS = 10 * 60_000;

/** Idle sweeps and close reconciliation run this often (see BotTiming.firstSweepMs). */
export const MAINTENANCE_INTERVAL_MS = 60_000;
/** Closed tables whose Discord side is reconciled per sweep (an old backlog drains gradually). */
const RECONCILE_BATCH = 10;

export const NO_CASINO_CHANNEL =
  'Tables open in the casino channel, and this server has not set one up yet. Ask a server manager to run /casinoadmin setup in the casino channel.';

/** What closing a table's Discord side achieved: done (or nothing left to do), retry later, or not ours to touch. */
type CloseOutcome = 'done' | 'retry' | 'skip';

interface ClosedTableRow {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string | null;
  thread_id: string | null;
  message_id: string | null;
}

/** Which animation frame of a table panel to draw for a given render hint. */
export function tableFrame(frame: number | undefined, hint: RenderHint | undefined): { revealStep?: number; dealStep?: number } {
  if (frame === undefined || !hint) return {};
  if (hint.kind === 'dealt') return { dealStep: 0 };
  if (hint.kind === 'round_settled') {
    if (hint.dealt && frame === 0) return { dealStep: 0 };
    return { revealStep: frame - (hint.dealt ? 1 : 0) };
  }
  return {};
}

export interface CasinoBotOptions {
  nicknameGuildId?: string | undefined;
  nicknameMembers?: NicknameMembers;
  guard?: OutboundGuard | null;
  /** Animated GIFs for dealing, draws, reveals and spins (default true; fast tests turn it off). */
  animations?: boolean;
  /** Replace the HTTP layer (tests use an in-memory Discord). */
  makeRequest?: NonNullable<ClientOptions['rest']>['makeRequest'];
  timing?: Partial<BotTiming>;
}

/** What the guard needs to know about an incoming interaction (thread parent included). */
function admissionOf(interaction: Interaction): AdmissionCandidate {
  const channel = interaction.channel;
  return {
    id: interaction.id,
    token: interaction.token,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentId: channel && channel.isThread() ? channel.parentId : null,
  };
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
  readonly pokerPanels: PanelSync<PokerRenderHint>;
  readonly wheelPanels: PanelSync<boolean>;
  readonly router: InteractionRouter;
  private readonly lobbyTimers = new Map<string, NodeJS.Timeout>();
  private readonly lobbyFiles = new Map<string, string | null>();
  /** What each lobby message last showed, so refreshes that change nothing send nothing. */
  private readonly lobbyShown = new Map<string, { messageId: string; digest: string; at: number }>();
  private readonly lobbyBusy = new Map<string, Promise<void>>();
  private readonly intervals: NodeJS.Timeout[] = [];
  private firstSweep: NodeJS.Timeout | null = null;
  private tidySweep: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private stopping = false;
  private maintaining = false;
  /** Tables whose Discord side is being closed right now (reconciliation leaves them alone). */
  private readonly closingPanels = new Set<string>();
  /** Closed tables whose thread is not ours to touch (foreign, outside the allowlist): skipped until restart. */
  private readonly reconcileSkipped = new Set<string>();
  /** Seated players of each private table, so leavers can be removed from its private thread. */
  private readonly privateMembers = new Map<string, Set<string>>();
  readonly guard: OutboundGuard | null;
  readonly timing: BotTiming;
  readonly restMetrics = new RestMetrics();
  readonly animations: boolean;
  readonly nicknames: SosseNicknames | null;

  constructor(
    readonly app: CasinoApp,
    readonly logger: Logger,
    options: CasinoBotOptions = {},
  ) {
    this.guard = options.guard ?? null;
    this.animations = options.animations ?? true;
    const timing = { ...DEFAULT_TIMING, ...options.timing };
    this.timing = timing;
    // Only the Guilds intent: no message content, no member lists, no presences.
    // Mentions never ping unless a message explicitly allows it (the coinflip challenge does).
    this.client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [], repliedUser: false }, ...(options.makeRequest ? { rest: { makeRequest: options.makeRequest } } : {}) });
    // Innermost wrapper, next to the network: time every Discord request that is actually sent.
    this.restMetrics.install(this.client.rest);
    // Test mode: every outgoing request passes the allowlist check first (outermost, so refused
    // requests never reach the network or the metrics).
    this.guard?.install(this.client.rest);
    // Outside test mode the service always exists, so pending restorations still run when the
    // approved server is unset or changed; with no approved server ('') nicknames are never offered.
    this.nicknames = this.guard ? null
      : new SosseNicknames(app, options.nicknameGuildId ?? '', options.nicknameMembers ?? discordNicknameMembers(this.client));
    const guard = this.guard;
    this.tablePanels = new PanelSync<RenderHint>({
      name: 'table',
      client: this.client,
      logger,
      locate: (id) => app.blackjack.peek(id)?.record,
      render: async (id, frame, hint) => {
        const snap = app.blackjack.peek(id);
        if (!snap) return null;
        // Animated GIF of the change (cards dealt / drawn / revealed, chips paid); still frames otherwise.
        if (frame !== undefined && hint && this.animations) return this.checked(await blackjackPanel(app, snap, { animation: hint }));
        return this.checked(await blackjackPanel(app, snap, tableFrame(frame, hint)));
      },
      // With animations: one GIF per change, then the final still. Without: still frames for the
      // deal pass and each dealer card.
      frames: (id, hint) => {
        const snap = app.blackjack.peek(id);
        if (!snap || !hint || !app.settings.get(snap.record.guildId).blackjack.dealerAnimation) return 0;
        if (this.animations) return hint.kind === 'dealt' || hint.kind === 'drawn' || hint.kind === 'round_settled' ? 1 : 0;
        if (hint.kind === 'dealt') return 1;
        if (hint.kind === 'round_settled') return (hint.dealt ? 1 : 0) + Math.min(hint.dealerSteps, 5);
        return 0;
      },
      holdScale: timing.animationScale,
      frameBudgetMs: (id, hint) => hint?.kind === 'dealt' && app.blackjack.peek(id)?.state.phase === 'playing' ? 1100 : undefined,
      frameDelayMs: (hint) => (hint?.kind === 'dealt' ? timing.dealFrameMs : timing.frameDelayMs),
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
      render: async (id, frame) => {
        const w = app.roulette.peek(id);
        if (!w) return null;
        if (frame === undefined) return this.checked(await roulettePanel(app, w));
        return this.checked(await roulettePanel(app, w, this.animatesGames(w.record.guildId) ? { animate: true } : { spinFrame: frame }));
      },
      // A spin plays the wheel turning and the ball dropping (one GIF), or two stills without animations.
      frames: (id, spun) => {
        const w = app.roulette.peek(id);
        return spun && w ? (this.animatesGames(w.record.guildId) ? 1 : 2) : 0;
      },
      holdScale: timing.animationScale,
      frameDelayMs: timing.spinFrameMs,
      minIntervalMs: timing.wheelMinIntervalMs,
      onMissing: (id) => this.recreateWheelPanel(id),
    });
    this.pokerPanels = new PanelSync<PokerRenderHint>({
      name: 'poker',
      client: this.client,
      logger,
      locate: (id) => app.poker.peek(id)?.record,
      render: async (id, frame, hint) => {
        const table = app.poker.peek(id);
        return table ? this.checked(await pokerPanel(app, table, frame === undefined ? undefined : hint)) : null;
      },
      frames: (id, hint) => {
        const table = app.poker.peek(id);
        return table && this.animatesGames(table.record.guildId) && hint && hint !== 'update' ? 1 : 0;
      },
      holdScale: timing.animationScale,
      minIntervalMs: timing.tableMinIntervalMs,
      frameBudgetMs: () => 1000,
      onMissing: (id) => this.recreatePokerPanel(id),
    });
    this.router = new InteractionRouter(app, this);

    // Refuse up front (with a private explanation) what Discord could not host.
    app.blackjack.setCreationCheck((guildId, { isPrivate }) => {
      if (!this.casinoChannelIds(guildId).length) throw new UserError(NO_CASINO_CHANNEL, 'no_casino_channel', 'Casino not set up');
      if (isPrivate && !this.privateThreadsAvailable(guildId)) throw new UserError(PRIVATE_TABLES_NEED_THREADS, 'private_unavailable', 'Private tables unavailable');
    });
    app.blackjack.setObserver({
      tableChanged: (id, hint, origin) => {
        if (this.stopping) return;
        this.tablePanels.request(id, hint, this.router.claim(origin));
        const snap = app.blackjack.peek(id);
        if (snap) {
          this.syncPrivateMembers(id, snap.record, snap.state.seats.map((s) => s.userId));
          this.requestLobby(snap.record.guildId);
        }
      },
      tableClosed: (snap, reason) => this.track(this.onTableClosed(snap, reason)),
    });
    app.events.onChanged((guildId) => this.requestLobby(guildId));
    app.poker.setObserver({
      changed: (id, hint, origin) => {
        if (this.stopping) return;
        const snapshot = app.poker.peek(id);
        if (!snapshot) return;
        if (snapshot.record.messageId) this.pokerPanels.request(id, hint, this.router.claim(origin));
        this.syncPrivateMembers(id, snapshot.record, snapshot.state.seats.map((s) => s.userId));
        this.requestLobby(snapshot.record.guildId);
      },
      closed: (snapshot, reason) => this.track(this.onTableClosed(snapshot, reason, 'poker')),
    });
    app.roulette.setObserver({
      wheelChanged: (id, spun, origin) => {
        if (this.stopping) return;
        this.wheelPanels.request(id, spun, this.router.claim(origin));
        const w = app.roulette.peek(id);
        if (w) this.requestLobby(w.record.guildId);
      },
      wheelClosed: (w) => this.track(this.onWheelClosed(w)),
    });
    app.coinflip.setObserver({
      challengeChanged: (challenge) => this.track(this.router.refreshChallenge(challenge)),
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (guard && !guard.admitInteraction(admissionOf(interaction))) return;
      this.track(this.router.handle(interaction));
    });
    this.client.on(Events.Error, (error) => logger.error('discord client error', { error }));
    this.client.on(Events.Warn, (message) => logger.warn('discord client warning', { message }));
    this.client.rest.on('rateLimited', (info) => logger.debug('rate limited', { route: info.route, timeToReset: info.timeToReset }));
    this.client.once(Events.ClientReady, (c) => void this.onReady(c.user.tag));
    if (guard?.threadsAllowed) {
      // Threads the gateway reports are verified against the allowlist (parent + server).
      this.client.on(Events.ThreadCreate, (thread) => void guard.learnThread({ id: thread.id, parentId: thread.parentId, guildId: thread.guildId }));
      this.client.on(Events.ThreadUpdate, (_old, thread) => void guard.learnThread({ id: thread.id, parentId: thread.parentId, guildId: thread.guildId }));
    }
  }

  async start(token: string): Promise<void> {
    void warmCasinoArtwork();
    void warmFloorArt().catch((error: unknown) => this.logger.warn('floor art warm-up failed', { error }));
    const recovery = this.app.recover();
    this.logger.info('recovery complete', recovery);
    await this.client.login(token);
  }

  /** Runs once the gateway is ready (tests call it directly): re-attach panels, refresh lobbies, start upkeep. */
  async onReady(tag: string): Promise<void> {
    this.logger.info(`logged in as ${tag}`, { guilds: this.client.guilds.cache.size });
    if (this.guard) {
      const { guildId, channelId } = this.guard.allow;
      for (const channel of this.client.channels.cache.values()) {
        if (channel.isThread()) this.guard.learnThread({ id: channel.id, parentId: channel.parentId, guildId: channel.guildId });
      }
      this.logger.info(`TEST MODE: outgoing Discord actions are limited to one channel${this.guard.threadsAllowed ? ' and its threads' : '; threads are disabled'}`, { guildId, channelId, knownThreads: this.guard.knownThreads.size });
      if (!this.app.settings.lobby(guildId).channelId) this.app.settings.setLobby(guildId, channelId, null);
    }
    // Re-attach every restored panel (recreating missing ones) and refresh lobbies.
    for (const snap of this.app.blackjack.allOpenTables()) {
      this.syncPrivateMembers(snap.record.id, snap.record, snap.state.seats.map((s) => s.userId));
      if (!snap.record.messageId) await this.recreateTablePanel(snap.record.id);
      else this.tablePanels.request(snap.record.id, { kind: 'restored' });
    }
    for (const table of this.app.poker.openTables()) {
      this.syncPrivateMembers(table.record.id, table.record, table.state.seats.map((s) => s.userId));
      if (!table.record.messageId) await this.recreatePokerPanel(table.record.id);
      else this.pokerPanels.request(table.record.id);
    }
    this.app.roulette.touchAll();
    for (const { guildId } of this.app.settings.guildsWithLobby()) this.requestLobby(guildId, 0);
    // Closes whose Discord side failed or was interrupted (e.g. by a crash) are finished now.
    this.track(this.reconcileClosedTables().then(() => undefined));
    // Keep #casino to the lobby and live challenges: remove the bot's own leftovers, once startup
    // (panel recovery, lobby sync) has settled, at low priority.
    this.tidySweep = setTimeout(() => this.track(tidyCasinoChannels(this.client, this.app, this.guard, this.logger).then(() => undefined, () => undefined)), TIDY_DELAY_MS);
    this.tidySweep.unref?.();
    this.firstSweep = setTimeout(() => this.track(this.maintenance()), this.timing.firstSweepMs);
    this.firstSweep.unref?.();
    this.intervals.push(
      setInterval(() => this.track(this.maintenance()), MAINTENANCE_INTERVAL_MS),
      setInterval(() => this.auditBooks(), 60 * 60_000),
      setInterval(() => this.logMetrics(), 10 * 60_000),
    );
    this.auditBooks();
    if (this.nicknames) this.track(this.nicknames.restoreDue());
  }

  private async maintenance(): Promise<void> {
    if (this.maintaining || this.stopping) return; // a slow pass is never overlapped by the next one
    this.maintaining = true;
    // Each step runs on its own: one failing never skips the others.
    const step = async (name: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        this.logger.error('maintenance step failed', { step: name, error });
      }
    };
    try {
      await step('idle tables', async () => {
        await this.app.blackjack.sweepIdle();
        await this.app.roulette.sweepIdle();
        await this.app.poker.sweepIdle();
      });
      await step('close reconciliation', () => this.reconcileClosedTables());
      await step('nickname restoration', async () => this.nicknames?.restoreDue());
    } finally {
      this.maintaining = false;
    }
  }

  /** Periodic performance line in the log: Discord API timings, interaction handling, panels. */
  logMetrics(): void {
    const r = this.router.latency;
    this.logger.info('metrics', {
      discordApi: this.restMetrics.summary(),
      rateLimited: this.restMetrics.rateLimited,
      interactions: { count: r.count, avgMs: r.count ? Math.round(r.totalMs / r.count) : 0, maxMs: r.maxMs },
      panels: this.tablePanels.stats,
      images: { hits: this.app.images.hits, renders: this.app.images.misses },
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      guard: this.guard ? { allowed: this.guard.allowedCount, blocked: this.guard.blockedCount } : null,
    });
  }

  private auditBooks(): void {
    const issues = this.app.economy.reconcile();
    if (issues.length) this.logger.error('LEDGER RECONCILIATION FAILED', { issues: issues.slice(0, 20), count: issues.length });
    else this.logger.debug('ledger reconciled');
  }

  /** Background work (interactions, close-time cleanup) that idle() and stop() wait for. */
  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error: unknown) => this.logger.error('background task failed', { error }))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves once every in-flight interaction, game action and panel/lobby update has finished. */
  async idle(): Promise<void> {
    for (let pass = 0; pass < 100; pass++) {
      await Promise.all([...this.inflight]);
      await Promise.all([this.app.blackjack.idle(), this.app.poker.idle()]);
      await Promise.all([this.tablePanels.idle(), this.wheelPanels.idle(), this.pokerPanels.idle()]);
      await Promise.all([...this.lobbyBusy.values()]);
      if (this.inflight.size === 0 && this.lobbyTimers.size === 0) return;
      await sleep(5);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.firstSweep) clearTimeout(this.firstSweep);
    if (this.tidySweep) clearTimeout(this.tidySweep);
    for (const t of this.intervals) clearInterval(t);
    for (const t of this.lobbyTimers.values()) clearTimeout(t);
    this.logMetrics();
    // Let interactions that are already being handled finish before disconnecting.
    await Promise.race([Promise.all([...this.inflight]), sleep(5_000)]);
    await Promise.race([Promise.all([this.tablePanels.idle(), this.wheelPanels.idle(), this.pokerPanels.idle()]), sleep(5_000)]);
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

  /** Animated roulette spins, slot reels and coin tosses for this server (blackjack has its own switch). */
  /**
   * True while the table panel is still showing (or about to show) the end of a hand — the
   * dealer's turn and the payout — so a private view must not tell the result yet. Other redraws
   * (a bet, a countdown, someone sitting out) don't count.
   */
  /** Let an in-flight animation finish. Repair the panel if a previous edit failed. */
  refreshIdleTable(tableId: string): boolean {
    if (this.tablePanels.showing(tableId, () => true)) return true;
    this.tablePanels.request(tableId);
    return false;
  }

  tableAnimating(tableId: string): boolean {
    return this.tablePanels.showing(tableId, (hint) => hint?.kind === 'round_settled');
  }

  animatesGames(guildId: string): boolean {
    return this.animations && this.app.settings.get(guildId).animations;
  }

  /** Threads are separate channels; in test mode they are never used. */
  get threadsAllowed(): boolean {
    return this.guard?.threadsAllowed ?? true;
  }

  /** In test mode a thread is usable only if it is a verified child of the allowlisted channel. */
  allowsThread(thread: ThreadChannel): boolean {
    return this.guard ? this.guard.learnThread({ id: thread.id, parentId: thread.parentId, guildId: thread.guildId }) : true;
  }

  /** In test mode only the allowlisted channel may host panels. */
  allowsChannel(channelId: string): boolean {
    return this.guard ? this.guard.allowsLocation({ channelId, threadId: null }) : true;
  }

  /** Private tables need table threads that the bot may use here (never a public fallback). */
  privateThreadsAvailable(guildId: string): boolean {
    return this.app.settings.get(guildId).tables.useThreads && this.threadsAllowed;
  }

  /**
   * Where tables may be opened, in order: the configured lobby channel, then (test mode) the
   * allowlisted channel. Never the channel a player happened to click in.
   */
  private casinoChannelIds(guildId: string): string[] {
    const guardChannel = this.guard && this.guard.allow.guildId === guildId ? this.guard.allow.channelId : null;
    const ids = [this.app.settings.lobby(guildId).channelId, guardChannel];
    return ids.filter((id, index): id is string => !!id && ids.indexOf(id) === index && this.allowsChannel(id));
  }

  /** The casino channel new tables and wheels are created in, or null when none is usable. */
  async casinoChannel(guildId: string): Promise<TextChannel | null> {
    for (const id of this.casinoChannelIds(guildId)) {
      const channel = await this.client.channels.fetch(id).catch(() => null);
      if (!channel || !('guildId' in channel) || channel.guildId !== guildId) continue;
      if (channel.isThread()) {
        const parent = channel.parent;
        if (parent?.type === ChannelType.GuildText && this.allowsChannel(parent.id)) return parent;
      }
      if (channel.type === ChannelType.GuildText) return channel;
    }
    return null;
  }

  missingPermissions(channel: GuildTextBasedChannel): string[] {
    const me = channel.guild.members.me;
    if (!me) return ['(bot member not cached)'];
    const perms = channel.permissionsFor(me);
    return REQUIRED_CHANNEL_PERMISSIONS.filter(([, flag]) => !perms?.has(flag)).map(([label]) => label);
  }

  /**
   * Create the thread (or, for public tables without threads, the channel message) that hosts a
   * new table's panel, always in the casino channel. A private table is only ever posted inside a
   * private thread its host was added to; anything less fails, and the caller closes the table
   * with refunds. `_requestedFrom` (where the player clicked) is deliberately ignored.
   */
  async createTablePanel(tableId: string, _requestedFrom: string | null, creatorId: string): Promise<{ url: string | null }> {
    const blackjack = this.app.blackjack.peek(tableId);
    const poker = this.app.poker.peek(tableId);
    const record = (blackjack ?? poker)?.record;
    if (!record) return { url: null };
    const channel = await this.casinoChannel(record.guildId);
    if (!channel) throw new Error('No casino channel is configured for tables');
    const screen = this.checked(poker ? await pokerPanel(this.app, poker) : await blackjackPanel(this.app, blackjack!));
    const useThreads = this.app.settings.get(record.guildId).tables.useThreads && this.threadsAllowed;
    if (record.isPrivate && !useThreads) throw new Error('Private tables need verified private threads.');
    let thread: ThreadChannel | null = null;
    if (useThreads) {
      try {
        thread = await channel.threads.create({
          name: `${poker ? 'poker' : 'blackjack'}-table-${String(record.number).padStart(2, '0')}`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          type: record.isPrivate ? ChannelType.PrivateThread : ChannelType.PublicThread,
          ...(record.isPrivate ? { invitable: false } : {}),
          reason: 'Casino table opened',
        });
      } catch (error) {
        if (record.isPrivate) throw error; // never fall back to a public post
        this.logger.warn('thread creation failed; using the channel instead', { tableId, code: discordErrorCode(error) });
      }
    }
    try {
      // The host joins a private thread before anything is posted; if that fails, so does the table.
      if (thread && record.isPrivate) await thread.members.add(creatorId);
      const message = await (thread ?? channel).send(createOptions(screen));
      const location = { channelId: channel.id, threadId: thread?.id ?? null, messageId: message.id };
      if (poker) await this.app.poker.attach(tableId, location);
      else await this.app.blackjack.attachDiscord(tableId, location);
      if (thread && !record.isPrivate) this.track(this.removeThreadNotice(channel, thread.id));
      if (thread && record.isPrivate) this.privateMembers.set(tableId, new Set([creatorId]));
      this.requestLobby(record.guildId);
      return { url: thread ? thread.url : message.url };
    } catch (error) {
      if (thread) await this.discardThread(channel, thread, record.isPrivate);
      throw error;
    }
  }

  /** A thread created for a table that could not be set up: locked, archived and its notice removed. */
  private async discardThread(channel: TextChannel, thread: ThreadChannel, isPrivate: boolean): Promise<void> {
    await thread.edit({ locked: true, archived: true, reason: 'Casino table setup failed' }).catch((error: unknown) =>
      this.logger.warn('could not lock an abandoned table thread', { threadId: thread.id, code: discordErrorCode(error) }));
    if (!isPrivate) this.track(this.removeThreadNotice(channel, thread.id));
  }

  /** Delete the bot's own "started a thread" system message for a thread it just created. */
  private async removeThreadNotice(channel: TextChannel, threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const recent = await channel.messages.fetch({ limit: 10, cache: false }).catch(() => null);
      const notice = recent?.find(
        (m) => m.type === MessageType.ThreadCreated && m.author.id === this.client.user?.id && (m.reference?.channelId === threadId || m.thread?.id === threadId),
      );
      if (notice) {
        this.guard?.allowDelete(notice.id); // the bot's own notice for its own thread
        await notice.delete().catch((error: unknown) => this.logger.debug('could not remove thread notice', { code: discordErrorCode(error) }));
        return;
      }
      await sleep(400 * (attempt + 1));
    }
  }

  /**
   * Make sure a player can open the table: a link to it, and for a private table membership of its
   * private thread. For private tables a failure throws, so the caller can release the seat.
   */
  async addToTableThread(tableId: string, userId: string): Promise<string | null> {
    const poker = this.app.poker.peek(tableId);
    const snap = this.app.blackjack.peek(tableId) ?? poker;
    if (!snap) return null;
    if (!snap.record.threadId) {
      return snap.record.channelId && snap.record.messageId
        ? `https://discord.com/channels/${snap.record.guildId}/${snap.record.channelId}/${snap.record.messageId}`
        : null;
    }
    const thread = await this.client.channels.fetch(snap.record.threadId).catch(() => null);
    if (!thread?.isThread()) {
      if (snap.record.isPrivate) throw new Error('The private table thread is unavailable');
      return null;
    }
    if (thread.archived) await thread.setArchived(false).catch(() => undefined);
    // Private threads need explicit membership. Public threads are open to everyone, so we don't
    // add people there (that would post an "X added Y" system line for every join).
    if (snap.record.isPrivate) await thread.members.add(userId);
    return thread.url;
  }

  /**
   * Track who sits at each private table; whoever leaves (or is removed) is taken out of its
   * private thread. The test-mode guard only permits adding thread members, so removal is
   * skipped there.
   */
  private syncPrivateMembers(tableId: string, record: { isPrivate: boolean; threadId: string | null }, seated: string[]): void {
    if (!record.isPrivate || !record.threadId) {
      this.privateMembers.delete(tableId);
      return;
    }
    const current = new Set(seated);
    const before = this.privateMembers.get(tableId);
    this.privateMembers.set(tableId, current);
    if (!before) return;
    for (const userId of before) {
      if (!current.has(userId)) this.track(this.removeFromThread(tableId, record.threadId, userId));
    }
  }

  private async removeFromThread(tableId: string, threadId: string, userId: string): Promise<void> {
    const thread = await this.client.channels.fetch(threadId).catch(() => null);
    if (!thread?.isThread() || !this.allowsThread(thread)) return;
    await thread.members.remove(userId).catch((error: unknown) =>
      this.logger.warn('could not remove a player from the private table thread', { tableId, code: discordErrorCode(error) }));
  }

  /** A new private thread only holds the host: bring every other seated player back (or release their seat). */
  private async readdSeatedPlayers(tableId: string, hostId: string): Promise<void> {
    for (const seat of [...(this.app.blackjack.peek(tableId)?.state.seats ?? [])]) {
      if (seat.userId === hostId) continue;
      try {
        await this.addToTableThread(tableId, seat.userId);
      } catch (error) {
        this.logger.warn('could not re-add a player to the private table thread; releasing the seat', { tableId, code: discordErrorCode(error) });
        await this.app.blackjack.leave(tableId, seat.userId).catch(() => undefined);
      }
    }
  }

  private async recreateTablePanel(tableId: string): Promise<void> {
    const snap = this.app.blackjack.peek(tableId);
    if (!snap) return;
    const { record } = snap;
    // Try to post a fresh panel in the existing thread first.
    if (record.threadId && this.threadsAllowed) {
      try {
        const thread = await this.client.channels.fetch(record.threadId).catch(() => null);
        if (thread?.isThread() && this.allowsThread(thread) && (!record.isPrivate || thread.type === ChannelType.PrivateThread)) {
          if (thread.archived) await thread.setArchived(false).catch(() => undefined);
          const screen = this.checked(await blackjackPanel(this.app, snap));
          const message = await thread.send(createOptions(screen));
          await this.app.blackjack.attachDiscord(tableId, { channelId: record.channelId ?? thread.parentId ?? thread.id, threadId: thread.id, messageId: message.id });
          return;
        }
      } catch (error) {
        this.logger.warn('could not re-post the table panel in its thread; moving the table', { tableId, code: discordErrorCode(error) });
      }
    }
    const previous = { ...record };
    try {
      await this.createTablePanel(tableId, null, record.ownerId);
      if (record.isPrivate) await this.readdSeatedPlayers(tableId, record.ownerId);
    } catch (error) {
      this.logger.error('could not recreate table panel; closing table with refunds', { tableId, error });
      await this.app.blackjack.closeTable(tableId, 'the table could not be shown in Discord', { force: true });
      return;
    }
    // The table moved: close the thread it left behind (only if it is ours to touch).
    if (previous.threadId && this.threadsAllowed && previous.threadId !== this.app.blackjack.peek(tableId)?.record.threadId) {
      await this.closePanel({ ...previous, messageId: null }, 'moved to a new thread');
    }
  }

  private async recreatePokerPanel(id: string): Promise<void> {
    const table = this.app.poker.peek(id);
    if (!table) return;
    const { record } = table;
    const thread = record.threadId ? await this.client.channels.fetch(record.threadId).catch(() => null) : null;
    try {
      if (thread?.isThread() && this.allowsThread(thread) && (!record.isPrivate || thread.type === ChannelType.PrivateThread)) {
        if (thread.archived) await thread.setArchived(false);
        const message = await thread.send(createOptions(this.checked(await pokerPanel(this.app, table))));
        await this.app.poker.attach(id, { channelId: thread.parentId, threadId: thread.id, messageId: message.id });
      } else {
        await this.createTablePanel(id, null, record.ownerId);
        if (record.isPrivate) for (const seat of table.state.seats) {
          if (seat.userId !== record.ownerId) await this.addToTableThread(id, seat.userId);
        }
      }
    } catch {
      this.logger.warn('Poker panel could not be restored', { tableId: id });
      await this.app.poker.close(id, 'the table could not be shown in Discord');
    }
  }

  private async onTableClosed(snap: TableSnapshot | PokerSnapshot, reason: string, game: 'blackjack' | 'poker' = 'blackjack'): Promise<void> {
    const { id } = snap.record;
    this.app.events.tableClosed(snap.record.guildId, id);
    this.privateMembers.delete(id);
    this.requestLobby(snap.record.guildId);
    this.closingPanels.add(id);
    try {
      await (game === 'poker' ? this.pokerPanels : this.tablePanels).retire(id);
      this.noteClosed(id, await this.closePanel(snap.record, reason));
    } finally {
      this.closingPanels.delete(id);
    }
  }

  /** Persist whether a closed table's Discord side is finished (reconciliation picks up the rest). */
  private noteClosed(tableId: string, outcome: CloseOutcome): void {
    if (outcome === 'skip') this.reconcileSkipped.add(tableId);
    if (outcome !== 'done') return;
    this.app.db.run("UPDATE game_tables SET discord_closed_at = ? WHERE id = ? AND status = 'closed'", [this.app.clock.now(), tableId]);
  }

  /**
   * Finish the Discord side of closed tables that never completed it — the lock/archive failed or
   * the process stopped first. Runs at startup and on every maintenance sweep, a small batch at a
   * time, most recent first. Only threads the bot owns in the table's server, under the table's
   * channel (and, in test mode, verified by the guard) are touched; others are skipped.
   */
  async reconcileClosedTables(limit = RECONCILE_BATCH): Promise<number> {
    if (!this.threadsAllowed) return 0;
    const excluded = this.reconcileSkipped.size + this.closingPanels.size;
    const rows = this.app.db.all<ClosedTableRow>(
      `SELECT id, guild_id, name, channel_id, thread_id, message_id FROM game_tables
       WHERE status = 'closed' AND thread_id IS NOT NULL AND discord_closed_at IS NULL
       ORDER BY closed_at DESC LIMIT ?`,
      [limit + excluded],
    );
    let done = 0;
    for (const row of rows.filter((r) => !this.reconcileSkipped.has(r.id) && !this.closingPanels.has(r.id)).slice(0, limit)) {
      if (this.stopping) break;
      if (this.guard && row.guild_id !== this.guard.allow.guildId) {
        this.reconcileSkipped.add(row.id);
        continue;
      }
      const outcome = await this.closePanel({ guildId: row.guild_id, name: row.name, channelId: row.channel_id, threadId: row.thread_id, messageId: row.message_id }, 'closed');
      this.noteClosed(row.id, outcome);
      if (outcome === 'done') done++;
    }
    if (done) this.logger.info('reconciled closed tables in Discord', { done });
    return done;
  }

  /** A table thread the bot created in the table's server, under the table's channel, and allowed by the guard. */
  private ownsTableThread(thread: ThreadChannel, record: { guildId: string; channelId: string | null }): boolean {
    if (thread.guildId !== record.guildId) return false;
    if (record.channelId && thread.parentId !== record.channelId) return false;
    if (thread.ownerId && this.client.user && thread.ownerId !== this.client.user.id) return false;
    return this.allowsThread(thread);
  }

  /** Show the closed state on the old panel, then lock and archive the table's thread. */
  private async closePanel(record: PanelLocation & { guildId: string; name: string }, reason: string): Promise<CloseOutcome> {
    const channelId = record.threadId ?? record.channelId;
    if (!channelId) return 'done';
    if (record.threadId && !this.threadsAllowed) return 'skip'; // test mode without threads: not ours to touch
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (error) {
      return discordErrorCode(error) === DISCORD_ERRORS.unknownChannel ? 'done' : 'retry'; // a deleted thread is closed enough
    }
    if (!channel?.isTextBased()) return 'done';
    if (channel.isThread() ? !this.ownsTableThread(channel, record) : !this.allowsChannel(channel.id)) return 'skip';
    const screen = this.checked(closedTablePanel(this.app, record, reason));
    if (record.messageId) {
      // An auto-archived (not locked) thread is reopened so the panel can show that it closed.
      if (channel.isThread() && channel.archived && !channel.locked) await channel.setArchived(false).catch(() => undefined);
      if (!channel.isThread() || !channel.archived) {
        await channel.messages.edit(record.messageId, editOptions(screen)).catch((error: unknown) =>
          this.logger.debug('closing panel update failed', { code: discordErrorCode(error) }));
      }
    }
    if (!channel.isThread() || (channel.locked && channel.archived)) return 'done';
    try {
      await channel.edit({ locked: true, archived: true, reason: 'Casino table closed' });
      return 'done';
    } catch (error) {
      const code = discordErrorCode(error);
      if (code === DISCORD_ERRORS.unknownChannel) return 'done';
      this.logger.warn('closing table thread failed; it will be retried', { threadId: channel.id, code });
      return 'retry';
    }
  }

  // ───────────────────────────── roulette ─────────────────────────────

  async createWheelPanel(wheelId: string, _requestedFrom: string | null): Promise<string | null> {
    const wheel = this.app.roulette.peek(wheelId);
    if (!wheel) return null;
    const channel = await this.casinoChannel(wheel.record.guildId);
    if (!channel) {
      await this.app.roulette.close(wheelId, 'no casino channel').catch(() => undefined);
      throw new UserError(NO_CASINO_CHANNEL, 'no_casino_channel', 'Casino not set up');
    }
    const screen = this.checked(await roulettePanel(this.app, wheel));
    let thread: ThreadChannel | null = null;
    if (this.app.settings.get(wheel.record.guildId).tables.useThreads && this.threadsAllowed) {
      thread = await channel.threads
        .create({ name: 'roulette-wheel', autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, type: ChannelType.PublicThread, reason: 'Roulette wheel opened' })
        .catch(() => null);
    }
    let message;
    try {
      message = await (thread ?? channel).send(createOptions(screen));
      await this.app.roulette.attachDiscord(wheelId, { channelId: channel.id, threadId: thread?.id ?? null, messageId: message.id });
    } catch (error) {
      if (thread) await this.discardThread(channel, thread, false);
      throw error;
    }
    if (thread) this.track(this.removeThreadNotice(channel, thread.id));
    this.requestLobby(wheel.record.guildId);
    return thread?.url ?? message.url;
  }

  private async recreateWheelPanel(wheelId: string): Promise<void> {
    const wheel = this.app.roulette.peek(wheelId);
    if (!wheel) return;
    try {
      await this.createWheelPanel(wheelId, null);
    } catch (error) {
      this.logger.error('could not recreate roulette panel; closing with refunds', { wheelId, error });
      await this.app.roulette.close(wheelId, 'panel unavailable');
    }
  }

  private async onWheelClosed(wheel: WheelSnapshot): Promise<void> {
    const { id } = wheel.record;
    this.requestLobby(wheel.record.guildId);
    this.closingPanels.add(id);
    try {
      await this.wheelPanels.retire(id);
      this.noteClosed(id, await this.closePanel({ ...wheel.record, name: 'Roulette' }, 'closed after inactivity'));
    } finally {
      this.closingPanels.delete(id);
    }
  }

  async coinflipScreen(challengeId: string, options: { flipping?: boolean; animate?: boolean } = {}): Promise<Screen | null> {
    const c = this.app.coinflip.get(challengeId);
    if (!c) return null;
    const names = {
      challenger: this.app.economy.getPlayer(c.guildId, c.challengerId)?.display_name || 'Challenger',
      opponent: this.app.economy.getPlayer(c.guildId, c.opponentId)?.display_name || 'Opponent',
    };
    return this.checked(await coinflipMessage(this.app, c, names, options));
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
    const digest = screenDigest(screen);
    const shown = this.lobbyShown.get(guildId);
    // Most table activity (a bet, a hit) doesn't change the lobby. A periodic re-send still notices a deleted lobby.
    if (messageId && shown?.messageId === messageId && shown.digest === digest && Date.now() - shown.at < LOBBY_RECHECK_MS) return messageId;
    if (messageId) {
      try {
        const reuse = this.lobbyFiles.get(guildId) === file;
        await channel.messages.edit(messageId, editOptions(screen, reuse));
        this.lobbyFiles.set(guildId, file);
        this.lobbyShown.set(guildId, { messageId, digest, at: Date.now() });
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
    this.lobbyShown.set(guildId, { messageId: message.id, digest, at: Date.now() });
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
    this.lobbyShown.delete(guildId);
    const messageId = await this.syncLobby(guildId);
    return { url: `https://discord.com/channels/${guildId}/${channel.id}/${messageId ?? ''}`, missing };
  }
}
