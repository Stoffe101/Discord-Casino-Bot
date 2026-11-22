import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';
import { driveTables, type DriveReport } from '../harness/table-driver.js';

let h: CasinoHarness;
afterEach(async () => {
  await h?.close();
});

function expectHealthy(report: DriveReport, minHands: number) {
  expect(report.interactionErrors).toEqual([]);
  expect(report.problems).toEqual([]);
  expect(report.lateAcks).toBe(0);
  expect(report.reconcile).toEqual([]);
  expect(report.conserved).toBe(true);
  expect(report.openEscrows).toBe(0);
  expect(report.tableIsolation).toBe(true);
  expect(report.handsSettled).toBeGreaterThanOrEqual(minHands);
}

describe('concurrent multi-table play through Discord', () => {
  it('10 players across 2 tables, 3 hands each', async () => {
    h = new CasinoHarness({ seed: 21 });
    const report = await driveTables(h, { tables: 2, players: 5, rounds: 3 });
    expectHealthy(report, 6);
    expect(h.guard!.blockedCount).toBe(0);
  }, 60_000);

  it('20 players across 4 tables with 25 ms network latency, 2 hands each', async () => {
    h = new CasinoHarness({ seed: 22 });
    const report = await driveTables(h, { tables: 4, players: 5, rounds: 2, latencyMs: 25 });
    expectHealthy(report, 8);
    expect(report.ackMs.max).toBeLessThan(3_000);
  }, 120_000);
});
