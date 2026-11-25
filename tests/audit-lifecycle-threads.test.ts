/**
 * Audit: table thread creation. Private tables must never become visible in the casino channel,
 * and a failed creation must leave nothing behind (DB rows, seats, escrows, threads, notices).
 *
 * Tests marked "Fixed bug" were written as failing reproductions during the lifecycle audit and
 * now guard the fixes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from './harness/casino-harness.js';
import type { FakeUser } from './harness/fake-discord.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function harness(options: ConstructorParameters<typeof CasinoHarness>[0] = {}): CasinoHarness {
  const h = new CasinoHarness({ allowThreads: true, ...options });
  cleanup.push(() => h.close());
  return h;
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'casino-audit-threads-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'casino.db');
}

const refused = { status: 403, body: { code: 50013, message: 'Missing Permissions' } };

/** Any message the user can press a (raw) control on: the reply to /casino in that channel. */
async function anchor(h: CasinoHarness, user: FakeUser, channelId = h.casino) {
  const message = h.seen(await h.slash(user, 'casino', {}, channelId));
  if (!message) throw new Error('no /casino reply');
  return message;
}

/**
 * Open a blackjack table through the real router path (tbl:create → create modal → openTable →
 * createTablePanel, with its close-on-failure handling). The custom id is pressed directly so the
 * test does not depend on the Home/Games navigation, which is being redesigned concurrently.
 */
async function openBlackjack(h: CasinoHarness, user: FakeUser, visibility: 'public' | 'private', channelId = h.casino) {
  const opener = h.fd.clickRaw(user, await anchor(h, user, channelId), 'tbl:create');
  await h.settle();
  return h.submit(user, opener, { visibility: [visibility] });
}

/** Public messages in a channel that are table panels (carry blackjack or Hold'em controls). */
function panelsIn(h: CasinoHarness, channelId: string) {
  return h.fd.channelMessages(channelId).filter((m) => h.buttons(m).some((b) => /^(bj|pk):/.test(b.custom_id ?? '')));
}

function openRows(h: CasinoHarness) {
  return h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_tables WHERE status = 'open'")!.n;
}

describe('audit: private tables and thread creation', () => {
  // Fixed bug (was bot.ts createTablePanel): when Discord refuses the private thread, the catch
  // block only rethrows for Hold'em; private Blackjack logs a warning and posts its panel with
  // `(thread ?? channel).send(...)` straight into #casino, visible to everyone.
  it('private Blackjack is refused (not posted in #casino) when the private thread cannot be created', async () => {
    const h = harness();
    const alice = h.user('Alice');
    h.fd.fault = (method, route) => (method === 'POST' && route === `/channels/${h.casino}/threads` ? refused : null);
    await openBlackjack(h, alice, 'private');
    expect(panelsIn(h, h.casino)).toHaveLength(0);
    expect(h.app.blackjack.tableOfUser(h.guildId, alice.id)).toBeUndefined();
    expect(openRows(h)).toBe(0);
  });

  // Fixed bug (was same root cause, second trigger): with `tables.useThreads` off (or in test mode
  // without allowThreads) Hold'em throws 'Private Hold’em needs verified private threads.', but
  // private Blackjack is posted in the channel.
  it('private Blackjack is refused when tables.useThreads is off', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'tables.useThreads', false);
    const alice = h.user('Alice');
    const opened = await openBlackjack(h, alice, 'private');
    expect(h.text(h.seen(opened))).toMatch(/private threads/i); // a clear, private explanation
    expect(h.seen(opened)?.forUser).toBe(alice.id);
    expect(panelsIn(h, h.casino)).toHaveLength(0);
    expect(openRows(h)).toBe(0);
  });

  it('without a configured casino channel no table opens anywhere, and the player is told why', async () => {
    const h = harness({ guard: false }); // production mode, /casinoadmin setup never run
    const alice = h.user('Alice');
    const opened = await openBlackjack(h, alice, 'public', h.general);
    expect(h.text(h.seen(opened))).toMatch(/casinoadmin setup/);
    expect(openRows(h)).toBe(0);
    expect([...h.fd.channels.values()].filter((c) => c.parentId !== null)).toHaveLength(0); // no thread under #general
    expect(panelsIn(h, h.general)).toHaveLength(0);
  });

  it('private Hold’em is refused, refunded and leaves no rows when the private thread cannot be created (verified)', async () => {
    const h = harness();
    h.app.settings.set(h.guildId, 'poker.enabled', true);
    const alice = h.user('Alice');
    h.fd.fault = (method, route) => (method === 'POST' && route === `/channels/${h.casino}/threads` ? refused : null);
    const creation = h.fd.clickRaw(alice, await anchor(h, alice), 'pk:create');
    await h.settle();
    const opened = await h.submit(alice, creation, { name: 'Back Room', visibility: ['private'], seats: '6', buyin: '200' });
    expect(h.text(h.seen(opened))).toMatch(/could not be opened/);
    expect(panelsIn(h, h.casino)).toHaveLength(0);
    expect(openRows(h)).toBe(0);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM table_seats')!.n).toBe(0);
    expect(h.app.economy.getWallet(h.guildId, alice.id).reserved).toBe(0);
    expect(h.app.economy.reconcile()).toEqual([]);
  });

  // Fixed bug (was third trigger, bot.ts recreateTablePanel → createTablePanel): a private table
  // whose thread disappeared while the bot was down is re-homed on boot. If the new private
  // thread cannot be created, the panel is posted in #casino.
  it('a private Blackjack table whose thread vanished is not re-posted publicly on restart', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ allowThreads: true, dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const alice = first.user('Alice');
    await openBlackjack(first, alice, 'private');
    const record = first.app.blackjack.tableOfUser(first.guildId, alice.id)!.record;
    expect(first.fd.channels.get(record.threadId!)?.type).toBe(12);
    first.fd.channels.delete(record.threadId!); // deleted by a moderator while the bot was offline
    const second = harness({ discord: first.fd, dbPath, clock: first.clock });
    second.fd.fault = (method, route) => (method === 'POST' && route === `/channels/${second.casino}/threads` ? refused : null);
    await second.boot();
    expect(panelsIn(second, second.casino)).toHaveLength(0);
  });

  // Fixed bug (was bot.ts recreateTablePanel): when a private Blackjack table is re-homed into a
  // NEW private thread, only the owner is added (createTablePanel adds `creatorId`). Seated
  // guests are never re-added (recreatePokerPanel does this for Hold'em), so they lose access to
  // a table they are seated at.
  it('re-homing a private Blackjack table re-adds every seated player to the new private thread', async () => {
    const dbPath = tempDb();
    const first = new CasinoHarness({ allowThreads: true, dbPath });
    cleanup.push(async () => {
      first.db.close();
      await first.bot.client.destroy();
    });
    const [alice, bob] = [first.user('Alice'), first.user('Bob')];
    await openBlackjack(first, alice, 'private');
    const record = first.app.blackjack.tableOfUser(first.guildId, alice.id)!.record;
    await first.app.blackjack.join(record.id, bob.id, 'Bob', record.accessCode!);
    first.fd.channels.delete(record.threadId!);
    const second = harness({ discord: first.fd, dbPath, clock: first.clock });
    second.fd.log.length = 0;
    await second.boot();
    const moved = second.app.blackjack.peek(record.id)!.record;
    expect(moved.threadId).not.toBe(record.threadId);
    expect(second.fd.channels.get(moved.threadId!)?.type).toBe(12);
    const added = (userId: string) => second.fd.log.some((r) => r.method === 'PUT' && r.route === `/channels/${moved.threadId}/thread-members/${userId}`);
    expect(added(alice.id)).toBe(true);
    expect(added(bob.id)).toBe(true);
  });

  // Fixed bug (was bot.ts createTablePanel catch block): if the panel cannot be posted after the
  // public thread was created, the thread is only archived (not locked) and the bot's own
  // "started a thread" notice stays in #casino, because removeThreadNotice is only called on the
  // success path.
  it('a failed panel post leaves no thread notice in #casino and no unlocked thread behind', async () => {
    const h = harness();
    const alice = h.user('Alice');
    h.fd.fault = (method, route) => {
      const target = /^\/channels\/(\d+)\/messages$/.exec(route)?.[1];
      return method === 'POST' && target && h.fd.channels.get(target)?.parentId === h.casino ? refused : null;
    };
    const opened = await openBlackjack(h, alice, 'public');
    expect(h.text(h.seen(opened))).toMatch(/couldn't create the table/);
    expect(openRows(h)).toBe(0);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM table_seats')!.n).toBe(0);
    expect(h.fd.channelMessages(h.casino).filter((m) => m.type === 18)).toHaveLength(0); // the bot's thread-created notice is gone too
    // Any thread that still exists (deleting it is an equally valid fix) must be locked and archived.
    const threads = [...h.fd.channels.values()].filter((c) => c.parentId === h.casino);
    expect(threads.every((t) => t.archived && t.locked)).toBe(true);
  });

  it('a table opened from #general is created under the configured lobby channel (verified, production mode)', async () => {
    const h = harness({ guard: false });
    const admin = h.user('Admin', true);
    await h.slash(admin, 'casinoadmin', { subcommand: 'setup' });
    const alice = h.user('Alice');
    await openBlackjack(h, alice, 'public', h.general);
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    expect(record.channelId).toBe(h.casino);
    expect(h.fd.channels.get(record.threadId!)?.parentId).toBe(h.casino);
    expect(panelsIn(h, h.general)).toHaveLength(0);
  });

  // Fixed bug (was bot.ts createTablePanel, `thread.members.add(creatorId).catch(() => undefined)`
  // for Blackjack): if the host cannot be added to the new private thread the table still opens,
  // so the host is seated at a table they cannot see. Hold'em adds the creator before posting and
  // fails the creation instead.
  it('a private Blackjack table is not opened when its host cannot be added to the private thread', async () => {
    const h = harness();
    const alice = h.user('Alice');
    h.fd.fault = (method, route) => (method === 'PUT' && /^\/channels\/\d+\/thread-members\//.test(route) ? refused : null);
    await openBlackjack(h, alice, 'private');
    expect(h.app.blackjack.tableOfUser(h.guildId, alice.id)).toBeUndefined();
    expect(openRows(h)).toBe(0);
  });

  // Fixed bug (was bot.ts addToTableThread: Blackjack swallows the members.add failure with a
  // warning; router 'tblcode' has already seated the player). Hold'em rolls the join back.
  it('a guest who cannot be added to a private Blackjack thread is not left seated there', async () => {
    const h = harness();
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await openBlackjack(h, alice, 'private');
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    h.fd.fault = (method, route) => (method === 'PUT' && route === `/channels/${record.threadId}/thread-members/${bob.id}` ? refused : null);
    const opener = h.fd.clickRaw(bob, await anchor(h, bob), `tbl:join:${record.id}`);
    await h.settle();
    await h.submit(bob, opener, { code: record.accessCode! });
    expect(h.app.blackjack.tableOfUser(h.guildId, bob.id)).toBeUndefined();
  });

  // Fixed bug (was bot.ts recreateTablePanel): the "post a fresh panel in the existing thread"
  // branch is outside the try/catch, so when that send fails the error escapes to PanelSync
  // ('table recreate failed' is logged) and the table stays open with no visible panel; neither the
  // channel fallback nor the close-with-refunds path runs.
  it('a table whose panel cannot be re-posted in its thread is re-homed or closed with refunds', async () => {
    const h = harness();
    const alice = h.user('Alice');
    await openBlackjack(h, alice, 'public');
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    h.fd.messages.get(record.messageId!)!.deleted = true; // a moderator deleted the panel
    h.fd.fault = (method, route) => (method === 'POST' && route === `/channels/${record.threadId}/messages` ? refused : null);
    await h.app.blackjack.placeBet(record.id, alice.id, 100); // any change re-renders the panel
    await h.settle();
    const now = h.app.blackjack.peek(record.id)?.record;
    const visible = now?.messageId ? h.fd.messages.get(now.messageId) : undefined;
    expect(!now || (visible !== undefined && !visible.deleted)).toBe(true);
  });

  // Fixed bug: nothing ever removed thread members. Leavers and kicked players of a private table
  // are now removed from its private thread (bot.ts syncPrivateMembers). Production mode: the
  // test-mode guard only permits adding thread members, so removal is skipped there.
  it('a player kicked from a private Blackjack table is removed from its private thread', async () => {
    const h = harness({ guard: false });
    await h.slash(h.user('Admin', true), 'casinoadmin', { subcommand: 'setup' });
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    h.app.economy.ensurePlayer(h.guildId, bob.id, 'Bob');
    await openBlackjack(h, alice, 'private');
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    await h.app.blackjack.join(record.id, bob.id, 'Bob', record.accessCode!);
    await h.bot.addToTableThread(record.id, bob.id);
    expect(h.fd.log.some((r) => r.method === 'PUT' && r.route === `/channels/${record.threadId}/thread-members/${bob.id}`)).toBe(true);
    await h.app.blackjack.kick(record.id, alice.id, bob.id);
    await h.settle();
    expect(h.fd.log.some((r) => r.method === 'DELETE' && r.route === `/channels/${record.threadId}/thread-members/${bob.id}`)).toBe(true);
  });
});
