import type { Database } from '../../db/database.js';
import { DAY, HOUR } from '../../core/clock.js';

/**
 * Read-only "unusual transfers" review for server admins. It only points at patterns worth a
 * quiet look; friends legitimately share chips, so nothing here is treated as proof, and nothing
 * here changes a wallet. Every query is scoped to one guild and bounded by a LIMIT.
 */

/** How far back the review looks. */
export const REVIEW_WINDOW_MS = 7 * DAY;
/**
 * A new account's transfers count while it is this young. Hold'em and coinflip are open from the
 * first minute; gifts unlock at 24 hours, so 48 hours also covers the first day gifts are possible.
 */
export const NEW_ACCOUNT_MS = 48 * HOUR;
/** Listed when at least this share of the account's starting chips reached one player. */
export const NEW_ACCOUNT_MIN_SHARE = 0.5;
/** Listed when one sender gifted the same recipient at least this often in the window. */
export const REPEATED_GIFT_MIN = 3;
export const REVIEW_LIMIT = 10;

export type TransferChannel = 'poker' | 'coinflip' | 'gift';

export interface NewAccountTransfer {
  /** The new account. */
  userId: string;
  /** The single player who received the chips. */
  counterpartyId: string;
  /** Chips that reached the counterparty within NEW_ACCOUNT_MS of joining. */
  amount: number;
  /** The account's actual initial grant (the setting may have changed since). */
  startingGrant: number;
  via: TransferChannel[];
  joinedAt: number;
}

export interface RepeatedGiftPair {
  senderId: string;
  recipientId: string;
  count: number;
  total: number;
  lastAt: number;
}

export interface TransferReview {
  since: number;
  newAccounts: NewAccountTransfer[];
  giftPairs: RepeatedGiftPair[];
}

export function reviewTransfers(db: Database, guildId: string, now: number, limit = REVIEW_LIMIT): TransferReview {
  const since = now - REVIEW_WINDOW_MS;
  return { since, newAccounts: newAccountTransfers(db, guildId, since, limit), giftPairs: repeatedGiftPairs(db, guildId, since, limit) };
}

/**
 * Accounts that joined in the window and, within NEW_ACCOUNT_MS of joining, passed at least half
 * of their starting chips (net) to ONE other player.
 *
 * Hold'em and coinflip are player-against-player, so a loss there went to the hand's winners. Per
 * hand, a loser→winner pair is credited MIN(chips the loser lost, chips the winner won): exact
 * heads-up and never more than the loser actually lost in a multiway pot. Chips won back from the
 * same player, and gifts received from them, are subtracted, so ordinary back-and-forth play
 * nets out. House games (blackjack, roulette, slots) are never counted, not even a shared wheel.
 */
export function newAccountTransfers(db: Database, guildId: string, since: number, limit = REVIEW_LIMIT): NewAccountTransfer[] {
  const rows = db.all<{ from_id: string; to_id: string; amount: number; via: string | null; grant_amount: number; joined_at: number }>(
    `WITH fresh AS (
       SELECT p.user_id, p.created_at, g.amount AS grant_amount
       FROM players p
       JOIN ledger g ON g.guild_id = p.guild_id AND g.user_id = p.user_id AND g.type = 'initial_grant'
       WHERE p.guild_id = $guild AND p.created_at >= $since AND g.amount > 0
     ),
     flows AS (
       SELECT f.user_id AS from_id, o.user_id AS to_id, y.game AS via,
         CASE WHEN y.net < 0 THEN MIN(-y.net, o.net) ELSE -MIN(y.net, -o.net) END AS amount
       FROM fresh f
       JOIN round_results y ON y.guild_id = $guild AND y.user_id = f.user_id
       JOIN round_results o ON o.round_id = y.round_id AND o.guild_id = y.guild_id AND o.user_id <> y.user_id
       WHERE y.game IN ('poker', 'coinflip') AND ((y.net < 0 AND o.net > 0) OR (y.net > 0 AND o.net < 0))
         AND y.created_at >= f.created_at AND y.created_at < f.created_at + $young
       UNION ALL
       SELECT f.user_id, r.user_id, 'gift', -s.amount
       FROM fresh f
       JOIN ledger s ON s.guild_id = $guild AND s.user_id = f.user_id AND s.type = 'gift_sent'
       JOIN ledger r ON r.guild_id = s.guild_id AND r.reference = s.reference AND r.type = 'gift_received'
       WHERE s.created_at >= f.created_at AND s.created_at < f.created_at + $young
       UNION ALL
       SELECT f.user_id, s.user_id, 'gift', -r.amount
       FROM fresh f
       JOIN ledger r ON r.guild_id = $guild AND r.user_id = f.user_id AND r.type = 'gift_received'
       JOIN ledger s ON s.guild_id = r.guild_id AND s.reference = r.reference AND s.type = 'gift_sent'
       WHERE r.created_at >= f.created_at AND r.created_at < f.created_at + $young
     )
     SELECT flows.from_id, flows.to_id, SUM(flows.amount) AS amount,
       GROUP_CONCAT(DISTINCT CASE WHEN flows.amount > 0 THEN flows.via END) AS via,
       fresh.grant_amount, fresh.created_at AS joined_at
     FROM flows JOIN fresh ON fresh.user_id = flows.from_id
     GROUP BY flows.from_id, flows.to_id
     HAVING SUM(flows.amount) >= fresh.grant_amount * $share
     ORDER BY SUM(flows.amount) * 1.0 / fresh.grant_amount DESC, amount DESC, flows.from_id, flows.to_id
     LIMIT $limit`,
    { guild: guildId, since, young: NEW_ACCOUNT_MS, share: NEW_ACCOUNT_MIN_SHARE, limit: clampLimit(limit) },
  );
  const order: TransferChannel[] = ['poker', 'coinflip', 'gift'];
  return rows.map((row) => ({
    userId: row.from_id,
    counterpartyId: row.to_id,
    amount: row.amount,
    startingGrant: row.grant_amount,
    via: order.filter((channel) => (row.via ?? '').split(',').includes(channel)),
    joinedAt: row.joined_at,
  }));
}

/** Sender→recipient pairs with REPEATED_GIFT_MIN or more gifts in the window, largest totals first. */
export function repeatedGiftPairs(db: Database, guildId: string, since: number, limit = REVIEW_LIMIT): RepeatedGiftPair[] {
  return db.all<{ sender_id: string; recipient_id: string; count: number; total: number; last_at: number }>(
    `WITH received AS (
       SELECT reference, user_id FROM ledger
       WHERE guild_id = $guild AND type = 'gift_received' AND created_at >= $since AND reference IS NOT NULL
     )
     SELECT s.user_id AS sender_id, r.user_id AS recipient_id, COUNT(*) AS count, SUM(-s.amount) AS total, MAX(s.created_at) AS last_at
     FROM ledger s JOIN received r ON r.reference = s.reference
     WHERE s.guild_id = $guild AND s.type = 'gift_sent' AND s.created_at >= $since
     GROUP BY s.user_id, r.user_id
     HAVING COUNT(*) >= $min
     ORDER BY total DESC, count DESC, sender_id, recipient_id
     LIMIT $limit`,
    { guild: guildId, since, min: REPEATED_GIFT_MIN, limit: clampLimit(limit) },
  ).map((row) => ({ senderId: row.sender_id, recipientId: row.recipient_id, count: row.count, total: row.total, lastAt: row.last_at }));
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(25, Math.floor(limit)));
}
