/**
 * View-toggles factory for the UV editor.
 *
 * Owns the three view-mode toggles:
 *   - `toggleHeatmap()`     — stretch heatmap on/off
 *   - `toggleWireframe()`   — wireframe-only overlay on/off
 *   - `toggleLiveUnwrap()`  — live re-unwrap on seam change
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const toggles = createViewToggles(state, deps);
 *   toggles.toggleHeatmap();
 *   toggles.toggleLiveUnwrap();
 */

/**
 * Create the view-toggles factory.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => HTMLElement | null} deps.getToolsEl - the toolbar
 *   container (for updating button active state)
 * @param {() => void} deps.notifySeamChange - called by
 *   toggleLiveUnwrap so the 3D seam overlay + live re-unwrap
 *   pipeline see the new setting
 * @returns {object} { toggleHeatmap, toggleWireframe, toggleLiveUnwrap }
 */
export function createViewToggles(state, deps) {
  const { scheduleDraw, getStatsEl, getToolsEl, notifySeamChange } = deps;

  /** Update the toolbar button's active state. */
  function setBtnActive(tool, isActive) {
    const toolsEl = getToolsEl();
    if (!toolsEl) return;
    const btn = toolsEl.querySelector(`[data-uv-tool="${tool}"]`);
    if (btn) btn.dataset.uvActive = isActive ? '1' : '0';
  }

  function toggleHeatmap() {
    state.setHeatmapEnabled(!state.getHeatmapEnabled());
    setBtnActive('heat', state.getHeatmapEnabled());
    scheduleDraw();
  }

  function toggleWireframe() {
    state.setMeshWireframe(!state.getMeshWireframe());
    setBtnActive('wire', state.getMeshWireframe());
    scheduleDraw();
  }

  function toggleLiveUnwrap() {
    state.setLiveUnwrapEnabled(!state.getLiveUnwrapEnabled());
    setBtnActive('live', state.getLiveUnwrapEnabled());
    const statsEl = getStatsEl();
    if (statsEl) {
      statsEl.textContent = state.getLiveUnwrapEnabled()
        ? 'LIVE re-unwrap: ON. Seam changes will re-unwrap automatically.'
        : 'LIVE re-unwrap: OFF. Press W to re-unwrap manually.';
    }
    notifySeamChange();
  }

  return { toggleHeatmap, toggleWireframe, toggleLiveUnwrap };
}
