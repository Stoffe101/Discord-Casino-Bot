import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { applySettingOverride, resolveSettings, type GuildSettings } from '../config/settings.js';

interface GuildRow {
  guild_id: string;
  settings_json: string;
  lobby_channel_id: string | null;
  lobby_message_id: string | null;
  updated_at: number;
}

/** Server configuration with an in-memory cache (single process). */
export class GuildSettingsService {
  private readonly cache = new Map<string, GuildSettings>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  get(guildId: string): GuildSettings {
    let settings = this.cache.get(guildId);
    if (!settings) {
      settings = resolveSettings(this.overrides(guildId));
      this.cache.set(guildId, settings);
    }
    return settings;
  }

  /** Bound provider for services that only need read access. */
  readonly provider = (guildId: string): GuildSettings => this.get(guildId);

  overrides(guildId: string): unknown {
    const row = this.row(guildId);
    if (!row) return {};
    try {
      return JSON.parse(row.settings_json) as unknown;
    } catch {
      return {};
    }
  }

  /** Validate and persist one setting. Throws an Error with a friendly message on bad input. */
  set(guildId: string, key: string, raw: unknown): GuildSettings {
    const next = applySettingOverride(this.overrides(guildId), key, raw);
    this.db.run(
      `INSERT INTO guild_settings (guild_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      [guildId, JSON.stringify(next), this.clock.now()],
    );
    this.cache.delete(guildId);
    return this.get(guildId);
  }

  resetAll(guildId: string): void {
    this.db.run('UPDATE guild_settings SET settings_json = ?, updated_at = ? WHERE guild_id = ?', ['{}', this.clock.now(), guildId]);
    this.cache.delete(guildId);
  }

  lobby(guildId: string): { channelId: string | null; messageId: string | null } {
    const row = this.row(guildId);
    return { channelId: row?.lobby_channel_id ?? null, messageId: row?.lobby_message_id ?? null };
  }

  setLobby(guildId: string, channelId: string | null, messageId: string | null): void {
    this.db.run(
      `INSERT INTO guild_settings (guild_id, lobby_channel_id, lobby_message_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET lobby_channel_id = excluded.lobby_channel_id,
         lobby_message_id = excluded.lobby_message_id, updated_at = excluded.updated_at`,
      [guildId, channelId, messageId, this.clock.now()],
    );
  }

  guildsWithLobby(): { guildId: string; channelId: string; messageId: string | null }[] {
    return this.db
      .all<GuildRow>('SELECT * FROM guild_settings WHERE lobby_channel_id IS NOT NULL')
      .map((r) => ({ guildId: r.guild_id, channelId: r.lobby_channel_id!, messageId: r.lobby_message_id }));
  }

  private row(guildId: string): GuildRow | undefined {
    return this.db.get<GuildRow>('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
  }
}
