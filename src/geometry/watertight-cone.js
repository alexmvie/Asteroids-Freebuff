import * as THREE from 'three';

// ---------------------------------------------------------------------------
// v0.72.3 — Watertight cone / pyramid geometry.
//
// THREE's `ConeGeometry(radius, height, segments, heightSegments)` is NOT
// strictly watertight: with `radiusTop = 0` it writes `radialSegments`
// SEPARATE vertex copies at the tip (one per side face, so per-face UVs
// and flat shading work) plus a cap-center copy — five-ish coincident
// vertices at the same world point. A strict edge analyzer sees the tip
// as `radialSegments` open boundary edges, and the cap fan triangles are
// degenerate (two corners coincide). Visually this never shows (the
// copies are exactly coincident), but it violates a hard "every mesh in
// the game is watertight" contract, breaks boolean/CSG/watertightness
// tooling, and muddies the unit-test signal.
//
// This builder emits a strictly watertight indexed cone: ONE tip vertex,
// ONE base-center vertex, and ONE rim ring shared by the side faces AND
// the base cap. Every edge is shared by exactly two triangles, no
// degenerate triangles, no NaN. Tip at +Y (matching THREE.ConeGeometry
// so existing `.rotateX(...)` calls keep working), base cap facing -Y.
//
// Usage in the game:
//   - src/entities/ship.js  — 4-sided pyramid body (was ConeGeometry 4)
//     and 8-sided engine-glow cone (was ConeGeometry 8)
//   - src/entities/powerup.js — `cone` shape default fallback
// ---------------------------------------------------------------------------

/**
 * Build a strictly watertight cone (closed, with base cap).
 *
 * Layout: vertex 0 = tip (+Y), vertex 1 = base center (-Y), vertices
 * 2..2+segments-1 = rim ring at y = -height/2, CCW around +Y.
 *
 *   - Side faces: (tip, rim[i+1], rim[i]) — outward winding
 *     (normal has +radial component; verified by cross product).
 *   - Base cap:   (center, rim[i+1], rim[i]) — downward winding
 *     (normal = -Y; the cap faces down, matching THREE.ConeGeometry's
 *     closed bottom).
 *
 * @param {number} radius          base radius
 * @param {number} height          total height along Y
 * @param {number} radialSegments  side faces / rim vertices (>= 3)
 * @returns {import('three').BufferGeometry}
 */
export function buildWatertightCone(radius, height, radialSegments) {
  if (radialSegments < 3) throw new Error('buildWatertightCone: radialSegments must be >= 3');
  const verts = new Float32Array((radialSegments + 2) * 3);
  verts[0] = 0;
  verts[1] = height / 2;
  verts[2] = 0;
  verts[3] = 0;
  verts[4] = -height / 2;
  verts[5] = 0;
  for (let i = 0; i < radialSegments; i++) {
    const a = (i / radialSegments) * Math.PI * 2;
    const o = (i + 2) * 3;
    verts[o] = Math.cos(a) * radius;
    verts[o + 1] = -height / 2;
    verts[o + 2] = Math.sin(a) * radius;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));

  const idx = [];
  for (let i = 0; i < radialSegments; i++) {
    const next = (i + 1) % radialSegments;
    const rim = 2 + i;
    const rimNext = 2 + next;
    // Side: (tip, rimNext, rim) — outward (normal has a +radial
    // component; verified by cross product).
    idx.push(0, rimNext, rim);
    // Base: (center, rim, rimNext) — faces -Y (away from the tip,
    // matching THREE.ConeGeometry's closed bottom so the pyramid's
    // back plate reads from behind).
    idx.push(1, rim, rimNext);
  }
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}
