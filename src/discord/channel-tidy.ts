import type { Client } from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import type { Logger } from '../core/logger.js';
import type { OutboundGuard } from './outbound-guard.js';

/** Timings (adjustable in tests). Bot messages younger than minAgeMs are left alone. */
export const tidyTiming = { minAgeMs: 10 * 60_000, resolvedMs: 3 * 60_000, otherMs: 30_000 };
/** At most this many deletions per sweep, one at a time (deletes share a rate-limit bucket). */
const MAX_DELETIONS = 40;

/**
 * Keep the casino channel to what belongs there: the persistent lobby, and live coinflip
 * challenges. Anything else the bot itself posted there earlier (old panels from before tables
 * moved into threads, finished challenge cards, leftovers from interrupted runs) is removed.
 *
 * Only the bot's own messages, only in the configured lobby channel of each guild, never the lobby
 * message or a pending challenge, never anything recent, and every delete is registered with the
 * test-mode guard first (which otherwise refuses deletes).
 */
export async function tidyCasinoChannels(client: Client, app: CasinoApp, guard: OutboundGuard | null, logger: Logger): Promise<number> {
  const me = client.user?.id;
  if (!me) return 0;
  let removed = 0;
  for (const { guildId } of app.settings.guildsWithLobby()) {
    const lobby = app.settings.lobby(guildId);
    if (!lobby.channelId) continue;
    const channel = await client.channels.fetch(lobby.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased() || !('messages' in channel)) continue;
    if (channel.guildId !== guildId) continue;
    // Never the lobby, a live challenge, or the panel of any open table or wheel (with table threads
    // switched off, those panels live in this channel).
    const panels = app.db
      .all<{ message_id: string }>("SELECT message_id FROM game_tables WHERE guild_id = ? AND status = 'open' AND message_id IS NOT NULL", [guildId])
      .map((row) => row.message_id);
    const keep = new Set<string>([lobby.messageId ?? '', ...app.coinflip.pendingMessageIds(guildId), ...panels]);
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!recent) continue;
    const cutoff = Date.now() - tidyTiming.minAgeMs;
    const stale = [...recent.values()].filter((m) => m.author.id === me && !keep.has(m.id) && m.createdTimestamp < cutoff && !m.pinned);
    for (const message of stale.slice(0, MAX_DELETIONS - removed)) {
      guard?.allowDelete(message.id);
      const ok = await message.delete().then(() => true, () => false);
      if (ok) removed++;
    }
    if (removed >= MAX_DELETIONS) break;
  }
  if (removed) logger.info('tidied the casino channel', { removed });
  return removed;
}

/** How long a finished challenge card stays visible before it is removed from the channel. */
export function challengeLingerMs(status: string): number | null {
  if (status === 'pending') return null;
  return status === 'resolved' ? tidyTiming.resolvedMs : tidyTiming.otherMs;
}
