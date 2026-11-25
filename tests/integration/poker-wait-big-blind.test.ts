/**
 * "Wait for big blind" from a player's private Hold'em view: a player who owes blinds either posts
 * them and plays the next hand (the default) or waits until the big blind reaches them. The choice
 * is stored with the seat (it survives a restart) and only choices the next deal can honour show.
 */
import { afterEach, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';

let h: CasinoHarness;
afterEach(async () => h.close());

async function runningTable() {
  h = new CasinoHarness({ allowThreads: true });
  h.app.settings.set(h.guildId, 'poker.enabled', true);
  const [alice, bob, carol] = [h.user('Alice'), h.user('Bob'), h.user('Carol')];
  const home = h.seen(await h.slash(alice, 'casino'))!;
  const games = h.seen(await h.click(alice, home, 'Games'))!;
  const browser = h.seen(await h.click(alice, games, 'Hold’em'))!;
  await h.submit(alice, await h.click(alice, browser, 'Open a Hold’em table'), { name: 'Blinds', visibility: ['public'], seats: '6', buyin: '200' });
  const id = h.app.poker.tableOfUser(h.guildId, alice.id)!.record.id;
  const panel = () => h.fd.messages.get(h.app.poker.peek(id)!.record.messageId!)!;
  await h.submit(bob, await h.click(bob, panel(), 'Take a seat'), { buyin: '200' });
  await h.click(alice, panel(), 'Deal (host)');
  return { alice, bob, carol, id, panel };
}

/** Everyone still to act folds until the hand is over. */
async function foldOut(id: string): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    const { state } = h.app.poker.peek(id)!;
    const hand = state.hand;
    if (!hand || hand.result) break;
    const actor = hand.seats.find((seat) => seat.seat === hand.actor)!;
    await h.app.poker.act(id, actor.userId, state.handId!, hand.seq, { type: 'fold' });
  }
  await h.settle();
}

it('a player joining a running game chooses to wait for the big blind, then to post again', async () => {
  const { alice, carol, id, panel } = await runningTable();
  // A second heads-up hand moves the big blind back to Alice (seat 0), so the next big blind after
  // Carol sits down (seat 2) is Bob's, not hers: waiting really means sitting a hand out.
  await foldOut(id);
  await h.click(alice, panel(), 'Deal (host)');
  expect(h.app.poker.peek(id)!.state.lastBigBlind).toBe(0);
  // Carol takes a seat mid-hand: she owes a big blind.
  await h.submit(carol, await h.click(carol, panel(), 'Take a seat'), { buyin: '200' });
  const view = h.seen(await h.click(carol, panel(), 'My hand'))!;
  expect(h.text(view)).toMatch(/You owe 10 in blinds/);
  expect(h.enabled(view)).toContain('Wait for big blind');

  const waiting = h.seen(await h.click(carol, view, 'Wait for big blind'))!;
  expect(h.text(waiting)).toMatch(/Waiting for the big blind/);
  expect(h.enabled(waiting)).toContain('Post and play next hand');
  const seat = () => h.app.poker.peek(id)!.state.seats.find((s) => s.userId === carol.id)!;
  expect(seat().waitForBigBlind).toBe(true);

  // Next hand: Carol is not dealt in and pays nothing.
  await foldOut(id);
  const before = seat().stack;
  await h.click(alice, panel(), 'Deal (host)');
  const hand2 = h.app.poker.peek(id)!.state.hand!;
  expect(hand2.bigBlindSeat).not.toBe(seat().seat);
  expect(hand2.seats.some((s) => s.userId === carol.id)).toBe(false);
  expect(seat().stack).toBe(before);

  // She changes her mind: the next hand deals her in with the blind posted.
  const back = h.seen(await h.click(carol, h.seen(await h.click(carol, panel(), 'My hand'))!, 'Post and play next hand'))!;
  expect(h.enabled(back)).toContain('Wait for big blind');
  expect(seat().waitForBigBlind).toBe(false);
  await foldOut(id);
  await h.click(alice, panel(), 'Deal (host)');
  const hand3 = h.app.poker.peek(id)!.state.hand!;
  expect(hand3.seats.some((s) => s.userId === carol.id)).toBe(true);
  expect(seat().owesBigBlind).toBe(false);
  // Dealt in: nothing owed any more, so the control is gone.
  const after = h.seen(await h.click(carol, panel(), 'My hand'))!;
  expect(h.buttons(after).some((b) => b.label === 'Wait for big blind' || b.label === 'Post and play next hand')).toBe(false);
  expect(h.app.economy.reconcile()).toEqual([]);
  expect(h.fd.problems).toEqual([]);
});

it('a stack that cannot cover the owed blinds offers no posting choice', async () => {
  const { carol, id, panel } = await runningTable();
  await h.submit(carol, await h.click(carol, panel(), 'Take a seat'), { buyin: '200' });
  // Shrink Carol's stack below the big blind she owes (as if she had lost most of it earlier).
  const table = h.app.poker.peek(id)!;
  table.state.seats.find((s) => s.userId === carol.id)!.stack = 10;
  const view = h.seen(await h.click(carol, panel(), 'My hand'))!;
  expect(h.text(view)).toMatch(/can’t cover/);
  expect(h.buttons(view).some((b) => b.label === 'Wait for big blind' || b.label === 'Post and play next hand')).toBe(false);
});
