/**
 * Tests for src/geometry/uv/abfpp.js.
 *
 * ABF++ minimizes per-triangle angle distortion by gradient
 * descent on the UV positions, initialized from LSCM. The
 * energy is E = sum (alpha_2D - alpha_3D)^2 / alpha_3D. This
 * is a simplified version of the full ABF++ (Sheffer, Lévy,
 * Mōri, Surazhsky 2005) — we use plain gradient descent with
 * a numerical gradient instead of L-BFGS with analytical
 * gradients.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/abfpp.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { buildEdgeKey, detectIslands, solveABFPlusPlus } from '../../src/geometry/uv/index.js';

test('solveABFPlusPlus: produces finite UVs on a capsule', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const seamKeys = new Set();
  const idx = geom.index.array;
  for (let f = 0; f < 4; f++) {
    seamKeys.add(buildEdgeKey(idx[f * 3 + 0], idx[f * 3 + 1]));
  }
  const islands = detectIslands(geom, seamKeys);
  for (const island of islands) {
    const { u, v } = solveABFPlusPlus(island, geom);
    for (let i = 0; i < u.length; i++) {
      assert.ok(Number.isFinite(u[i]), `u[${i}] not finite: ${u[i]}`);
      assert.ok(Number.isFinite(v[i]), `v[${i}] not finite: ${v[i]}`);
    }
  }
});
