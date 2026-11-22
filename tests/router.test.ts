import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageFlags } from 'discord.js';
import { Database } from '../src/db/database.js';
import { ManualClock } from '../src/core/clock.js';
import { ManualScheduler } from '../src/core/scheduler.js';
import { silentLogger } from '../src/core/logger.js';
import { seededRng } from '../src/core/random.js';
import { CasinoApp } from '../src/app/casino-app.js';
import { CasinoBot } from '../src/discord/bot.js';
import { ALL_IN_DEAL_DELAY_MS } from '../src/tables/blackjack-table-service.js';
import { currentTurnUserId } from '../src/games/blackjack/engine.js';
import type { Card } from '../src/games/cards.js';
import { GUILD, userId } from './helpers.js';

type Call = [string, unknown?];

interface FakeOptions {
  kind: 'command' | 'button' | 'select' | 'userselect' | 'modal';
  user: number;
  admin?: boolean;
  customId?: string;
  values?: string[];
  ephemeralSource?: boolean;
  commandName?: string;
  subcommand?: string;
  fields?: Record<string, string>;
  options?: Record<string, unknown>;
}

let counter = 0;

/** A minimal stand-in for a discord.js interaction: records every response call. */
function fake(o: FakeOptions) {
  const calls: Call[] = [];
  const component = o.kind === 'button' || o.kind === 'select' || o.kind === 'userselect';
  const i = {
    id: `int-${++counter}`,
    guildId: GUILD,
    channelId: 'channel-1',
    channel: null,
    createdTimestamp: Date.now(),
    deferred: false,
    replied: false,
    user: { id: userId(o.user), username: `user${o.user}`, globalName: `Player ${o.user}`, bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' },
    member: { displayName: `Player ${o.user}`, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' },
    memberPermissions: { has: () => o.admin ?? false },
    customId: o.customId ?? '',
    values: o.values ?? [],
    users: { first: () => undefined },
    members: new Map(),
    commandName: o.commandName,
    message: { flags: { has: (f: number) => (o.ephemeralSource ?? false) && f === MessageFlags.Ephemeral } },
    options: {
      getSubcommand: () => o.subcommand,
      getUser: (n: string) => o.options?.[n] ?? null,
      getString: (n: string) => o.options?.[n] ?? null,
      getInteger: (n: string) => o.options?.[n] ?? null,
      getChannel: () => null,
    },
    fields: {
      getTextInputValue: (id: string) => {
        if (!(id in (o.fields ?? {}))) throw new Error('no field');
        return o.fields![id]!;
      },
      getStringSelectValues: (id: string) => (o.fields?.[id] ? [o.fields[id]] : []),
      getSelectedUsers: () => null,
    },
    isRepliable: () => true,
    inGuild: () => true,
    isAutocomplete: () => false,
    isCommand: () => o.kind === 'command',
    isChatInputCommand: () => o.kind === 'command',
    isUserContextMenuCommand: () => false,
    isButton: () => o.kind === 'button',
    isAnySelectMenu: () => o.kind === 'select' || o.kind === 'userselect',
    isStringSelectMenu: () => o.kind === 'select',
    isUserSelectMenu: () => o.kind === 'userselect',
    isMessageComponent: () => component,
    isModalSubmit: () => o.kind === 'modal',
    isFromMessage: () => true,
    async reply(opts: unknown) {
      calls.push(['reply', opts]);
      i.replied = true;
      return { resource: { message: { id: 'msg-1', channelId: 'channel-1' } } };
    },
    async update(opts: unknown) {
      calls.push(['update', opts]);
      i.replied = true;
    },
    async deferUpdate() {
      calls.push(['deferUpdate']);
      i.deferred = true;
    },
    async deferReply(opts: unknown) {
      calls.push(['deferReply', opts]);
      i.deferred = true;
    },
    async editReply(opts: unknown) {
      calls.push(['editReply', opts]);
    },
    async followUp(opts: unknown) {
      calls.push(['followUp', opts]);
    },
    async showModal(spec: unknown) {
      calls.push(['showModal', spec]);
      i.replied = true;
    },
  };
  return { i, calls };
}

const kinds = (calls: Call[]) => calls.map((c) => c[0]);
const flagsOf = (call: Call | undefined) => (call?.[1] as { flags?: number } | undefined)?.flags ?? 0;
const textOf = (call: Call | undefined) => JSON.stringify((call?.[1] as { components?: unknown })?.components ?? '');

describe('InteractionRouter (headless)', () => {
  let app: CasinoApp;
  let bot: CasinoBot;
  let clock: ManualClock;
  let scheduler: ManualScheduler;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.migrate();
    clock = new ManualClock(Date.now());
    scheduler = new ManualScheduler(clock);
    app = new CasinoApp({ db, logger: silentLogger, clock, scheduler, rng: seededRng(5) });
    bot = new CasinoBot(app, silentLogger);
  });

  afterEach(async () => {
    await bot.client.destroy();
  });

  const run = async (o: FakeOptions) => {
    const f = fake(o);
    await bot.router.handle(f.i as never);
    await app.blackjack.idle();
    await bot.tablePanels.idle();
    return f;
  };

  it('/casino replies privately with a Components V2 home screen and creates the account', async () => {
    const { calls } = await run({ kind: 'command', user: 1, commandName: 'casino' });
    expect(kinds(calls)).toEqual(['reply']);
    expect(flagsOf(calls[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(flagsOf(calls[0]) & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(textOf(calls[0])).toContain('1,000 chips');
    expect(app.economy.getPlayer(GUILD, userId(1))!.balance).toBe(1000);
  });

  it('navigates in place from a private panel, but opens a private reply from a public one', async () => {
    const own = await run({ kind: 'button', user: 1, customId: 'nav:wallet', ephemeralSource: true });
    expect(kinds(own.calls)).toEqual(['update']);
    const lobby = await run({ kind: 'button', user: 1, customId: 'nav:wallet', ephemeralSource: false });
    expect(kinds(lobby.calls)).toEqual(['reply']);
    expect(flagsOf(lobby.calls[0]) & MessageFlags.Ephemeral).toBeTruthy();
  });

  it('claims the daily reward once and reports the second attempt as a friendly error', async () => {
    await run({ kind: 'button', user: 1, customId: 'eco:daily:wallet', ephemeralSource: true });
    expect(app.economy.getPlayer(GUILD, userId(1))!.balance).toBe(1250);
    const again = await run({ kind: 'button', user: 1, customId: 'eco:daily:wallet', ephemeralSource: true });
    expect(kinds(again.calls)).toEqual(['reply']);
    expect(textOf(again.calls[0])).toContain('Already claimed');
    expect(app.economy.getPlayer(GUILD, userId(1))!.balance).toBe(1250);
  });

  it('a chip click on the table panel places the bet and updates the panel in the same response', async () => {
    app.economy.ensurePlayer(GUILD, userId(1), 'Player 1');
    const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
    const { calls } = await run({ kind: 'button', user: 1, customId: `bj:bet:${t.record.id}:50` });
    expect(app.blackjack.peek(t.record.id)!.state.bets[userId(1)]).toBe(50);
    expect(kinds(calls)).toEqual(['update']);
    expect(textOf(calls[0])).toContain('50');
    expect(bot.tablePanels.stats.viaInteraction).toBe(1);
  });

  it('a chip click from someone at the rail seats them first', async () => {
    app.economy.ensurePlayer(GUILD, userId(1), 'Player 1');
    const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
    await run({ kind: 'button', user: 2, customId: `bj:bet:${t.record.id}:25` });
    expect(app.blackjack.peek(t.record.id)!.state.seats.map((s) => s.userId)).toContain(userId(2));
    expect(app.blackjack.peek(t.record.id)!.state.bets[userId(2)]).toBe(25);
  });

  it("rejects another player's turn privately and leaves the hand untouched", async () => {
    for (const n of [1, 2]) app.economy.ensurePlayer(GUILD, userId(n), `Player ${n}`);
    const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
    await app.blackjack.join(t.record.id, userId(2), 'Player 2');
    await app.blackjack.debugSetShoe(t.record.id, ['TS', '9S', '7H', '6D', '8D', 'TH'] as Card[]);
    await app.blackjack.placeBet(t.record.id, userId(1), 50);
    await app.blackjack.placeBet(t.record.id, userId(2), 50);
    clock.advance(ALL_IN_DEAL_DELAY_MS);
    scheduler.runDue();
    await app.blackjack.idle();
    const round = app.blackjack.peek(t.record.id)!.state.round!;
    expect(currentTurnUserId(round)).toBe(userId(1));
    const wrong = await run({ kind: 'button', user: 2, customId: `bj:act:${t.record.id}:hit:${round.seq}` });
    expect(kinds(wrong.calls)).toEqual(['reply']);
    expect(flagsOf(wrong.calls[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(textOf(wrong.calls[0])).toContain("Player 1's turn");
    expect(app.blackjack.peek(t.record.id)!.state.round!.seats[0]!.hands[0]!.cards).toHaveLength(2);
    // A stale sequence number (old message / double click) is refused too.
    const stale = await run({ kind: 'button', user: 1, customId: `bj:act:${t.record.id}:hit:${round.seq - 1}` });
    expect(textOf(stale.calls[0])).toContain('Already handled');
    const ok = await run({ kind: 'button', user: 1, customId: `bj:act:${t.record.id}:hit:${round.seq}` });
    expect(kinds(ok.calls)).toEqual(['update']);
    expect(app.blackjack.peek(t.record.id)!.state.round!.seats[0]!.hands[0]!.cards).toHaveLength(3);
  });

  it('admin tools are refused to non-admins, server-side', async () => {
    const { calls } = await run({ kind: 'command', user: 3, commandName: 'casinoadmin', subcommand: 'panel', admin: false });
    expect(textOf(calls[0])).toContain('Admins only');
    const button = await run({ kind: 'button', user: 3, customId: 'adm:audit', ephemeralSource: true, admin: false });
    expect(textOf(button.calls[0])).toContain('Admins only');
    const ok = await run({ kind: 'command', user: 4, commandName: 'casinoadmin', subcommand: 'panel', admin: true });
    expect(textOf(ok.calls[0])).toContain('Casino admin');
  });

  it('admin wallet adjustments require a reason and are logged', async () => {
    app.economy.ensurePlayer(GUILD, userId(5), 'Player 5');
    const target = { id: userId(5), bot: false, username: 'p5', globalName: 'Player 5' };
    const noReason = await run({ kind: 'command', user: 4, admin: true, commandName: 'casinoadmin', subcommand: 'adjust', options: { player: target, amount: 100, reason: '' } });
    expect(textOf(noReason.calls[0])).toContain('reason');
    await run({ kind: 'command', user: 4, admin: true, commandName: 'casinoadmin', subcommand: 'adjust', options: { player: target, amount: 100, reason: 'Tournament prize' } });
    expect(app.economy.getPlayer(GUILD, userId(5))!.balance).toBe(1100);
    expect(app.economy.ledgerPage(GUILD, userId(5), 1)[0]).toMatchObject({ type: 'admin_adjust', actor_id: userId(4), memo: 'Tournament prize' });
  });

  it('opens modals immediately for custom bets and table creation', async () => {
    app.economy.ensurePlayer(GUILD, userId(1), 'Player 1');
    const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
    const custom = await run({ kind: 'button', user: 1, customId: `bj:betx:${t.record.id}` });
    expect(kinds(custom.calls)).toEqual(['showModal']);
    const create = await run({ kind: 'button', user: 2, customId: 'tbl:create' });
    expect(kinds(create.calls)).toEqual(['showModal']);
    // Someone already seated is told to leave first instead.
    const blocked = await run({ kind: 'button', user: 1, customId: 'tbl:create' });
    expect(textOf(blocked.calls[0])).toContain('already seated');
  });

  it('custom bet modal places the bet and validates numbers', async () => {
    app.economy.ensurePlayer(GUILD, userId(1), 'Player 1');
    const t = await app.blackjack.createTable({ guildId: GUILD, ownerId: userId(1), ownerName: 'Player 1' });
    const bad = await run({ kind: 'modal', user: 1, customId: `m:bjbet:${t.record.id}`, fields: { amount: 'lots' } });
    expect(textOf(bad.calls[0])).toContain('whole number');
    await run({ kind: 'modal', user: 1, customId: `m:bjbet:${t.record.id}`, fields: { amount: '1,25' } });
    expect(app.blackjack.peek(t.record.id)!.state.bets[userId(1)]).toBe(125);
  });

  it('slot spins update the private machine and ignore double-clicks', async () => {
    const first = await run({ kind: 'button', user: 1, customId: 'sl:spin:10:0', ephemeralSource: true });
    expect(kinds(first.calls)).toEqual(['update']);
    const dupe = await run({ kind: 'button', user: 1, customId: 'sl:spin:10:0', ephemeralSource: true });
    expect(textOf(dupe.calls[0])).toContain('Already handled');
    expect(app.slots.spinCount(GUILD, userId(1))).toBe(1);
  });

  it('unknown or outdated buttons fail safely', async () => {
    const { calls } = await run({ kind: 'button', user: 1, customId: 'zz:old:thing' });
    expect(kinds(calls)).toEqual(['reply']);
    expect(textOf(calls[0])).toContain('Out of date');
    const closed = await run({ kind: 'button', user: 1, customId: 'bj:act:no-such-table:hit:1' });
    expect(textOf(closed.calls[0])).toContain('closed');
  });

  it('ignores duplicate deliveries of the same interaction', async () => {
    const f = fake({ kind: 'command', user: 1, commandName: 'daily' });
    await bot.router.handle(f.i as never);
    await bot.router.handle(f.i as never);
    expect(kinds(f.calls)).toEqual(['reply']);
    expect(app.economy.getPlayer(GUILD, userId(1))!.balance).toBe(1250);
  });
});
