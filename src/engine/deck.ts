/**
 * Solo-mode deck: a plain random shuffle of the 52 cards.
 *
 * The original tournament/server deck plumbing (DayData, fixed 47-card server
 * decks, prime-walk) is intentionally not ported — it was cut from scope.
 *
 * The RNG is injectable so tests are deterministic. It must return a float in
 * [0, 1), like Math.random.
 */

import { type CardId, fullDeckIds } from "./cards.js";

export type Rng = () => number;

/** Fisher–Yates shuffle of a fresh 52-card deck. */
export function shuffledDeck(rng: Rng = Math.random): CardId[] {
  const deck = fullDeckIds();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

/** Small deterministic RNG (mulberry32) for tests. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic random source from a string seed.
 *
 * The tournament server issues the seed and replays the round with it to work
 * out the score, so both sides must produce the identical sequence — which is
 * why this lives in the engine, compiled once and shared, rather than being
 * written twice and drifting.
 *
 * mulberry32, seeded by FNV-1a over the string. Not cryptographic; it only has
 * to be well-distributed and identical everywhere.
 */
export function seededRng(seed: string): Rng {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
