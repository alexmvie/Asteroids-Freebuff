/**
 * Edge-loop walking.
 *
 * Given a starting edge, walk the "edge loop" — a band of
 * connected edges that share the same topological neighborhood.
 * Used for Alt+Click loop selection in both the 2D UV editor
 * and the 3D mini viewport.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { buildEdgeKey } from './edge-keys.js';

/**
 * Walk the edge loop starting at the given edge (startVa, startVb).
 * Returns an array of { va, vb } edges that form a connected
 * "band" around the mesh.
 *
 * Algorithm (Blender-style edge loop):
 *   1. The starting edge has two adjacent faces F1 and F2.
 *   2. Pick F2 as the "next" face — the loop will alternate
 *      between F1's side and F2's side of the band.
 *   3. The third vertex of F2 is the next vertex. The next
 *      edge is (startVb, nextVert).
 *   4. That edge has two adjacent faces: F2 and a new face F3.
 *      The next vertex is F3's third vertex. And so on.
 *   5. Continue until the loop closes, hits a boundary, or
 *      the safety cap.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {number} startVa
 * @param {number} startVb
 * @param {number} [maxSteps=10000]  safety cap
 * @returns {Array<{ va: number, vb: number }>}
 */
export function walkEdgeLoop(geometry, startVa, startVb, maxSteps = 10000) {
  const idxArr = geometry.index.array;
  const faceCount = Math.floor(idxArr.length / 3);
  // Build edge → faces map.
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const a = idxArr[f * 3 + 0];
    const b = idxArr[f * 3 + 1];
    const c = idxArr[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push(f);
    }
  }
  // Pre-compute per-face vertex arrays.
  const faceVerts = new Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    faceVerts[f] = [idxArr[f * 3 + 0], idxArr[f * 3 + 1], idxArr[f * 3 + 2]];
  }
  function thirdVertex(faceIdx, va, vb) {
    const v = faceVerts[faceIdx];
    for (let i = 0; i < 3; i++) {
      if (v[i] !== va && v[i] !== vb) return v[i];
    }
    return -1;
  }
  const startK = buildEdgeKey(startVa, startVb);
  const startFaces = edgeToFaces.get(startK);
  if (!startFaces || startFaces.length < 2) {
    return [{ va: startVa, vb: startVb }];
  }
  const f1 = startFaces[0];
  const f2 = startFaces[1];
  const loop = [];
  const visited = new Set();
  let prevFace = f1;
  let prev = startVa;
  let cur = startVb;
  while (true) {
    const ek = buildEdgeKey(prev, cur);
    if (visited.has(ek)) break;
    visited.add(ek);
    loop.push({ va: prev, vb: cur });
    if (loop.length > maxSteps) break;
    const faces = edgeToFaces.get(ek);
    if (!faces || faces.length < 2) break;
    const nextFace = faces[0] === prevFace ? faces[1] : faces[0];
    const next = thirdVertex(nextFace, prev, cur);
    if (next < 0) break;
    if (buildEdgeKey(cur, next) === startK) {
      loop.push({ va: cur, vb: next });
      break;
    }
    prevFace = nextFace;
    prev = cur;
    cur = next;
  }
  return loop;
}
