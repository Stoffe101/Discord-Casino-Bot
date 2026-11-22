import { REST, Routes } from 'discord.js';
import { ConfigError, loadEnvFile, readEnv } from '../config/env.js';
import { commandDefinitions } from '../discord/commands.js';

/**
 * Registers slash commands. With DISCORD_DEV_GUILD_ID set they are registered to that server
 * only (instant); otherwise globally (can take up to an hour to appear).
 *   npm run register-commands            → dev guild if configured, else global
 *   npm run register-commands -- --global
 *   npm run register-commands -- --clear-guild   (remove dev-guild copies after going global)
 */
async function main(): Promise<void> {
  loadEnvFile();
  let env;
  try {
    env = readEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const rest = new REST().setToken(env.token);
  const args = new Set(process.argv.slice(2));
  const body = commandDefinitions();

  if (args.has('--clear-guild')) {
    if (!env.devGuildId) throw new Error('DISCORD_DEV_GUILD_ID is not set');
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.devGuildId), { body: [] });
    console.log(`Removed guild commands from ${env.devGuildId}.`);
    return;
  }
  if (env.devGuildId && !args.has('--global')) {
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.devGuildId), { body });
    console.log(`Registered ${body.length} commands to development server ${env.devGuildId} (available immediately).`);
  } else {
    await rest.put(Routes.applicationCommands(env.clientId), { body });
    console.log(`Registered ${body.length} global commands (may take up to an hour to appear everywhere).`);
  }
}

main().catch((error: unknown) => {
  console.error('Command registration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
