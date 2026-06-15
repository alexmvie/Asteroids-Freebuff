/**
 * Tutte embedding solver.
 *
 * The Tutte embedding is a flat parameterization where the
 * boundary is placed on a fixed shape (square for 1- and 2-loop
 * boundaries, circle for 3+) and interior vertices are solved
 * as the Laplacian average of their neighbors. Same algorithm
 * used by Blender's "Unwrap" (basic) and Maya's "Planar"
 * projection. Not as conformal as LSCM, but simple, robust, fast
 * (one Cholesky solve per island), and gives a usable layout.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { buildEdgeKey } from './edge-keys.js';
import { findAllBoundaryLoops } from './island-detection.js';
import { EPS } from './edge-keys.js';

// =============================================================================
// Square-domain boundary placement
// =============================================================================
//
// The legacy Tutte-on-a-circle placement put every boundary vertex
// on a single unit circle. For multi-loop boundaries (the "theta"
// case — a cylinder body with both ends open and one longitudinal
// cut), this is the wrong shape: the cylinder's natural unwrap is a
// RECTANGLE, and projecting it onto a circle forces a sharp fold.
//
// The square-domain placement fixes this: it places each boundary
// cycle on a portion of the unit square's perimeter, so the
// resulting Tutte solve flattens the cylinder body into a
// recognizable rectangle.
//
// Three cases:
//   1. ONE loop  → full unit-square perimeter
//   2. TWO loops → top and bottom edges of the square (the theta case)
//   3. 3+ loops  → fall back to the circle placement (caller's job)
//
// Returns true if the placement was applied, false if the caller
// should fall back to the circle placement.

/**
 * Place one boundary loop on the full perimeter of the unit
 * square. t = 0 at (0, 0), t = 0.25 at (1, 0), t = 0.5 at
 * (1, 1), t = 0.75 at (0, 1), t = 1 back at (0, 0).
 */
function placeOneLoopOnSquare(loop, bU, bV) {
  const N = loop.length;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    let u, v;
    if (t < 0.25) { u = t * 4; v = 0; }
    else if (t < 0.5) { u = 1; v = (t - 0.25) * 4; }
    else if (t < 0.75) { u = 1 - (t - 0.5) * 4; v = 1; }
    else { u = 0; v = 1 - (t - 0.75) * 4; }
    bU[loop[i]] = u;
    bV[loop[i]] = v;
  }
}

/**
 * Place two boundary loops on the top and bottom edges of the
 * unit square. The shared vertex (in both loops) sits at
 * (0, top) on the left edge; the other endpoints sit at
 * (1, top) and (1, bottom) on the right edge.
 */
function placeTwoLoopsOnSquare(loops, pos, bU, bV) {
  // Sort loops by average 3D y-coordinate: the "top" loop
  // has the higher average y.
  const avgY = loops.map((loop) => {
    let sum = 0;
    for (const v of loop) sum += pos.getY(v);
    return sum / loop.length;
  });
  const order = avgY[0] > avgY[1] ? [0, 1] : [1, 0];
  const topLoop = loops[order[0]];
  const bottomLoop = loops[order[1]];

  // Find the shared vertex (the single vertex in both loops).
  const bottomSet = new Set(bottomLoop);
  let sharedVert = -1;
  for (const v of topLoop) {
    if (bottomSet.has(v)) { sharedVert = v; break; }
  }
  if (sharedVert < 0) return false;

  // Place the top loop on the top edge (y = 1).
  const topStartIdx = topLoop.indexOf(sharedVert);
  const topOrdered = topStartIdx > 0
    ? [...topLoop.slice(topStartIdx), ...topLoop.slice(0, topStartIdx)]
    : topLoop;
  for (let i = 0; i < topOrdered.length; i++) {
    const t = i / Math.max(1, topOrdered.length - 1);
    bU[topOrdered[i]] = t;
    bV[topOrdered[i]] = 1;
  }

  // Place the bottom loop on the bottom edge (y = 0), skipping
  // the shared vertex.
  const bottomStartIdx = bottomLoop.indexOf(sharedVert);
  const bottomFiltered = bottomLoop.filter((v) => v !== sharedVert);
  if (bottomFiltered.length === 0) return true;
  const bottomFirst = bottomFiltered[0];
  const firstIdx = bottomFiltered.indexOf(bottomFirst);
  const bottomOrdered = firstIdx > 0
    ? [...bottomFiltered.slice(firstIdx), ...bottomFiltered.slice(0, firstIdx)]
    : bottomFiltered;
  const lastIdx = bottomOrdered.length - 1;
  const useCount = (lastIdx > 0 && bottomOrdered[0] === bottomOrdered[lastIdx])
    ? lastIdx
    : bottomOrdered.length;
  for (let i = 0; i < useCount; i++) {
    const t = i / Math.max(1, useCount - 1);
    bU[bottomOrdered[i]] = t;
    bV[bottomOrdered[i]] = 0;
  }
  return true;
}

/**
 * Try to place the boundary vertices on the unit square.
 * Returns true on success, false if the topology is unsupported
 * (3+ loops) and the caller should fall back to the circle.
 */
export function tryPlaceBoundaryOnSquare(boundaryLoops, pos, bU, bV) {
  if (boundaryLoops.length === 1) {
    placeOneLoopOnSquare(boundaryLoops[0], bU, bV);
    return true;
  }
  if (boundaryLoops.length === 2) {
    return placeTwoLoopsOnSquare(boundaryLoops, pos, bU, bV);
  }
  return false; // 3+ loops: fall back to circle
}

// =============================================================================
// Cholesky decomposition (shared with LSCM)
// =============================================================================

/**
 * Cholesky decomposition of a symmetric positive-definite matrix
 * A. Returns the lower triangular L such that A = L * L^T.
 */
export function choleskyDecompose(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) {
          // Not positive definite — fall back to a tiny diagonal
          // to avoid NaN. The resulting solve will be approximate.
          sum = EPS;
        }
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/**
 * Solve L * L^T * x = b given a Cholesky factor L.
 */
export function choleskySolve(L, b) {
  const n = L.length;
  // Forward: L * y = b
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  // Backward: L^T * x = y
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

// =============================================================================
// Tutte embedding
// =============================================================================

/**
 * Compute a Tutte embedding for an island. Returns per-vertex
 * (u, v) coordinates. Boundary vertices are placed on a unit
 * square (for 1- or 2-loop boundaries) or unit circle (fallback
 * for 3+ loops). Interior vertices are solved as the Laplacian
 * average of their neighbors.
 *
 * @param {Island} island
 * @param {import('three').BufferGeometry} geometry
 * @returns {{ u: Float64Array, v: Float64Array }} length = vertexCount
 */
export function computeTutteEmbedding(island, geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const vertexCount = pos.count;

  // Build the 1-ring adjacency.
  const neighbors = Array.from({ length: vertexCount }, () => []);
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      if (!neighbors[va].includes(vb)) neighbors[va].push(vb);
      if (!neighbors[vb].includes(va)) neighbors[vb].push(va);
    }
  }

  // Find all boundary cycles.
  const seamKeys = new Set();
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      seamKeys.add(k);
    }
  }
  const edgeToFaceCount = new Map();
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      edgeToFaceCount.set(k, (edgeToFaceCount.get(k) || 0) + 1);
    }
  }
  for (const [k, count] of edgeToFaceCount) {
    if (count >= 2) seamKeys.delete(k);
  }
  const boundaryLoops = findAllBoundaryLoops(geometry, island, seamKeys);
  const boundarySet = new Set(island.boundary);

  // Compute the radius for the circle-fallback placement.
  let totalBoundaryLen = 0;
  for (const loop of boundaryLoops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
      const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
      const dx = ax - bx, dy = ay - by, dz = az - bz;
      totalBoundaryLen += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  const totalEdges = boundaryLoops.reduce((s, l) => s + l.length, 0);
  const radius = totalBoundaryLen > 0 ? totalBoundaryLen / (2 * Math.PI) : 1;

  // Place boundary vertices. Prefer square-domain (1-2 loops);
  // fall back to circle (3+ loops).
  const bU = new Float64Array(vertexCount);
  const bV = new Float64Array(vertexCount);
  let usedSquare = false;
  if (boundaryLoops.length > 0) {
    usedSquare = tryPlaceBoundaryOnSquare(boundaryLoops, pos, bU, bV);
  }
  if (!usedSquare) {
    // Circle fallback: each loop on a contiguous arc of the unit circle.
    let cumulativeArc = 0;
    for (const loop of boundaryLoops) {
      if (loop.length === 0) continue;
      const loopEdges = loop.length;
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

  // Identify interior vertices.
  const interior = [];
  for (let v = 0; v < vertexCount; v++) {
    if (!boundarySet.has(v)) interior.push(v);
  }

  if (interior.length === 0) {
    return { u: bU, v: bV };
  }

  // Build the Laplacian system.
  const n = interior.length;
  const interiorIndex = new Map();
  for (let i = 0; i < n; i++) interiorIndex.set(interior[i], i);

  const A = Array.from({ length: n }, () => new Float64Array(n));
  const rhsU = new Float64Array(n);
  const rhsV = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const v = interior[i];
    const nbs = neighbors[v];
    A[i][i] = nbs.length;
    for (const nb of nbs) {
      if (boundarySet.has(nb)) {
        rhsU[i] -= bU[nb];
        rhsV[i] -= bV[nb];
      } else {
        const j = interiorIndex.get(nb);
        A[i][j] -= 1;
      }
    }
  }

  const cholesky = choleskyDecompose(A);
  const xU = choleskySolve(cholesky, rhsU);
  const xV = choleskySolve(cholesky, rhsV);

  for (let i = 0; i < n; i++) {
    bU[interior[i]] = xU[i];
    bV[interior[i]] = xV[i];
  }

  return { u: bU, v: bV };
}
