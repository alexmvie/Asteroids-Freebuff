/**
 * Translate tool factory for the UV editor.
 *
 * Owns the `applyTranslate()` tool — translates the selected
 * vertices' UVs by (du, dv) in UV space, optionally snapped
 * to the grid. Used by the 2D canvas's drag-to-translate
 * interaction (the "translate" drag mode in onCanvasPointerDown).
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createTranslateTool(state, deps);
 *   tool.applyTranslate(0.05, -0.02);
 */

import { snapToGrid } from './transforms.js';

/**
 * Create the translate tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(vk: number) => [number | null, number | null]} deps.parseEdgeKey
 * @param {() => void} deps.scheduleDraw
 * @param {() => void} deps.onAfterTranslate - called after the
 *   UVs are written (e.g., to recompute the layout)
 * @returns {object} { applyTranslate }
 */
export function createTranslateTool(state, deps) {
  const { getBodyGeometry, parseEdgeKey, scheduleDraw, onAfterTranslate } = deps;

  /**
   * Collect the vertex indices affected by the current selection.
   * Mode-aware: face mode → face triangle vertex indices, edge
   * mode → edge vertex pairs, vertex mode → vertex indices.
   * Returns a Set of vertex indices.
   *
   * Matches the original inline behavior (face/edge/vertex
   * only — not island) so the extracted tool is a faithful
   * refactor, not a behavior change. Island-mode selection
   * still works for transforms (the transforms factory
   * handles island) but the translate drag falls back to
   * "translate all" if no face/edge/vertex is selected.
   */
  function collectAffectedIndices(geom) {
    const idx = new Set();
    const mode = state.getMode();
    if (mode === 'face') {
      for (const f of state.getSelectedFaces()) {
        const ia = geom.index.array[f * 3 + 0];
        const ib = geom.index.array[f * 3 + 1];
        const ic = geom.index.array[f * 3 + 2];
        idx.add(ia); idx.add(ib); idx.add(ic);
      }
    } else if (mode === 'edge') {
      for (const e of state.getSelectedEdges()) {
        const [lo, hi] = parseEdgeKey(e);
        if (lo != null) { idx.add(lo); idx.add(hi); }
      }
    } else if (mode === 'vertex') {
      for (const v of state.getSelectedVertices()) idx.add(v);
    }
    return idx;
  }

  /**
   * Translate the selected vertices' UVs by (du, dv). If no
   * selection, translates all vertices (the "no selection →
   * translate all" fallback). Grid-snap is applied per-vertex
   * delta (not per-vertex UV) so the relative geometry of the
   * selection is preserved.
   */
  function applyTranslate(du, dv) {
    const geom = getBodyGeometry();
    if (!geom) return;
    const uvAttr = geom.attributes.uv;
    if (!uvAttr) return;
    const indices = collectAffectedIndices(geom);
    if (indices.size === 0) {
      // No selection → translate all.
      for (let i = 0; i < uvAttr.count; i++) indices.add(i);
    }
    let sDu = du, sDv = dv;
    if (state.getSnapEnabled()) {
      const SNAP_STEP = state.getSnapStep();
      sDu = snapToGrid(du, SNAP_STEP);
      sDv = snapToGrid(dv, SNAP_STEP);
    }
    for (const i of indices) {
      uvAttr.array[i * 2 + 0] += sDu;
      uvAttr.array[i * 2 + 1] += sDv;
    }
    uvAttr.needsUpdate = true;
    if (onAfterTranslate) onAfterTranslate();
    scheduleDraw();
  }

  return { applyTranslate };
}
