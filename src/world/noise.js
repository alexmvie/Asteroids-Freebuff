/**
 * 2D Simplex noise with a seeded permutation table.
 * Adapted from Stefan Gustavson's public-domain reference implementation.
 *
 * Use `makeSimplex2(systemSeed)` to obtain a noise function bound to a
 * particular permutation. Same seed → identical noise field. Different
 * seeds → completely different fields. Output is approximately in [-1, 1].
 *
 * @param {number} systemSeed Any 32-bit-ish integer; used to shuffle the
 *   permutation table so the noise field is deterministic per system.
 * @returns {(x: number, y: number) => number} Noise function in ~[-1, 1].
 */
export function makeSimplex2(systemSeed) {
  // Lazy import to keep this module dependency-light at the source level.
  // Inlined mulberry32 to avoid a circular or surprising import path.
  let a = systemSeed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Build a 0..255 permutation then duplicate to 512 for wrap-free indexing.
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  // Standard 2D simplex gradient set (12 directions).
  const grad3 = new Float32Array([
    1, 1,  -1, 1,   1, -1,  -1, -1,
    1, 0,  -1, 0,   0, 1,    0, -1,
    1, 0,  -1, 0,   0, 1,    0, -1,
  ]);

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  return function noise2(xin, yin) {
    let n0 = 0, n1 = 0, n2 = 0;

    // Skew the input space to determine which simplex cell we're in.
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = xin - X0;
    const y0 = yin - Y0;

    // Determine which simplex (triangle) we are in.
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    // Hashed gradient indices for the three corners.
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = (perm[ii + perm[jj]] % 12) * 2;
    const gi1 = (perm[ii + i1 + perm[jj + j1]] % 12) * 2;
    const gi2 = (perm[ii + 1 + perm[jj + 1]] % 12) * 2;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0] * x0 + grad3[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1] * x1 + grad3[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2] * x2 + grad3[gi2 + 1] * y2);
    }

    // Scale to ~[-1, 1].
    return 70 * (n0 + n1 + n2);
  };
}
