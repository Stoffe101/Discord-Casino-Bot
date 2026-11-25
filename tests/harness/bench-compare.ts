/**
 * Compare two bench-interactions result folders (written by the runner: cold1..N.json, warm.json,
 * concurrent.json) and print baseline vs after tables.
 *
 *   npx tsx tests/harness/bench-compare.ts recordings/perf/baseline recordings/perf/after
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface Sample { name: string; pass: number; ackMs: number | null; firstMs: number | null; finalMs: number | null; finalNetMs: number | null; extraMs: number | null; requests: number; kbUp: number; uploads: number }
type Stats = { median: number; p95: number; max: number } | null;

const [baseDir, afterDir] = process.argv.slice(2);
if (!baseDir || !afterDir) throw new Error('usage: bench-compare <baselineDir> <afterDir>');

function load(dir: string): { cold: Sample[]; warm: Sample[]; concurrent: Record<string, unknown> | null } {
  const cold: Sample[] = [];
  const warm: Sample[] = [];
  for (const file of readdirSync(dir).filter((f) => /^cold\d+\.json$/.test(f))) {
    cold.push(...(JSON.parse(readFileSync(join(dir, file), 'utf8')) as { samples: Sample[] }).samples);
  }
  const w = join(dir, 'warm.json');
  if (existsSync(w)) {
    const samples = (JSON.parse(readFileSync(w, 'utf8')) as { samples: Sample[] }).samples;
    cold.push(...samples.filter((s) => s.pass === 1));
    warm.push(...samples.filter((s) => s.pass > 1));
  }
  const c = join(dir, 'concurrent.json');
  const concurrent = existsSync(c) ? ((JSON.parse(readFileSync(c, 'utf8')) as { concurrent: Record<string, unknown> }).concurrent) : null;
  return { cold, warm, concurrent };
}

function stats(list: number[]): Stats {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
  return { median: at(0.5), p95: at(0.95), max: Math.round(s.at(-1)!) };
}
const fmt = (x: Stats) => (x ? `${x.median}/${x.p95}/${x.max}` : '-');
const avg = (rows: Sample[], f: (s: Sample) => number) => (rows.length ? +(rows.reduce((n, s) => n + f(s), 0) / rows.length).toFixed(1) : 0);

const base = load(baseDir);
const after = load(afterDir);
for (const [label, b, a] of [['warm', base.warm, after.warm], ['cold', base.cold, after.cold]] as const) {
  const names = [...new Set([...b, ...a].map((s) => s.name))];
  console.log(`\n### ${label} (first visible change, median/p95/max ms; n = samples)\n`);
  console.log('| interaction | n | baseline first | after first | baseline final-net | after final-net | req b→a | KB up b→a |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const name of names) {
    const rb = b.filter((s) => s.name === name);
    const ra = a.filter((s) => s.name === name);
    const pick = (rows: Sample[], f: (s: Sample) => number | null) => stats(rows.map(f).filter((x): x is number => x !== null));
    const extra = pick(rb, (s) => s.extraMs) ? ` (milestone ${fmt(pick(rb, (s) => s.extraMs))} → ${fmt(pick(ra, (s) => s.extraMs))})` : '';
    console.log(`| ${name}${extra} | ${rb.length}/${ra.length} | ${fmt(pick(rb, (s) => s.firstMs))} | ${fmt(pick(ra, (s) => s.firstMs))} | ${fmt(pick(rb, (s) => s.finalNetMs))} | ${fmt(pick(ra, (s) => s.finalNetMs))} | ${avg(rb, (s) => s.requests)}→${avg(ra, (s) => s.requests)} | ${avg(rb, (s) => s.kbUp)}→${avg(ra, (s) => s.kbUp)} |`);
  }
}
if (base.concurrent || after.concurrent) {
  console.log('\n### concurrent\n');
  const keys = ['wallMs', 'interactions', 'requests', 'requestsPerSec', 'uploads', 'uploadsKb', 'lobbyEdits', 'unchangedEdits', 'unchangedLobbyEdits', 'maxInflight', 'eventLoopMs', 'cpuPct', 'rssPeakMb', 'render', 'peakWritesPer5sByChannel'];
  for (const k of keys) console.log(`- ${k}: ${JSON.stringify(base.concurrent?.[k])} → ${JSON.stringify(after.concurrent?.[k])}`);
  const lat = (c: Record<string, unknown> | null) => (c?.latency ?? {}) as Record<string, { n: number; response: Stats; ack: Stats }>;
  console.log('\n| interaction (concurrent) | n b/a | baseline response | after response |');
  console.log('|---|---|---|---|');
  for (const name of new Set([...Object.keys(lat(base.concurrent)), ...Object.keys(lat(after.concurrent))])) {
    const x = lat(base.concurrent)[name];
    const y = lat(after.concurrent)[name];
    console.log(`| ${name} | ${x?.n ?? 0}/${y?.n ?? 0} | ${fmt(x?.response ?? null)} | ${fmt(y?.response ?? null)} |`);
  }
}
