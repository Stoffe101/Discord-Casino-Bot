import { afterEach, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { PanelSync } from '../../src/discord/panel-sync.js';
import { noticeScreen } from '../../src/ui/screens/common.js';
import type { Screen } from '../../src/ui/kit.js';
import type { Card } from '../../src/games/cards.js';
import { CasinoHarness } from '../harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

it('sends the same complete Home on a slash response and on a navigation update', async () => {
  h = new CasinoHarness();
  const user = h.user('Alex');
  const slash = await h.slash(user, 'casino');
  const first = h.seen(slash)!;
  const expected = structuredClone(first.components);
  expect(first.flags & MessageFlags.IsComponentsV2).toBeTruthy();
  expect(first.flags & MessageFlags.Ephemeral).toBeTruthy();
  expect(h.enabled(first)).toContain('Play a game');
  const attachments = first.attachments.map((attachment) => attachment.filename);
  await h.click(user, first, 'Games');
  const back = await h.click(user, first, 'Home');
  expect(back.source?.id).toBe(first.id);
  expect(first.components).toEqual(expected);
  // Home shows exactly the same components. Images uploaded for an earlier screen (the Games banner)
  // may stay on the message unreferenced, so a return to that screen re-uses them instead of
  // uploading again; Home itself references none of them.
  const kept = first.attachments.map((attachment) => attachment.filename);
  for (const name of attachments) expect(kept).toContain(name);
  expect(JSON.stringify(first.components)).not.toMatch(/attachment:\/\/emerald-gaming-floor/);
  expect(first.flags & MessageFlags.IsComponentsV2).toBeTruthy();
  expect(first.flags & MessageFlags.Ephemeral).toBeTruthy();
});

it('recovers a valid host click from a betting panel with an automatic deal already committed', async () => {
  h = new CasinoHarness();
  h.fd.latencyMs = 160;
  h.fd.recording = true;
  const [host, guest] = [h.user('Host'), h.user('Guest')];
  await h.openBlackjack(host);
  const id = h.app.blackjack.tableOfUser(h.guildId, host.id)!.record.id;
  await h.click(guest, h.tablePanel(id), 'Take a seat');
  await h.app.blackjack.debugSetShoe(id, ['TS', '9C', '6H', 'TD', '3D'] as Card[]);
  await h.click(host, h.tablePanel(id), '25');
  const before = h.app.blackjack.peek(id)!;
  const panel = h.tablePanel(id);
  const request = h.buttons(panel).find((button) => button.label === 'Deal now (host)')!.custom_id!;
  h.clock.set(before.state.deadline!);
  h.scheduler.runDue();
  await h.app.blackjack.idle();

  // The game has committed its deal and the slower Discord edit is still pending.
  expect(h.app.blackjack.peek(id)!.state.phase).toBe('playing');
  expect(h.buttons(panel).some((button) => button.custom_id === request)).toBe(true);
  const click = h.fd.clickRaw(host, panel, request);
  await h.settle();
  expect(click.errors).toEqual([]);
  expect(h.text(h.seen(click))).not.toMatch(/Already handled|table moved on|Bets are closed|cards are already out/i);
  expect(h.text(panel)).toContain('Host to act');
  expect(h.app.blackjack.peek(id)!.state.roundNumber).toBe(1);
  await h.click(host, panel, 'Stand');
  expect(h.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM game_rounds WHERE id = ?', [before.state.roundId])!.count).toBe(1);
  expect(h.app.economy.reconcile()).toEqual([]);
});

it('publishes the current table when its decorative frame is still rendering', async () => {
  h = new CasinoHarness();
  const host = h.user('Host');
  await h.openBlackjack(host);
  const table = h.app.blackjack.tableOfUser(h.guildId, host.id)!;
  const { promise, resolve } = Promise.withResolvers<Screen>();
  const sync = new PanelSync({
    name: 'table',
    client: h.bot.client,
    logger: h.app.logger,
    locate: () => table.record,
    frames: () => 1,
    frameBudgetMs: () => 5,
    minIntervalMs: 0,
    render: async (_id, frame) => frame === undefined
      ? noticeScreen({ title: 'Current table', body: 'The turn is ready.' })
      : promise,
    onMissing: async () => { throw new Error('Panel unexpectedly missing'); },
  });
  sync.request(table.record.id);
  await sync.idle();
  expect(h.text(h.tablePanel(table.record.id))).toContain('The turn is ready.');
  resolve(noticeScreen({ title: 'Late animation', body: 'This frame has expired.' }));
  await sync.idle();
  expect(h.text(h.tablePanel(table.record.id))).toContain('The turn is ready.');
  expect(sync.stats.viaRest).toBe(1);
});
