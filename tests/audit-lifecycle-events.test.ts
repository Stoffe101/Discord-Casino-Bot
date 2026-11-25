/**
 * Audit: casino events — registration capacity, private access, organizer authorization, the
 * event-assigned table versus idle closure, and recovery.
 *
 * Tests marked "Fixed" were written as failing reproductions during the lifecycle audit and now
 * guard the fixes.
 * Event controls are pressed by custom id (clickRaw) so the tests survive the UI redesign.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_TABLE_GRACE_MS, type EventActor } from '../src/domain/casino-events.js';
import { CasinoHarness } from './harness/casino-harness.js';
import type { FakeMessage, FakeUser } from './harness/fake-discord.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function harness(options: ConstructorParameters<typeof CasinoHarness>[0] = {}): CasinoHarness {
  const h = new CasinoHarness(options);
  cleanup.push(() => h.close());
  return h;
}

function player(h: CasinoHarness, name: string, admin = false): FakeUser {
  const user = h.user(name, admin);
  h.app.economy.ensurePlayer(h.guildId, user.id, name);
  return user;
}

const MIN = 60_000;

function actor(h: CasinoHarness, user: FakeUser, isAdmin = false): EventActor {
  return { guildId: h.guildId, userId: user.id, isAdmin };
}

function eventInput(h: CasinoHarness, overrides: Partial<{ startsAt: number; minPlayers: number; maxPlayers: number; private: boolean }> = {}) {
  return { title: 'Audit Night', description: '', game: 'blackjack' as const, startsAt: h.clock.now() + 60 * MIN, minPlayers: 2, maxPlayers: 4, private: false, ...overrides };
}

async function openTable(h: CasinoHarness, host: FakeUser, isPrivate = false) {
  const table = await h.app.blackjack.createTable({ guildId: h.guildId, ownerId: host.id, ownerName: host.name, isPrivate });
  await h.bot.createTablePanel(table.record.id, h.casino, host.id);
  await h.settle();
  return table.record.id;
}

async function anchor(h: CasinoHarness, user: FakeUser): Promise<FakeMessage> {
  const message = h.seen(await h.slash(user, 'casino'));
  if (!message) throw new Error('no /casino reply');
  return message;
}

async function press(h: CasinoHarness, user: FakeUser, message: FakeMessage, customId: string) {
  const rec = h.fd.clickRaw(user, message, customId);
  await h.settle();
  return rec;
}

describe('audit: casino events', () => {
  // Fixed gap (was blackjack-table-service.ts idleReason / poker-service.ts isIdle know nothing
  // about events): the details screen tells organizers to "Open a matching table, then return here
  // to assign it", but an assigned table for an event more than ~5 min away is idle-closed by the
  // sweep, bot.onTableClosed → events.tableClosed silently detaches it, and "Start event" can no
  // longer be used until a new table is opened and assigned.
  it('a table assigned to an upcoming event survives the idle sweep until the event starts', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const event = h.app.events.create(organizer, eventInput(h));
    const tableId = await openTable(h, host);
    expect(h.app.events.assign(organizer, event.id, event.revision, tableId).table_id).toBe(tableId);
    h.clock.advance(5 * MIN);
    await h.app.blackjack.sweepIdle();
    await h.settle();
    expect(h.app.blackjack.peek(tableId)).toBeDefined();
    expect(h.app.events.view(organizer, event.id).table_id).toBe(tableId);
  });

  // Policy: the idle exemption is bounded — it ends 30 minutes after the start time. After that an
  // in-progress event's table follows the normal idle rule, and its close completes the event.
  it('the event exemption ends 30 minutes after the start; an idle table then closes and completes the event', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const event = h.app.events.create(organizer, eventInput(h, { startsAt: h.clock.now() + MIN }));
    for (const name of ['P1', 'P2']) h.app.events.join(actor(h, player(h, name)), event.id, name);
    const tableId = await openTable(h, host);
    h.app.events.assign(organizer, event.id, event.revision, tableId);
    await h.advance(MIN); // start time: the event becomes 'ready' (this is also table activity-free)
    const ready = h.app.events.view(organizer, event.id);
    expect(ready.state).toBe('ready');
    // The table was opened before the start; act once so it is fresh when the event starts.
    await h.app.blackjack.setSittingOut(tableId, host.id, true);
    expect(h.app.events.manageAction(organizer, event.id, ready.revision, 'start').state).toBe('in_progress');
    h.clock.advance(5 * MIN); // idle, but within 30 minutes of the start
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    expect(h.app.events.view(organizer, event.id)).toMatchObject({ state: 'in_progress', table_id: tableId });
    h.clock.advance(EVENT_TABLE_GRACE_MS - 5 * MIN); // exactly starts_at + 30 min
    expect(await h.app.blackjack.sweepIdle()).toEqual([tableId]);
    await h.settle();
    expect(h.app.events.view(organizer, event.id)).toMatchObject({ state: 'completed', table_id: null });
  });

  // Fixed bug (was casino-events.ts assignableTables): only `maxSeats >= max_players` is checked,
  // but createTable always seats the organizer. With an unregistered organizer, a full event
  // cannot seat its last registrant ("This table is full").
  it('every registrant of a full event can take a seat at the assigned table', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const maxSeats = h.app.settings.get(h.guildId).blackjack.maxSeats;
    const event = h.app.events.create(organizer, eventInput(h, { startsAt: h.clock.now() + MIN, maxPlayers: maxSeats }));
    const players = Array.from({ length: maxSeats }, (_, i) => player(h, `P${i + 1}`));
    for (const p of players) h.app.events.join(actor(h, p), event.id, p.name);
    const tableId = await openTable(h, host);
    // Either fix is acceptable: refuse to assign a table that cannot seat every registrant, or
    // make room for all of them.
    let assigned = true;
    try {
      h.app.events.assign(organizer, event.id, event.revision, tableId);
    } catch {
      assigned = false;
    }
    if (!assigned) return;
    for (const p of players) await h.app.blackjack.join(tableId, p.id, p.name);
    expect(h.app.blackjack.peek(tableId)!.state.seats.filter((s) => s.userId !== host.id)).toHaveLength(maxSeats);
  });

  it('assigning explains the host seat, and a registered organizer can use a table that fits everyone', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const maxSeats = h.app.settings.get(h.guildId).blackjack.maxSeats;
    const event = h.app.events.create(organizer, eventInput(h, { maxPlayers: maxSeats }));
    const tableId = await openTable(h, host);
    expect(h.app.events.assignableTables(organizer, event)).toEqual([]);
    expect(() => h.app.events.assign(organizer, event.id, event.revision, tableId)).toThrow(/Register for the event yourself/);
    const registered = h.app.events.join(organizer, event.id, host.name);
    expect(h.app.events.assignableTables(organizer, registered).map((t) => t.id)).toEqual([tableId]);
    expect(h.app.events.assign(organizer, event.id, registered.revision, tableId).table_id).toBe(tableId);
  });

  it('an assigned table far ahead of its event is held only until 30 minutes after the start', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const event = h.app.events.create(organizer, eventInput(h, { startsAt: h.clock.now() + 120 * MIN }));
    const tableId = await openTable(h, host);
    h.app.events.assign(organizer, event.id, event.revision, tableId);
    h.clock.advance(120 * MIN + EVENT_TABLE_GRACE_MS - 1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([]);
    h.clock.advance(1);
    expect(await h.app.blackjack.sweepIdle()).toEqual([tableId]);
  });

  it('a Hold’em table assigned to a due event gets the same bounded idle exemption', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const event = h.app.events.create(organizer, { ...eventInput(h), game: 'poker' });
    const table = await h.app.poker.create({ guildId: h.guildId, userId: host.id, name: host.name, buyIn: 200 });
    await h.bot.createTablePanel(table.record.id, h.casino, host.id);
    h.app.events.assign(organizer, event.id, event.revision, table.record.id);
    h.clock.advance(60 * MIN + EVENT_TABLE_GRACE_MS - 1);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(table.record.id)).toBeDefined();
    h.clock.advance(1);
    await h.app.poker.sweepIdle();
    expect(h.app.poker.peek(table.record.id)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, host.id).reserved).toBe(0);
  });

  it('concurrent registrations never exceed capacity; a double click registers once (verified)', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const event = h.app.events.create(actor(h, host, true), eventInput(h, { maxPlayers: 2 }));
    const players = ['A', 'B', 'C'].map((name) => player(h, name));
    const anchors = await Promise.all(players.map((p) => anchor(h, p)));
    const recs = players.flatMap((p, i) => [h.fd.clickRaw(p, anchors[i]!, `evt:join:${event.id}`), h.fd.clickRaw(p, anchors[i]!, `evt:join:${event.id}`)]);
    await h.settle();
    expect(h.app.events.registrations(event)).toHaveLength(2);
    expect(recs.some((r) => /full/i.test(h.text(h.seen(r))))).toBe(true);
  });

  it('a private event is unreachable without the invite code, and its table still needs the table code (verified)', async () => {
    const h = harness({ allowThreads: true });
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const [guest, outsider] = [player(h, 'Guest'), player(h, 'Outsider')];
    const event = h.app.events.create(organizer, eventInput(h, { private: true, startsAt: h.clock.now() + MIN }));
    const outsiderAnchor = await anchor(h, outsider);
    for (const customId of [`evt:open:${event.id}`, `evt:join:${event.id}`, `evt:leave:${event.id}`]) {
      const rec = await press(h, outsider, outsiderAnchor, customId);
      expect(h.text(h.seen(rec))).toMatch(/invitation code/i);
    }
    h.app.events.joinWithCode(actor(h, guest), event.access_code!, 'Guest');
    h.app.events.joinWithCode(actor(h, player(h, 'Guest 2')), event.access_code!, 'Guest 2');
    const tableId = await openTable(h, host, true);
    h.app.events.assign(organizer, event.id, event.revision, tableId);
    await h.advance(MIN);
    await h.app.blackjack.setSittingOut(tableId, host.id, true);
    const ready = h.app.events.view(organizer, event.id);
    h.app.events.manageAction(organizer, event.id, ready.revision, 'start');
    // The registered guest sees the table code; the outsider pressing the same seat control by id
    // only gets the access-code modal, and a wrong code is refused.
    const guestView = await press(h, guest, await anchor(h, guest), `evt:open:${event.id}`);
    expect(h.text(h.seen(guestView))).toContain(h.app.blackjack.peek(tableId)!.record.accessCode!);
    const opener = await press(h, outsider, outsiderAnchor, `tbl:join:${tableId}`);
    expect(opener.modal).not.toBeNull();
    await h.submit(outsider, opener, { code: 'WRONG' });
    expect(h.app.blackjack.tableOfUser(h.guildId, outsider.id)).toBeUndefined();
  });

  it('organizer-role members manage only their own events; server managers manage all (verified, via the router)', async () => {
    const h = harness();
    const roleId = '123456789012345678';
    h.app.settings.set(h.guildId, 'eventOrganizerRole', roleId);
    const guild = h.bot.client.guilds.cache.get(h.guildId)!;
    (guild.roles as unknown as { _add(data: unknown): unknown })._add({ id: roleId, name: 'Organizer', permissions: '0', position: 1, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 });
    const [first, second, member] = [player(h, 'First'), player(h, 'Second'), player(h, 'Member')];
    const admin = player(h, 'Admin', true);
    const organizers = new Set([first.id, second.id]);
    const memberJson = h.fd.memberJson.bind(h.fd);
    h.fd.memberJson = (u) => ({ ...memberJson(u), roles: organizers.has(u.id) ? [roleId] : [] });
    expect((await press(h, first, await anchor(h, first), 'evt:create')).modal).not.toBeNull();
    expect((await press(h, member, await anchor(h, member), 'evt:create')).modal).toBeNull();
    const event = h.app.events.create({ ...actor(h, first), canOrganizeEvents: true }, eventInput(h));
    await press(h, second, await anchor(h, second), `evt:cancel:${event.id}:${event.revision}`);
    expect(h.app.events.view(actor(h, admin, true), event.id).state).toBe('scheduled');
    await press(h, admin, await anchor(h, admin), `evt:cancel:${event.id}:${event.revision}`);
    expect(h.app.events.view(actor(h, admin, true), event.id).state).toBe('cancelled');
  });

  it('recovery detaches an event table that was closed while the bot was down (verified)', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const organizer = actor(h, host, true);
    const event = h.app.events.create(organizer, eventInput(h));
    const tableId = await openTable(h, host);
    h.app.events.assign(organizer, event.id, event.revision, tableId);
    h.db.run("UPDATE game_tables SET status = 'closed' WHERE id = ?", [tableId]);
    h.app.events.recover();
    expect(h.app.events.view(organizer, event.id).table_id).toBeNull();
  });
});
