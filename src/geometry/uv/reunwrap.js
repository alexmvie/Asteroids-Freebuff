/**
 * Re-unwrap orchestrator.
 *
 * Given a set of marked seam edges, splits the mesh into
 * islands, solves each island (via Tutte / LSCM / ABF++),
 * and packs the result into the unit square.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { detectIslands } from './island-detection.js';
import { computeTutteEmbedding } from './tutte.js';
import { solveLSCM } from './lscm.js';
import { solveABFPlusPlus } from './abfpp.js';
import { packIslandsIntoGrid } from './packing.js';
import { EPS } from './edge-keys.js';

/**
 * Re-unwrap a mesh given the set of marked seam edges. Returns
 * the new per-vertex UV arrays. Caller applies them to the
 * geometry.
 *
 * Algorithm:
 *   1. Detect islands.
 *   2. For each island, compute a per-island embedding (Tutte,
 *      LSCM, or ABF++).
 *   3. Pack the islands into the unit square.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {Set<number>} seamKeys
 * @param {{ pack?: boolean, margin?: number, solver?: 'tutte'|'lscm'|'abf++' }} [opts]
 * @returns {{ u: Float64Array, v: Float64Array, islands: Island[] }}
 */
export function reunwrap(geometry, seamKeys, opts = {}) {
  const islands = detectIslands(geometry, seamKeys);
  const vertexCount = geometry.attributes.position.count;
  const outU = new Float64Array(vertexCount);
  const outV = new Float64Array(vertexCount);
  const solver = opts.solver === 'lscm' ? 'lscm'
    : opts.solver === 'abf++' ? 'abf++'
    : 'tutte';
  let solveIsland;
  if (solver === 'lscm') solveIsland = solveLSCM;
  else if (solver === 'abf++') solveIsland = solveABFPlusPlus;
  else solveIsland = computeTutteEmbedding;

  // If packing is disabled, place each island in its own row.
  if (opts.pack === false) {
    const targetW = 0.45;
    const targetH = 0.45;
    let offsetU = 0, offsetV = 0;
    for (const island of islands) {
      const { u, v } = solveIsland(island, geometry);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let vi = 0; vi < u.length; vi++) {
        if (!isFinite(u[vi]) || !isFinite(v[vi])) continue;
        if (u[vi] < minU) minU = u[vi];
        if (u[vi] > maxU) maxU = u[vi];
        if (v[vi] < minV) minV = v[vi];
        if (v[vi] > maxV) maxV = v[vi];
      }
      const width = (maxU - minU) || 1;
      const height = (maxV - minV) || 1;
      const scale = Math.min(targetW / width, targetH / height);
      const seen = new Set();
      const idx = geometry.index;
      for (const f of island.faces) {
        const a = idx.array[f * 3 + 0];
        const b = idx.array[f * 3 + 1];
        const c = idx.array[f * 3 + 2];
        for (const vi of [a, b, c]) {
          if (seen.has(vi)) continue;
          seen.add(vi);
          outU[vi] = (u[vi] - minU) * scale + offsetU;
          outV[vi] = (v[vi] - minV) * scale + offsetV;
        }
      }
      offsetU += targetW + 0.05;
      if (offsetU > 0.9) {
        offsetU = 0;
        offsetV += targetH + 0.05;
      }
    }
    return { u: outU, v: outV, islands };
  }

  // Default: pack into the unit square.
  const margin = opts.margin != null ? opts.margin : 0.04;
  const islandData = islands.map((island) => {
    const { u, v } = solveIsland(island, geometry);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let vi = 0; vi < u.length; vi++) {
      if (!isFinite(u[vi]) || !isFinite(v[vi])) continue;
      if (u[vi] < minU) minU = u[vi];
      if (u[vi] > maxU) maxU = u[vi];
      if (v[vi] < minV) minV = v[vi];
      if (v[vi] > maxV) maxV = v[vi];
    }
    return {
      island, u, v,
      minU, maxU, minV, maxV,
      width: (maxU - minU) || EPS,
      height: (maxV - minV) || EPS,
    };
  });
  islandData.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  packIslandsIntoGrid(islandData, outU, outV, margin, geometry);
  return { u: outU, v: outV, islands };
}
