import type { Database } from '../db/database.js';
import type { Clock } from '../core/clock.js';
import { StaleActionError, UserError } from '../core/errors.js';
import { chips } from '../core/format.js';
import { newId, shortCode } from '../core/random.js';
import type { Scheduler } from '../core/scheduler.js';
import type { SettingsProvider } from './economy/economy-service.js';

export type EventGame = 'blackjack' | 'poker';
type EventState = 'scheduled' | 'ready' | 'awaiting' | 'in_progress' | 'completed' | 'cancelled';

export interface EventActor {
  guildId: string;
  userId: string;
  isAdmin: boolean;
  canOrganizeEvents?: boolean;
}

export interface CasinoEvent {
  id: string;
  guild_id: string;
  organizer_id: string;
  title: string;
  description: string;
  game: EventGame;
  starts_at: number;
  min_players: number;
  max_players: number;
  access_code: string | null;
  state: EventState;
  registration_open: number;
  table_id: string | null;
  revision: number;
  registered: number;
  /** The organizer's table settings (NULL: server defaults). Read through tableConfig(). */
  table_config_json: string | null;
  /** The last table this event opened itself (never reopened automatically once set). */
  opened_table_id: string | null;
  /** Why the event's table could not open yet, for the organizer. */
  table_note: string | null;
}

/**
 * What the event's table is opened with. Hold'em blinds and the buy-in range come from the
 * server settings (PokerTableService.create has no per-table limits); `buyIn` is what the
 * organizer brings to the table when it opens with them as host.
 * Extension point for multi-table events: a list of these, one per table.
 */
export type EventTableConfig =
  | { game: 'blackjack'; seats: number; minBet: number; maxBet: number }
  | { game: 'poker'; seats: number; buyIn: number };

type EventInput = {
  title: string; description: string; game: EventGame; startsAt: number;
  minPlayers: number; maxPlayers: number; private: boolean;
};

export interface EventTable {
  id: string;
  game: EventGame;
  name: string;
  owner_id: string;
  is_private: number;
  config_json: string;
  channel_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  access_code: string | null;
}

/** How long after its start an event's assigned table is kept open despite being idle. */
export const EVENT_TABLE_GRACE_MS = 30 * 60_000;
/** An event's own table opens this long before the start, once enough players registered. */
export const EVENT_TABLE_LEAD_MS = 15 * 60_000;

const ACTIVE = "e.state IN ('scheduled','ready','awaiting','in_progress')";

const SELECT = `SELECT e.*, (SELECT COUNT(*) FROM casino_event_players p WHERE p.event_id = e.id) AS registered FROM casino_events e`;

/** Require an explicit UTC offset and reject normalized dates such as February 30. */
export function parseEventTime(input: string): number | null {
  const parts = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d) *(Z|[+-]\d\d:\d\d)$/.exec(input.trim());
  if (!parts) return null;
  const [, day, minute, zone] = parts;
  const local = day + 'T' + minute + ':00.000Z';
  const utc = Date.parse(local);
  if (!Number.isFinite(utc) || new Date(utc).toISOString() !== local) return null;
  if (zone !== 'Z' && (!zone || Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59
    || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) > 0))) return null;
  const start = Date.parse(day + 'T' + minute + ':00' + zone);
  return Number.isFinite(start) ? start : null;
}

export class CasinoEvents {
  private changed: (guildId: string) => void = () => undefined;

  constructor(private readonly deps: { db: Database; clock: Clock; scheduler: Scheduler; settings: SettingsProvider }) {}

  onChanged(observer: (guildId: string) => void): void { this.changed = observer; }

  upcoming(guildId: string, userId?: string): CasinoEvent[] {
    return this.deps.db.all<CasinoEvent>(SELECT + `
      WHERE e.guild_id = ? AND e.state NOT IN ('completed','cancelled')
        AND (e.access_code IS NULL OR e.organizer_id = ? OR EXISTS (SELECT 1 FROM casino_event_players p WHERE p.event_id = e.id AND p.user_id = ?))
      ORDER BY e.starts_at, e.id`, [guildId, userId ?? null, userId ?? null]);
  }

  view(actor: EventActor, id: string): CasinoEvent {
    const event = this.get(actor.guildId, id);
    if (event.access_code && !this.canManage(actor, event) && !this.registered(event.id, actor.userId)) {
      throw new UserError('Use your invitation code to open this event.');
    }
    return event;
  }

  canManage(actor: EventActor, event?: CasinoEvent): boolean {
    return actor.isAdmin || !!actor.canOrganizeEvents && (!event || event.organizer_id === actor.userId);
  }

  registered(eventId: string, userId: string): boolean {
    return !!this.deps.db.get('SELECT 1 FROM casino_event_players WHERE event_id = ? AND user_id = ?', [eventId, userId]);
  }

  registrations(event: CasinoEvent): Array<{ user_id: string; name: string }> {
    return this.deps.db.all('SELECT user_id, name FROM casino_event_players WHERE event_id = ? ORDER BY joined_at, user_id', [event.id]);
  }

  create(actor: EventActor, input: EventInput): CasinoEvent {
    if (!this.canManage(actor)) throw new UserError('Only organizers can create casino events.');
    this.validate(actor.guildId, input);
    const id = newId();
    const code = input.private ? this.uniqueCode(actor.guildId) : null;
    const { db, clock } = this.deps;
    const config = this.defaultTableConfig(actor.guildId, input.game);
    db.run(`INSERT INTO casino_events (id,guild_id,organizer_id,title,description,game,starts_at,min_players,max_players,access_code,state,registration_open,revision,created_at,table_config_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,'scheduled',1,0,?,?)`, [id, actor.guildId, actor.userId, input.title, input.description, input.game, input.startsAt,
      input.minPlayers, input.maxPlayers, code, clock.now(), JSON.stringify(config)]);
    return this.updateSchedule(this.get(actor.guildId, id));
  }

  edit(actor: EventActor, id: string, revision: number, input: EventInput): CasinoEvent {
    this.validate(actor.guildId, input);
    const event = this.manage(actor, id, revision);
    if (!this.isUpcoming(event) || event.table_id) throw new UserError('An event can be edited until its table opens (an assigned table can be detached first).');
    if (event.registered > input.maxPlayers) throw new UserError('Keep enough places for your existing registrations.');
    const code = input.private ? event.access_code ?? this.uniqueCode(actor.guildId) : null;
    // Same game: keep the table settings, with room for the new maximum. New game: its defaults.
    const kept = input.game === event.game ? this.tableConfig(event) : this.defaultTableConfig(actor.guildId, input.game);
    const seatsCap = this.seatLimit(actor.guildId, input.game);
    const config = { ...kept, seats: Math.min(seatsCap, Math.max(kept.seats, input.maxPlayers)) };
    // A rescheduled event opens a fresh table at its new time.
    this.deps.db.run(`UPDATE casino_events SET title=?,description=?,game=?,starts_at=?,min_players=?,max_players=?,access_code=?,state='scheduled',
        table_config_json=?,opened_table_id=NULL,table_note=NULL,revision=revision+1 WHERE id=?`,
      [input.title, input.description, input.game, input.startsAt, input.minPlayers, input.maxPlayers, code, JSON.stringify(config), id]);
    return this.updateSchedule(this.get(actor.guildId, id));
  }

  joinWithCode(actor: EventActor, code: string, name: string): CasinoEvent {
    const event = this.deps.db.get<CasinoEvent>(SELECT + " WHERE e.guild_id = ? AND e.access_code = ? AND e.state IN ('scheduled','ready','awaiting')",
      [actor.guildId, code.trim().toUpperCase()]);
    if (!event) throw new UserError('That invitation code does not match an upcoming casino event.');
    return this.join(actor, event.id, name, event.access_code!);
  }

  join(actor: EventActor, id: string, name: string, code?: string): CasinoEvent {
    const event = this.deps.db.transaction(() => {
      const current = this.get(actor.guildId, id);
      if (this.registered(id, actor.userId)) return current;
      if (current.access_code && current.access_code !== code && !this.canManage(actor, current)) throw new UserError('Use your invitation code to join.');
      const settings = this.deps.settings(actor.guildId);
      if (!settings.enabled || !settings[current.game].enabled) throw new UserError('This game is closed for new registrations.');
      if (!this.isUpcoming(current) || !current.registration_open) throw new UserError('Registration is closed.');
      if (current.registered >= current.max_players) throw new UserError('This event is full.');
      this.deps.db.run('INSERT INTO casino_event_players (event_id,user_id,name,joined_at) VALUES (?,?,?,?)',
        [id, actor.userId, name, this.deps.clock.now()]);
      return this.recheck(id, actor.guildId);
    });
    this.changed(actor.guildId);
    return event;
  }

  leave(actor: EventActor, id: string): CasinoEvent {
    const event = this.deps.db.transaction(() => {
      const current = this.view(actor, id);
      if (!this.isUpcoming(current)) throw new UserError('Registration is finished for this event.');
      this.deps.db.run('DELETE FROM casino_event_players WHERE event_id = ? AND user_id = ?', [id, actor.userId]);
      return this.recheck(id, actor.guildId);
    });
    this.changed(actor.guildId);
    return event;
  }

  table(event: CasinoEvent): EventTable | undefined {
    return this.deps.db.get<EventTable>("SELECT * FROM game_tables WHERE guild_id = ? AND id = ? AND status = 'open'", [event.guild_id, event.table_id]);
  }

  assignableTables(actor: EventActor, event: CasinoEvent): EventTable[] {
    return this.matchingTables(actor, event).filter((table) => this.seatsForRegistrants(event, table) >= event.max_players);
  }

  /** Open tables the actor hosts with the event's game and visibility (capacity not checked). */
  private matchingTables(actor: EventActor, event: CasinoEvent): EventTable[] {
    if (!this.canManage(actor, event)) return [];
    return this.deps.db.all<EventTable>("SELECT * FROM game_tables WHERE guild_id = ? AND game = ? AND owner_id = ? AND is_private = ? AND status = 'open' AND message_id IS NOT NULL",
      [actor.guildId, event.game, actor.userId, !!event.access_code]);
  }

  /**
   * Seats left for registrants: the table's seats minus those held by people who are not
   * registered for this event — notably the host who opened it, unless they registered too.
   */
  private seatsForRegistrants(event: CasinoEvent, table: EventTable): number {
    let maxSeats: number;
    try {
      maxSeats = (JSON.parse(table.config_json) as { maxSeats: number }).maxSeats;
    } catch {
      return 0;
    }
    const others = this.deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM table_seats s WHERE s.table_id = ?
      AND NOT EXISTS (SELECT 1 FROM casino_event_players p WHERE p.event_id = ? AND p.user_id = s.user_id)`, [table.id, event.id])?.n ?? 0;
    return maxSeats - others;
  }

  /** True while an event that uses this table is due — bounded: until 30 minutes after it starts. */
  holdsTable(guildId: string, tableId: string, now: number): boolean {
    return !!this.deps.db.get(`SELECT 1 FROM casino_events WHERE guild_id = ? AND table_id = ?
      AND state IN ('scheduled','ready','awaiting','in_progress') AND ? < starts_at + ?`, [guildId, tableId, now, EVENT_TABLE_GRACE_MS]);
  }

  assign(actor: EventActor, id: string, revision: number, tableId: string | null): CasinoEvent {
    const event = this.manage(actor, id, revision);
    if (!this.isUpcoming(event)) throw new UserError('Only upcoming events can change tables.');
    const table = tableId ? this.matchingTables(actor, event).find((candidate) => candidate.id === tableId) : undefined;
    if (tableId && !table) {
      throw new UserError('Choose one of your own open tables with matching game, visibility and enough seats.');
    }
    if (table) {
      const free = this.seatsForRegistrants(event, table);
      if (free < event.max_players) {
        throw new UserError(`That table leaves only ${free} of the ${event.max_players} seats this event needs: seats held by players who aren't registered count against it — including yours as the host. Register for the event yourself, or open a table with more seats.`);
      }
    }
    if (tableId && this.deps.db.get("SELECT id FROM casino_events WHERE table_id = ? AND id <> ? AND state NOT IN ('completed','cancelled')", [tableId, id])) {
      throw new UserError('That table belongs to another upcoming event.');
    }
    this.deps.db.run('UPDATE casino_events SET table_id = ?, revision = revision + 1 WHERE id = ?', [tableId, id]);
    this.changed(actor.guildId);
    return this.get(actor.guildId, id);
  }

  manageAction(actor: EventActor, id: string, revision: number, action: string): CasinoEvent {
    const event = this.manage(actor, id, revision);
    const upcoming = this.isUpcoming(event);
    let state = event.state;
    let registration = event.registration_open;
    if (action === 'start') {
      // Starting early is allowed once enough players registered and the table is open.
      const settings = this.deps.settings(actor.guildId);
      if (!upcoming || event.registered < event.min_players || !this.table(event)
        || !settings.enabled || !settings[event.game].enabled) {
        throw new UserError('Starting requires enough registered players and an open event table.');
      }
      state = 'in_progress';
      registration = 0;
    } else if (action === 'finish' && state === 'in_progress') {
      state = 'completed';
    } else if (action === 'cancel' && upcoming) {
      state = 'cancelled';
      registration = 0;
    } else if (action === 'registration' && upcoming) {
      registration = registration ? 0 : 1;
    } else {
      throw new StaleActionError('Refresh this event to see what you can do.');
    }
    this.deps.db.run('UPDATE casino_events SET state = ?, registration_open = ?, revision = revision + 1 WHERE id = ?', [state, registration, id]);
    return this.updateSchedule(this.get(actor.guildId, id));
  }

  tableClosed(guildId: string, tableId: string): void {
    const changes = this.deps.db.run(`UPDATE casino_events SET table_id = NULL, state = CASE WHEN state = 'in_progress' THEN 'completed' ELSE state END,
      revision = revision + 1 WHERE guild_id = ? AND table_id = ? AND state NOT IN ('completed','cancelled')`, [guildId, tableId]);
    if (changes.changes) this.changed(guildId);
  }

  recover(): number {
    const { db } = this.deps;
    const events = db.all<CasinoEvent>(SELECT + " WHERE e.state NOT IN ('cancelled','completed')");
    for (const event of events) {
      if (event.table_id && !this.table(event)) this.tableClosed(event.guild_id, event.table_id);
      this.updateSchedule(this.recheck(event.id, event.guild_id));
    }
    return events.length;
  }

  // ───────────────────────────── the event's own table ─────────────────────────────

  /** A fresh read without access checks (sweeps and the table keeper re-read inside their lock). */
  find(guildId: string, id: string): CasinoEvent | undefined {
    return this.deps.db.get<CasinoEvent>(SELECT + ' WHERE e.guild_id = ? AND e.id = ?', [guildId, id]);
  }

  defaultTableConfig(guildId: string, game: EventGame): EventTableConfig {
    const settings = this.deps.settings(guildId);
    const seats = this.seatLimit(guildId, game);
    return game === 'blackjack'
      ? { game, seats, minBet: settings.blackjack.minBet, maxBet: settings.blackjack.maxBet }
      : { game, seats, buyIn: settings.poker.minBuyIn };
  }

  /** The settings the event's table opens with, kept inside the server's current limits. */
  tableConfig(event: CasinoEvent): EventTableConfig {
    const fallback = this.defaultTableConfig(event.guild_id, event.game);
    let stored: Record<string, unknown> = {};
    try {
      const parsed: unknown = event.table_config_json ? JSON.parse(event.table_config_json) : {};
      if (parsed && typeof parsed === 'object' && (parsed as { game?: unknown }).game === event.game) stored = parsed as Record<string, unknown>;
    } catch {
      stored = {};
    }
    const int = (value: unknown, otherwise: number) => (Number.isSafeInteger(value) ? (value as number) : otherwise);
    const limit = this.seatLimit(event.guild_id, event.game);
    const seats = clamp(int(stored.seats, fallback.seats), Math.min(event.max_players, limit), limit);
    const settings = this.deps.settings(event.guild_id);
    if (event.game === 'blackjack') {
      const bj = settings.blackjack;
      const minBet = clamp(int(stored.minBet, bj.minBet), bj.minBet, bj.maxBet);
      return { game: 'blackjack', seats, minBet, maxBet: clamp(int(stored.maxBet, bj.maxBet), minBet, bj.maxBet) };
    }
    const pk = settings.poker;
    return { game: 'poker', seats, buyIn: clamp(int(stored.buyIn, pk.minBuyIn), pk.minBuyIn, pk.maxBuyIn) };
  }

  configureTable(actor: EventActor, id: string, revision: number, config: EventTableConfig): CasinoEvent {
    const event = this.manage(actor, id, revision);
    if (!this.isUpcoming(event)) throw new UserError('Table settings can only change before the event starts.');
    if (this.table(event)) throw new UserError('The table is already open, so its settings are fixed.');
    if (config.game !== event.game) throw new StaleActionError('Refresh the event before changing its table.');
    const settings = this.deps.settings(actor.guildId);
    const limit = this.seatLimit(actor.guildId, event.game);
    if (!Number.isInteger(config.seats) || config.seats < event.max_players || config.seats > limit) {
      throw new UserError(`Choose ${event.max_players >= limit ? limit : `${event.max_players}–${limit}`} seats: every registered player needs one.`);
    }
    let clean: EventTableConfig;
    if (config.game === 'blackjack') {
      const bj = settings.blackjack;
      if (!Number.isSafeInteger(config.minBet) || !Number.isSafeInteger(config.maxBet) || config.minBet > config.maxBet) {
        throw new UserError('The minimum bet must not be higher than the maximum.');
      }
      if (config.minBet < bj.minBet || config.maxBet > bj.maxBet) throw new UserError(`Bet limits must stay within the server range ${chips(bj.minBet)}–${chips(bj.maxBet)}.`);
      clean = { game: 'blackjack', seats: config.seats, minBet: config.minBet, maxBet: config.maxBet };
    } else {
      const pk = settings.poker;
      if (!Number.isSafeInteger(config.buyIn) || config.buyIn < pk.minBuyIn || config.buyIn > pk.maxBuyIn) {
        throw new UserError(`Choose a buy-in from ${chips(pk.minBuyIn)} to ${chips(pk.maxBuyIn)} chips.`);
      }
      clean = { game: 'poker', seats: config.seats, buyIn: config.buyIn };
    }
    this.deps.db.run('UPDATE casino_events SET table_config_json = ?, revision = revision + 1 WHERE id = ?', [JSON.stringify(clean), id]);
    this.changed(actor.guildId);
    return this.get(actor.guildId, id);
  }

  /**
   * The organizer keeps the host seat when registered, or when the table has a seat beyond the
   * player limit; otherwise their seat would take a registered player's place.
   */
  organizerKeepsSeat(event: CasinoEvent): boolean {
    return this.registered(event.id, event.organizer_id) || this.tableConfig(event).seats > event.max_players;
  }

  /** Who may sit at the event's table through the event: registered players, and the organizer when a seat is spare. */
  maySit(event: CasinoEvent, userId: string): boolean {
    return this.registered(event.id, userId) || (userId === event.organizer_id && this.organizerKeepsSeat(event));
  }

  /** Whether a player asking to sit may open the table now: inside its window, with enough players. */
  openable(event: CasinoEvent, now: number): boolean {
    if (this.table(event) || now >= event.starts_at + EVENT_TABLE_GRACE_MS) return false;
    return event.state === 'in_progress'
      || (this.isUpcoming(event) && now >= event.starts_at - EVENT_TABLE_LEAD_MS && event.registered >= event.min_players);
  }

  /** Events whose table the maintenance sweep opens now: due, nothing assigned, never opened by the event. */
  dueForTables(now: number): CasinoEvent[] {
    return this.deps.db.all<CasinoEvent>(SELECT + ` WHERE ${ACTIVE} AND e.table_id IS NULL AND e.opened_table_id IS NULL
      AND ? < e.starts_at + ? AND (e.state = 'in_progress' OR (e.starts_at - ? <= ?
        AND (SELECT COUNT(*) FROM casino_event_players p WHERE p.event_id = e.id) >= e.min_players))
      ORDER BY e.starts_at, e.id`, [now, EVENT_TABLE_GRACE_MS, EVENT_TABLE_LEAD_MS, now]);
  }

  /** Link the table the event just opened, before Discord shows it: a restart never opens a second one. */
  linkOpenedTable(guildId: string, id: string, tableId: string): void {
    this.deps.db.run('UPDATE casino_events SET table_id = ?, opened_table_id = ?, table_note = NULL, revision = revision + 1 WHERE guild_id = ? AND id = ?',
      [tableId, tableId, guildId, id]);
    this.changed(guildId);
  }

  /** Discord could not show the new table: detach it before it closes (with refunds), so the event stays as it was. */
  unlinkFailedTable(guildId: string, id: string, tableId: string, note: string): void {
    this.deps.db.run('UPDATE casino_events SET table_id = NULL, table_note = ?, revision = revision + 1 WHERE guild_id = ? AND id = ? AND table_id = ?',
      [note, guildId, id, tableId]);
    this.changed(guildId);
  }

  /** Why the table has not opened yet (null clears it). Informational: no revision change. */
  noteTable(guildId: string, id: string, note: string | null): void {
    const result = this.deps.db.run('UPDATE casino_events SET table_note = ? WHERE guild_id = ? AND id = ? AND table_note IS NOT ?', [note, guildId, id, note]);
    if (result.changes) this.changed(guildId);
  }

  /**
   * Settles events still upcoming 30 minutes after their start, so none lingers in the lists:
   * short of players: called off (the caller closes any table they opened, with refunds);
   * table open: in progress (completed when the table closes); table played and closed: completed;
   * table never opened: called off.
   */
  settleOverdue(now: number): void {
    const events = this.deps.db.all<CasinoEvent>(SELECT + " WHERE e.state IN ('scheduled','ready','awaiting') AND e.starts_at + ? <= ?",
      [EVENT_TABLE_GRACE_MS, now]);
    for (const event of events) {
      const [state, note] = event.registered < event.min_players ? ['cancelled', 'Called off: not enough players registered by the start.']
        : this.table(event) ? ['in_progress', null]
          : event.opened_table_id ? ['completed', null]
            : ['cancelled', 'Called off: the table never opened.'];
      this.deps.db.run('UPDATE casino_events SET state = ?, registration_open = 0, table_note = COALESCE(?, table_note), revision = revision + 1 WHERE id = ?',
        [state, note, event.id]);
      this.updateSchedule(this.get(event.guild_id, event.id));
    }
  }

  /** Open tables that cancelled events opened themselves (also after a restart between cancel and close). */
  tablesToClose(): Array<{ guildId: string; tableId: string }> {
    return this.deps.db.all(`SELECT e.guild_id AS guildId, e.opened_table_id AS tableId FROM casino_events e
      JOIN game_tables t ON t.id = e.opened_table_id AND t.status = 'open' WHERE e.state = 'cancelled'`);
  }

  private seatLimit(guildId: string, game: EventGame): number {
    const settings = this.deps.settings(guildId);
    return game === 'poker' ? settings.poker.maxSeats : settings.blackjack.maxSeats;
  }

  private uniqueCode(guildId: string): string {
    let code = shortCode();
    while (this.deps.db.get('SELECT 1 FROM casino_events WHERE guild_id = ? AND access_code = ?', [guildId, code])) code = shortCode();
    return code;
  }

  private validate(guildId: string, input: EventInput): void {
    const settings = this.deps.settings(guildId);
    if (!settings.enabled || !settings[input.game].enabled) throw new UserError('Choose an enabled game.');
    const seats = input.game === 'poker' ? settings.poker.maxSeats : settings.blackjack.maxSeats;
    if (!input.title.trim() || input.title.length > 60 || input.description.length > 450) throw new UserError('Use a title of 1–60 characters and a description of up to 450.');
    if (!Number.isSafeInteger(input.startsAt) || input.startsAt <= this.deps.clock.now()) throw new UserError('Choose a future start time with an explicit offset.');
    if (!Number.isInteger(input.minPlayers) || !Number.isInteger(input.maxPlayers) || input.minPlayers < 2
      || input.maxPlayers > seats || input.maxPlayers < input.minPlayers) throw new UserError('The player range must fit one table for this game.');
  }

  private get(guildId: string, id: string): CasinoEvent {
    const event = this.deps.db.get<CasinoEvent>(SELECT + ' WHERE e.guild_id = ? AND e.id = ?', [guildId, id]);
    if (!event) throw new UserError('That event is unavailable in this server.');
    return event;
  }

  private manage(actor: EventActor, id: string, revision: number): CasinoEvent {
    const event = this.get(actor.guildId, id);
    if (!this.canManage(actor, event)) throw new UserError('Only this event’s organizer or a server manager can do that.');
    if (event.revision !== revision) throw new StaleActionError('Refresh the event before editing it.');
    return event;
  }

  private isUpcoming(event: CasinoEvent): boolean {
    return event.state === 'scheduled' || event.state === 'ready' || event.state === 'awaiting';
  }

  private recheck(id: string, guildId: string): CasinoEvent {
    const current = this.get(guildId, id);
    if (!this.isUpcoming(current) || current.starts_at > this.deps.clock.now()) return current;
    const state = current.registered >= current.min_players ? 'ready' : 'awaiting';
    if (state === current.state) return current;
    this.deps.db.run('UPDATE casino_events SET state = ?, revision = revision + 1 WHERE id = ?', [state, id]);
    return this.get(guildId, id);
  }

  private updateSchedule(event: CasinoEvent): CasinoEvent {
    const { scheduler, clock } = this.deps;
    const key = 'event:' + event.id;
    scheduler.clear(key);
    if (this.isUpcoming(event) && event.starts_at > clock.now()) {
      scheduler.set(key, event.starts_at, () => {
        const current = this.recheck(event.id, event.guild_id);
        this.updateSchedule(current);
      });
    }
    this.changed(event.guild_id);
    return event;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
