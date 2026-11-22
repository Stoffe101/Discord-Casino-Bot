import { stat, type StatSnapshot } from './stats-service.js';

export interface AchievementContext {
  stats: StatSnapshot;
  /** Facts from the round being recorded (empty when just browsing). */
  flags: ReadonlySet<string>;
  level: number;
}

export interface AchievementReward {
  chips?: number;
  xp?: number;
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  /** Unicode glyph used in lists (kept to a single tasteful symbol). */
  icon: string;
  category: 'blackjack' | 'casino' | 'roulette' | 'slots' | 'coinflip';
  reward: AchievementReward;
  /** Hidden until unlocked. */
  secret?: boolean;
  /** Progress towards a numeric goal, if the achievement has one. */
  progress?: (ctx: AchievementContext) => { current: number; target: number };
  /** Event-style achievements unlock from a round fact. */
  flag?: string;
}

const counter =
  (game: string, name: string, target: number) =>
  (ctx: AchievementContext): { current: number; target: number } => ({
    current: Math.min(stat(ctx.stats, game, name), target),
    target,
  });

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    id: 'first_hand',
    name: 'First Hand',
    description: 'Complete your first blackjack round.',
    icon: '♠',
    category: 'blackjack',
    reward: { chips: 100, xp: 50 },
    progress: counter('blackjack', 'rounds', 1),
  },
  {
    id: 'natural_talent',
    name: 'Natural Talent',
    description: 'Get your first natural blackjack.',
    icon: '✦',
    category: 'blackjack',
    reward: { chips: 150, xp: 75 },
    progress: counter('blackjack', 'blackjacks', 1),
  },
  {
    id: 'twenty_one_club',
    name: 'Twenty-One Club',
    description: 'Get 25 natural blackjacks.',
    icon: '✦',
    category: 'blackjack',
    reward: { chips: 400, xp: 200 },
    progress: counter('blackjack', 'blackjacks', 25),
  },
  {
    id: 'on_a_roll',
    name: 'On a Roll',
    description: 'Win five blackjack rounds in a row.',
    icon: '➚',
    category: 'blackjack',
    reward: { chips: 200, xp: 100 },
    progress: counter('blackjack', 'best_streak', 5),
  },
  {
    id: 'unstoppable',
    name: 'Unstoppable',
    description: 'Win ten blackjack rounds in a row. Unlocks the Obsidian card back.',
    icon: '➚',
    category: 'blackjack',
    reward: { chips: 500, xp: 250 },
    progress: counter('blackjack', 'best_streak', 10),
  },
  {
    id: 'high_roller',
    name: 'High Roller',
    description: 'Win a blackjack hand with a stake of 500 chips or more.',
    icon: '◆',
    category: 'blackjack',
    reward: { xp: 100 },
    flag: 'bj_big_win',
  },
  {
    id: 'split_decision',
    name: 'Split Decision',
    description: 'Split a pair and win both hands.',
    icon: '⫽',
    category: 'blackjack',
    reward: { chips: 150, xp: 100 },
    flag: 'bj_split_both_won',
  },
  {
    id: 'lucky_seven',
    name: 'Lucky Seven',
    description: 'Win a hand with 21 made from three or more cards.',
    icon: '7',
    category: 'blackjack',
    reward: { chips: 150, xp: 75 },
    flag: 'bj_multi_card_21_win',
  },
  {
    id: 'five_card_charlie',
    name: 'Five Card Charlie',
    description: 'Hold five cards without going bust.',
    icon: '✋',
    category: 'blackjack',
    reward: { chips: 150, xp: 100 },
    flag: 'bj_five_cards',
  },
  {
    id: 'double_trouble',
    name: 'Double Trouble',
    description: 'Win a doubled hand.',
    icon: '×2',
    category: 'blackjack',
    reward: { chips: 100, xp: 50 },
    progress: counter('blackjack', 'doubles_won', 1),
  },
  {
    id: 'safety_first',
    name: 'Safety First',
    description: 'Collect an insurance payout.',
    icon: '⛨',
    category: 'blackjack',
    reward: { xp: 75 },
    flag: 'bj_insurance_paid',
  },
  {
    id: 'comeback_kid',
    name: 'Comeback Kid',
    description: 'Win a round right after losing five in a row.',
    icon: '↺',
    category: 'blackjack',
    reward: { chips: 200, xp: 100 },
    flag: 'comeback',
    secret: true,
  },
  {
    id: 'full_house',
    name: 'Full House',
    description: 'Play a round at a table with five or more players.',
    icon: '☷',
    category: 'blackjack',
    reward: { xp: 75 },
    flag: 'bj_full_table',
  },
  {
    id: 'century',
    name: 'Century',
    description: 'Play 100 blackjack rounds.',
    icon: '♣',
    category: 'blackjack',
    reward: { chips: 300, xp: 150 },
    progress: counter('blackjack', 'rounds', 100),
  },
  {
    id: 'dealers_nightmare',
    name: "Veteran Dealer's Nightmare",
    description: 'Win 100 blackjack hands. Unlocks the Royal Velvet card back.',
    icon: '♛',
    category: 'blackjack',
    reward: { chips: 500, xp: 300 },
    progress: counter('blackjack', 'hands_won', 100),
  },
  {
    id: 'regular_guest',
    name: 'Regular Guest',
    description: 'Play on five different days.',
    icon: '☼',
    category: 'casino',
    reward: { chips: 200, xp: 100 },
    progress: counter('all', 'days_played', 5),
  },
  {
    id: 'house_favourite',
    name: 'House Favourite',
    description: 'Play on twenty different days. Unlocks the Royal felt.',
    icon: '♥',
    category: 'casino',
    reward: { chips: 500, xp: 250 },
    progress: counter('all', 'days_played', 20),
  },
  {
    id: 'distinguished',
    name: 'Distinguished Guest',
    description: 'Reach casino level 10.',
    icon: '♜',
    category: 'casino',
    reward: { chips: 300 },
    progress: (ctx) => ({ current: Math.min(ctx.level, 10), target: 10 }),
  },
  {
    id: 'coin_duelist',
    name: 'Heads or Tails',
    description: 'Win a coinflip duel.',
    icon: '◐',
    category: 'coinflip',
    reward: { chips: 100, xp: 50 },
    progress: counter('coinflip', 'wins', 1),
  },
  {
    id: 'straight_up',
    name: 'Straight Up',
    description: 'Win a single-number roulette bet.',
    icon: '◎',
    category: 'roulette',
    reward: { chips: 150, xp: 100 },
    flag: 'roulette_straight_win',
  },
  {
    id: 'jackpot',
    name: 'Jackpot!',
    description: 'Line up three sevens on the slot machine.',
    icon: '7',
    category: 'slots',
    reward: { xp: 200 },
    flag: 'slots_jackpot',
    secret: true,
  },
];

export function achievementById(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

export function isAchieved(def: AchievementDef, ctx: AchievementContext): boolean {
  if (def.flag && ctx.flags.has(def.flag)) return true;
  if (def.progress) {
    const { current, target } = def.progress(ctx);
    return current >= target;
  }
  return false;
}
