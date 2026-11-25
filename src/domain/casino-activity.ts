import type { CasinoApp } from '../app/casino-app.js';
import { escapeMarkdown } from '../core/format.js';

/** Older highlights ended with an internal round id and "net at <game>"; players never need either. */
function tidy(text: string): string {
  return text
    .replace(/ · round [0-9a-f]{6,}$/, '')
    .replace(/\+([\d,]+) net at (\w)/, (_, amount: string, first: string) => `won **${amount}** at ${first.toUpperCase()}`);
}

export function recentCasinoActivity(app: CasinoApp, guildId: string, limit: number): string[] {
  if (!app.settings.get(guildId).highlights.enabled) return [];
  return app.db
    .all<{ display_name: string; text: string }>(
      `SELECT p.display_name, h.text
       FROM highlights h JOIN players p USING (guild_id, user_id)
       WHERE h.guild_id = ? AND p.highlights_opt_out = 0
       ORDER BY h.id DESC LIMIT ?`,
      [guildId, limit],
    )
    .map((entry) => `**${escapeMarkdown(entry.display_name || 'A player')}** · ${tidy(entry.text)}`);
}
