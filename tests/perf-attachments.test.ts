/**
 * Performance regressions, asserted as behaviour (requests, uploads, ordering) rather than
 * milliseconds: the machine running the tests is shared.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canKeepAttachments } from '../src/discord/payload.js';
import { framesToGif } from '../src/render/gif.js';
import { rasterize, renderStats } from '../src/render/png.js';
import { cid } from '../src/ui/custom-id.js';
import type { Screen } from '../src/ui/kit.js';
import { NAV } from '../src/ui/screens/common.js';
import { CasinoHarness } from './harness/casino-harness.js';
import { FakeDiscord, findComponents, type FakeMessage } from './harness/fake-discord.js';

interface Sent { method: string; route: string; files: number; callbackType: number | null }

/** A harness whose Discord requests are logged with the number of files each one uploaded. */
function instrumented(): { h: CasinoHarness; sent: Sent[] } {
  const fd = new FakeDiscord();
  const guild = fd.addGuild('Test Server');
  fd.addChannel(guild, 'casino');
  fd.addChannel(guild, 'general');
  const sent: Sent[] = [];
  const inner = fd.makeRequest;
  (fd as unknown as { makeRequest: FakeDiscord['makeRequest'] }).makeRequest = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/api(\/v\d+)?/, '');
    let files = 0;
    let callbackType: number | null = null;
    const body = init.body as { entries?: () => Iterable<[string, unknown]> } | string | undefined;
    if (body && typeof body === 'object' && typeof body.entries === 'function') {
      for (const [key, value] of body.entries()) {
        if (key === 'payload_json') callbackType = (JSON.parse(String(value)) as { type?: number }).type ?? null;
        else files++;
      }
    } else if (typeof body === 'string') {
      callbackType = (JSON.parse(body) as { type?: number }).type ?? null;
    }
    sent.push({ method: (init.method ?? 'GET').toUpperCase(), route, files, callbackType: route.startsWith('/interactions/') ? callbackType : null });
    return inner(url, init);
  };
  return { h: new CasinoHarness({ discord: fd }), sent };
}

/** Press a control by custom id on a message (as Discord delivers it) and wait for the bot. */
async function press(h: CasinoHarness, user: ReturnType<CasinoHarness['user']>, message: FakeMessage, customId: string) {
  const rec = h.fd.clickRaw(user, message, customId);
  await h.settle();
  return rec;
}

const imageOf = (m: FakeMessage | null) => {
  // A media gallery's first item, or a section thumbnail (Wallet's badge).
  const url = m ? ((findComponents(m.components, 12)[0]?.items?.[0]?.media?.url ?? findComponents(m.components, 11)[0]?.media?.url) as string | undefined) : undefined;
  return url?.startsWith('attachment://') ? url.slice('attachment://'.length) : null;
};

describe('private panels re-use images they already carry', () => {
  let h: CasinoHarness;
  afterEach(async () => h.close());

  it('uploads the Games art once; returning to Games through screens without images uploads nothing', async () => {
    const t = instrumented();
    h = t.h;
    const alice = h.user('Alice');
    const panel = h.seen(await h.slash(alice, 'casino'))!;

    let mark = t.sent.length;
    await press(h, alice, panel, NAV.games);
    const art = imageOf(panel);
    expect(art).not.toBeNull();
    expect(t.sent.slice(mark)).toEqual([expect.objectContaining({ callbackType: 7, files: 1 })]);
    const uploaded = panel.attachments.find((a) => a.filename === art)!.id;

    // Rules has no image: the art stays on the message (hidden), nothing is uploaded or removed.
    mark = t.sent.length;
    await h.select(alice, panel, 'nav:rules', ['blackjack']);
    expect(imageOf(panel)).toBeNull();
    expect(t.sent.slice(mark)).toEqual([expect.objectContaining({ callbackType: 7, files: 0 })]);

    // Back to Games, and Games again from Home: one request each, no upload, the same attachment.
    for (const id of [NAV.floor, NAV.home, NAV.games]) {
      mark = t.sent.length;
      await press(h, alice, panel, id);
      expect(t.sent.slice(mark)).toEqual([expect.objectContaining({ callbackType: 7, files: 0 })]);
    }
    expect(imageOf(panel)).toBe(art);
    expect(panel.attachments.find((a) => a.filename === art)?.id).toBe(uploaded);
    expect(h.fd.problems).toEqual([]);
  });

  it('uploads when the screen needs an image the message does not have', async () => {
    const t = instrumented();
    h = t.h;
    const alice = h.user('Alice');
    const panel = h.seen(await h.slash(alice, 'casino'))!;
    await press(h, alice, panel, NAV.games);
    const mark = t.sent.length;
    await press(h, alice, panel, NAV.wallet);
    const badge = imageOf(panel);
    expect(badge).not.toBeNull();
    expect(t.sent.slice(mark)).toEqual([expect.objectContaining({ callbackType: 7, files: 1 })]);
    // The upload replaced the attachments: only what the wallet shows is left.
    expect(panel.attachments.map((a) => a.filename)).toEqual([badge]);
  });

  it('falls back to uploading when the image vanished from the message in the meantime', async () => {
    const t = instrumented();
    h = t.h;
    const alice = h.user('Alice');
    const panel = h.seen(await h.slash(alice, 'casino'))!;
    await press(h, alice, panel, NAV.games);
    await press(h, alice, panel, NAV.home);
    // The click still says the art is there, but by the time the answer arrives it is gone
    // (for example replaced by a second click a moment earlier).
    const mark = t.sent.length;
    const rec = h.fd.clickRaw(alice, panel, NAV.games);
    panel.attachments = [];
    await h.settle();
    expect(t.sent.slice(mark).map((s) => s.files)).toEqual([0, 1]);
    expect(rec.errors).toHaveLength(1);
    expect(imageOf(panel)).not.toBeNull();
    expect(panel.attachments.map((a) => a.filename)).toEqual([imageOf(panel)]);
    h.fd.problems.length = 0; // the rejected first attempt is expected here
  });

  it('keeps core screens to one Discord request each', async () => {
    const t = instrumented();
    h = t.h;
    const alice = h.user('Alice');
    let mark = t.sent.length;
    const panel = h.seen(await h.slash(alice, 'casino'))!;
    expect(t.sent.slice(mark)).toEqual([expect.objectContaining({ callbackType: 4 })]);
    for (const id of [NAV.games, NAV.wallet, NAV.home, NAV.profile, NAV.leaderboard, cid('nav', 'matches'), NAV.events, NAV.myTable, NAV.games]) {
      mark = t.sent.length;
      await press(h, alice, panel, id);
      expect(t.sent.slice(mark), id).toEqual([expect.objectContaining({ callbackType: 7 })]);
    }
  });
});

describe('attachment re-use rules', () => {
  const screen = (files: Array<{ name: string; size: number }>): Screen => ({
    components: [],
    files: files.map((f) => ({ name: f.name, data: Buffer.alloc(f.size) })),
  });

  it('re-uses only content-addressed names with the same size', () => {
    expect(canKeepAttachments(screen([]), [])).toBe(true);
    expect(canKeepAttachments(screen([{ name: 'table-0123456789abcdef.png', size: 10 }]), [{ name: 'table-0123456789abcdef.png', size: 10 }])).toBe(true);
    expect(canKeepAttachments(screen([{ name: 'emerald-gaming-floor.png', size: 10 }]), [{ name: 'emerald-gaming-floor.png', size: 10 }])).toBe(true);
    // A redrawn image under a fixed name (the style preview) is always uploaded again.
    expect(canKeepAttachments(screen([{ name: 'style.png', size: 10 }]), [{ name: 'style.png', size: 10 }])).toBe(false);
    expect(canKeepAttachments(screen([{ name: 'emerald-gaming-floor.png', size: 11 }]), [{ name: 'emerald-gaming-floor.png', size: 10 }])).toBe(false);
    expect(canKeepAttachments(screen([{ name: 'table-0123456789abcdef.png', size: 10 }]), [])).toBe(false);
  });
});

describe('rendering stays responsive', () => {
  const frame = (shift: number, size: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#143d30"/>`
    + Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 37 + shift) % size}" cy="${(i * 53) % size}" r="${20 + (i % 7)}" fill="#dba968" opacity=".6"/>`).join('')
    + '</svg>';

  it('renders a still ahead of queued animation frames', async () => {
    const order: string[] = [];
    const frames = Array.from({ length: 16 }, (_, i) => rasterize(frame(i, 900), 900, 'animation').then(() => order.push(`frame${i}`)));
    const still = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', 8, 'still').then(() => order.push('still'));
    await Promise.all([...frames, still]);
    // At most the frames already running finish first; every queued frame waits for the still.
    expect(order.indexOf('still')).toBeLessThan(order.length - 8);
  });

  it('yields to the event loop while encoding an animation', async () => {
    renderStats.gifBlockMaxMs = 0;
    const before = { ...renderStats };
    await framesToGif(Array.from({ length: 8 }, (_, i) => ({ svg: frame(i * 9, 320), delayMs: 50 })), 320);
    const encoded = renderStats.gifEncodeMs - before.gifEncodeMs;
    // The longest uninterrupted stretch is a fraction of the whole encode.
    expect(renderStats.gifBlockMaxMs).toBeLessThan(encoded);
    expect(renderStats.gif - before.gif).toBe(1);
  });
});
