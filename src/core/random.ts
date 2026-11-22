import { randomInt as cryptoRandomInt, randomUUID } from 'node:crypto';

/**
 * Randomness source. Production uses the OS CSPRNG via node:crypto; tests can inject
 * deterministic sequences. All game outcomes flow through this interface.
 */
export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export const secureRng: Rng = {
  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`maxExclusive must be a positive safe integer, got ${maxExclusive}`);
    }
    return cryptoRandomInt(maxExclusive);
  },
};

/** Unbiased in-place Fisher–Yates shuffle. */
export function shuffleInPlace<T>(items: T[], rng: Rng = secureRng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/** Deterministic RNG for tests and simulations (mulberry32). Never used for real games. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    int(maxExclusive: number): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(r * maxExclusive);
    },
  };
}

export function newId(): string {
  return randomUUID();
}

/** Short, human-friendly reference (for error references, access codes). */
export function shortCode(length = 6, rng: Rng = secureRng): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
}
