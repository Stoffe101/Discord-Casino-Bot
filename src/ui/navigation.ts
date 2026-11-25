import { LEADERBOARD_CATEGORIES, type LeaderboardCategory, type LeaderboardPeriod } from '../domain/leaderboard-service.js';
import { cid, parseCid } from './custom-id.js';
import type { Viewer } from './screens/common.js';

export interface BoardLocation {
  category: LeaderboardCategory;
  period: LeaderboardPeriod;
  page: number;
}

/** A private return location travels with the message and survives a bot restart. */
export function boardComponent(scope: 'lbpro' | 'lbback', viewer: Viewer, location: BoardLocation): string {
  return cid(scope, 'v1', viewer.guildId, viewer.userId, location.category, location.period, location.page);
}

export function readBoardLocation(id: string, viewer: Viewer): BoardLocation | null {
  const { scope, action, args } = parseCid(id);
  if ((scope !== 'lbpro' && scope !== 'lbback') || action !== 'v1' || args.length !== 5) return null;
  const [guild, owner, category, period, rawPage] = args;
  if (guild !== viewer.guildId || owner !== viewer.userId || !rawPage || !/^\d+$/.test(rawPage)) return null;
  const page = Number(rawPage);
  const board = LEADERBOARD_CATEGORIES.find((entry) => entry.id === category);
  if (!board || !Number.isSafeInteger(page) || !board.periods.includes(period as LeaderboardPeriod)) return null;
  return { category: board.id, period: period as LeaderboardPeriod, page };
}
