import { afterEach, expect, it } from 'vitest';
import { HOUR } from '../../src/core/clock.js';
import { SosseNicknames, type NicknameMembers } from '../../src/domain/sosse-nicknames.js';
import { CasinoHarness } from '../harness/casino-harness.js';

class FakeNicknameMembers implements NicknameMembers {
  readonly members = new Map<string, { value: string | null; manageable: boolean }>();
  readonly writes: Array<[string, string | null]> = [];
  missResponse = false;

  async lookup(_guildId: string, userId: string) {
    const member = this.members.get(userId);
    if (!member) return null;
    return {
      nickname: member.value,
      manageable: member.manageable,
      setNickname: async (value: string | null) => {
        member.value = value;
        this.writes.push([userId, value]);
        if (this.missResponse) throw new Error('Fake Discord applied the change but lost its response');
      },
    };
  }
}

let h: CasinoHarness;
afterEach(async () => h.close());

function reliefSettings(enabled: boolean) {
  h.app.settings.set(h.guildId, 'economy.reliefNickname', enabled);
  h.app.settings.set(h.guildId, 'economy.startingBalance', 0);
  h.app.settings.set(h.guildId, 'economy.passivePerHour', 0);
  h.app.settings.set(h.guildId, 'economy.dailyReward', 0);
}

it('grants relief first and changes the nickname only after the authenticated player consents', async () => {
  const fake = new FakeNicknameMembers();
  h = new CasinoHarness({ guard: false, nicknameMembers: fake });
  reliefSettings(true);
  const user = h.user('Alice');
  fake.members.set(user.id, { value: null, manageable: true });
  const wallet = h.seen(await h.slash(user, 'wallet'))!;
  await h.click(user, wallet, 'Claim as Sosse');
  expect(h.balance(user)).toBe(50);
  expect(fake.writes).toEqual([]);
  h.fd.click(user, wallet, 'Set my server nickname to Sosse');
  h.fd.click(user, wallet, 'Set my server nickname to Sosse');
  await h.settle();
  expect(fake.writes).toEqual([[user.id, 'Sosse']]);
  expect(h.app.economy.reconcile()).toEqual([]);
  h.app.settings.set(h.guildId, 'economy.reliefNickname', false);
  h.clock.advance(HOUR / 2);
  const restarted = new SosseNicknames(h.app, h.guildId, fake);
  await restarted.restoreDue();
  await restarted.restoreDue();
  expect(fake.writes).toEqual([[user.id, 'Sosse'], [user.id, null]]);
});

it('retains the test allowlist and leaves relief independent of nicknames', async () => {
  const fake = new FakeNicknameMembers();
  h = new CasinoHarness({ guard: true, nicknameMembers: fake });
  reliefSettings(true);
  const user = h.user('Alice');
  fake.members.set(user.id, { value: 'Al', manageable: true });
  const wallet = h.seen(await h.slash(user, 'wallet'))!;
  await h.click(user, wallet, 'Claim as Sosse');
  expect(h.balance(user)).toBe(50);
  expect(h.bot.nicknames).toBeNull();
  expect(h.enabled(wallet)).not.toContain('Set my server nickname to Sosse');
  expect(fake.writes).toEqual([]);
  expect(() => h.guard!.check('PATCH', '/guilds/' + h.guildId + '/members/' + user.id, { nick: 'Sosse' })).toThrow();
});

it('recovers an uncertain write, retries denied restoration, and respects a later manual change or departure', async () => {
  const fake = new FakeNicknameMembers();
  h = new CasinoHarness();
  reliefSettings(false);
  const service = new SosseNicknames(h.app, h.guildId, fake);
  await expect(service.accept(h.guildId, 'disabled')).rejects.toThrow(/disabled/);
  reliefSettings(true);
  const names = ['A', 'B', 'C', 'D'];
  for (const name of names) {
    h.app.economy.ensurePlayer(h.guildId, name);
    h.app.economy.claimRelief(h.guildId, name, true);
    fake.members.set(name, { value: name + ' original', manageable: name !== 'D' });
  }
  await expect(service.accept('another-guild', 'A')).rejects.toThrow(/disabled/);
  await expect(service.accept(h.guildId, 'D')).rejects.toThrow(/hierarchy/);
  fake.missResponse = true;
  await expect(service.accept(h.guildId, 'A')).rejects.toThrow(/did not confirm/);
  fake.missResponse = false;
  await service.accept(h.guildId, 'B');
  await service.accept(h.guildId, 'C');
  fake.members.get('A')!.manageable = false;
  fake.members.get('B')!.value = 'Manually changed';
  fake.members.delete('C');
  h.clock.advance(HOUR / 2);
  const restarted = new SosseNicknames(h.app, h.guildId, fake);
  await restarted.restoreDue();
  expect(fake.writes).toHaveLength(3);
  fake.members.get('A')!.manageable = true;
  h.clock.advance(60_000);
  await restarted.restoreDue();
  expect(fake.writes.at(-1)).toEqual(['A', 'A original']);
  expect(fake.members.get('B')!.value).toBe('Manually changed');
  expect(h.db.all('SELECT * FROM relief_nicknames')).toEqual([]);
});
