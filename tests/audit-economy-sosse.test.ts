/**
 * Audit: the casino-only Sosse title and the optional, consented, temporary server nickname.
 *
 * Tests wrapped in `it.fails` reproduce a CONFIRMED bug that could not be fixed inside the
 * audited files and assert the CORRECT behaviour.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CasinoApp } from '../src/app/casino-app.js';
import { HOUR, ManualClock } from '../src/core/clock.js';
import { silentLogger } from '../src/core/logger.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { Database } from '../src/db/database.js';
import { CasinoBot } from '../src/discord/bot.js';
import { SosseNicknames, type NicknameMembers } from '../src/domain/sosse-nicknames.js';
import { CasinoHarness } from './harness/casino-harness.js';

const G = '100000000000000001';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

class FakeMembers implements NicknameMembers {
  readonly members = new Map<string, { value: string | null; manageable: boolean }>();
  readonly writes: Array<[string, string | null]> = [];
  /** 'refuse': Discord rejects without applying. 'lost': applies, but the response is lost. */
  failure: 'refuse' | 'lost' | null = null;

  async lookup(_guildId: string, userId: string) {
    const member = this.members.get(userId);
    if (!member) return null;
    return {
      nickname: member.value,
      manageable: member.manageable,
      setNickname: async (value: string | null) => {
        if (this.failure === 'refuse') throw new Error('403 Missing Permissions');
        member.value = value;
        this.writes.push([userId, value]);
        if (this.failure === 'lost') throw new Error('socket hang up');
      },
    };
  }
}

function setup(options: { nickname?: boolean; title?: boolean } = {}) {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new ManualClock();
  const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock) });
  cleanup.push(() => db.close(), () => app.shutdown());
  for (const [key, value] of Object.entries({
    'economy.startingBalance': 0, 'economy.passivePerHour': 0, 'economy.dailyReward': 0,
    'economy.reliefNickname': options.nickname ?? true, 'economy.reliefTitle': options.title ?? true,
  })) app.settings.set(G, key, value);
  const fake = new FakeMembers();
  const service = new SosseNicknames(app, G, fake);
  return { app, clock, fake, service };
}

const leases = (app: CasinoApp) => app.db.all('SELECT * FROM relief_nicknames');

describe('consent and enablement', () => {
  it('is off by default, needs the title, the approved guild and an open casino', () => {
    const { app, service } = setup({ nickname: false });
    expect(service.offered(G)).toBe(false);
    app.settings.set(G, 'economy.reliefNickname', true);
    expect(service.offered(G)).toBe(true);
    expect(service.offered('100000000000000002')).toBe(false);
    app.settings.set(G, 'economy.reliefTitle', false);
    expect(service.offered(G)).toBe(false);
    app.settings.set(G, 'economy.reliefTitle', true);
    app.settings.set(G, 'enabled', false);
    expect(service.offered(G)).toBe(false);
  });

  it('grants relief without any nickname step, and a plain claim cannot be turned into a nickname', async () => {
    const { app, fake, service } = setup();
    app.economy.ensurePlayer(G, 'plain');
    fake.members.set('plain', { value: 'Plain', manageable: true });
    app.economy.claimRelief(G, 'plain', false);
    expect(app.economy.requirePlayer(G, 'plain')).toMatchObject({ balance: 50, relief_title_until: null });
    await expect(service.accept(G, 'plain')).rejects.toThrow(/expired/);
    app.economy.ensurePlayer(G, 'titled');
    fake.members.set('titled', { value: 'Titled', manageable: true });
    app.economy.claimRelief(G, 'titled', true);
    expect(app.economy.requirePlayer(G, 'titled').balance).toBe(50);
    expect(fake.writes).toEqual([]);
    expect(leases(app)).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('stores the exact original (null), restores at the 30-minute expiry and not before', async () => {
    const { app, clock, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: null, manageable: true });
    app.economy.claimRelief(G, 'a', true);
    const until = await service.accept(G, 'a');
    expect(until).toBe(clock.now() + HOUR / 2);
    expect(leases(app)).toMatchObject([{ user_id: 'a', original_nick: null, expires_at: until }]);
    clock.advance(HOUR / 2 - 1);
    await service.restoreDue();
    expect(fake.members.get('a')!.value).toBe('Sosse');
    clock.advance(1);
    await service.restoreDue();
    expect(fake.writes).toEqual([['a', 'Sosse'], ['a', null]]);
    expect(leases(app)).toEqual([]);
    await expect(service.accept(G, 'a')).rejects.toThrow(/expired/);
  });

  it('keeps unusual originals byte-for-byte, including whitespace and markdown', async () => {
    const { app, clock, fake, service } = setup();
    const original = '  _Ä*b`c ';
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: original, manageable: true });
    app.economy.claimRelief(G, 'a', true);
    await service.accept(G, 'a');
    clock.advance(HOUR / 2);
    await service.restoreDue();
    expect(fake.members.get('a')!.value).toBe(original);
  });

  it('lets the player retry after Discord refused the change without applying it', async () => {
    const { app, clock, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: 'Original', manageable: true });
    app.economy.claimRelief(G, 'a', true);
    fake.failure = 'refuse';
    await expect(service.accept(G, 'a')).rejects.toThrow(/did not confirm/);
    expect(fake.members.get('a')!.value).toBe('Original');
    fake.failure = null;
    await service.accept(G, 'a');
    expect(fake.members.get('a')!.value).toBe('Sosse');
    clock.advance(HOUR / 2);
    await service.restoreDue();
    expect(fake.members.get('a')!.value).toBe('Original');
  });

  it('does not re-apply after an uncertain write that did land, or after a manual revert', async () => {
    const { app, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: 'Original', manageable: true });
    app.economy.claimRelief(G, 'a', true);
    fake.failure = 'lost';
    await expect(service.accept(G, 'a')).rejects.toThrow(/did not confirm/);
    fake.failure = null;
    await expect(service.accept(G, 'a')).rejects.toThrow(/already Sosse/);
    fake.members.get('a')!.value = 'Changed by the player';
    await expect(service.accept(G, 'a')).rejects.toThrow(/already used/);
    expect(fake.writes).toEqual([['a', 'Sosse']]);
  });

  // Deliberate trade-off of the retry rule: a lease whose nickname still equals the stored original
  // is indistinguishable from a write that never landed, so a player who reverted by hand to that
  // exact original and presses the consent button again gets Sosse again. It is an explicit click
  // by that player, the lease and its expiry are unchanged, and restoration still happens on time.
  it('after a manual revert to the exact original, only a new explicit click re-applies, with the same expiry', async () => {
    const { app, clock, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: 'Original', manageable: true });
    app.economy.claimRelief(G, 'a', true);
    const until = await service.accept(G, 'a');
    fake.members.get('a')!.value = 'Original';
    clock.advance(HOUR / 4);
    await service.restoreDue();
    expect(fake.members.get('a')!.value).toBe('Original');
    expect(await service.accept(G, 'a')).toBe(until);
    expect(leases(app)).toMatchObject([{ user_id: 'a', original_nick: 'Original', expires_at: until }]);
    clock.advance(HOUR / 4);
    await service.restoreDue();
    expect(fake.writes).toEqual([['a', 'Sosse'], ['a', 'Sosse'], ['a', 'Original']]);
    expect(leases(app)).toEqual([]);
  });

  it('still restores a lease after the approval moved to another server', async () => {
    const { app, clock, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: 'Original', manageable: true });
    app.economy.claimRelief(G, 'a', true);
    await service.accept(G, 'a');
    clock.advance(HOUR / 2);
    await new SosseNicknames(app, '100000000000000002', fake).restoreDue();
    expect(fake.members.get('a')!.value).toBe('Original');
    expect(leases(app)).toEqual([]);
  });

  it('serialises duplicate requests into one Discord write', async () => {
    const { app, fake, service } = setup();
    app.economy.ensurePlayer(G, 'a');
    fake.members.set('a', { value: 'A', manageable: true });
    app.economy.claimRelief(G, 'a', true);
    const results = await Promise.allSettled([service.accept(G, 'a'), service.accept(G, 'a'), service.accept(G, 'a')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fake.writes).toEqual([['a', 'Sosse']]);
  });

  it('refuses without writing when the role hierarchy or permissions do not allow it, or the member left', async () => {
    const { app, fake, service } = setup();
    for (const id of ['owner', 'gone']) {
      app.economy.ensurePlayer(G, id);
      app.economy.claimRelief(G, id, true);
    }
    fake.members.set('owner', { value: 'Owner', manageable: false });
    await expect(service.accept(G, 'owner')).rejects.toThrow(/hierarchy/);
    await expect(service.accept(G, 'gone')).rejects.toThrow(/hierarchy/);
    expect(fake.writes).toEqual([]);
    expect(leases(app)).toEqual([]);
  });
});

describe('restarts and test mode', () => {
  const instant = { frameDelayMs: 0, dealFrameMs: 0, spinFrameMs: 0, animationScale: 0, tableMinIntervalMs: 0, wheelMinIntervalMs: 0, lobbyDebounceMs: 0 };

  function tempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'casino-audit-sosse-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'casino.db');
  }

  async function nicknamedPlayer(fake: FakeMembers, dbPath: string) {
    const clock = new ManualClock();
    const first = new CasinoHarness({ guard: false, nicknameMembers: fake, dbPath, clock });
    first.app.settings.set(first.guildId, 'economy.reliefNickname', true);
    first.app.settings.set(first.guildId, 'economy.startingBalance', 0);
    first.app.settings.set(first.guildId, 'economy.passivePerHour', 0);
    first.app.settings.set(first.guildId, 'economy.dailyReward', 0);
    const user = first.user('Alice');
    first.app.economy.ensurePlayer(first.guildId, user.id);
    fake.members.set(user.id, { value: 'Alice original', manageable: true });
    first.app.economy.claimRelief(first.guildId, user.id, true);
    await first.bot.nicknames!.accept(first.guildId, user.id);
    await first.close();
    return { fd: first.fd, clock, guildId: first.guildId, userId: user.id };
  }

  it('in guarded test mode makes no guild-member edits at all, even for leases from an earlier run', async () => {
    const fake = new FakeMembers();
    const dbPath = tempDb();
    const { fd, clock, userId } = await nicknamedPlayer(fake, dbPath);
    clock.advance(HOUR / 2);
    const guarded = new CasinoHarness({ guard: true, nicknameMembers: fake, dbPath, clock, discord: fd });
    cleanup.push(() => guarded.close());
    await guarded.boot();
    expect(guarded.bot.nicknames).toBeNull();
    expect(fake.writes).toEqual([[userId, 'Sosse']]);
  });

  // CONFIRMED (medium): restoration is wired to the same switch that enables new nicknames.
  // bot.ts builds SosseNicknames only when CASINO_NICKNAME_GUILD_ID is set, so an operator who
  // withdraws the approval (unset the variable) and restarts leaves every player who is currently
  // named "Sosse" with that nickname permanently; their lease rows are never processed.
  // Required change (src/discord/bot.ts constructor, outside the audited files): when not guarded,
  // always construct a SosseNicknames for restoration, e.g. with approvedGuild '' so offered()
  // stays false. restoreDue() already processes every guild's leases (fixed in this audit).
  it.fails('restores a pending nickname after a restart that withdrew the nickname approval', async () => {
    const fake = new FakeMembers();
    const dbPath = tempDb();
    const { fd, clock, userId } = await nicknamedPlayer(fake, dbPath);
    clock.advance(HOUR / 2);
    const db = new Database(dbPath);
    db.migrate();
    const app = new CasinoApp({ db, clock, logger: silentLogger, scheduler: new ManualScheduler(clock) });
    const bot = new CasinoBot(app, silentLogger, { guard: null, nicknameMembers: fake, animations: false, timing: instant, makeRequest: fd.makeRequest as never });
    fd.attach(bot.client);
    cleanup.push(() => db.close(), () => app.shutdown(), () => bot.stop());
    await bot.onReady('Emerald Room#0000');
    await bot.idle();
    expect(fake.members.get(userId)!.value).toBe('Alice original');
  });
});
