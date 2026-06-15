/**
 * Tests for src/geometry/uv/tutte.js.
 *
 * Covers:
 *   - `computeTutteEmbedding`: produces a finite layout (no NaN),
 *     boundary vertices are on the unit square perimeter, interior
 *     vertices are solved.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/tutte.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { buildEdgeKey, detectIslands, computeTutteEmbedding } from '../../src/geometry/uv/index.js';

function makeCapsuleForTutteTests() {
  return new Capsule(1, 1.5, 4, 12, 6);
}

test('computeTutteEmbedding: produces finite UVs', () => {
  const geom = makeCapsuleForTutteTests();
  // Mark one edge as a seam to create a boundary.
  const seamKeys = new Set();
  const idx = geom.index.array;
  seamKeys.add(buildEdgeKey(idx[0], idx[1]));
  const islands = detectIslands(geom, seamKeys);
  for (const island of islands) {
    const { u, v } = computeTutteEmbedding(island, geom);
    for (let i = 0; i < u.length; i++) {
      assert.ok(Number.isFinite(u[i]), `u[${i}] is not finite: ${u[i]}`);
      assert.ok(Number.isFinite(v[i]), `v[${i}] is not finite: ${v[i]}`);
    }
  }
});

test('computeTutteEmbedding: boundary vertices lie on the unit square perimeter (approx)', () => {
  // The square-domain Tutte placement puts boundary vertices on
  // the perimeter of the unit square [0, 1] x [0, 1]. Each
  // boundary vertex should have u or v (or both) close to 0 or
  // 1. (Legacy: the circle placement put them on a circle —
  // that invariant no longer holds.)
  const geom = makeCapsuleForTutteTests();
  const seamKeys = new Set();
  const idx = geom.index.array;
  seamKeys.add(buildEdgeKey(idx[0], idx[1]));
  const islands = detectIslands(geom, seamKeys);
  const eps = 1e-6;
  for (const island of islands) {
    if (island.boundary.length < 3) continue;
    const { u, v } = computeTutteEmbedding(island, geom);
    for (const vert of island.boundary) {
      const onLeftEdge = Math.abs(u[vert]) < eps;
      const onRightEdge = Math.abs(u[vert] - 1) < eps;
      const onBottomEdge = Math.abs(v[vert]) < eps;
      const onTopEdge = Math.abs(v[vert] - 1) < eps;
      assert.ok(
        onLeftEdge || onRightEdge || onBottomEdge || onTopEdge,
        `boundary vertex ${vert} (u=${u[vert]}, v=${v[vert]}) is not on the unit square perimeter`,
      );
    }
  }
});
