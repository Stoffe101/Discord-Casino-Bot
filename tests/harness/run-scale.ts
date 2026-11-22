/**
 * Scale run through the full Discord stack (in-memory Discord, temp database on disk).
 *   npm run simulate:discord -- --tables 12 --players 5 --rounds 3 --latency 40
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasinoHarness } from './casino-harness.js';
import { driveTables } from './table-driver.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'casino-scale-'));
  const h = new CasinoHarness({ dbPath: join(dir, 'scale.db'), seed: num('seed', 2026) });
  const report = await driveTables(h, { tables: num('tables', 12), players: num('players', 5), rounds: num('rounds', 3), latencyMs: num('latency', 0) });
  const panels = h.bot.tablePanels.stats;
  const latency = h.bot.router.latency;
  await h.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n══════ Discord-stack scale run ══════`);
  console.log(`${report.tables} tables · ${report.players} players · ${report.handsSettled} hands settled · ${(report.wallMs / 1000).toFixed(1)} s`);
  console.log(`interactions ${report.interactions} · ack p50 ${report.ackMs.p50} ms · p95 ${report.ackMs.p95} ms · max ${report.ackMs.max} ms · late/unacked ${report.lateAcks}`);
  console.log(`router handling avg ${(latency.totalMs / Math.max(1, latency.count)).toFixed(1)} ms · max ${latency.maxMs} ms`);
  console.log(`panel renders ${panels.renders} · via click ${panels.viaInteraction} · via REST ${panels.viaRest} · image reused ${panels.reusedImage} · failures ${panels.failures}`);
  console.log(`Discord requests ${report.requests}: ${Object.entries(report.requestsByKind).map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
  console.log(`peak channel writes in any 5 s window: ${report.peakChannelWritesPer5s} (all tables share one channel in test mode)`);
  console.log(`memory rss ${report.rssMb.before} → ${report.rssMb.after} MB`);
  console.log(`ledger ${report.reconcile.length ? `${report.reconcile.length} PROBLEMS` : 'OK'} · chips ${report.conserved ? 'conserved' : 'MISMATCH'} · open escrows ${report.openEscrows} · isolation ${report.tableIsolation ? 'OK' : 'BROKEN'}`);
  console.log(`payload problems ${report.problems.length} · interaction errors ${report.interactionErrors.length}`);
  for (const p of [...report.problems, ...report.interactionErrors].slice(0, 10)) console.log(`  ! ${p}`);
  const healthy = !report.reconcile.length && report.conserved && !report.openEscrows && report.tableIsolation && !report.problems.length && !report.interactionErrors.length && !report.lateAcks;
  process.exit(healthy ? 0 : 1);
}

void main();
