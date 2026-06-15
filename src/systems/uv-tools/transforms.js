/**
 * 2D affine transform matrix builders.
 *
 * Each transform is represented as a 6-element matrix
 * `[a, b, c, d, e, f]` such that
 *
 *   [u', v'] = [a*u + b*v + e, c*u + d*v + f]
 *
 * The `[a, b, c, d]` block is the linear part; `[e, f]` is
 * the translation. Note: the rotation/scale/mirror functions
 * produce matrices that operate around the SELECTION CENTROID
 * — the caller (the editor's `applyTransform`) translates to
 * centroid, applies the matrix, then translates back.
 *
 * @fileoverview Previously inlined in `src/systems/uv-unwrap-viewer.js`
 * (the 106K char god-function). Extracted to its own file so
 * the transform math is testable independently and the
 * orchestrator can shrink.
 *
 * All functions are PURE — no state, no side effects.
 */

/**
 * Build a 2D rotation matrix for `deg` degrees.
 *
 * @param {number} deg
 * @returns {[number, number, number, number, number, number]}
 */
export function rotationMatrix(deg) {
  const r = deg * Math.PI / 180;
  const co = Math.cos(r), si = Math.sin(r);
  return [co, -si, si, co, 0, 0];
}

/**
 * Build a 2D uniform scale matrix for `factor`.
 *
 * @param {number} factor
 * @returns {[number, number, number, number, number, number]}
 */
export function scaleMatrix(factor) {
  return [factor, 0, 0, factor, 0, 0];
}

/**
 * Build a 2D mirror matrix across the line y = x
 * (swaps u and v coordinates).
 *
 * @returns {[number, number, number, number, number, number]}
 */
export function mirrorMatrix() {
  return [0, 1, 1, 0, 0, 0];
}

/**
 * Build a 2D flip matrix along the U axis (mirrors across
 * the V axis, i.e. negates u).
 *
 * @returns {[number, number, number, number, number, number]}
 */
export function flipUMatrix() {
  return [-1, 0, 0, 1, 0, 0];
}

/**
 * Build a 2D flip matrix along the V axis (mirrors across
 * the U axis, i.e. negates v).
 *
 * @returns {[number, number, number, number, number, number]}
 */
export function flipVMatrix() {
  return [1, 0, 0, -1, 0, 0];
}

/**
 * Snap a coordinate to the nearest grid step.
 *
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
export function snapToGrid(value, step) {
  return Math.round(value / step) * step;
}
