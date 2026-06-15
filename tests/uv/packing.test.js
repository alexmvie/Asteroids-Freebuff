/**
 * Tests for src/geometry/uv/packing.js.
 *
 * Covers:
 *   - `packIslandsIntoGrid`: takes an array of pre-computed
 *     island data (per-island UV bounding boxes + UV arrays)
 *     and writes packed (u, v) coordinates back into the
 *     output arrays. The function is an in-place mutator.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/packing.js`.
 * The monolithic `tests/uv-unwrapping.test.js` didn't directly
 * test this helper (it was tested indirectly via the end-to-end
 * `reunwrap` tests), so these are fresh baseline tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { buildEdgeKey, reunwrap } from '../../src/geometry/uv/index.js';
import { packIslandsIntoGrid } from '../../src/geometry/uv/packing.js';

test('packIslandsIntoGrid: mutates the outU/outV arrays in place', () => {
  // The packer is an in-place mutator — it takes pre-computed
  // island data and writes packed (u, v) coordinates back. The
  // canonical way to test it is to feed it the output of
  // reunwrap (with packing disabled) and verify the post-pack
  // coordinates are still finite and fit in [0, 1]².
  const geom = new Capsule(1, 1, 4, 8, 4);
  const seamKeys = new Set();
  const idx = geom.index.array;
  // Mark a longitudinal seam.
  seamKeys.add(buildEdgeKey(idx[0], idx[1]));
  // Run reunwrap WITHOUT packing (we want to test packIslandsIntoGrid
  // directly, not the integrated pipeline).
  const layout = reunwrap(geom, seamKeys, { pack: false });
  // Build the per-island data structure the packer expects:
  // { island, u, v, minU, maxU, minV, maxV, width, height }.
  const islandData = [];
  const outU = new Float64Array(layout.u.length);
  const outV = new Float64Array(layout.v.length);
  for (const island of layout.islands) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const fi of island.faces) {
      const a = idx[fi * 3 + 0];
      const b = idx[fi * 3 + 1];
      const c = idx[fi * 3 + 2];
      for (const v of [a, b, c]) {
        if (layout.u[v] < minU) minU = layout.u[v];
        if (layout.u[v] > maxU) maxU = layout.u[v];
        if (layout.v[v] < minV) minV = layout.v[v];
        if (layout.v[v] > maxV) maxV = layout.v[v];
      }
    }
    const u = layout.u;
    const v = layout.v;
    islandData.push({
      island, u, v,
      minU, maxU, minV, maxV,
      width: maxU - minU,
      height: maxV - minV,
    });
  }
  // Call the packer.
  packIslandsIntoGrid(islandData, outU, outV, 0, geom);
  // Verify the output is finite + in [0, 1]².
  for (let i = 0; i < outU.length; i++) {
    assert.ok(Number.isFinite(outU[i]), `outU[${i}] should be finite, got ${outU[i]}`);
    assert.ok(Number.isFinite(outV[i]), `outV[${i}] should be finite, got ${outV[i]}`);
    assert.ok(outU[i] >= -0.001 && outU[i] <= 1.001, `outU[${i}] = ${outU[i]} should be in [0, 1]`);
    assert.ok(outV[i] >= -0.001 && outV[i] <= 1.001, `outV[${i}] = ${outV[i]} should be in [0, 1]`);
  }
  // The packer should have written something — not all zeros.
  let anyNonZero = false;
  for (let i = 0; i < outU.length; i++) {
    if (outU[i] !== 0 || outV[i] !== 0) { anyNonZero = true; break; }
  }
  assert.ok(anyNonZero, 'packer should have written non-zero coordinates');
  // Tighter packer-only assertion: the packer should have
  // actually MOVED at least one vertex's UV (not just rewritten
  // the same values). Snapshot the input UVs, then verify
  // at least one entry of outU differs from layout.u.
  let anyMoved = false;
  for (let i = 0; i < outU.length; i++) {
    if (outU[i] !== layout.u[i] || outV[i] !== layout.v[i]) {
      anyMoved = true;
      break;
    }
  }
  assert.ok(anyMoved, 'packer should have moved at least one vertex UV');
});
