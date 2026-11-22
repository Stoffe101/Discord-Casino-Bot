import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, durationShort, signedChips } from '../../core/format.js';
import type { LedgerRow } from '../../domain/economy/economy-service.js';
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
      label: daily.available ? `Daily ${chips(daily.amount)}` : `Daily in ${durationShort(daily.nextAt - app.clock.now())}`,
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
  const dailyLine = wallet.daily.available
    ? `**Daily reward** · ready — **${chips(wallet.daily.amount)}** chips${wallet.daily.streak > 1 ? ` (day ${wallet.daily.streak} streak)` : ''}`
    : `**Daily reward** · claimed — next ${discordTime(wallet.daily.nextAt)}`;
  const tablesLine =
    tables.length === 0
      ? '**Blackjack** · no tables open — start one!'
      : `**Blackjack** · ${tables.length} ${tables.length === 1 ? 'table' : 'tables'} open · ${seated} ${seated === 1 ? 'player' : 'players'} seated`;

  const playButton = mine
    ? mine.record.threadId || mine.record.channelId
      ? linkButton(`Back to ${mine.record.name}`, channelUrl(viewer.guildId, (mine.record.threadId ?? mine.record.channelId)!, mine.record.threadId ? null : mine.record.messageId), ICONS.blackjack)
      : button({ id: NAV.tables, label: `Back to ${mine.record.name}`, emoji: ICONS.blackjack, tone: 'primary' })
    : button({ id: cid('tbl', 'quick'), label: 'Play Blackjack', emoji: ICONS.blackjack, tone: 'primary', disabled: !settings.blackjack.enabled });

  return {
    components: [
      container(COLORS.emerald, [
        section([`# ${settings.casinoName}`, greeting], thumbnail(viewer.avatarUrl, `${viewer.displayName}'s avatar`)),
        separator(),
        text(balanceLine),
        text([passiveLine, dailyLine, tablesLine].filter(Boolean).join('\n')),
        row(...claimButtons(app, viewer)),
        separator(),
        row(
          playButton,
          button({ id: NAV.tables, label: 'Tables', emoji: ICONS.tables }),
          button({ id: NAV.games, label: 'More Games', emoji: ICONS.games }),
          button({ id: NAV.help, label: 'Help', emoji: ICONS.help }),
        ),
        navRow('home'),
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
};

const GAME_LABELS: Record<string, string> = { blackjack: 'Blackjack', roulette: 'Roulette', slots: 'Slots', coinflip: 'Coinflip' };

export function ledgerLine(entry: LedgerRow): string {
  const label = `${entry.game ? `${GAME_LABELS[entry.game] ?? entry.game} ` : ''}${LEDGER_LABELS[entry.type] ?? entry.type}`;
  const memo = entry.memo && !['Passive earnings'].includes(entry.memo) ? ` — ${entry.memo}` : '';
  const amount = entry.amount === 0 ? '±0' : signedChips(entry.amount);
  return `\`${amount.padStart(8)}\` ${label}${memo.length > 90 ? `${memo.slice(0, 89)}…` : memo} · ${discordTime(entry.created_at)}`;
}

export function walletScreen(app: CasinoApp, viewer: Viewer): Screen {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const wallet = app.economy.getWallet(viewer.guildId, viewer.userId);
  const all = app.stats.snapshot(viewer.guildId, viewer.userId).all ?? {};
  const recent = app.economy.ledgerPage(viewer.guildId, viewer.userId, 5);
  const passive = wallet.passive;
  const passiveText =
    passive.ratePerHour === 0
      ? '**Passive income** · disabled on this server'
      : `**Passive income** · ${chips(passive.available)} / ${chips(passive.cap)} ready\n${progressBar(passive.cap ? passive.available / passive.cap : 0)} ${passive.isFull ? 'full — collect it!' : `full ${discordTime(passive.fullAt ?? 0)}`}\n-# Earns ${chips(passive.ratePerHour)} chips an hour, even while you're away.`;
  const dailyText = wallet.daily.available
    ? `**Daily reward** · ready — **${chips(wallet.daily.amount)}** chips${wallet.daily.streak > 1 ? ` · day ${wallet.daily.streak} streak` : ''}`
    : `**Daily reward** · claimed${wallet.daily.streak > 1 ? ` · ${wallet.daily.streak}-day streak` : ''} — next ${discordTime(wallet.daily.nextAt)}`;
  const won = all.net_won ?? 0;
  const lost = all.net_lost ?? 0;
  return {
    components: [
      container(COLORS.gold, [
        section(
          [
            '## Wallet',
            `# ${chips(wallet.balance)} chips\n-# ${wallet.reserved > 0 ? `${chips(wallet.reserved)} committed to games · ${chips(wallet.total)} total` : 'Nothing committed to games right now'}`,
          ],
          thumbnail(viewer.avatarUrl),
        ),
        separator(),
        text(`${passiveText}\n${dailyText}`),
        row(...claimButtons(app, viewer, 'wallet')),
        separator(),
        text(
          `**Lifetime** · won ${chips(won)} · lost ${chips(lost)} · net **${signedChips(won - lost)}**\n-# Peak balance ${chips(wallet.highestBalance)}`,
        ),
        text(recent.length ? `**Recent activity**\n${recent.map(ledgerLine).join('\n')}` : '**Recent activity**\nNothing yet.'),
        row(
          button({ id: cid('nav', 'history', 0), label: 'Full history', emoji: ICONS.history }),
          button({ id: NAV.wallet, label: 'Refresh', emoji: ICONS.refresh }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
          button({ id: NAV.rewards, label: 'Rewards', emoji: ICONS.rewards }),
        ),
      ]),
    ],
  };
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
        text(`## Transaction history\n-# Every chip movement is recorded in an append-only ledger. ${total} entries.`),
        separator(),
        text(entries.length ? entries.map(ledgerLine).join('\n') : 'No transactions yet.'),
        row(
          button({ id: cid('nav', 'history', p - 1), emoji: ICONS.back, disabled: p === 0 }),
          button({ id: cid('nav', 'history', 'page'), label: `Page ${p + 1} of ${pages}`, disabled: true }),
          button({ id: cid('nav', 'history', p + 1), emoji: ICONS.next, disabled: p >= pages - 1 }),
          button({ id: NAV.wallet, label: 'Wallet', emoji: ICONS.wallet }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
        ),
      ]),
    ],
  };
}

export { casinoName };
