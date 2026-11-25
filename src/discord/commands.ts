import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import { LEADERBOARD_CATEGORIES } from '../domain/leaderboard-service.js';

/** All application commands. Guild-only: every casino is per server. */
export function commandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const slash = (name: string, description: string) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

  const commands: { toJSON(): RESTPostAPIApplicationCommandsJSONBody }[] = [
    slash('casino', 'Open the casino: wallet, games, rewards and stats'),
    slash('wallet', 'Your chips, passive income and transaction history'),
    slash('daily', 'Claim your daily chip reward'),
    slash('blackjack', 'Find a blackjack table or open your own'),
    slash('games', 'Open the gaming floor: every game in one place'),
    slash('holdem', 'Find a Hold’em poker table or open your own'),
    slash('roulette', 'Go to the roulette wheel'),
    slash('slots', 'Play your personal slot machine'),
    slash('help', 'How the casino works'),
    slash('profile', 'Casino profile and statistics').addUserOption((o) =>
      o.setName('player').setDescription('Whose profile to view (default: yours)'),
    ),
    slash('leaderboard', 'Server rankings').addStringOption((o) =>
      o
        .setName('board')
        .setDescription('Which leaderboard')
        .addChoices(...LEADERBOARD_CATEGORIES.map((c) => ({ name: c.label, value: c.id }))),
    ),
    slash('coinflip', 'Challenge another player to a coinflip duel')
      .addUserOption((o) => o.setName('player').setDescription('Who to challenge').setRequired(true))
      .addIntegerOption((o) => o.setName('stake').setDescription('Chips each player puts in').setRequired(true).setMinValue(1))
      .addStringOption((o) =>
        o
          .setName('call')
          .setDescription('Your call (default heads)')
          .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }),
      ),
    slash('casinoadmin', 'Casino administration')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Post (or move) the casino lobby')
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Casino channel (default: this one)').addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((s) => s.setName('panel').setDescription('Open the settings panel'))
      .addSubcommand((s) =>
        s
          .setName('adjust')
          .setDescription("Adjust a player's chips (recorded in the audit log)")
          .addUserOption((o) => o.setName('player').setDescription('Player').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Chips to add (negative to remove)').setRequired(true))
          .addStringOption((o) =>
            o.setName('reason').setDescription('Reason for the audit log').setRequired(true).setMinLength(3).setMaxLength(200),
          ),
      )
      .addSubcommand((s) => s.setName('audit').setDescription('Recent administrative adjustments'))
      .addSubcommand((s) => s.setName('health').setDescription('Ledger reconciliation and bot health'))
      .addSubcommand((s) => s.setName('reset-dev').setDescription('Development only: wipe all casino data in this server')),
    new ContextMenuCommandBuilder()
      .setName('Casino profile')
      .setType(ApplicationCommandType.User)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
  ];
  return commands.map((c) => c.toJSON());
}
