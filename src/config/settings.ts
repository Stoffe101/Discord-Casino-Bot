/**
 * Per-server casino settings. Defaults live here; each server stores only its overrides
 * (guild_settings.settings_json) and edits them through the admin panel — no code changes.
 */
export interface GuildSettings {
  casinoName: string;
  eventOrganizerRole: string;
  enabled: boolean;
  /** Animated spins, reels and coin tosses (blackjack has its own switch). */
  animations: boolean;
  economy: {
    startingBalance: number;
    passivePerHour: number;
    passiveCapHours: number;
    dailyReward: number;
    dailyStreakBonus: number;
    dailyStreakMaxDays: number;
    reliefAmount: number;
    reliefCooldownHours: number;
    reliefTitle: boolean;
    reliefNickname: boolean;
    giftingEnabled: boolean;
    giftDailyLimit: number;
  };
  highlights: { enabled: boolean; bigNet: number; majorNet: number; minimumWager: number; allInStake: number; pokerReturn: number; cooldownSeconds: number };
  blackjack: {
    enabled: boolean;
    minBet: number;
    maxBet: number;
    maxSeats: number;
    turnSeconds: number;
    bettingSeconds: number;
    insuranceSeconds: number;
    decks: number;
    dealerHitsSoft17: boolean;
    blackjackPayout: '3:2' | '6:5';
    doubleAfterSplit: boolean;
    surrender: boolean;
    insurance: boolean;
    maxSplitHands: number;
    resplitAces: boolean;
    penetrationPercent: number;
    dealerAnimation: boolean;
  };
  tables: {
    maxTables: number;
    useThreads: boolean;
    idleEmptyMinutes: number;
    idleMinutes: number;
  };
  coinflip: { enabled: boolean; minBet: number; maxBet: number; expirySeconds: number };
  roulette: { enabled: boolean; minBet: number; maxBet: number; bettingSeconds: number; minimumReadySeconds: number };
  slots: { enabled: boolean; minBet: number; maxBet: number };
  poker: { enabled: boolean; minBuyIn: number; maxBuyIn: number; smallBlind: number; bigBlind: number; maxSeats: number; turnSeconds: number };
}

export const DEFAULT_SETTINGS: GuildSettings = {
  casinoName: 'The Emerald Room',
  eventOrganizerRole: 'off',
  animations: true,
  enabled: true,
  economy: {
    startingBalance: 500,
    passivePerHour: 20,
    passiveCapHours: 24,
    dailyReward: 100,
    dailyStreakBonus: 10,
    dailyStreakMaxDays: 7,
    reliefAmount: 50,
    reliefCooldownHours: 24,
    reliefTitle: true,
    reliefNickname: false,
    giftingEnabled: true,
    giftDailyLimit: 500,
  },
  highlights: { enabled: true, bigNet: 500, majorNet: 1000, minimumWager: 50, allInStake: 250, pokerReturn: 750, cooldownSeconds: 300 },
  blackjack: {
    enabled: true,
    minBet: 10,
    maxBet: 500,
    maxSeats: 5,
    turnSeconds: 30,
    bettingSeconds: 20,
    insuranceSeconds: 12,
    decks: 6,
    dealerHitsSoft17: false,
    blackjackPayout: '3:2',
    doubleAfterSplit: true,
    surrender: true,
    insurance: true,
    maxSplitHands: 4,
    resplitAces: false,
    penetrationPercent: 75,
    dealerAnimation: true,
  },
  tables: {
    maxTables: 6,
    useThreads: true,
    idleEmptyMinutes: 10,
    idleMinutes: 30,
  },
  coinflip: { enabled: true, minBet: 10, maxBet: 1000, expirySeconds: 120 },
  roulette: { enabled: true, minBet: 10, maxBet: 500, bettingSeconds: 25, minimumReadySeconds: 8 },
  slots: { enabled: true, minBet: 5, maxBet: 250 },
  poker: { enabled: false, minBuyIn: 100, maxBuyIn: 500, smallBlind: 5, bigBlind: 10, maxSeats: 6, turnSeconds: 40 },
};

export type SettingSpec =
  | { key: string; group: SettingGroup; label: string; help: string; type: 'int'; min: number; max: number }
  | { key: string; group: SettingGroup; label: string; help: string; type: 'bool' }
  | { key: string; group: SettingGroup; label: string; help: string; type: 'enum'; options: readonly string[] }
  | { key: string; group: SettingGroup; label: string; help: string; type: 'text'; maxLength: number };

export type SettingGroup = 'general' | 'economy' | 'blackjack' | 'tables' | 'games' | 'highlights' | 'poker';

export const SETTING_GROUPS: Record<SettingGroup, { label: string; description: string }> = {
  general: { label: 'General', description: 'Casino name and master switch' },
  economy: { label: 'Economy', description: 'Starting chips, passive income, daily rewards' },
  blackjack: { label: 'Blackjack', description: 'Limits, timers and house rules' },
  tables: { label: 'Tables', description: 'Table limits, threads and idle cleanup' },
  poker: { label: 'Poker', description: 'Hold’em availability, buy-ins, blinds and turn timer' },
  highlights: { label: 'Highlights', description: 'Lobby activity thresholds and cooldown' },
  games: { label: 'Other games', description: 'Coinflip, roulette and slots' },
};

/** Declarative description of every editable setting (drives validation and the admin UI). */
export const SETTING_SPECS: readonly SettingSpec[] = [
  { key: 'casinoName', group: 'general', label: 'Casino name', help: 'Shown on every screen', type: 'text', maxLength: 40 },
  { key: 'enabled', group: 'general', label: 'Casino open', help: 'Close the casino to everyone but admins', type: 'bool' },
  { key: 'animations', group: 'general', label: 'Game animations', help: 'Animated roulette spins, slot reels and coin tosses', type: 'bool' },

  { key: 'eventOrganizerRole', group: 'general', label: 'Event organizer role', help: 'Discord role ID, or off for server managers only', type: 'text', maxLength: 22 },
  { key: 'economy.startingBalance', group: 'economy', label: 'Starting chips', help: 'Granted once to new players', type: 'int', min: 0, max: 1_000_000 },
  { key: 'economy.passivePerHour', group: 'economy', label: 'Passive chips / hour', help: 'Accrues while offline', type: 'int', min: 0, max: 100_000 },
  { key: 'economy.passiveCapHours', group: 'economy', label: 'Passive cap (hours)', help: 'Accrual stops after this many hours', type: 'int', min: 1, max: 168 },
  { key: 'economy.dailyReward', group: 'economy', label: 'Daily reward', help: 'Base daily claim (UTC days)', type: 'int', min: 0, max: 1_000_000 },
  { key: 'economy.dailyStreakBonus', group: 'economy', label: 'Streak bonus / day', help: 'Extra chips per consecutive day', type: 'int', min: 0, max: 100_000 },
  { key: 'economy.dailyStreakMaxDays', group: 'economy', label: 'Streak bonus cap (days)', help: 'Bonus stops growing after this', type: 'int', min: 1, max: 30 },

  { key: 'economy.reliefAmount', group: 'economy', label: 'Relief grant', help: 'Set to zero to close the relief fund', type: 'int', min: 0, max: 1000 },
  { key: 'economy.reliefCooldownHours', group: 'economy', label: 'Relief cooldown (h)', help: 'Time between eligible relief claims', type: 'int', min: 1, max: 168 },
  { key: 'economy.reliefTitle', group: 'economy', label: 'Sosse title', help: 'Offer an optional temporary casino profile title', type: 'bool' },
  { key: 'economy.reliefNickname', group: 'economy', label: 'Sosse server nickname', help: 'Offer a temporary nickname when the deployment has authorized it', type: 'bool' },
  { key: 'economy.giftingEnabled', group: 'economy', label: 'Chip gifting', help: 'Allow small gifts between established accounts', type: 'bool' },
  { key: 'economy.giftDailyLimit', group: 'economy', label: 'Daily gift limit', help: 'Maximum sent by one player per UTC day', type: 'int', min: 10, max: 5000 },
  { key: 'highlights.enabled', group: 'highlights', label: 'Activity highlights', help: 'Show notable moments in the casino lobby', type: 'bool' },
  { key: 'highlights.bigNet', group: 'highlights', label: 'Big-win net profit', help: 'Minimum profit for a big win', type: 'int', min: 1, max: 10_000_000 },
  { key: 'highlights.majorNet', group: 'highlights', label: 'Major-win net profit', help: 'Minimum profit for a major win', type: 'int', min: 1, max: 10_000_000 },
  { key: 'highlights.minimumWager', group: 'highlights', label: 'Highlight wager floor', help: 'Minimum stake for a big win or slots jackpot', type: 'int', min: 1, max: 10_000_000 },
  { key: 'highlights.allInStake', group: 'highlights', label: 'All-in highlight stake', help: 'Minimum full-stack Hold’em commitment for an all-in win highlight', type: 'int', min: 1, max: 10_000_000 },
  { key: 'highlights.pokerReturn', group: 'highlights', label: 'Poker highlight payout', help: 'Minimum share of the pots returned for a Hold’em pot win highlight', type: 'int', min: 1, max: 10_000_000 },
  { key: 'highlights.cooldownSeconds', group: 'highlights', label: 'Player cooldown (s)', help: 'Minimum time between win highlights per player', type: 'int', min: 0, max: 86400 },
  { key: 'blackjack.enabled', group: 'blackjack', label: 'Blackjack enabled', help: 'Allow new blackjack tables', type: 'bool' },
  { key: 'blackjack.minBet', group: 'blackjack', label: 'Minimum bet', help: 'Server-wide floor', type: 'int', min: 1, max: 1_000_000 },
  { key: 'blackjack.maxBet', group: 'blackjack', label: 'Maximum bet', help: 'Server-wide ceiling', type: 'int', min: 1, max: 10_000_000 },
  { key: 'blackjack.maxSeats', group: 'blackjack', label: 'Seats per table', help: 'Default and maximum seats', type: 'int', min: 1, max: 7 },
  { key: 'blackjack.turnSeconds', group: 'blackjack', label: 'Turn timer (s)', help: 'Then the hand auto-stands', type: 'int', min: 10, max: 180 },
  { key: 'blackjack.bettingSeconds', group: 'blackjack', label: 'Betting window (s)', help: 'Starts at the first bet', type: 'int', min: 5, max: 120 },
  { key: 'blackjack.insuranceSeconds', group: 'blackjack', label: 'Insurance window (s)', help: 'Then insurance is declined', type: 'int', min: 5, max: 60 },
  { key: 'blackjack.decks', group: 'blackjack', label: 'Decks in shoe', help: 'Applies to new shoes', type: 'int', min: 1, max: 8 },
  { key: 'blackjack.dealerHitsSoft17', group: 'blackjack', label: 'Dealer hits soft 17', help: 'Off = dealer stands on all 17s', type: 'bool' },
  { key: 'blackjack.blackjackPayout', group: 'blackjack', label: 'Blackjack payout', help: 'Natural blackjack odds', type: 'enum', options: ['3:2', '6:5'] },
  { key: 'blackjack.doubleAfterSplit', group: 'blackjack', label: 'Double after split', help: 'Allow doubling split hands', type: 'bool' },
  { key: 'blackjack.surrender', group: 'blackjack', label: 'Late surrender', help: 'Forfeit half on the first decision', type: 'bool' },
  { key: 'blackjack.insurance', group: 'blackjack', label: 'Insurance', help: 'Offered when the dealer shows an ace', type: 'bool' },
  { key: 'blackjack.maxSplitHands', group: 'blackjack', label: 'Max hands after splits', help: '2 = no resplitting', type: 'int', min: 2, max: 4 },
  { key: 'blackjack.resplitAces', group: 'blackjack', label: 'Resplit aces', help: 'Allow splitting aces again', type: 'bool' },
  { key: 'blackjack.penetrationPercent', group: 'blackjack', label: 'Shoe penetration (%)', help: 'Reshuffle after this much is dealt', type: 'int', min: 50, max: 90 },
  { key: 'blackjack.dealerAnimation', group: 'blackjack', label: 'Table animations', help: 'Animated dealing, card draws, dealer reveal and payouts', type: 'bool' },

  { key: 'tables.maxTables', group: 'tables', label: 'Max open tables', help: 'Across all games', type: 'int', min: 1, max: 25 },
  { key: 'tables.useThreads', group: 'tables', label: 'Use table threads', help: 'Off = post tables in the casino channel', type: 'bool' },
  { key: 'tables.idleEmptyMinutes', group: 'tables', label: 'Close empty tables after (min)', help: 'Tables with nobody seated', type: 'int', min: 2, max: 1440 },
  { key: 'tables.idleMinutes', group: 'tables', label: 'Close idle tables after (min)', help: 'No bets placed in this long', type: 'int', min: 5, max: 1440 },

  { key: 'coinflip.enabled', group: 'games', label: 'Coinflip duels', help: 'Player-vs-player flips', type: 'bool' },
  { key: 'coinflip.minBet', group: 'games', label: 'Coinflip min', help: 'Minimum duel stake', type: 'int', min: 1, max: 1_000_000 },
  { key: 'coinflip.maxBet', group: 'games', label: 'Coinflip max', help: 'Maximum duel stake', type: 'int', min: 1, max: 10_000_000 },
  { key: 'coinflip.expirySeconds', group: 'games', label: 'Challenge expiry (s)', help: 'Unanswered challenges refund', type: 'int', min: 30, max: 3600 },
  { key: 'poker.enabled', group: 'poker', label: 'Hold’em tables', help: 'Enable opening new poker tables', type: 'bool' },
  { key: 'poker.minBuyIn', group: 'poker', label: 'Minimum buy-in', help: 'Lower limit for new stacks', type: 'int', min: 10, max: 100000 },
  { key: 'poker.maxBuyIn', group: 'poker', label: 'Maximum buy-in', help: 'Upper limit for new stacks', type: 'int', min: 10, max: 100000 },
  { key: 'poker.smallBlind', group: 'poker', label: 'Small blind', help: 'Applies to newly opened tables', type: 'int', min: 1, max: 10000 },
  { key: 'poker.bigBlind', group: 'poker', label: 'Big blind', help: 'Applies to newly opened tables', type: 'int', min: 2, max: 20000 },
  { key: 'poker.maxSeats', group: 'poker', label: 'Seats per table', help: 'Default maximum seats for Hold’em', type: 'int', min: 2, max: 7 },
  { key: 'poker.turnSeconds', group: 'poker', label: 'Turn timer (s)', help: 'Checks if possible or folds on timeout', type: 'int', min: 15, max: 180 },
  { key: 'roulette.enabled', group: 'games', label: 'Roulette', help: 'Shared roulette wheel', type: 'bool' },
  { key: 'roulette.minBet', group: 'games', label: 'Roulette min', help: 'Minimum bet', type: 'int', min: 1, max: 1_000_000 },
  { key: 'roulette.maxBet', group: 'games', label: 'Roulette max', help: 'Maximum bet per spot', type: 'int', min: 1, max: 10_000_000 },
  { key: 'roulette.bettingSeconds', group: 'games', label: 'Roulette betting (s)', help: 'Window after the first bet', type: 'int', min: 10, max: 120 },
  { key: 'roulette.minimumReadySeconds', group: 'games', label: 'Roulette early start (s)', help: 'Minimum time before a ready majority can spin', type: 'int', min: 1, max: 120 },
  { key: 'slots.enabled', group: 'games', label: 'Slots', help: 'Personal slot machine', type: 'bool' },
  { key: 'slots.minBet', group: 'games', label: 'Slots min', help: 'Minimum spin', type: 'int', min: 1, max: 1_000_000 },
  { key: 'slots.maxBet', group: 'games', label: 'Slots max', help: 'Maximum spin', type: 'int', min: 1, max: 10_000_000 },
];

export function getSpec(key: string): SettingSpec | undefined {
  return SETTING_SPECS.find((s) => s.key === key);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getPath(obj: unknown, key: string): unknown {
  let current: unknown = obj;
  for (const part of key.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(obj: Json, key: string, value: unknown): void {
  const parts = key.split('.');
  let current: Json = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {};
    current = current[part] as Json;
  }
  current[parts[parts.length - 1]!] = value;
}

/** Validate and coerce a raw value for a setting. Throws a friendly message on bad input. */
export function coerceSetting(spec: SettingSpec, raw: unknown): unknown {
  switch (spec.type) {
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,_\s]/g, ''));
      if (!Number.isInteger(n)) throw new Error(`${spec.label} must be a whole number.`);
      if (n < spec.min || n > spec.max) {
        throw new Error(`${spec.label} must be between ${spec.min.toLocaleString('en-US')} and ${spec.max.toLocaleString('en-US')}.`);
      }
      return n;
    }
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      throw new Error(`${spec.label} must be on or off.`);
    case 'enum':
      if (typeof raw === 'string' && spec.options.includes(raw)) return raw;
      throw new Error(`${spec.label} must be one of ${spec.options.join(', ')}.`);
    case 'text': {
      const text = String(raw ?? '').trim();
      if (text.length === 0 || text.length > spec.maxLength) {
        throw new Error(`${spec.label} must be 1–${spec.maxLength} characters.`);
      }
      return text;
    }
  }
}

/** Merge stored overrides onto defaults, silently dropping anything invalid or unknown. */
export function resolveSettings(overrides: unknown): GuildSettings {
  const result = structuredClone(DEFAULT_SETTINGS) as unknown as Json;
  for (const spec of SETTING_SPECS) {
    const raw = getPath(overrides, spec.key);
    if (raw === undefined) continue;
    try {
      setPath(result, spec.key, coerceSetting(spec, raw));
    } catch {
      // Ignore invalid stored values; the default stays in effect.
    }
  }
  const settings = result as unknown as GuildSettings;
  // Cross-field sanity: keep min <= max for every game.
  for (const game of [settings.blackjack, settings.coinflip, settings.roulette, settings.slots]) {
    if (game.minBet > game.maxBet) game.maxBet = game.minBet;
  }
  const poker = settings.poker;
  poker.bigBlind = Math.max(poker.bigBlind, poker.smallBlind + 1);
  poker.minBuyIn = Math.max(poker.minBuyIn, poker.bigBlind);
  poker.maxBuyIn = Math.max(poker.maxBuyIn, poker.minBuyIn);
  return settings;
}

/** Produce a new overrides object with one setting changed (validated). */
export function applySettingOverride(overrides: unknown, key: string, raw: unknown): Json {
  const spec = getSpec(key);
  if (!spec) throw new Error(`Unknown setting: ${key}`);
  const value = coerceSetting(spec, raw);
  if (key === 'eventOrganizerRole' && value !== 'off' && !/^\d{15,22}$/.test(String(value))) {
    throw new Error('Use a Discord role ID or enter off.');
  }
  const next = isObject(overrides) ? (structuredClone(overrides) as Json) : {};
  setPath(next, key, value);
  // Validate the min/max relationship for the affected game.
  const merged = resolveSettings(next);
  const [game] = key.split('.');
  if (game && (key.endsWith('.minBet') || key.endsWith('.maxBet'))) {
    const section = getPath(merged, game) as { minBet: number; maxBet: number } | undefined;
    const rawMin = getPath(next, `${game}.minBet`) ?? section?.minBet;
    const rawMax = getPath(next, `${game}.maxBet`) ?? section?.maxBet;
    if (typeof rawMin === 'number' && typeof rawMax === 'number' && rawMin > rawMax) {
      throw new Error('The minimum bet cannot be higher than the maximum bet.');
    }
  }
  return next;
}
