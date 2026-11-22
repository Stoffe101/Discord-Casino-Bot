import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown } from '../../core/format.js';
import { levelInfo } from '../../domain/progression.js';
import { cid } from '../custom-id.js';
import { button, container, row, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';

/** Who is looking at a screen. Built by the Discord layer from the interaction. */
export interface Viewer {
  guildId: string;
  userId: string;
  displayName: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export type NavTarget = 'home' | 'wallet' | 'profile' | 'leaderboard' | 'rewards' | 'tables' | 'games' | 'help';

export const NAV = {
  home: cid('nav', 'home'),
  wallet: cid('nav', 'wallet'),
  profile: cid('nav', 'profile', ''),
  leaderboard: cid('nav', 'lb', 'net', 'all', 0),
  rewards: cid('nav', 'rewards'),
  tables: cid('nav', 'tables'),
  games: cid('nav', 'games'),
  help: cid('nav', 'help', 'start'),
} as const;

/** Bottom navigation row shared by every personal screen (the current screen is omitted). */
export function navRow(current: NavTarget, extra: ReturnType<typeof button>[] = []) {
  const items: { target: NavTarget; label: string; emoji: string }[] = [
    { target: 'home', label: 'Home', emoji: ICONS.home },
    { target: 'wallet', label: 'Wallet', emoji: ICONS.wallet },
    { target: 'profile', label: 'Profile', emoji: ICONS.profile },
    { target: 'leaderboard', label: 'Leaderboards', emoji: ICONS.leaderboard },
    { target: 'rewards', label: 'Rewards', emoji: ICONS.rewards },
  ];
  const buttons = items
    .filter((i) => i.target !== current)
    .slice(0, 5 - extra.length)
    .map((i) => button({ id: NAV[i.target], label: i.label, emoji: i.emoji }));
  return row(...extra, ...buttons);
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
