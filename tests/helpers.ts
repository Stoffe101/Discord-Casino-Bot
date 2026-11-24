import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_SETTINGS, resolveSettings, type GuildSettings } from '../src/config/settings.js';
import { EconomyService } from '../src/domain/economy/economy-service.js';

export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';

export function userId(n: number): string {
  return `2000000000000000${String(n).padStart(2, '0')}`;
}

export interface TestEnv {
  db: Database;
  clock: ManualClock;
  settings: Map<string, GuildSettings>;
  economy: EconomyService;
  setSettings(guildId: string, patch: (s: GuildSettings) => void): void;
}

export function createTestEnv(): TestEnv {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const settings = new Map<string, GuildSettings>();
  const provider = (guildId: string): GuildSettings => {
    let s = settings.get(guildId);
    if (!s) {
      // Stable amounts for unit tests that assert exact legacy payouts and accrual.
      s = resolveSettings({ economy: { startingBalance: 1000, passivePerHour: 50, dailyReward: 250, dailyStreakBonus: 25 } });
      settings.set(guildId, s);
    }
    return s;
  };
  const economy = new EconomyService(db, provider, clock);
  return {
    db,
    clock,
    settings,
    economy,
    setSettings(guildId, patch) {
      const s = structuredClone(provider(guildId));
      patch(s);
      settings.set(guildId, s);
    },
  };
}

export { DEFAULT_SETTINGS };
