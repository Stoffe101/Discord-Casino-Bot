import { UserError } from '../core/errors.js';
import { KeyedSerialQueue } from '../core/serial-queue.js';
import type { CasinoApp } from '../app/casino-app.js';

const TITLE = 'Sosse';
const RETRY_MS = 60_000;

export interface NicknameMember {
  nickname: string | null;
  manageable: boolean;
  setNickname(nickname: string | null): Promise<void>;
}

export interface NicknameMembers {
  lookup(guildId: string, userId: string): Promise<NicknameMember | null>;
}

interface Lease {
  guild_id: string;
  user_id: string;
  original_nick: string | null;
  expires_at: number;
  retry_at: number;
}

export class SosseNicknames {
  private readonly queue = new KeyedSerialQueue();

  constructor(private readonly app: CasinoApp, private readonly approvedGuild: string, private readonly members: NicknameMembers) {}

  offered(guildId: string): boolean {
    const settings = this.app.settings.get(guildId);
    return guildId === this.approvedGuild && settings.enabled && settings.economy.reliefTitle && settings.economy.reliefNickname;
  }

  async accept(guildId: string, userId: string): Promise<number> {
    return this.queue.run(guildId + ':' + userId, async () => {
      if (!this.offered(guildId)) throw new UserError('Server nicknames are disabled for casino relief.');
      const { db, clock, economy } = this.app;
      const expiresAt = economy.requirePlayer(guildId, userId).relief_title_until;
      if (expiresAt === null || expiresAt <= clock.now()) throw new UserError('Your temporary Sosse title has expired.');
      if (db.get('SELECT 1 FROM relief_nicknames WHERE guild_id = ? AND user_id = ?', [guildId, userId])) {
        throw new UserError('You already used the server nickname for this relief claim.');
      }
      const member = await this.members.lookup(guildId, userId);
      if (!member?.manageable) throw new UserError('Discord permissions or role hierarchy prevent the nickname change.');
      if (member.nickname === TITLE) throw new UserError('Your server nickname is already Sosse.');
      if (expiresAt <= clock.now() || !this.offered(guildId)) throw new UserError('The nickname offer is no longer available.');
      // Persist the exact original value before any Discord call. An uncertain network
      // result is restored the same way as a successful change, if Sosse is still set.
      db.run('INSERT INTO relief_nicknames (guild_id, user_id, original_nick, expires_at) VALUES (?, ?, ?, ?)',
        [guildId, userId, member.nickname, expiresAt]);
      try {
        await member.setNickname(TITLE);
      } catch {
        throw new UserError('Discord did not confirm the nickname change. Your relief chips are already available.');
      }
      return expiresAt;
    });
  }

  async restoreDue(): Promise<void> {
    const { db, clock, logger } = this.app;
    const due = db.all<Lease>('SELECT * FROM relief_nicknames WHERE guild_id = ? AND expires_at <= ? AND retry_at <= ?',
      [this.approvedGuild, clock.now(), clock.now()]);
    for (const lease of due) {
      const { guild_id: guildId, user_id: userId } = lease;
      await this.queue.run(guildId + ':' + userId, async () => {
        const current = db.get<Lease>('SELECT * FROM relief_nicknames WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
        if (current?.expires_at !== lease.expires_at || current.retry_at > clock.now()) return;
        try {
          const member = await this.members.lookup(guildId, userId);
          if (member?.nickname === TITLE) {
            if (!member.manageable) throw new Error('Discord permissions prevent restoration');
            await member.setNickname(lease.original_nick);
          }
          db.run('DELETE FROM relief_nicknames WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
        } catch {
          logger.warn('Sosse nickname restoration will retry', { guildId, userId });
          db.run('UPDATE relief_nicknames SET retry_at = ? WHERE guild_id = ? AND user_id = ?', [clock.now() + RETRY_MS, guildId, userId]);
        }
      });
    }
  }
}
