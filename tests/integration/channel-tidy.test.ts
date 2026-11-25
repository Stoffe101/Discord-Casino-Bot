/**
 * #casino holds what belongs there: the lobby, live coinflip challenges and open tables. The
 * bot's own messages that the records show are finished are removed (closed panels, finished
 * challenge cards after a short while); anything unexplained and nobody else's messages are
 * never touched.
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

it('the sweep removes only what the records show is finished; the lobby, live challenges, unexplained bot messages and other people’s messages stay', async () => {
  h = new CasinoHarness(); // threads off: table panels are posted in #casino itself
  await h.boot();
  const [alex, hanna, kim] = [h.user('Alex'), h.user('Hanna'), h.user('Kim')];
  const lobby = h.lobby()!;
  const live = await challenge(h, alex, hanna);
  // A table that has closed: its panel in #casino is finished.
  const screen = h.seen(await h.slash(kim, 'blackjack'))!;
  await h.submit(kim, await h.click(kim, screen, 'Open a Blackjack table'), { name: 'Rail', visibility: 'public' });
  const table = h.app.blackjack.tableOfUser(h.guildId, kim.id)!.record;
  await h.app.blackjack.closeTable(table.id, 'test', { force: true });
  await h.settle();
  const channel = await h.bot.client.channels.fetch(h.casino);
  if (!channel?.isTextBased() || !('send' in channel)) throw new Error('no casino channel');
  // A bot message the database cannot explain (another runtime under the same account, say).
  const unexplained = await channel.send({ content: 'a message these records know nothing about' });
  const human = h.fd.postAsUser(hanna, h.casino, 'hi all');
  tidyTiming.minAgeMs = 0;
  const removed = await tidyCasinoChannels(h.bot.client, h.app, h.guard, silentLogger);
  expect(h.fd.messages.get(table.messageId!)!.deleted).toBe(true);
  expect(removed).toBe(1);
  for (const kept of [unexplained.id, lobby.id, live.id, human.id]) expect(h.fd.messages.get(kept)!.deleted).toBeFalsy();
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

it('a finished challenge card whose timer was lost (a restart) is swept once its linger time has passed', async () => {
  h = new CasinoHarness();
  await h.boot();
  const [alex, hanna] = [h.user('Alex'), h.user('Hanna')];
  tidyTiming.otherMs = 60 * 60_000; // the in-process timer won't fire during this test
  const card = await challenge(h, alex, hanna);
  await h.click(hanna, card, /^Decline/);
  tidyTiming.minAgeMs = 0;
  expect(await tidyCasinoChannels(h.bot.client, h.app, h.guard, silentLogger)).toBe(0); // still showing its outcome
  tidyTiming.otherMs = 0;
  expect(await tidyCasinoChannels(h.bot.client, h.app, h.guard, silentLogger)).toBe(1);
  expect(h.fd.messages.get(card.id)!.deleted).toBe(true);
  expect(h.guard!.blocked).toEqual([]);
});
