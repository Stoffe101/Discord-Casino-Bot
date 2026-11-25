/**
 * Casino events open their own table. The maintenance sweep (and startup) opens it 15 minutes
 * before the start once enough players registered; the organizer can open it earlier; registered
 * players take a seat with one click. A private event's table lives in a private thread and its
 * access code is never shown: registration is the access, checked here before the seat is taken
 * with the code on the player's behalf.
 *
 * Tables are created through the game services and shown through the bot's normal panel path, so
 * they behave like every other table (idle rules, closing, restart recovery). The event records
 * the table before Discord shows it, so a restart never opens a second one.
 *
 * One table per event. Multi-table events would extend EventTableConfig to a list and loop over
 * openWithHost here; nothing else assumes a single table beyond casino_events.table_id.
 */
import type { CasinoApp } from '../app/casino-app.js';
import { UserError, isUserError } from '../core/errors.js';
import { discordTime, plural } from '../core/format.js';
import { EVENT_TABLE_LEAD_MS, type CasinoEvent, type CasinoEvents, type EventActor, type EventTable } from '../domain/casino-events.js';
import { sanitizeTableName } from '../tables/blackjack-table-service.js';
import type { CasinoBot } from './bot.js';

/** What the keeper needs from the bot. */
export type EventTableHost = Pick<CasinoBot, 'createTablePanel' | 'addToTableThread' | 'client' | 'logger'>;

interface Host {
  userId: string;
  name: string;
  /** Hold'em only: the stack the host brings. */
  buyIn?: number;
  /** False: the host's seat is released once the table is shown, so it never takes a registered player's place. */
  keepSeat: boolean;
}

export interface SeatResult {
  tableId: string;
  tableName: string;
  url: string | null;
  /** This player opened the table (they host it). */
  opened: boolean;
}

const ACTIVE_STATES = new Set(['scheduled', 'ready', 'awaiting', 'in_progress']);

/** One open (or seat-opening) attempt per event at a time, shared by sweeps and clicks. */
const locks = new WeakMap<CasinoEvents, Map<string, Promise<unknown>>>();

function exclusive<T>(app: CasinoApp, eventId: string, work: () => Promise<T>): Promise<T> {
  let queue = locks.get(app.events);
  if (!queue) locks.set(app.events, (queue = new Map()));
  const next = (queue.get(eventId) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  queue.set(eventId, tail);
  void tail.then(() => {
    if (queue.get(eventId) === tail) queue.delete(eventId);
  });
  return next;
}

export function eventTableUrl(event: Pick<CasinoEvent, 'guild_id'>, table: Pick<EventTable, 'thread_id' | 'channel_id' | 'message_id'>): string | null {
  if (table.thread_id) return `https://discord.com/channels/${event.guild_id}/${table.thread_id}`;
  return table.channel_id && table.message_id ? `https://discord.com/channels/${event.guild_id}/${table.channel_id}/${table.message_id}` : null;
}

function seatedElsewhere(app: CasinoApp, guildId: string, userId: string): boolean {
  return !!(app.blackjack.tableOfUser(guildId, userId) ?? app.poker.tableOfUser(guildId, userId));
}

async function isMember(bot: EventTableHost, guildId: string, userId: string): Promise<boolean> {
  const guild = bot.client.guilds.cache.get(guildId);
  if (!guild) return false;
  return !!(await guild.members.fetch({ user: userId, force: true }).catch(() => null));
}

function nameOf(app: CasinoApp, event: CasinoEvent, userId: string): string {
  return app.events.registrations(event).find((person) => person.user_id === userId)?.name
    || app.economy.getPlayer(event.guild_id, userId)?.display_name || 'Player';
}

/** Closes a table with refunds (an active hand or round is voided). Missing tables are ignored. */
export async function closeEventTable(app: CasinoApp, tableId: string, reason: string): Promise<void> {
  if (app.blackjack.peek(tableId)) await app.blackjack.closeTable(tableId, reason, { force: true });
  else if (app.poker.peek(tableId)) await app.poker.close(tableId, reason);
}

/**
 * Who opens the table automatically. Blackjack: the organizer (their seat is released again when
 * they are not registered and the table has no spare seat), else the first free registered
 * player (seat released too, so nobody is held at a table they did not choose). Hold'em never
 * opens on its own: a seat holds a buy-in, and chips only leave a wallet when the player asks to
 * sit (registering is not that), so the first registered player to take a seat opens it, the
 * organizer included ("Open table now" asks for their buy-in).
 * Returns the reason when nobody can open it now.
 */
async function automaticHost(app: CasinoApp, bot: EventTableHost, event: CasinoEvent): Promise<Host | string> {
  if (app.events.tableConfig(event).game === 'poker') {
    return 'Hold’em seats take a buy-in from each player’s own wallet, so the table opens when the first registered player takes a seat.';
  }
  const { guild_id: guildId, organizer_id: organizerId } = event;
  const here = await isMember(bot, guildId, organizerId);
  const free = here && !seatedElsewhere(app, guildId, organizerId);
  if (free) return { userId: organizerId, name: nameOf(app, event, organizerId), keepSeat: app.events.organizerKeepsSeat(event) };
  for (const person of app.events.registrations(event)) {
    if (person.user_id === organizerId || seatedElsewhere(app, guildId, person.user_id)) continue;
    if (await isMember(bot, guildId, person.user_id)) return { userId: person.user_id, name: person.name, keepSeat: false };
  }
  return here
    ? 'The organizer and every registered player are seated at other tables. The table opens when one of them is free.'
    : 'Nobody who can host is free yet. The table opens when a registered player is free.';
}

/** Create the table through the game service, link it to the event, then show it in Discord. */
async function openWithHost(app: CasinoApp, bot: EventTableHost, event: CasinoEvent, host: Host): Promise<{ tableId: string; url: string | null }> {
  const config = app.events.tableConfig(event);
  const name = sanitizeTableName(event.title);
  const isPrivate = !!event.access_code;
  let tableId: string;
  if (config.game === 'blackjack') {
    const player = app.economy.getPlayer(event.guild_id, host.userId);
    const table = await app.blackjack.createTable({
      guildId: event.guild_id, ownerId: host.userId, ownerName: host.name, isPrivate,
      maxSeats: config.seats, minBet: config.minBet, maxBet: config.maxBet,
      ...(name ? { name } : {}),
      ...(player ? { feltId: player.felt_id, cardBackId: player.card_back_id } : {}),
    });
    tableId = table.record.id;
  } else {
    // A Hold'em seat holds chips: only a buy-in the player chose themselves, never a default.
    if (host.buyIn === undefined) throw new UserError('Choose a buy-in for your seat.');
    const table = await app.poker.create({
      guildId: event.guild_id, userId: host.userId, name: host.name, private: isPrivate,
      seats: config.seats, buyIn: host.buyIn, ...(name ? { tableName: name } : {}),
    });
    tableId = table.record.id;
  }
  // Linked before any Discord call: a crash from here on resumes this table (its panel is
  // re-posted on startup) instead of opening another.
  app.events.linkOpenedTable(event.guild_id, event.id, tableId);
  let url: string | null;
  try {
    ({ url } = await bot.createTablePanel(tableId, null, host.userId));
    if (!url) throw new Error('The event table panel was not created');
  } catch (error) {
    const note = 'Discord refused the table’s thread or message. Check the bot’s permissions in the casino channel, then open the table again.';
    bot.logger.warn('event table could not be shown in Discord; closing it with refunds', { eventId: event.id, tableId, error });
    app.events.unlinkFailedTable(event.guild_id, event.id, tableId, note);
    await closeEventTable(app, tableId, 'could not be created');
    throw new UserError(note, 'panel_failed', 'Could not open the table');
  }
  if (!host.keepSeat && config.game === 'blackjack') await app.blackjack.leave(tableId, host.userId).catch(() => undefined);
  return { tableId, url };
}

/**
 * Open the event's table now with the automatic host (the sweep, startup, the organizer's "Open
 * table now"). Returns the open table, or why it did not open (also stored as the event's note).
 */
export function openEventTable(app: CasinoApp, bot: EventTableHost, guildId: string, eventId: string): Promise<{ tableId: string | null; note: string | null }> {
  return exclusive(app, eventId, async () => {
    const event = app.events.find(guildId, eventId);
    if (!event || !ACTIVE_STATES.has(event.state)) return { tableId: null, note: 'This event is over.' };
    const existing = app.events.table(event);
    if (existing) return { tableId: existing.id, note: null };
    const host = await automaticHost(app, bot, event);
    if (typeof host === 'string') {
      app.events.noteTable(guildId, eventId, host);
      return { tableId: null, note: host };
    }
    try {
      return { tableId: (await openWithHost(app, bot, event, host)).tableId, note: null };
    } catch (error) {
      if (!isUserError(error)) throw error;
      // Table limit, private threads unavailable, game closed…: say why. The sweep retries
      // unless Discord refused the panel (that table was already opened once).
      app.events.noteTable(guildId, eventId, error.message);
      return { tableId: null, note: error.message };
    }
  });
}

/**
 * The maintenance sweep (also run once at startup): settle events past their window (called off,
 * in progress or completed), close tables of cancelled events, and open the tables that are due.
 */
export async function openDueEventTables(app: CasinoApp, bot: EventTableHost): Promise<void> {
  app.events.settleOverdue(app.clock.now());
  for (const { tableId } of app.events.tablesToClose()) {
    await closeEventTable(app, tableId, 'the event was cancelled').catch((error: unknown) =>
      bot.logger.warn('could not close a cancelled event’s table', { tableId, error }));
  }
  for (const event of app.events.dueForTables(app.clock.now())) {
    await openEventTable(app, bot, event.guild_id, event.id).catch((error: unknown) =>
      bot.logger.error('event table could not open', { eventId: event.id, error }));
  }
}

/**
 * Throws unless this player may take a seat at the event's table now: registered (or the
 * organizer with a spare seat) and, when nothing is open yet, inside the table's window.
 */
export function assertMaySit(app: CasinoApp, actor: EventActor, event: CasinoEvent): void {
  if (!app.events.maySit(event, actor.userId)) {
    throw new UserError(event.organizer_id === actor.userId
      ? 'Register for your event to play at its table: every seat is kept for registered players.'
      : 'Register for this event to take a seat at its table.', 'not_registered', 'Registration needed');
  }
  if (!ACTIVE_STATES.has(event.state)) throw new UserError('This event is over.', 'event_over', 'Event over');
  const table = app.events.table(event);
  if (table && !table.message_id) throw new UserError('The table is still being set up. Try again in a moment.', 'table_setup', 'One moment');
  if (table || event.organizer_id === actor.userId) return;
  if (!app.events.openable(event, app.clock.now())) {
    const missing = event.min_players - event.registered;
    throw new UserError(missing > 0
      ? `The table opens once ${plural(missing, 'more player')} ${missing === 1 ? 'registers' : 'register'}.`
      : `The table opens ${discordTime(event.starts_at - EVENT_TABLE_LEAD_MS)}, 15 minutes before the start.`, 'not_yet', 'Not open yet');
  }
}

/**
 * Seat a registered player at the event's table, opening it with them as host when it isn't open
 * yet. Private tables: their code is passed on the player's behalf after the registration check,
 * and they are added to the private thread (the seat is released if Discord refuses). Runs under
 * the event's lock, so a seat is never taken while the table is still being opened.
 */
export async function seatAtEventTable(
  app: CasinoApp, bot: EventTableHost, actor: EventActor & { displayName: string }, eventId: string, buyIn?: number,
): Promise<SeatResult> {
  const event = app.events.view(actor, eventId);
  if (event.game === 'poker' && buyIn === undefined) throw new UserError('Choose a buy-in for your seat.');
  // Checked inside the lock: an open in flight finishes (panel shown) before anyone joins.
  return exclusive(app, event.id, async () => {
    const current = app.events.find(event.guild_id, event.id)!;
    assertMaySit(app, actor, current);
    const table = app.events.table(current);
    if (!table) {
      const opened = await openWithHost(app, bot, current, { userId: actor.userId, name: actor.displayName, buyIn, keepSeat: true });
      const name = app.events.table(app.events.find(event.guild_id, event.id)!)?.name ?? current.title;
      return { tableId: opened.tableId, tableName: name, url: opened.url, opened: true };
    }
    if (current.game === 'blackjack') {
      await app.blackjack.join(table.id, actor.userId, actor.displayName, table.access_code ?? undefined);
    } else {
      await app.poker.join(table.id, actor.userId, actor.displayName, buyIn!, table.access_code ?? undefined);
    }
    let url: string | null;
    try {
      url = await bot.addToTableThread(table.id, actor.userId);
    } catch (error) {
      bot.logger.warn('private event table thread unavailable for a new seat; seat released', { tableId: table.id, error });
      if (current.game === 'blackjack') await app.blackjack.leave(table.id, actor.userId).catch(() => undefined);
      else await app.poker.leave(table.id, actor.userId).catch(() => undefined);
      throw new UserError("Discord didn't let me add you to the table's private thread, so your seat was released. Try again in a moment.", 'thread_access', 'Could not join');
    }
    return { tableId: table.id, tableName: table.name, url: url ?? eventTableUrl(current, table), opened: false };
  });
}
