/**
 * Casino progression: levels come from XP (earned by playing and completing goals), never from
 * chip wealth, and only unlock cosmetics. Nothing here affects odds or payouts.
 */

/** XP needed to advance from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return 100 + 50 * (level - 1);
}

/** Total XP required to reach `level` (level 1 = 0 XP). */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpToNext(l);
  return total;
}

export interface LevelInfo {
  level: number;
  xp: number;
  /** XP earned inside the current level. */
  into: number;
  /** XP span of the current level. */
  span: number;
  progress: number;
  rank: Rank;
}

export interface Rank {
  minLevel: number;
  name: string;
}

export const RANKS: readonly Rank[] = [
  { minLevel: 1, name: 'Newcomer' },
  { minLevel: 3, name: 'Regular' },
  { minLevel: 6, name: 'Card Sharp' },
  { minLevel: 10, name: 'High Roller' },
  { minLevel: 15, name: 'Pit Boss' },
  { minLevel: 20, name: 'Casino Royalty' },
  { minLevel: 30, name: 'Living Legend' },
];

export function rankForLevel(level: number): Rank {
  let current = RANKS[0]!;
  for (const rank of RANKS) if (level >= rank.minLevel) current = rank;
  return current;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 1;
  let floor = 0;
  while (xp >= floor + xpToNext(level)) {
    floor += xpToNext(level);
    level++;
  }
  const span = xpToNext(level);
  const into = xp - floor;
  return { level, xp, into, span, progress: into / span, rank: rankForLevel(level) };
}

/** Game XP per UTC day before diminishing returns kick in (discourages marathon sessions). */
export const DAILY_GAME_XP_SOFT_CAP = 400;

/** Apply the daily soft cap: XP beyond the cap is earned at 25%. */
export function cappedGameXp(earnedToday: number, gain: number): number {
  if (gain <= 0) return 0;
  const fullRoom = Math.max(0, DAILY_GAME_XP_SOFT_CAP - earnedToday);
  const full = Math.min(gain, fullRoom);
  const reduced = Math.floor((gain - full) / 4);
  return full + reduced;
}

// ───────────────────────────── cosmetics ─────────────────────────────

export type CosmeticKind = 'card_back' | 'felt' | 'title';

export interface Cosmetic {
  kind: CosmeticKind;
  id: string;
  name: string;
  description: string;
  /** Unlocked automatically at this level... */
  level?: number;
  /** ...or by unlocking this achievement. */
  achievement?: string;
}

export interface CardBackStyle {
  base: string;
  pattern: string;
  accent: string;
}

export interface FeltStyle {
  inner: string;
  outer: string;
  rail: string;
  line: string;
}

export const CARD_BACKS: Record<string, CardBackStyle> = {
  emerald: { base: '#0d4f3a', pattern: '#13684c', accent: '#d9b45a' },
  crimson: { base: '#6e1423', pattern: '#8c1c2f', accent: '#e6c36a' },
  midnight: { base: '#141c3a', pattern: '#22305e', accent: '#b8c4e6' },
  ivory: { base: '#efe6d2', pattern: '#dccfae', accent: '#9a7b3a' },
  sapphire: { base: '#0e3a66', pattern: '#15508a', accent: '#e8d08a' },
  obsidian: { base: '#111111', pattern: '#262626', accent: '#d4af37' },
  royal: { base: '#3d1a5c', pattern: '#55267f', accent: '#f0d27a' },
};

export const FELTS: Record<string, FeltStyle> = {
  emerald: { inner: '#17704f', outer: '#073626', rail: '#2a1a0e', line: '#d9b45a' },
  sapphire: { inner: '#1b5a8c', outer: '#0a2440', rail: '#1d1b24', line: '#d9c27a' },
  burgundy: { inner: '#7a2234', outer: '#330a14', rail: '#24140c', line: '#e0be6a' },
  onyx: { inner: '#2f3336', outer: '#0d0f10', rail: '#1a1a1a', line: '#c9a54e' },
  royal: { inner: '#4a2a73', outer: '#1c0d33', rail: '#21150c', line: '#f0d27a' },
};

export const COSMETICS: readonly Cosmetic[] = [
  { kind: 'card_back', id: 'emerald', name: 'Emerald', description: 'The house classic', level: 1 },
  { kind: 'card_back', id: 'crimson', name: 'Crimson', description: 'Reach level 3', level: 3 },
  { kind: 'card_back', id: 'midnight', name: 'Midnight', description: 'Reach level 6', level: 6 },
  { kind: 'card_back', id: 'ivory', name: 'Ivory', description: 'Reach level 10', level: 10 },
  { kind: 'card_back', id: 'sapphire', name: 'Sapphire', description: 'Reach level 15', level: 15 },
  { kind: 'card_back', id: 'obsidian', name: 'Obsidian', description: 'Achievement: Unstoppable', achievement: 'unstoppable' },
  { kind: 'card_back', id: 'royal', name: 'Royal Velvet', description: "Achievement: Dealer's Nightmare", achievement: 'dealers_nightmare' },

  { kind: 'felt', id: 'emerald', name: 'Emerald Felt', description: 'The house classic', level: 1 },
  { kind: 'felt', id: 'sapphire', name: 'Sapphire Felt', description: 'Reach level 5', level: 5 },
  { kind: 'felt', id: 'burgundy', name: 'Burgundy Felt', description: 'Reach level 8', level: 8 },
  { kind: 'felt', id: 'onyx', name: 'Onyx Felt', description: 'Reach level 12', level: 12 },
  { kind: 'felt', id: 'royal', name: 'Royal Felt', description: 'Achievement: House Favourite', achievement: 'house_favourite' },

  { kind: 'title', id: 'natural', name: 'The Natural', description: 'Achievement: Natural Talent', achievement: 'natural_talent' },
  { kind: 'title', id: 'lucky_seven', name: 'Lucky Seven', description: 'Achievement: Lucky Seven', achievement: 'lucky_seven' },
  { kind: 'title', id: 'charlie', name: 'Charlie', description: 'Achievement: Five Card Charlie', achievement: 'five_card_charlie' },
  { kind: 'title', id: 'streak', name: 'Unstoppable', description: 'Achievement: Unstoppable', achievement: 'unstoppable' },
  { kind: 'title', id: 'nightmare', name: "Dealer's Nightmare", description: "Achievement: Dealer's Nightmare", achievement: 'dealers_nightmare' },
  { kind: 'title', id: 'jackpot', name: 'Jackpot', description: 'Achievement: Jackpot!', achievement: 'jackpot' },
  { kind: 'title', id: 'duelist', name: 'Duelist', description: 'Achievement: Heads or Tails', achievement: 'coin_duelist' },
  { kind: 'title', id: 'regular', name: 'House Favourite', description: 'Achievement: House Favourite', achievement: 'house_favourite' },
];

export function cosmetic(kind: CosmeticKind, id: string): Cosmetic | undefined {
  return COSMETICS.find((c) => c.kind === kind && c.id === id);
}

export function isCosmeticUnlocked(c: Cosmetic, level: number, achievements: ReadonlySet<string>): boolean {
  if (c.level !== undefined && level >= c.level) return true;
  if (c.achievement !== undefined && achievements.has(c.achievement)) return true;
  return false;
}
