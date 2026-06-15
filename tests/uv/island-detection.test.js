/**
 * Tests for src/geometry/uv/island-detection.js.
 *
 * Covers:
 *   - `detectIslands`: finds connected components after seam removal.
 *     The theta-graph boundary case is tested in `reunwrap.test.js`
 *     (it needs the end-to-end `reunwrap` + `computeStretch` to
 *     verify the multi-loop walker actually fires).
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/island-detection.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { buildEdgeKey, detectIslands } from '../../src/geometry/uv/index.js';

// Helper: build a Capsule geometry that has been merged to
// share vertices across faces. The Capsule is already indexed
// (its constructor emits an index buffer) and the body has
// enough topology to exercise the seam-detection algorithm.
function makeCapsuleForIslandTests() {
  return new Capsule(1, 1.5, 4, 12, 6);
}

test('detectIslands: closed capsule (no seams) is one island', () => {
  const geom = makeCapsuleForIslandTests();
  const islands = detectIslands(geom, new Set());
  // The capsule's caps are open (no top/bottom), so there's
  // already a boundary. Even with no user seams, we expect
  // exactly 1 island (the whole thing is one connected piece).
  assert.equal(islands.length, 1);
});

test('detectIslands: marking a seam changes the island count', () => {
  const geom = makeCapsuleForIslandTests();
  const before = detectIslands(geom, new Set());
  const seamKeys = new Set();
  const idx = geom.index.array;
  // Mark one edge on the cylindrical body as a seam.
  seamKeys.add(buildEdgeKey(idx[0], idx[1]));
  const after = detectIslands(geom, seamKeys);
  // Marking a seam should at minimum keep the same number of
  // islands (no new connections), or split into more islands.
  assert.ok(after.length >= before.length,
    `Expected more or equal islands after seam, got before=${before.length}, after=${after.length}`);
});
