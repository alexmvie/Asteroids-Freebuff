/**
 * Transform tools factory for the UV editor.
 *
 * Owns the 5 transform tools (rotate, scale, mirror, flip U,
 * flip V) + the snap toggle. All transforms apply a 2D affine
 * matrix to the selected vertices' UVs around the selection
 * centroid, optionally snapped to the grid.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split. The factory
 * takes the editor state + a small `deps` object (getBodyGeometry,
 * scheduleDraw, etc.) and returns the public transform methods.
 *
 * @example
 *   const tools = createTransformTools(state, deps);
 *   tools.rotateSelection(15);
 *   tools.scaleSelection(1.1);
 *   tools.toggleSnap();
 */

import {
  rotationMatrix,
  scaleMatrix,
  mirrorMatrix,
  flipUMatrix,
  flipVMatrix,
  snapToGrid,
} from './transforms.js';

/**
 * Create the transform tools.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {() => void} deps.scheduleDraw
 * @returns {object} { rotateSelection, scaleSelection, mirrorSelection, flipU, flipV, toggleSnap }
 */
export function createTransformTools(state, deps) {
  const { getBodyGeometry, scheduleDraw } = deps;

  /**
   * Collect the vertex indices affected by the current selection.
   * Mode-aware: face mode → face triangle vertex indices, edge
   * mode → edge vertex pairs, vertex mode → vertex indices.
   * Returns a Set of vertex indices.
   */
  function collectAffectedIndices(geom) {
    const idx = new Set();
    const mode = state.getMode();
    if (mode === 'face' || mode === 'island') {
      const faces = state.getSelectedFaces();
      for (const f of faces) {
        const ia = geom.index.array[f * 3 + 0];
        const ib = geom.index.array[f * 3 + 1];
        const ic = geom.index.array[f * 3 + 2];
        idx.add(ia); idx.add(ib); idx.add(ic);
      }
    } else if (mode === 'edge') {
      const edges = state.getSelectedEdges();
      for (const e of edges) {
        const [lo, hi] = parseEdgeKeyToVerts(e);
        if (lo != null) { idx.add(lo); idx.add(hi); }
      }
    } else if (mode === 'vertex') {
      for (const v of state.getSelectedVertices()) idx.add(v);
    }
    return idx;
  }

  /**
   * Decode a vertex-edge key (buildEdgeKey encoding) back to
   * [lo, hi] vertex-index pair. Replicates the orchestrator's
   * local helper. The keys are imported from the uv-unwrapping
   * module via deps.parseEdgeKey (the orchestrator passes it
   * in so the tool factory doesn't need to know the encoding
   * format).
   */
  function parseEdgeKeyToVerts(vk) {
    if (vk == null || !Number.isFinite(vk)) return [null, null];
    return deps.parseEdgeKey(vk);
  }

  /**
   * Apply a 2D affine transform matrix to the selected vertices'
   * UVs. The matrix is [a, b, c, d, e, f] such that
   * [u', v'] = [a*u + b*v + e, c*u + d*v + f], with rotation/
   * scale centered on the selection's centroid.
   *
   * @param {number[]} matrix - 6-element affine matrix
   * @param {() => void} onAfterApply - called after the UVs are
   *   written (e.g., to recompute the layout)
   */
  function applyTransform(matrix, onAfterApply) {
    const geom = getBodyGeometry();
    if (!geom) return;
    const uvAttr = geom.attributes.uv;
    if (!uvAttr) return;
    const indices = collectAffectedIndices(geom);
    if (indices.size === 0) return;
    // Compute centroid for rotation/scale around it.
    let cu = 0, cv = 0;
    for (const i of indices) {
      cu += uvAttr.array[i * 2 + 0];
      cv += uvAttr.array[i * 2 + 1];
    }
    cu /= indices.size; cv /= indices.size;
    const [a, b, c, d, e, f] = matrix;
    const snapEnabled = state.getSnapEnabled();
    const SNAP_STEP = state.getSnapStep();
    for (const i of indices) {
      const u0 = uvAttr.array[i * 2 + 0] - cu;
      const v0 = uvAttr.array[i * 2 + 1] - cv;
      let un = a * u0 + b * v0 + cu + e;
      let vn = c * u0 + d * v0 + cv + f;
      if (snapEnabled) {
        un = snapToGrid(un, SNAP_STEP);
        vn = snapToGrid(vn, SNAP_STEP);
      }
      uvAttr.array[i * 2 + 0] = un;
      uvAttr.array[i * 2 + 1] = vn;
    }
    uvAttr.needsUpdate = true;
    if (onAfterApply) onAfterApply();
    scheduleDraw();
  }

  return {
    /**
     * Rotate the selection by `deg` degrees around its centroid.
     * @param {number} deg
     */
    rotateSelection(deg) {
      applyTransform(rotationMatrix(deg), deps.onAfterApply);
    },

    /**
     * Scale the selection by `factor` around its centroid.
     * @param {number} factor
     */
    scaleSelection(factor) {
      applyTransform(scaleMatrix(factor), deps.onAfterApply);
    },

    /**
     * Mirror the selection across the U=V diagonal.
     */
    mirrorSelection() {
      applyTransform(mirrorMatrix(), deps.onAfterApply);
    },

    /**
     * Flip the selection's U axis.
     */
    flipU() {
      applyTransform(flipUMatrix(), deps.onAfterApply);
    },

    /**
     * Flip the selection's V axis.
     */
    flipV() {
      applyTransform(flipVMatrix(), deps.onAfterApply);
    },

    /**
     * Toggle the grid-snap setting. When ON, all transform
     * results are snapped to the nearest `snapStep` grid line.
     */
    toggleSnap() {
      state.setSnapEnabled(!state.getSnapEnabled());
    },
  };
}
