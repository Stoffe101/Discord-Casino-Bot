/**
 * The casino's visual language: deep emerald, charcoal and warm gold, with restrained
 * typography and very few emoji (icons on navigation buttons only).
 */
export const COLORS = {
  emerald: 0x13784f,
  deepEmerald: 0x0c4f35,
  gold: 0xd6ad4b,
  crimson: 0xb3263a,
  charcoal: 0x30343a,
  win: 0x1f9d63,
  sapphire: 0x2f6db3,
  violet: 0x6b46c1,
} as const;

/** Button icons (unicode emoji keep working without uploading custom emoji). */
export const ICONS = {
  home: '🏠',
  poker: '♦️',
  blackjack: '🃏',
  tables: '🪑',
  wallet: '💰',
  profile: '👤',
  leaderboard: '🏆',
  rewards: '🎁',
  games: '🎲',
  events: '📅',
  matches: '🗂️',
  missions: '📋',
  gift: '💝',
  spectate: '👁️',
  leave: '🚪',
  hand: '✋',
  help: '❔',
  rules: '📖',
  stats: '📊',
  sosse: '🎭',
  refresh: '🔄',
  back: '↩️',
  prev: '◀️',
  next: '▶️',
  roulette: '🎡',
  slots: '🎰',
  coinflip: '🪙',
  settings: '⚙️',
  lock: '🔒',
  achievements: '🎖️',
  history: '📜',
  style: '🎨',
} as const;

/** Unicode ornaments used inside text. */
export const GLYPH = {
  spade: '♠',
  heart: '♥',
  diamond: '♦',
  club: '♣',
  dot: '·',
  bullet: '▸',
  star: '✦',
  diamondSmall: '◆',
} as const;

export const SUIT_LINE = '♠ ♥ ♦ ♣';
