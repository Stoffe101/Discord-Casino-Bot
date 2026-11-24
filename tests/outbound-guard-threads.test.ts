/**
 * Test mode with threads enabled: only threads whose parent is the allowlisted channel (in the
 * allowlisted server) become reachable — verified from Discord's own data, never assumed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REST, Routes } from 'discord.js';
import { silentLogger } from '../src/core/logger.js';
import { OutboundBlockedError, OutboundGuard, allowlistFromEnv } from '../src/discord/outbound-guard.js';
import { CasinoHarness } from './harness/casino-harness.js';
import { undiciLikeResponse } from './harness/fake-discord.js';

const GUILD = '573000000000000001';
const OTHER_GUILD = '573000000000000002';
const CASINO = '157400000000000001';
const GENERAL = '157400000000000002';
const T_OK = '157400000000000010'; // child of #casino
const T_GENERAL = '157400000000000011'; // child of #general
const T_OTHER_GUILD = '157400000000000012'; // child of a channel with the same id… in another server
const T_UNKNOWN = '157400000000000013';
const APP = '157300000000000009';

function guard(allowThreads = true) {
  const g = new OutboundGuard({ guildId: GUILD, channelId: CASINO, applicationId: APP, allowThreads }, silentLogger);
  g.learnThread({ id: T_OK, parentId: CASINO, guildId: GUILD });
  g.learnThread({ id: T_GENERAL, parentId: GENERAL, guildId: GUILD });
  g.learnThread({ id: T_OTHER_GUILD, parentId: CASINO, guildId: OTHER_GUILD });
  return g;
}

describe('thread policy', () => {
  const g = guard();

  it('verifies thread parentage and server before trusting a thread', () => {
    expect([...g.knownThreads]).toEqual([T_OK]);
    expect(g.allowsLocation({ channelId: CASINO, threadId: T_OK })).toBe(true);
    expect(g.allowsLocation({ channelId: CASINO, threadId: T_UNKNOWN })).toBe(false);
    expect(g.allowsLocation({ channelId: GENERAL, threadId: T_GENERAL })).toBe(false);
  });

  const allowed: Array<[string, string, unknown?]> = [
    ['POST', `/channels/${CASINO}/threads`, { name: 'blackjack-table-01', type: 11 }],
    ['POST', `/channels/${CASINO}/threads`, { name: 'private', type: 12, invitable: false }],
    ['POST', `/channels/${T_OK}/messages`],
    ['PATCH', `/channels/${T_OK}/messages/800000000000000005`],
    ['GET', `/channels/${T_OK}/messages/800000000000000005`],
    ['PATCH', `/channels/${T_OK}`, { archived: true }],
    ['PATCH', `/channels/${T_OK}`, { locked: true }],
    ['PATCH', `/channels/${T_OK}`, { archived: false, auto_archive_duration: 1440 }],
    ['PUT', `/channels/${T_OK}/thread-members/123456789012345678`],
    ['GET', `/channels/${T_UNKNOWN}`], // lookup only (verifies parentage)
  ];
  const blocked: Array<[string, string, RegExp, unknown?]> = [
    ['POST', `/channels/${T_GENERAL}/messages`, /not allowlisted/],
    ['POST', `/channels/${T_OTHER_GUILD}/messages`, /not allowlisted/],
    ['POST', `/channels/${T_UNKNOWN}/messages`, /not allowlisted/],
    ['GET', `/channels/${T_UNKNOWN}/messages`, /not allowlisted/],
    ['PATCH', `/channels/${T_GENERAL}`, /not allowlisted/, { archived: true }],
    ['POST', `/channels/${GENERAL}/threads`, /not allowlisted/, { name: 'x', type: 11 }],
    ['POST', `/channels/${GENERAL}/messages/800000000000000005/threads`, /not allowlisted/],
    ['POST', `/channels/${CASINO}/threads`, /public or private threads/, { name: 'news', type: 10 }],
    ['POST', `/channels/${T_OK}/threads`, /only allowed under the allowlisted channel/, { name: 'nested', type: 11 }],
    ['PATCH', `/channels/${T_OK}`, /only archiving or locking/, { name: 'renamed' }],
    ['PATCH', `/channels/${T_OK}`, /only archiving or locking/, { archived: true, rate_limit_per_user: 60 }],
    ['DELETE', `/channels/${T_OK}`, /may not be deleted/],
    ['DELETE', `/channels/${T_OK}/thread-members/123456789012345678`, /only adding members/],
    ['PUT', `/channels/${T_GENERAL}/thread-members/123456789012345678`, /not allowlisted/],
    ['PUT', `/channels/${T_OK}/messages/800000000000000005/reactions/x/@me`, /reactions, pins/],
    ['DELETE', `/channels/${T_OK}/messages/800000000000000005`, /created by this test session/],
    ['PATCH', `/channels/${CASINO}`, /channel settings/, { name: 'x' }],
    ['POST', '/users/@me/channels', /DMs/],
  ];

  it.each(allowed)('allows %s %s', (method, route, body) => {
    expect(g.violation(method, route, body)).toBeNull();
  });
  it.each(blocked)('blocks %s %s', (method, route, reason, body) => {
    expect(g.violation(method, route, body)).toMatch(reason);
  });

  it('admits interactions only from #casino or its verified threads', () => {
    const fresh = guard();
    expect(fresh.admitInteraction({ id: '1', token: 'a', guildId: GUILD, channelId: T_OK })).toBe(true);
    // A new thread is admitted when the interaction proves its parent is #casino…
    expect(fresh.admitInteraction({ id: '2', token: 'b', guildId: GUILD, channelId: '157400000000000020', parentId: CASINO })).toBe(true);
    expect(fresh.knownThreads.has('157400000000000020')).toBe(true);
    // …but not a thread of another channel or another server.
    expect(fresh.admitInteraction({ id: '3', token: 'c', guildId: GUILD, channelId: '157400000000000021', parentId: GENERAL })).toBe(false);
    expect(fresh.admitInteraction({ id: '4', token: 'd', guildId: OTHER_GUILD, channelId: '157400000000000022', parentId: CASINO })).toBe(false);
    expect(fresh.admitInteraction({ id: '5', token: 'e', guildId: GUILD, channelId: GENERAL })).toBe(false);
  });

  it('keeps every thread closed when threads are not enabled', () => {
    const off = guard(false);
    expect(off.knownThreads.size).toBe(0);
    expect(off.violation('POST', `/channels/${CASINO}/threads`, { name: 'x', type: 11 })).toMatch(/not allowed in test mode/);
    expect(off.violation('POST', `/channels/${T_OK}/messages`)).toMatch(/separate channels/);
    expect(off.violation('GET', `/channels/${T_UNKNOWN}`)).toMatch(/not allowlisted/);
    expect(off.admitInteraction({ id: '9', token: 'z', guildId: GUILD, channelId: T_OK, parentId: CASINO })).toBe(false);
  });

  it('reads CASINO_TEST_ALLOW_THREADS from the environment (off unless set)', () => {
    const base = { CASINO_TEST_MODE: 'true', CASINO_TEST_GUILD_ID: GUILD, CASINO_TEST_CHANNEL_ID: CASINO };
    expect(allowlistFromEnv(base, APP)?.allowThreads).toBe(false);
    expect(allowlistFromEnv({ ...base, CASINO_TEST_ALLOW_THREADS: 'true' }, APP)?.allowThreads).toBe(true);
  });
});

describe('learning threads from Discord responses (real discord.js REST client)', () => {
  function restWith(responses: Record<string, unknown>) {
    const sent: string[] = [];
    const rest = new REST({
      makeRequest: async (url: string, init: { method?: string }) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        sent.push(`${init.method} ${path}`);
        const body = responses[`${init.method} ${path}`] ?? { id: '800000000000000001' };
        return undiciLikeResponse(200, body);
      },
    } as never).setToken('test');
    return { rest, sent };
  }

  it('learns a thread it created under #casino and can post in it', async () => {
    const g = new OutboundGuard({ guildId: GUILD, channelId: CASINO, applicationId: APP, allowThreads: true }, silentLogger);
    const { rest, sent } = restWith({ [`POST /channels/${CASINO}/threads`]: { id: '157400000000000030', type: 11, parent_id: CASINO, guild_id: GUILD } });
    g.install(rest);
    await rest.post(Routes.threads(CASINO), { body: { name: 't', type: 11 } });
    await rest.post(Routes.channelMessages('157400000000000030'), { body: { content: 'hi', allowed_mentions: { parse: [] } } });
    expect(sent).toHaveLength(2);
  });

  it('a lookup of a thread under #general does not unlock it', async () => {
    const g = new OutboundGuard({ guildId: GUILD, channelId: CASINO, applicationId: APP, allowThreads: true }, silentLogger);
    const { rest, sent } = restWith({ [`GET /channels/${T_GENERAL}`]: { id: T_GENERAL, type: 11, parent_id: GENERAL, guild_id: GUILD } });
    g.install(rest);
    await rest.get(Routes.channel(T_GENERAL));
    await expect(rest.post(Routes.channelMessages(T_GENERAL), { body: { content: 'x', allowed_mentions: { parse: [] } } })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(sent).toEqual([`GET /channels/${T_GENERAL}`]);
  });
});

describe('table threads in test mode (full stack)', () => {
  let h: CasinoHarness;
  afterEach(async () => {
    await h?.close();
  });

  /** Every write must target #casino, a verified #casino thread, or an admitted interaction. */
  function assertContained() {
    const allowedChannels = new Set([h.casino, ...h.guard!.knownThreads]);
    for (const r of h.fd.log) {
      if (r.method === 'GET') continue;
      const channel = /^\/channels\/(\d+)/.exec(r.route)?.[1];
      const ok = (channel && allowedChannels.has(channel)) || r.route.startsWith('/interactions/') || r.route.startsWith(`/webhooks/${h.fd.appId}/`);
      expect(ok, `${r.method} ${r.route}`).toBe(true);
    }
    for (const id of h.guard!.knownThreads) expect(h.fd.channels.get(id)?.parentId).toBe(h.casino);
  }

  it('creates the table thread under #casino, plays inside it and archives it on close', async () => {
    h = new CasinoHarness({ allowThreads: true });
    const [alice, bob] = [h.user('Alice'), h.user('Bob')];
    await h.click(alice, h.seen(await h.slash(alice, 'casino')), 'Play Blackjack');
    const record = h.app.blackjack.tableOfUser(h.guildId, alice.id)!.record;
    const thread = h.fd.channels.get(record.threadId!)!;
    expect(thread.parentId).toBe(h.casino);
    expect(thread.name).toBe('blackjack-table-01');
    expect(h.tablePanel(record.id).channelId).toBe(thread.id);
    // Players act from inside the thread.
    await h.click(alice, h.tablePanel(record.id), '25');
    const bobBet = await h.click(bob, h.tablePanel(record.id), '25');
    expect(bobBet.errors).toEqual([]);
    expect(bobBet.callbacks).toEqual([7]);
    // Host closes the table from the seat screen: panel shows closed, thread is locked and archived.
    await h.app.blackjack.clearBet(record.id, alice.id);
    await h.app.blackjack.clearBet(record.id, bob.id);
    await h.app.blackjack.closeTable(record.id, 'closed by the host', { actorId: alice.id });
    await h.settle();
    expect(h.text(h.fd.messages.get(record.messageId!)!)).toContain('closed');
    expect(thread.locked).toBe(true);
    expect(thread.archived).toBe(true);
    expect(h.guard!.blockedCount).toBe(0);
    assertContained();
  });

  it('private tables use a private #casino thread and add the joining player', async () => {
    h = new CasinoHarness({ allowThreads: true });
    const [host, guest] = [h.user('Host'), h.user('Guest')];
    const tables = h.seen(await h.click(host, h.seen(await h.slash(host, 'casino')), 'Browse tables'));
    const opener = await h.click(host, tables, 'Open a table');
    await h.submit(host, opener, { visibility: 'private' });
    const record = h.app.blackjack.tableOfUser(h.guildId, host.id)!.record;
    expect(h.fd.channels.get(record.threadId!)?.type).toBe(12);
    const ask = await h.click(guest, h.tablePanel(record.id), 'Take a seat');
    await h.submit(guest, ask, { code: record.accessCode! });
    expect(h.fd.log.some((r) => r.method === 'PUT' && r.route === `/channels/${record.threadId}/thread-members/${guest.id}`)).toBe(true);
    assertContained();
  });

  it('ignores interactions from a member thread under another channel', async () => {
    h = new CasinoHarness({ allowThreads: true });
    const alice = h.user('Alice');
    const stray = h.fd.addThread(h.general, 'chit-chat');
    const rec = await h.slash(alice, 'casino', {}, stray);
    expect(rec.callbacks).toEqual([]);
    expect(h.fd.log).toEqual([]);
    expect(h.guard!.knownThreads.has(stray)).toBe(false);
  });

  it('keeps several tables in their own threads without posting panels in #casino', async () => {
    h = new CasinoHarness({ allowThreads: true });
    for (let i = 0; i < 3; i++) {
      const host = h.user(`Host${i}`);
      const tables = h.seen(await h.click(host, h.seen(await h.slash(host, 'casino')), 'Browse tables'));
      const opener = await h.click(host, tables, 'Open a table');
      await h.submit(host, opener, { visibility: 'public' });
    }
    const open = h.app.blackjack.allOpenTables();
    expect(open).toHaveLength(3);
    expect(new Set(open.map((t) => t.record.threadId)).size).toBe(3);
    // No table panels in #casino itself, and the "started a thread" notices were removed again.
    expect(h.fd.channelMessages(h.casino)).toHaveLength(0);
    expect([...h.fd.messages.values()].filter((m) => m.type === 18 && m.deleted)).toHaveLength(3);
    assertContained();
  });
});
