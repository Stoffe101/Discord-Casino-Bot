import { afterEach, describe, expect, it } from 'vitest';
import { CasinoHarness } from '../harness/casino-harness.js';

describe('full-stack harness smoke test', () => {
  let h: CasinoHarness;
  afterEach(async () => {
    await h?.close();
  });

  it('answers /casino with a private home screen', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const rec = await h.slash(alice, 'casino');
    expect(rec.errors).toEqual([]);
    expect(rec.callbacks).toEqual([4]);
    const home = h.seen(rec)!;
    expect(home.forUser).toBe(alice.id);
    expect(h.text(home)).toContain('Alice');
    expect(h.enabled(home)).toContain('Play a game');
    expect(h.text(home)).toContain('Your table');
    expect(h.enabled(home)).not.toContain('Play Blackjack');
    expect(h.fd.problems).toEqual([]);
  });

  it('opens Blackjack from the Games screen in #casino (threads are disabled in test mode)', async () => {
    h = new CasinoHarness();
    const alice = h.user('Alice');
    const home = h.seen(await h.slash(alice, 'casino'));
    const rec = await h.openBlackjack(alice, home);
    expect(rec.errors).toEqual([]);
    const tables = h.app.blackjack.allOpenTables();
    expect(tables).toHaveLength(1);
    const panel = h.tablePanel(tables[0]!.record.id);
    expect(panel.channelId).toBe(h.casino);
    expect(panel.attachments.length).toBe(1);
    expect(h.fd.problems).toEqual([]);
    expect(h.guard!.blockedCount).toBe(0);
  });
});
