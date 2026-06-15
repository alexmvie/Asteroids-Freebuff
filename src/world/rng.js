/**
 * Mulberry32 — a tiny, fast, deterministic 32-bit PRNG.
 * See SPEC.md §3 (Seed Strategy) and the public-domain reference by Tommy Ettinger.
 *
 * Usage:
 *   const rng = mulberry32(0x1234);
 *   const v = rng();          // float in [0, 1)
 *   const i = (rng() * 10) | 0; // int in [0, 10)
 *
 * Properties:
 *   - Pure: same seed → identical infinite sequence.
 *   - Stateless w.r.t. the caller: each call mutates only its own closure.
 *   - Good enough for game-data randomness; NOT suitable for crypto.
 *
 * @param {number} seed 32-bit unsigned integer seed.
 * @returns {() => number} A function that returns the next value in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
