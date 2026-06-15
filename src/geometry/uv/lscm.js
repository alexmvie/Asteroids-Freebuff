/**
 * LSCM (Least-Squares Conformal Mapping) solver.
 *
 * LSCM is a conformal (angle-preserving) parameterization that
 * minimizes the Dirichlet energy of the mapping, weighted by
 * cotangent weights. Same algorithm Blender's "Unwrap" uses
 * when "Conformal" is selected. Strict upgrade over uniform-
 * weight Tutte for organic shapes: the cotangent weights
 * account for the local triangle shape, so the Laplacian
 * solve doesn't pull interior vertices toward the boundary
 * (the "corner-pinch" that gives ~14× stretch on the square-
 * Tutte placement).
 *
 * Math: for each interior vertex v, the LSCM energy is
 *   E = sum_{(v,j) edge} w_vj * |u_v - u_j|^2
 * where w_vj is the cotangent weight of edge (v, j):
 *   w_vj = (cot(alpha_vj) + cot(beta_vj)) / 2
 * and alpha, beta are the angles opposite edge (v, j) in the
 * two adjacent triangles.
 *
 * Reference: Lévy et al., "Least Squares Conformal Maps for
 * Automatic Texture Atlas Generation" (SIGGRAPH 2002).
 *
 * Closed meshes (no boundary — e.g. a sphere, torus, or any
 * genus-g surface without user-marked seams) are handled by
 * pinning two vertices via the geodesic-diameter heuristic
 * (`findDiameterPair`).
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { buildEdgeKey, parseEdgeKey, EPS } from './edge-keys.js';
import { findAllBoundaryLoops } from './island-detection.js';
import { choleskyDecompose, choleskySolve, tryPlaceBoundaryOnSquare } from './tutte.js';

/**
 * Compute the cotangent weight of each edge in the island.
 * Returns a Map from edge key → cotangent weight. For interior
 * edges, the weight is (cot(alpha) + cot(beta)) / 2 where
 * alpha, beta are the angles opposite the edge in the two
 * adjacent triangles. For boundary edges, only one triangle
 * exists, so the weight is cot(alpha) (one half of the
 * interior formula).
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Island} island
 * @returns {Map<number, number>} edge key → cotangent weight
 */
export function computeCotangentWeights(geometry, island) {
  const idx = geometry.index;
  const pos = geometry.attributes.position;
  const weights = new Map();
  const addWeight = (va, vb, w) => {
    const k = buildEdgeKey(va, vb);
    weights.set(k, (weights.get(k) || 0) + w);
  };
  for (const fi of island.faces) {
    const a = idx.array[fi * 3 + 0];
    const b = idx.array[fi * 3 + 1];
    const c = idx.array[fi * 3 + 2];
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const bcx = cx - bx, bcy = cy - by, bcz = cz - bz;
    const cax = ax - cx, cay = ay - cy, caz = az - cz;
    const lab = Math.sqrt(abx*abx + aby*aby + abz*abz);
    const lbc = Math.sqrt(bcx*bcx + bcy*bcy + bcz*bcz);
    const lca = Math.sqrt(cax*cax + cay*cay + caz*caz);
    if (lab < EPS || lbc < EPS || lca < EPS) continue;
    const cosA = (lab*lab + lca*lca - lbc*lbc) / (2 * lab * lca);
    const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const cosB = (lab*lab + lbc*lbc - lca*lca) / (2 * lab * lbc);
    const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));
    const cosC = (lbc*lbc + lca*lca - lab*lab) / (2 * lbc * lca);
    const angleC = Math.acos(Math.max(-1, Math.min(1, cosC)));
    const COT_CLAMP = 100;
    addWeight(b, c, Math.max(-COT_CLAMP, Math.min(COT_CLAMP, 1 / Math.tan(angleA))));
    addWeight(c, a, Math.max(-COT_CLAMP, Math.min(COT_CLAMP, 1 / Math.tan(angleB))));
    addWeight(a, b, Math.max(-COT_CLAMP, Math.min(COT_CLAMP, 1 / Math.tan(angleC))));
  }
  return weights;
}

/**
 * Dijkstra's shortest-path algorithm. Returns a Map from
 * each vertex in `vertices` to its shortest geodesic
 * distance from `source` along the surface (using
 * Euclidean edge lengths as weights). O(V²) using a simple
 * array-based priority queue.
 *
 * @param {Map<number, Array<[number, number]>>} adj
 * @param {Set<number>} vertices
 * @param {number} source
 * @returns {Map<number, number>}
 */
export function dijkstra(adj, vertices, source) {
  const dist = new Map();
  for (const v of vertices) dist.set(v, Infinity);
  dist.set(source, 0);
  const visited = new Set();
  while (visited.size < vertices.size) {
    let u = -1;
    let minDist = Infinity;
    for (const v of vertices) {
      if (visited.has(v)) continue;
      if (dist.get(v) < minDist) {
        minDist = dist.get(v);
        u = v;
      }
    }
    if (u < 0 || minDist === Infinity) break;
    visited.add(u);
    const neighbors = adj.get(u);
    if (!neighbors) continue;
    for (const [v, w] of neighbors) {
      const newDist = dist.get(u) + w;
      if (newDist < dist.get(v)) {
        dist.set(v, newDist);
      }
    }
  }
  return dist;
}

/**
 * Find the two vertices on an island with the longest
 * geodesic (surface) distance apart. Uses the classic
 * double-sweep approximation:
 *
 *   1. Pick any starting vertex v0.
 *   2. Dijkstra from v0 → farthest vertex v1.
 *   3. Dijkstra from v1 → farthest vertex v2.
 *   4. Return [v1, v2].
 *
 * Approximation, not exact diameter — but O(V²) total and
 * within a few percent for triangulated meshes.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Island} island
 * @returns {[number, number] | null}
 */
export function findDiameterPair(geometry, island) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const islandVertices = new Set();
  for (const f of island.faces) {
    for (let k = 0; k < 3; k++) {
      islandVertices.add(idx.array[f * 3 + k]);
    }
  }
  if (islandVertices.size < 2) return null;
  const adj = new Map();
  for (const v of islandVertices) adj.set(v, []);
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      if (!islandVertices.has(va) || !islandVertices.has(vb)) continue;
      const dx = pos.getX(va) - pos.getX(vb);
      const dy = pos.getY(va) - pos.getY(vb);
      const dz = pos.getZ(va) - pos.getZ(vb);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      adj.get(va).push([vb, len]);
      adj.get(vb).push([va, len]);
    }
  }
  const start = idx.array[island.faces[0] * 3 + 0];
  const dist1 = dijkstra(adj, islandVertices, start);
  let v1 = -1;
  let maxDist1 = -Infinity;
  for (const v of islandVertices) {
    const d = dist1.get(v);
    if (d !== undefined && d > maxDist1) {
      maxDist1 = d;
      v1 = v;
    }
  }
  if (v1 < 0) return null;
  const dist2 = dijkstra(adj, islandVertices, v1);
  let v2 = -1;
  let maxDist2 = -Infinity;
  for (const v of islandVertices) {
    const d = dist2.get(v);
    if (d !== undefined && d > maxDist2) {
      maxDist2 = d;
      v2 = v;
    }
  }
  if (v2 < 0) return null;
  return [v1, v2];
}

/**
 * Compute an LSCM (Least-Squares Conformal Mapping) embedding
 * for an island. Returns per-vertex (u, v) coordinates.
 *
 * Closed meshes are handled by pinning two vertices to (0, 0)
 * and (1, 0) and treating them as boundary. The pinned pair
 * is chosen by `findDiameterPair` (geodesic-diameter heuristic).
 *
 * @param {Island} island
 * @param {import('three').BufferGeometry} geometry
 * @returns {{ u: Float64Array, v: Float64Array }}
 */
export function solveLSCM(island, geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const vertexCount = pos.count;

  // Build seam-keys set and boundary loops.
  const seamKeys = new Set();
  const edgeToFaceCount = new Map();
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      seamKeys.add(k);
      edgeToFaceCount.set(k, (edgeToFaceCount.get(k) || 0) + 1);
    }
  }
  for (const [k, count] of edgeToFaceCount) {
    if (count >= 2) seamKeys.delete(k);
  }
  const boundaryLoops = findAllBoundaryLoops(geometry, island, seamKeys);
  const boundarySet = new Set(island.boundary);

  // Closed-mesh handling: pin 2 vertices via geodesic-diameter.
  let pinnedVerts = null;
  if (boundarySet.size === 0) {
    pinnedVerts = findDiameterPair(geometry, island);
    if (pinnedVerts) {
      boundarySet.add(pinnedVerts[0]);
      boundarySet.add(pinnedVerts[1]);
    }
  }

  // Place boundary.
  const bU = new Float64Array(vertexCount);
  const bV = new Float64Array(vertexCount);
  if (pinnedVerts) {
    bU[pinnedVerts[0]] = 0;
    bV[pinnedVerts[0]] = 0;
    bU[pinnedVerts[1]] = 1;
    bV[pinnedVerts[1]] = 0;
  } else {
    let usedSquare = false;
    if (boundaryLoops.length > 0) {
      usedSquare = tryPlaceBoundaryOnSquare(boundaryLoops, pos, bU, bV);
    }
    if (!usedSquare) {
      // Circle fallback.
      let totalBoundaryLen = 0;
      for (const loop of boundaryLoops) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          const dx = pos.getX(a) - pos.getX(b);
          const dy = pos.getY(a) - pos.getY(b);
          const dz = pos.getZ(a) - pos.getZ(b);
          totalBoundaryLen += Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
      }
      const radius = totalBoundaryLen > 0 ? totalBoundaryLen / (2 * Math.PI) : 1;
      let cumulativeArc = 0;
      for (const loop of boundaryLoops) {
        if (loop.length === 0) continue;
        const loopEdges = loop.length;
        const totalEdges = boundaryLoops.reduce((s, l) => s + l.length, 0);
        const arcLen = totalEdges > 0 ? (loopEdges / totalEdges) * 2 * Math.PI : 0;
        for (let i = 0; i < loop.length; i++) {
          const v = loop[i];
          const t = cumulativeArc + (i / loop.length) * arcLen;
          bU[v] = radius * Math.cos(t);
          bV[v] = radius * Math.sin(t);
        }
        cumulativeArc += arcLen;
      }
    }
  }

  const interior = [];
  for (let v = 0; v < vertexCount; v++) {
    if (!boundarySet.has(v)) interior.push(v);
  }
  if (interior.length === 0) {
    return { u: bU, v: bV };
  }

  // Compute cotangent weights.
  const weights = computeCotangentWeights(geometry, island);

  // Build per-vertex neighbor → weight map.
  const neighborWeights = Array.from({ length: vertexCount }, () => new Map());
  for (const [k, w] of weights) {
    const [va, vb] = parseEdgeKey(k);
    neighborWeights[va].set(vb, (neighborWeights[va].get(vb) || 0) + w);
    neighborWeights[vb].set(va, (neighborWeights[vb].get(va) || 0) + w);
  }

  // Set up the linear system.
  const n = interior.length;
  const interiorIndex = new Map();
  for (let i = 0; i < n; i++) interiorIndex.set(interior[i], i);
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const rhsU = new Float64Array(n);
  const rhsV = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = interior[i];
    const nbs = neighborWeights[v];
    let diagSum = 0;
    for (const [nb, w] of nbs) {
      if (boundarySet.has(nb)) {
        rhsU[i] += w * bU[nb];
        rhsV[i] += w * bV[nb];
      } else {
        const j = interiorIndex.get(nb);
        A[i][j] -= w;
      }
      diagSum += w;
    }
    A[i][i] = diagSum;
  }

  const chol = choleskyDecompose(A);
  const xU = choleskySolve(chol, rhsU);
  const xV = choleskySolve(chol, rhsV);
  for (let i = 0; i < n; i++) {
    bU[interior[i]] = xU[i];
    bV[interior[i]] = xV[i];
  }
  return { u: bU, v: bV };
}
