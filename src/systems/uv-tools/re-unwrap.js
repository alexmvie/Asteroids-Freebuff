/**
 * Re-unwrap tool factory for the UV editor.
 *
 * Owns the `runReUnwrap()` tool — re-computes the UV layout
 * for the current geometry using the current seam set, and
 * writes the new UVs back to the geometry. The user-marked
 * seams persist across unwraps (the geometry topology
 * doesn't change, only the UVs do).
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createReUnwrapTool(state, deps);
 *   tool.runReUnwrap();
 */

import { applyUnwrapResult } from './unwrap-result.js';

/**
 * Create the re-unwrap tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(geom: THREE.BufferGeometry, seamKeys: Set, opts: {pack: boolean}) => {u: number[], v: number[]}} deps.reunwrap
 * @param {() => void} deps.scheduleDraw
 * @param {() => void} deps.notifySeamChange
 * @param {() => void} deps.onAfterApply - called after UVs
 *   are written (e.g., to recompute the layout)
 * @returns {object} { runReUnwrap }
 */
export function createReUnwrapTool(state, deps) {
  const { getBodyGeometry, reunwrap, scheduleDraw, notifySeamChange, onAfterApply } = deps;

  /**
   * Re-compute the UV layout for the current geometry using
   * the current seam set, and write the new UVs back. The
   * user-marked seams persist (the geometry topology
   * doesn't change, only the UVs do).
   */
  function runReUnwrap() {
    const geom = getBodyGeometry();
    if (!geom) return;
    // seamKeys is a Set of VERTEX-edge keys (`buildEdgeKey`),
    // which is exactly what `reunwrap` wants — no conversion
    // needed.
    const result = reunwrap(geom, state.getSeamKeys(), { pack: true });
    applyUnwrapResult(geom, result);
    if (onAfterApply) onAfterApply();
    notifySeamChange();
    scheduleDraw();
  }

  return { runReUnwrap };
}
