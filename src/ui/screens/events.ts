import type { CasinoApp } from '../../app/casino-app.js';
import { discordTime, escapeMarkdown, plural, truncate } from '../../core/format.js';
import type { CasinoEvent, EventActor, EventGame } from '../../domain/casino-events.js';
import { cid } from '../custom-id.js';
import { button, container, linkButton, modal, option, row, section, select, selectLabel, text, textInputLabel, type Screen } from '../kit.js';
import { COLORS, ICONS } from '../theme.js';
import { channelUrl, navRow } from './common.js';

const STATE_LABELS = {
  scheduled: 'Scheduled', ready: 'Ready to start', awaiting: 'Waiting for players', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
} as const;

function gameName(game: EventGame): string {
  return game === 'blackjack' ? 'Blackjack' : 'Hold’em';
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
        text('## Casino events\n-# Scheduled Blackjack and Hold’em sessions'),
        ...current.map((event) => section([
          `**${escapeMarkdown(event.title)}** · ${gameName(event.game)}\n${discordTime(event.starts_at, 'f')} · ${event.registered}/${event.max_players} registered · ${STATE_LABELS[event.state]}`,
        ], button({ id: cid('evt', 'open', event.id), label: 'Details', emoji: ICONS.events, tone: 'primary' }))),
        current.length ? null : text('No upcoming events.'),
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

export function eventDetailsScreen(app: CasinoApp, actor: EventActor, event: CasinoEvent): Screen {
  const canManage = app.events.canManage(actor, event);
  const table = app.events.table(event);
  const registered = app.events.registered(event.id, actor.userId);
  const publicTableAvailable = table && !event.access_code && event.state === 'in_progress';
  const privateTableAvailable = table && event.access_code && event.state === 'in_progress' && (registered || canManage);
  const upcoming = event.state === 'scheduled' || event.state === 'awaiting' || event.state === 'ready';
  const organizer = app.economy.getPlayer(event.guild_id, event.organizer_id)?.display_name || 'Casino organizer';
  const people = app.events.registrations(event);
  const choices = canManage && upcoming ? app.events.assignableTables(actor, event) : [];
  const options = choices.map((choice) => option(truncate(choice.name, 70), choice.id, undefined, undefined, event.table_id === choice.id));
  if (event.table_id) options.unshift(option('Detach table', 'detach'));
  return {
    components: [
      container(COLORS.gold, [
        navRow('games'),
        text(`## ${escapeMarkdown(event.title)}\n**${gameName(event.game)}** · ${STATE_LABELS[event.state]} · ${event.access_code ? 'Private' : 'Public'}\n${discordTime(event.starts_at, 'F')} · ${escapeMarkdown(organizer)}`),
        event.description ? text(escapeMarkdown(event.description)) : null,
        text(`**Registration** · ${event.registered}/${event.max_players} · ${plural(event.min_players, 'player')} needed${people.length ? '\n-# ' + people.map((person) => escapeMarkdown(truncate(person.name, 26))).join(' · ') : ''}`),
        canManage && event.access_code && upcoming ? text(`-# Invitation code · **${event.access_code}**`) : null,
        privateTableAvailable && table.access_code ? text(`**Private table code** · ${table.access_code}`) : null,
        row(
          upcoming && !registered ? button({ id: cid('evt', 'join', event.id), label: 'Join event', tone: 'success', disabled: !event.registration_open || event.registered >= event.max_players }) : null,
          upcoming && registered ? button({ id: cid('evt', 'leave', event.id), label: 'Withdraw', emoji: ICONS.leave }) : null,
          publicTableAvailable && table.message_id && (table.thread_id || table.channel_id) ? linkButton('Open table',
            channelUrl(event.guild_id, (table.thread_id ?? table.channel_id)!, table.thread_id ? null : table.message_id), ICONS.tables) : null,
          privateTableAvailable ? button({ id: event.game === 'poker' ? cid('pk', 'join', table.id) : cid('tbl', 'join', table.id), label: 'Take a private seat', emoji: ICONS.tables }) : null,
          button({ id: cid('nav', 'events', 'back'), label: 'Back to events', emoji: ICONS.back }),
        ),
      ]),
      ...(canManage && (upcoming || event.state === 'in_progress') ? [container(COLORS.deepEmerald, [
        text(table ? `**Assigned table** · ${escapeMarkdown(table.name)}` : '**Table** · Open a matching table, then return here to assign it.'),
        upcoming && options.length ? select({ id: cid('evt', 'assign', event.id, event.revision), placeholder: 'Assign your table', options: options.slice(0, 25) }) : null,
        upcoming && !options.length ? row(button({ id: cid('nav', 'tables', event.game), label: 'Browse and open tables', emoji: ICONS.tables })) : null,
        row(
          upcoming ? button({ id: cid('evt', 'edit', event.id, event.revision), label: 'Edit', disabled: !!table }) : null,
          upcoming ? button({ id: cid('evt', 'registration', event.id, event.revision), label: event.registration_open ? 'Close registration' : 'Open registration' }) : null,
          upcoming ? button({ id: cid('evt', 'start', event.id, event.revision), label: 'Start event', tone: 'success', disabled: !table || event.state !== 'ready' }) : null,
          upcoming ? button({ id: cid('evt', 'cancel', event.id, event.revision), label: 'Cancel event', tone: 'danger' }) : null,
          event.state === 'in_progress' ? button({ id: cid('evt', 'finish', event.id, event.revision), label: 'Finish event', tone: 'success' }) : null,
        ),
      ])] : []),
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
    textInputLabel({ id: 'capacity', label: 'Minimum and maximum players', description: 'Use a range like 2-5. The maximum must fit one table.', value: event ? event.min_players + '-' + event.max_players : '2-' + (settings.blackjack.enabled ? settings.blackjack.maxSeats : settings.poker.maxSeats), max: 7 }),
    selectLabel({ id: 'format', label: 'Game and visibility', options: games.flatMap((game) => ['public', 'private'].map((visibility) =>
      option(gameName(game) + ' · ' + visibility, game + '-' + visibility, undefined, undefined, activeGame === game + '-' + visibility))) }),
  ]);
}

export function eventInviteModal() {
  return modal(cid('m', 'evtcode'), 'Join a private casino event', [textInputLabel({ id: 'code', label: 'Invitation code', max: 10 })]);
}
