/**
 * Seam-3D toggle tool factory for the UV editor.
 *
 * Owns the `toggleSeamFrom3D()` tool — public API for the
 * 3D mini viewport (in the edit object screen) to toggle a
 * seam by vertex-edge pair. The 3D overlay rebuilds via
 * the seam-change listener, and the live re-unwrap
 * pipeline (if ON) runs.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createSeam3DToggleTool(state, deps);
 *   const added = tool.toggleSeamFrom3D(va, vb);
 */

/**
 * Create the 3D seam toggle tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {(va: number, vb: number) => number} deps.buildEdgeKey
 * @param {() => void} deps.scheduleDraw
 * @param {() => void} deps.notifySeamChange
 * @returns {object} { toggleSeamFrom3D }
 */
export function createSeam3DToggleTool(state, deps) {
  const { buildEdgeKey, scheduleDraw, notifySeamChange } = deps;

  /**
   * Toggle a seam by vertex-edge pair. No UV lookup needed
   * — seamKeys is in vertex-edge key format, which is
   * stable across re-unwraps.
   *
   * @param {number} va - vertex index a
   * @param {number} vb - vertex index b
   * @returns {boolean} true if the seam was added, false if removed
   */
  function toggleSeamFrom3D(va, vb) {
    const k = buildEdgeKey(va, vb);
    const seamKeys = state.getSeamKeys();
    let added;
    if (seamKeys.has(k)) { seamKeys.delete(k); added = false; }
    else { seamKeys.add(k); added = true; }
    notifySeamChange();
    scheduleDraw();
    return added;
  }

  return { toggleSeamFrom3D };
}
