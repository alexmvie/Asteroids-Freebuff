/**
 * Boundary-seams tool factory for the UV editor.
 *
 * Owns the `markBoundarySeams()` tool — marks every
 * boundary edge of every island as a seam. Boundary edges
 * are always "free" to cut (they have no neighbor on the
 * other side) and often you want exactly those edges to
 * be seams anyway.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createBoundarySeamsTool(state, deps);
 *   tool.markBoundarySeams();
 */

/**
 * Create the boundary-seams tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => object | null} deps.getLayout
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(va: number, vb: number) => number} deps.buildEdgeKey
 * @param {(vk: number) => [number | null, number | null]} deps.parseEdgeKey
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => void} deps.notifySeamChange
 * @returns {object} { markBoundarySeams }
 */
export function createBoundarySeamsTool(state, deps) {
  const {
    getLayout,
    getBodyGeometry,
    buildEdgeKey,
    parseEdgeKey,
    scheduleDraw,
    getStatsEl,
    notifySeamChange,
  } = deps;

  /**
   * Find the boundary edges of an island. Returns an array
   * of `[va, vb]` vertex-index pairs — the edges of the
   * island that are touched by exactly ONE face in the
   * island.
   *
   * For a closed mesh, an island's boundary IS the seam
   * set restricted to that island. For an open mesh, it
   * also picks up the mesh's natural boundary edges
   * (edges with only 1 face in the whole mesh).
   */
  function getIslandBoundaryEdges(geom, island) {
    const idxArr = geom.index.array;
    // Count island faces per edge (using the vertex-edge
    // key since the geometry is indexed).
    const edgeToCount = new Map();
    for (const fi of island.faces) {
      const a = idxArr[fi * 3 + 0];
      const b = idxArr[fi * 3 + 1];
      const c = idxArr[fi * 3 + 2];
      for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
        const k = buildEdgeKey(va, vb);
        edgeToCount.set(k, (edgeToCount.get(k) || 0) + 1);
      }
    }
    // Boundary = edges with exactly 1 island face. Return
    // vertex pairs so the caller can convert to UV-edge-keys.
    const boundary = [];
    for (const [k, count] of edgeToCount) {
      if (count === 1) {
        const [lo, hi] = parseEdgeKey(k);
        boundary.push([lo, hi]);
      }
    }
    return boundary;
  }

  /**
   * Mark every boundary edge of every island as a seam.
   * Useful as a starting point: boundary edges are always
   * "free" to cut (they have no neighbor on the other side)
   * and often you want exactly those edges to be seams
   * anyway.
   */
  function markBoundarySeams() {
    const geom = getBodyGeometry();
    const layout = getLayout();
    if (!geom || !layout) return;
    let added = 0;
    const seamKeys = state.getSeamKeys();
    for (const island of layout.islands) {
      const boundaryEdges = getIslandBoundaryEdges(geom, island);
      // boundaryEdges is already in [va, vb] format, which
      // is what seamKeys stores (vertex-edge keys). No UV
      // lookup needed.
      for (const [va, vb] of boundaryEdges) {
        const k = buildEdgeKey(va, vb);
        if (!seamKeys.has(k)) {
          seamKeys.add(k);
          added++;
        }
      }
    }
    const statsEl = getStatsEl();
    if (statsEl) statsEl.textContent = `Marked ${added} boundary edges as seams.`;
    notifySeamChange();
    scheduleDraw();
  }

  return { markBoundarySeams };
}
