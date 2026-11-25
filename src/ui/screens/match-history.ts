import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, escapeMarkdown, plural, signedChips } from '../../core/format.js';
import { UserError } from '../../core/errors.js';
import { readResultDetail, type MatchResult } from '../../domain/match-history.js';
import { describeNumber } from '../../games/roulette/engine.js';
import { SYMBOL_NAMES, SYMBOLS, type SlotSymbol } from '../../games/slots/engine.js';
import { GAMES, type GameId } from '../game-menu.js';
import { cid } from '../custom-id.js';
import { button, container, option, row, select, text, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { navRow, type Viewer } from './common.js';

const PAGE_SIZE = 8;
export const gameLabel = (id: string): string => GAMES.find((game) => game.id === id)?.label ?? 'Casino game';

export function parseHistoryGame(raw: string | undefined): GameId | undefined {
  return GAMES.find((game) => game.id === raw)?.id;
}

function resultLine(result: MatchResult): string {
  const icon = GAMES.find((game) => game.id === result.game)?.icon ?? ICONS.games;
  const verdict = result.net > 0 ? `▲ won **${chips(result.net)}**` : result.net < 0 ? `▼ lost ${chips(-result.net)}` : '■ even';
  return `${icon} **${gameLabel(result.game)}** · ${verdict} · ${discordTime(result.created_at, 'R')}\n-# Bet ${chips(result.wagered)} · back ${chips(result.returned)} · net ${signedChips(result.net)} · ${discordTime(result.created_at, 'f')}`;
}

export function matchesScreen(app: CasinoApp, viewer: Viewer, game?: GameId, page = 0): Screen {
  const results = app.history.page(viewer.guildId, viewer.userId, game, page, PAGE_SIZE);
  const filter = game ?? 'all';
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(`## Match history\n-# ${plural(results.total, 'recorded round')}`),
    select({ id: cid('match', 'filter'), placeholder: 'Filter by game', options: [
      option('All games', 'all', undefined, undefined, game === undefined),
      ...GAMES.map((item) => option(item.label, item.id, undefined, item.icon, game === item.id)),
    ] }),
    text(results.results.length ? results.results.map(resultLine).join('\n') : 'No matching rounds.'),
    results.results.length ? select({
      id: cid('match', 'open', filter, results.page), placeholder: 'Inspect a result…',
      options: results.results.map((result, i) => option(
        `${results.page * PAGE_SIZE + i + 1}. ${gameLabel(result.game)} · ${signedChips(result.net)}`, result.round_id,
      )),
    }) : null,
    row(
      button({ id: cid('nav', 'matches', filter, results.page - 1), label: 'Previous', disabled: results.page === 0 }),
      button({ id: cid('nav', 'matches', filter, 'page'), label: `Page ${results.page + 1} of ${results.pages}`, disabled: true }),
      button({ id: cid('nav', 'matches', filter, results.page + 1), label: 'Next', disabled: results.page + 1 >= results.pages }),
      button({ id: cid('nav', 'wallet', 'from-matches'), label: 'Back to wallet', emoji: ICONS.back }),
    ),
  ])] };
}

export function matchDetailScreen(app: CasinoApp, viewer: Viewer, roundId: string, game?: GameId, page = 0): Screen {
  const match = app.history.get(viewer.guildId, viewer.userId, roundId);
  if (!match) throw new UserError('That result is unavailable in your match history.');
  const detail = readResultDetail(match.detail_json);
  let summary: string | undefined;
  if (match.game === 'blackjack' && Array.isArray(detail.hands)) {
    const outcomes = detail.hands.flatMap((hand: unknown) => {
      if (typeof hand !== 'object' || hand === null || !('outcome' in hand) || typeof hand.outcome !== 'string') return [];
      return [escapeMarkdown(hand.outcome)];
    });
    if (outcomes.length) summary = `Hand results · ${outcomes.join(' · ')}`;
  } else if (match.game === 'roulette' && typeof detail.number === 'number' && Number.isInteger(detail.number) && detail.number >= 0 && detail.number <= 36) {
    summary = `Winning pocket · ${describeNumber(detail.number)}`;
  } else if (match.game === 'slots' && Array.isArray(detail.line) && detail.line.length === 3 && detail.line.every((item) => SYMBOLS.includes(item))) {
    summary = `Payline · ${detail.line.map((item: SlotSymbol) => SYMBOL_NAMES[item]).join(' · ')}`;
  } else if (match.game === 'coinflip' && (detail.result === 'heads' || detail.result === 'tails')) {
    summary = `Coin landed on ${detail.result}.`;
  }
  return { components: [container(COLORS.gold, [
    navRow('wallet'),
    text(`## Round details\n${resultLine(match)}`),
    summary ? text(summary) : null,
    text(`-# Round \x60${escapeMarkdown(match.round_id)}\x60`),
    row(button({ id: cid('nav', 'matches', game ?? 'all', page), label: 'Back to results', emoji: ICONS.back })),
  ])] };
}
