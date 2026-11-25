import { afterEach, expect, it } from 'vitest';
import { CasinoApp } from '../../src/app/casino-app.js';
import { silentLogger } from '../../src/core/logger.js';
import { ManualScheduler } from '../../src/core/scheduler.js';
import { parseEventTime } from '../../src/domain/casino-events.js';
import { CasinoHarness } from '../harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => h.close());

it('parses explicit offsets and rejects missing offsets, invalid dates and unsupported offsets', () => {
  h = new CasinoHarness();
  expect(parseEventTime('2026-12-04 20:00 +01:00')).toBe(Date.UTC(2026, 11, 4, 19));
  expect(parseEventTime('2026-07-04 20:00 +02:00')).toBe(Date.UTC(2026, 6, 4, 18));
  expect(parseEventTime('2026-12-04 20:00')).toBeNull();
  expect(parseEventTime('2026-02-30 20:00Z')).toBeNull();
  expect(parseEventTime('2026-12-04 20:00 +14:01')).toBeNull();
});

it('organizes a Blackjack event with the Discord router and links the assigned table at start', async () => {
  h = new CasinoHarness();
  const host = h.user('Host', true);
  const alice = h.user('Alice');
  const bob = h.user('Bob');
  const home = h.seen(await h.slash(host, 'casino'))!;
  const startAt = new Date(h.clock.now() + 120_000);
  const start = startAt.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const eventList = h.seen(await h.click(host, home, 'Events'))!;
  const editor = await h.click(host, eventList, 'Create event');
  const open = await h.submit(host, editor, { title: 'Friday Blackjack', time: start, description: 'A friendly session', capacity: '2-2', format: ['blackjack-public'] });
  expect(h.text(h.seen(open))).toContain('Friday Blackjack');
  const event = h.app.events.upcoming(h.guildId)[0]!;
  const getPlayerEvents = async (player: typeof alice) => {
    const home = h.seen(await h.slash(player, 'casino'))!;
    await h.click(player, home, 'Events');
    await h.click(player, home, 'Details');
    return home;
  };
  const aliceEvent = await getPlayerEvents(alice);
  const bobEvent = await getPlayerEvents(bob);
  h.fd.click(alice, aliceEvent, 'Join event');
  h.fd.click(alice, aliceEvent, 'Join event');
  h.fd.click(bob, bobEvent, 'Join event');
  await h.settle();
  expect(h.app.events.registrations(event).map((entry) => entry.user_id).sort()).toEqual([alice.id, bob.id].sort());
  const table = await h.app.blackjack.createTable({ guildId: h.guildId, ownerId: host.id, ownerName: host.name });
  await h.bot.createTablePanel(table.record.id, h.casino, host.id);
  const hostEvent = await getPlayerEvents(host);
  await h.select(host, hostEvent, 'evt:assign', [table.record.id]);
  await h.advance(120_000);
  const freshHostEvent = await getPlayerEvents(host);
  await h.click(host, freshHostEvent, 'Start event');
  expect(h.text(freshHostEvent)).toContain('In progress');
  expect(h.buttons(freshHostEvent).find((button) => button.label === 'Go to the table')?.style).toBe(5); // the host is seated there
  await h.click(host, freshHostEvent, 'Finish event');
  expect(h.app.events.upcoming(h.guildId)).toEqual([]);
  expect(h.guard!.blockedCount).toBe(0);
});

it('enforces organizer access, seat limits, private invites, guild scope and revision checks', () => {
  h = new CasinoHarness();
  const { app, guildId } = h;
  const admin = { guildId, userId: 'admin', isAdmin: true };
  const guest = { guildId, userId: 'guest', isAdmin: false };
  const role = { guildId, userId: 'role', isAdmin: false, canOrganizeEvents: true };
  const input = { title: 'Members’ Blackjack', description: '', game: 'blackjack' as const, startsAt: h.clock.now() + 60_000, minPlayers: 2, maxPlayers: 2, private: true };
  expect(() => app.events.create(guest, input)).toThrow(/organizers/);
  const event = app.events.create(role, input);
  expect(app.events.upcoming(guildId)).toEqual([]);
  expect(app.events.upcoming(guildId, role.userId)).toHaveLength(1);
  expect(() => app.events.view(guest, event.id)).toThrow(/invitation/);
  expect(() => app.events.joinWithCode({ ...guest, guildId: 'another' }, event.access_code!, 'Guest')).toThrow(/invitation/);
  expect(() => app.events.join(guest, event.id, 'Guest')).toThrow(/invitation/);
  expect(() => app.events.manageAction(role, event.id, event.revision, 'start')).toThrow(/requires/);
  app.events.joinWithCode(guest, event.access_code!, 'Guest');
  app.events.joinWithCode(guest, event.access_code!, 'Guest');
  app.events.joinWithCode({ ...guest, userId: 'guest2' }, event.access_code!, 'Guest 2');
  expect(() => app.events.joinWithCode({ ...guest, userId: 'guest3' }, event.access_code!, 'Guest 3')).toThrow(/full/);
  app.events.leave(guest, event.id);
  const edited = app.events.edit(role, event.id, event.revision, { ...input, title: 'Updated event' });
  expect(() => app.events.manageAction(role, event.id, event.revision, 'cancel')).toThrow(/Refresh/);
  expect(() => app.events.manageAction({ ...role, canOrganizeEvents: false }, event.id, edited.revision, 'cancel')).toThrow(/organizer/);
  expect(app.events.manageAction(admin, event.id, edited.revision, 'cancel').state).toBe('cancelled');
  expect(() => app.events.create(admin, { ...input, game: 'poker' })).toThrow(/enabled/);
});

it('rearms scheduled events after restarting and keeps separate events and registrations', async () => {
  h = new CasinoHarness();
  const { app, guildId, db, clock } = h;
  const organizer = { guildId, userId: 'host', isAdmin: true };
  const input = { title: 'First', description: '', game: 'blackjack' as const, startsAt: clock.now() + 1_000, minPlayers: 2, maxPlayers: 3, private: false };
  const first = app.events.create(organizer, input);
  const second = app.events.create(organizer, { ...input, title: 'Second', startsAt: input.startsAt + 60_000 });
  for (const userId of ['one', 'two']) app.events.join({ ...organizer, userId }, first.id, userId);
  await app.shutdown();
  const scheduler = new ManualScheduler(clock);
  const recovered = new CasinoApp({ db, clock, scheduler, logger: silentLogger });
  expect(recovered.recover().events).toBe(2);
  clock.advance(1_000);
  scheduler.runDue();
  expect(recovered.events.view(organizer, first.id).state).toBe('ready');
  expect(recovered.events.view(organizer, second.id).state).toBe('scheduled');
  clock.advance(60_000);
  scheduler.runDue();
  expect(recovered.events.view(organizer, second.id).state).toBe('awaiting');
  expect(recovered.events.view(organizer, first.id).registered).toBe(2);
  await recovered.shutdown();
});
