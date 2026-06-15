/**
 * Clear-seams tool factory for the UV editor.
 *
 * Owns the `clearSeams()` tool — clears all user-marked
 * seams and notifies the 3D overlay + live re-unwrap pipeline.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createClearSeamsTool(state, deps);
 *   tool.clearSeams();
 */

/**
 * Create the clear-seams tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => HTMLElement | null} deps.getStatsEl - status line
 *   element getter. Called at `clearSeams()` time, not at
 *   factory-creation time, so it late-binds to the
 *   orchestrator's `statsEl` (which is set in `mount()`,
 *   after the factory is instantiated).
 * @param {() => void} deps.scheduleDraw
 * @param {() => void} deps.notifySeamChange - seam change notification
 * @returns {object} { clearSeams }
 */
export function createClearSeamsTool(state, deps) {
  const { getStatsEl, scheduleDraw, notifySeamChange } = deps;

  return {
    /**
     * Clear all user-marked seams. The 3D seam overlay
     * rebuilds via the seam-change listener, and the live
     * re-unwrap pipeline (if ON) runs.
     */
    clearSeams() {
      state.clearSeamKeys();
      const statsEl = getStatsEl();
      if (statsEl) statsEl.textContent = 'Cleared all user-marked seams.';
      notifySeamChange();
      scheduleDraw();
    },
  };
}
