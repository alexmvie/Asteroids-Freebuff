/**
 * Shared unwrap result helper for the UV editor.
 *
 * All three unwrap tools (re-unwrap, auto-unwrap,
 * smart-unwrap) produce a result of the same shape:
 * `{ u: number[], v: number[] }` (plus optional solver
 * metadata). Writing the result into the geometry's `uv`
 * attribute and marking it for GPU upload is a 6-line
 * pattern that's identical across all three — this module
 * factors it out so the tool files don't duplicate it.
 *
 * @fileoverview Shared helper for the unwrap tool files.
 *
 * @example
 *   import { applyUnwrapResult } from './unwrap-result.js';
 *   applyUnwrapResult(geom, result);
 */

/**
 * Write `result.u[]` / `result.v[]` into the geometry's
 * `uv` attribute and mark it for GPU upload.
 *
 * @param {THREE.BufferGeometry} geom
 * @param {{u: number[], v: number[]}} result - the unwrap
 *   result (from reunwrap / solveWith / solveAutomatic)
 */
export function applyUnwrapResult(geom, result) {
  const uvAttr = geom.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.array[i * 2 + 0] = result.u[i];
    uvAttr.array[i * 2 + 1] = result.v[i];
  }
  uvAttr.needsUpdate = true;
}

/**
 * Shared "apply + notify" skeleton used by every unwrap tool
 * (start-unwrap, smart-unwrap, re-unwrap, auto-unwrap).
 * Extracts the 4-line pattern that's identical across all of
 * them so the tools don't drift apart when the next maintainer
 * adds a side-effect to one but not the other.
 *
 * @param {THREE.BufferGeometry} geom - the body geometry
 * @param {{u: number[], v: number[], seamKeys: Set, islandCount: number, seamCount: number, maxStretch: number, solverId: string}} result - the unwrap result
 * @param {Set<string>} userSeamKeys - the live user seam set; auto-detected seams from `result.seamKeys` are added to it
 * @param {object} opts
 * @param {() => void} opts.onAfterApply - recompute layout (call after UVs change)
 * @param {() => void} opts.notifySeamChange - fire seam-change listeners (3D overlay + live re-unwrap)
 * @param {() => void} opts.scheduleDraw - schedule a 2D redraw
 * @returns {number} how many NEW seams were added to `userSeamKeys`
 */
export function applyUnwrapAndNotify(geom, result, userSeamKeys, opts) {
  const { onAfterApply, notifySeamChange, scheduleDraw } = opts || {};
  let added = 0;
  if (userSeamKeys && result.seamKeys) {
    for (const k of result.seamKeys) {
      if (!userSeamKeys.has(k)) { userSeamKeys.add(k); added++; }
    }
  }
  applyUnwrapResult(geom, result);
  if (onAfterApply) onAfterApply();
  if (notifySeamChange) notifySeamChange();
  if (scheduleDraw) scheduleDraw();
  return added;
}
