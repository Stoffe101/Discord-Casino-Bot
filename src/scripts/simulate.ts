/**
 * Headless end-to-end simulation — no Discord connection needed.
 *
 *   npm run simulate                       (4 tables × 5 players × 40 hands, with rendering)
 *   npm run simulate -- --tables 10 --rounds 100 --no-render
 *   npm run simulate -- --crash            (restarts the process state mid-run)
 *
 * Creates players, opens tables, places bets, plays every hand with a simple strategy across
 * all tables concurrently, renders the Discord panels, optionally "crashes" and recovers, and
 * finally verifies the ledger and chip conservation. Prints latency figures measured locally.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Database } from '../db/database.js';
import { ManualClock } from '../core/clock.js';
import { ManualScheduler } from '../core/scheduler.js';
import { Logger } from '../core/logger.js';
import { seededRng } from '../core/random.js';
import { CasinoApp } from '../app/casino-app.js';
import { availableActions, currentTurnUserId, handValue } from '../games/blackjack/engine.js';
import { ALL_IN_DEAL_DELAY_MS } from '../tables/blackjack-table-service.js';
import { blackjackPanel } from '../ui/screens/blackjack.js';
import { validateScreen } from '../ui/validate.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const TABLES = num('tables', 4);
const PER_TABLE = num('players', 5);
const ROUNDS = num('rounds', 40);
const RENDER = !flag('no-render');
const CRASH = flag('crash');
const GUILD = 'sim-guild';

function stats(samples: number[]) {
  if (samples.length === 0) return 'n/a';
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `avg ${avg.toFixed(2)} ms · p50 ${p(0.5).toFixed(2)} · p95 ${p(0.95).toFixed(2)} · max ${sorted.at(-1)!.toFixed(2)} (n=${sorted.length})`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'casino-sim-'));
  const path = join(dir, 'sim.db');
  const logger = new Logger({ level: 'warn' });
  const clock = new ManualClock(Date.now());
  let scheduler = new ManualScheduler(clock);
  let db = new Database(path);
  db.migrate();
  let app = new CasinoApp({ db, logger, clock, scheduler, rng: seededRng(num('seed', 2026)) });
  app.settings.set(GUILD, 'tables.maxTables', Math.max(TABLES, 6));
  const actionMs: number[] = [];
  const renderMs: number[] = [];
  const pngBytes: number[] = [];
  let payloadErrors = 0;

  const players = Array.from({ length: TABLES * PER_TABLE }, (_, i) => `player-${i + 1}`);
  for (const p of players) app.economy.ensurePlayer(GUILD, p, p.replace('player-', 'Player '));
  const startTotal = db.get<{ n: number }>('SELECT SUM(balance + reserved) AS n FROM players')!.n;
  const tableIds: string[] = [];
  for (let t = 0; t < TABLES; t++) {
    const seated = players.slice(t * PER_TABLE, (t + 1) * PER_TABLE);
    const table = await app.blackjack.createTable({ guildId: GUILD, ownerId: seated[0]!, ownerName: seated[0]! });
    for (const p of seated.slice(1)) await app.blackjack.join(table.record.id, p, p);
    tableIds.push(table.record.id);
  }

  const timed = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const t0 = performance.now();
    try {
      return await fn();
    } catch {
      return undefined; // e.g. insufficient funds for a double — the simulation just moves on
    } finally {
      actionMs.push(performance.now() - t0);
    }
  };

  const render = async (tableId: string) => {
    if (!RENDER) return;
    const snap = app.blackjack.peek(tableId);
    if (!snap) return;
    const t0 = performance.now();
    const screen = await blackjackPanel(app, snap);
    renderMs.push(performance.now() - t0);
    pngBytes.push(screen.files?.[0]?.data.length ?? 0);
    payloadErrors += validateScreen(screen).errors.length;
  };

  const started = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    if (CRASH && round === Math.floor(ROUNDS / 2)) {
      // Abandon the running services (no graceful shutdown) and recover from the database file.
      console.log(`… simulated crash before hand ${round + 1}; recovering from ${path}`);
      db.close();
      db = new Database(path);
      db.migrate();
      scheduler = new ManualScheduler(clock);
      app = new CasinoApp({ db, logger, clock, scheduler, rng: seededRng(round) });
      console.log('  recovery:', JSON.stringify(app.recover()));
    }
    // Everyone bets at once on every table.
    await Promise.all(
      tableIds.flatMap((tableId, t) =>
        players.slice(t * PER_TABLE, (t + 1) * PER_TABLE).map((p, i) => timed(() => app.blackjack.placeBet(tableId, p, 10 + ((round + i) % 10) * 25))),
      ),
    );
    clock.advance(ALL_IN_DEAL_DELAY_MS);
    scheduler.runDue();
    await app.blackjack.idle();
    await Promise.all(tableIds.map(render));
    // Play until every table is back to betting.
    for (let step = 0; step < 200; step++) {
      const moves = tableIds.map(async (tableId) => {
        const snap = app.blackjack.peek(tableId);
        if (!snap) return false;
        const { state } = snap;
        if (state.phase === 'insurance') {
          for (const seat of state.round!.seats) {
            if (seat.insurance.decision === 'pending') await timed(() => app.blackjack.decideInsurance(tableId, seat.userId, false));
          }
          return true;
        }
        if (state.phase !== 'playing') return false;
        const round = state.round!;
        const who = currentTurnUserId(round)!;
        const hand = round.seats[round.turn!.seat]!.hands[round.turn!.hand]!;
        const legal = availableActions(round, who);
        const { total } = handValue(hand.cards);
        const move = legal.split && total >= 16 ? 'split' : legal.double && total >= 10 && total <= 11 ? 'double' : legal.hit && total < 17 ? 'hit' : 'stand';
        await timed(() => app.blackjack.act(tableId, who, move, round.seq));
        await render(tableId);
        return true;
      });
      const busy = await Promise.all(moves);
      if (!busy.some(Boolean)) break;
    }
    await Promise.all(tableIds.map(render));
  }
  const elapsed = performance.now() - started;

  const issues = app.economy.reconcile();
  const endTotal = db.get<{ n: number }>('SELECT SUM(balance + reserved) AS n FROM players')!.n;
  const gameNet = db.get<{ n: number }>('SELECT COALESCE(SUM(net), 0) AS n FROM round_results')!.n;
  const rewards = db.get<{ n: number }>("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger WHERE type IN ('achievement_reward','mission_reward')")!.n;
  const held = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM escrows WHERE status = 'held'")!.n;
  const rounds = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_rounds WHERE status = 'settled'")!.n;
  const conserved = endTotal - startTotal === gameNet + rewards;

  console.log('\n══════ Simulation summary ══════');
  console.log(`tables ${TABLES} × ${PER_TABLE} players · ${ROUNDS} hands each · ${rounds} rounds settled in ${(elapsed / 1000).toFixed(1)} s`);
  console.log(`service actions   ${stats(actionMs)}`);
  if (RENDER) {
    console.log(`panel render      ${stats(renderMs)}`);
    console.log(`panel image size  avg ${Math.round(pngBytes.reduce((a, b) => a + b, 0) / Math.max(1, pngBytes.length) / 1024)} KB · image cache ${app.images.hits} hits / ${app.images.misses} renders`);
    console.log(`payload problems  ${payloadErrors}`);
  }
  console.log(`house result      players net ${gameNet >= 0 ? '+' : ''}${gameNet} chips (+${rewards} from achievements/missions)`);
  console.log(`ledger reconcile  ${issues.length === 0 ? 'OK' : `${issues.length} PROBLEMS`}`);
  console.log(`chip conservation ${conserved ? 'OK' : 'MISMATCH'} · open escrows ${held}`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (issues.length || !conserved || held !== 0 || payloadErrors) process.exit(1);
}

void main();
