import { afterEach, describe, expect, it } from 'vitest';
import { REST, Routes } from 'discord.js';
import { silentLogger } from '../src/core/logger.js';
import { OutboundGuard, OutboundBlockedError, allowlistFromEnv, mentionViolation, routeOf } from '../src/discord/outbound-guard.js';
import { CasinoHarness } from './harness/casino-harness.js';

const GUILD = '573000000000000001';
const CHANNEL = '157400000000000001';
const OTHER = '157400000000000002';
const THREAD = '157400000000000003';
const APP = '157300000000000009';

function guard(now = () => 1_000_000) {
  return new OutboundGuard({ guildId: GUILD, channelId: CHANNEL, applicationId: APP }, silentLogger, now);
}

describe('OutboundGuard policy', () => {
  const g = guard();
  g.admitInteraction({ id: '900000000000000001', token: 'tok-ok', guildId: GUILD, channelId: CHANNEL });
  g.allowDelete('800000000000000001');

  const allowed: Array<[string, string]> = [
    ['POST', `/channels/${CHANNEL}/messages`],
    ['PATCH', `/channels/${CHANNEL}/messages/800000000000000005`],
    ['GET', `/channels/${CHANNEL}/messages/800000000000000005`],
    ['GET', `/channels/${CHANNEL}`],
    ['POST', `/channels/${CHANNEL}/typing`],
    ['DELETE', `/channels/${CHANNEL}/messages/800000000000000001`],
    ['POST', '/interactions/900000000000000001/tok-ok/callback'],
    ['POST', `/webhooks/${APP}/tok-ok`],
    ['PATCH', `/webhooks/${APP}/tok-ok/messages/@original`],
    ['PATCH', `/webhooks/${APP}/tok-ok/messages/%40original`],
    ['PUT', `/applications/${APP}/guilds/${GUILD}/commands`],
    ['GET', `/guilds/${GUILD}/members/123456789012345678`],
    ['GET', '/users/@me'],
    ['GET', '/gateway/bot'],
  ];
  const blocked: Array<[string, string, RegExp]> = [
    ['POST', `/channels/${OTHER}/messages`, /not allowlisted/],
    ['PATCH', `/channels/${OTHER}/messages/1`, /not allowlisted/],
    ['GET', `/channels/${OTHER}/messages`, /not allowlisted/],
    ['POST', `/channels/${THREAD}/messages`, /threads count as separate channels/],
    ['POST', `/channels/${CHANNEL}/threads`, /only messages/],
    ['POST', `/channels/${CHANNEL}/messages/800000000000000005/threads`, /thread creation/],
    ['PUT', `/channels/${CHANNEL}/messages/800000000000000005/reactions/%F0%9F%8E%B2/@me`, /reactions, pins/],
    ['PUT', `/channels/${CHANNEL}/pins/800000000000000005`, /only messages/],
    ['PATCH', `/channels/${CHANNEL}`, /channel settings/],
    ['PUT', `/channels/${CHANNEL}/permissions/1`, /only messages/],
    ['DELETE', `/channels/${CHANNEL}/messages/800000000000000005`, /created by this test session/],
    ['POST', `/channels/${CHANNEL}/messages/bulk-delete`, /bulk delete/],
    ['POST', '/users/@me/channels', /DMs/],
    ['GET', '/users/@me/channels', /no DM or server lists/],
    ['GET', '/users/@me/guilds', /no DM or server lists/],
    ['PUT', `/applications/${APP}/commands`, /allowlisted server/],
    ['PUT', `/applications/${APP}/guilds/573000000000000002/commands`, /allowlisted server/],
    ['GET', '/guilds/573000000000000002', /server is not allowlisted/],
    ['PATCH', `/guilds/${GUILD}`, /server settings/],
    ['PUT', `/guilds/${GUILD}/members/1/roles/2`, /server settings/],
    ['POST', '/interactions/900000000000000002/tok-x/callback', /not admitted/],
    ['POST', '/interactions/900000000000000001/wrong-token/callback', /not admitted/],
    ['POST', `/webhooks/${APP}/tok-unknown`, /not admitted/],
    ['POST', '/webhooks/157300000000000010/tok-ok', /this application/],
    ['POST', '/invites/abc', /not allowlisted/],
  ];

  it.each(allowed)('allows %s %s', (method, route) => {
    expect(g.violation(method, route)).toBeNull();
  });

  it.each(blocked)('blocks %s %s', (method, route, reason) => {
    expect(g.violation(method, route)).toMatch(reason);
  });

  it('refuses interactions from other channels, threads and servers', () => {
    const fresh = guard();
    expect(fresh.admitInteraction({ id: '1', token: 'a', guildId: GUILD, channelId: OTHER })).toBe(false);
    expect(fresh.admitInteraction({ id: '2', token: 'b', guildId: GUILD, channelId: THREAD })).toBe(false);
    expect(fresh.admitInteraction({ id: '3', token: 'c', guildId: '573000000000000002', channelId: CHANNEL })).toBe(false);
    expect(fresh.admitInteraction({ id: '4', token: 'd', guildId: null, channelId: CHANNEL })).toBe(false);
    expect(fresh.violation('POST', '/interactions/1/a/callback')).toMatch(/not admitted/);
    expect(fresh.admitInteraction({ id: '5', token: 'e', guildId: GUILD, channelId: CHANNEL })).toBe(true);
  });

  it('expires admitted interaction tokens after 15 minutes', () => {
    let now = 1_000_000;
    const g2 = guard(() => now);
    g2.admitInteraction({ id: '7', token: 'tok7', guildId: GUILD, channelId: CHANNEL });
    expect(g2.violation('POST', `/webhooks/${APP}/tok7`)).toBeNull();
    now += 15 * 60_000 + 1;
    expect(g2.violation('POST', `/webhooks/${APP}/tok7`)).toMatch(/not admitted/);
  });

  it('refuses payloads that would ping anyone', () => {
    expect(mentionViolation({ components: [{ type: 10, content: 'hi <@123456789012345678>' }] })).toMatch(/would ping/);
    expect(mentionViolation({ content: '@everyone look' })).toMatch(/would ping/);
    expect(mentionViolation({ allowed_mentions: { parse: ['users'] }, content: 'x' })).toMatch(/pings are not allowed/);
    expect(mentionViolation({ allowed_mentions: { parse: [], users: ['1'] } })).toMatch(/pings are not allowed/);
    expect(mentionViolation({ type: 4, data: { allowed_mentions: { parse: [], users: ['1'] } } })).toMatch(/pings are not allowed/);
    expect(mentionViolation({ allowed_mentions: { parse: [] }, components: [{ type: 10, content: '<@123456789012345678>' }] })).toBeNull();
    expect(mentionViolation({ type: 6 })).toBeNull();
  });

  it('redacts interaction tokens in what it records', () => {
    const g3 = guard();
    expect(() => g3.check('POST', `https://discord.com/api/v10/webhooks/${APP}/secret-token-value`)).toThrow(OutboundBlockedError);
    expect(JSON.stringify(g3.blocked)).not.toContain('secret-token-value');
  });

  it('parses routes from full URLs', () => {
    expect(routeOf('https://discord.com/api/v10/channels/1/messages?limit=5')).toBe('/channels/1/messages');
  });

  it('reads the allowlist from the environment and fails closed', () => {
    expect(allowlistFromEnv({}, APP)).toBeNull();
    expect(() => allowlistFromEnv({ CASINO_TEST_MODE: 'true' }, APP)).toThrow(/requires/);
    expect(allowlistFromEnv({ CASINO_TEST_MODE: 'true', CASINO_TEST_GUILD_ID: GUILD, CASINO_TEST_CHANNEL_ID: CHANNEL }, APP)).toEqual({ guildId: GUILD, channelId: CHANNEL, applicationId: APP });
  });
});

describe('OutboundGuard on a real discord.js REST client', () => {
  it('stops blocked requests before they reach the network', async () => {
    const sent: string[] = [];
    const rest = new REST({
      makeRequest: async (url: string) => {
        sent.push(url);
        return new Response(JSON.stringify({ id: '1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    } as never).setToken('test');
    guard().install(rest);
    await expect(rest.post(Routes.channelMessages(OTHER), { body: { content: 'hello' } })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(rest.post(Routes.threads(CHANNEL), { body: { name: 't' } })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(rest.post(Routes.userChannels(), { body: { recipient_id: '1' } })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(rest.post(Routes.channelMessages(CHANNEL), { body: { content: 'hi <@123456789012345678>' } })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(sent).toEqual([]);
    await rest.post(Routes.channelMessages(CHANNEL), { body: { content: 'hello', allowed_mentions: { parse: [] } } });
    expect(sent).toHaveLength(1);
  });
});

describe('OutboundGuard inside the running bot (full stack)', () => {
  let h: CasinoHarness;
  afterEach(async () => {
    await h?.close();
  });

  /** Every write must target #casino or an admitted interaction; nothing else may reach Discord. */
  function assertContained(harness: CasinoHarness) {
    for (const r of harness.fd.log) {
      if (r.method === 'GET') continue;
      const ok = r.route.startsWith(`/channels/${harness.casino}/messages`) || r.route.startsWith('/interactions/') || r.route.startsWith(`/webhooks/${harness.fd.appId}/`);
      expect(ok, `${r.method} ${r.route}`).toBe(true);
    }
  }

  it('ignores interactions from other channels without sending anything', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const rec = await h.slash(alice, 'casino', {}, h.general);
    expect(rec.callbacks).toEqual([]);
    expect(h.fd.log).toEqual([]);
  });

  it('refuses to move the lobby outside the allowlist', async () => {
    h = new CasinoHarness();
    const admin = h.user('Admin', true);
    const rec = await h.slash(admin, 'casinoadmin', { subcommand: 'setup', args: [] }, h.general);
    expect(rec.callbacks).toEqual([]);
    expect(h.app.settings.lobby(h.guildId).channelId).toBeNull();
    // An admin in #casino pointing setup at #general is refused privately; nothing reaches #general.
    const elsewhere = await h.slash(admin, 'casinoadmin', { subcommand: 'setup', args: [{ name: 'channel', type: 'channel', value: h.general }] });
    expect(h.seen(elsewhere)!.forUser).toBe(admin.id);
    expect(h.text(h.seen(elsewhere))).toMatch(/test mode/i);
    expect(h.app.settings.lobby(h.guildId).channelId).toBeNull();
    expect(h.fd.log.some((r) => r.route.includes(h.general))).toBe(false);
    // Setup from #casino works and posts the lobby there.
    const ok = await h.slash(admin, 'casinoadmin', { subcommand: 'setup' });
    expect(ok.errors).toEqual([]);
    expect(h.lobby()?.channelId).toBe(h.casino);
    assertContained(h);
    expect(h.guard!.blockedCount).toBe(0);
  });

  it('relocates a table whose panel lives in a thread instead of touching the thread', async () => {
    // Session 1 without the guard: threads are used.
    const path = `${process.env.TEMP ?? '/tmp'}/casino-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const before = new CasinoHarness({ guard: false, dbPath: path });
    const alice = before.user('Alice');
    await before.click(alice, before.seen(await before.slash(alice, 'casino')), 'Play Blackjack');
    const tableId = before.app.blackjack.allOpenTables()[0]!.record.id;
    const threadId = before.app.blackjack.peek(tableId)!.record.threadId;
    expect(threadId).not.toBeNull();
    await before.close();

    // Session 2 in test mode, same server and database.
    h = new CasinoHarness({ discord: before.fd, dbPath: path });
    h.fd.log.length = 0;
    await h.boot();
    const record = h.app.blackjack.peek(tableId)!.record;
    expect(record.threadId).toBeNull();
    expect(h.tablePanel(tableId).channelId).toBe(h.casino);
    expect(h.fd.log.some((r) => r.route.includes(threadId!) && r.method !== 'GET')).toBe(false);
    assertContained(h);
  });

  it('keeps background work (timeouts, lobby refreshes, closing) inside the allowlist', async () => {
    h = new CasinoHarness();
    const admin = h.user('Admin', true);
    await h.slash(admin, 'casinoadmin', { subcommand: 'setup' });
    const alice = h.user('Alice');
    await h.click(alice, h.seen(await h.slash(alice, 'casino')), 'Play Blackjack');
    const tableId = h.app.blackjack.allOpenTables()[0]!.record.id;
    await h.click(alice, h.tablePanel(tableId), /^25$|25/);
    await h.advance(60_000); // betting window → deal → turn timer → auto-stand → settle
    await h.advance(60_000);
    await h.app.blackjack.closeTable(tableId, 'test over', { force: true });
    await h.settle();
    assertContained(h);
    expect(h.guard!.blockedCount).toBe(0);
    expect(h.fd.problems).toEqual([]);
  });
});
