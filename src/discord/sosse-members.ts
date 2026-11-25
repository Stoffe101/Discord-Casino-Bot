import { PermissionFlagsBits, RESTJSONErrorCodes, type Client } from 'discord.js';
import type { NicknameMembers } from '../domain/sosse-nicknames.js';

export function discordNicknameMembers(client: Client): NicknameMembers {
  return {
    async lookup(guildId, userId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild?.available) throw new Error('The approved guild is temporarily unavailable');
      let member;
      try {
        member = await guild.members.fetch({ user: userId, force: true });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownMember) return null;
        throw error;
      }
      const bot = await guild.members.fetchMe({ force: true });
      return {
        nickname: member.nickname,
        manageable: bot.permissions.has(PermissionFlagsBits.ManageNicknames) && member.manageable,
        setNickname: async (nickname) => {
          await member.setNickname(nickname, 'Temporary casino relief nickname with player consent');
        },
      };
    },
  };
}
