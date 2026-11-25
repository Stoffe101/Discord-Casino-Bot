/**
 * #casino holds what belongs there: the lobby and live coinflip challenges. The bot's own
 * leftovers are removed; finished challenge cards leave after a short while; nobody else's
 * messages are ever touched.
 */
import { afterEach, expect, it } from 'vitest';
import { silentLogger } from '../../src/core/logger.js';
import { tidyCasinoChannels, tidyTiming } from '../../src/discord/channel-tidy.js';
import { CasinoHarness } from '../harness/casino-harness.js';

let h: CasinoHarness;
const saved = { ...tidyTiming };
afterEach(async () => {
  Object.assign(tidyTiming, saved);
  await h?.close();
});

async function challenge(h: CasinoHarness, from: ReturnType<CasinoHarness['user']>, to: ReturnType<CasinoHarness['user']>) {
  const screen = h.seen(await h.slash(from, 'games'))!;
  await h.click(from, screen, 'Coinflip');
  const card = h.seen(await h.submit(from, await h.select(from, screen, 'cf:pick', [to.id]), { amount: '25', call: 'tails' }))!;
  return card;
}

it('the startup sweep removes the bot’s own leftovers but keeps the lobby, live challenges and other people’s messages', async () => {
  h = new CasinoHarness();
  await h.boot();
  const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
  const lobby = h.lobby()!;
  const live = await challenge(h, alex, hanna);
  const channel = await h.bot.client.channels.fetch(h.casino);
  if (!channel?.isTextBased() || !('send' in channel)) throw new Error('no casino channel');
  const stray = await channel.send({ content: 'an old panel from an interrupted run' });
  const human = h.fd.postAsUser(hanna, h.casino, 'hi all');
  tidyTiming.minAgeMs = 0;
  const removed = await tidyCasinoChannels(h.bot.client, h.app, h.guard, silentLogger);
  expect(removed).toBe(1);
  expect(h.fd.messages.get(stray.id)!.deleted).toBe(true);
  expect(h.fd.messages.get(lobby.id)!.deleted).toBeFalsy();
  expect(h.fd.messages.get(live.id)!.deleted).toBeFalsy();
  expect(h.fd.messages.get(human.id)!.deleted).toBeFalsy();
  expect(h.guard!.blocked).toEqual([]);
});

it('with table threads off, an open table’s panel in #casino is never swept', async () => {
  h = new CasinoHarness(); // test mode without threads: panels are posted in the channel itself
  await h.boot();
  const alex = h.user('Alex');
  const screen = h.seen(await h.slash(alex, 'blackjack'))!;
  const opener = await h.click(alex, screen, 'Open a Blackjack table');
  await h.submit(alex, opener, { name: 'Rail', visibility: 'public' });
  const table = h.app.blackjack.tableOfUser(h.guildId, alex.id)!;
  expect(table.record.threadId).toBeFalsy();
  tidyTiming.minAgeMs = 0;
  await tidyCasinoChannels(h.bot.client, h.app, h.guard, silentLogger);
  expect(h.fd.messages.get(table.record.messageId!)!.deleted).toBeFalsy();
});

it('a declined challenge card leaves #casino after a short while', async () => {
  h = new CasinoHarness();
  tidyTiming.otherMs = 40;
  const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
  const card = await challenge(h, alex, hanna);
  await h.click(hanna, card, /^Decline/);
  expect(h.fd.messages.get(card.id)!.deleted).toBeFalsy(); // the outcome is shown first
  await new Promise((r) => setTimeout(r, 120));
  await h.settle();
  expect(h.fd.messages.get(card.id)!.deleted).toBe(true);
  expect(h.guard!.blocked).toEqual([]);
  expect(h.app.economy.reconcile()).toEqual([]);
});
