import type { CasinoApp } from '../../app/casino-app.js';
import { escapeMarkdown, truncate } from '../../core/format.js';
import { LEADERBOARD_CATEGORIES, type LeaderboardCategory, type LeaderboardPeriod } from '../../domain/leaderboard-service.js';
import { cid } from '../custom-id.js';
import { button, container, option, row, select, separator, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { NAV, type Viewer } from './common.js';

export const LEADERBOARD_PAGE = 10;

const PERIOD_LABEL: Record<LeaderboardPeriod, string> = { all: 'All-time', week: 'This week', day: 'Today' };
const MEDALS = ['🥇', '🥈', '🥉'];

export function leaderboardScreen(
  app: CasinoApp,
  viewer: Viewer,
  category: LeaderboardCategory,
  period: LeaderboardPeriod,
  page: number,
): Screen {
  app.economy.ensurePlayer(viewer.guildId, viewer.userId, viewer.displayName);
  const board = app.leaderboards.page(viewer.guildId, category, period, page, LEADERBOARD_PAGE, viewer.userId);
  const { category: info } = board;
  const lines = board.entries.map((e) => {
    const marker = e.rank <= 3 ? MEDALS[e.rank - 1] : `\`#${String(e.rank).padStart(2)}\``;
    const who = escapeMarkdown(truncate(e.displayName || 'Player', 24));
    const line = `${marker} ${e.userId === viewer.userId ? `__**${who}**__` : `**${who}**`} · ${e.display}`;
    return line;
  });
  const viewerOnPage = board.entries.some((e) => e.userId === viewer.userId);
  const viewerLine = board.viewer
    ? viewerOnPage
      ? `-# You're **#${board.viewer.rank}** of ${board.total}.`
      : `-# ▸ You: **#${board.viewer.rank}** of ${board.total} — ${board.viewer.display}`
    : '-# You are not on this board yet.';
  const periodButtons = info.periods.length > 1
    ? row(
        ...info.periods.map((p) =>
          button({ id: cid('nav', 'lb', info.id, p, 0, 'p'), label: PERIOD_LABEL[p], tone: p === board.period ? 'primary' : 'secondary', disabled: p === board.period }),
        ),
      )
    : null;
  const profileOptions = board.entries.map((e) => option(`#${e.rank} ${truncate(e.displayName || 'Player', 60)}`, e.userId, e.display));
  return {
    components: [
      container(COLORS.gold, [
        text(`## 🏆 ${info.label}\n-# ${PERIOD_LABEL[board.period]} · ${info.description}`),
        select({
          id: cid('lbcat', board.period),
          placeholder: 'Choose a leaderboard',
          options: LEADERBOARD_CATEGORIES.map((c) => option(c.label, c.id, c.description, undefined, c.id === info.id)),
        }),
        separator(),
        text(lines.length ? `${lines.join('\n')}\n\n${viewerLine}` : `Nobody is on this board yet — be the first!\n\n${viewerLine}`),
        periodButtons,
        row(
          button({ id: cid('nav', 'lb', info.id, board.period, board.page - 1), emoji: ICONS.back, disabled: board.page === 0 }),
          button({ id: cid('nav', 'lb', info.id, board.period, 'page'), label: `Page ${board.page + 1} of ${board.pages}`, disabled: true }),
          button({ id: cid('nav', 'lb', info.id, board.period, board.page + 1), emoji: ICONS.next, disabled: board.page >= board.pages - 1 }),
          button({ id: cid('nav', 'lb', info.id, board.period, board.page, 'r'), label: 'Refresh', emoji: ICONS.refresh }),
          button({ id: NAV.home, label: 'Home', emoji: ICONS.home }),
        ),
        profileOptions.length ? select({ id: cid('lbpro', 'view'), placeholder: 'View a player’s profile…', options: profileOptions }) : null,
      ]),
    ],
  };
}
