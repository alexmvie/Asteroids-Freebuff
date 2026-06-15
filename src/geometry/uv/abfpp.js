/**
 * ABF++ (Angle-Based Flattening) solver.
 *
 * ABF++ minimizes angle distortion: for each triangle, the 2D
 * angles should match the 3D angles (preserving the local
 * shape of the triangle, not just its conformal class). The
 * energy is
 *
 *   E = sum over triangles T of sum over angles alpha in T of
 *       (alpha_2D - alpha_3D)^2 / alpha_3D
 *
 * The / alpha_3D normalizes by the target angle, so small
 * angles (close to 0) dominate the energy. These are the
 * hardest to preserve and the most visually noticeable when
 * distorted.
 *
 * This is a SIMPLIFIED version of the full ABF++ algorithm
 * (Sheffer, Lévy, Mōri, Surazhsky 2005). The full algorithm
 * uses L-BFGS with analytical gradients and explicit cone
 * handling. This implementation uses plain gradient descent
 * with a NUMERICAL gradient (central differences), which is
 * O(N*F) per iteration instead of O(N+F). Slower but correct
 * and much simpler. Sufficient for typical asteroid meshes
 * (50-200 vertices, 100-400 faces per island) — 20 iterations
 * take < 100ms on a desktop browser.
 *
 * Reference: Sheffer & de Sturler, "Parameterization of
 * Faceted Surfaces for Meshing using Angle-Based Flattening"
 * (Engineering with Computers 2001) — the original ABF.
 * Sheffer, Lévy, Mōri, Surazhsky, "ABF++: Fast and Robust
 * Angle Based Flattening" (ACM TOG 2005) — the ABF++ extensions.
 *
 * @fileoverview Previously part of `src/geometry/uv-unwrapping.js`.
 */

import { EPS } from './edge-keys.js';
import { solveLSCM, findDiameterPair } from './lscm.js';

/**
 * Compute the 3D angles for each face in the island.
 * Returns a Map<faceIndex, [alpha_a, alpha_b, alpha_c]>
 * where alpha_a is the angle at vertex a, etc.
 */
export function compute3DAngles(geometry, island) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const angles = new Map();
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    const lab = distance3D(pos, a, b);
    const lbc = distance3D(pos, b, c);
    const lca = distance3D(pos, c, a);
    if (lab < EPS || lbc < EPS || lca < EPS) {
      angles.set(f, [Math.PI / 3, Math.PI / 3, Math.PI / 3]);
      continue;
    }
    const cosA = (lab*lab + lca*lca - lbc*lbc) / (2 * lab * lca);
    const cosB = (lab*lab + lbc*lbc - lca*lca) / (2 * lab * lbc);
    const cosC = (lbc*lbc + lca*lca - lab*lab) / (2 * lbc * lca);
    angles.set(f, [
      Math.acos(Math.max(-1, Math.min(1, cosA))),
      Math.acos(Math.max(-1, Math.min(1, cosB))),
      Math.acos(Math.max(-1, Math.min(1, cosC))),
    ]);
  }
  return angles;
}

function distance3D(pos, i, j) {
  const dx = pos.getX(i) - pos.getX(j);
  const dy = pos.getY(i) - pos.getY(j);
  const dz = pos.getZ(i) - pos.getZ(j);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

/**
 * Compute the angle distortion energy.
 * E = sum over triangles T of sum over angles alpha in T of
 *     (alpha_2D - alpha_3D)^2 / max(alpha_3D, 1e-6)
 */
export function computeAngleEnergy(geometry, island, u, v, targetAngles) {
  const idx = geometry.index;
  let energy = 0;
  for (const f of island.faces) {
    const a = idx.array[f * 3 + 0];
    const b = idx.array[f * 3 + 1];
    const c = idx.array[f * 3 + 2];
    const lab = Math.hypot(u[b] - u[a], v[b] - v[a]);
    const lbc = Math.hypot(u[c] - u[b], v[c] - v[b]);
    const lca = Math.hypot(u[a] - u[c], v[a] - v[c]);
    if (lab < EPS || lbc < EPS || lca < EPS) continue;
    const cosA = (lab*lab + lca*lca - lbc*lbc) / (2 * lab * lca);
    const cosB = (lab*lab + lbc*lbc - lca*lca) / (2 * lab * lbc);
    const cosC = (lbc*lbc + lca*lca - lab*lab) / (2 * lbc * lca);
    const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));
    const angleC = Math.acos(Math.max(-1, Math.min(1, cosC)));
    const target = targetAngles.get(f);
    if (!target) continue;
    energy += Math.pow(angleA - target[0], 2) / Math.max(target[0], 1e-6);
    energy += Math.pow(angleB - target[1], 2) / Math.max(target[1], 1e-6);
    energy += Math.pow(angleC - target[2], 2) / Math.max(target[2], 1e-6);
  }
  return energy;
}

/**
 * Compute an ABF++ (Angle-Based Flattening) embedding for
 * an island. Returns per-vertex (u, v) coordinates.
 *
 * @param {Island} island
 * @param {import('three').BufferGeometry} geometry
 * @param {{ maxIterations?: number, learningRate?: number, tol?: number }} [opts]
 * @returns {{ u: Float64Array, v: Float64Array }}
 */
export function solveABFPlusPlus(island, geometry, opts = {}) {
  const maxIterations = opts.maxIterations != null ? opts.maxIterations : 20;
  const learningRate = opts.learningRate != null ? opts.learningRate : 0.05;
  const tol = opts.tol != null ? opts.tol : 1e-6;
  // Initialize with LSCM.
  const lscm = solveLSCM(island, geometry);
  const u = new Float64Array(lscm.u);
  const v = new Float64Array(lscm.v);
  // Precompute target 3D angles.
  const targetAngles = compute3DAngles(geometry, island);
  // Identify boundary (pinned) vertices.
  const boundarySet = new Set(island.boundary);
  if (boundarySet.size === 0) {
    const pinnedVerts = findDiameterPair(geometry, island);
    if (pinnedVerts) {
      boundarySet.add(pinnedVerts[0]);
      boundarySet.add(pinnedVerts[1]);
    }
  }
  // Gradient descent with numerical gradient.
  const eps = 1e-6;
  let prevEnergy = Infinity;
  for (let iter = 0; iter < maxIterations; iter++) {
    const energy = computeAngleEnergy(geometry, island, u, v, targetAngles);
    if (iter > 0 && Math.abs(prevEnergy - energy) < tol * Math.max(1, energy)) {
      break;
    }
    prevEnergy = energy;
    const gradU = new Float64Array(u.length);
    const gradV = new Float64Array(v.length);
    for (let i = 0; i < u.length; i++) {
      if (boundarySet.has(i)) continue;
      const u0 = u[i];
      u[i] = u0 + eps;
      const ePlusU = computeAngleEnergy(geometry, island, u, v, targetAngles);
      u[i] = u0 - eps;
      const eMinusU = computeAngleEnergy(geometry, island, u, v, targetAngles);
      u[i] = u0;
      gradU[i] = (ePlusU - eMinusU) / (2 * eps);
      const v0 = v[i];
      v[i] = v0 + eps;
      const ePlusV = computeAngleEnergy(geometry, island, u, v, targetAngles);
      v[i] = v0 - eps;
      const eMinusV = computeAngleEnergy(geometry, island, u, v, targetAngles);
      v[i] = v0;
      gradV[i] = (ePlusV - eMinusV) / (2 * eps);
    }
    for (let i = 0; i < u.length; i++) {
      if (boundarySet.has(i)) continue;
      u[i] -= learningRate * gradU[i];
      v[i] -= learningRate * gradV[i];
    }
  }
  return { u, v };
}
