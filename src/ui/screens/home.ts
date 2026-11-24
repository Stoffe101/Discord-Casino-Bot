import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, durationShort, escapeMarkdown, signedChips } from '../../core/format.js';
import { recentCasinoActivity } from '../../domain/casino-activity.js';
import type { LedgerRow } from '../../domain/economy/economy-service.js';
import { GAMES } from '../game-menu.js';
import { cid } from '../custom-id.js';
import { button, container, row, separator, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, casinoName, levelLine, name, navRow, type Viewer } from './common.js';
import { balanceText, dashboardArt, rewardSummary } from './dashboard.js';

/** Claim buttons shared by Home, Wallet and Rewards. */
export function claimButtons(app: CasinoApp, viewer: Viewer, from: 'home' | 'wallet' | 'rewards' = 'home') {
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const passive = wallet.passive;
  const daily = wallet.daily;
  const hasDailyReward = app.settings.get(viewer.guildId).economy.dailyReward > 0;
  return [
    passive.ratePerHour > 0
      ? button({
          id: cid('eco', 'passive', from),
          label: passive.available > 0 ? `Collect ${chips(passive.available)}` : 'Nothing to collect',
          emoji: ICONS.wallet,
          tone: passive.available > 0 ? 'success' : 'secondary',
          disabled: passive.available <= 0,
        })
      : null,
    button({
      id: cid('eco', 'daily', from),
      label: !hasDailyReward ? 'Daily reward disabled' : daily.available ? `Daily ${chips(daily.amount)}` : `Daily in ${durationShort(daily.nextAt - app.clock.now())}`,
      emoji: ICONS.rewards,
      tone: daily.available ? 'success' : 'secondary',
      disabled: !daily.available,
    }),
  ].filter((b): b is ReturnType<typeof button> => b !== null);
}

export async function homeScreen(app: CasinoApp, viewer: Viewer): Promise<Screen> {
  const player = app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const activity = recentCasinoActivity(app, viewer.guildId, 2);
  const settings = app.settings.get(viewer.guildId);
  const art = await dashboardArt('home');
  const sameBrand = settings.casinoName === 'The Emerald Room' && art.component;
  const nameLine = `${name(viewer.displayName)} · ${levelLine(player.xp)}`;

  return {
    files: art.files,
    components: [
      container(COLORS.emerald, [
        navRow('home'),
        art.component,
        text(`${sameBrand ? '' : `# ${escapeMarkdown(settings.casinoName)}\n`}${balanceText(wallet)}\n-# ${nameLine}`),
        row(
          button({ id: NAV.myTable, label: 'My table', emoji: ICONS.tables }),
          button({ id: NAV.tables, label: 'Browse tables', emoji: ICONS.tables }),
          button({ id: NAV.events, label: 'Events', emoji: ICONS.events }),
          button({ id: NAV.help, label: 'Help', emoji: ICONS.help }),
        ),
      ]),
      container(COLORS.deepEmerald, [
        text(rewardSummary(wallet, settings.economy.dailyReward > 0, true)),
        row(...claimButtons(app, viewer)),
        activity.length ? text(`### Casino activity\n${activity.join('\n')}`) : null,
      ]),
    ],
  };
}

// ───────────────────────────── wallet ─────────────────────────────

const LEDGER_LABELS: Record<string, string> = {
  initial_grant: 'Welcome chips',
  passive_income: 'Passive earnings',
  daily_reward: 'Daily reward',
  mission_reward: 'Mission reward',
  achievement_reward: 'Achievement reward',
  wager: 'Wager',
  wager_cancel: 'Bet withdrawn',
  win: 'Win',
  push: 'Push',
  loss: 'Settled',
  refund: 'Refund',
  admin_adjust: 'Admin adjustment',
  emergency_relief: 'Emerald Relief Fund',
  gift_sent: 'Gift sent',
  gift_received: 'Gift received',
};

export function ledgerLine(entry: LedgerRow, compact = false): string {
  const label = `${entry.game ? `${GAMES.find((game) => game.id === entry.game)?.label ?? entry.game} ` : ''}${LEDGER_LABELS[entry.type] ?? entry.type}`;
  const memo = entry.memo && !['Passive earnings'].includes(entry.memo) && !entry.type.startsWith('gift_') && entry.type !== 'emergency_relief' ? ` — ${entry.memo}` : '';
  const amount = entry.amount === 0 ? '±0' : signedChips(entry.amount);
  if (compact) return `**${amount}** · ${label} · ${discordTime(entry.created_at)}`;
  return `\`${amount.padStart(8)}\` ${label}${memo.length > 90 ? `${memo.slice(0, 89)}…` : memo} · ${discordTime(entry.created_at)}`;
}

export async function walletScreen(app: CasinoApp, viewer: Viewer): Promise<Screen> {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const relief = app.economy.reliefStatus(viewer.guildId, viewer.userId);
  const recent = app.economy.ledgerPage(viewer.guildId, viewer.userId, 4);
  const settings = app.settings.get(viewer.guildId);
  const art = await dashboardArt('wallet');
  const reliefText = relief.eligible
    ? `**Emerald Relief Fund** · ${chips(relief.amount)} chips available`
    : relief.nextAt ? `**Emerald Relief Fund** · next eligible ${discordTime(relief.nextAt)}`
    : relief.reason === 'rewards' ? '**Emerald Relief Fund** · collect your available rewards first' : null;
  return {
    files: art.files,
    components: [
      container(COLORS.gold, [
        navRow('wallet'),
        art.component,
        text(`${art.component ? '' : '**Wallet**\n'}${balanceText(wallet)}`),
        text(rewardSummary(wallet, settings.economy.dailyReward > 0)),
        row(...claimButtons(app, viewer, 'wallet')),
        reliefText ? text(reliefText) : null,
        relief.eligible ? row(
          button({ id: cid('eco', 'relief'), label: `Claim ${chips(relief.amount)} chips`, tone: 'success' }),
          relief.titleOffered ? button({ id: cid('eco', 'relief', 'title'), label: 'Claim with Sosse title' }) : null,
        ) : null,
      ]),
      container(COLORS.deepEmerald, [
        text(recent.length ? `### Recent transactions\n${recent.map((entry) => ledgerLine(entry, true)).join('\n')}` : '### Recent transactions\nNo transactions yet.'),
        row(
          button({ id: cid('nav', 'history', 0), label: 'Transactions', emoji: ICONS.history }),
          button({ id: cid('nav', 'matches'), label: 'Match history', emoji: ICONS.matches }),
          button({ id: cid('nav', 'walletstats'), label: 'Statistics', emoji: ICONS.leaderboard }),
        ),
        row(
          button({ id: NAV.rewards, label: 'Rewards', emoji: ICONS.rewards }),
          button({ id: cid('nav', 'missions'), label: 'Missions', emoji: ICONS.missions }),
          button({ id: cid('nav', 'gifting'), label: 'Gifting', emoji: ICONS.gift, disabled: !settings.economy.giftingEnabled }),
        ),
      ]),
    ],
  };
}

export function walletStatsScreen(app: CasinoApp, viewer: Viewer): Screen {
  const { balance, reserved, highestBalance } = app.economy.getWallet(viewer.guildId, viewer.userId);
  const stats = app.stats.snapshot(viewer.guildId, viewer.userId);
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(`## Chip statistics\nAvailable **${chips(balance)}** · Committed **${chips(reserved)}** · Peak **${chips(highestBalance)}**`),
    text(GAMES.map((game) => {
      const values = stats[game.id] ?? {};
      return `**${game.label}** · ${chips(values.rounds ?? 0)} rounds · net ${signedChips(values.net ?? 0)}`;
    }).join('\n')),
  ])] };
}

export const HISTORY_PAGE = 12;

export function historyScreen(app: CasinoApp, viewer: Viewer, page: number): Screen {
  const total = app.economy.ledgerCount(viewer.guildId, viewer.userId);
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const entries = app.economy.ledgerPage(viewer.guildId, viewer.userId, HISTORY_PAGE, p * HISTORY_PAGE);
  return {
    components: [
      container(COLORS.gold, [
        navRow('wallet'),
        text(`## Transaction history\n-# Every chip movement is recorded in an append-only ledger. ${total} entries.`),
        separator(),
        text(entries.length ? entries.map((entry) => ledgerLine(entry)).join('\n') : 'No transactions yet.'),
        row(
          button({ id: cid('nav', 'history', p - 1), emoji: ICONS.back, disabled: p === 0 }),
          button({ id: cid('nav', 'history', 'page'), label: `Page ${p + 1} of ${pages}`, disabled: true }),
          button({ id: cid('nav', 'history', p + 1), emoji: ICONS.next, disabled: p >= pages - 1 }),
          button({ id: cid('nav', 'wallet', 'back'), label: 'Back to wallet', emoji: ICONS.back }),
        ),
      ]),
    ],
  };
}

export { casinoName };
