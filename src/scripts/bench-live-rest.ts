/**
 * Real-Discord REST timing sample for the performance work (development only, test mode required).
 *
 * Like live-bench, but with its own state file (so it never collides with a live-bench run) and
 * focused on what the interaction path pays for: each main screen sent as a fresh upload, then
 * repeated pairs that compare uploading an image, keeping an already-uploaded attachment by id,
 * and an edit with no image at all. One bot message in the allowlisted channel, REST only (no
 * gateway session), every request through the outbound guard, deleted at the end.
 *
 *   node --env-file=../Discord-Casino-Bot/.env --env-file=data/grand-test.env --import tsx src/scripts/bench-live-rest.ts [--reps 4] [--pause 1.2] [--out file.json]
 *   ... --cleanup   → delete a bench message left behind by an interrupted run
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MessageFlags, REST, Routes } from 'discord.js';
import { loadEnvFile, readEnv } from '../config/env.js';
import { Logger } from '../core/logger.js';
import { OutboundGuard, allowlistFromEnv } from '../discord/outbound-guard.js';
import type { Screen } from '../ui/kit.js';
import { buildScreens } from './bench-screens.js';

const STATE_FILE = 'data/bench-perf-message.json';
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Attachment { id: string; filename: string; size: number }
interface Sample { step: string; mode: 'create' | 'upload' | 'keep' | 'keepnamed' | 'omit' | 'none' | 'hidden' | 'upload+keep'; ms: number; kb: number; ok: boolean; note: string }

/** How the message's attachments are treated by an edit. */
type Mode = Sample['mode'];

function body(screen: Screen, mode: Mode, existing: Attachment[]): { body: Record<string, unknown>; files: Array<{ name: string; data: Buffer; contentType: string }> } {
  const base = { components: screen.components, flags: MessageFlags.IsComponentsV2, allowed_mentions: { parse: [] } };
  const wanted = screen.files ?? [];
  if (mode === 'keep') {
    // Keep the attachments this screen references (same file name), upload nothing.
    const keep = existing.filter((a) => wanted.some((f) => f.name === a.filename));
    return { body: { ...base, attachments: keep.map((a) => ({ id: a.id })) }, files: [] };
  }
  if (mode === 'keepnamed') {
    const keep = existing.filter((a) => wanted.some((f) => f.name === a.filename));
    return { body: { ...base, attachments: keep.map((a) => ({ id: a.id, filename: a.filename })) }, files: [] };
  }
  if (mode === 'upload+keep') {
    // Upload this screen's images and keep every attachment already on the message (unreferenced).
    const files = wanted.map((f) => ({ name: f.name, data: Buffer.from(f.data), contentType: 'image/png' }));
    return { body: { ...base, attachments: [...existing.map((a) => ({ id: a.id })), ...wanted.map((f, i) => ({ id: i, filename: f.name }))] }, files };
  }
  if (mode === 'omit') {
    // No attachments field at all: Discord keeps every existing attachment.
    return { body: base, files: [] };
  }
  if (mode === 'hidden') {
    // A screen without images that keeps the previous image on the message, unreferenced.
    return { body: { ...base, attachments: existing.map((a) => ({ id: a.id })) }, files: [] };
  }
  const files = wanted.map((f) => ({ name: f.name, data: Buffer.from(f.data), contentType: f.name.endsWith('.gif') ? 'image/gif' : 'image/png' }));
  return {
    body: { ...base, attachments: wanted.map((f, i) => ({ id: i, filename: f.name, ...(f.description ? { description: f.description.slice(0, 1024) } : {}) })) },
    files,
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv();
  const allow = allowlistFromEnv(process.env, env.clientId);
  if (!allow) {
    console.error('bench-live-rest only runs in test mode (CASINO_TEST_MODE=true with an allowlisted channel).');
    process.exit(1);
  }
  const guard = new OutboundGuard(allow, new Logger({ level: 'warn' }));
  const rest = new REST().setToken(env.token);
  guard.install(rest);
  const channel = allow.channelId;
  const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { messageId: string; channelId: string }) : null;
  const remove = async (messageId: string) => {
    guard.allowDelete(messageId);
    await rest.delete(Routes.channelMessage(channel, messageId)).catch((e: unknown) => console.log('delete:', e instanceof Error ? e.message : e));
    rmSync(STATE_FILE, { force: true });
  };
  if (flag('cleanup')) {
    if (!state || state.channelId !== channel) return console.log('No bench message to delete.');
    await remove(state.messageId);
    return console.log(`Deleted bench message ${state.messageId}.`);
  }
  if (state) throw new Error(`${STATE_FILE} exists: run with --cleanup first.`);
  const target = await rest.get(Routes.channel(channel)) as { guild_id?: string; type?: number };
  if (target.guild_id !== allow.guildId || target.type !== 0) throw new Error('The allowlisted channel must be a text channel in the configured test guild.');

  const screens = new Map(await buildScreens(allow.guildId, channel));
  const get = (name: string) => {
    const s = screens.get(name);
    if (!s) throw new Error(`no screen ${name}`);
    return s;
  };
  const pauseMs = Number(value('pause') ?? 1.2) * 1000;
  const reps = Number(value('reps') ?? 4);
  const samples: Sample[] = [];
  let messageId: string | null = null;
  let attachments: Attachment[] = [];

  const send = async (step: string, screen: Screen, mode: Mode) => {
    const { body: json, files } = body(screen, messageId ? mode : 'upload', attachments);
    const kb = Math.round(files.reduce((n, f) => n + f.data.length, 0) / 1024);
    const t0 = performance.now();
    try {
      const res = (messageId
        ? await rest.patch(Routes.channelMessage(channel, messageId), { body: json, files })
        : await rest.post(Routes.channelMessages(channel), { body: json, files })) as { id: string; attachments: Attachment[] };
      const ms = performance.now() - t0;
      if (!messageId) {
        messageId = res.id;
        mkdirSync(dirname(STATE_FILE), { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify({ messageId, channelId: channel }));
      }
      attachments = res.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size }));
      samples.push({ step, mode: samples.length === 0 ? 'create' : mode, ms, kb, ok: true, note: `attachments after: ${attachments.map((a) => a.filename).join(', ') || 'none'}` });
    } catch (error) {
      const raw = (error as { rawError?: unknown }).rawError;
      samples.push({ step, mode, ms: performance.now() - t0, kb, ok: false, note: `${error instanceof Error ? error.message : String(error)} ${raw ? JSON.stringify(raw).slice(0, 300) : ''}` });
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  };

  try {
    if (flag('sticky-probe')) {
      await send('games upload', get('games'), 'upload');
      await send('wallet upload, keep games', get('wallet'), 'upload+keep');
      await send('games omit (kept)', get('games'), 'omit');
      await send('wallet omit', get('wallet'), 'omit');
      await send('home omit', get('home'), 'omit');
    } else if (flag('reuse-only')) {
      for (let r = 0; r < reps; r++) {
        await send('games upload', get('games'), 'upload');
        await send('games omit', get('games'), 'omit');
        await send('games keepnamed', get('games'), 'keepnamed');
        await send('bj-playing upload', get('bj-playing'), 'upload');
        await send('bj-playing omit', get('bj-playing'), 'omit');
      }
    } else {
    // 1. The main screens as the interaction path sends them today: each one a fresh upload.
    for (const name of ['home', 'games', 'wallet', 'profile', 'leaderboard', 'matches', 'rules', 'events', 'tables-blackjack', 'my-table', 'bj-betting', 'bj-playing', 'my-hand']) {
      await send(name, get(name), (get(name).files ?? []).length ? 'upload' : 'none');
    }
    // 2. Upload vs keep-by-id vs no image, repeated.
    for (let r = 0; r < reps; r++) {
      await send('games upload', get('games'), 'upload');
      await send('games keep', get('games'), 'keep');
      await send('home hiding games', get('home'), 'hidden');
      await send('games keep (was hidden)', get('games'), 'keep');
      await send('home none', get('home'), 'none');
      await send('bj-playing upload', get('bj-playing'), 'upload');
      await send('bj-playing keep', get('bj-playing'), 'keep');
      await send('wallet upload', get('wallet'), 'upload');
    }
    }
  } finally {
    if (messageId) await remove(messageId);
  }

  for (const s of samples) console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step.padEnd(26)} ${s.mode.padEnd(7)} ${s.ms.toFixed(0).padStart(5)} ms ${String(s.kb).padStart(4)} KB  ${s.ok ? '' : s.note}`);
  const groups = new Map<string, number[]>();
  for (const s of samples.filter((x) => x.ok)) groups.set(`${s.step}`, [...(groups.get(s.step) ?? []), s.ms]);
  console.log('\nmedian by step:');
  for (const [step, list] of groups) {
    const sorted = [...list].sort((a, b) => a - b);
    console.log(`  ${step.padEnd(26)} n=${sorted.length} median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms`);
  }
  console.log(`Guard: ${guard.allowedCount} allowed, ${guard.blockedCount} blocked. Bench message deleted.`);
  const out = value('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), samples }, null, 2));
  }
  if (samples.some((s) => !s.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
