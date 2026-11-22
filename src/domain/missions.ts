import { seededRng } from '../core/random.js';
import type { GameId } from './economy/economy-service.js';

export interface MissionProgressInput {
  game: GameId;
  stats: Record<string, number>;
  flags: ReadonlySet<string>;
  tablePlayers: number;
}

export interface MissionDef {
  id: string;
  name: string;
  description: string;
  target: number;
  reward: number;
  xp: number;
  /** Game that must be enabled for this mission to be offered. */
  requires: GameId;
  /** Progress gained from one recorded round. */
  track: (input: MissionProgressInput) => number;
}

const onGame = (game: GameId, fn: (i: MissionProgressInput) => number) => (i: MissionProgressInput) =>
  i.game === game ? fn(i) : 0;

/**
 * Daily missions reward taking part — never wager size — and three per day at most.
 */
export const MISSIONS: readonly MissionDef[] = [
  {
    id: 'bj_play',
    name: 'Warm-up',
    description: 'Play 5 blackjack rounds',
    target: 5,
    reward: 100,
    xp: 25,
    requires: 'blackjack',
    track: onGame('blackjack', () => 1),
  },
  {
    id: 'bj_win',
    name: 'Winning Hands',
    description: 'Win 3 blackjack hands',
    target: 3,
    reward: 120,
    xp: 25,
    requires: 'blackjack',
    track: onGame('blackjack', (i) => i.stats.hands_won ?? 0),
  },
  {
    id: 'bj_natural',
    name: 'Natural Born',
    description: 'Get a natural blackjack',
    target: 1,
    reward: 150,
    xp: 30,
    requires: 'blackjack',
    track: onGame('blackjack', (i) => i.stats.blackjacks ?? 0),
  },
  {
    id: 'bj_double',
    name: 'Double Down',
    description: 'Win a doubled hand',
    target: 1,
    reward: 120,
    xp: 25,
    requires: 'blackjack',
    track: onGame('blackjack', (i) => i.stats.doubles_won ?? 0),
  },
  {
    id: 'bj_split',
    name: 'Seeing Double',
    description: 'Split a pair',
    target: 1,
    reward: 80,
    xp: 20,
    requires: 'blackjack',
    track: onGame('blackjack', (i) => i.stats.splits ?? 0),
  },
  {
    id: 'bj_social',
    name: 'Good Company',
    description: 'Play a blackjack round with 2+ other players',
    target: 1,
    reward: 100,
    xp: 25,
    requires: 'blackjack',
    track: onGame('blackjack', (i) => (i.tablePlayers >= 3 ? 1 : 0)),
  },
  {
    id: 'roulette_play',
    name: 'Spin Cycle',
    description: 'Play 3 roulette spins',
    target: 3,
    reward: 80,
    xp: 20,
    requires: 'roulette',
    track: onGame('roulette', () => 1),
  },
  {
    id: 'slots_play',
    name: 'Reel Deal',
    description: 'Spin the slots 5 times',
    target: 5,
    reward: 60,
    xp: 15,
    requires: 'slots',
    track: onGame('slots', () => 1),
  },
  {
    id: 'coinflip_play',
    name: 'Friendly Wager',
    description: 'Finish a coinflip duel',
    target: 1,
    reward: 80,
    xp: 20,
    requires: 'coinflip',
    track: onGame('coinflip', () => 1),
  },
];

export const MISSIONS_PER_DAY = 3;

export function missionById(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}

/** Deterministically choose today's missions for a player (same answer on every call). */
export function pickMissions(guildId: string, userId: string, day: string, enabled: ReadonlySet<GameId>): MissionDef[] {
  const pool = MISSIONS.filter((m) => enabled.has(m.requires));
  const rng = seededRng(hashString(`${guildId}:${userId}:${day}`));
  const chosen: MissionDef[] = [];
  const candidates = [...pool];
  // Always include one blackjack mission when blackjack is enabled — it is the flagship game.
  const bj = candidates.filter((m) => m.requires === 'blackjack');
  if (bj.length > 0) {
    const first = bj[rng.int(bj.length)]!;
    chosen.push(first);
    candidates.splice(candidates.indexOf(first), 1);
  }
  while (chosen.length < MISSIONS_PER_DAY && candidates.length > 0) {
    const next = candidates.splice(rng.int(candidates.length), 1)[0]!;
    chosen.push(next);
  }
  return chosen;
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
