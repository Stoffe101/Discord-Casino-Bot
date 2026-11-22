/**
 * Live table-thread bench (development only; test mode with CASINO_TEST_ALLOW_THREADS=true).
 *
 * Runs the real bot adapter — thread creation, panel posting, panel sync with dealer reveal
 * frames, close / lock / archive — against the real Discord API in threads under the allowlisted
 * channel. Players are simulated (they act through the game services, since only real people
 * can press real buttons) in a throw-away in-memory casino. REST only: no gateway session, so it
 * never competes with the running bot for interactions. Every request passes the outbound guard.
 *
 *   npm run live-tables                        → 3 tables (one private), 2 hands each, then close
 *   npm run live-tables -- --tables 2 --rounds 3 --pace 900
 *   npm run live-tables -- --tidy              → also delete the "started a thread" notices it caused
 */
import { performance } from 'node:perf_hooks';
import { ClientUser, Routes, type APIMessage, type APIThreadChannel, type APIUser, type Client } from 'discord.js';
import { loadEnvFile, readEnv } from '../config/env.js';
import { Logger } from '../core/logger.js';
import { Database } from '../db/database.js';
import { ManualClock } from '../core/clock.js';
import { ManualScheduler } from '../core/scheduler.js';
import { seededRng } from '../core/random.js';
import { CasinoApp } from '../app/casino-app.js';
import { CasinoBot } from '../discord/bot.js';
import { OutboundGuard, allowlistFromEnv } from '../discord/outbound-guard.js';
import { ALL_IN_DEAL_DELAY_MS } from '../tables/blackjack-table-service.js';
import { availableActions, currentTurnUserId, handValue } from '../games/blackjack/engine.js';
import type { Card } from '../games/cards.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const TABLES = num('tables', 3);
const ROUNDS = num('rounds', 2);
const PACE_MS = num('pace', 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['Alex', 'Hanna', 'Christoffer', 'Maja', 'Oskar', 'Linnea', 'Viktor', 'Elsa', 'Noah', 'Wilma', 'Hugo', 'Saga'];

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv();
  const allow = allowlistFromEnv(process.env, env.clientId);
  if (!allow?.allowThreads) {
    console.error('live-tables needs test mode with CASINO_TEST_ALLOW_THREADS=true.');
    process.exit(1);
  }
  const logger = new Logger({ level: 'warn' });
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock(Date.now());
  const scheduler = new ManualScheduler(clock);
  const app = new CasinoApp({ db, logger, clock, scheduler, rng: seededRng(77) });
  const guard = new OutboundGuard(allow, logger);
  const bot = new CasinoBot(app, logger, { guard }); // production timings: real reveal frames
  const client: Client = bot.client;
  client.rest.setToken(env.token);
  const started = performance.now();

  // REST-only bootstrap of the caches the adapter expects (bot user, server, #casino).
  const me = (await client.rest.get(Routes.user())) as APIUser;
  const UserCtor = ClientUser as unknown as new (c: Client, data: unknown) => ClientUser;
  (client as unknown as { user: ClientUser }).user = new UserCtor(client, me);
  const guild = await client.guilds.fetch(allow.guildId);
  await guild.members.fetchMe();
  await client.channels.fetch(allow.channelId);
  const guildId = allow.guildId;

  // Open the tables: real threads under #casino with real panels.
  const tables: Array<{ id: string; players: string[]; threadId: string; messageId: string; url: string | null; private: boolean }> = [];
  for (let t = 0; t < TABLES; t++) {
    const players = Array.from({ length: 4 }, (_, p) => `90000000000000${String(t).padStart(2, '0')}${p}0`);
    players.forEach((id, p) => app.economy.ensurePlayer(guildId, id, NAMES[(t * 4 + p) % NAMES.length]!));
    const isPrivate = t === TABLES - 1 && TABLES > 1;
    const table = await app.blackjack.createTable({ guildId, ownerId: players[0]!, ownerName: NAMES[(t * 4) % NAMES.length]!, isPrivate });
    for (const [p, id] of players.slice(1).entries()) await app.blackjack.join(table.record.id, id, NAMES[(t * 4 + p + 1) % NAMES.length]!, table.record.accessCode ?? undefined);
    const { url } = await bot.createTablePanel(table.record.id, allow.channelId, players[0]!);
    const record = app.blackjack.peek(table.record.id)!.record;
    tables.push({ id: record.id, players, threadId: record.threadId!, messageId: record.messageId!, url, private: isPrivate });
    console.log(`table ${t + 1}: ${isPrivate ? 'private' : 'public'} thread created, panel posted (${url ? 'link ok' : 'no link'})`);
  }
  // Table 1, hand 1: a pair of eights to split and a double.
  await app.blackjack.debugSetShoe(tables[0]!.id, ['8S', 'TC', '9H', '6D', '7C', '8H', '6S', '2D', 'KD', 'TH', '3C', '9C', '5D', 'QS'] as Card[]);

  // Play: all tables concurrently, at a human-ish pace so each panel update is visible.
  const playTable = async (t: (typeof tables)[number]) => {
    for (let round = 0; round < ROUNDS; round++) {
      for (const [i, id] of t.players.entries()) {
        await app.blackjack.placeBet(t.id, id, [25, 50, 100, 10][(round + i) % 4]!);
        await sleep(PACE_MS / 3);
      }
      clock.advance(ALL_IN_DEAL_DELAY_MS);
      scheduler.runDue();
      await app.blackjack.idle();
      for (let step = 0; step < 40; step++) {
        const s = app.blackjack.peek(t.id)!.state;
        if (s.phase === 'insurance') {
          for (const seat of s.round!.seats.filter((x) => x.insurance.decision === 'pending')) await app.blackjack.decideInsurance(t.id, seat.userId, false);
          continue;
        }
        if (s.phase !== 'playing') break;
        const who = currentTurnUserId(s.round!)!;
        const turn = s.round!.turn!;
        const hand = s.round!.seats[turn.seat]!.hands[turn.hand]!;
        const legal = availableActions(s.round!, who);
        const total = handValue(hand.cards).total;
        const move = legal.split && total === 16 ? 'split' : legal.double && total >= 10 && total <= 11 ? 'double' : legal.hit && total < 17 ? 'hit' : 'stand';
        await sleep(PACE_MS);
        await app.blackjack.act(t.id, who, move, s.round!.seq).catch(() => undefined);
      }
      await bot.idle(); // includes the dealer reveal frames
      await sleep(PACE_MS);
    }
  };
  await Promise.all(tables.map(playTable));
  await bot.idle();

  // Verify what Discord now holds for each table. Components V2 keeps images inside the media
  // component (resolved to a CDN url), not in the message's attachments list.
  const report: string[] = [];
  const resolvedMedia = (m: APIMessage) => [...JSON.stringify(m.components).matchAll(/"media":\{"id":"\d+","url":"https:\/\/cdn\.discordapp\.com\//g)].length;
  for (const [i, t] of tables.entries()) {
    // Re-render the same state: the panel keeps its image and edits WITHOUT re-uploading it.
    const reusedBefore = bot.tablePanels.stats.reusedImage;
    bot.tablePanels.request(t.id);
    await bot.idle();
    const reused = bot.tablePanels.stats.reusedImage > reusedBefore;
    const message = (await client.rest.get(Routes.channelMessage(t.threadId, t.messageId))) as APIMessage;
    const text = JSON.stringify(message.components);
    report.push(`table ${i + 1}: panel in its thread · results shown: ${/results/.test(text) ? 'yes' : 'NO'} · image resolved by Discord: ${resolvedMedia(message) === 1 ? 'yes' : 'NO'}${reused ? ' (after an edit that reused it without re-upload)' : ''}`);
  }

  // Close: closed panel, then lock + archive (the bot's normal cleanup).
  for (const t of tables) await app.blackjack.closeTable(t.id, 'bench finished', { force: true });
  await bot.idle();
  for (const [i, t] of tables.entries()) {
    const thread = (await client.rest.get(Routes.channel(t.threadId))) as APIThreadChannel;
    const message = (await client.rest.get(Routes.channelMessage(t.threadId, t.messageId))) as APIMessage;
    report.push(
      `table ${i + 1}: closed panel ${/closed/.test(JSON.stringify(message.components)) ? 'yes' : 'NO'} · locked ${thread.thread_metadata?.locked ? 'yes' : 'NO'} · archived ${thread.thread_metadata?.archived ? 'yes' : 'NO'} · type ${thread.type === 12 ? 'private' : 'public'}`,
    );
  }

  // What did #casino itself receive? (Thread creation makes Discord post a small notice.)
  const recent = (await client.rest.get(Routes.channelMessages(allow.channelId), { query: new URLSearchParams({ limit: '30' }) })) as APIMessage[];
  const ours = new Set(tables.map((t) => t.threadId));
  const notices = recent.filter((m) => m.author.id === me.id && m.type === 18);
  const ourNotices = notices.filter((m) => (m.message_reference?.channel_id && ours.has(m.message_reference.channel_id)) || (m.thread?.id && ours.has(m.thread.id)));
  const otherBotMessages = recent.filter((m) => m.author.id === me.id && m.type !== 18 && Date.parse(m.timestamp) > Date.now() - (performance.now() - started) - 5_000);
  report.push(`#casino: ${ourNotices.length} "started a thread" notice(s) from this run (${notices.length} in the last 30 messages); other new bot messages: ${otherBotMessages.length}`);
  if (args.includes('--tidy')) {
    let deleted = 0;
    for (const m of ourNotices) {
      guard.allowDelete(m.id);
      try {
        await client.rest.delete(Routes.channelMessage(allow.channelId, m.id));
        deleted++;
      } catch (error) {
        report.push(`could not delete notice ${m.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    report.push(`#casino: deleted ${deleted} notice(s)`);
  }

  const metrics = bot.restMetrics.summary();
  console.log('\n══════ Live table threads ══════');
  for (const line of report) console.log(line);
  console.log(`hands settled: ${db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE status = 'settled'")!.n} · elapsed ${((performance.now() - started) / 1000).toFixed(1)} s`);
  console.log(`panels: ${JSON.stringify(bot.tablePanels.stats)}`);
  for (const [kind, m] of Object.entries(metrics)) console.log(`Discord ${kind}: ${m.count}× avg ${m.avgMs} ms · p95 ${m.p95Ms} ms · max ${m.maxMs} ms · errors ${m.errors}`);
  console.log(`rate-limited responses: ${bot.restMetrics.rateLimited} · guard: ${guard.allowedCount} allowed, ${guard.blockedCount} blocked`);
  for (const b of guard.blocked) console.log(`  blocked: ${b.method} ${b.route} — ${b.reason}`);
  console.log(`ledger: ${app.economy.reconcile().length === 0 ? 'OK' : 'PROBLEMS'}`);
  await bot.stop();
  await app.shutdown();
  db.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
