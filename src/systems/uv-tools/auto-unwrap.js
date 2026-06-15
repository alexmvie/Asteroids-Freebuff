/**
 * Auto-unwrap tool factory for the UV editor.
 *
 * Owns the `runAutoUnwrap()` tool — auto-detects seams by
 * dihedral angle (curvature-based), adds them to the user's
 * seam set, and runs a re-unwrap so the 2D layout + 3D
 * mesh reflect the new seams.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createAutoUnwrapTool(state, deps);
 *   tool.runAutoUnwrap();
 */

import { UV_EDITOR_CONFIG } from './config.js';
import { applyUnwrapResult } from './unwrap-result.js';

/**
 * Create the auto-unwrap tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(geom: THREE.BufferGeometry, thresholdDeg: number) => Set<number>} deps.autoDetectSeams
 * @param {(geom: THREE.BufferGeometry, seamKeys: Set, opts: {pack: boolean}) => {u: number[], v: number[]}} deps.reunwrap
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => void} deps.notifySeamChange
 * @param {() => void} deps.onAfterApply - called after UVs
 *   are written (e.g., to recompute the layout)
 * @returns {object} { runAutoUnwrap }
 */
export function createAutoUnwrapTool(state, deps) {
  const {
    getBodyGeometry,
    autoDetectSeams,
    reunwrap,
    scheduleDraw,
    getStatsEl,
    notifySeamChange,
    onAfterApply,
  } = deps;

  /**
   * Auto-detect seams by dihedral angle (curvature-based)
   * and run the unwrap. The detected seams are added to
   * `seamKeys` so the user can SEE them highlighted in the
   * 2D panel (and the 3D mesh, via the seam change
   * listeners).
   */
  function runAutoUnwrap() {
    const geom = getBodyGeometry();
    if (!geom) return;
    const threshold = UV_EDITOR_CONFIG.auto.thresholdDeg;
    // autoDetectSeams returns vertex-edge keys
    // (buildEdgeKey format) — exactly what seamKeys stores,
    // so no conversion is needed.
    const seamVertexKeys = autoDetectSeams(geom, threshold);
    let added = 0;
    const seamKeys = state.getSeamKeys();
    for (const vk of seamVertexKeys) {
      if (!seamKeys.has(vk)) {
        seamKeys.add(vk);
        added++;
      }
    }
    const statsEl = getStatsEl();
    if (statsEl) {
      statsEl.textContent =
        `AUTO: ${added} seam${added === 1 ? '' : 's'} added ` +
        `(${threshold}\u00b0 dihedral). Press W to re-unwrap, or enable LIVE.`;
    }
    notifySeamChange();
    // Run the unwrap with the (now-augmented) seam set so
    // the 2D layout + 3D mesh texture reflect the new seams.
    // Calls reunwrap directly (no cross-tool dep on the
    // re-unwrap factory) and shares the applyUnwrapResult
    // helper with re-unwrap / smart-unwrap.
    const result = reunwrap(geom, seamKeys, { pack: true });
    applyUnwrapResult(geom, result);
    if (onAfterApply) onAfterApply();
    scheduleDraw();
  }

  return { runAutoUnwrap };
}
