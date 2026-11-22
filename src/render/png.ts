import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAsync, type ResvgRenderOptions } from '@resvg/resvg-js';

/**
 * SVG → PNG rendering with bundled, openly licensed fonts (Cinzel + Manrope, SIL OFL).
 * Rendering runs on libuv's thread pool (renderAsync), so it never blocks the event loop.
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

function renderOptions(): ResvgRenderOptions {
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

export async function svgToPng(svg: string, width?: number): Promise<Buffer> {
  const options = width ? { ...renderOptions(), fitTo: { mode: 'width' as const, value: width } } : renderOptions();
  const rendered = await renderAsync(svg, options);
  return rendered.asPng();
}

/** Small LRU of rendered PNGs keyed by a hash of the SVG source. */
export class PngCache {
  private readonly entries = new Map<string, Buffer>();
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
    this.misses++;
    const png = await svgToPng(svg, width);
    this.entries.set(key, png);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return { key, png };
  }
}

export const sharedPngCache = new PngCache(192);
