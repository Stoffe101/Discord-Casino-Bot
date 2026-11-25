import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as gifencModule from 'gifenc';
import type { GifencApi, Palette } from 'gifenc';
import { rasterize, renderStats } from './png.js';

// gifenc is CommonJS: Node exposes it as a default export, bundlers (vitest) as named exports.
// (The ESM build also has a default export, which is just GIFEncoder — so test for the functions.)
const named = gifencModule as unknown as Partial<GifencApi>;
const gifenc: GifencApi = typeof named.quantize === 'function' ? (named as GifencApi) : (gifencModule as unknown as { default: GifencApi }).default;
const { GIFEncoder, quantize } = gifenc;

/**
 * Short animations as GIFs (Discord can't animate parts of a message, so motion has to live in
 * the image). Frames are SVG strings rendered on libuv's thread pool (after any waiting stills);
 * one shared palette keeps colours stable; every frame after the first only stores the pixels that
 * changed (the rest is transparent), which keeps a full-width animation to a few hundred KB. GIFs
 * play once.
 *
 * Encoding runs on the main thread, so it is cheap and cooperative: identical frames are drawn
 * once, only pixels that changed are matched to the palette (through one lookup table for the
 * whole animation), and the encoder yields to the event loop after every frame, so a 30-frame
 * dealer reveal never holds up other players' clicks for more than a few milliseconds at a time.
 */

export interface GifFrame {
  svg: string;
  /** How long this frame stays on screen, in milliseconds. */
  delayMs: number;
}

const TRANSPARENT = 255;

/** Nearest palette colour, memoised per animation with gifenc's own colour bucketing. */
function paletteMatcher(palette: Palette): (rgba: number) => number {
  const cache = new Int16Array(1 << 16).fill(-1);
  return (rgba) => {
    const r = rgba & 0xff;
    const g = (rgba >>> 8) & 0xff;
    const b = (rgba >>> 16) & 0xff;
    const key = ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
    let k = cache[key]!;
    if (k >= 0) return k;
    // Same search (and tie-break) as gifenc's applyPalette.
    k = 0;
    let min = 1e100;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i]!;
      let d = (c[0]! - r) ** 2;
      if (d > min) continue;
      d += (c[1]! - g) ** 2;
      if (d > min) continue;
      d += (c[2]! - b) ** 2;
      if (d > min) continue;
      min = d;
      k = i;
    }
    cache[key] = k;
    return k;
  };
}

/** RGBA bytes as one 32-bit word per pixel (copied only if the buffer isn't word-aligned). */
function words(pixels: Uint8Array): Uint32Array {
  return pixels.byteOffset % 4 === 0
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2)
    : new Uint32Array(pixels.slice().buffer);
}

export async function framesToGif(frames: GifFrame[], width: number): Promise<{ gif: Buffer; durationMs: number }> {
  if (frames.length === 0) throw new Error('no frames');
  const rasterStarted = performance.now();
  const unique = new Map<string, ReturnType<typeof rasterize>>();
  const rendered = await Promise.all(frames.map((f) => {
    let image = unique.get(f.svg);
    if (!image) {
      image = rasterize(f.svg, width, 'animation');
      unique.set(f.svg, image);
    }
    return image;
  }));
  const encodeStarted = performance.now();
  let busy = 0;
  let block = 0;
  let slice = encodeStarted;
  const breathe = async () => {
    const ran = performance.now() - slice;
    busy += ran;
    block = Math.max(block, ran);
    await nextTurn();
    slice = performance.now();
  };

  const w = rendered[0]!.width;
  const h = rendered[0]!.height;
  const pixels = rendered.map((r) => new Uint8Array(r.pixels.buffer, r.pixels.byteOffset, r.pixels.byteLength));

  // One palette for the whole animation, learnt from the first and last frames (they contain
  // every colour on screen: the start state and the final state).
  const sample = new Uint8Array(pixels[0]!.length + pixels.at(-1)!.length);
  sample.set(pixels[0]!, 0);
  sample.set(pixels.at(-1)!, pixels[0]!.length);
  const palette: Palette = quantize(sample, 255);
  while (palette.length < 255) palette.push([0, 0, 0]);
  const match = paletteMatcher(palette.slice(0, 255));
  palette.push([255, 0, 255]); // index 255: transparency slot (never produced by the matcher)
  await breathe();

  const encoder = GIFEncoder();
  const first = words(pixels[0]!);
  const canvas = new Uint8Array(first.length);
  for (let p = 0; p < first.length; p++) canvas[p] = match(first[p]!);
  encoder.writeFrame(canvas.slice(), w, h, { palette, delay: frames[0]!.delayMs, repeat: -1 });
  await breathe();
  let previous = first;
  for (let i = 1; i < pixels.length; i++) {
    const current = words(pixels[i]!);
    // Only changed pixels are stored; unchanged ones are transparent and show the frame below.
    const delta = new Uint8Array(current.length).fill(TRANSPARENT);
    if (rendered[i] !== rendered[i - 1]) {
      for (let p = 0; p < current.length; p++) {
        const rgba = current[p]!;
        if (rgba === previous[p]) continue;
        const v = match(rgba);
        if (v !== canvas[p]) {
          delta[p] = v;
          canvas[p] = v;
        }
      }
    }
    encoder.writeFrame(delta, w, h, { delay: frames[i]!.delayMs, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
    previous = current;
    await breathe();
  }
  encoder.finish();
  const gif = Buffer.from(encoder.bytes());
  busy += performance.now() - slice;
  renderStats.gif++;
  renderStats.gifFrames += frames.length;
  renderStats.gifRasterMs += encodeStarted - rasterStarted;
  renderStats.gifEncodeMs += busy;
  renderStats.gifEncodeMaxMs = Math.max(renderStats.gifEncodeMaxMs, busy);
  renderStats.gifBlockMaxMs = Math.max(renderStats.gifBlockMaxMs, block);
  return { gif, durationMs: frames.reduce((sum, f) => sum + f.delayMs, 0) };
}
