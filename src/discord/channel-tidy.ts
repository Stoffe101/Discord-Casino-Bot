import { MessageType, type Client } from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import type { Logger } from '../core/logger.js';
import type { OutboundGuard } from './outbound-guard.js';

/** Timings (adjustable in tests). Bot messages younger than minAgeMs are left alone. */
export const tidyTiming = { minAgeMs: 10 * 60_000, resolvedMs: 3 * 60_000, otherMs: 30_000 };
/** At most this many deletions per sweep, one at a time (deletes share a rate-limit bucket). */
const MAX_DELETIONS = 40;

/**
 * Keep the casino channel to what belongs there by removing the bot's own messages that this
 * casino's database shows are finished, and nothing else:
 *
 * - the panel of a closed table or wheel (posted in the channel when table threads are off),
 * - the bot's "started a thread" notice for a table's or wheel's thread (removed right after the
 *   thread is created; this catches notices left by an interrupted run),
 * - a coinflip challenge card whose challenge finished longer ago than its linger time.
 *
 * Everything else stays: the lobby, live challenges, open tables and wheels, and any message the
 * database cannot positively identify as finished (another runtime's messages under the same bot
 * account, anything new). Only the bot's own messages, only in each guild's configured lobby
 * channel, never anything younger than minAgeMs or pinned, and every delete is registered with the
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
    const finished = finishedMessages(app, guildId, Date.now());
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!recent) continue;
    const cutoff = Date.now() - tidyTiming.minAgeMs;
    const obsolete = [...recent.values()].filter((m) => {
      if (m.author.id !== me || m.pinned || m.createdTimestamp >= cutoff || m.id === lobby.messageId) return false;
      if (m.type === MessageType.ThreadCreated) {
        const threadId = m.reference?.channelId ?? m.thread?.id;
        return !!threadId && finished.tableThreads.has(threadId);
      }
      return finished.messages.has(m.id);
    });
    for (const message of obsolete.slice(0, MAX_DELETIONS - removed)) {
      guard?.allowDelete(message.id);
      const ok = await message.delete().then(() => true, () => false);
      if (ok) removed++;
    }
    if (removed >= MAX_DELETIONS) break;
  }
  if (removed) logger.info('tidied the casino channel', { removed });
  return removed;
}

/** What this guild's records show is over: closed panels, finished challenge cards, table threads. */
function finishedMessages(app: CasinoApp, guildId: string, now: number): { messages: Set<string>; tableThreads: Set<string> } {
  const closedPanels = app.db.all<{ message_id: string }>(
    "SELECT message_id FROM game_tables WHERE guild_id = ? AND status = 'closed' AND message_id IS NOT NULL", [guildId]);
  const cards = app.db.all<{ message_id: string; status: string; at: number }>(
    `SELECT message_id, status, COALESCE(resolved_at, expires_at) AS at FROM coinflip_challenges
     WHERE guild_id = ? AND status <> 'pending' AND message_id IS NOT NULL`, [guildId]);
  const threads = app.db.all<{ thread_id: string }>('SELECT thread_id FROM game_tables WHERE guild_id = ? AND thread_id IS NOT NULL', [guildId]);
  const doneCards = cards.filter((card) => now - card.at >= (challengeLingerMs(card.status) ?? Infinity));
  return {
    messages: new Set([...closedPanels.map((row) => row.message_id), ...doneCards.map((card) => card.message_id)]),
    tableThreads: new Set(threads.map((row) => row.thread_id)),
  };
}

/** How long a finished challenge card stays visible before it is removed from the channel. */
export function challengeLingerMs(status: string): number | null {
  if (status === 'pending') return null;
  return status === 'resolved' ? tidyTiming.resolvedMs : tidyTiming.otherMs;
}
