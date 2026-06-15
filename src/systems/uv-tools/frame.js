/**
 * Frame tool factory for the UV editor.
 *
 * Owns the `frameSelection()` tool — fits the 2D camera
 * (pan + zoom) to the current selection's UV bounding box.
 * Mirrors Blender's `F` shortcut and RizomUV's "Frame
 * Selection".
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createFrameTool(state, deps);
 *   tool.frameSelection();
 */

import { UV_EDITOR_CONFIG } from './config.js';

/**
 * Create the frame tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => object | null} deps.getLayout - the current layout
 * @param {() => HTMLCanvasElement | null} deps.getUvCanvas - the 2D canvas
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {(vk: number) => [number | null, number | null]} deps.parseEdgeKey
 * @param {() => void} deps.scheduleDraw
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @returns {object} { frameSelection }
 */
export function createFrameTool(state, deps) {
  const {
    getLayout,
    getUvCanvas,
    getBodyGeometry,
    parseEdgeKey,
    scheduleDraw,
    getStatsEl,
  } = deps;

  /**
   * Fit the 2D camera to the current selection's UV bounding
   * box. If nothing is selected, frames the whole layout.
   * Slice mode owns the camera too (it overlays its own
   * preview line) — bail out so the user keeps the same
   * view for their next slice click.
   */
  function frameSelection() {
    if (state.getMode() === 'slice') return;
    const layout = getLayout();
    const uvCanvas = getUvCanvas();
    if (!layout || !uvCanvas) return;
    const w = uvCanvas.clientWidth, h = uvCanvas.clientHeight;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const includeUv = (u, v) => {
      if (!Number.isFinite(u) || !Number.isFinite(v)) return;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    };
    const mode = state.getMode();
    if (mode === 'face' || mode === 'island') {
      for (const fi of state.getSelectedFaces()) {
        const face = layout.faces[fi];
        if (!face) continue;
        includeUv(face.uvA[0], face.uvA[1]);
        includeUv(face.uvB[0], face.uvB[1]);
        includeUv(face.uvC[0], face.uvC[1]);
      }
    } else if (mode === 'edge') {
      const geom = getBodyGeometry();
      if (geom) {
        const uvArr = geom.attributes.uv.array;
        for (const ek of state.getSelectedEdges()) {
          const [va, vb] = parseEdgeKey(ek);
          if (va == null) continue;
          includeUv(uvArr[va * 2], uvArr[va * 2 + 1]);
          includeUv(uvArr[vb * 2], uvArr[vb * 2 + 1]);
        }
      }
    } else if (mode === 'vertex') {
      for (const vi of state.getSelectedVertices()) {
        const uv = layout.uvs[vi];
        if (!uv) continue;
        includeUv(uv[0], uv[1]);
      }
    }
    if (!Number.isFinite(minU)) {
      // No selection — frame the entire layout.
      for (const uv of layout.uvs) includeUv(uv[0], uv[1]);
    }
    if (!Number.isFinite(minU)) return; // no UVs at all
    // 5% padding so the bounding box doesn't sit flush against
    // the canvas border (the grid frame is drawn there and it
    // looks cramped without a margin).
    const boxW = maxU - minU || 0.01;
    const boxH = maxV - minV || 0.01;
    const padU = boxW * 0.05;
    const padV = boxH * 0.05;
    minU -= padU; maxU += padU;
    minV -= padV; maxV += padV;
    // Choose the zoom that fits both axes; the smaller wins so
    // the box isn't clipped on either side.
    const z = UV_EDITOR_CONFIG.zoom;
    const newZoom = Math.max(
      z.min,
      Math.min(z.max, Math.min(w / (maxU - minU) / w, h / (maxV - minV) / h))
    );
    state.setZoom(newZoom);
    // Center the box: the canvas-center pixel should land on
    // the box-center in UV space.
    state.setPanX(w * newZoom * (0.5 - (minU + maxU) / 2));
    state.setPanY(h * newZoom * (0.5 - (minV + maxV) / 2));
    const statsEl = getStatsEl();
    if (statsEl) {
      statsEl.textContent = `Framed selection: ${boxW.toFixed(2)} \u00d7 ${boxH.toFixed(2)} UV units.`;
    }
    scheduleDraw();
  }

  return { frameSelection };
}
