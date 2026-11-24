import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, durationShort, signedChips } from '../../core/format.js';
import { recentCasinoActivity } from '../../domain/casino-activity.js';
import type { LedgerRow } from '../../domain/economy/economy-service.js';
import { GAMES, gameEnabled } from '../game-menu.js';
import { cid } from '../custom-id.js';
import { button, container, progressBar, row, section, separator, text, thumbnail, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, casinoName, channelUrl, levelLine, name, navRow, type Viewer } from './common.js';
import { linkButton } from '../kit.js';

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

export function homeScreen(app: CasinoApp, viewer: Viewer): Screen {
  const player = app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const tables = app.blackjack.openTables(viewer.guildId);
  const activity = recentCasinoActivity(app, viewer.guildId, 2);
  const seated = tables.reduce((n, t) => n + t.state.seats.length, 0);
  const mine = app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
  const settings = app.settings.get(viewer.guildId);
  const isNew = player.created_at > app.clock.now() - 60_000 && app.economy.ledgerCount(viewer.guildId, viewer.userId) <= 1;

  const greeting = isNew
    ? `Welcome, ${name(viewer.displayName)} — here are **${chips(settings.economy.startingBalance)}** chips to get you started.`
    : `Welcome back, ${name(viewer.displayName)}.`;
  const balanceLine =
    wallet.reserved > 0
      ? `## ${chips(wallet.balance)} chips\n-# ${chips(wallet.reserved)} on the table · ${levelLine(player.xp)}`
      : `## ${chips(wallet.balance)} chips\n-# ${levelLine(player.xp)}`;

  const passive = wallet.passive;
  const passiveLine =
    passive.ratePerHour === 0
      ? null
      : passive.isFull
        ? `**Passive income** · ${chips(passive.available)} ready — full, collect it!`
        : `**Passive income** · ${chips(passive.available)} ready ${progressBar(passive.available / passive.cap, 8)} full ${discordTime(passive.fullAt ?? 0)}`;
  const dailyLine = settings.economy.dailyReward === 0 ? '**Daily reward** · disabled on this server' : wallet.daily.available
    ? `**Daily reward** · ready — **${chips(wallet.daily.amount)}** chips${wallet.daily.streak > 1 ? ` (day ${wallet.daily.streak} streak)` : ''}`
    : `**Daily reward** · claimed — next ${discordTime(wallet.daily.nextAt)}`;
  const tablesLine =
    tables.length === 0
      ? '**Blackjack** · no tables open — start one!'
      : `**Blackjack** · ${tables.length} ${tables.length === 1 ? 'table' : 'tables'} open · ${seated} ${seated === 1 ? 'player' : 'players'} seated`;

  const playButton = mine
    ? mine.record.threadId || mine.record.channelId
      ? linkButton(`Back to ${mine.record.name}`, channelUrl(viewer.guildId, (mine.record.threadId ?? mine.record.channelId)!, mine.record.threadId ? null : mine.record.messageId), ICONS.blackjack)
      : // No panel yet (still being posted): open the player's seat controls instead. A distinct id —
        // reusing the Tables button's id would make Discord reject the whole message.
        button({ id: cid('bj', 'seat', mine.record.id), label: `Back to ${mine.record.name}`, emoji: ICONS.blackjack, tone: 'primary' })
    : button({ id: cid('tbl', 'quick'), label: 'Play Blackjack', emoji: ICONS.blackjack, tone: 'primary', disabled: !gameEnabled(settings, 'blackjack') });

  return {
    components: [
      container(COLORS.emerald, [
        navRow('home'),
        section([`# ${settings.casinoName}`, greeting], thumbnail(viewer.avatarUrl, `${viewer.displayName}'s avatar`)),
        text(balanceLine),
        text([passiveLine, dailyLine, tablesLine].filter(Boolean).join('\n')),
        row(...claimButtons(app, viewer)),
        separator(),
        row(
          playButton,
          button({ id: NAV.tables, label: 'Tables', emoji: ICONS.tables }),
          button({ id: NAV.help, label: 'Help', emoji: ICONS.help }),
        ),
        row(...GAMES.filter((game) => game.id !== 'blackjack').map((game) =>
          button({ id: game.play, label: game.label, emoji: game.icon, disabled: !gameEnabled(settings, game.id) }))),
        activity.length ? text(`### Casino activity\n${activity.join('\n')}`) : null,
        isNew ? text('-# New here? **Play Blackjack** seats you at a table. Chips are free and fictional — they can never be bought or cashed out.') : null,
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

export function walletScreen(app: CasinoApp, viewer: Viewer): Screen {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const relief = app.economy.reliefStatus(viewer.guildId, viewer.userId);
  const recent = app.economy.ledgerPage(viewer.guildId, viewer.userId, 5);
  const passive = wallet.passive;
  const passiveText =
    passive.ratePerHour === 0
      ? '**Passive income** · disabled on this server'
      : `**Passive income** · ${chips(passive.available)} / ${chips(passive.cap)} ready\n${progressBar(passive.cap ? passive.available / passive.cap : 0)} ${passive.isFull ? 'full — collect it!' : `full ${discordTime(passive.fullAt ?? 0)}`}\n-# Earns ${chips(passive.ratePerHour)} chips an hour, even while you're away.`;
  const dailyText = app.settings.get(viewer.guildId).economy.dailyReward === 0 ? '**Daily reward** · disabled on this server' : wallet.daily.available
    ? `**Daily reward** · ready — **${chips(wallet.daily.amount)}** chips${wallet.daily.streak > 1 ? ` · day ${wallet.daily.streak} streak` : ''}`
    : `**Daily reward** · claimed${wallet.daily.streak > 1 ? ` · ${wallet.daily.streak}-day streak` : ''} — next ${discordTime(wallet.daily.nextAt)}`;
  const reliefText = relief.eligible
    ? `**Emerald Relief Fund** · ${chips(relief.amount)} chips available`
    : relief.nextAt ? `**Emerald Relief Fund** · next eligible ${discordTime(relief.nextAt)}`
    : relief.reason === 'rewards' ? '**Emerald Relief Fund** · collect your available rewards first'
    : relief.reason === 'funds' ? '**Emerald Relief Fund** · available when you have zero available or committed chips'
    : null;
  return {
    components: [
      container(COLORS.gold, [
        navRow('wallet'),
        section(
          [
            '## Wallet',
            `# ${chips(wallet.balance)} available\n-# ${chips(wallet.reserved)} committed · ${chips(wallet.total)} total chips`,
          ],
          thumbnail(viewer.avatarUrl),
        ),
        text(`${passiveText}\n${dailyText}`),
        row(...claimButtons(app, viewer, 'wallet')),
        reliefText ? text(reliefText) : null,
        relief.eligible ? row(
          button({ id: cid('eco', 'relief'), label: `Claim ${chips(relief.amount)} chips`, tone: 'success' }),
          relief.titleOffered ? button({ id: cid('eco', 'relief', 'title'), label: 'Claim with Sosse title' }) : null,
        ) : null,
        text(recent.length ? `### Recent transactions\n${recent.map((entry) => ledgerLine(entry, true)).join('\n')}` : '### Recent transactions\nNothing yet.'),
        row(
          button({ id: cid('nav', 'history', 0), label: 'Transactions', emoji: ICONS.history }),
          button({ id: NAV.rewards, label: 'Rewards', emoji: ICONS.rewards }),
          button({ id: cid('nav', 'missions'), label: 'Missions' }),
          button({ id: cid('nav', 'matches'), label: 'Match history' }),
        ),
        row(
          button({ id: cid('nav', 'walletstats'), label: 'Chip statistics' }),
          button({ id: cid('nav', 'gifting'), label: 'Gifting', disabled: !app.settings.get(viewer.guildId).economy.giftingEnabled }),
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
