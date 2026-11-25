/**
 * Casino events open their own table: configured from the event, opened by the maintenance sweep
 * 15 minutes before the start (or early by the organizer), joined with one click by registered
 * players, closed with refunds on cancellation, and never duplicated across restarts.
 * Players act through the router (buttons, selects, modals) wherever Discord would let them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_TABLE_GRACE_MS, EVENT_TABLE_LEAD_MS, type CasinoEvent, type EventActor } from '../../src/domain/casino-events.js';
import { openDueEventTables, seatAtEventTable } from '../../src/discord/event-tables.js';
import { CasinoHarness, type HarnessOptions } from '../harness/casino-harness.js';
import type { FakeMessage, FakeUser } from '../harness/fake-discord.js';

const MIN = 60_000;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function harness(options: HarnessOptions = {}): CasinoHarness {
  const h = new CasinoHarness(options);
  cleanup.push(() => h.close());
  return h;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'casino-event-tables-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'casino.db');
}

function player(h: CasinoHarness, name: string, admin = false): FakeUser {
  const user = h.user(name, admin);
  h.app.economy.ensurePlayer(h.guildId, user.id, name);
  return user;
}

function actor(h: CasinoHarness, user: FakeUser | string, isAdmin = false): EventActor {
  return { guildId: h.guildId, userId: typeof user === 'string' ? user : user.id, isAdmin };
}

function schedule(h: CasinoHarness, organizer: EventActor, overrides: Partial<{ game: 'blackjack' | 'poker'; startsAt: number; minPlayers: number; maxPlayers: number; private: boolean }> = {}): CasinoEvent {
  return h.app.events.create(organizer, {
    title: 'Friday Night', description: '', game: 'blackjack', startsAt: h.clock.now() + 60 * MIN, minPlayers: 2, maxPlayers: 4, private: false, ...overrides,
  });
}

function register(h: CasinoHarness, event: CasinoEvent, ...users: FakeUser[]): void {
  for (const user of users) h.app.events.join(actor(h, user), event.id, user.name, event.access_code ?? undefined);
}

/** One maintenance pass, as the bot runs it every minute. */
async function sweep(h: CasinoHarness): Promise<void> {
  await (h.bot as unknown as { maintenance(): Promise<void> }).maintenance();
  await h.settle();
}

/** The event's details as this user sees them, opened from their /casino panel. */
async function details(h: CasinoHarness, user: FakeUser, event: CasinoEvent): Promise<FakeMessage> {
  const anchor = h.seen(await h.slash(user, 'casino'))!;
  h.fd.clickRaw(user, anchor, `evt:open:${event.id}`);
  await h.settle();
  return anchor;
}

function current(h: CasinoHarness, event: CasinoEvent): CasinoEvent {
  return h.app.events.find(h.guildId, event.id)!;
}

function openTables(h: CasinoHarness) {
  return [...h.app.blackjack.openTables(h.guildId).map((t) => t.record), ...h.app.poker.openTables(h.guildId).map((t) => t.record)];
}

describe('event tables', () => {
  it('an organizer creates an event and configures its table from the event itself', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const home = h.seen(await h.slash(host, 'casino'))!;
    const list = h.seen(await h.click(host, home, 'Events'))!;
    const editor = await h.click(host, list, 'Create event');
    const at = new Date(h.clock.now() + 120 * MIN).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    const shown = h.seen(await h.submit(host, editor, { title: 'Friday Blackjack', time: at, capacity: '2-4', format: ['blackjack-public'] }))!;
    expect(h.text(shown)).toContain('5 seats · bets 10–500');
    const event = h.app.events.upcoming(h.guildId)[0]!;
    // Too few seats for four players, and bets outside the server range, are refused.
    const tooSmall = await h.submit(host, await h.click(host, shown, 'Table settings'), { seats: '3', min: '25', max: '250' });
    expect(h.text(h.seen(tooSmall))).toMatch(/every registered player needs one/);
    const tooHigh = await h.submit(host, await h.click(host, shown, 'Table settings'), { seats: '4', min: '25', max: '900' });
    expect(h.text(h.seen(tooHigh))).toMatch(/server range/);
    const saved = await h.submit(host, await h.click(host, shown, 'Table settings'), { seats: '4', min: '25', max: '250' });
    expect(h.text(h.seen(saved))).toContain('4 seats · bets 25–250');
    expect(h.app.events.tableConfig(current(h, event))).toEqual({ game: 'blackjack', seats: 4, minBet: 25, maxBet: 250 });
    // Hold'em: seats and the organizer's own buy-in; blinds and the buy-in range are the server's.
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const poker = schedule(h, actor(h, host, true), { game: 'poker', maxPlayers: 3 });
    const pokerView = await details(h, host, poker);
    const pokerModal = await h.click(host, pokerView, 'Table settings');
    expect(JSON.stringify(pokerModal.modal)).toContain('blinds 5/10');
    await h.submit(host, pokerModal, { seats: '4', buyin: '250' });
    expect(h.app.events.tableConfig(current(h, poker))).toEqual({ game: 'poker', seats: 4, buyIn: 250 });
    expect(h.fd.problems).toEqual([]);
  });

  it('the sweep opens the configured table 15 minutes before the start, once enough players registered', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const organizer = actor(h, host, true);
    const event = schedule(h, organizer, { maxPlayers: 3 });
    h.app.events.configureTable(organizer, event.id, event.revision, { game: 'blackjack', seats: 4, minBet: 20, maxBet: 200 });
    register(h, event, alice);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS - 1);
    await sweep(h);
    expect(openTables(h)).toEqual([]);
    h.clock.advance(1);
    await sweep(h);
    expect(openTables(h)).toEqual([]); // inside the window, but one player short
    expect(h.text(await details(h, alice, event))).toContain('Opens as soon as 1 more player registers');
    register(h, event, bob);
    await sweep(h);
    const [table] = h.app.blackjack.openTables(h.guildId);
    expect(table!.record).toMatchObject({ name: 'Friday Night', ownerId: host.id, config: { maxSeats: 4, minBet: 20, maxBet: 200 } });
    expect(current(h, event)).toMatchObject({ table_id: table!.record.id, opened_table_id: table!.record.id });
    // A spare seat (4 seats, 3 players): the organizer keeps the host seat.
    expect(table!.state.seats.map((s) => s.userId)).toEqual([host.id]);
    // Registered players get one click to a seat; the table survives idle sweeps until the start.
    const view = await details(h, alice, event);
    expect(h.text(view)).toContain('is open');
    const seated = h.seen(await h.click(alice, view, 'Join the table'))!;
    expect(h.buttons(seated).find((b) => b.label === 'Go to the table')?.style).toBe(5);
    expect(h.app.blackjack.tableOfUser(h.guildId, alice.id)?.record.id).toBe(table!.record.id);
    // Registration is what seated her: withdrawing while seated is refused, so a seat never
    // outlives its registration.
    const withdraw = await h.click(alice, await details(h, alice, event), 'Withdraw');
    expect(h.text(h.seen(withdraw))).toMatch(/Leave the table first/);
    expect(h.app.events.registered(event.id, alice.id)).toBe(true);
    h.clock.advance(EVENT_TABLE_LEAD_MS);
    await sweep(h);
    expect(h.app.blackjack.peek(table!.record.id)).toBeDefined();
    expect(openTables(h)).toHaveLength(1);
    expect(h.fd.problems).toEqual([]);
    expect(h.guard!.blockedCount).toBe(0);
  });

  it('the organizer can open the table early and start before the scheduled time', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { startsAt: h.clock.now() + 3 * 60 * MIN, maxPlayers: 2 });
    register(h, event, alice, bob);
    const view = await details(h, host, event);
    expect(h.buttons(view).find((b) => b.label === 'Start event')?.disabled).toBe(true);
    await h.click(host, view, 'Open table now');
    const [table] = h.app.blackjack.openTables(h.guildId);
    expect(table).toBeDefined();
    // Five seats for two players leave a spare seat: the organizer hosts and keeps it.
    expect(table!.record.ownerId).toBe(host.id);
    await h.click(host, view, 'Start event');
    expect(current(h, event).state).toBe('in_progress');
    expect(h.text(view)).toContain('In progress');
    // The scheduled time passing changes nothing, and nothing opens twice.
    h.clock.advance(3 * 60 * MIN);
    h.scheduler.runDue();
    await sweep(h);
    expect(openTables(h)).toHaveLength(1);
  });

  it('an unregistered organizer’s seat is released so every registered player of a full event can sit', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const seats = h.app.settings.get(h.guildId).blackjack.maxSeats;
    const players = Array.from({ length: seats }, (_, i) => player(h, `P${i + 1}`));
    const event = schedule(h, actor(h, host, true), { maxPlayers: seats });
    register(h, event, ...players);
    expect(() => h.app.events.join(actor(h, player(h, 'Late')), event.id, 'Late')).toThrow(/full/);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    const tableId = current(h, event).table_id!;
    expect(h.app.blackjack.peek(tableId)!.state.seats).toEqual([]);
    for (const p of players) await h.click(p, await details(h, p, event), 'Join the table');
    expect(h.app.blackjack.peek(tableId)!.state.seats).toHaveLength(seats);
    // The organizer is not registered and every seat is a player's: no seat for them.
    expect(h.app.events.maySit(current(h, event), host.id)).toBe(false);
  });

  it('a private event: registration is the access, guests join the private thread, the table code is never shown', async () => {
    const h = harness({ allowThreads: true });
    const host = player(h, 'Host', true);
    const [guest, outsider] = [player(h, 'Guest'), player(h, 'Outsider')];
    const event = schedule(h, actor(h, host, true), { private: true, maxPlayers: 3 });
    // The guest registers with the event's invitation code, through the router.
    const anchor = h.seen(await h.slash(guest, 'casino'))!;
    await h.click(guest, anchor, 'Events');
    const invite = await h.click(guest, anchor, 'Use invitation code');
    await h.submit(guest, invite, { code: event.access_code! });
    register(h, event, player(h, 'Second'));
    expect(h.app.events.registered(event.id, guest.id)).toBe(true);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    const record = h.app.blackjack.peek(current(h, event).table_id!)!.record;
    expect(record.isPrivate).toBe(true);
    expect(record.threadId).toBeTruthy();
    const view = await details(h, guest, event);
    expect(h.text(view)).not.toContain(record.accessCode!);
    const seated = h.seen(await h.click(guest, view, 'Join the table'))!;
    expect(h.text(seated)).not.toContain(record.accessCode!);
    expect(h.app.blackjack.tableOfUser(h.guildId, guest.id)?.record.id).toBe(record.id);
    const added = h.fd.log.find((r) => r.method === 'PUT' && r.route === `/channels/${record.threadId}/thread-members/${guest.id}`);
    expect(added?.status).toBe(204);
    // Someone without a registration gets nothing from the event's seat control.
    const refused = h.fd.clickRaw(outsider, h.seen(await h.slash(outsider, 'casino'))!, `evt:seat:${event.id}`);
    await h.settle();
    expect(h.text(h.seen(refused))).toMatch(/invitation code/i);
    expect(h.app.blackjack.tableOfUser(h.guildId, outsider.id)).toBeUndefined();
    expect(h.fd.log.some((r) => r.route.endsWith(`/thread-members/${outsider.id}`))).toBe(false);
    // Nothing about the private table was posted publicly.
    expect(h.fd.channelMessages(h.casino).some((m) => h.text(m).includes(record.accessCode!))).toBe(false);
    expect(h.guard!.blocked).toEqual([]);
  });

  it('cancelling closes the event’s Blackjack table and refunds open bets', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { maxPlayers: 2 });
    register(h, event, alice, bob);
    const view = await details(h, host, event);
    await h.click(host, view, 'Open table now');
    const tableId = current(h, event).table_id!;
    await h.click(alice, await details(h, alice, event), 'Join the table');
    const before = h.app.economy.getWallet(h.guildId, alice.id);
    await h.app.blackjack.placeBet(tableId, alice.id, 50, alice.name);
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(50);
    await h.click(host, await details(h, host, event), 'Cancel event');
    expect(current(h, event).state).toBe('cancelled');
    expect(h.app.blackjack.peek(tableId)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, alice.id)).toMatchObject({ balance: before.balance, reserved: 0 });
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('a Hold’em event never takes a buy-in on its own: the organizer opens it with theirs; cancelling returns every stack', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const host = player(h, 'Host', true);
    const guest = player(h, 'Guest');
    const organizer = actor(h, host, true);
    const event = schedule(h, organizer, { game: 'poker', maxPlayers: 3 });
    h.app.events.configureTable(organizer, event.id, event.revision, { game: 'poker', seats: 4, buyIn: 200 });
    register(h, event, guest);
    h.app.events.join(organizer, event.id, host.name);
    const [hostBefore, guestBefore] = [h.balance(host), h.balance(guest)];
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    // Registering is not a game-entry action: the sweep reserves nobody's chips.
    expect(openTables(h)).toEqual([]);
    expect(current(h, event).table_note).toMatch(/own wallet/);
    expect(h.app.economy.getWallet(h.guildId, host.id)).toMatchObject({ balance: hostBefore, reserved: 0 });
    const opening = await h.click(host, await details(h, host, event), 'Open table now');
    expect(JSON.stringify(opening.modal)).toContain('"value":"200"'); // the buy-in set in the table settings
    await h.submit(host, opening, { buyin: '200' });
    const table = h.app.poker.peek(current(h, event).table_id!)!;
    expect(table.state.seats.map((s) => [s.userId, s.stack])).toEqual([[host.id, 200]]);
    expect(table.record).toMatchObject({ ownerId: host.id, config: { maxSeats: 4 } });
    const opener = await h.click(guest, await details(h, guest, event), 'Join the table');
    expect(opener.modal).not.toBeNull();
    expect(JSON.stringify(opener.modal)).not.toMatch(/access code/i);
    await h.submit(guest, opener, { buyin: '150' });
    expect(h.app.poker.peek(table.record.id)!.state.seats.map((s) => s.stack)).toEqual([200, 150]);
    await h.click(host, await details(h, host, event), 'Cancel event');
    expect(h.app.poker.peek(table.record.id)).toBeUndefined();
    expect([h.balance(host), h.balance(guest)]).toEqual([hostBefore, guestBefore]);
    expect(h.app.economy.getWallet(h.guildId, guest.id).reserved).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  it('a Hold’em event without a registered organizer opens when the first registered player takes a seat', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { game: 'poker', maxPlayers: 3 });
    register(h, event, alice, bob);
    // Before the window a registered player cannot open it yet.
    expect(h.buttons(await details(h, alice, event)).some((b) => b.label === 'Join the table')).toBe(false);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    expect(openTables(h)).toEqual([]);
    expect(current(h, event).table_note).toMatch(/first registered player takes a seat/);
    const opener = await h.click(alice, await details(h, alice, event), 'Join the table');
    await h.submit(alice, opener, { buyin: '120' });
    const table = h.app.poker.peek(current(h, event).table_id!)!;
    expect(table.record.ownerId).toBe(alice.id);
    expect(table.state.seats.map((s) => [s.userId, s.stack])).toEqual([[alice.id, 120]]);
    const second = await h.click(bob, await details(h, bob, event), 'Join the table');
    await h.submit(bob, second, { buyin: '100' });
    expect(h.app.poker.peek(table.record.id)!.state.seats).toHaveLength(2);
    expect(openTables(h)).toHaveLength(1);
  });

  it('a registered player seated at another table gets the way back or out, then joins', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { maxPlayers: 2 });
    register(h, event, alice, bob);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    const other = await h.app.blackjack.createTable({ guildId: h.guildId, ownerId: bob.id, ownerName: bob.name, name: 'Side Game' });
    await h.bot.createTablePanel(other.record.id, h.casino, bob.id);
    const tableId = current(h, event).table_id!;
    const view = await details(h, bob, event);
    const conflict = h.seen(await h.click(bob, view, 'Join the table'))!;
    expect(h.text(conflict)).toContain('You already have a seat');
    expect(h.text(conflict)).toContain('Side Game');
    expect(h.buttons(conflict).find((b) => b.label === 'Return to Side Game')?.style).toBe(5);
    await h.click(bob, conflict, 'Leave Side Game');
    await h.click(bob, await details(h, bob, event), 'Join the table');
    expect(h.app.blackjack.tableOfUser(h.guildId, bob.id)?.record.id).toBe(tableId);
  });

  it('a missing organizer does not block the table: a free registered player opens it, nobody is held at it', async () => {
    const h = harness();
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    // The organizer left the server (Discord no longer knows them as a member).
    const event = schedule(h, actor(h, '999999999999999999', true), { maxPlayers: 2 });
    register(h, event, alice, bob);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    const table = h.app.blackjack.peek(current(h, event).table_id!)!;
    expect(table.state.seats).toEqual([]);
    await h.click(bob, await details(h, bob, event), 'Join the table');
    expect(h.app.blackjack.peek(table.record.id)!.state.seats.map((s) => s.userId)).toEqual([bob.id]);
    expect(h.app.blackjack.peek(table.record.id)!.record.ownerId).toBe(bob.id); // the first to sit hosts
  });

  it('an event still short of players is called off 30 minutes after the start and its table closes', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const alice = player(h, 'Alice');
    const event = schedule(h, actor(h, host, true), { maxPlayers: 2 });
    register(h, event, alice);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    expect(openTables(h)).toEqual([]);
    // The organizer opens it anyway; Alice plays while waiting for a second player.
    await h.click(host, await details(h, host, event), 'Open table now');
    const tableId = current(h, event).table_id!;
    await h.click(alice, await details(h, alice, event), 'Join the table');
    await h.advance(EVENT_TABLE_LEAD_MS); // the start: still one player short
    expect(current(h, event).state).toBe('awaiting');
    await h.app.blackjack.placeBet(tableId, alice.id, 25, alice.name);
    h.clock.advance(EVENT_TABLE_GRACE_MS);
    await sweep(h);
    expect(current(h, event)).toMatchObject({ state: 'cancelled', table_note: expect.stringMatching(/not enough players/) });
    expect(h.app.blackjack.peek(tableId)).toBeUndefined();
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(0);
    expect(h.text(await details(h, alice, event))).toContain('not enough players');
  });

  it('a table Discord refuses is closed with refunds and not retried by the sweep', async () => {
    const h = harness({ allowThreads: true });
    const host = player(h, 'Host', true);
    const event = schedule(h, actor(h, host, true), { private: true, maxPlayers: 2 });
    register(h, event, player(h, 'Alice'), player(h, 'Bob'));
    let attempts = 0;
    h.fd.fault = (method, route) => {
      if (method !== 'POST' || !route.endsWith('/threads')) return null;
      attempts++;
      return { status: 403, body: { code: 50013, message: 'Missing Permissions' } };
    };
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    expect(attempts).toBe(1);
    expect(openTables(h)).toEqual([]);
    expect(current(h, event)).toMatchObject({ table_id: null, state: 'scheduled', table_note: expect.stringMatching(/Discord refused/) });
    await sweep(h);
    expect(attempts).toBe(1);
    // Fixed permissions: the organizer opens it again by hand.
    h.fd.fault = null;
    await h.click(host, await details(h, host, event), 'Open table now');
    expect(openTables(h)).toHaveLength(1);
  });

  it('restarts neither lose a due table nor open a second one', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const host = player(first, 'Host', true);
    const event = schedule(first, actor(first, host, true), { maxPlayers: 2 });
    register(first, event, player(first, 'Alice'), player(first, 'Bob'));
    // The bot is down while the table comes due; startup opens it.
    first.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS + 5 * MIN);
    const second = new CasinoHarness({ discord: first.fd, dbPath, clock: first.clock });
    cleanup.push(async () => {
      second.db.close();
      await second.bot.client.destroy();
    });
    await second.boot();
    const tables = openTables(second);
    expect(tables).toHaveLength(1);
    await sweep(second);
    expect(openTables(second).map((t) => t.id)).toEqual([tables[0]!.id]);
    // Crash again: the same table comes back, still the event's, and nothing new opens.
    const messages = first.fd.channelMessages(first.casino).length;
    const third = new CasinoHarness({ discord: first.fd, dbPath, clock: first.clock });
    cleanup.push(() => third.close());
    await third.boot();
    await sweep(third);
    expect(openTables(third).map((t) => t.id)).toEqual([tables[0]!.id]);
    expect(third.app.events.find(third.guildId, event.id)!.table_id).toBe(tables[0]!.id);
    expect(third.fd.channelMessages(third.casino).length).toBe(messages);
    expect(third.fd.problems).toEqual([]);
  });

  it('overlapping sweeps and a simultaneous seat click open exactly one table', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { maxPlayers: 3 });
    register(h, event, alice, bob);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    // Startup's sweep, the minute sweep and Alice's click all race for the same due table.
    const [, , seat] = await Promise.all([
      openDueEventTables(h.app, h.bot),
      openDueEventTables(h.app, h.bot),
      seatAtEventTable(h.app, h.bot, { ...actor(h, alice), displayName: alice.name }, event.id),
    ]);
    await h.settle();
    expect(openTables(h)).toHaveLength(1);
    expect(seat.tableId).toBe(openTables(h)[0]!.id);
    expect(h.app.blackjack.tableOfUser(h.guildId, alice.id)?.record.id).toBe(seat.tableId);
    expect(h.fd.problems).toEqual([]);
  });

  it('a crash between creating the table and showing it resumes that table on startup', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const host = player(first, 'Host', true);
    const event = schedule(first, actor(first, host, true), { maxPlayers: 2 });
    register(first, event, player(first, 'Alice'), player(first, 'Bob'));
    first.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    // What the keeper does before Discord is asked: the service creates it, the event links it.
    const table = await first.app.blackjack.createTable({ guildId: first.guildId, ownerId: host.id, ownerName: host.name, name: 'Friday Night' });
    first.app.events.linkOpenedTable(first.guildId, event.id, table.record.id);
    const second = new CasinoHarness({ discord: first.fd, dbPath, clock: first.clock });
    cleanup.push(() => second.close());
    await second.boot();
    await sweep(second);
    expect(openTables(second).map((t) => t.id)).toEqual([table.record.id]);
    expect(second.app.blackjack.peek(table.record.id)!.record.messageId).toBeTruthy();
    expect(second.app.events.find(second.guildId, event.id)!.table_id).toBe(table.record.id);
  });

  it('a played event nobody started is completed once its table closes after the start window', async () => {
    const h = harness();
    const host = player(h, 'Host', true);
    const [alice, bob] = [player(h, 'Alice'), player(h, 'Bob')];
    const event = schedule(h, actor(h, host, true), { maxPlayers: 2 });
    register(h, event, alice, bob);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    const tableId = current(h, event).table_id!;
    await h.advance(EVENT_TABLE_LEAD_MS); // the start: ready, but the organizer never presses Start
    expect(current(h, event).state).toBe('ready');
    h.clock.advance(EVENT_TABLE_GRACE_MS);
    await sweep(h); // the idle hold ends: the table closes, and the event is settled
    expect(h.app.blackjack.peek(tableId)).toBeUndefined();
    expect(current(h, event).state).toBe('completed');
    expect(h.app.events.upcoming(h.guildId)).toEqual([]);
  });

  it('a private Hold’em guest joins through the event with a buy-in and is added to the private thread', async () => {
    const h = harness({ allowThreads: true });
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const host = player(h, 'Host', true);
    const guest = player(h, 'Guest');
    const organizer = actor(h, host, true);
    const event = schedule(h, organizer, { game: 'poker', private: true, maxPlayers: 3 });
    register(h, event, guest);
    h.app.events.join(organizer, event.id, host.name);
    h.clock.advance(60 * MIN - EVENT_TABLE_LEAD_MS);
    await sweep(h);
    await h.submit(host, await h.click(host, await details(h, host, event), 'Join the table'), { buyin: '200' });
    const record = h.app.poker.peek(current(h, event).table_id!)!.record;
    expect(record).toMatchObject({ isPrivate: true, ownerId: host.id });
    const opener = await h.click(guest, await details(h, guest, event), 'Join the table');
    const seated = h.seen(await h.submit(guest, opener, { buyin: '100' }))!;
    expect(h.text(seated)).not.toContain(record.accessCode!);
    expect(h.app.poker.tableOfUser(h.guildId, guest.id)?.record.id).toBe(record.id);
    const added = h.fd.log.find((r) => r.method === 'PUT' && r.route === `/channels/${record.threadId}/thread-members/${guest.id}`);
    expect(added?.status).toBe(204);
    expect(h.guard!.blocked).toEqual([]);
  });
});
