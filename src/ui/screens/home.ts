import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, durationShort, escapeMarkdown, signedChips, truncate } from '../../core/format.js';
import { recentCasinoActivity } from '../../domain/casino-activity.js';
import type { LedgerRow } from '../../domain/economy/economy-service.js';
import { GAMES } from '../game-menu.js';
import { cid } from '../custom-id.js';
import { button, container, progressBar, row, section, separator, text, thumbnail, type Screen } from '../kit.js';
import { walletBadge } from '../../render/floor-art.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, casinoName, levelLine, name, navRow, type Viewer } from './common.js';
import { balanceText, rewardSummary } from './dashboard.js';
import { myTable, myTableLine, returnToTableButton } from './my-table.js';

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
  const settings = app.settings.get(viewer.guildId);
  const activity = recentCasinoActivity(app, viewer.guildId, 3);
  const table = myTable(app, viewer);
  const next = app.events.upcoming(viewer.guildId, viewer.userId)[0];
  const claims = claimButtons(app, viewer).filter((b) => !('disabled' in b && b.disabled));
  const isNew = player.created_at > app.clock.now() - 60_000 && app.economy.ledgerCount(viewer.guildId, viewer.userId) <= 1;
  const greeting = isNew
    ? `Welcome, ${name(viewer.displayName)}. Here are **${chips(settings.economy.startingBalance)}** free chips to start.`
    : `Welcome back, ${name(viewer.displayName)}.`;
  const committed = wallet.reserved > 0 ? `${chips(wallet.reserved)} at the tables · ${chips(wallet.total)} total` : 'ready to play';

  return {
    components: [
      container(table?.urgent ? COLORS.gold : COLORS.emerald, [
        navRow('home'),
        section(
          [`## ${escapeMarkdown(settings.casinoName)}`, `${greeting}
-# ${levelLine(player.xp)}`],
          thumbnail(viewer.avatarUrl, `${viewer.displayName}'s avatar`),
        ),
        text(`# ${chips(wallet.balance)} chips
-# ${committed}`),
        separator(),
        // My table: the one place to get back to a game in progress.
        table
          ? text(`### Your table
${myTableLine(table)}`)
          : text('### Your table\n-# You are not seated anywhere. Open **Games** to pick a table, the wheel or your slot machine.'),
        table ? row(returnToTableButton(table)) : null,
      ]),
      // Second card: what's waiting for you, what's coming up, and what just happened.
      container(COLORS.deepEmerald, [
        // Rewards: only what can be collected right now gets a button.
        text(`### Rewards
${rewardSummary(wallet, settings.economy.dailyReward > 0, true)}`),
        claims.length ? row(...claims) : null,
        next ? text(`### Next event
${ICONS.events} **${escapeMarkdown(truncate(next.title, 60))}** · ${next.game === 'poker' ? 'Hold’em' : 'Blackjack'} · ${discordTime(next.starts_at, 'f')} (${discordTime(next.starts_at)})`) : null,
        activity.length ? text(`### Casino activity
${activity.map((line) => `-# ${line}`).join('\n')}`) : null,
        separator(),
        row(
          button({ id: NAV.floor, label: 'Play a game', emoji: ICONS.games, tone: 'success' }),
          button({ id: NAV.events, label: 'Events', emoji: ICONS.events }),
          button({ id: NAV.help, label: 'Help', emoji: ICONS.help }),
        ),
        isNew ? text('-# Chips are free and fictional. They can never be bought, sold or cashed out.') : null,
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
  const badge = await walletBadge();
  const { passive, daily } = wallet;
  const claims = claimButtons(app, viewer, 'wallet').filter((b) => !('disabled' in b && b.disabled));
  // Rewards as two short meters rather than a wall of numbers.
  const passiveLine = passive.ratePerHour === 0 ? null
    : `**Passive income** ${progressBar(passive.cap ? passive.available / passive.cap : 0, 10)} ${chips(passive.available)} / ${chips(passive.cap)}`
      + `\n-# ${chips(passive.ratePerHour)} an hour, even while you're away${passive.isFull ? ' · full, collect it' : passive.fullAt ? ` · full ${discordTime(passive.fullAt)}` : ''}`;
  const dailyLine = settings.economy.dailyReward <= 0 ? null
    : daily.available ? `**Daily reward** · **${chips(daily.amount)}** ready${daily.streak > 1 ? ` · day ${daily.streak} streak` : ''}`
      : `**Daily reward** · claimed · next ${discordTime(daily.nextAt)}${daily.streak > 1 ? ` · ${daily.streak}-day streak` : ''}`;
  const reliefText = relief.eligible
    ? `### Emerald Relief Fund\nRunning low? **${chips(relief.amount)} free chips** are yours to claim.${relief.titleOffered ? '\n-# Optionally wear the casino title **Sosse** for 30 minutes while you play — just for fun.' : ''}`
    : relief.reason === 'rewards' && wallet.balance < 10 ? '-# Emerald Relief Fund: collect your rewards above first.'
    : relief.nextAt && wallet.balance < 10 ? `-# Emerald Relief Fund: next available ${discordTime(relief.nextAt)}.` : null;
  const committed = wallet.reserved > 0
    ? `${chips(wallet.reserved)} at the tables · ${chips(wallet.total)} total`
    : 'available to play';
  return {
    files: badge ? [badge] : [],
    components: [
      container(COLORS.gold, [
        navRow('wallet'),
        badge
          ? section(['## Wallet', `# ${chips(wallet.balance)} chips`, `-# ${committed}`], thumbnail(`attachment://${badge.name}`, badge.description))
          : text(`## Wallet\n${balanceText(wallet)}`),
        separator(),
        text(`### Rewards\n${[passiveLine, dailyLine].filter(Boolean).join('\n') || '-# Rewards are switched off on this server.'}`),
        claims.length ? row(...claims) : null,
        reliefText ? text(reliefText) : null,
        relief.eligible ? row(
          button({ id: cid('eco', 'relief'), label: `Claim ${chips(relief.amount)} chips`, emoji: ICONS.rewards, tone: 'success' }),
          relief.titleOffered ? button({ id: cid('eco', 'relief', 'title'), label: 'Claim as Sosse', emoji: ICONS.sosse }) : null,
        ) : null,
        separator(),
        text(recent.length ? `### Recent activity\n${recent.map((entry) => ledgerLine(entry, true)).join('\n')}` : '### Recent activity\n-# Nothing yet — your wins, bets and rewards will show up here.'),
        row(
          button({ id: cid('nav', 'history', 0), label: 'Transactions', emoji: ICONS.history }),
          button({ id: cid('nav', 'matches'), label: 'Match history', emoji: ICONS.matches }),
          button({ id: cid('nav', 'missions'), label: 'Missions', emoji: ICONS.missions }),
          settings.economy.giftingEnabled ? button({ id: cid('nav', 'gifting'), label: 'Gift chips', emoji: ICONS.gift }) : null,
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
          button({ id: cid('nav', 'history', p - 1), emoji: ICONS.prev, disabled: p === 0 }),
          button({ id: cid('nav', 'history', 'page'), label: `Page ${p + 1} of ${pages}`, disabled: true }),
          button({ id: cid('nav', 'history', p + 1), emoji: ICONS.next, disabled: p >= pages - 1 }),
          button({ id: cid('nav', 'walletstats'), label: 'Stats', emoji: ICONS.stats }),
          button({ id: cid('nav', 'wallet', 'back'), label: 'Wallet', emoji: ICONS.back }),
        ),
      ]),
    ],
  };
}

export { casinoName };
