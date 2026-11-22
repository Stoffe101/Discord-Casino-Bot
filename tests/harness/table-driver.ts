/**
 * Multi-table driver: N tables × M players playing several hands concurrently through the real
 * Discord surface (FakeDiscord). Hosts open public tables through the "Open a table" modal; the
 * other players press a chip on their table's panel to sit down and bet; turn actions are pressed
 * on the panel by whoever's turn it is. Every table's clicks are dispatched at the same time.
 */
import { performance } from 'node:perf_hooks';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import { availableActions, handValue } from '../../src/games/blackjack/engine.js';
import type { CasinoHarness } from './casino-harness.js';
import type { FakeUser, InteractionRecord } from './fake-discord.js';

export interface DriveOptions {
  tables: number;
  players: number;
  rounds: number;
  /** Simulated network latency per Discord request. */
  latencyMs?: number;
}

export interface DriveReport {
  tables: number;
  players: number;
  handsSettled: number;
  interactions: number;
  ackMs: { p50: number; p95: number; max: number };
  lateAcks: number;
  interactionErrors: string[];
  requests: number;
  requestsByKind: Record<string, number>;
  peakChannelWritesPer5s: number;
  wallMs: number;
  rssMb: { before: number; after: number };
  problems: string[];
  reconcile: string[];
  conserved: boolean;
  openEscrows: number;
  tableIsolation: boolean;
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

export async function driveTables(h: CasinoHarness, options: DriveOptions): Promise<DriveReport> {
  h.fd.latencyMs = options.latencyMs ?? 0;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const interactions: InteractionRecord[] = [];
  const track = (rec: InteractionRecord) => {
    interactions.push(rec);
    return rec;
  };
  const settings = h.app.settings.get(h.guildId);
  if (settings.tables.maxTables < options.tables) h.app.settings.set(h.guildId, 'tables.maxTables', options.tables);
  h.app.settings.set(h.guildId, 'economy.startingBalance', 20_000);

  // Seat everyone (accounts exist up front so chip conservation can be checked from the start).
  const groups: Array<{ tableId: string; players: FakeUser[] }> = [];
  for (let t = 0; t < options.tables; t++) {
    const players = Array.from({ length: options.players }, (_, p) => h.user(`T${t + 1}P${p + 1}`));
    for (const p of players) h.app.economy.ensurePlayer(h.guildId, p.id, p.name);
    const host = players[0]!;
    const home = h.seen(track(await h.slash(host, 'casino')));
    const tablesScreen = h.seen(track(await h.click(host, home, 'Tables')));
    const opener = track(await h.click(host, tablesScreen, 'Open a table'));
    track(await h.submit(host, opener, { name: `Table ${t + 1}`, visibility: 'public' }));
    const tableId = h.app.blackjack.tableOfUser(h.guildId, host.id)?.record.id;
    if (!tableId) throw new Error(`host ${host.name} has no table: ${opener.errors.join(', ')}`);
    groups.push({ tableId, players });
  }
  const startTotal = h.db.get<{ n: number }>('SELECT SUM(balance + reserved) AS n FROM players')!.n;

  for (let round = 0; round < options.rounds; round++) {
    // Everyone bets at once, across all tables (the first bet also seats the non-hosts).
    for (const g of groups) {
      for (const [i, p] of g.players.entries()) track(h.fd.click(p, h.tablePanel(g.tableId), ['10', '25', '100'][(round + i) % 3]!));
    }
    await h.settle();
    await h.advance(ALL_IN_DEAL_DELAY_MS);
    // Play: each step, every table's active player presses one button simultaneously.
    for (let step = 0; step < 400; step++) {
      let busy = false;
      for (const g of groups) {
        const s = h.app.blackjack.peek(g.tableId)!.state;
        if (s.phase === 'insurance') {
          for (const seat of s.round!.seats.filter((x) => x.insurance.decision === 'pending')) {
            const p = g.players.find((x) => x.id === seat.userId)!;
            track(h.fd.click(p, h.tablePanel(g.tableId), 'No insurance'));
          }
          busy = true;
          continue;
        }
        if (s.phase !== 'playing' || !s.round?.turn) continue;
        const seat = s.round.seats[s.round.turn.seat]!;
        const hand = seat.hands[s.round.turn.hand]!;
        const legal = availableActions(s.round, seat.userId);
        const total = handValue(hand.cards).total;
        const move = legal.split && total >= 16 ? 'Split' : legal.double && total >= 10 && total <= 11 ? 'Double' : legal.hit && total < 17 ? 'Hit' : 'Stand';
        const p = g.players.find((x) => x.id === seat.userId)!;
        const panel = h.tablePanel(g.tableId);
        const target = h.buttons(panel).find((b) => b.label === move && !b.disabled) ? move : 'Stand';
        track(h.fd.click(p, panel, target));
        busy = true;
      }
      await h.settle();
      if (!busy) break;
    }
    // A table whose players couldn't all bet waits for its betting window.
    if (groups.some((g) => h.app.blackjack.peek(g.tableId)!.state.phase !== 'betting')) await h.advance(120_000);
  }
  await h.settle();

  const ack = interactions.filter((r) => r.ackedAt !== null).map((r) => r.ackedAt! - r.createdAt).sort((a, b) => a - b);
  const writes = h.fd.log.filter((r) => r.method !== 'GET' && r.route.startsWith('/channels/')).map((r) => r.at).sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < writes.length; i++) {
    while (writes[i]! - writes[j]! > 5_000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const kinds: Record<string, number> = {};
  for (const r of h.fd.log) {
    const kind = r.route.startsWith('/interactions/') ? 'interaction callback' : r.route.startsWith('/webhooks/') ? `webhook ${r.method}` : `${r.method} ${r.route.replace(/\d{15,}/g, ':id')}`;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const endTotal = h.db.get<{ n: number }>('SELECT SUM(balance + reserved) AS n FROM players')!.n;
  const gameNet = h.db.get<{ n: number }>('SELECT COALESCE(SUM(net), 0) AS n FROM round_results')!.n;
  const rewards = h.db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward','mission_reward')")!.n;
  // Isolation: every settled round's seats belong to exactly one table's players.
  const isolation = groups.every((g) => {
    const ids = new Set(g.players.map((p) => p.id));
    return h.app.blackjack.peek(g.tableId)!.state.seats.every((s) => ids.has(s.userId));
  });
  return {
    tables: options.tables,
    players: options.tables * options.players,
    handsSettled: h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE game = 'blackjack' AND status = 'settled'")!.n,
    interactions: interactions.length,
    ackMs: { p50: pct(ack, 0.5), p95: pct(ack, 0.95), max: ack.at(-1) ?? 0 },
    lateAcks: interactions.filter((r) => r.ackedAt === null || r.ackedAt - r.createdAt > 3_000).length,
    interactionErrors: interactions.flatMap((r) => r.errors),
    requests: h.fd.log.length,
    requestsByKind: kinds,
    peakChannelWritesPer5s: peak,
    wallMs: performance.now() - started,
    rssMb: { before: Math.round(rssBefore / 1048576), after: Math.round(process.memoryUsage().rss / 1048576) },
    problems: [...h.fd.problems],
    reconcile: h.app.economy.reconcile().map((x) => JSON.stringify(x)),
    conserved: endTotal - startTotal === gameNet + rewards,
    openEscrows: h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM escrows WHERE status = 'held'")!.n,
    tableIsolation: isolation,
  };
}
