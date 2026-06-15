/**
 * Smart-unwrap tool factory for the UV editor.
 *
 * Owns the `runSmartUnwrap()` tool — one-click cascade that
 * auto-picks the best solver (Auto mode) or uses the
 * solver selected in the dropdown (Expert mode), then
 * applies the result to the geometry and shows a quality
 * report in the stats line.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createSmartUnwrapTool(state, deps);
 *   tool.runSmartUnwrap();
 */

import { UV_EDITOR_CONFIG } from './config.js';
import { applyUnwrapAndNotify } from './unwrap-result.js';
import { SOLVER_LABELS } from '../../geometry/uv-solvers.js';

/**
 * Create the smart-unwrap tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(geom: THREE.BufferGeometry, opts: {seamKeys: Set, thresholdDeg: number}) => {u: number[], v: number[], seamKeys: Set, islandCount: number, seamCount: number, maxStretch: number, solverId: string}} deps.solveAutomatic
 * @param {(geom: THREE.BufferGeometry, solverId: string, opts: {seamKeys: Set, thresholdDeg: number}) => object} deps.solveWith
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => void} deps.notifySeamChange
 * @param {() => void} deps.onAfterApply - called after UVs
 *   are written (e.g., to recompute the layout)
 * @returns {object} { runSmartUnwrap }
 */
export function createSmartUnwrapTool(state, deps) {
  const {
    getBodyGeometry,
    solveAutomatic,
    solveWith,
    scheduleDraw,
    getStatsEl,
    notifySeamChange,
    onAfterApply,
  } = deps;

  /**
   * One-click smart unwrap. In Auto mode, runs the
   * cascade and picks the best solver. In Expert mode,
   * uses the solver selected in the dropdown. The result
   * is applied to the geometry, the seams are added to
   * `seamKeys` (so the user can see them highlighted in
   * the 2D panel + 3D mesh), and a quality report is
   * shown in the stats line.
   */
  function runSmartUnwrap() {
    const geom = getBodyGeometry();
    if (!geom) return;
    const startTime = performance.now();
    const thresholdDeg = UV_EDITOR_CONFIG.auto.thresholdDeg;
    const seamKeys = state.getSeamKeys();
    const solverMode = state.getSolverMode();
    let result;
    let modeLabel;
    if (solverMode === 'auto') {
      result = solveAutomatic(geom, { seamKeys, thresholdDeg });
      modeLabel = 'auto';
    } else {
      result = solveWith(geom, state.getExpertSolverId(), { seamKeys, thresholdDeg });
      modeLabel = 'expert';
    }
    // Shared apply+notify skeleton (same as start-unwrap).
    // Returns the number of NEW seams added to `seamKeys` so
    // the stats line can show the "auto-added" count.
    const added = applyUnwrapAndNotify(geom, result, seamKeys, {
      onAfterApply,
      notifySeamChange,
      scheduleDraw,
    });
    const ms = (performance.now() - startTime).toFixed(0);
    const statsEl = getStatsEl();
    if (statsEl) {
      const solverLabel = modeLabel === 'auto'
        ? result.solverId
        : `${SOLVER_LABELS[state.getExpertSolverId()] || state.getExpertSolverId()} (expert)`;
      statsEl.textContent =
        `\u2605 SMART: ${result.islandCount} island${result.islandCount === 1 ? '' : 's'} \u00b7 ` +
        `${result.seamCount} seam${result.seamCount === 1 ? '' : 's'} ` +
        `(${added} auto-added) \u00b7 ` +
        `solver: ${solverLabel} \u00b7 ` +
        `max stretch: ${result.maxStretch.toFixed(1)}\u00d7 \u00b7 ` +
        `${ms}ms`;
    }
  }

  return { runSmartUnwrap };
}
