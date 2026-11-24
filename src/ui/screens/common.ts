import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown } from '../../core/format.js';
import { levelInfo } from '../../domain/progression.js';
import { cid } from '../custom-id.js';
import { button, container, linkButton, row, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';

/** Who is looking at a screen. Built by the Discord layer from the interaction. */
export interface Viewer {
  guildId: string;
  userId: string;
  displayName: string;
  avatarUrl: string;
  isAdmin: boolean;
  canOrganizeEvents?: boolean;
}

export type NavTarget = 'home' | 'games' | 'wallet' | 'leaderboard' | 'profile';

export const NAV = {
  home: cid('nav', 'home'),
  wallet: cid('nav', 'wallet'),
  profile: cid('nav', 'profile', ''),
  leaderboard: cid('nav', 'lb', 'net', 'all', 0),
  rewards: cid('nav', 'rewards'),
  tables: cid('nav', 'tables'),
  myTable: cid('nav', 'tables', 'mine'),
  games: cid('nav', 'games'),
  // A second way into Games from a screen's own content (a message can't repeat a custom id).
  floor: cid('nav', 'games', 'floor'),
  events: cid('nav', 'events'),
  help: cid('nav', 'help', 'start'),
} as const;

const DESTINATIONS = [
  { target: 'home', label: 'Home', emoji: ICONS.home },
  { target: 'games', label: 'Games', emoji: ICONS.games },
  { target: 'wallet', label: 'Wallet', emoji: ICONS.wallet },
  { target: 'leaderboard', label: 'Leaderboards', emoji: ICONS.leaderboard },
  { target: 'profile', label: 'Profile', emoji: ICONS.profile },
] as const;

/** Keep the destination order and position consistent across private screens. */
export function navRow(current?: NavTarget, disabled = false) {
  return row(...DESTINATIONS.map(({ target, label, emoji }) =>
    button({ id: NAV[target], label, emoji, tone: target === current ? 'primary' : 'secondary', disabled })));
}

export function name(text: string): string {
  return `**${escapeMarkdown(text || 'Player')}**`;
}

export function chipsText(amount: number): string {
  return `**${chips(amount)}** chips`;
}

export function levelLine(xp: number): string {
  const info = levelInfo(xp);
  return `Level ${info.level} · ${info.rank.name}`;
}

/** A compact, friendly message card (errors, confirmations, notices). */
export function noticeScreen(options: {
  title: string;
  body: string;
  tone?: 'error' | 'success' | 'info' | 'gold';
  buttons?: ReturnType<typeof button>[];
}): Screen {
  const accent =
    options.tone === 'error' ? COLORS.crimson : options.tone === 'success' ? COLORS.win : options.tone === 'gold' ? COLORS.gold : COLORS.emerald;
  return {
    components: [
      container(accent, [text(`### ${options.title}\n${options.body}`), options.buttons && options.buttons.length ? row(...options.buttons) : null]),
    ],
  };
}

export function errorScreen(title: string, body: string, withHome = true): Screen {
  return noticeScreen({
    title,
    body,
    tone: 'error',
    buttons: withHome ? [button({ id: NAV.home, label: 'Casino home', emoji: ICONS.home })] : [],
  });
}

export function casinoName(app: CasinoApp, guildId: string): string {
  return app.settings.get(guildId).casinoName;
}

/** Discord link to a channel or thread (opens it when clicked). */
export function channelUrl(guildId: string, channelId: string, messageId?: string | null): string {
  return `https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ''}`;
}

/** Return to the persistent lobby from any table thread or private receipt. */
export function returnToCasino(app: CasinoApp, guildId: string, fallbackChannelId?: string | null) {
  const lobby = app.settings.lobby(guildId);
  const channelId = lobby.channelId ?? fallbackChannelId;
  return channelId
    ? linkButton('Return to casino', channelUrl(guildId, channelId, lobby.messageId), ICONS.home)
    : button({ id: NAV.home, label: 'Casino home', emoji: ICONS.home });
}
