import type { CasinoApp } from '../../app/casino-app.js';
import { chips, escapeMarkdown } from '../../core/format.js';
import { currentTurnUserId } from '../../games/blackjack/engine.js';
import { cid } from '../custom-id.js';
import { button, linkButton, row, text } from '../kit.js';
import { ICONS } from '../theme.js';
import { NAV, channelUrl, type Viewer } from './common.js';

/** The one table (Blackjack or Hold'em) a player is seated at, described for any screen. */
export interface MyTable {
  game: 'blackjack' | 'poker';
  gameLabel: string;
  icon: string;
  id: string;
  name: string;
  url: string | null;
  isPrivate: boolean;
  /** What the table is doing: "Hand 4 in play", "Taking bets"… */
  table: string;
  /** Where the player stands: "Your turn", "25 bet placed", "Stack 480"… */
  seat: string;
  /** Something is waiting on the player right now. */
  urgent: boolean;
  /** Leaving now would not forfeit anything that is still in play. */
  canLeaveNow: boolean;
}

function location(guildId: string, threadId: string | null, channelId: string | null, messageId: string | null): string | null {
  if (threadId) return channelUrl(guildId, threadId);
  if (channelId && messageId) return channelUrl(guildId, channelId, messageId);
  return null;
}

export function myTable(app: CasinoApp, viewer: Pick<Viewer, 'guildId' | 'userId'>): MyTable | null {
  const bj = app.blackjack.tableOfUser(viewer.guildId, viewer.userId);
  if (bj) {
    const { record, state } = bj;
    const seat = state.seats.find((s) => s.userId === viewer.userId);
    const round = state.round;
    const inHand = !!round?.seats.some((s) => s.userId === viewer.userId);
    const myTurn = state.phase === 'playing' && !!round && currentTurnUserId(round) === viewer.userId;
    const insurance = state.phase === 'insurance' && !!round?.seats.some((s) => s.userId === viewer.userId && s.insurance.decision === 'pending');
    const bet = state.bets[viewer.userId];
    const table =
      state.phase === 'playing' ? `Hand ${state.roundNumber} in play`
        : state.phase === 'insurance' ? 'Insurance decisions'
          : Object.keys(state.bets).length > 0 ? 'Taking bets' : 'Waiting for bets';
    const seatText = myTurn ? 'Your turn' : insurance ? 'Insurance — your call' : inHand ? 'In this hand'
      : bet ? `${chips(bet)} bet placed` : seat?.sittingOut ? 'Sitting out' : 'No bet yet';
    return {
      game: 'blackjack', gameLabel: 'Blackjack', icon: ICONS.blackjack, id: record.id, name: record.name,
      url: location(record.guildId, record.threadId, record.channelId, record.messageId), isPrivate: record.isPrivate,
      table, seat: seatText, urgent: myTurn || insurance, canLeaveNow: !inHand,
    };
  }
  const pk = app.poker.tableOfUser(viewer.guildId, viewer.userId);
  if (pk) {
    const { record, state } = pk;
    const seat = state.seats.find((s) => s.userId === viewer.userId)!;
    const hand = state.hand;
    const handSeat = hand?.seats.find((s) => s.userId === viewer.userId);
    const myTurn = !!hand && !!handSeat && hand.actor === handSeat.seat && !hand.result;
    const inHand = !!handSeat && !handSeat.folded && !hand?.result;
    const extras = [seat.sittingOut ? 'sitting out' : null, seat.leaving ? 'leaving after this hand' : null].filter(Boolean).join(' · ');
    return {
      game: 'poker', gameLabel: 'Hold’em', icon: ICONS.poker, id: record.id, name: record.name,
      url: location(record.guildId, record.threadId, record.channelId, record.messageId), isPrivate: record.isPrivate,
      table: hand && !hand.result ? `Hand ${state.number} · ${hand.street === 'preflop' ? 'pre-flop' : hand.street}` : 'Between hands',
      seat: `${myTurn ? 'Your turn · ' : ''}Stack ${chips(seat.stack)}${extras ? ` · ${extras}` : ''}`,
      urgent: myTurn, canLeaveNow: !inHand,
    };
  }
  return null;
}

/** "♠ Table 01 · Blackjack — Hand 4 in play · Your turn" */
export function myTableLine(table: MyTable): string {
  return `${table.icon} **${escapeMarkdown(table.name)}** · ${table.gameLabel}${table.isPrivate ? ' 🔒' : ''}\n-# ${table.table} · ${table.urgent ? `**${table.seat}**` : table.seat}`;
}

/** A link straight into the table's thread (Discord moves the client on click). */
export function returnToTableButton(table: MyTable) {
  return table.url
    ? linkButton(`Return to ${table.name}`.slice(0, 80), table.url, table.icon)
    : button({ id: NAV.myTable, label: 'My table', emoji: ICONS.tables });
}

/**
 * Shown when a player asks for a table in one game while seated in another: explains why, and
 * offers the way back, leaving (only when nothing is in play), or the Games floor.
 */
export function seatConflict(table: MyTable, wanted: string) {
  const leave = table.game === 'blackjack' ? cid('bj', 'leave', table.id) : cid('pk', 'leave', table.id);
  const why = table.game === 'poker'
    ? 'Leaving cashes out your stack after any hand you are in.'
    : 'Leaving returns any bet that has not been dealt yet.';
  return [
    text(`### You already have a seat\nYou're at **${escapeMarkdown(table.name)}** (${table.gameLabel}). A player can hold one Blackjack or Hold’em seat at a time, so leave that table before opening ${wanted}.\n-# ${why}`),
    row(
      returnToTableButton(table),
      table.canLeaveNow ? button({ id: leave, label: `Leave ${table.name}`.slice(0, 80), emoji: ICONS.leave, tone: 'danger' }) : null,
      button({ id: NAV.floor, label: 'Games', emoji: ICONS.games }),
    ),
  ];
}
