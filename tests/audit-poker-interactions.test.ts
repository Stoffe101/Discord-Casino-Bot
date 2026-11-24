import { afterEach, expect, it } from 'vitest';
import { cardLabel } from '../src/games/cards.js';
import { CasinoHarness } from './harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => h.close());

async function openTable(visibility: 'public' | 'private') {
  h = new CasinoHarness({ allowThreads: true });
  h.app.settings.set(h.guildId, 'poker.enabled', true);
  const alice = h.user('Alice');
  const bob = h.user('Bob');
  const carol = h.user('Carol');
  const home = h.seen(await h.slash(alice, 'casino'))!;
  const games = h.seen(await h.click(alice, home, 'Games'))!;
  const browser = h.seen(await h.click(alice, games, 'Hold’em'))!;
  const creation = await h.click(alice, browser, 'Open a Hold’em table');
  await h.submit(alice, creation, { name: 'Audit', visibility: [visibility], seats: '6', buyin: '200' });
  const table = h.app.poker.tableOfUser(h.guildId, alice.id)!;
  const id = table.record.id;
  const panel = () => h.fd.messages.get(h.app.poker.peek(id)!.record.messageId!)!;
  return { alice, bob, carol, id, panel, code: table.record.accessCode };
}

it('rejects foreign, out-of-turn, stale and non-seated button presses without changing the hand', async () => {
  const { alice, bob, carol, id, panel } = await openTable('public');
  await h.submit(bob, await h.click(bob, panel(), 'Take a seat'), { buyin: '200' });
  const forbidden = h.seen(await h.click(carol, panel(), 'Deal (host)'))!;
  expect(h.text(forbidden)).toContain('Only the host');
  const alicePrivate = h.seen(await h.click(alice, panel(), 'Deal (host)'))!;
  const state = () => h.app.poker.peek(id)!.state;
  const seq = state().hand!.seq;
  // Bob presses Alice's (button/small blind) action: he is acting for another user and out of turn.
  const callId = h.buttons(alicePrivate).find((b) => b.label === 'Call 5')!.custom_id!;
  const forged = h.fd.clickRaw(bob, panel(), callId);
  await h.settle();
  const foreign = h.seen(forged)!;
  expect(h.text(foreign)).toMatch(/turn|Refresh/i);
  expect(state().hand!.seq).toBe(seq);
  // Carol is not seated: her My hand shows no cards and she cannot act.
  const carolView = h.seen(await h.click(carol, panel(), 'My hand'))!;
  for (const seat of state().hand!.seats) for (const card of seat.cards.map(cardLabel)) expect(h.text(carolView)).not.toContain(card);
  expect(h.enabled(carolView)).not.toContain('Fold');
  // Alice calls, then presses her old Call button again.
  await h.click(alice, alicePrivate, 'Call 5');
  expect(state().hand!.seq).toBe(seq + 1);
  const replay = h.fd.clickRaw(alice, alicePrivate, callId);
  await h.settle();
  const twice = h.seen(replay)!;
  expect(h.text(twice)).toMatch(/Refresh|turn|out of date/i);
  expect(state().hand!.seq).toBe(seq + 1);
  // Bob checks; his old Check button from pre-flop cannot act on the flop.
  const bobPrivate = h.seen(await h.click(bob, panel(), 'My hand'))!;
  const checkId = h.buttons(bobPrivate).find((b) => b.label === 'Check')!.custom_id!;
  await h.click(bob, bobPrivate, 'Check');
  expect(state().hand!.street).toBe('flop');
  const flopSeq = state().hand!.seq;
  // Post-flop the big blind acts first, so Bob is on turn again: only the sequence number makes it stale.
  expect(state().hand!.seats.find((seat) => seat.seat === state().hand!.actor)!.userId).toBe(bob.id);
  const old = h.fd.clickRaw(bob, bobPrivate, checkId);
  await h.settle();
  const stale = h.seen(old)!;
  expect(h.text(stale)).toMatch(/Refresh|turn|out of date/i);
  expect(state().hand!.seq).toBe(flopSeq);
  expect(h.app.economy.reconcile()).toEqual([]);
});

it('a private table cannot be joined without its access code by any route', async () => {
  const { carol, id, code, panel } = await openTable('private');
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  // Through the tables browser.
  const home = h.seen(await h.slash(carol, 'casino'))!;
  const before = h.app.economy.getWallet(h.guildId, carol.id);
  const games = h.seen(await h.click(carol, home, 'Games'))!;
  const browser = h.seen(await h.click(carol, games, 'Hold’em'))!;
  const modal = await h.click(carol, browser, 'Join with code');
  const wrong = h.seen(await h.submit(carol, modal, { buyin: '200', code: 'WRONG1' }))!;
  expect(h.text(wrong)).toContain('access code');
  // Directly through the service, as a forged join would.
  await expect(h.app.poker.join(id, carol.id, 'Carol', 200)).rejects.toThrow(/access code/);
  expect(h.app.economy.getWallet(h.guildId, carol.id)).toEqual(before);
  expect(h.app.poker.peek(id)!.state.seats.map((seat) => seat.userId)).not.toContain(carol.id);
  // The lowercase code is accepted and charges exactly one buy-in.
  await h.submit(carol, modal, { buyin: '200', code: code!.toLowerCase() });
  expect(h.app.economy.getWallet(h.guildId, carol.id)).toMatchObject({ reserved: 200, balance: before.balance - 200 });
  expect(panel()).toBeTruthy();
});
