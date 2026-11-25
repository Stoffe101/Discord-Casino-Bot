import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAsync, type ResvgRenderOptions } from '@resvg/resvg-js';

/**
 * SVG → PNG rendering with bundled, openly licensed fonts (Cinzel + Manrope, SIL OFL).
 * Rendering runs on libuv's thread pool (renderAsync), so it never blocks the event loop; stills
 * are scheduled ahead of animation frames (see RenderPriority).
 */

export const FONT_DISPLAY = 'Cinzel';
export const FONT_UI = 'Manrope';

function findFontDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Works from src/render (tsx) and dist/render (compiled).
  for (const candidate of [resolve(here, '../../assets/fonts'), resolve(process.cwd(), 'assets/fonts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedOptions: ResvgRenderOptions | null = null;

export function renderOptions(): ResvgRenderOptions {
  if (cachedOptions) return cachedOptions;
  const dir = findFontDir();
  const fontFiles = dir ? readdirSync(dir).filter((f) => f.endsWith('.ttf')).map((f) => join(dir, f)) : [];
  cachedOptions = {
    font: {
      // System fonts are slow to scan (hundreds of ms); only fall back to them if ours are missing.
      loadSystemFonts: fontFiles.length === 0,
      fontFiles,
      defaultFontFamily: FONT_UI,
      sansSerifFamily: FONT_UI,
      serifFamily: FONT_DISPLAY,
    },
    shapeRendering: 2,
    textRendering: 1,
    logLevel: 'off',
  };
  return cachedOptions;
}

export function hasBundledFonts(): boolean {
  return findFontDir() !== null;
}

/**
 * Cumulative render timings, for benchmarks and the health screen. PNG and GIF raster times are
 * wall time as the caller sees it (queueing included); `gifEncodeMs` is main-thread time spent
 * quantizing and encoding, and `gifBlockMaxMs` the longest stretch of it without a break.
 */
export const renderStats = { png: 0, pngMs: 0, gif: 0, gifFrames: 0, gifRasterMs: 0, gifEncodeMs: 0, gifEncodeMaxMs: 0, gifBlockMaxMs: 0, queuedMax: 0 };

/**
 * What a render is for. A still is usually someone's answer (a bet on the table, their hand, the
 * slot machine) and is one frame; an animation is dozens of frames. libuv's thread pool runs work
 * first come, first served, so without this a still requested during a dealer-reveal animation
 * waited behind every queued frame of it.
 */
export type RenderPriority = 'still' | 'animation';

/** Renders in flight at once: libuv's pool size, so the order below decides who runs next. */
const RENDER_SLOTS = Math.max(1, Number(process.env.UV_THREADPOOL_SIZE) || 4);
let renderActive = 0;
const renderWaiting: Record<RenderPriority, Array<() => void>> = { still: [], animation: [] };

function acquireRenderSlot(priority: RenderPriority): Promise<void> | undefined {
  if (renderActive < RENDER_SLOTS) {
    renderActive++;
    return undefined;
  }
  renderStats.queuedMax = Math.max(renderStats.queuedMax, renderWaiting.still.length + renderWaiting.animation.length + 1);
  return new Promise((resolve) => renderWaiting[priority].push(resolve));
}

function releaseRenderSlot(): void {
  const next = renderWaiting.still.shift() ?? renderWaiting.animation.shift();
  if (next) next();
  else renderActive--;
}

/** Rasterise an SVG on the thread pool, stills before animation frames. */
export async function rasterize(svg: string, width: number | undefined, priority: RenderPriority = 'still'): Promise<RenderedImage> {
  const waiting = acquireRenderSlot(priority);
  if (waiting) await waiting;
  try {
    return await renderAsync(svg, width ? { ...renderOptions(), fitTo: { mode: 'width', value: width } } : renderOptions());
  } finally {
    releaseRenderSlot();
  }
}

type RenderedImage = Awaited<ReturnType<typeof renderAsync>>;

export async function svgToPng(svg: string, width?: number): Promise<Buffer> {
  const started = performance.now();
  const rendered = await rasterize(svg, width, 'still');
  const png = rendered.asPng();
  renderStats.png++;
  renderStats.pngMs += performance.now() - started;
  return png;
}

/** Small LRU of rendered PNGs keyed by a hash of the SVG source; concurrent requests share one render. */
export class PngCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  hits = 0;
  misses = 0;

  constructor(private readonly capacity = 128) {}

  static keyOf(svg: string): string {
    return createHash('sha1').update(svg).digest('hex').slice(0, 16);
  }

  async render(svg: string, width?: number): Promise<{ key: string; png: Buffer }> {
    const key = PngCache.keyOf(`${width ?? 0}:${svg}`);
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return { key, png: existing };
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.hits++;
      return { key, png: await pending };
    }
    this.misses++;
    const render = svgToPng(svg, width);
    this.inflight.set(key, render);
    try {
      const png = await render;
      this.entries.set(key, png);
      if (this.entries.size > this.capacity) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      return { key, png };
    } finally {
      this.inflight.delete(key);
    }
  }
}

export const sharedPngCache = new PngCache(192);
