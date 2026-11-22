// Minimal typings for gifenc (pure-JS GIF encoder, MIT): only what the casino uses.
declare module 'gifenc' {
  export type Palette = number[][];
  export interface WriteFrameOptions {
    palette?: Palette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    first?: boolean;
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export interface GifencApi {
    GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): Encoder;
    quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: string }): Palette;
    applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array;
  }
  // Node loads the CommonJS build (only a default export); bundlers such as Vite load the ESM build
  // (only named exports). Both shapes are declared; src/render/gif.ts picks whichever exists.
  export const GIFEncoder: GifencApi['GIFEncoder'] | undefined;
  export const quantize: GifencApi['quantize'] | undefined;
  export const applyPalette: GifencApi['applyPalette'] | undefined;
  const gifenc: GifencApi | undefined;
  export default gifenc;
}
