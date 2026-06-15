/**
 * Canonical edge-key utilities.
 *
 * An "edge" in a triangle mesh is the pair of vertex indices
 * `(va, vb)` that form a side. For lookup in a `Set` or `Map`
 * we need a canonical, order-independent key — a key built from
 * `(va, vb)` must equal the key built from `(vb, va)`.
 *
 * This module provides:
 *   - `buildEdgeKey(va, vb)` — encode two vertex indices as an integer
 *   - `parseEdgeKey(key)`     — decode an integer back to `[lo, hi]`
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 * Extracted to its own module so other UV files can import these
 * helpers without pulling in the whole solver.
 */

const EPS = 1e-9;

/**
 * Build a canonical edge key from two vertex indices. The key
 * sorts the indices so the order doesn't matter. Returned as a
 * 32-bit integer (a + b * 65536) — works for vertex counts up to
 * 65535, which covers any reasonable asteroid mesh.
 *
 * @param {number} va
 * @param {number} vb
 * @returns {number}
 */
export function buildEdgeKey(va, vb) {
  const lo = Math.min(va, vb);
  const hi = Math.max(va, vb);
  return lo + hi * 65536;
}

/**
 * Parse an edge key back to the canonical `[lo, hi]` pair.
 *
 * @param {number} key
 * @returns {[number, number]}
 */
export function parseEdgeKey(key) {
  const lo = key % 65536;
  const hi = Math.floor(key / 65536);
  return [lo, hi];
}

// Re-export EPS so existing `import { EPS } from './edge-keys.js'`
// keeps working in downstream modules. (Only used by some internal
// functions; not part of the public API.)
export { EPS };
