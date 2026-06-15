/**
 * Selection tools factory for the UV editor.
 *
 * Owns the selection-manipulation logic:
 *   - `growSelection()` / `shrinkSelection()` — Blender-style
 *     grow/shrink by one ring of neighbors (faces, edges,
 *     or vertices, depending on the current mode)
 *   - `findIslandOfFace()` — lookup helper for island mode
 *   - `commitBoxSelect()` — finalize the box-select drag rect
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tools = createSelectionTools(state, deps);
 *   tools.growSelection();
 *   tools.commitBoxSelect();
 */

import { buildEdgeKey } from '../../geometry/uv-unwrapping.js';

/**
 * Create the selection tools.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => object | null} deps.getLayout
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {() => HTMLCanvasElement | null} deps.getUvCanvas
 * @param {(sx: number, sy: number, w: number, h: number) => {x: number, y: number}} deps.uvToScreen
 * @param {(vk: number) => [number | null, number | null]} deps.parseEdgeKey
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {() => void} deps.scheduleDraw
 * @returns {object} { growSelection, shrinkSelection, findIslandOfFace, commitBoxSelect }
 */
export function createSelectionTools(state, deps) {
  const {
    getLayout,
    getBodyGeometry,
    getUvCanvas,
    uvToScreen,
    parseEdgeKey,
    getStatsEl,
    scheduleDraw,
  } = deps;

  /**
   * Find the island that contains a given face. Returns
   * the island object (with .faces[]) or null if the face
   * is not in any island. Used by island mode to expand a
   * click into a full island selection.
   */
  function findIslandOfFace(faceIdx) {
    const layout = getLayout();
    if (!layout) return null;
    for (const island of layout.islands) {
      if (island.faces.includes(faceIdx)) return island;
    }
    return null;
  }

  /**
   * Grow the current selection by one ring of neighbors.
   * Blender hotkey: `[`. RizomUV: Ctrl+Space.
   */
  function growSelection() {
    const layout = getLayout();
    if (!layout) return;
    const mode = state.getMode();
    if (mode === 'face' || mode === 'island') {
      const adj = layout.faceAdjacency;
      const newSel = new Set(state.getSelectedFaces());
      for (const fi of newSel) {
        if (!adj[fi]) continue;
        for (const nb of adj[fi]) newSel.add(nb);
      }
      // Replace the selection by clearing + re-adding. Since
      // selectedFaces is the same Set returned by state, we
      // mutate it in place.
      const selectedFaces = state.getSelectedFaces();
      selectedFaces.clear();
      for (const fi of newSel) selectedFaces.add(fi);
    } else if (mode === 'edge') {
      const geom = getBodyGeometry();
      if (!geom) return;
      const selectedEdges = state.getSelectedEdges();
      const newSel = new Set(selectedEdges);
      const touchedVerts = new Set();
      for (const uvK of selectedEdges) {
        const [va, vb] = parseEdgeKey(uvK);
        if (va != null) { touchedVerts.add(va); touchedVerts.add(vb); }
      }
      const idxArr = geom.index.array;
      const faceCount = Math.floor(idxArr.length / 3);
      const seen = new Set();
      for (let f = 0; f < faceCount; f++) {
        const a = idxArr[f * 3 + 0];
        const b = idxArr[f * 3 + 1];
        const c = idxArr[f * 3 + 2];
        for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
          const k = buildEdgeKey(va, vb);
          if (seen.has(k)) continue;
          seen.add(k);
          if (touchedVerts.has(va) || touchedVerts.has(vb)) newSel.add(k);
        }
      }
      selectedEdges.clear();
      for (const k of newSel) selectedEdges.add(k);
    } else if (mode === 'vertex') {
      const geom = getBodyGeometry();
      if (!geom) return;
      const selectedVertices = state.getSelectedVertices();
      const newSel = new Set(selectedVertices);
      const idxArr = geom.index.array;
      const faceCount = Math.floor(idxArr.length / 3);
      for (let f = 0; f < faceCount; f++) {
        const a = idxArr[f * 3 + 0];
        const b = idxArr[f * 3 + 1];
        const c = idxArr[f * 3 + 2];
        for (const [va, vb] of [[a, b], [b, c], [c, a]]) {
          if (selectedVertices.has(va) || selectedVertices.has(vb)) {
            newSel.add(va);
            newSel.add(vb);
          }
        }
      }
      selectedVertices.clear();
      for (const v of newSel) selectedVertices.add(v);
    }
    const statsEl = getStatsEl();
    if (statsEl) {
      const n = mode === 'face' || mode === 'island' ? state.getSelectedFaces().size
        : mode === 'edge' ? state.getSelectedEdges().size
        : state.getSelectedVertices().size;
      statsEl.textContent = `Grew selection: ${n} ${mode === 'face' || mode === 'island' ? 'face' : mode}${n === 1 ? '' : 's'}.`;
    }
    scheduleDraw();
  }

  /**
   * Shrink the current selection by removing its boundary
   * ring. Blender hotkey: `]`.
   */
  function shrinkSelection() {
    const layout = getLayout();
    if (!layout) return;
    const mode = state.getMode();
    if (mode === 'face' || mode === 'island') {
      const adj = layout.faceAdjacency;
      const selectedFaces = state.getSelectedFaces();
      const toRemove = [];
      for (const fi of selectedFaces) {
        if (!adj[fi]) continue;
        let isBoundary = false;
        for (const nb of adj[fi]) {
          if (!selectedFaces.has(nb)) { isBoundary = true; break; }
        }
        if (isBoundary) toRemove.push(fi);
      }
      for (const fi of toRemove) selectedFaces.delete(fi);
    } else if (mode === 'edge') {
      const geom = getBodyGeometry();
      if (!geom) return;
      const selectedEdges = state.getSelectedEdges();
      const touchedVerts = new Set();
      for (const uvK of selectedEdges) {
        const [va, vb] = parseEdgeKey(uvK);
        if (va != null) { touchedVerts.add(va); touchedVerts.add(vb); }
      }
      const toRemove = [];
      for (const uvK of selectedEdges) {
        const [va, vb] = parseEdgeKey(uvK);
        if (va == null) continue;
        let isBoundary = false;
        for (const v of [va, vb]) {
          const idxArr = geom.index.array;
          const faceCount = Math.floor(idxArr.length / 3);
          outer: for (let f = 0; f < faceCount; f++) {
            const a = idxArr[f * 3 + 0];
            const b = idxArr[f * 3 + 1];
            const c = idxArr[f * 3 + 2];
            for (const [ea, eb] of [[a, b], [b, c], [c, a]]) {
              if ((ea === v || eb === v) && ea !== va && eb !== vb) {
                const k = buildEdgeKey(ea, eb);
                if (!selectedEdges.has(k)) { isBoundary = true; break outer; }
              }
            }
          }
          if (isBoundary) break;
        }
        if (isBoundary) toRemove.push(uvK);
      }
      for (const k of toRemove) selectedEdges.delete(k);
    } else if (mode === 'vertex') {
      const geom = getBodyGeometry();
      if (!geom) return;
      const selectedVertices = state.getSelectedVertices();
      const toRemove = [];
      const idxArr = geom.index.array;
      const faceCount = Math.floor(idxArr.length / 3);
      for (const v of selectedVertices) {
        let isBoundary = false;
        for (let f = 0; f < faceCount && !isBoundary; f++) {
          const a = idxArr[f * 3 + 0];
          const b = idxArr[f * 3 + 1];
          const c = idxArr[f * 3 + 2];
          for (const [ea, eb] of [[a, b], [b, c], [c, a]]) {
            if (ea === v && !selectedVertices.has(eb)) { isBoundary = true; break; }
            else if (eb === v && !selectedVertices.has(ea)) { isBoundary = true; break; }
          }
        }
        if (isBoundary) toRemove.push(v);
      }
      for (const v of toRemove) selectedVertices.delete(v);
    }
    const statsEl = getStatsEl();
    if (statsEl) {
      const n = mode === 'face' || mode === 'island' ? state.getSelectedFaces().size
        : mode === 'edge' ? state.getSelectedEdges().size
        : state.getSelectedVertices().size;
      statsEl.textContent = `Shrunk selection: ${n} ${mode === 'face' || mode === 'island' ? 'face' : mode}${n === 1 ? '' : 's'}.`;
    }
    scheduleDraw();
  }

  /**
   * Commit the current box-select drag rectangle: find
   * every face/vertex inside the rect and add it to the
   * selection. In island mode, any face inside the box
   * selects its whole island.
   */
  function commitBoxSelect() {
    const boxSelectRect = state.getBoxSelectRect();
    const layout = getLayout();
    if (!boxSelectRect || !layout) return;
    const r = boxSelectRect;
    const xMin = Math.min(r.x0, r.x1), xMax = Math.max(r.x0, r.x1);
    const yMin = Math.min(r.y0, r.y1), yMax = Math.max(r.y0, r.y1);
    const uvCanvas = getUvCanvas();
    if (!uvCanvas) return;
    const w = uvCanvas.clientWidth, h = uvCanvas.clientHeight;
    const mode = state.getMode();
    if (mode === 'face' || mode === 'island') {
      const addedIslands = mode === 'island' ? new Set() : null;
      const selectedFaces = state.getSelectedFaces();
      for (const island of layout.islands) {
        for (const fi of island.faces) {
          const face = layout.faces[fi];
          for (const uv of [face.uvA, face.uvB, face.uvC]) {
            const p = uvToScreen(uv[0], uv[1], w, h);
            if (p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax) {
              if (mode === 'island') {
                if (!addedIslands.has(island)) {
                  addedIslands.add(island);
                  for (const f of island.faces) selectedFaces.add(f);
                }
              } else {
                selectedFaces.add(fi);
              }
              break;
            }
          }
        }
      }
    } else if (mode === 'vertex') {
      const selectedVertices = state.getSelectedVertices();
      for (let vi = 0; vi < layout.uvs.length; vi++) {
        const p = uvToScreen(layout.uvs[vi][0], layout.uvs[vi][1], w, h);
        if (p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax) {
          selectedVertices.add(vi);
        }
      }
    }
  }

  return { growSelection, shrinkSelection, findIslandOfFace, commitBoxSelect };
}
