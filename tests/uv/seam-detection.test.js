/**
 * Tests for src/geometry/uv/seam-detection.js.
 *
 * Covers:
 *   - `autoDetectSeams`: returns a Set of vertex-edge keys for
 *     edges where the dihedral angle exceeds the threshold
 *     (curvature-based seam detection).
 *   - `autoUnwrap`: end-to-end convenience that combines
 *     `autoDetectSeams` + `reunwrap`.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/seam-detection.js`.
 * The monolithic `tests/uv-unwrapping.test.js` didn't directly
 * test these helpers (they were tested indirectly via the
 * orchestrator's AUTO button), so these are fresh baseline tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { autoDetectSeams, autoUnwrap } from '../../src/geometry/uv/index.js';

test('autoDetectSeams: detects seam edges on a capsule above the dihedral threshold', () => {
  // autoDetectSeams requires an INDEXED geometry (it walks the
  // index buffer to compute per-edge dihedral angles). The
  // Capsule is indexed. The capsule has a 90° dihedral at the
  // cap-body junction (the body cylinder meets the hemisphere
  // cap), so edges there should exceed the 30° threshold and
  // be marked as seams.
  const geom = new Capsule(1, 1, 4, 8, 4);
  const seamKeys = autoDetectSeams(geom, 30);
  assert.ok(seamKeys instanceof Set, 'expected a Set');
  assert.ok(seamKeys.size > 0, `expected at least one detected seam, got ${seamKeys.size}`);
  for (const k of seamKeys) {
    assert.ok(Number.isFinite(k), `seam key should be a finite number, got ${k}`);
  }
});

test('autoDetectSeams: lowering the threshold yields more seams', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const fewSeams = autoDetectSeams(geom, 60);
  const manySeams = autoDetectSeams(geom, 10);
  // Lower threshold → more edges qualify as seams.
  assert.ok(manySeams.size >= fewSeams.size,
    `expected lower threshold to yield >= seams, got ${manySeams.size} (10°) vs ${fewSeams.size} (60°)`);
});

test('autoUnwrap: returns a valid result on a capsule', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const result = autoUnwrap(geom, { thresholdDeg: 30 });
  // Result should be valid (finite UVs, has islands).
  for (let i = 0; i < result.u.length; i++) {
    assert.ok(Number.isFinite(result.u[i]), `u[${i}] not finite: ${result.u[i]}`);
    assert.ok(Number.isFinite(result.v[i]), `v[${i}] not finite: ${result.v[i]}`);
  }
  assert.ok(result.islands && result.islands.length > 0,
    `expected at least one island, got ${result.islands ? result.islands.length : 'no islands array'}`);
});
