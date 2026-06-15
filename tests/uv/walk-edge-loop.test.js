/**
 * Tests for src/geometry/uv/walk-edge-loop.js.
 *
 * Covers:
 *   - `walkEdgeLoop`: boundary edge returns just that edge,
 *     interior edge returns a connected sequence, respects the
 *     `maxSteps` safety cap.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/walk-edge-loop.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { buildEdgeKey, parseEdgeKey, walkEdgeLoop } from '../../src/geometry/uv/index.js';

test('walkEdgeLoop: boundary edge returns just that edge', () => {
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  const idx = geom.index.array;
  // Find a boundary edge (one that has only 1 adjacent face).
  const edgeToFaces = new Map();
  const faceCount = Math.floor(idx.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const a = idx[f * 3 + 0];
    const b = idx[f * 3 + 1];
    const c = idx[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push({ f, va, vb });
    }
  }
  let boundaryEdge = null;
  for (const [k, faces] of edgeToFaces) {
    if (faces.length < 2) {
      boundaryEdge = [faces[0].va, faces[0].vb];
      break;
    }
  }
  assert.ok(boundaryEdge, 'expected at least one boundary edge on a capsule');
  const loop = walkEdgeLoop(geom, boundaryEdge[0], boundaryEdge[1]);
  assert.equal(loop.length, 1);
  assert.equal(loop[0].va, boundaryEdge[0]);
  assert.equal(loop[0].vb, boundaryEdge[1]);
});

test('walkEdgeLoop: interior edge returns a connected sequence', () => {
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  const idx = geom.index.array;
  // Find a real interior edge (one with exactly 2 adjacent
  // faces). Just picking idx[0], idx[1] can land on a boundary
  // edge of the cap, which would degenerate to a 1-edge loop.
  const faceCount = Math.floor(idx.length / 3);
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const a = idx[f * 3 + 0];
    const b = idx[f * 3 + 1];
    const c = idx[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push(f);
    }
  }
  let interiorEdge = null;
  for (const [k, faces] of edgeToFaces) {
    if (faces.length === 2) {
      // Decode the edge to get va, vb.
      interiorEdge = parseEdgeKey(k);
      break;
    }
  }
  assert.ok(interiorEdge, 'expected at least one interior edge on a capsule');
  const [va, vb] = interiorEdge;
  const loop = walkEdgeLoop(geom, va, vb);
  // Every returned edge must be a valid edge (a, b vertex pair).
  for (const e of loop) {
    assert.ok(Number.isInteger(e.va) && e.va >= 0, `invalid va: ${e.va}`);
    assert.ok(Number.isInteger(e.vb) && e.vb >= 0, `invalid vb: ${e.vb}`);
  }
  // The first edge must match the start.
  assert.equal(loop[0].va, va);
  assert.equal(loop[0].vb, vb);
  // Each consecutive edge must share a vertex with the previous.
  for (let i = 1; i < loop.length; i++) {
    const prev = loop[i - 1];
    const cur = loop[i];
    const shared = prev.va === cur.va || prev.va === cur.vb
                || prev.vb === cur.va || prev.vb === cur.vb;
    assert.ok(shared, `edge ${i} (${cur.va},${cur.vb}) doesn't share a vertex with edge ${i - 1} (${prev.va},${prev.vb})`);
  }
  // The loop should not be the trivial 1-edge case for an
  // interior edge of a non-degenerate mesh.
  assert.ok(loop.length >= 2, `expected loop length >= 2 for interior edge, got ${loop.length}`);
});

test('walkEdgeLoop: respects the maxSteps safety cap', () => {
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  const idx = geom.index.array;
  const faceCount = Math.floor(idx.length / 3);
  // Find an interior edge (see test above for why idx[0], idx[1]
  // isn't reliable).
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const a = idx[f * 3 + 0];
    const b = idx[f * 3 + 1];
    const c = idx[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push(f);
    }
  }
  let interiorEdge = null;
  for (const [k, faces] of edgeToFaces) {
    if (faces.length === 2) { interiorEdge = parseEdgeKey(k); break; }
  }
  assert.ok(interiorEdge, 'expected at least one interior edge on a capsule');
  const [va, vb] = interiorEdge;
  const loop = walkEdgeLoop(geom, va, vb, 3);
  assert.ok(loop.length <= 4, `expected loop length <= 4 with maxSteps=3, got ${loop.length}`);
});
