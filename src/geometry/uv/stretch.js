/**
 * Per-face stretch metric + heatmap colormap.
 *
 * Stretch is the ratio of 3D area to UV area, symmetrized so
 * "0 = uniform" and "> 0 = stretched" — the same convention
 * Blender's UV editor uses for the stretch display.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { EPS } from './edge-keys.js';

/**
 * Compute a per-face stretch metric: 0 means uniform, > 0 means
 * stretched. Uses the ratio of 3D area to UV area, symmetrized:
 *
 *   s = max(area3D / areaUV, areaUV / area3D) - 1
 *
 *   s = 0  →  area3D == areaUV (uniform)
 *   s = 1  →  one is double the other (2x stretch)
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {{ u: Float64Array, v: Float64Array }} uvs
 * @returns {Float32Array} per-face stretch
 */
export function computeStretch(geometry, uvs) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  if (!idx) {
    throw new Error('computeStretch: geometry must be indexed');
  }
  const faceCount = Math.floor(idx.count / 3);
  const stretch = new Float32Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const ia = idx.array[f * 3 + 0];
    const ib = idx.array[f * 3 + 1];
    const ic = idx.array[f * 3 + 2];
    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
    const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const area3D = 0.5 * Math.sqrt(nx*nx + ny*ny + nz*nz);
    const au = uvs.u[ia], av = uvs.v[ia];
    const bu = uvs.u[ib], bv = uvs.v[ib];
    const cu = uvs.u[ic], cv = uvs.v[ic];
    const f1x = bu - au, f1y = bv - av;
    const f2x = cu - au, f2y = cv - av;
    const areaUV = 0.5 * Math.abs(f1x * f2y - f1y * f2x);
    const ratio = areaUV > EPS ? area3D / areaUV : 1;
    const s = Math.max(ratio, 1 / Math.max(ratio, EPS)) - 1;
    stretch[f] = isFinite(s) ? s : 0;
  }
  return stretch;
}

/**
 * Map a stretch value to a color. 0 = green, 0.5 = yellow,
 * 1+ = red. Matches the conventional "heat" colormap.
 */
export function stretchToColor(s) {
  const t = Math.max(0, Math.min(1, s));
  if (t < 0.5) {
    const u = t / 0.5;
    return [
      Math.round(0 + 200 * u),
      Math.round(200),
      Math.round(0),
    ];
  } else {
    const u = (t - 0.5) / 0.5;
    return [
      Math.round(200 + 20 * u),
      Math.round(200 - 170 * u),
      Math.round(0),
    ];
  }
}
