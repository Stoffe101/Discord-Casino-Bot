/**
 * Offline ledger check: opens the database READ-ONLY and verifies every balance against the
 * ledger and escrows. Run only while the bot is stopped (or accept a point-in-time view).
 *   npm run reconcile
 */
import { loadEnvFile, readEnv } from '../config/env.js';
import { DatabaseSync } from '../db/sqlite.js';

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv({ requireToken: false });
  const db = new DatabaseSync(env.databasePath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT p.guild_id, p.user_id, p.balance, p.reserved,
              COALESCE((SELECT SUM(amount) FROM ledger l WHERE l.guild_id = p.guild_id AND l.user_id = p.user_id), 0) AS ledger_sum,
              COALESCE((SELECT SUM(amount) FROM escrows e WHERE e.guild_id = p.guild_id AND e.user_id = p.user_id AND e.status = 'held'), 0) AS held
       FROM players p`,
    )
    .all() as Array<{ guild_id: string; user_id: string; balance: number; reserved: number; ledger_sum: number; held: number }>;
  // Same rules as EconomyService.reconcile(): the ledger sums to the spendable balance, and the
  // reserved amount equals the escrows still held.
  const problems = rows.filter((r) => r.balance < 0 || r.reserved < 0 || r.balance !== r.ledger_sum || r.reserved !== r.held);
  console.log(`${rows.length} players checked · ${problems.length} problems`);
  for (const p of problems) console.log(`  ${p.user_id}: balance ${p.balance} vs ledger ${p.ledger_sum}; reserved ${p.reserved} vs held escrows ${p.held}`);
  db.close();
  process.exitCode = problems.length ? 1 : 0;
}

void main();
