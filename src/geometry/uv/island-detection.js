/**
 * Island detection + boundary-loop walking.
 *
 * Given a set of marked "seam" edges, this module:
 *   1. Splits the mesh into islands (connected components of faces
 *      after removing the seam edges).
 *   2. Walks each island's boundary as a set of independent cycles.
 *
 * The boundary-walk is used by the Tutte / LSCM solvers to place
 * boundary vertices on a circle or square.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { buildEdgeKey, parseEdgeKey } from './edge-keys.js';

/**
 * Detect islands after removing the seam edges. An island is a
 * connected component of faces when the seam edges are removed.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Set<number>} seamKeys  set of edge keys (from buildEdgeKey)
 * @returns {Array<Island>}
 *   Island = { faces: number[], boundary: number[] }
 */
export function detectIslands(geometry, seamKeys) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  if (!pos) {
    throw new Error('detectIslands: geometry must have a position attribute');
  }
  if (!idx) {
    throw new Error('detectIslands: geometry must be indexed');
  }
  const faceCount = Math.floor(idx.count / 3);

  // Build a map: edge (canonical) → list of face indices. Also
  // build a set of "seam edges" (edges with only 1 face OR edges
  // explicitly marked as seams).
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const key = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(key);
      if (!list) { list = []; edgeToFaces.set(key, list); }
      list.push(f);
    }
  }
  const seamEdges = new Set();
  for (const [key, faces] of edgeToFaces) {
    if (faces.length < 2 || seamKeys.has(key)) {
      seamEdges.add(key);
    }
  }

  // Face adjacency: for each face, list of neighboring face indices
  // (faces that share a non-seam edge).
  const faceAdj = Array.from({ length: faceCount }, () => []);
  for (const [key, faces] of edgeToFaces) {
    if (seamEdges.has(key)) continue;
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        faceAdj[faces[i]].push(faces[j]);
        faceAdj[faces[j]].push(faces[i]);
      }
    }
  }

  // BFS over face adjacency to find connected components.
  const islandOf = new Array(faceCount).fill(-1);
  const islands = [];
  for (let f = 0; f < faceCount; f++) {
    if (islandOf[f] !== -1) continue;
    const faces = [];
    const queue = [f];
    islandOf[f] = islands.length;
    while (queue.length) {
      const cur = queue.shift();
      faces.push(cur);
      for (const nb of faceAdj[cur]) {
        if (islandOf[nb] === -1) {
          islandOf[nb] = islands.length;
          queue.push(nb);
        }
      }
    }
    // Find boundary vertices: vertices that are on a seam edge.
    const boundarySet = new Set();
    for (const fi of faces) {
      const a = idx.array[fi * 3 + 0];
      const b = idx.array[fi * 3 + 1];
      const c = idx.array[fi * 3 + 2];
      for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
        if (seamEdges.has(buildEdgeKey(va, vb))) {
          boundarySet.add(va);
          boundarySet.add(vb);
        }
      }
    }
    const boundary = [...boundarySet];
    islands.push({ faces, boundary });
  }
  return islands;
}

/**
 * Walk the boundary of an island as a set of independent cycles.
 * Returns an array of vertex-index arrays — one per cycle. The
 * cycles together cover every boundary edge of the island. Used
 * by the Tutte / LSCM solvers to place boundary vertices on the
 * unit circle: each cycle gets its own arc, proportional to its
 * edge count, so the interior Laplacian solve can flatten the
 * island without leaving any "strip" collapsed to a point.
 *
 * Why "all cycles" instead of one big loop? For multi-loop
 * boundaries (a cylinder with two open ends and one cut = a
 * theta graph; a torus boundary; etc.) the Tutte embedding
 * degenerates if the boundary is treated as one big loop and
 * placed on a single circle — the Laplacian solve then has
 * vertices on opposite sides of the circle that are
 * topologically adjacent, producing a sharp fold and huge
 * stretch. Decomposing into independent cycles and giving each
 * its own arc of the circle fixes this — the "theta" case
 * (capsule body after marking the cap-body junction + one
 * longitudinal seam) is the canonical example and the original
 * motivation for this function.
 *
 * Algorithm: greedy walk, one cycle per unused edge. For each
 * unused boundary edge, start a walk at one endpoint. At each
 * vertex, follow any unused edge (not going back the way we
 * came). The walk terminates when it either closes back to the
 * start vertex or hits a dead end. After the walk, mark all
 * traversed edges as used. Repeat until every boundary edge is
 * covered. For a simple ring (every boundary vertex has degree
 * 2), this produces one loop. For a theta graph, it produces
 * two loops — the top ring and the bottom ring, each treated
 * independently.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Island} island
 * @param {Set<number>} seamKeys
 * @returns {Array<Array<number>>} one array of vertex indices per cycle
 */
export function findAllBoundaryLoops(geometry, island, seamKeys) {
  const idx = geometry.index;
  // 1. Collect every boundary edge of this island.
  const edgeToFaces = new Map();
  for (const fi of island.faces) {
    const a = idx.array[fi * 3 + 0];
    const b = idx.array[fi * 3 + 1];
    const c = idx.array[fi * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push(fi);
    }
  }
  const boundaryEdgeKeys = new Set();
  for (const [k, faces] of edgeToFaces) {
    if (faces.length < 2 || seamKeys.has(k)) {
      boundaryEdgeKeys.add(k);
    }
  }
  if (boundaryEdgeKeys.size === 0) return [];
  // 2. Build the boundary neighbor map.
  const neighbors = new Map();
  for (const k of boundaryEdgeKeys) {
    const [a, b] = parseEdgeKey(k);
    if (!neighbors.has(a)) neighbors.set(a, []);
    if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  // 3. Greedy walk — one loop per unused edge.
  const used = new Set();
  const loops = [];
  const cap = boundaryEdgeKeys.size * 4 + 8;
  for (const startKey of boundaryEdgeKeys) {
    if (used.has(startKey)) continue;
    const [s0, s1] = parseEdgeKey(startKey);
    const loop = [s0, s1];
    used.add(startKey);
    let cur = s1;
    let prev = s0;
    let safety = cap;
    while (safety-- > 0) {
      const nbs = neighbors.get(cur) || [];
      let next = -1;
      let nextKey = -1;
      for (const nb of nbs) {
        if (nb === prev) continue;
        const nk = buildEdgeKey(cur, nb);
        if (used.has(nk)) continue;
        next = nb;
        nextKey = nk;
        break;
      }
      if (next < 0) break;
      used.add(nextKey);
      if (next === s0) break; // closed the loop
      loop.push(next);
      prev = cur;
      cur = next;
    }
    if (loop.length >= 2) loops.push(loop);
  }
  return loops;
}
