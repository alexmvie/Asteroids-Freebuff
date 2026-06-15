/**
 * Slice tool factory for the UV editor.
 *
 * Owns the slice interaction: click two points in the 2D
 * canvas to mark every edge the line between them crosses
 * as a seam. Mirrors Blender's "Knife" tool workflow.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createSliceTool(state, deps);
 *   tool.startSlice();
 *   tool.executeSlice();
 *   tool.cancelSlice();
 */

/**
 * Create the slice tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => object | null} deps.getLayout
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {() => HTMLCanvasElement | null} deps.getUvCanvas
 * @param {(sx: number, sy: number, w: number, h: number) => {x: number, y: number}} deps.screenToUv
 * @param {(va: number, vb: number) => number} deps.buildEdgeKey
 * @param {(p1: {x:number,y:number}, p2: {x:number,y:number}, p3: {x:number,y:number}, p4: {x:number,y:number}) => boolean} deps.segmentsCross
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => void} deps.notifySeamChange
 * @param {(m: string) => void} deps.setMode - orchestrator's setMode
 *   (updates the toolbar active state + scheduleDraw)
 * @returns {object} { startSlice, cancelSlice, executeSlice }
 */
export function createSliceTool(state, deps) {
  const {
    getLayout,
    getBodyGeometry,
    getUvCanvas,
    screenToUv,
    buildEdgeKey,
    segmentsCross,
    scheduleDraw,
    getStatsEl,
    notifySeamChange,
    setMode,
  } = deps;

  /**
   * Enter slice mode. The next two clicks in the 2D canvas
   * mark every edge the line between them crosses as a seam.
   */
  function startSlice() {
    if (!getLayout()) return;
    setMode('slice');
    state.clearSlice();
    const statsEl = getStatsEl();
    if (statsEl) {
      statsEl.textContent = 'SLICE: click the first point in the 2D view (Esc to cancel).';
    }
  }

  /**
   * Exit slice mode without committing a slice. Used by the
   * Esc hotkey.
   */
  function cancelSlice() {
    if (state.getMode() !== 'slice') return;
    setMode('face');
    state.clearSlice();
    const statsEl = getStatsEl();
    if (statsEl) statsEl.textContent = 'Slice cancelled.';
  }

  /**
   * Execute the slice: for every edge in the layout, check if
   * the segment (sliceFirst, sliceSecond) crosses the edge's
   * UV-space segment. Crossing uses the standard orientation
   * test (sign of the cross product on both sides). Touching
   * at a shared vertex does NOT count as crossing — otherwise
   * any click near a vertex would explode the seam set.
   *
   * Does NOT exit slice mode — the caller (canvas pointer
   * handler) does that after this returns.
   */
  function executeSlice() {
    const sliceFirst = state.getSliceFirst();
    const sliceSecond = state.getSliceSecond();
    const layout = getLayout();
    if (!sliceFirst || !sliceSecond || !layout) return;
    const geom = getBodyGeometry();
    if (!geom) return;
    // Canvas size for the screen→UV conversion.
    const uvCanvas = getUvCanvas();
    if (!uvCanvas) return;
    const w = uvCanvas.clientWidth, h = uvCanvas.clientHeight;
    const uv1 = screenToUv(sliceFirst.x, sliceFirst.y, w, h);
    const uv2 = screenToUv(sliceSecond.x, sliceSecond.y, w, h);
    let added = 0;
    // Dedupe per-edge: the same vertex-edge appears in two
    // adjacent faces, so we use a Set to avoid adding it
    // twice.
    const addedKeys = new Set();
    const seamKeys = state.getSeamKeys();
    for (const island of layout.islands) {
      for (const fi of island.faces) {
        const face = layout.faces[fi];
        const verts = [face.a, face.b, face.c];
        const uvs = [face.uvA, face.uvB, face.uvC];
        for (let i = 0; i < 3; i++) {
          const va = verts[i], vb = verts[(i + 1) % 3];
          const uvA = uvs[i], uvB = uvs[(i + 1) % 3];
          if (segmentsCross(uv1, uv2, uvA, uvB)) {
            const k = buildEdgeKey(va, vb);
            if (!addedKeys.has(k)) {
              addedKeys.add(k);
              if (!seamKeys.has(k)) {
                seamKeys.add(k);
                added++;
              }
            }
          }
        }
      }
    }
    const statsEl = getStatsEl();
    if (statsEl) {
      statsEl.textContent = `SLICE: marked ${added} edge${added === 1 ? '' : 's'} as seams.`;
    }
    notifySeamChange();
    scheduleDraw();
  }

  return { startSlice, cancelSlice, executeSlice };
}
