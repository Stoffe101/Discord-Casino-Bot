/**
 * Resolves the test-mode allowlist: the development server from DISCORD_DEV_GUILD_ID and its
 * single text channel named "casino". Read-only (two GET requests through the outbound guard).
 *
 *   npm run test:allowlist             → print what was found
 *   npm run test:allowlist -- --write  → also store CASINO_TEST_MODE / _GUILD_ID / _CHANNEL_ID in .env
 *
 * Refuses to pick when zero or several channels match.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { REST, Routes, ChannelType, type APIChannel, type APIGuild } from 'discord.js';
import { ConfigError, loadEnvFile, readEnv } from '../config/env.js';
import { Logger } from '../core/logger.js';
import { OutboundGuard } from '../discord/outbound-guard.js';

const CHANNEL_NAME = 'casino';

async function main(): Promise<void> {
  loadEnvFile();
  const env = readEnv();
  if (!env.devGuildId) throw new ConfigError('DISCORD_DEV_GUILD_ID is not set in .env');
  const rest = new REST().setToken(env.token);
  // The channel isn't known yet, so this guard only permits reading the development server.
  new OutboundGuard({ guildId: env.devGuildId, channelId: '000000000000000000', applicationId: env.clientId }, new Logger({ level: 'warn' })).install(rest);

  const guild = (await rest.get(Routes.guild(env.devGuildId))) as APIGuild;
  const channels = (await rest.get(Routes.guildChannels(env.devGuildId))) as APIChannel[];
  const named = channels.filter((c) => 'name' in c && c.name?.toLowerCase() === CHANNEL_NAME);
  const text = named.filter((c) => c.type === ChannelType.GuildText);
  const parent = (id: string | null | undefined) => channels.find((c) => c.id === id);

  console.log(`Server: "${guild.name}" (${guild.id})`);
  for (const c of named) {
    const category = 'parent_id' in c ? parent(c.parent_id)?.name : undefined;
    console.log(`  #${'name' in c ? c.name : '?'}  id ${c.id}  type ${ChannelType[c.type]}${category ? `  category "${category}"` : ''}`);
  }
  if (text.length !== 1) {
    console.error(`\nExpected exactly one text channel named "${CHANNEL_NAME}", found ${text.length}. Not guessing; nothing written.`);
    process.exit(1);
  }
  const channelId = text[0]!.id;
  console.log(`\nAllowlist: guild ${guild.id} · channel ${channelId}`);

  if (process.argv.includes('--write')) {
    const values: Record<string, string> = { CASINO_TEST_MODE: 'true', CASINO_TEST_GUILD_ID: guild.id, CASINO_TEST_CHANNEL_ID: channelId };
    const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
    for (const [key, value] of Object.entries(values)) {
      const i = lines.findIndex((l) => l.startsWith(`${key}=`));
      if (i >= 0) lines[i] = `${key}=${value}`;
      else {
        if (lines.at(-1) === '') lines.pop();
        lines.push(`${key}=${value}`, '');
      }
    }
    writeFileSync('.env', lines.join('\n'));
    console.log('Stored in .env (CASINO_TEST_MODE, CASINO_TEST_GUILD_ID, CASINO_TEST_CHANNEL_ID).');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
