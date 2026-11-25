import type { CasinoApp } from '../../app/casino-app.js';
import { chips, discordTime, escapeMarkdown, plural, truncate } from '../../core/format.js';
import { EVENT_TABLE_GRACE_MS, EVENT_TABLE_LEAD_MS, type CasinoEvent, type EventActor, type EventGame, type EventTableConfig } from '../../domain/casino-events.js';
import { cid } from '../custom-id.js';
import { button, container, linkButton, modal, option, progressBar, row, section, select, selectLabel, text, textInputLabel, type ModalSpec, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { channelUrl, navRow } from './common.js';
import { myTable, seatConflict, type MyTable } from './my-table.js';

const STATE_LABELS = {
  scheduled: 'Scheduled', ready: 'Ready to start', awaiting: 'Waiting for players', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
} as const;

function gameName(game: EventGame): string {
  return game === 'blackjack' ? 'Blackjack' : 'Hold’em';
}

function gameIcon(game: EventGame): string {
  return game === 'poker' ? ICONS.poker : ICONS.blackjack;
}

function isUpcoming(event: CasinoEvent): boolean {
  return event.state === 'scheduled' || event.state === 'awaiting' || event.state === 'ready';
}

/** "5 seats · bets 10–500" / "6 seats · blinds 5/10 · buy-in 100–500" */
function configLine(app: CasinoApp, event: CasinoEvent, config: EventTableConfig): string {
  if (config.game === 'blackjack') return `${plural(config.seats, 'seat')} · bets ${chips(config.minBet)}–${chips(config.maxBet)}`;
  const pk = app.settings.get(event.guild_id).poker;
  return `${plural(config.seats, 'seat')} · blinds ${chips(pk.smallBlind)}/${chips(pk.bigBlind)} · buy-in ${chips(pk.minBuyIn)}–${chips(pk.maxBuyIn)}`;
}

function seating(app: CasinoApp, tableId: string): string {
  const blackjack = app.blackjack.peek(tableId);
  const poker = app.poker.peek(tableId);
  const seated = blackjack?.state.seats.length ?? poker?.state.seats.length ?? 0;
  const seats = blackjack?.record.config.maxSeats ?? poker?.record.config.maxSeats;
  return seats ? `${seated}/${seats} seated` : plural(seated, 'player') + ' seated';
}

/** Who hosts the table when it opens, as the organizer controls explain it. */
function hostHint(app: CasinoApp, event: CasinoEvent, isOrganizer: boolean): string {
  const config = app.events.tableConfig(event);
  const [you, your] = isOrganizer ? ['you', 'your'] : ['the organizer', 'their'];
  if (config.game === 'poker') {
    return app.events.registered(event.id, event.organizer_id)
      ? `When the table opens, ${you} host it with ${your} ${chips(config.buyIn)}-chip buy-in.`
      : isOrganizer ? 'Register to host it with your buy-in. Until then, the first registered player to sit opens it.'
        : 'The organizer isn’t registered, so the first registered player to sit opens it.';
  }
  return app.events.organizerKeepsSeat(event)
    ? `When the table opens, ${you} host it from a seat.`
    : 'Every seat is kept for registered players: the first of them to sit hosts. Register to play too.';
}

/** A row of buttons, or nothing when none of them applies (Discord rejects empty rows). */
function buttonRow(...buttons: Parameters<typeof row>): ReturnType<typeof row> | null {
  const built = row(...buttons);
  return built.components.length ? built : null;
}

const PAGE_SIZE = 4;

export function eventsScreen(app: CasinoApp, actor: EventActor, requested = 0): Screen {
  const events = app.events.upcoming(actor.guildId, actor.userId);
  const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, requested));
  const current = events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const settings = app.settings.get(actor.guildId);
  return {
    components: [
      container(COLORS.gold, [
        navRow('games'),
        text(`## ${ICONS.events} Casino events\n-# Game nights with friends: register, and the table opens 15 minutes before the start.`),
        ...current.map((event) => {
          const table = app.events.table(event);
          const mine = app.events.registered(event.id, actor.userId);
          const status = [STATE_LABELS[event.state], table ? 'table open' : null, mine ? 'you’re registered' : null].filter(Boolean).join(' · ');
          return section([
            `${gameIcon(event.game)} **${escapeMarkdown(event.title)}** · ${gameName(event.game)}${event.access_code ? ` ${ICONS.lock}` : ''}\n${discordTime(event.starts_at, 'f')} (${discordTime(event.starts_at)})\n-# ${progressBar(event.max_players ? event.registered / event.max_players : 0, 6)} ${event.registered}/${event.max_players} registered · ${status}`,
          ], button({ id: cid('evt', 'open', event.id), label: 'Details', emoji: ICONS.events, tone: table ? 'success' : 'secondary' }));
        }),
        current.length ? null : text(app.events.canManage(actor) ? '-# Nothing scheduled yet. Create the first game night below.' : '-# Nothing scheduled yet. Organizers can create game nights here.'),
        pages > 1 ? row(
          button({ id: cid('nav', 'events', page - 1), label: 'Previous', emoji: ICONS.prev, disabled: page === 0 }),
          button({ id: cid('nav', 'events', page + 1), label: 'Next', emoji: ICONS.next, disabled: page + 1 >= pages }),
        ) : null,
        row(
          app.events.canManage(actor) && settings.enabled ? button({ id: cid('evt', 'create'), label: 'Create event', emoji: ICONS.events, tone: 'success' }) : null,
          button({ id: cid('evt', 'invite'), label: 'Use invitation code', emoji: ICONS.lock }),
        ),
      ]),
    ],
  };
}

/** Where the event's table stands, for everyone (the organizer also sees why it hasn't opened). */
function tableStatus(app: CasinoApp, event: CasinoEvent, canManage: boolean): string | null {
  const config = app.events.tableConfig(event);
  const table = app.events.table(event);
  const head = `**Table** · ${configLine(app, event, config)}`;
  if (table) return `${head}\n${ICONS.tables} **${escapeMarkdown(table.name)}** is open · ${seating(app, table.id)}`;
  const active = isUpcoming(event) || event.state === 'in_progress';
  if (!active) return event.table_note ? `-# ${escapeMarkdown(event.table_note)}` : null;
  const now = app.clock.now();
  const opensAt = event.starts_at - EVENT_TABLE_LEAD_MS;
  const missing = event.min_players - event.registered;
  let when: string;
  if (now >= event.starts_at + EVENT_TABLE_GRACE_MS) when = 'The table window has passed.';
  else if (missing > 0 && event.state !== 'in_progress') when = now < opensAt
    ? `Opens ${discordTime(opensAt, 't')} (${discordTime(opensAt)}) once ${plural(event.min_players, 'player')} have registered.`
    : `Opens as soon as ${plural(missing, 'more player')} ${missing === 1 ? 'registers' : 'register'}.`;
  else if (now < opensAt) when = `Opens ${discordTime(opensAt, 't')} (${discordTime(opensAt)}), 15 minutes before the start.`;
  else if (event.opened_table_id) when = 'The table has closed. Registered players can open it again by taking a seat.';
  else when = event.game === 'poker' ? 'Opening shortly. A registered player can also open it by taking a seat.' : 'Opening shortly.';
  const note = event.table_note && canManage ? `\n-# ${escapeMarkdown(event.table_note)}` : '';
  return `${head}\n-# ${when}${note}`;
}

export function eventDetailsScreen(app: CasinoApp, actor: EventActor, event: CasinoEvent): Screen {
  const canManage = app.events.canManage(actor, event);
  const table = app.events.table(event);
  const registered = app.events.registered(event.id, actor.userId);
  const upcoming = isUpcoming(event);
  const active = upcoming || event.state === 'in_progress';
  const organizer = app.economy.getPlayer(event.guild_id, event.organizer_id)?.display_name || 'Casino organizer';
  const people = app.events.registrations(event);
  const url = table && table.message_id ? tableLink(event, table) : null;
  const me = myTable(app, actor);
  const seatedHere = !!table && me?.id === table.id;
  const maySit = active && app.events.maySit(event, actor.userId);
  const canTakeSeat = maySit && !seatedHere && (table ? !!table.message_id : app.events.openable(event, app.clock.now()));
  // The manual path: an organizer may still assign one of their own open tables.
  const manual = !!table && table.id !== event.opened_table_id;
  const choices = canManage && upcoming && (!table || manual) ? app.events.assignableTables(actor, event) : [];
  const options = choices.map((choice) => option(truncate(choice.name, 70), choice.id, undefined, undefined, event.table_id === choice.id));
  if (manual) options.unshift(option('Detach table', 'detach'));
  const missing = Math.max(0, event.min_players - event.registered);
  return {
    components: [
      container(COLORS.gold, [
        navRow('games'),
        text(`## ${gameIcon(event.game)} ${escapeMarkdown(event.title)}\n**${gameName(event.game)}** · ${STATE_LABELS[event.state]} · ${event.access_code ? `${ICONS.lock} Private` : 'Public'}\n${discordTime(event.starts_at, 'F')} (${discordTime(event.starts_at)}) · organized by ${escapeMarkdown(organizer)}`),
        event.description ? text(escapeMarkdown(event.description)) : null,
        text(`**Players** · ${progressBar(event.max_players ? event.registered / event.max_players : 0, 6)} ${event.registered}/${event.max_players}${missing ? ` · ${plural(missing, 'more player')} needed` : ''}${registered ? ' · you’re registered' : ''}${people.length ? '\n-# ' + people.map((person) => escapeMarkdown(truncate(person.name, 26))).join(' · ') : ''}`),
        ((status) => (status ? text(status) : null))(tableStatus(app, event, canManage)),
        event.access_code && registered && active ? text('-# Private event: your registration is your way in. No table code needed.') : null,
        row(
          upcoming && !registered ? button({ id: cid('evt', 'join', event.id), label: 'Join event', tone: 'success', disabled: !event.registration_open || event.registered >= event.max_players }) : null,
          upcoming && registered ? button({ id: cid('evt', 'leave', event.id), label: 'Withdraw', emoji: ICONS.leave }) : null,
          seatedHere && url ? linkButton('Go to the table', url, ICONS.tables) : null,
          canTakeSeat ? button({ id: cid('evt', 'seat', event.id), label: 'Join the table', emoji: gameIcon(event.game), tone: 'success' }) : null,
          table && url && !event.access_code && !maySit && !seatedHere ? linkButton('View table', url, ICONS.spectate) : null,
          button({ id: cid('nav', 'events', 'back'), label: 'Back to events', emoji: ICONS.back }),
        ),
      ]),
      ...(canManage && active ? [container(COLORS.deepEmerald, [
        text(`**Organizer**${event.access_code && upcoming ? ` · invitation code **${event.access_code}**` : ''}\n-# ${table ? 'The table is open; its settings are fixed now.' : hostHint(app, event, actor.userId === event.organizer_id)}`),
        options.length ? select({ id: cid('evt', 'assign', event.id, event.revision), placeholder: table ? 'Assigned table' : 'Or use one of your open tables', options: options.slice(0, 25) }) : null,
        buttonRow(
          upcoming ? button({ id: cid('evt', 'edit', event.id, event.revision), label: 'Edit', disabled: !!table }) : null,
          upcoming && !table ? button({ id: cid('evt', 'table', event.id, event.revision), label: 'Table settings', emoji: ICONS.settings }) : null,
          !table ? button({ id: cid('evt', 'opennow', event.id, event.revision), label: 'Open table now', emoji: ICONS.tables, tone: 'success' }) : null,
        ),
        buttonRow(
          upcoming ? button({ id: cid('evt', 'registration', event.id, event.revision), label: event.registration_open ? 'Close registration' : 'Open registration' }) : null,
          upcoming ? button({ id: cid('evt', 'start', event.id, event.revision), label: 'Start event', tone: 'success', disabled: !table || event.registered < event.min_players }) : null,
          upcoming ? button({ id: cid('evt', 'cancel', event.id, event.revision), label: 'Cancel event', tone: 'danger' }) : null,
          event.state === 'in_progress' ? button({ id: cid('evt', 'finish', event.id, event.revision), label: 'Finish event', tone: 'success' }) : null,
        ),
      ])] : []),
    ],
  };
}

function tableLink(event: CasinoEvent, table: { thread_id: string | null; channel_id: string | null; message_id: string | null }): string | null {
  if (table.thread_id) return channelUrl(event.guild_id, table.thread_id);
  return table.channel_id && table.message_id ? channelUrl(event.guild_id, table.channel_id, table.message_id) : null;
}

/** After taking a seat through the event. Never shows the table's access code. */
export function eventSeatedScreen(event: CasinoEvent, seat: { tableId: string; tableName: string; url: string | null; opened: boolean }, note?: string): Screen {
  const body = note ?? (seat.opened
    ? 'You opened the event table and you’re its host.'
    : event.game === 'poker' ? 'You’re seated. Your stack stays reserved until you leave.' : 'You’re seated. Press a chip on the table to bet.');
  return {
    components: [
      container(COLORS.emerald, [
        navRow('games'),
        text(`## ${gameIcon(event.game)} ${escapeMarkdown(seat.tableName)}\n${body}\n-# ${escapeMarkdown(event.title)}`),
        row(
          seat.url ? linkButton('Go to the table', seat.url, ICONS.tables) : null,
          event.game === 'poker' ? button({ id: cid('pk', 'hand', seat.tableId), label: 'My hand', emoji: ICONS.hand }) : null,
          button({ id: cid('evt', 'open', event.id), label: 'Back to event', emoji: ICONS.back }),
        ),
      ]),
    ],
  };
}

/** A registered player who is seated at another table: the way back, or out, as everywhere else. */
export function eventSeatConflictScreen(event: CasinoEvent, table: MyTable): Screen {
  return {
    components: [
      container(COLORS.gold, [
        navRow('games'),
        ...seatConflict(table, 'the event table'),
        row(button({ id: cid('evt', 'open', event.id), label: 'Back to event', emoji: ICONS.back })),
      ]),
    ],
  };
}

export function eventEditor(app: CasinoApp, actor: EventActor, event?: CasinoEvent) {
  const settings = app.settings.get(actor.guildId);
  const time = event ? new Date(event.starts_at).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : undefined;
  const activeGame = event ? event.game + (event.access_code ? '-private' : '-public') : settings.blackjack.enabled ? 'blackjack-public' : 'poker-public';
  const games = (['blackjack', 'poker'] as const).filter((game) => settings[game].enabled);
  return modal(event ? cid('m', 'evtedt', event.id, event.revision) : cid('m', 'evtnew'), event ? 'Edit casino event' : 'Schedule a casino event', [
    textInputLabel({ id: 'title', label: 'Event name', value: event?.title, max: 60 }),
    textInputLabel({ id: 'time', label: 'Start time and UTC offset', description: 'Include the offset or Z · 2026-12-04 20:00 +01:00', max: 32, value: time }),
    textInputLabel({ id: 'description', label: 'Details', value: event?.description, max: 450, required: false, paragraph: true }),
    textInputLabel({ id: 'capacity', label: 'Minimum and maximum players', description: 'A range like 2-5. Table seats and stakes come next.', value: event ? event.min_players + '-' + event.max_players : '2-' + (settings.blackjack.enabled ? settings.blackjack.maxSeats : settings.poker.maxSeats), max: 7 }),
    selectLabel({ id: 'format', label: 'Game and visibility', description: 'Private: only invited players register, and only they can sit.', options: games.flatMap((game) => ['public', 'private'].map((visibility) =>
      option(gameName(game) + ' · ' + visibility, game + '-' + visibility, undefined, undefined, activeGame === game + '-' + visibility))) }),
  ]);
}

/** The event table's settings (before it opens). Hold'em blinds and buy-in limits follow the server settings. */
export function eventTableModal(app: CasinoApp, event: CasinoEvent): ModalSpec {
  const config = app.events.tableConfig(event);
  const settings = app.settings.get(event.guild_id);
  const limit = config.game === 'poker' ? settings.poker.maxSeats : settings.blackjack.maxSeats;
  const lowest = Math.min(limit, Math.max(2, event.max_players));
  const seats = Array.from({ length: limit - lowest + 1 }, (_, i) => limit - i).map((n) =>
    option(plural(n, 'seat'), String(n), n > event.max_players ? `Room for ${plural(n - event.max_players, 'extra player')}` : 'One per player', undefined, n === config.seats));
  const seatsLabel = (note = '') => selectLabel({ id: 'seats', label: 'Seats', description: `At least one per player (${event.max_players})${note}`, options: seats });
  if (config.game === 'blackjack') {
    const bj = settings.blackjack;
    return modal(cid('m', 'evttbl', event.id, event.revision), 'Event table · Blackjack', [
      seatsLabel(),
      textInputLabel({ id: 'min', label: 'Minimum bet', description: `Server range ${chips(bj.minBet)}–${chips(bj.maxBet)}`, value: String(config.minBet), max: 9 }),
      textInputLabel({ id: 'max', label: 'Maximum bet', value: String(config.maxBet), max: 9 }),
    ]);
  }
  const pk = settings.poker;
  return modal(cid('m', 'evttbl', event.id, event.revision), 'Event table · Hold’em', [
    // Blinds and the buy-in range are server settings (no per-table limits in the Hold'em service yet).
    seatsLabel(` · blinds ${chips(pk.smallBlind)}/${chips(pk.bigBlind)} are the server's`),
    textInputLabel({ id: 'buyin', label: 'Your buy-in as host', description: `Reserved when the table opens with you seated (only if you registered). ${chips(pk.minBuyIn)}–${chips(pk.maxBuyIn)}`, value: String(config.buyIn), max: 8 }),
  ]);
}

/** Hold'em seat through the event: the buy-in only (registration replaces any table code). */
export function eventBuyInModal(app: CasinoApp, event: CasinoEvent, opening: boolean): ModalSpec {
  const table = app.events.table(event);
  const limits = (table && app.poker.peek(table.id)?.record.config) ?? app.settings.get(event.guild_id).poker;
  // The organizer opening the table starts from the buy-in they set in the table settings.
  const config = app.events.tableConfig(event);
  const suggested = opening && config.game === 'poker' ? config.buyIn : limits.minBuyIn;
  return modal(cid('m', 'evtbuy', event.id), `Take a seat · ${truncate(event.title, 28)}`, [
    textInputLabel({ id: 'buyin', label: 'Buy-in', description: `${chips(limits.minBuyIn)}–${chips(limits.maxBuyIn)} chips · returned to Wallet when you leave`, value: String(suggested), max: 8 }),
  ]);
}

export function eventInviteModal() {
  return modal(cid('m', 'evtcode'), 'Join a private casino event', [textInputLabel({ id: 'code', label: 'Invitation code', max: 10 })]);
}
