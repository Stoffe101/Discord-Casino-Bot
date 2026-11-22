/**
 * Live Discord payload bench (development only, test mode required).
 *
 * Renders every casino screen from a simulated, throw-away casino (in-memory database) and shows
 * them in the allowlisted channel through ONE bot message that is edited from screen to screen.
 * Discord's own API validates each payload; request timings are measured. REST only — no gateway
 * session, so it never competes with the running bot for interactions. All requests go through
 * the outbound guard.
 *
 *   npm run live-bench                       → every screen, then delete the message
 *   npm run live-bench -- --only home,bj-playing --keep   → show those and leave the message up
 *   npm run live-bench -- --list             → list screen names
 *   npm run live-bench -- --cleanup          → delete the bench message
 *   npm run live-bench -- --dry              → render + validate locally, no Discord requests
 *
 * The message id is remembered in data/bench-message.json so later runs edit the same message.
 * Ephemeral screens are shown as a normal (non-ephemeral) message: Discord applies the same
 * component validation to both.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { REST, Routes, MessageFlags } from 'discord.js';
import { loadEnvFile, readEnv } from '../config/env.js';
import { Logger } from '../core/logger.js';
import { OutboundGuard, allowlistFromEnv } from '../discord/outbound-guard.js';
import type { Screen } from '../ui/kit.js';
import { validateScreen } from '../ui/validate.js';
import { buildScreens } from './bench-screens.js';
const STATE_FILE = 'data/bench-message.json';
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface RawFile {
  name: string;
  data: Buffer;
  contentType: string;
}

function payload(screen: Screen, reuse: boolean): { body: Record<string, unknown>; files: RawFile[] } {
  const files = reuse ? [] : (screen.files ?? []).map((f) => ({ name: f.name, data: Buffer.from(f.data), contentType: f.name.endsWith('.gif') ? 'image/gif' : 'image/png' }));
  return {
    body: {
      components: screen.components,
      flags: MessageFlags.IsComponentsV2,
      allowed_mentions: { parse: [] },
      ...(reuse ? {} : { attachments: (screen.files ?? []).map((f, i) => ({ id: i, filename: f.name, ...(f.description ? { description: f.description.slice(0, 1024) } : {}) })) }),
    },
    files,
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv();
  const allow = allowlistFromEnv(process.env, env.clientId);
  if (!allow) {
    console.error('live-bench only runs in test mode (CASINO_TEST_MODE=true with an allowlisted channel).');
    process.exit(1);
  }
  const logger = new Logger({ level: 'warn' });
  const guard = new OutboundGuard(allow, logger);
  const rest = new REST().setToken(env.token);
  guard.install(rest);
  const channel = allow.channelId;
  const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { messageId: string; channelId: string }) : null;

  if (flag('cleanup')) {
    if (!state || state.channelId !== channel) return console.log('No bench message to delete.');
    guard.allowDelete(state.messageId);
    await rest.delete(Routes.channelMessage(channel, state.messageId)).catch((e: unknown) => console.log('delete:', e instanceof Error ? e.message : e));
    rmSync(STATE_FILE, { force: true });
    return console.log(`Deleted bench message ${state.messageId}.`);
  }

  const renderStart = performance.now();
  let screens = await buildScreens(allow.guildId, channel);
  const renderMs = performance.now() - renderStart;
  if (flag('list')) return console.log(screens.map(([n]) => n).join('\n'));
  const only = value('only')?.split(',');
  if (only) screens = screens.filter(([n]) => only.includes(n));
  const pauseMs = Number(value('pause') ?? 0) * 1000;

  console.log(`Rendered ${screens.length} screens in ${renderMs.toFixed(0)} ms (simulated casino, in-memory database).`);
  let messageId = state?.channelId === channel ? state.messageId : null;
  let lastFile: string | null = null;
  const results: Array<{ name: string; ok: boolean; ms: number; kb: number; note: string }> = [];
  for (const [name, screen] of screens) {
    const local = validateScreen(screen);
    const kb = Math.round((screen.files ?? []).reduce((n, f) => n + f.data.length, 0) / 1024);
    if (local.errors.length) {
      results.push({ name, ok: false, ms: 0, kb, note: `local validation: ${local.errors.join('; ')}` });
      continue;
    }
    if (flag('dry')) {
      results.push({ name, ok: true, ms: 0, kb, note: 'validated locally' });
      continue;
    }
    const file = screen.files?.[0]?.name ?? null;
    const reuse = messageId !== null && file !== null && file === lastFile;
    const { body, files } = payload(screen, reuse);
    const t0 = performance.now();
    try {
      if (!messageId) {
        const created = (await rest.post(Routes.channelMessages(channel), { body, files })) as { id: string };
        messageId = created.id;
        writeFileSync(STATE_FILE, JSON.stringify({ messageId, channelId: channel }));
      } else {
        await rest.patch(Routes.channelMessage(channel, messageId), { body, files });
      }
      lastFile = file;
      results.push({ name, ok: true, ms: performance.now() - t0, kb: reuse ? 0 : kb, note: reuse ? 'image reused' : '' });
    } catch (error) {
      const raw = (error as { rawError?: unknown }).rawError;
      results.push({ name, ok: false, ms: performance.now() - t0, kb, note: `${error instanceof Error ? error.message : String(error)} ${raw ? JSON.stringify(raw).slice(0, 600) : ''}` });
      lastFile = null;
    }
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }

  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(20)} ${r.ms.toFixed(0).padStart(5)} ms ${String(r.kb).padStart(4)} KB  ${r.note}`);
  const timed = results.filter((r) => r.ok && r.ms > 0).map((r) => r.ms).sort((a, b) => a - b);
  if (timed.length) console.log(`Discord API: ${timed.length} requests · median ${timed[Math.floor(timed.length / 2)]!.toFixed(0)} ms · max ${timed.at(-1)!.toFixed(0)} ms`);
  console.log(`Guard: ${guard.allowedCount} allowed, ${guard.blockedCount} blocked.`);
  if (messageId && !flag('keep') && !flag('dry')) {
    guard.allowDelete(messageId);
    await rest.delete(Routes.channelMessage(channel, messageId));
    rmSync(STATE_FILE, { force: true });
    console.log('Bench message deleted.');
  } else if (messageId) {
    console.log(`Bench message kept: ${messageId} (npm run live-bench -- --cleanup to remove).`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
