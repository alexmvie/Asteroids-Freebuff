/**
 * Pure 2D geometry math helpers for the UV editor.
 *
 * @fileoverview Previously inlined in `src/systems/uv-unwrap-viewer.js`
 * (the 106K char god-function). Extracted to its own file so the
 * orchestrator can shrink and these helpers can be unit-tested
 * independently (no DOM, no Three.js, no closure dependency).
 *
 * All functions are PURE — no state, no side effects.
 */

/**
 * Squared distance from point (px, py) to the closest point on
 * the segment (a, b). Returns a non-negative squared distance.
 * Used by the 2D pick to find the nearest edge under the cursor.
 *
 * @param {number} px
 * @param {number} py
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number} squared distance
 */
export function pointToSegmentDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) {
    const ex = px - a.x, ey = py - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Squared distance from point (px, py) to the closest point in
 * the triangle (a, b, c). The triangle may be degenerate
 * (zero-area) — in that case, returns the closest edge distance.
 *
 * @param {number} px
 * @param {number} py
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} c
 * @returns {number} squared distance
 */
export function pointToTriangleDist(px, py, a, b, c) {
  const d1 = pointToSegmentDist(px, py, a, b);
  const d2 = pointToSegmentDist(px, py, b, c);
  const d3 = pointToSegmentDist(px, py, c, a);
  return Math.min(d1, d2, d3);
}

/**
 * 2D orientation test. Returns the sign of the cross product
 * (b - a) × (c - a) in 2D. Positive = c is left of ab,
 * negative = c is right of ab, zero = collinear.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @param {[number, number]} c
 * @returns {number}
 */
export function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * 2D segment-crossing test. Returns true if (p1, p2) properly
 * crosses (p3, p4) — each endpoint lies on a different side of
 * the other segment. Endpoints that exactly land on the other
 * segment are NOT counted as crossing (they would otherwise
 * inflate the seam set on every slice near a shared vertex).
 *
 * @param {[number, number]} p1
 * @param {[number, number]} p2
 * @param {[number, number]} p3
 * @param {[number, number]} p4
 * @returns {boolean}
 */
export function segmentsCross(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * HSV → RGB color conversion. Returns [r, g, b] in [0, 1].
 * Used by the per-island color generator.
 *
 * @param {number} h hue in [0, 1)
 * @param {number} s saturation in [0, 1]
 * @param {number} v value in [0, 1]
 * @returns {[number, number, number]}
 */
export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    case 5: return [v, p, q];
    default: return [0, 0, 0];
  }
}

/**
 * Compute the "pack efficiency" of a layout: the sum of each
 * island's bounding-box UV area, divided by 1.0 (the unit
 * square). Clamped to [0, 1]. This is an upper bound on the
 * true efficiency (the boxes can overlap; the packer minimizes
 * overlap via grid layout) but it's a useful "how much of the
 * UV space am I using" metric for the stats line.
 *
 * @param {object} layout
 * @returns {number} in [0, 1]
 */
export function computePackEfficiency(layout) {
  if (!layout || !layout.islands || layout.islands.length === 0) return 0;
  let total = 0;
  for (const island of layout.islands) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const fi of island.faces) {
      const face = layout.faces[fi];
      for (const uv of [face.uvA, face.uvB, face.uvC]) {
        if (uv[0] < minU) minU = uv[0];
        if (uv[0] > maxU) maxU = uv[0];
        if (uv[1] < minV) minV = uv[1];
        if (uv[1] > maxV) maxV = uv[1];
      }
    }
    const w = (maxU - minU) || 0;
    const h = (maxV - minV) || 0;
    total += w * h;
  }
  return Math.max(0, Math.min(1, total));
}
