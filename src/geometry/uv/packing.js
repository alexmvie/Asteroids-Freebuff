/**
 * Island-grid packer.
 *
 * Places per-island UV coordinates into a regular grid of
 * cells, scaled to fit. Aspect-preserving (each island keeps
 * its shape). Used by `reunwrap` to pack everything into
 * the unit square [0, 1] x [0, 1].
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { EPS } from './edge-keys.js';

/**
 * Pack per-island UV coordinates into a grid that fills the
 * unit square. Writes into `outU` / `outV` in place.
 *
 * The packing is a simple grid packer: islands are sorted by
 * area (largest first), placed into a square grid, and each
 * island is centered inside its cell with the given margin.
 *
 * @param {Array<{
 *   island: Island,
 *   u: Float64Array, v: Float64Array,
 *   minU: number, maxU: number, minV: number, maxV: number,
 *   width: number, height: number,
 * }>} islandData
 * @param {Float64Array} outU
 * @param {Float64Array} outV
 * @param {number} margin
 * @param {import('three').BufferGeometry} geometry
 */
export function packIslandsIntoGrid(islandData, outU, outV, margin, geometry) {
  outU.fill(0);
  outV.fill(0);
  const idx = geometry.index;
  const n = islandData.length;
  if (n === 0) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  for (let i = 0; i < islandData.length; i++) {
    const d = islandData[i];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const innerU = c * cellW + margin * cellW;
    const innerV = r * cellH + margin * cellH;
    const innerW = cellW * (1 - 2 * margin);
    const innerH = cellH * (1 - 2 * margin);
    const aspectSrc = d.width / Math.max(d.height, EPS);
    const aspectDst = innerW / innerH;
    let fitU, fitV;
    if (aspectSrc > aspectDst) {
      fitU = innerW;
      fitV = d.height * (innerW / Math.max(d.width, EPS));
    } else {
      fitV = innerH;
      fitU = d.width * (innerH / Math.max(d.height, EPS));
    }
    const offsetU = innerU + (innerW - fitU) / 2;
    const offsetV = innerV + (innerH - fitV) / 2;
    const seen = new Set();
    const scaleU = fitU / Math.max(d.width, EPS);
    const scaleV = fitV / Math.max(d.height, EPS);
    for (const f of d.island.faces) {
      const a = idx.array[f * 3 + 0];
      const b = idx.array[f * 3 + 1];
      const cIdx = idx.array[f * 3 + 2];
      for (const v of [a, b, cIdx]) {
        if (seen.has(v)) continue;
        seen.add(v);
        outU[v] = (d.u[v] - d.minU) * scaleU + offsetU;
        outV[v] = (d.v[v] - d.minV) * scaleV + offsetV;
      }
    }
  }
}
