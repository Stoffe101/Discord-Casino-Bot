import { renderAsync } from '@resvg/resvg-js';
import * as gifencModule from 'gifenc';
import type { GifencApi, Palette } from 'gifenc';
import { renderOptions } from './png.js';

// gifenc is CommonJS: Node exposes it as a default export, bundlers (vitest) as named exports.
// (The ESM build also has a default export, which is just GIFEncoder — so test for the functions.)
const named = gifencModule as unknown as Partial<GifencApi>;
const gifenc: GifencApi = typeof named.quantize === 'function' ? (named as GifencApi) : (gifencModule as unknown as { default: GifencApi }).default;
const { GIFEncoder, applyPalette, quantize } = gifenc;

/**
 * Short animations as GIFs (Discord can't animate parts of a message, so motion has to live in
 * the image). Frames are SVG strings rendered on libuv's thread pool; one shared palette keeps
 * colours stable; every frame after the first only stores the pixels that changed (the rest is
 * transparent), which keeps a full-width animation to a few hundred KB. GIFs play once.
 */

export interface GifFrame {
  svg: string;
  /** How long this frame stays on screen, in milliseconds. */
  delayMs: number;
}

const TRANSPARENT = 255;

export async function framesToGif(frames: GifFrame[], width: number): Promise<{ gif: Buffer; durationMs: number }> {
  if (frames.length === 0) throw new Error('no frames');
  const base = renderOptions();
  const rendered = await Promise.all(frames.map((f) => renderAsync(f.svg, { ...base, fitTo: { mode: 'width', value: width } })));
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
  palette.push([255, 0, 255]); // index 255: transparency slot (never produced by applyPalette)

  const encoder = GIFEncoder();
  let canvas: Uint8Array | null = null;
  for (const [i, rgba] of pixels.entries()) {
    const index = applyPalette(rgba, palette.slice(0, 255));
    if (!canvas) {
      encoder.writeFrame(index, w, h, { palette, delay: frames[i]!.delayMs, repeat: -1 });
      canvas = index;
      continue;
    }
    // Only changed pixels are stored; unchanged ones are transparent and show the frame below.
    const delta = new Uint8Array(index.length);
    for (let p = 0; p < index.length; p++) {
      const v = index[p]!;
      if (v === canvas[p]) delta[p] = TRANSPARENT;
      else {
        delta[p] = v;
        canvas[p] = v;
      }
    }
    encoder.writeFrame(delta, w, h, { delay: frames[i]!.delayMs, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
  }
  encoder.finish();
  return { gif: Buffer.from(encoder.bytes()), durationMs: frames.reduce((sum, f) => sum + f.delayMs, 0) };
}
