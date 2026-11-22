import {
  MessageFlags,
  PermissionFlagsBits,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type TextChannel,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import { InsufficientFundsError, UserError, isUserError } from '../core/errors.js';
import { chips, escapeMarkdown, signedChips } from '../core/format.js';
import { shortCode } from '../core/random.js';
import { getSpec, type SettingGroup } from '../config/settings.js';
import { resetGuildData } from '../domain/dev-reset.js';
import type { LeaderboardCategory, LeaderboardPeriod } from '../domain/leaderboard-service.js';
import { LEADERBOARD_CATEGORIES } from '../domain/leaderboard-service.js';
import type { CosmeticKind } from '../domain/progression.js';
import type { Challenge, CoinSide } from '../games/coinflip/coinflip-service.js';
import { isBetType } from '../games/roulette/engine.js';
import type { PlayerAction } from '../games/blackjack/engine.js';
import { cid, intArg, parseCid } from '../ui/custom-id.js';
import { button, linkButton, row, type Screen } from '../ui/kit.js';
import { COLORS, ICONS } from '../ui/theme.js';
import { noticeScreen, errorScreen, NAV, type Viewer } from '../ui/screens/common.js';
import { homeScreen, walletScreen, historyScreen } from '../ui/screens/home.js';
import { profileScreen, achievementsScreen, styleScreen, applyCosmetic } from '../ui/screens/profile.js';
import { leaderboardScreen } from '../ui/screens/leaderboard.js';
import { rewardsScreen } from '../ui/screens/rewards.js';
import {
  accessCodeModal,
  createTableModal,
  customBetModal,
  mySeatScreen,
  rulesScreen,
  tablesScreen,
} from '../ui/screens/blackjack.js';
import { coinflipModal, gamesHubScreen, paytableScreen, rouletteBetModal, rouletteHelpScreen, slotsScreen } from '../ui/screens/games.js';
import { HELP_TOPICS, helpScreen, type HelpTopic } from '../ui/screens/help.js';
import { adjustModal, adminScreen, adminTablesScreen, auditScreen, devResetModal, settingModal } from '../ui/screens/admin.js';
import type { ModalSpec } from '../ui/kit.js';
import type { CasinoBot } from './bot.js';
import type { Carrier } from './panel-sync.js';
import { createOptions, discordErrorCode, editOptions, replyOptions } from './payload.js';

type Component = ButtonInteraction | AnySelectMenuInteraction;
type AckMode = 'update' | 'reply' | 'none';

const ACK_GUARD_MS = 2_200;
const PLAYER_ACTIONS = new Set<PlayerAction>(['hit', 'stand', 'double', 'split', 'surrender']);

/**
 * Routes every interaction. Handlers re-validate everything server-side (guild, table, phase,
 * player, sequence, funds) — custom IDs are treated as untrusted hints.
 */
export class InteractionRouter {
  private readonly claimed = new WeakSet<object>();
  private readonly seen = new Map<string, number>();
  private readonly handledChallenges = new Set<string>();
  /** How we deferred each interaction, so later responses go to the right place. */
  private readonly deferredAs = new WeakMap<object, 'update' | 'reply'>();
  readonly startedAt = Date.now();
  latency = { count: 0, totalMs: 0, maxMs: 0 };

  constructor(
    private readonly app: CasinoApp,
    private readonly bot: CasinoBot,
  ) {}

  /** Called by the panel observers: the interaction that caused a change answers it. */
  claim(origin?: object): Carrier | undefined {
    if (!origin) return undefined;
    this.claimed.add(origin);
    return origin as Carrier;
  }

  async handle(interaction: Interaction): Promise<void> {
    if (this.seen.has(interaction.id)) return; // duplicate delivery
    this.seen.set(interaction.id, Date.now());
    if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
    if (!interaction.isRepliable()) {
      if (interaction.isAutocomplete()) await interaction.respond([]).catch(() => undefined);
      return;
    }
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'The casino lives inside servers — use it from a server channel.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    const started = Date.now();
    let guard: NodeJS.Timeout | undefined;
    const arm = (mode: AckMode) => {
      if (mode === 'none') return;
      guard = setTimeout(() => {
        this.defer(interaction, mode).catch(() => undefined);
      }, ACK_GUARD_MS);
    };
    try {
      if (interaction.isChatInputCommand()) await this.command(interaction, arm);
      else if (interaction.isUserContextMenuCommand()) await this.userMenu(interaction);
      else if (interaction.isButton() || interaction.isAnySelectMenu()) await this.component(interaction, arm);
      else if (interaction.isModalSubmit()) await this.modal(interaction, arm);
    } catch (error) {
      await this.fail(interaction, error);
    } finally {
      if (guard) clearTimeout(guard);
      const ms = Date.now() - started;
      this.latency.count++;
      this.latency.totalMs += ms;
      this.latency.maxMs = Math.max(this.latency.maxMs, ms);
      this.app.logger.debug('interaction', { id: 'customId' in interaction ? interaction.customId : interaction.isCommand() ? interaction.commandName : '?', ms });
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private viewer(i: RepliableInteraction): Viewer {
    const member = i.member as GuildMember | { nick?: string | null } | null;
    const displayName =
      (member && 'displayName' in member ? member.displayName : member?.nick) || i.user.globalName || i.user.username;
    const avatarUrl =
      member && 'displayAvatarURL' in member
        ? member.displayAvatarURL({ extension: 'png', size: 128 })
        : i.user.displayAvatarURL({ extension: 'png', size: 128 });
    const isAdmin = i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    const viewer = { guildId: i.guildId!, userId: i.user.id, displayName, avatarUrl, isAdmin };
    this.app.economy.ensurePlayer(viewer.guildId, viewer.userId, displayName);
    return viewer;
  }

  private fromEphemeral(i: RepliableInteraction): boolean {
    if (i.isMessageComponent()) return i.message.flags.has(MessageFlags.Ephemeral);
    if (i.isModalSubmit() && i.isFromMessage()) return i.message.flags.has(MessageFlags.Ephemeral);
    return false;
  }

  /**
   * Acknowledge without answering yet. 'update' (component/modal on a message) means the eventual
   * answer edits the user's own panel; 'reply' opens a private "thinking…" reply to fill later.
   */
  private async defer(i: RepliableInteraction, mode: 'update' | 'reply'): Promise<void> {
    if (i.deferred || i.replied) return;
    if (mode === 'update' && (i.isMessageComponent() || (i.isModalSubmit() && i.isFromMessage()))) {
      this.deferredAs.set(i, 'update');
      await (i as ButtonInteraction).deferUpdate();
    } else {
      this.deferredAs.set(i, 'reply');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }

  /**
   * Show a screen: in place when the click came from the user's own private panel, otherwise as a
   * new private (or public) reply. Never edits a shared message by accident: if the interaction
   * was acknowledged in a way that doesn't match, the screen goes out as a private follow-up.
   */
  private async show(i: RepliableInteraction, screen: Screen, how: 'auto' | 'private' | 'public' = 'auto'): Promise<void> {
    screen = this.bot.checked(screen);
    const inPlace = how === 'auto' && this.fromEphemeral(i) && (i.isMessageComponent() || i.isModalSubmit());
    if (!i.deferred && !i.replied) {
      if (inPlace) await (i as ButtonInteraction).update(editOptions(screen));
      else await i.reply(replyOptions(screen, how !== 'public'));
      return;
    }
    const deferred = this.deferredAs.get(i);
    if (i.deferred && !i.replied && (deferred === 'reply' || (deferred === 'update' && inPlace))) {
      await i.editReply(editOptions(screen));
      return;
    }
    await i.followUp(replyOptions(screen, how !== 'public'));
  }

  private async notice(i: RepliableInteraction, title: string, body: string, tone: 'success' | 'info' | 'error' | 'gold' = 'info', buttons: ReturnType<typeof button>[] = []): Promise<void> {
    await this.show(i, noticeScreen({ title, body, tone, buttons }), 'private');
  }

  private async fail(i: RepliableInteraction, error: unknown): Promise<void> {
    let screen: Screen;
    if (isUserError(error)) {
      screen = noticeScreen({ title: error.title, body: error.message, tone: 'error' });
      if (error instanceof InsufficientFundsError) {
        screen = noticeScreen({ title: error.title, body: `${error.message}\nCollect your passive income or daily reward for more chips.`, tone: 'error', buttons: [button({ id: NAV.wallet, label: 'Open wallet', emoji: ICONS.wallet })] });
      }
    } else {
      const ref = shortCode(6);
      this.app.logger.error('interaction failed', { ref, error, customId: 'customId' in i ? i.customId : undefined, command: i.isCommand() ? i.commandName : undefined });
      screen = errorScreen('Something went wrong', `That didn't work — sorry about that. Nothing was charged.\n-# Reference \`${ref}\` (for the bot owner's logs)`, false);
    }
    try {
      const opts = replyOptions(screen, true);
      if (!i.deferred && !i.replied) await i.reply(opts);
      else if (this.deferredAs.get(i) === 'reply' && !i.replied) await i.editReply(editOptions(screen));
      else await i.followUp(opts);
    } catch (e) {
      this.app.logger.debug('could not report error to user', { code: discordErrorCode(e) });
    }
  }

  /** If a panel action changed nothing visible, acknowledge the click silently. */
  private async settle(i: Component | ModalSubmitInteraction): Promise<void> {
    if (this.claimed.has(i)) return;
    if (!i.deferred && !i.replied) await i.deferUpdate().catch(() => undefined);
  }

  private requireAdmin(viewer: Viewer): void {
    if (!viewer.isAdmin) throw new UserError('Only server managers can use casino admin tools.', 'not_admin', 'Admins only');
  }

  private requireOpen(viewer: Viewer): void {
    if (!this.app.settings.get(viewer.guildId).enabled && !viewer.isAdmin) {
      throw new UserError('The casino is closed right now. Your chips are safe.', 'casino_closed', 'Casino closed');
    }
  }

  private async showModal(i: Component | ChatInputCommandInteraction, spec: ModalSpec): Promise<void> {
    await i.showModal(spec as unknown as Parameters<ButtonInteraction['showModal']>[0]);
  }

  private async profileTarget(guildId: string, userId: string): Promise<{ userId: string; displayName: string; avatarUrl: string }> {
    const guild = this.bot.client.guilds.cache.get(guildId);
    const member = await guild?.members.fetch(userId).catch(() => null);
    if (member) return { userId, displayName: member.displayName, avatarUrl: member.displayAvatarURL({ extension: 'png', size: 128 }) };
    const user = await this.bot.client.users.fetch(userId).catch(() => null);
    const stored = this.app.economy.getPlayer(guildId, userId)?.display_name;
    return {
      userId,
      displayName: stored || user?.globalName || user?.username || 'Player',
      avatarUrl: user?.displayAvatarURL({ extension: 'png', size: 128 }) ?? 'https://cdn.discordapp.com/embed/avatars/0.png',
    };
  }

  // ───────────────────────────── slash commands ─────────────────────────────

  private async command(i: ChatInputCommandInteraction, arm: (m: AckMode) => void): Promise<void> {
    const viewer = this.viewer(i);
    arm('reply');
    switch (i.commandName) {
      case 'casino':
        return this.show(i, homeScreen(this.app, viewer));
      case 'wallet':
        return this.show(i, walletScreen(this.app, viewer));
      case 'daily': {
        const claim = this.app.economy.claimDaily(viewer.guildId, viewer.userId);
        return this.show(i, noticeScreen({
          title: `+${chips(claim.amount)} chips`,
          body: `Daily reward collected${claim.streak > 1 ? ` — **${claim.streak}-day streak!**` : '.'} Balance: **${chips(claim.balance)}**.`,
          tone: 'gold',
          buttons: [button({ id: NAV.wallet, label: 'Wallet', emoji: ICONS.wallet }), button({ id: NAV.home, label: 'Casino', emoji: ICONS.home })],
        }));
      }
      case 'blackjack':
        return this.show(i, tablesScreen(this.app, viewer));
      case 'roulette':
        return this.openRoulette(i, viewer);
      case 'slots':
        this.requireOpen(viewer);
        return this.show(i, await slotsScreen(this.app, viewer, this.app.settings.get(viewer.guildId).slots.minBet));
      case 'help':
        return this.show(i, helpScreen(this.app, viewer, 'start'));
      case 'profile': {
        const user = i.options.getUser('player');
        const target = user ? await this.profileTarget(viewer.guildId, user.id) : { userId: viewer.userId, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl };
        return this.show(i, profileScreen(this.app, viewer, target));
      }
      case 'leaderboard': {
        const board = (i.options.getString('board') ?? 'net') as LeaderboardCategory;
        return this.show(i, leaderboardScreen(this.app, viewer, board, 'all', 0));
      }
      case 'coinflip': {
        const opponent = i.options.getUser('player', true);
        const stake = i.options.getInteger('stake', true);
        const call = (i.options.getString('call') ?? 'heads') as CoinSide;
        return this.createChallenge(i, viewer, opponent.id, opponent.bot, stake, call);
      }
      case 'casinoadmin':
        return this.adminCommand(i, viewer);
      default:
        throw new UserError('Unknown command — try `/casino`.');
    }
  }

  private async userMenu(i: UserContextMenuCommandInteraction): Promise<void> {
    const viewer = this.viewer(i);
    const target = await this.profileTarget(viewer.guildId, i.targetUser.id);
    await this.show(i, profileScreen(this.app, viewer, target));
  }

  private async adminCommand(i: ChatInputCommandInteraction, viewer: Viewer): Promise<void> {
    this.requireAdmin(viewer);
    const sub = i.options.getSubcommand();
    switch (sub) {
      case 'setup': {
        const channel = (i.options.getChannel('channel') ?? i.channel) as TextChannel | null;
        if (!channel || !('threads' in channel)) throw new UserError('Pick a regular text channel for the casino lobby.');
        await this.defer(i, 'reply');
        const { url, missing } = await this.bot.setupLobby(viewer.guildId, channel);
        if (!url) {
          return this.notice(i, 'Missing permissions', `I need these permissions in <#${channel.id}>: **${missing.join(', ')}**.`, 'error');
        }
        const warn = missing.length ? `\n-# Some optional permissions are missing (${missing.join(', ')}); tables will fall back to channel messages if threads can't be created.` : '';
        return this.notice(i, 'Lobby ready', `The casino lobby is live in <#${channel.id}>. Restarting the bot keeps this same message.${warn}`, 'success', [linkButton('Go to lobby', url)]);
      }
      case 'panel':
        return this.show(i, adminScreen(this.app, viewer.guildId, 'general'));
      case 'adjust': {
        const user = i.options.getUser('player', true);
        if (user.bot) throw new UserError('Bots do not have casino accounts.');
        this.app.economy.ensurePlayer(viewer.guildId, user.id, user.globalName ?? user.username);
        const row = this.app.economy.adminAdjust({
          guildId: viewer.guildId,
          userId: user.id,
          amount: i.options.getInteger('amount', true),
          reason: i.options.getString('reason', true),
          actorId: viewer.userId,
        });
        this.app.logger.info('admin adjustment', { guildId: viewer.guildId, actor: viewer.userId, target: user.id, amount: row.amount });
        return this.notice(i, 'Wallet adjusted', `${signedChips(row.amount)} chips for <@${user.id}> — new balance **${chips(row.balance_after)}**.\n-# Recorded in the audit log: “${escapeMarkdown(row.memo ?? '')}”`, 'success');
      }
      case 'audit':
        return this.show(i, auditScreen(this.app, viewer.guildId));
      case 'health':
        return this.show(i, this.healthScreen(viewer.guildId));
      case 'reset-dev': {
        const env = process.env;
        const devGuild = env.DISCORD_DEV_GUILD_ID;
        if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_RESET !== 'true' || devGuild !== viewer.guildId) {
          throw new UserError('Data resets are only available in the development server with ALLOW_DEV_RESET=true. Real player data is protected.', 'reset_blocked', 'Protected');
        }
        return this.showModal(i, devResetModal(viewer.guildId));
      }
    }
  }

  private healthScreen(guildId: string): Screen {
    const issues = this.app.economy.reconcile(guildId);
    const tables = this.app.blackjack.openTables(guildId);
    const mem = process.memoryUsage();
    const avg = this.latency.count ? Math.round(this.latency.totalMs / this.latency.count) : 0;
    const p = this.bot.tablePanels.stats;
    return noticeScreen({
      title: issues.length ? '⚠️ Ledger problems found' : '✅ Healthy',
      tone: issues.length ? 'error' : 'success',
      body:
        `**Ledger** · ${issues.length ? `${issues.length} problems — ${escapeMarkdown(issues.slice(0, 3).map((x) => x.problem).join('; '))}` : 'every balance matches the ledger and escrows'}\n` +
        `**Tables** · ${tables.length} open · roulette ${this.app.roulette.wheelFor(guildId) ? 'open' : 'closed'}\n` +
        `**Interactions** · ${this.latency.count} handled · avg ${avg} ms · max ${this.latency.maxMs} ms\n` +
        `**Panels** · ${p.renders} renders (${p.viaInteraction} direct, ${p.viaRest} edits, ${p.reusedImage} image reuses, ${p.failures} failures)\n` +
        `**Images** · cache ${this.app.images.hits} hits / ${this.app.images.misses} renders\n` +
        `**Process** · up ${Math.round((Date.now() - this.startedAt) / 60_000)} min · ${Math.round(mem.rss / 1048576)} MB · Discord ping ${this.bot.client.ws.ping} ms`,
    });
  }

  // ───────────────────────────── components ─────────────────────────────

  private async component(i: Component, arm: (m: AckMode) => void): Promise<void> {
    const { scope, action, args } = parseCid(i.customId);
    const viewer = this.viewer(i);
    const ephemeral = this.fromEphemeral(i);
    switch (scope) {
      case 'nav':
        arm(ephemeral ? 'update' : 'reply');
        return this.nav(i, viewer, action, args);
      case 'lbcat': {
        arm('update');
        const category = (i.isStringSelectMenu() ? i.values[0] : 'net') as LeaderboardCategory;
        const period = (args[0] ?? action) as LeaderboardPeriod;
        const info = LEADERBOARD_CATEGORIES.find((c) => c.id === category);
        return this.show(i, leaderboardScreen(this.app, viewer, category, info?.periods.includes(period) ? period : 'all', 0));
      }
      case 'lbpro': {
        arm('update');
        const userId = i.isStringSelectMenu() ? i.values[0]! : viewer.userId;
        return this.show(i, profileScreen(this.app, viewer, await this.profileTarget(viewer.guildId, userId)));
      }
      case 'help': {
        arm('update');
        const topic = (i.isStringSelectMenu() ? i.values[0] : 'start') as HelpTopic;
        return this.show(i, helpScreen(this.app, viewer, HELP_TOPICS.includes(topic) ? topic : 'start'));
      }
      case 'style': {
        arm('update');
        if (!i.isStringSelectMenu()) return;
        const problem = applyCosmetic(this.app, viewer, action as CosmeticKind, i.values[0] ?? '');
        if (problem) throw new UserError(problem, 'locked', 'Locked');
        return this.show(i, await styleScreen(this.app, viewer));
      }
      case 'eco':
        arm(ephemeral ? 'update' : 'reply');
        return this.claimReward(i, viewer, action, args[0] ?? 'home');
      case 'tbl':
        return this.tables(i, viewer, action, args, arm);
      case 'lobby':
        if (action === 'table' && i.isStringSelectMenu()) return this.joinTable(i, viewer, i.values[0]!, arm);
        return;
      case 'bj':
        return this.blackjack(i, viewer, action, args, arm);
      case 'rl':
        return this.roulette(i, viewer, action, args, arm);
      case 'sl':
        return this.slots(i, viewer, action, args, arm);
      case 'cf':
        return this.coinflip(i, viewer, action, args);
      case 'adm':
        return this.admin(i, viewer, action, args, arm);
      default:
        throw new UserError('That button is from an older version of the casino. Open `/casino` for a fresh menu.', 'unknown_component', 'Out of date');
    }
  }

  private async nav(i: Component, viewer: Viewer, action: string, args: string[]): Promise<void> {
    switch (action) {
      case 'home':
        return this.show(i, homeScreen(this.app, viewer));
      case 'wallet':
        return this.show(i, walletScreen(this.app, viewer));
      case 'history':
        return this.show(i, historyScreen(this.app, viewer, intArg(args[0])));
      case 'profile': {
        const target = args[0] ? await this.profileTarget(viewer.guildId, args[0]) : { userId: viewer.userId, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl };
        return this.show(i, profileScreen(this.app, viewer, target));
      }
      case 'achv': {
        const targetId = args[0] || viewer.userId;
        const name = targetId === viewer.userId ? viewer.displayName : this.app.economy.getPlayer(viewer.guildId, targetId)?.display_name || 'Player';
        return this.show(i, achievementsScreen(this.app, viewer, targetId, name, intArg(args[1])));
      }
      case 'style':
        return this.show(i, await styleScreen(this.app, viewer));
      case 'privacy': {
        const player = this.app.economy.getPlayer(viewer.guildId, viewer.userId)!;
        this.app.db.run('UPDATE players SET leaderboard_opt_out = ? WHERE guild_id = ? AND user_id = ?', [player.leaderboard_opt_out ? 0 : 1, viewer.guildId, viewer.userId]);
        return this.show(i, profileScreen(this.app, viewer, { userId: viewer.userId, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl }));
      }
      case 'lb': {
        const category = (args[0] ?? 'net') as LeaderboardCategory;
        const period = (args[1] ?? 'all') as LeaderboardPeriod;
        return this.show(i, leaderboardScreen(this.app, viewer, category, period, intArg(args[2])));
      }
      case 'rewards':
        return this.show(i, rewardsScreen(this.app, viewer));
      case 'tables':
        return this.show(i, tablesScreen(this.app, viewer));
      case 'games':
        return this.show(i, gamesHubScreen(this.app, viewer));
      case 'help':
        return this.show(i, helpScreen(this.app, viewer, (HELP_TOPICS as readonly string[]).includes(args[0] ?? '') ? (args[0] as HelpTopic) : 'start'));
      case 'slots':
        this.requireOpen(viewer);
        return this.show(i, await slotsScreen(this.app, viewer, intArg(args[0], this.app.settings.get(viewer.guildId).slots.minBet)));
      default:
        return this.show(i, homeScreen(this.app, viewer));
    }
  }

  private async claimReward(i: Component, viewer: Viewer, action: string, from: string): Promise<void> {
    if (action === 'passive') {
      const { amount } = this.app.economy.claimPassive(viewer.guildId, viewer.userId);
      if (amount === 0) throw new UserError('Nothing to collect yet — passive income builds up over time.', 'nothing', 'Not yet');
    } else if (action === 'daily') {
      this.app.economy.claimDaily(viewer.guildId, viewer.userId);
    }
    // Re-render the personal screen the button was on.
    const screen = from === 'wallet' ? walletScreen(this.app, viewer) : from === 'rewards' ? rewardsScreen(this.app, viewer) : homeScreen(this.app, viewer);
    return this.show(i, screen);
  }

  // ───────────────────────────── tables (finding / creating / joining) ─────────────────────────────

  private async tables(i: Component, viewer: Viewer, action: string, args: string[], arm: (m: AckMode) => void): Promise<void> {
    this.requireOpen(viewer);
    switch (action) {
      case 'create': {
        const seated = this.app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
        if (seated) throw new UserError(`You're already seated at **${escapeMarkdown(seated.record.name)}**. Leave it before opening a new table.`, 'already_seated');
        return this.showModal(i, createTableModal(this.app, viewer.guildId));
      }
      case 'quick':
        arm(this.fromEphemeral(i) ? 'update' : 'reply');
        return this.quickSeat(i, viewer);
      case 'join':
        return this.joinTable(i, viewer, args[0] ?? '', arm);
    }
  }

  private async quickSeat(i: RepliableInteraction, viewer: Viewer): Promise<void> {
    const mine = this.app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
    if (mine) {
      const url = await this.bot.addToTableThread(mine.record.id, viewer.userId);
      return this.show(i, this.seatedScreen(mine.record.name, url, 'You already have a seat here.'));
    }
    const candidates = this.app.blackjack
      .openTables(viewer.guildId)
      .filter((t) => !t.record.isPrivate && t.state.seats.length < t.record.config.maxSeats && t.record.messageId)
      .sort((a, b) => b.state.seats.length - a.state.seats.length);
    for (const table of candidates) {
      try {
        const seat = await this.app.blackjack.join(table.record.id, viewer.userId, viewer.displayName);
        const url = await this.bot.addToTableThread(table.record.id, viewer.userId);
        return this.show(i, this.seatedScreen(table.record.name, url, `You're in seat **${seat.seatIndex + 1}**. Press a chip on the table to bet.`));
      } catch (error) {
        if (!isUserError(error)) throw error;
      }
    }
    // Nothing open: start a table for them.
    return this.openTable(i, viewer, {});
  }

  private async openTable(i: RepliableInteraction, viewer: Viewer, options: { name?: string; isPrivate?: boolean; maxSeats?: number; minBet?: number; maxBet?: number }): Promise<void> {
    const player = this.app.economy.getPlayer(viewer.guildId, viewer.userId)!;
    await this.defer(i, this.fromEphemeral(i) ? 'update' : 'reply');
    const table = await this.app.blackjack.createTable({
      guildId: viewer.guildId,
      ownerId: viewer.userId,
      ownerName: viewer.displayName,
      ...options,
      feltId: player.felt_id,
      cardBackId: player.card_back_id,
    });
    let url: string | null;
    try {
      ({ url } = await this.bot.createTablePanel(table.record.id, i.channelId, viewer.userId));
    } catch (error) {
      await this.app.blackjack.closeTable(table.record.id, 'could not be created', { force: true });
      this.app.logger.error('table panel creation failed', { error });
      throw new UserError("I couldn't create the table's thread or message. Ask an admin to check my permissions in the casino channel (Send Messages, Attach Files, Create Threads).", 'panel_failed', 'Could not open table');
    }
    const code = table.record.isPrivate ? `\nAccess code: **\`${table.record.accessCode}\`** — share it with the friends you want to invite.` : '';
    return this.show(i, this.seatedScreen(table.record.name, url, `Your table is open and you're the host.${code}`));
  }

  private seatedScreen(tableName: string, url: string | null, body: string): Screen {
    return noticeScreen({
      title: `♠ ${escapeMarkdown(tableName)}`,
      body,
      tone: 'success',
      buttons: [url ? linkButton('Go to the table', url, ICONS.blackjack) : null, button({ id: NAV.home, label: 'Casino home', emoji: ICONS.home })].filter(
        (b): b is ReturnType<typeof button> => b !== null,
      ),
    });
  }

  private async joinTable(i: Component, viewer: Viewer, tableId: string, arm: (m: AckMode) => void, code?: string): Promise<void> {
    this.requireOpen(viewer);
    const snap = this.app.blackjack.peek(tableId);
    if (!snap || snap.record.guildId !== viewer.guildId) throw new UserError('That table has closed. Open the lobby to find another one.', 'table_closed');
    if (snap.state.seats.some((s) => s.userId === viewer.userId)) {
      arm(this.fromEphemeral(i) ? 'update' : 'reply');
      const url = await this.bot.addToTableThread(tableId, viewer.userId);
      return this.show(i, this.seatedScreen(snap.record.name, url, 'You already have a seat here.'), this.fromEphemeral(i) ? 'auto' : 'private');
    }
    if (snap.record.isPrivate && snap.record.ownerId !== viewer.userId && !code) {
      return this.showModal(i, accessCodeModal(tableId, snap.record.name));
    }
    arm(this.fromEphemeral(i) ? 'update' : 'reply');
    const seat = await this.app.blackjack.join(tableId, viewer.userId, viewer.displayName, code);
    const url = await this.bot.addToTableThread(tableId, viewer.userId);
    const inRound = snap.state.phase !== 'betting';
    return this.show(
      i,
      this.seatedScreen(snap.record.name, url, `You're in seat **${seat.seatIndex + 1}**. ${inRound ? "A hand is in progress — you'll be dealt in next hand." : 'Press a chip on the table to bet.'}`),
      this.fromEphemeral(i) ? 'auto' : 'private',
    );
  }

  // ───────────────────────────── blackjack table panel ─────────────────────────────

  private async blackjack(i: Component, viewer: Viewer, action: string, args: string[], arm: (m: AckMode) => void): Promise<void> {
    const tableId = args[0] ?? '';
    const tables = this.app.blackjack;
    switch (action) {
      case 'home':
        arm('reply');
        return this.show(i, homeScreen(this.app, viewer), this.fromEphemeral(i) ? 'auto' : 'private');
      case 'rules':
        arm('reply');
        return this.show(i, rulesScreen(this.app, viewer.guildId, tableId), 'private');
      case 'seat':
        arm('reply');
        return this.show(i, mySeatScreen(this.app, viewer, tableId), 'private');
      case 'join':
        return this.joinTable(i, viewer, tableId, arm);
      case 'betx': {
        const snap = tables.peek(tableId);
        if (!snap) throw new UserError('That table has closed.', 'table_closed');
        return this.showModal(i, customBetModal(tableId, snap.record.config.minBet, snap.record.config.maxBet, snap.state.bets[viewer.userId] ?? null));
      }
    }
    this.requireOpen(viewer);
    const snap = tables.peek(tableId);
    if (!snap || snap.record.guildId !== viewer.guildId) throw new UserError('That table has closed. Open the lobby to find another one.', 'table_closed', 'Table closed');
    switch (action) {
      case 'bet':
      case 'rebet': {
        arm('update');
        let amount = intArg(args[1]);
        const seat = snap.state.seats.find((s) => s.userId === viewer.userId);
        if (action === 'rebet') {
          if (!seat?.lastBet) throw new UserError('You have no previous bet at this table yet — pick a chip.', 'no_last_bet', 'Nothing to repeat');
          amount = seat.lastBet;
        }
        if (!seat) {
          // Pressing a chip while standing at the rail sits you down if there is room.
          if (snap.record.isPrivate) throw new UserError('This is a private table — use **Take a seat** and enter the access code.', 'private');
          await tables.join(tableId, viewer.userId, viewer.displayName);
          void this.bot.addToTableThread(tableId, viewer.userId);
        }
        await tables.placeBet(tableId, viewer.userId, amount, viewer.displayName, i);
        return this.settle(i);
      }
      case 'clear':
        arm('update');
        await tables.clearBet(tableId, viewer.userId, i);
        return this.settle(i);
      case 'deal':
        arm('update');
        await tables.dealNow(tableId, viewer.userId, i);
        return this.settle(i);
      case 'act': {
        arm('update');
        const move = args[1] as PlayerAction;
        if (!PLAYER_ACTIONS.has(move)) throw new UserError('Unknown action.');
        await tables.act(tableId, viewer.userId, move, intArg(args[2], -1), i);
        return this.settle(i);
      }
      case 'ins':
        arm('update');
        await tables.decideInsurance(tableId, viewer.userId, args[1] === '1', i);
        return this.settle(i);
      case 'leave': {
        arm(this.fromEphemeral(i) ? 'update' : 'reply');
        const result = await tables.leave(tableId, viewer.userId);
        return this.show(
          i,
          noticeScreen({
            title: result === 'left' ? 'You left the table' : "You'll leave after this hand",
            body: result === 'left' ? 'Any open bet was returned to your wallet. Come back any time!' : 'Your remaining hands will stand automatically and your seat frees up when the hand ends.',
            tone: 'info',
            buttons: [button({ id: NAV.tables, label: 'Other tables', emoji: ICONS.tables }), button({ id: NAV.home, label: 'Casino home', emoji: ICONS.home })],
          }),
          this.fromEphemeral(i) ? 'auto' : 'private',
        );
      }
      case 'sit':
        arm('update');
        await tables.setSittingOut(tableId, viewer.userId, args[1] === '1');
        return this.show(i, mySeatScreen(this.app, viewer, tableId));
      case 'close':
        arm('update');
        await tables.closeTable(tableId, `closed by the host`, { actorId: viewer.userId });
        return this.show(i, noticeScreen({ title: 'Table closed', body: 'All open bets were refunded.', tone: 'success', buttons: [button({ id: NAV.home, label: 'Casino home', emoji: ICONS.home })] }));
      case 'kick': {
        arm('update');
        if (!i.isUserSelectMenu()) return;
        await tables.kick(tableId, viewer.userId, i.values[0]!);
        return this.show(i, mySeatScreen(this.app, viewer, tableId));
      }
      default:
        throw new UserError('That control is out of date.', 'stale', 'Out of date');
    }
  }

  // ───────────────────────────── roulette ─────────────────────────────

  private async openRoulette(i: RepliableInteraction, viewer: Viewer): Promise<void> {
    this.requireOpen(viewer);
    const { wheel } = await this.app.roulette.open(viewer.guildId);
    let url: string | null;
    if (!wheel.record.messageId) {
      await this.defer(i, this.fromEphemeral(i) ? 'update' : 'reply');
      url = await this.bot.createWheelPanel(wheel.record.id, i.channelId);
    } else {
      url = wheel.record.threadId
        ? `https://discord.com/channels/${viewer.guildId}/${wheel.record.threadId}`
        : `https://discord.com/channels/${viewer.guildId}/${wheel.record.channelId}/${wheel.record.messageId}`;
    }
    return this.show(i, noticeScreen({ title: '🎡 The wheel is ready', body: 'Pick a bet from the menu under the wheel. It spins shortly after the first bet.', tone: 'success', buttons: url ? [linkButton('Go to the wheel', url)] : [] }));
  }

  private async roulette(i: Component, viewer: Viewer, action: string, args: string[], arm: (m: AckMode) => void): Promise<void> {
    switch (action) {
      case 'open':
        arm(this.fromEphemeral(i) ? 'update' : 'reply');
        return this.openRoulette(i, viewer);
      case 'help':
        return this.show(i, rouletteHelpScreen(), 'private');
      case 'bet': {
        this.requireOpen(viewer);
        if (!i.isStringSelectMenu()) return;
        const type = i.values[0] ?? '';
        if (!isBetType(type)) throw new UserError('Unknown bet type.');
        const limits = this.app.settings.get(viewer.guildId).roulette;
        return this.showModal(i, rouletteBetModal(args[0] ?? '', type, limits.minBet, limits.maxBet));
      }
      case 'clear':
        arm('update');
        await this.app.roulette.clearBets(args[0] ?? '', viewer.userId, i);
        return this.settle(i);
    }
  }

  // ───────────────────────────── slots ─────────────────────────────

  private async slots(i: Component, viewer: Viewer, action: string, args: string[], arm: (m: AckMode) => void): Promise<void> {
    arm('update');
    if (action === 'pay') return this.show(i, paytableScreen(intArg(args[0])));
    if (action === 'spin') {
      this.requireOpen(viewer);
      const bet = intArg(args[0]);
      await this.app.slots.spin(viewer.guildId, viewer.userId, bet, intArg(args[1], -1));
      return this.show(i, await slotsScreen(this.app, viewer, bet));
    }
  }

  // ───────────────────────────── coinflip ─────────────────────────────

  private async coinflip(i: Component, viewer: Viewer, action: string, args: string[]): Promise<void> {
    if (action === 'pick') {
      this.requireOpen(viewer);
      if (!i.isUserSelectMenu()) return;
      const user = i.users.first();
      if (!user) return;
      if (user.bot) throw new UserError("Bots don't gamble — pick a person.", 'bot');
      if (user.id === viewer.userId) throw new UserError("You can't flip against yourself.", 'self');
      const limits = this.app.settings.get(viewer.guildId).coinflip;
      const member = i.members.get(user.id) as GuildMember | { nick?: string } | undefined;
      const name = (member && 'displayName' in member ? member.displayName : member?.nick) || user.globalName || user.username;
      return this.showModal(i, coinflipModal(user.id, name, limits.minBet, limits.maxBet));
    }
    const id = args[0] ?? '';
    this.handledChallenges.add(id);
    try {
      let challenge: Challenge;
      if (action === 'accept') challenge = (await this.app.coinflip.accept(id, viewer.userId)).challenge;
      else if (action === 'decline') challenge = await this.app.coinflip.decline(id, viewer.userId);
      else if (action === 'cancel') challenge = await this.app.coinflip.cancel(id, viewer.userId);
      else return;
      const screen = await this.bot.coinflipScreen(challenge.id);
      if (screen) await i.update(editOptions(screen));
    } finally {
      setTimeout(() => this.handledChallenges.delete(id), 5_000).unref?.();
    }
  }

  private async createChallenge(i: RepliableInteraction, viewer: Viewer, opponentId: string, isBot: boolean, stake: number, call: CoinSide): Promise<void> {
    this.requireOpen(viewer);
    if (isBot) throw new UserError("Bots don't gamble — pick a person.", 'bot');
    const opponentName = (await this.profileTarget(viewer.guildId, opponentId)).displayName;
    this.app.economy.ensurePlayer(viewer.guildId, opponentId, opponentName);
    const challenge = await this.app.coinflip.create({ guildId: viewer.guildId, challengerId: viewer.userId, opponentId, amount: stake, call });
    const screen = await this.bot.coinflipScreen(challenge.id);
    if (!screen) return;
    // The card mentions the opponent; only this first post is allowed to ping them.
    const response = await i.reply({ ...createOptions(screen, [opponentId]), withResponse: true } as Parameters<typeof i.reply>[0] & { withResponse: true });
    const message = (response as { resource?: { message?: { id: string; channelId: string } } }).resource?.message;
    if (message) await this.app.coinflip.attachMessage(challenge.id, message.channelId, message.id);
  }

  /** Observer path: refresh a challenge message after expiry (clicks update it directly). */
  async refreshChallenge(challenge: Challenge): Promise<void> {
    if (this.handledChallenges.has(challenge.id) || !challenge.channelId || !challenge.messageId) return;
    try {
      const screen = await this.bot.coinflipScreen(challenge.id);
      const channel = await this.bot.client.channels.fetch(challenge.channelId);
      if (screen && channel?.isTextBased()) await channel.messages.edit(challenge.messageId, editOptions(screen));
    } catch (error) {
      this.app.logger.debug('challenge refresh failed', { code: discordErrorCode(error) });
    }
  }

  // ───────────────────────────── admin ─────────────────────────────

  private async admin(i: Component, viewer: Viewer, action: string, args: string[], arm: (m: AckMode) => void): Promise<void> {
    this.requireAdmin(viewer);
    switch (action) {
      case 'group': {
        arm('update');
        const group = (i.isStringSelectMenu() ? i.values[0] : args[0] ?? 'general') as SettingGroup;
        return this.show(i, adminScreen(this.app, viewer.guildId, group));
      }
      case 'edit': {
        if (!i.isStringSelectMenu()) return;
        const spec = getSpec(i.values[0] ?? '');
        if (!spec) throw new UserError('Unknown setting.');
        if (spec.type === 'bool' || spec.type === 'enum') {
          arm('update');
          const current = spec.key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], this.app.settings.get(viewer.guildId));
          const next = spec.type === 'bool' ? !current : spec.options[(spec.options.indexOf(String(current)) + 1) % spec.options.length];
          this.app.settings.set(viewer.guildId, spec.key, next);
          this.afterSettingsChange(viewer, spec.key, next);
          return this.show(i, adminScreen(this.app, viewer.guildId, spec.group, `✅ **${spec.label}** is now **${spec.type === 'bool' ? (next ? 'On' : 'Off') : String(next)}**.`));
        }
        return this.showModal(i, settingModal(this.app, viewer.guildId, spec));
      }
      case 'adjust':
        return this.showModal(i, adjustModal());
      case 'audit':
        arm('update');
        return this.show(i, auditScreen(this.app, viewer.guildId));
      case 'tables':
        arm('update');
        return this.show(i, adminTablesScreen(this.app, viewer.guildId));
      case 'close':
        arm('update');
        await this.app.blackjack.closeTable(args[0] ?? '', 'closed by an admin', { force: true });
        return this.show(i, adminTablesScreen(this.app, viewer.guildId));
      case 'closewheel':
        arm('update');
        await this.app.roulette.close(args[0] ?? '', 'closed by an admin');
        return this.show(i, adminTablesScreen(this.app, viewer.guildId));
      case 'lobby':
        arm('update');
        await this.bot.syncLobby(viewer.guildId);
        return this.show(i, adminScreen(this.app, viewer.guildId, 'general', '✅ Lobby refreshed.'));
      case 'health':
        arm('update');
        return this.show(i, this.healthScreen(viewer.guildId), 'private');
    }
  }

  private afterSettingsChange(viewer: Viewer, key: string, value: unknown): void {
    this.app.logger.info('setting changed', { guildId: viewer.guildId, actor: viewer.userId, key, value });
    this.bot.requestLobby(viewer.guildId, 500);
  }

  // ───────────────────────────── modals ─────────────────────────────

  private async modal(i: ModalSubmitInteraction, arm: (m: AckMode) => void): Promise<void> {
    const { action, args } = parseCid(i.customId);
    const viewer = this.viewer(i);
    const field = (id: string) => {
      try {
        return i.fields.getTextInputValue(id).trim();
      } catch {
        return '';
      }
    };
    const selectValue = (id: string) => {
      try {
        return i.fields.getStringSelectValues(id)[0] ?? '';
      } catch {
        return '';
      }
    };
    const amount = (raw: string) => {
      const n = Number(raw.replace(/[,_\s]/g, ''));
      if (!Number.isSafeInteger(n)) throw new UserError('Please enter a whole number of chips.', 'bad_amount', 'Not a number');
      return n;
    };
    switch (action) {
      case 'tblcreate': {
        this.requireOpen(viewer);
        const bj = this.app.settings.get(viewer.guildId).blackjack;
        const min = field('min') ? amount(field('min')) : bj.minBet;
        const max = field('max') ? amount(field('max')) : bj.maxBet;
        if (min > max) throw new UserError('The minimum bet must not be higher than the maximum.', 'bad_limits');
        if (min < bj.minBet || max > bj.maxBet) throw new UserError(`Bet limits must stay within the server range ${chips(bj.minBet)}–${chips(bj.maxBet)}.`, 'bad_limits');
        return this.openTable(i, viewer, {
          ...(field('name') ? { name: field('name') } : {}),
          isPrivate: selectValue('visibility') === 'private',
          maxSeats: intArg(selectValue('seats'), bj.maxSeats),
          minBet: min,
          maxBet: max,
        });
      }
      case 'tblcode': {
        arm('update');
        const tableId = args[0] ?? '';
        const snap = this.app.blackjack.peek(tableId);
        if (!snap) throw new UserError('That table has closed.', 'table_closed');
        await this.app.blackjack.join(tableId, viewer.userId, viewer.displayName, field('code'));
        const url = await this.bot.addToTableThread(tableId, viewer.userId);
        return this.show(i, this.seatedScreen(snap.record.name, url, 'Code accepted — welcome to the table.'), this.fromEphemeral(i) ? 'auto' : 'private');
      }
      case 'bjbet': {
        arm('update');
        this.requireOpen(viewer);
        const tableId = args[0] ?? '';
        await this.app.blackjack.placeBet(tableId, viewer.userId, amount(field('amount')), viewer.displayName, i);
        return this.settle(i);
      }
      case 'rlbet': {
        arm('update');
        this.requireOpen(viewer);
        const [wheelId = '', type = ''] = args;
        if (!isBetType(type)) throw new UserError('Unknown bet type.');
        const number = type === 'straight' ? amount(field('number')) : undefined;
        await this.app.roulette.placeBet(wheelId, { userId: viewer.userId, displayName: viewer.displayName, type, number, amount: amount(field('amount')) }, i);
        return this.settle(i);
      }
      case 'cf': {
        const opponentId = args[0] ?? '';
        const call = (selectValue('call') || 'heads') as CoinSide;
        const user = await this.bot.client.users.fetch(opponentId).catch(() => null);
        return this.createChallenge(i, viewer, opponentId, user?.bot ?? false, amount(field('amount')), call);
      }
      case 'admset': {
        this.requireAdmin(viewer);
        arm('update');
        const key = args[0] ?? '';
        const spec = getSpec(key);
        if (!spec) throw new UserError('Unknown setting.');
        try {
          this.app.settings.set(viewer.guildId, key, field('value'));
        } catch (error) {
          throw new UserError(error instanceof Error ? error.message : 'Invalid value.', 'bad_setting', 'Invalid value');
        }
        this.afterSettingsChange(viewer, key, field('value'));
        return this.show(i, adminScreen(this.app, viewer.guildId, spec.group, `✅ **${spec.label}** updated.`));
      }
      case 'admadjust': {
        this.requireAdmin(viewer);
        const users = i.fields.getSelectedUsers('user');
        const target = users?.first();
        if (!target) throw new UserError('Pick a player.');
        if (target.bot) throw new UserError('Bots do not have casino accounts.');
        this.app.economy.ensurePlayer(viewer.guildId, target.id, target.globalName ?? target.username);
        const entry = this.app.economy.adminAdjust({ guildId: viewer.guildId, userId: target.id, amount: amount(field('amount')), reason: field('reason'), actorId: viewer.userId });
        this.app.logger.info('admin adjustment', { guildId: viewer.guildId, actor: viewer.userId, target: target.id, amount: entry.amount });
        return this.show(i, adminScreen(this.app, viewer.guildId, 'economy', `✅ ${signedChips(entry.amount)} chips for <@${target.id}> (balance ${chips(entry.balance_after)}). Logged.`));
      }
      case 'admreset': {
        this.requireAdmin(viewer);
        const env = process.env;
        if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_RESET !== 'true' || env.DISCORD_DEV_GUILD_ID !== viewer.guildId) {
          throw new UserError('Resets are disabled here.', 'reset_blocked', 'Protected');
        }
        if (field('confirm') !== `RESET ${viewer.guildId.slice(-4)}`) throw new UserError('The confirmation text did not match. Nothing was deleted.', 'bad_confirm');
        if (this.app.blackjack.openTables(viewer.guildId).length || this.app.roulette.wheelFor(viewer.guildId)) {
          throw new UserError('Close every table and the roulette wheel first (Admin → Manage tables).', 'tables_open');
        }
        const counts = resetGuildData(this.app.db, viewer.guildId);
        this.app.logger.warn('DEV RESET performed', { guildId: viewer.guildId, actor: viewer.userId, counts });
        return this.notice(i, 'Development data reset', `Deleted ${Object.values(counts).reduce((a, b) => a + b, 0)} rows in this server.`, 'success');
      }
      default:
        throw new UserError('That form is out of date. Please try again.', 'stale_modal', 'Out of date');
    }
  }
}

export { cid, row, COLORS };
