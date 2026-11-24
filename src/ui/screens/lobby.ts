import type { CasinoApp } from '../../app/casino-app.js';
import { discordTime, escapeMarkdown, truncate } from '../../core/format.js';
import { recentCasinoActivity } from '../../domain/casino-activity.js';
import { bannerSvg } from '../../render/game-images.js';
import { cid } from '../custom-id.js';
import { button, container, gallery, option, row, select, separator, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { tableSummary } from './blackjack.js';

/**
 * The persistent public lobby message. Everything personal opens as an ephemeral panel, so
 * the channel never fills up with menus.
 */
export async function lobbyScreen(app: CasinoApp, guildId: string): Promise<Screen> {
  const settings = app.settings.get(guildId);
  const { key, png } = await app.images.render(bannerSvg(settings.casinoName), 800);
  const file = `banner-${key}.png`;
  const tables = app.blackjack.openTables(guildId);
  const seated = tables.reduce((n, t) => n + t.state.seats.length, 0);
  const wheel = app.roulette.wheelFor(guildId);
  const tableLines = tables.slice(0, 8).map((t) => `**${escapeMarkdown(t.record.name)}**${t.record.isPrivate ? ' 🔒' : ''} — ${tableSummary(t)}`);
  if (wheel) tableLines.push(`**Roulette wheel** — ${wheel.state.bets.length ? 'bets are on the table' : 'waiting for bets'} · spin ${wheel.state.spinNumber + 1}`);
  const highlights = recentCasinoActivity(app, guildId, 3);
  const highlightText = highlights.length ? `### Casino activity\n${highlights.join('\n')}` : null;
  const events = app.events.upcoming(guildId).slice(0, 2);
  const closed = !settings.enabled;
  return {
    files: [{ name: file, data: png, description: `${settings.casinoName} banner` }],
    components: [
      container(closed ? COLORS.charcoal : COLORS.emerald, [
        gallery([{ url: `attachment://${file}`, description: `${settings.casinoName}` }]),
        text(
          closed
            ? '### The casino is closed\nAn admin has closed the doors for now. Your chips are safe.'
            : `Welcome to **${escapeMarkdown(settings.casinoName)}** — a private casino for this server.\n-# Chips are free and fictional: they can't be bought, sold or cashed out. Open the casino for your wallet, rewards and stats.`,
        ),
        separator(),
        text(
          tableLines.length
            ? `### Tonight's tables\n${tableLines.join('\n')}\n-# ${seated} ${seated === 1 ? 'player' : 'players'} at the tables`
            : '### Tonight\'s tables\nNo tables are open yet — press **Quick seat** to start one.',
        ),
        tables.length
          ? select({
              id: cid('lobby', 'table'),
              placeholder: 'Join a table…',
              options: tables.slice(0, 25).map((t) =>
                option(`${truncate(t.record.name, 60)}${t.record.isPrivate ? ' 🔒' : ''}`, t.record.id, truncate(tableSummary(t), 100), '♠️'),
              ),
            })
          : null,
        row(
          button({ id: cid('tbl', 'quick'), label: 'Quick seat', emoji: ICONS.blackjack, tone: 'success', disabled: closed }),
          button({ id: cid('tbl', 'create'), label: 'New table', tone: 'primary', disabled: closed }),
          button({ id: cid('nav', 'home'), label: 'Open casino', emoji: ICONS.home }),
          button({ id: cid('nav', 'events'), label: 'Events', emoji: ICONS.events }),
        ),
        row(
          button({ id: cid('nav', 'wallet'), label: 'Wallet', emoji: ICONS.wallet }),
          button({ id: cid('nav', 'rewards'), label: 'Daily', emoji: ICONS.rewards }),
          button({ id: cid('nav', 'lb', 'net', 'week', 0), label: 'Leaderboards', emoji: ICONS.leaderboard }),
          button({ id: cid('nav', 'games'), label: 'Games', emoji: ICONS.games }),
          button({ id: cid('nav', 'help', 'start'), label: 'Help', emoji: ICONS.help }),
        ),
        separator(),
        events.length ? text(`### Upcoming events\n${events.map((event) => `**${escapeMarkdown(event.title)}** · ${discordTime(event.starts_at, 'f')}`).join('\n')}`) : null,
        highlightText ? text(highlightText) : null,
      ]),
    ],
  };
}
