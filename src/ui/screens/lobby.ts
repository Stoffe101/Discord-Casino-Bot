import type { CasinoApp } from '../../app/casino-app.js';
import { discordTime, escapeMarkdown } from '../../core/format.js';
import { recentCasinoActivity } from '../../domain/casino-activity.js';
import { bannerSvg } from '../../render/game-images.js';
import { button, container, gallery, row, separator, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV } from './common.js';
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
  const poker = app.poker.openTables(guildId);
  const wheel = app.roulette.wheelFor(guildId);
  const tableLines = [
    ...tables.filter((table) => !table.record.isPrivate).slice(0, 3)
      .map((table) => '♠ **' + escapeMarkdown(table.record.name) + '** · ' + tableSummary(table)),
    ...poker.filter((table) => !table.record.isPrivate).slice(0, 3)
      .map((table) => '♦ **' + escapeMarkdown(table.record.name) + '** · Hold’em · ' + table.state.seats.length + '/' + table.record.config.maxSeats + ' seated'),
  ];
  if (wheel) tableLines.push('**Roulette** · ' + (wheel.state.bets.length ? 'taking bets' : 'wheel open'));
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
        row(
          button({ id: NAV.home, label: 'Open casino', emoji: ICONS.home }),
          button({ id: NAV.games, label: 'Games', emoji: ICONS.games, tone: 'primary', disabled: closed }),
          button({ id: NAV.myTable, label: 'My table', emoji: ICONS.tables }),
          button({ id: NAV.events, label: 'Events', emoji: ICONS.events }),
        ),
        tableLines.length ? text('### Open on the floor\n' + tableLines.join('\n')) : null,
        events.length || highlightText ? separator() : null,
        events.length ? text(`### Upcoming events\n${events.map((event) => `**${escapeMarkdown(event.title)}** · ${discordTime(event.starts_at, 'f')}`).join('\n')}`) : null,
        highlightText ? text(highlightText) : null,
      ]),
    ],
  };
}
