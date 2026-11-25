/**
 * Interaction latency bench through the full bot stack (in-memory Discord, production timings).
 *
 * Unlike the tests, this wires CasinoApp and CasinoBot the way main.ts does: the system clock, real
 * timers, the bot's default timing and animations on, threads allowed. Every Discord request goes
 * through a wrapper that adds simulated network time (a fixed latency per request, plus a fixed
 * cost for any request that uploads files, calibrated against real Discord with
 * src/scripts/bench-live-rest.ts) and logs start, end, route, interaction and uploaded bytes.
 *
 *   npx tsx tests/harness/bench-interactions.ts --scenario solo --passes 30 --out recordings/perf/x.json
 *   npx tsx tests/harness/bench-interactions.ts --scenario concurrent --out recordings/perf/y.json
 *   options: --latency 120 (ms per request) --upload-ms 150 (extra per request with files) --label name
 *
 * Per interaction it reports: ack (the interaction's own first response), first visible change,
 * final visible change (the last message write it caused), the same minus deliberate waits (GIF
 * holds, the solo deal delay), Discord requests and uploaded KB. Lobby edits are counted apart
 * (they are debounced and land in later windows). Pass 1 of a fresh process is "cold".
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { CasinoApp } from '../../src/app/casino-app.js';
import { systemClock } from '../../src/core/clock.js';
import { silentLogger } from '../../src/core/logger.js';
import { seededRng } from '../../src/core/random.js';
import { RealScheduler } from '../../src/core/scheduler.js';
import { Database } from '../../src/db/database.js';
import { CasinoBot } from '../../src/discord/bot.js';
import { OutboundGuard } from '../../src/discord/outbound-guard.js';
import { rouletteSpinAt } from '../../src/games/roulette/roulette-service.js';
import type { Card } from '../../src/games/cards.js';
import { warmCasinoArtwork } from '../../src/render/casino-art.js';
import { warmFloorArt } from '../../src/render/floor-art.js';
import { renderStats } from '../../src/render/png.js';
import { SOLO_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import { cid } from '../../src/ui/custom-id.js';
import type { Screen } from '../../src/ui/kit.js';
import { NAV } from '../../src/ui/screens/common.js';
import { FakeDiscord, buttonsOf, type FakeMessage, type FakeUser, type InteractionRecord } from './fake-discord.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const SCENARIO = opt('scenario', 'solo');
const PASSES = Number(opt('passes', '30'));
const LATENCY = Number(opt('latency', '120'));
const UPLOAD_MS = Number(opt('upload-ms', '150'));
const OUT = opt('out', '');
const LABEL = opt('label', '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── request log ─────────────────────────────

interface Req {
  start: number;
  end: number;
  method: string;
  route: string;
  bytes: number;
  files: string[];
  callbackType: number | null;
  interactionId: string | null;
  channelId: string | null;
  messageId: string | null;
  status: number;
  /** Digest of the components sent (to spot edits that changed nothing). */
  digest: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function describeBody(body: unknown): Promise<{ bytes: number; files: string[]; json: any }> {
  if (body === undefined || body === null) return { bytes: 0, files: [], json: undefined };
  if (typeof body === 'string') return { bytes: Buffer.byteLength(body), files: [], json: JSON.parse(body) };
  if (body instanceof Uint8Array) return { bytes: body.byteLength, files: [], json: JSON.parse(Buffer.from(body).toString('utf8')) };
  const form = body as { entries?: () => Iterable<[string, unknown]> };
  let bytes = 0;
  const files: string[] = [];
  let json: any;
  if (typeof form.entries === 'function') {
    for (const [key, value] of form.entries()) {
      if (key === 'payload_json') {
        bytes += Buffer.byteLength(String(value));
        json = JSON.parse(String(value));
      } else if (value && typeof value === 'object' && 'size' in value) {
        bytes += (value as Blob).size;
        files.push((value as Blob & { name?: string }).name ?? key);
      }
    }
  }
  return { bytes, files, json };
}

class World {
  readonly fd = new FakeDiscord();
  readonly guildId: string;
  readonly casino: string;
  readonly app: CasinoApp;
  readonly bot: CasinoBot;
  readonly log: Req[] = [];
  inflight = 0;
  maxInflight = 0;
  /** Screens the bot sent (validated), with their animation hold. */
  readonly sent: Array<{ at: number; holdMs: number | undefined }> = [];

  constructor() {
    this.guildId = this.fd.addGuild('Bench Server');
    this.casino = this.fd.addChannel(this.guildId, 'casino');
    this.fd.addChannel(this.guildId, 'general');
    const db = new Database(':memory:');
    db.migrate();
    this.app = new CasinoApp({ db, logger: silentLogger, clock: systemClock, scheduler: new RealScheduler(systemClock), rng: seededRng(2026) });
    const guard = new OutboundGuard({ guildId: this.guildId, channelId: this.casino, applicationId: this.fd.appId, allowThreads: true }, silentLogger);
    const inner = this.fd.makeRequest;
    const wrapped = async (url: string, init: { method?: string | undefined; body?: unknown }): Promise<Response> => {
      const start = performance.now();
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      const route = new URL(url).pathname.replace(/^\/api(\/v\d+)?/, '');
      const method = (init.method ?? 'GET').toUpperCase();
      const { bytes, files, json } = await describeBody(init.body);
      await sleep(LATENCY + (files.length ? UPLOAD_MS : 0));
      let res: Response;
      try {
        res = await inner(url, init);
      } finally {
        this.inflight--;
      }
      const s = route.split('/').filter(Boolean);
      let interactionId: string | null = null;
      if (s[0] === 'interactions') interactionId = s[1] ?? null;
      else if (s[0] === 'webhooks') interactionId = this.fd.interactions.get(decodeURIComponent(s[2] ?? ''))?.id ?? null;
      this.log.push({
        start, end: performance.now(), method, route: route.replace(/\/[A-Za-z0-9_-]{40,}/g, '/[token]'), bytes, files,
        callbackType: s[0] === 'interactions' ? (json?.type ?? null) : null, interactionId,
        channelId: s[0] === 'channels' ? s[1]! : null, messageId: s[0] === 'channels' && s[2] === 'messages' ? (s[3] ?? null) : null,
        status: res.status,
        digest: json ? createHash('sha1').update(JSON.stringify(json.components ?? json.data?.components ?? null) + files.join(',')).digest('hex').slice(0, 12) : null,
      });
      return res;
    };
    this.bot = new CasinoBot(this.app, silentLogger, { guard, animations: true, makeRequest: wrapped as never });
    const checked = this.bot.checked.bind(this.bot);
    this.bot.checked = (screen: Screen) => {
      this.sent.push({ at: performance.now(), holdMs: screen.holdMs });
      return checked(screen);
    };
    this.fd.attach(this.bot.client);
  }

  async boot(): Promise<void> {
    // What start() does before login: warm the static artwork (login itself takes longer).
    await Promise.all([warmCasinoArtwork(), warmFloorArt()]);
    this.app.recover();
    this.app.settings.setLobby(this.guildId, this.casino, null);
    this.app.settings.set(this.guildId, 'poker.enabled', true);
    this.app.settings.set(this.guildId, 'tables.maxTables', 25);
    this.app.settings.set(this.guildId, 'economy.startingBalance', 5_000);
    await this.bot.onReady('Emerald Room#0000');
    await this.quiet(() => !!this.lobbyMessageId());
  }

  user(name: string): FakeUser {
    const u = this.fd.user(name);
    this.app.economy.ensurePlayer(this.guildId, u.id, name);
    // Old enough to gift; passive income waiting to be collected.
    this.app.db.run('UPDATE players SET created_at = ?, passive_anchor_at = ? WHERE guild_id = ? AND user_id = ?', [Date.now() - 3 * 86_400_000, Date.now() - 2 * 3_600_000, this.guildId, u.id]);
    return u;
  }

  lobbyMessageId(): string | null {
    return this.app.settings.lobby(this.guildId).messageId;
  }

  private panelsBusy(): boolean {
    const slots = (p: unknown) => [...((p as { slots: Map<string, { running: boolean; pending: unknown }> }).slots.values())];
    return [this.bot.tablePanels, this.bot.wheelPanels, this.bot.pokerPanels].some((p) => slots(p).some((s) => s.running || s.pending));
  }

  /** Wait until nothing is happening (lobby debounce excluded) and `until` holds. */
  async quiet(until: () => boolean = () => true, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let calm = 0;
    while (Date.now() < deadline) {
      const busy = this.inflight > 0 || (this.bot as unknown as { inflight: Set<unknown> }).inflight.size > 0 || this.panelsBusy() || !until();
      calm = busy ? 0 : calm + 1;
      if (calm >= 3) return;
      await sleep(10);
    }
    throw new Error('bench: did not settle');
  }

  panel(messageId: string | null | undefined): FakeMessage {
    const m = messageId ? this.fd.messages.get(messageId) : undefined;
    if (!m || m.deleted) throw new Error('bench: panel missing');
    return m;
  }
}

// ───────────────────────────── per-interaction samples ─────────────────────────────

interface Sample {
  name: string;
  pass: number;
  ackMs: number | null;
  firstMs: number | null;
  finalMs: number | null;
  /** final minus deliberate waits (GIF holds sent in the window, the solo deal delay). */
  finalNetMs: number | null;
  /** For the first deal: the deal animation reaching the table panel. */
  extraMs: number | null;
  requests: number;
  kbUp: number;
  uploads: number;
  lobbyEdits: number;
  routes: string[];
  renderMs: number;
  gifEncodeMs: number;
  errors: string[];
}

const VISIBLE_CALLBACKS = new Set([4, 7, 9]);
const isWrite = (r: Req) =>
  (r.callbackType !== null && VISIBLE_CALLBACKS.has(r.callbackType))
  || (r.route.startsWith('/webhooks/') && (r.method === 'PATCH' || r.method === 'POST'))
  || (r.messageId !== null && r.method === 'PATCH')
  || (r.channelId !== null && /\/messages$/.test(r.route) && r.method === 'POST');

const samples: Sample[] = [];

interface Step {
  name: string;
  pass: number;
  /** Dispatch the interaction (synchronously, like a real click). */
  act: () => InteractionRecord;
  until?: () => boolean;
  /** Deliberate wait to subtract from final (ms). */
  waitMs?: number;
  /** A later milestone in ms (e.g. the deal reaching the panel), computed from the window's writes. */
  extra?: (writes: Req[], rec: InteractionRecord, t0: number) => number | undefined;
}

async function measure(w: World, step: Step): Promise<InteractionRecord> {
  const mark = w.log.length;
  const sentMark = w.sent.length;
  const render0 = renderStats.pngMs + renderStats.gifRasterMs + renderStats.gifEncodeMs;
  const encode0 = renderStats.gifEncodeMs;
  const t0 = performance.now();
  const rec = step.act();
  await w.quiet(step.until);
  const lobby = w.lobbyMessageId();
  const window = w.log.slice(mark).filter((r) => r.start >= t0 - 1);
  const own = window.filter((r) => !(lobby && r.messageId === lobby));
  const writes = own.filter(isWrite);
  const ack = own.find((r) => r.interactionId === rec.id);
  const holds = w.sent.slice(sentMark).reduce((n, s) => n + (s.holdMs ?? 0), 0);
  const final = writes.at(-1);
  const extra = step.extra?.(writes, rec, t0);
  samples.push({
    name: step.name,
    pass: step.pass,
    ackMs: ack ? ack.end - t0 : null,
    firstMs: writes[0] ? writes[0].end - t0 : null,
    finalMs: final ? final.end - t0 : null,
    finalNetMs: final ? final.end - t0 - holds - (step.waitMs ?? 0) : null,
    extraMs: extra ?? null,
    requests: own.length,
    kbUp: own.reduce((n, r) => n + r.bytes, 0) / 1024,
    uploads: own.filter((r) => r.files.length).length,
    lobbyEdits: window.length - own.length,
    routes: own.map((r) => `${r.method} ${r.route.replace(/\d{15,}/g, ':id')}${r.callbackType !== null ? ` t${r.callbackType}` : ''}${r.files.length ? ` +${r.files.length}f` : ''}`),
    renderMs: renderStats.pngMs + renderStats.gifRasterMs + renderStats.gifEncodeMs - render0,
    gifEncodeMs: renderStats.gifEncodeMs - encode0,
    errors: [...rec.errors],
  });
  return rec;
}

const seen = (w: World, rec: InteractionRecord): FakeMessage => {
  const m = w.fd.seen(rec);
  if (!m) throw new Error(`bench: no response for ${rec.customId ?? rec.kind} (${rec.errors.join('; ')})`);
  return m;
};

const hasButton = (m: FakeMessage, match: RegExp) => buttonsOf(m).some((b) => !b.disabled && (match.test(b.label ?? '') || match.test(b.custom_id ?? '')));
const buttonId = (m: FakeMessage, match: RegExp) => {
  const b = buttonsOf(m).find((x) => !x.disabled && (match.test(x.label ?? '') || match.test(x.custom_id ?? '')));
  if (!b?.custom_id) throw new Error(`bench: no button ${String(match)} (have ${buttonsOf(m).map((x) => x.label).join(', ')})`);
  return b.custom_id;
};

// ───────────────────────────── the solo scenario (one pass) ─────────────────────────────

async function pass(w: World, p: number, organizer: FakeUser, eventId: string): Promise<void> {
  const fd = w.fd;
  const a = w.user(`A${p}`);
  const b = w.user(`B${p}`);
  const m = async (name: string, act: () => InteractionRecord, extra: Partial<Step> = {}) => measure(w, { name, pass: p, act, ...extra });

  // Navigation (one private panel, updated in place).
  const home = seen(w, await m('/casino', () => fd.slash(a, w.casino, 'casino')));
  await m('Games', () => fd.clickRaw(a, home, NAV.games));
  await m('Wallet', () => fd.clickRaw(a, home, NAV.wallet));
  await m('Home', () => fd.clickRaw(a, home, NAV.home));
  await m('Profile', () => fd.clickRaw(a, home, NAV.profile));
  await m('Leaderboards', () => fd.clickRaw(a, home, NAV.leaderboard));
  await m('Match history', () => fd.clickRaw(a, home, cid('nav', 'matches')));
  await m('Games (again)', () => fd.clickRaw(a, home, NAV.games));
  await m('Rules', () => fd.select(a, home, 'nav:rules', ['blackjack']));
  await m('Back to Games', () => fd.clickRaw(a, home, NAV.floor));
  await m('Events', () => fd.clickRaw(a, home, NAV.events));
  await m('My table', () => fd.clickRaw(a, home, NAV.myTable));
  await m('Games (3rd)', () => fd.clickRaw(a, home, NAV.games));
  await m('Blackjack list', () => fd.click(a, home, 'Blackjack'));
  await m('Games (back)', () => fd.clickRaw(a, home, NAV.games));
  await m('Hold’em list', () => fd.click(a, home, 'Hold’em'));

  // Economy.
  await m('Home (for rewards)', () => fd.clickRaw(a, home, NAV.home));
  await m('Collect', () => fd.clickRaw(a, home, cid('eco', 'passive', 'home')));
  await m('Daily', () => fd.clickRaw(a, home, cid('eco', 'daily', 'home')));
  await m('Wallet (for gifting)', () => fd.clickRaw(a, home, NAV.wallet));
  await m('Gifting open', () => fd.clickRaw(a, home, cid('nav', 'gifting')));
  const pick = await m('Gift recipient (modal)', () => fd.select(a, home, 'gift:pick', [b.id]));
  await m('Gift amount submit', () => fd.submitModal(a, pick, { amount: '25' }));
  await m('Gift confirm', () => fd.click(a, home, 'Confirm gift'));
  // Relief: a separate empty account (rewards switched off just for its creation).
  const settings = w.app.settings;
  const economy = { ...settings.get(w.guildId).economy };
  settings.set(w.guildId, 'economy.startingBalance', 0);
  settings.set(w.guildId, 'economy.passivePerHour', 0);
  settings.set(w.guildId, 'economy.dailyReward', 0);
  const poor = w.fd.user(`Poor${p}`);
  const wallet = seen(w, await m('/wallet', () => fd.slash(poor, w.casino, 'wallet')));
  await m('Relief', () => fd.clickRaw(poor, wallet, cid('eco', 'relief', 'wallet')));
  settings.set(w.guildId, 'economy.startingBalance', economy.startingBalance);
  settings.set(w.guildId, 'economy.passivePerHour', economy.passivePerHour);
  settings.set(w.guildId, 'economy.dailyReward', economy.dailyReward);
  // Events.
  await m('Events (for register)', () => fd.clickRaw(a, home, NAV.events));
  await m('Event register', () => fd.clickRaw(a, home, cid('evt', 'join', eventId)));
  await measure(w, { name: 'Event withdraw', pass: p, act: () => fd.clickRaw(a, home, cid('evt', 'leave', eventId)) });
  void organizer;

  // Blackjack.
  await m('Games (for blackjack)', () => fd.clickRaw(a, home, NAV.games));
  await m('Blackjack list (2)', () => fd.click(a, home, 'Blackjack'));
  const opener = await m('BJ create (modal)', () => fd.click(a, home, 'Open a Blackjack table'));
  await m('BJ create (table + thread)', () => fd.submitModal(a, opener, { name: `Bench ${p}`, visibility: 'public' }));
  const table = w.app.blackjack.tableOfUser(w.guildId, a.id);
  if (!table) throw new Error(`bench: no table (${opener.errors.join('; ')})`);
  const tableId = table.record.id;
  const panel = () => w.panel(w.app.blackjack.peek(tableId)?.record.messageId);
  const bHome = seen(w, await measure(w, { name: '/casino (B)', pass: p, act: () => fd.slash(b, w.casino, 'casino') }));
  await m('BJ join', () => fd.clickRaw(b, bHome, cid('tbl', 'join', tableId)));
  await m('BJ leave', () => fd.click(b, panel(), 'Leave'));
  // A solo hand: 8,8 against a dealer 6 (hole 10). Split; double the first hand, hit the second, stand.
  await w.app.blackjack.debugSetShoe(tableId, ['8S', '6D', '8H', 'TS', '3C', '9H', '2D', 'TC', '5S', '9D', 'KD', '4H'] as Card[]);
  const phase = () => w.app.blackjack.peek(tableId)?.state.phase;
  await m('BJ bet → first deal (solo)', () => fd.click(a, panel(), '25'), {
    until: () => phase() === 'playing',
    waitMs: SOLO_DEAL_DELAY_MS,
    // The deal reaching the table panel (the bet's own update answers the click first).
    extra: (writes, rec, t0) => {
      const deal = writes.find((r) => r.messageId === panel().id && r.interactionId !== rec.id);
      return deal ? deal.end - t0 : undefined;
    },
  });
  const can = (label: string) => phase() === 'playing' && hasButton(panel(), new RegExp(`^${label}$`));
  if (can('Split')) await m('BJ split', () => fd.click(a, panel(), 'Split'));
  if (can('Double')) await m('BJ double', () => fd.click(a, panel(), 'Double'));
  if (can('Hit')) await m('BJ hit', () => fd.click(a, panel(), 'Hit'));
  for (let guard = 0; guard < 6 && can('Stand'); guard++) {
    await m('BJ stand', () => fd.click(a, panel(), 'Stand'));
    if (phase() === 'betting') samples.at(-1)!.name = 'BJ stand (dealer + payout)';
  }
  await measure(w, { name: 'BJ close', pass: p, act: () => fd.clickRaw(a, panel(), cid('bj', 'close', tableId)), until: () => !w.app.blackjack.peek(tableId) });

  // Hold'em heads-up: A opens, B joins, A deals; A calls, B checks; B bets on the flop, A folds.
  await m('Games (for holdem)', () => fd.clickRaw(a, home, NAV.games));
  await m('Hold’em list (2)', () => fd.click(a, home, 'Hold’em'));
  const pkOpen = await m('PK create (modal)', () => fd.click(a, home, 'Open a Hold’em table'));
  await m('PK create (table + thread)', () => fd.submitModal(a, pkOpen, { name: `Oak ${p}`, visibility: ['public'], seats: '6', buyin: '200' }));
  const pk = w.app.poker.tableOfUser(w.guildId, a.id);
  if (!pk) throw new Error(`bench: no poker table (${pkOpen.errors.join('; ')})`);
  const pkId = pk.record.id;
  const pkPanel = () => w.panel(w.app.poker.peek(pkId)?.record.messageId);
  const join = await m('PK join (modal)', () => fd.click(b, pkPanel(), 'Take a seat'));
  await m('PK join', () => fd.submitModal(b, join, { buyin: '200' }));
  const aView = seen(w, await m('PK deal (host)', () => fd.click(a, pkPanel(), 'Deal (host)'), { until: () => !!w.app.poker.peek(pkId)?.state.hand }));
  const bView = seen(w, await m('PK my hand', () => fd.click(b, pkPanel(), 'My hand')));
  const actor = () => {
    const hand = w.app.poker.peek(pkId)?.state.hand;
    const seat = hand?.seats.find((s) => s.seat === hand.actor);
    return seat?.userId === a.id ? { user: a, view: aView, other: { user: b, view: bView } } : { user: b, view: bView, other: { user: a, view: aView } };
  };
  // Preflop: the small blind calls, the big blind checks its option.
  const sb = actor();
  await m('PK call', () => fd.click(sb.user, sb.view, /^Call/));
  await m('PK refresh', () => fd.clickRaw(sb.other.user, sb.other.view, cid('pk', 'hand', pkId)));
  await m('PK check', () => fd.click(sb.other.user, sb.other.view, 'Check'));
  // Flop: the first player bets, the other refreshes and folds.
  const first = actor();
  if (!hasButton(first.view, /^pk:raise/)) await m('PK refresh', () => fd.clickRaw(first.user, first.view, cid('pk', 'hand', pkId)));
  await m('PK raise (bet)', () => fd.clickRaw(first.user, first.view, buttonId(first.view, /^pk:raise/)));
  await m('PK refresh', () => fd.clickRaw(first.other.user, first.other.view, cid('pk', 'hand', pkId)));
  await m('PK fold', () => fd.click(first.other.user, first.other.view, 'Fold'), { until: () => !w.app.poker.peek(pkId)?.state.hand });
  await measure(w, { name: 'PK close', pass: p, act: () => fd.clickRaw(a, aView, cid('pk', 'close', pkId)), until: () => !w.app.poker.peek(pkId) });

  // Roulette: open the wheel, bet on red, vote to spin.
  await m('Games (for roulette)', () => fd.clickRaw(a, home, NAV.games));
  await m('Roulette open', () => fd.click(a, home, 'Roulette'));
  const wheel = w.app.roulette.wheelFor(w.guildId);
  if (!wheel?.record.messageId) throw new Error('bench: no wheel');
  const wheelId = wheel.record.id;
  const wheelPanel = () => w.panel(w.app.roulette.peek(wheelId)?.record.messageId);
  const betModal = await m('Roulette bet (modal)', () => fd.select(a, wheelPanel(), 'rl:bet', ['red']));
  await m('Roulette bet', () => fd.submitModal(a, betModal, { amount: '25' }));
  const roundId = w.app.roulette.peek(wheelId)!.state.roundId;
  let spinDue = 0;
  const wheelMessage = wheelPanel().id;
  await m('Roulette vote → spin', () => fd.click(a, wheelPanel(), 'Ready'), {
    until: () => {
      const s = w.app.roulette.peek(wheelId)?.state;
      if (s && s.roundId === roundId) spinDue = rouletteSpinAt(s) ?? spinDue;
      return !s || s.roundId !== roundId;
    },
    // The spin can't start before the minimum ready time: the spin animation, counted from when it was due.
    extra: (writes) => {
      const due = spinDue - performance.timeOrigin;
      const spin = writes.find((r) => r.messageId === wheelMessage && r.end > due && r.files.some((f) => f.endsWith('.gif')));
      return spin ? spin.end - due : undefined;
    },
  });

  // Slots.
  await m('Games (for slots)', () => fd.clickRaw(a, home, NAV.games));
  await m('Slots open', () => fd.click(a, home, 'Slots'));
  await m('Slots spin', () => fd.click(a, home, /^Spin/));

  // Coinflip: A challenges B, B accepts.
  const challenge = seen(w, await m('Coinflip challenge', () => fd.slash(a, w.casino, 'coinflip', { args: [{ name: 'player', type: 'user', value: b.id }, { name: 'stake', type: 'integer', value: 25 }] })));
  const duel = w.fd.channelMessages(w.casino).filter((x) => hasButton(x, /^Accept/)).at(-1) ?? challenge;
  await m('Coinflip accept', () => fd.click(b, duel, /^Accept/));
}

// ───────────────────────────── the concurrent scenario ─────────────────────────────

interface Live { name: string; rec: InteractionRecord; at: number }

async function concurrent(w: World): Promise<Record<string, unknown>> {
  const fd = w.fd;
  const live: Live[] = [];
  let missed = 0;
  /** Press something; a control that isn't on screen yet (panel mid-update) is simply missed. */
  const fire = (name: string, press: () => InteractionRecord): InteractionRecord | null => {
    const at = performance.now();
    try {
      const rec = press();
      live.push({ name, rec, at });
      return rec;
    } catch {
      missed++;
      return null;
    }
  };
  const think = () => sleep(300 + Math.floor(Math.random() * 500));
  let running = true;

  // Two five-seat Blackjack tables.
  const bjTables: Array<{ id: string; players: FakeUser[] }> = [];
  for (let t = 0; t < 2; t++) {
    const players = Array.from({ length: 5 }, (_, i) => w.user(`T${t}P${i}`));
    const opened = fd.slash(players[0]!, w.casino, 'casino');
    await w.quiet();
    const home = seen(w, opened);
    fd.clickRaw(players[0]!, home, NAV.games); await w.quiet();
    fd.click(players[0]!, home, 'Blackjack'); await w.quiet();
    const opener = fd.click(players[0]!, home, 'Open a Blackjack table'); await w.quiet();
    fd.submitModal(players[0]!, opener, { name: `Rush ${t}`, visibility: 'public' }); await w.quiet();
    bjTables.push({ id: w.app.blackjack.tableOfUser(w.guildId, players[0]!.id)!.record.id, players });
  }
  // A four-seat Hold'em table.
  const pkPlayers = Array.from({ length: 4 }, (_, i) => w.user(`H${i}`));
  {
    const rec = fd.slash(pkPlayers[0]!, w.casino, 'casino'); await w.quiet();
    const home = seen(w, rec);
    fd.clickRaw(pkPlayers[0]!, home, NAV.games); await w.quiet();
    fd.click(pkPlayers[0]!, home, 'Hold’em'); await w.quiet();
    const opener = fd.click(pkPlayers[0]!, home, 'Open a Hold’em table'); await w.quiet();
    fd.submitModal(pkPlayers[0]!, opener, { name: 'Oak', visibility: ['public'], seats: '6', buyin: '400' }); await w.quiet();
  }
  const pkId = w.app.poker.tableOfUser(w.guildId, pkPlayers[0]!.id)!.record.id;
  const pkPanel = () => w.panel(w.app.poker.peek(pkId)?.record.messageId);
  for (const p of pkPlayers.slice(1)) {
    const modal = fd.click(p, pkPanel(), 'Take a seat'); await w.quiet();
    fd.submitModal(p, modal, { buyin: '400' }); await w.quiet();
  }
  // The wheel.
  const rouletteUsers = Array.from({ length: 10 }, (_, i) => w.user(`R${i}`));
  {
    const rec = fd.slash(rouletteUsers[0]!, w.casino, 'roulette'); await w.quiet();
    void rec;
  }
  const wheelId = w.app.roulette.wheelFor(w.guildId)!.record.id;
  const wheelPanel = () => w.panel(w.app.roulette.peek(wheelId)?.record.messageId);
  // Browsers: players flicking between screens during the rounds.
  const browsers = Array.from({ length: 5 }, (_, i) => w.user(`V${i}`));
  const browserHomes: FakeMessage[] = [];
  for (const v of browsers) {
    const rec = fd.slash(v, w.casino, 'casino'); await w.quiet();
    browserHomes.push(seen(w, rec));
  }
  await w.quiet();

  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  loopDelay.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const mark = w.log.length;
  const render0 = { ...renderStats };
  let rssPeak = process.memoryUsage().rss;
  const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 200);

  const blackjackActor = async (t: { id: string; players: FakeUser[] }, rounds: number) => {
    const panel = () => w.panel(w.app.blackjack.peek(t.id)?.record.messageId);
    for (let r = 0; r < rounds; r++) {
      while (w.app.blackjack.peek(t.id)?.state.phase !== 'betting') await sleep(50);
      for (const p of t.players) {
        // A press can miss while the panel is mid-update; players press again.
        for (let tries = 0; tries < 20 && w.app.blackjack.peek(t.id)?.state.bets[p.id] === undefined; tries++) {
          if (fire('BJ bet', () => fd.click(p, panel(), ['10', '25', '100'][r % 3]!))) await sleep(250);
          else await sleep(60);
        }
        await sleep(80);
      }
      // The deal starts shortly after everyone has bet.
      for (let wait = 0; wait < 200 && w.app.blackjack.peek(t.id)?.state.phase === 'betting'; wait++) await sleep(50);
      for (let guard = 0; guard < 400; guard++) {
        const s = w.app.blackjack.peek(t.id)?.state;
        if (!s) return;
        if (s.phase === 'betting') break;
        if (s.phase === 'insurance') {
          for (const seat of s.round!.seats.filter((x) => x.insurance.decision === 'pending')) {
            fire('BJ insurance', () => fd.click(t.players.find((p) => p.id === seat.userId)!, panel(), 'No insurance'));
          }
          await sleep(400);
          continue;
        }
        if (s.phase !== 'playing' || !s.round?.turn) { await sleep(60); continue; }
        const seat = s.round.seats[s.round.turn.seat]!;
        const player = t.players.find((p) => p.id === seat.userId)!;
        await think();
        const now = w.app.blackjack.peek(t.id)?.state;
        if (now?.round?.seq !== s.round.seq) continue;
        const message = panel();
        const label = hasButton(message, /^Hit$/) && Math.random() < 0.4 ? 'Hit' : 'Stand';
        if (!hasButton(message, new RegExp(`^${label}$`))) { await sleep(60); continue; }
        fire(`BJ ${label.toLowerCase()}`, () => fd.click(player, message, label));
        await sleep(120);
      }
    }
  };

  const pokerActor = async (hands: number) => {
    for (let h = 0; h < hands; h++) {
      while (w.app.poker.peek(pkId)?.state.hand) await sleep(80);
      await sleep(300);
      const host = pkPlayers[0]!;
      fire('PK deal', () => fd.click(host, pkPanel(), 'Deal (host)'));
      await sleep(200);
      for (let guard = 0; guard < 120 && w.app.poker.peek(pkId)?.state.hand; guard++) {
        const hand = w.app.poker.peek(pkId)!.state.hand!;
        const turn = hand.seats.find((s) => s.seat === hand.actor);
        if (!turn) { await sleep(80); continue; }
        const player = pkPlayers.find((p) => p.id === turn.userId)!;
        await think();
        const view = fire('PK my hand', () => fd.click(player, pkPanel(), 'My hand'));
        if (!view) continue;
        for (let wait = 0; wait < 200 && w.fd.seen(view) === null; wait++) await sleep(20);
        const msg = w.fd.seen(view);
        if (!msg) continue;
        const choice = hasButton(msg, /^Check$/) ? 'Check' : hasButton(msg, /^Call/) ? /^Call/ : null;
        if (!choice) continue;
        await think();
        fire(typeof choice === 'string' ? 'PK check' : 'PK call', () => fd.click(player, msg, choice));
        await sleep(150);
      }
    }
  };

  const rouletteActor = async (spins: number) => {
    for (let s = 0; s < spins; s++) {
      const roundId = w.app.roulette.peek(wheelId)!.state.roundId;
      const modals: Array<[FakeUser, InteractionRecord | null]> = [];
      for (const u of rouletteUsers) {
        modals.push([u, fire('Roulette bet (modal)', () => fd.select(u, wheelPanel(), 'rl:bet', [['red', 'black', 'odd', 'even'][Math.floor(Math.random() * 4)]!]))]);
        await sleep(60);
      }
      await sleep(400);
      for (const [u, modal] of modals) {
        if (modal?.modal) fire('Roulette bet', () => fd.submitModal(u, modal, { amount: '20' }));
        await sleep(90);
      }
      await sleep(600);
      for (const u of rouletteUsers.slice(0, 7)) {
        const panel = wheelPanel();
        if (hasButton(panel, /^Ready$/)) fire('Roulette vote', () => fd.click(u, panel, 'Ready'));
        await sleep(120);
      }
      while (w.app.roulette.peek(wheelId)?.state.roundId === roundId) await sleep(100);
      await sleep(300);
    }
  };

  const browserActor = async (v: FakeUser, home: FakeMessage) => {
    const targets = [NAV.games, NAV.wallet, NAV.home, NAV.games, NAV.leaderboard, NAV.wallet];
    for (let k = 0; running; k++) {
      const target = targets[k % targets.length]!;
      fire(target === NAV.games ? 'Games (during rounds)' : target === NAV.wallet ? 'Wallet (during rounds)' : 'Other nav (during rounds)', () => fd.clickRaw(v, home, target));
      await sleep(900 + Math.floor(Math.random() * 900));
    }
  };

  const browsing = browsers.map((v, i) => browserActor(v, browserHomes[i]!));
  await Promise.all([blackjackActor(bjTables[0]!, 3), blackjackActor(bjTables[1]!, 3), pokerActor(3), rouletteActor(2)]);
  running = false;
  await Promise.all(browsing);
  await w.quiet(() => true, 60_000);
  const wallMs = performance.now() - t0;
  clearInterval(rssTimer);
  loopDelay.disable();
  const cpu = process.cpuUsage(cpu0);
  const window = w.log.slice(mark);

  // Per-interaction latency, attributed by interaction id.
  const byName = new Map<string, { ack: number[]; response: number[]; errors: number }>();
  for (const l of live) {
    const own = window.filter((r) => r.interactionId === l.rec.id);
    const ack = own[0];
    const response = own.find((r) => (r.callbackType !== null && VISIBLE_CALLBACKS.has(r.callbackType)) || (r.route.startsWith('/webhooks/') && r.method !== 'GET'));
    const e = byName.get(l.name) ?? { ack: [], response: [], errors: 0 };
    if (ack) e.ack.push(ack.end - l.at);
    if (response) e.response.push(response.end - l.at);
    e.errors += l.rec.errors.length;
    byName.set(l.name, e);
  }
  // Discord applies per-channel write limits: the busiest 5-second window per channel.
  const writes = new Map<string, number[]>();
  for (const r of window) if (r.channelId && r.method !== 'GET') writes.set(r.channelId, [...(writes.get(r.channelId) ?? []), r.end]);
  const peaks: Record<string, number> = {};
  for (const [channel, list] of writes) {
    list.sort((x, y) => x - y);
    let peak = 0;
    for (let i = 0, j = 0; i < list.length; i++) {
      while (list[i]! - list[j]! > 5_000) j++;
      peak = Math.max(peak, i - j + 1);
    }
    peaks[channel === w.casino ? '#casino' : `thread …${channel.slice(-4)}`] = peak;
  }
  const kinds: Record<string, number> = {};
  for (const r of window) {
    const k = r.callbackType !== null ? `callback t${r.callbackType}` : r.route.startsWith('/webhooks/') ? `webhook ${r.method}` : `${r.method} ${r.route.replace(/\d{15,}/g, ':id')}`;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  const lobby = w.lobbyMessageId();
  // Message edits identical to the previous edit of the same message (nothing visible changed).
  const lastDigest = new Map<string, string | null>();
  let unchangedEdits = 0;
  let unchangedLobbyEdits = 0;
  for (const r of window) {
    if (!r.messageId || r.method !== 'PATCH') continue;
    if (lastDigest.get(r.messageId) === r.digest) {
      unchangedEdits++;
      if (r.messageId === lobby) unchangedLobbyEdits++;
    }
    lastDigest.set(r.messageId, r.digest);
  }
  return {
    wallMs: Math.round(wallMs),
    interactions: live.length,
    missedPresses: missed,
    latency: Object.fromEntries([...byName].map(([k, v]) => [k, { n: v.ack.length, ack: stats(v.ack), response: stats(v.response), errors: v.errors }])),
    requests: window.length,
    requestsPerSec: +(window.length / (wallMs / 1000)).toFixed(1),
    uploadsKb: Math.round(window.reduce((n, r) => n + r.bytes, 0) / 1024),
    uploads: window.filter((r) => r.files.length).length,
    lobbyEdits: window.filter((r) => lobby && r.messageId === lobby).length,
    unchangedEdits,
    unchangedLobbyEdits,
    maxInflight: w.maxInflight,
    peakWritesPer5sByChannel: peaks,
    requestKinds: kinds,
    eventLoopMs: { p50: +(loopDelay.percentile(50) / 1e6).toFixed(1), p99: +(loopDelay.percentile(99) / 1e6).toFixed(1), max: +(loopDelay.max / 1e6).toFixed(1) },
    cpuPct: +(((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(1),
    rssPeakMb: Math.round(rssPeak / 1048576),
    render: {
      png: renderStats.png - render0.png, pngMs: Math.round(renderStats.pngMs - render0.pngMs),
      gif: renderStats.gif - render0.gif, gifRasterMs: Math.round(renderStats.gifRasterMs - render0.gifRasterMs),
      gifEncodeMs: Math.round(renderStats.gifEncodeMs - render0.gifEncodeMs), gifEncodeMaxMs: Math.round(renderStats.gifEncodeMaxMs),
    },
    panels: { table: w.bot.tablePanels.stats, poker: w.bot.pokerPanels.stats, wheel: w.bot.wheelPanels.stats },
    problems: w.fd.problems.slice(0, 10),
  };
}

// ───────────────────────────── reporting ─────────────────────────────

function stats(list: number[]): { median: number; p95: number; max: number } | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
  return { median: at(0.5), p95: at(0.95), max: Math.round(s.at(-1)!) };
}

function summarize(list: Sample[]) {
  const names = [...new Set(list.map((s) => s.name))];
  return names.map((name) => {
    const rows = list.filter((s) => s.name === name);
    const pick = (f: (s: Sample) => number | null) => stats(rows.map(f).filter((x): x is number => x !== null));
    const avg = (f: (s: Sample) => number) => +(rows.reduce((n, s) => n + f(s), 0) / rows.length).toFixed(1);
    return {
      name,
      n: rows.length,
      ack: pick((s) => s.ackMs),
      first: pick((s) => s.firstMs),
      final: pick((s) => s.finalMs),
      finalNet: pick((s) => s.finalNetMs),
      extra: pick((s) => s.extraMs),
      requests: avg((s) => s.requests),
      kbUp: avg((s) => s.kbUp),
      uploads: avg((s) => s.uploads),
      lobbyEdits: avg((s) => s.lobbyEdits),
      renderMs: avg((s) => s.renderMs),
      gifEncodeMs: avg((s) => s.gifEncodeMs),
      errors: rows.reduce((n, s) => n + s.errors.length, 0),
      routes: rows.at(-1)!.routes,
    };
  });
}

function table(rows: ReturnType<typeof summarize>): string {
  const f = (x: { median: number; p95: number; max: number } | null) => (x ? `${x.median}/${x.p95}/${x.max}` : '-');
  const lines = [`${'interaction'.padEnd(30)} ${'n'.padStart(3)} ${'ack'.padStart(15)} ${'first'.padStart(15)} ${'final'.padStart(16)} ${'final-net'.padStart(15)} req   KB  up  render gifEnc err`];
  for (const r of rows) {
    lines.push(`${r.name.padEnd(30)} ${String(r.n).padStart(3)} ${f(r.ack).padStart(15)} ${f(r.first).padStart(15)} ${f(r.final).padStart(16)} ${f(r.finalNet).padStart(15)} ${String(r.requests).padStart(4)} ${String(r.kbUp).padStart(5)} ${String(r.uploads).padStart(3)} ${String(r.renderMs).padStart(6)} ${String(r.gifEncodeMs).padStart(5)} ${r.errors}`
      + (r.extra ? `  extra ${f(r.extra)}` : ''));
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cpuNote = opt('cpu-note', '');
  const w = new World();
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const bootStart = performance.now();
  await w.boot();
  const bootMs = performance.now() - bootStart;
  const result: Record<string, unknown> = { label: LABEL, scenario: SCENARIO, latencyMs: LATENCY, uploadMs: UPLOAD_MS, cpuNote, node: process.version, at: new Date().toISOString(), bootMs: Math.round(bootMs) };

  if (SCENARIO === 'solo') {
    const organizer = w.user('Organizer');
    const eventId = w.app.events.create({ guildId: w.guildId, userId: organizer.id, isAdmin: true }, {
      title: 'Bench night', game: 'poker', private: false, description: 'Benchmark event', startsAt: Date.now() + 26 * 3_600_000, minPlayers: 2, maxPlayers: 6,
    }).id;
    const rss: number[] = [];
    for (let p = 1; p <= PASSES; p++) {
      if (p === 2) loop.reset();
      const t = performance.now();
      await pass(w, p, organizer, eventId);
      rss.push(process.memoryUsage().rss);
      process.stderr.write(`pass ${p}/${PASSES} ${((performance.now() - t) / 1000).toFixed(1)} s\n`);
    }
    const cold = summarize(samples.filter((s) => s.pass === 1));
    const warm = summarize(samples.filter((s) => s.pass > 1));
    result.cold = cold;
    result.warm = warm;
    result.eventLoopWarmMs = { p50: +(loop.percentile(50) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1) };
    result.rssMb = { first: Math.round(rss[0]! / 1048576), last: Math.round(rss.at(-1)! / 1048576), max: Math.round(Math.max(...rss) / 1048576) };
    result.render = { ...renderStats };
    result.problems = w.fd.problems.slice(0, 20);
    result.panels = { table: w.bot.tablePanels.stats, poker: w.bot.pokerPanels.stats, wheel: w.bot.wheelPanels.stats };
    console.log(`\n── cold (pass 1) ──\n${table(cold)}`);
    if (warm.length) console.log(`\n── warm (passes 2..${PASSES}) ── median/p95/max ms\n${table(warm)}`);
    console.log(`\nevent loop (warm) p50 ${(result.eventLoopWarmMs as { p50: number }).p50} ms · p99 ${(result.eventLoopWarmMs as { p99: number }).p99} ms · max ${(result.eventLoopWarmMs as { max: number }).max} ms · rss ${JSON.stringify(result.rssMb)} MB`);
    console.log(`problems: ${w.fd.problems.length}${w.fd.problems.length ? ` (${w.fd.problems.slice(0, 3).join(' | ')})` : ''}`);
  } else {
    result.concurrent = await concurrent(w);
    console.log(JSON.stringify(result.concurrent, null, 2));
  }
  loop.disable();
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ ...result, samples: SCENARIO === 'solo' ? samples : undefined }, null, 1));
  }
  await w.bot.stop().catch(() => undefined);
  await w.app.shutdown().catch(() => undefined);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
