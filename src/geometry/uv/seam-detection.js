/**
 * Auto-seam detection (dihedral-angle based) + autoUnwrap.
 *
 * Detects seam edges by dihedral angle: if the angle between
 * two adjacent face normals exceeds a threshold (default 30°),
 * the edge is a candidate seam. Same algorithm Blender's
 * "Mark Seam" tool uses under the hood.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { buildEdgeKey } from './edge-keys.js';
import { reunwrap } from './reunwrap.js';

/**
 * Compute the dihedral angle (in degrees) for every interior
 * edge of the mesh. Boundary edges (edges with only 1 adjacent
 * face) are skipped (no dihedral defined). The returned map
 * lets callers rank seams by sharpness and pick the N strongest
 * without re-walking the mesh.
 *
 * @param {import('three').BufferGeometry} geometry
 * @returns {Map<number, number>} edge key → dihedral in degrees
 *   (only includes edges with 2 adjacent faces)
 */
export function computeAllDihedrals(geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  if (!pos) throw new Error('computeAllDihedrals: geometry must have a position attribute');
  if (!idx) throw new Error('computeAllDihedrals: geometry must be indexed');
  const faceCount = Math.floor(idx.count / 3);
  // 1. Compute face normals.
  const normals = new Float32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const ia = idx.array[f * 3 + 0];
    const ib = idx.array[f * 3 + 1];
    const ic = idx.array[f * 3 + 2];
    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
    const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    normals[f * 3 + 0] = nx;
    normals[f * 3 + 1] = ny;
    normals[f * 3 + 2] = nz;
  }
  // 2. Map each edge → list of face indices.
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
      const k = buildEdgeKey(va, vb);
      let list = edgeToFaces.get(k);
      if (!list) { list = []; edgeToFaces.set(k, list); }
      list.push(f);
    }
  }
  // 3. For each interior edge, compute dihedral in degrees.
  const out = new Map();
  for (const [k, faces] of edgeToFaces) {
    if (faces.length !== 2) continue;
    const f1 = faces[0], f2 = faces[1];
    const dot = normals[f1 * 3] * normals[f2 * 3]
              + normals[f1 * 3 + 1] * normals[f2 * 3 + 1]
              + normals[f1 * 3 + 2] * normals[f2 * 3 + 2];
    // Clamp to [-1, 1] for acos safety (floating-point can drift).
    const clamped = Math.max(-1, Math.min(1, dot));
    const deg = Math.acos(clamped) * 180 / Math.PI;
    out.set(k, deg);
  }
  return out;
}

/**
 * Auto-detect seam edges by dihedral angle. For each edge shared
 * by exactly 2 faces, compute the angle between the two face
 * normals. If the angle exceeds `thresholdDeg`, the edge is
 * marked as a seam.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {number} thresholdDeg  dihedral threshold in degrees (default 30°).
 * @returns {Set<number>} vertex-edge keys (use buildEdgeKey)
 */
export function autoDetectSeams(geometry, thresholdDeg = 30) {
  const dihedrals = computeAllDihedrals(geometry);
  const seams = new Set();
  for (const [k, deg] of dihedrals) {
    if (deg >= thresholdDeg) seams.add(k);
  }
  return seams;
}

/**
 * One-shot: auto-detect seams + re-unwrap. Returns the new
 * per-vertex UV arrays. Convenience wrapper around
 * `autoDetectSeams` + `reunwrap`.
 */
export function autoUnwrap(geometry, thresholdDeg = 30) {
  const seamKeys = autoDetectSeams(geometry, thresholdDeg);
  return reunwrap(geometry, seamKeys, { pack: true });
}
