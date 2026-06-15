/**
 * Drawing tool factory for the UV editor.
 *
 * Owns the 2D canvas rendering: the main `draw()` entry
 * point plus all the per-layer helpers (background, grid,
 * layout, hover, selection, box-select, slice preview,
 * overlay). Also owns the texture loader (`ensureTextureLoaded`)
 * and the island color helper (`colorForIsland`).
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createDrawTool(state, deps);
 *   tool.draw();
 */

import { UV_EDITOR_CONFIG } from './config.js';
import {
  hsvToRgb,
  computePackEfficiency,
} from './geometry-utils.js';
import {
  parseEdgeKey,
  stretchToColor,
} from '../../geometry/uv-unwrapping.js';

/**
 * Create the drawing tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => boolean} deps.getEnabled - whether the editor is enabled
 * @param {() => HTMLCanvasElement | null} deps.getUvCanvas
 * @param {() => CanvasRenderingContext2D | null} deps.getUvCtx
 * @param {() => object | null} deps.getLayout
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {() => object | null} deps.getSelectedEntity
 * @param {() => HTMLElement | null} deps.getStatsEl
 * @param {(u: number, v: number, w: number, h: number) => {x: number, y: number}} deps.uvToScreen
 * @returns {object} { draw, colorForIsland }
 */
export function createDrawTool(state, deps) {
  const {
    getEnabled,
    getUvCanvas,
    getUvCtx,
    getLayout,
    getBodyGeometry,
    getSelectedEntity,
    getStatsEl,
    uvToScreen,
  } = deps;

  // Texture cache (private to the factory). The texture is
  // loaded from the selected entity's mesh material and
  // drawn behind the UV layout when the user switches to
  // "texture" background mode.
  let textureImg = null;
  let textureReady = false;

  /**
   * Compute a stable per-island color from the island's
   * UV-space centroid. Uses a hash of the centroid + index
   * for the hue, fixed saturation + value. The result is
   * deterministic for the same input.
   */
  function colorForIsland(centroidUv, idx) {
    const h = ((centroidUv[0] * 7 + idx * 0.137) % 1 + 1) % 1;
    return hsvToRgb(h, 0.65, 0.95);
  }

  /**
   * Load the texture from the selected entity's mesh
   * material. Called lazily by `drawBackground` when the
   * user switches to "texture" background mode.
   */
  function ensureTextureLoaded() {
    const layout = getLayout();
    const selectedEntity = getSelectedEntity();
    if (!layout || !selectedEntity) return;
    const body = selectedEntity.mesh && selectedEntity.mesh.children && selectedEntity.mesh.children[0];
    if (!body) return;
    const mesh = body.isLOD ? body.levels[0].object : body;
    const tex = mesh && mesh.material && mesh.material.map;
    if (!tex) { textureImg = null; textureReady = false; return; }
    if (tex.image && (tex.image instanceof HTMLImageElement || tex.image instanceof HTMLCanvasElement)) {
      if (tex.image.complete !== false && tex.image.naturalWidth > 0) {
        textureImg = tex.image;
        textureReady = true;
        return;
      }
      textureImg = null;
      textureReady = false;
    }
  }

  function drawBackground(w, h) {
    const uvCtx = getUvCtx();
    if (!uvCtx) return;
    const backgroundMode = state.getBackgroundMode();
    const selectedEntity = getSelectedEntity();
    const uvCanvas = getUvCanvas();
    if (!uvCanvas) return;
    if (backgroundMode === 'texture' && selectedEntity) ensureTextureLoaded();
    const C = UV_EDITOR_CONFIG.colors;
    if (backgroundMode === 'texture' && textureReady && textureImg) {
      const a = uvToScreen(0, 0, w, h);
      const b = uvToScreen(1, 1, w, h);
      uvCtx.save();
      uvCtx.globalAlpha = UV_EDITOR_CONFIG.texture.alpha;
      uvCtx.drawImage(textureImg, a.x, b.y, b.x - a.x, a.y - b.y);
      uvCtx.restore();
    } else {
      const cells = UV_EDITOR_CONFIG.checker.cells;
      const a = uvToScreen(0, 0, w, h);
      const b = uvToScreen(1, 1, w, h);
      const cellW = (b.x - a.x) / cells;
      const cellH = (a.y - b.y) / cells;
      uvCtx.fillStyle = C.checkerBg;
      uvCtx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
      uvCtx.fillStyle = C.checkerAlt;
      for (let yi = 0; yi < cells; yi++) {
        for (let xi = 0; xi < cells; xi++) {
          if ((xi + yi) % 2 === 0) continue;
          uvCtx.fillRect(a.x + xi * cellW, b.y + yi * cellH, cellW, cellH);
        }
      }
    }
  }

  function drawGrid(w, h) {
    const uvCtx = getUvCtx();
    const uvCanvas = getUvCanvas();
    if (!uvCtx || !uvCanvas) return;
    const a = uvToScreen(0, 0, w, h);
    const b = uvToScreen(1, 1, w, h);
    const C = UV_EDITOR_CONFIG.colors;
    const LW = UV_EDITOR_CONFIG.lineWidths;
    uvCtx.strokeStyle = C.gridLine;
    uvCtx.lineWidth = LW.grid;
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const x = a.x + (b.x - a.x) * t;
      uvCtx.beginPath();
      uvCtx.moveTo(x, a.y);
      uvCtx.lineTo(x, b.y);
      uvCtx.stroke();
      const y = a.y + (b.y - a.y) * t;
      uvCtx.beginPath();
      uvCtx.moveTo(a.x, y);
      uvCtx.lineTo(b.x, y);
      uvCtx.stroke();
    }
    uvCtx.strokeStyle = C.gridBorder;
    uvCtx.lineWidth = LW.gridBorder;
    uvCtx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
  }

  function drawLayout(w, h) {
    const layout = getLayout();
    const uvCtx = getUvCtx();
    if (!layout || !uvCtx) return;
    const C = UV_EDITOR_CONFIG.colors;
    const LW = UV_EDITOR_CONFIG.lineWidths;
    const meshWireframe = state.getMeshWireframe();
    const heatmapEnabled = state.getHeatmapEnabled();
    // Face fills (skipped in wireframe mode for a clean
    // mesh view).
    if (!meshWireframe) {
      uvCtx.save();
      for (const island of layout.islands) {
        const [r, g, b] = island.color;
        uvCtx.fillStyle = `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.22)`;
        for (const fi of island.faces) {
          const face = layout.faces[fi];
          const pa = uvToScreen(face.uvA[0], face.uvA[1], w, h);
          const pb = uvToScreen(face.uvB[0], face.uvB[1], w, h);
          const pc = uvToScreen(face.uvC[0], face.uvC[1], w, h);
          if (heatmapEnabled) {
            const geom = getBodyGeometry();
            if (geom) {
              const idxArr = geom.index ? geom.index.array : null;
              const uvArr = geom.attributes.uv.array;
              const ia = idxArr ? idxArr[fi * 3 + 0] : fi * 3 + 0;
              const ib = idxArr ? idxArr[fi * 3 + 1] : fi * 3 + 1;
              const ic = idxArr ? idxArr[fi * 3 + 2] : fi * 3 + 2;
              const ax = geom.attributes.position.getX(ia);
              const ay = geom.attributes.position.getY(ia);
              const az = geom.attributes.position.getZ(ia);
              const bx = geom.attributes.position.getX(ib);
              const by = geom.attributes.position.getY(ib);
              const bz = geom.attributes.position.getZ(ib);
              const cx = geom.attributes.position.getX(ic);
              const cy = geom.attributes.position.getY(ic);
              const cz = geom.attributes.position.getZ(ic);
              const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
              const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
              const nx = e1y * e2z - e1z * e2y;
              const ny = e1z * e2x - e1x * e2z;
              const nz = e1x * e2y - e1y * e2x;
              const area3D = 0.5 * Math.sqrt(nx*nx + ny*ny + nz*nz);
              const au = uvArr[ia*2], av = uvArr[ia*2+1];
              const bu = uvArr[ib*2], bv = uvArr[ib*2+1];
              const cu = uvArr[ic*2], cv = uvArr[ic*2+1];
              const f1x = bu - au, f1y = bv - av;
              const f2x = cu - au, f2y = cv - av;
              const areaUV = 0.5 * Math.abs(f1x * f2y - f1y * f2x);
              const ratio = areaUV > 1e-9 ? area3D / areaUV : 1;
              const s = Math.max(ratio, 1 / Math.max(ratio, 1e-9)) - 1;
              const [hr, hg, hb] = stretchToColor(s);
              uvCtx.fillStyle = `rgba(${hr},${hg},${hb},0.45)`;
            }
          }
          uvCtx.beginPath();
          uvCtx.moveTo(pa.x, pa.y);
          uvCtx.lineTo(pb.x, pb.y);
          uvCtx.lineTo(pc.x, pc.y);
          uvCtx.closePath();
          uvCtx.fill();
        }
      }
      uvCtx.restore();
    }

    // Triangle edges.
    uvCtx.save();
    for (const island of layout.islands) {
      const [r, g, b] = island.color;
      uvCtx.strokeStyle = meshWireframe
        ? C.wireframeEdge
        : `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.85)`;
      uvCtx.lineWidth = meshWireframe ? LW.wireframe : LW.edge;
      uvCtx.beginPath();
      for (const fi of island.faces) {
        const face = layout.faces[fi];
        const pa = uvToScreen(face.uvA[0], face.uvA[1], w, h);
        const pb = uvToScreen(face.uvB[0], face.uvB[1], w, h);
        const pc = uvToScreen(face.uvC[0], face.uvC[1], w, h);
        uvCtx.moveTo(pa.x, pa.y);
        uvCtx.lineTo(pb.x, pb.y);
        uvCtx.lineTo(pc.x, pc.y);
        uvCtx.lineTo(pa.x, pa.y);
      }
      uvCtx.stroke();
    }
    uvCtx.restore();

    // Auto-detected seam edges (red).
    uvCtx.save();
    uvCtx.strokeStyle = C.seamAuto;
    uvCtx.lineWidth = LW.seamAuto;
    uvCtx.beginPath();
    for (const seam of layout.seamEdges) {
      const pa = uvToScreen(seam.uvA[0], seam.uvA[1], w, h);
      const pb = uvToScreen(seam.uvB[0], seam.uvB[1], w, h);
      uvCtx.moveTo(pa.x, pa.y);
      uvCtx.lineTo(pb.x, pb.y);
    }
    uvCtx.stroke();
    uvCtx.restore();

    // User-marked seams (yellow, dashed).
    uvCtx.save();
    uvCtx.strokeStyle = C.seamUser;
    uvCtx.lineWidth = LW.seamUser;
    uvCtx.setLineDash(UV_EDITOR_CONFIG.dashes.seamUser);
    uvCtx.beginPath();
    const userSeamGeom = getBodyGeometry();
    if (userSeamGeom) {
      const uvArr = userSeamGeom.attributes.uv.array;
      for (const sk of state.getSeamKeys()) {
        const [va, vb] = parseEdgeKey(sk);
        if (va == null) continue;
        const au = uvArr[va * 2], av = uvArr[va * 2 + 1];
        const bu = uvArr[vb * 2], bv = uvArr[vb * 2 + 1];
        if (!Number.isFinite(au) || !Number.isFinite(bu)) continue;
        const pa = uvToScreen(au, av, w, h);
        const pb = uvToScreen(bu, bv, w, h);
        uvCtx.moveTo(pa.x, pa.y);
        uvCtx.lineTo(pb.x, pb.y);
      }
    }
    uvCtx.stroke();
    uvCtx.restore();
    uvCtx.setLineDash([]);

    // Vertex dots (suppressed in wireframe mode).
    if (!meshWireframe) {
      uvCtx.save();
      uvCtx.fillStyle = C.vertexDot;
      const r = Math.max(UV_EDITOR_CONFIG.vertices.minDotRadius, UV_EDITOR_CONFIG.vertices.baseDotRadius / state.getZoom());
      for (const uv of layout.uvs) {
        const p = uvToScreen(uv[0], uv[1], w, h);
        uvCtx.beginPath();
        uvCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
        uvCtx.fill();
      }
      uvCtx.restore();
    }
  }

  function drawHover(w, h) {
    const layout = getLayout();
    const uvCtx = getUvCtx();
    if (!layout || !uvCtx) return;
    const C = UV_EDITOR_CONFIG.colors;
    const LW = UV_EDITOR_CONFIG.lineWidths;
    const mode = state.getMode();
    const hoveredFace = state.getHoveredFace();
    const hoveredEdge = state.getHoveredEdge();
    if (hoveredFace != null && mode === 'face') {
      const face = layout.faces[hoveredFace];
      if (face) {
        const pa = uvToScreen(face.uvA[0], face.uvA[1], w, h);
        const pb = uvToScreen(face.uvB[0], face.uvB[1], w, h);
        const pc = uvToScreen(face.uvC[0], face.uvC[1], w, h);
        uvCtx.save();
        uvCtx.fillStyle = 'rgba(72, 219, 251, 0.18)';
        uvCtx.beginPath();
        uvCtx.moveTo(pa.x, pa.y);
        uvCtx.lineTo(pb.x, pb.y);
        uvCtx.lineTo(pc.x, pc.y);
        uvCtx.closePath();
        uvCtx.fill();
        uvCtx.restore();
      }
    }
    if (hoveredEdge && mode === 'edge') {
      const pa = uvToScreen(hoveredEdge.uvA[0], hoveredEdge.uvA[1], w, h);
      const pb = uvToScreen(hoveredEdge.uvB[0], hoveredEdge.uvB[1], w, h);
      uvCtx.save();
      uvCtx.strokeStyle = C.hoverEdge;
      uvCtx.lineWidth = LW.hoverEdge;
      uvCtx.lineCap = 'round';
      uvCtx.beginPath();
      uvCtx.moveTo(pa.x, pa.y);
      uvCtx.lineTo(pb.x, pb.y);
      uvCtx.stroke();
      uvCtx.restore();
    }
  }

  function drawSelection(w, h) {
    const layout = getLayout();
    const uvCtx = getUvCtx();
    if (!layout || !uvCtx) return;
    const C = UV_EDITOR_CONFIG.colors;
    const LW = UV_EDITOR_CONFIG.lineWidths;
    const selectedFaces = state.getSelectedFaces();
    const selectedEdges = state.getSelectedEdges();
    const selectedVertices = state.getSelectedVertices();
    if (selectedFaces.size > 0) {
      uvCtx.save();
      uvCtx.fillStyle = C.selectedFace;
      for (const fi of selectedFaces) {
        const face = layout.faces[fi];
        const pa = uvToScreen(face.uvA[0], face.uvA[1], w, h);
        const pb = uvToScreen(face.uvB[0], face.uvB[1], w, h);
        const pc = uvToScreen(face.uvC[0], face.uvC[1], w, h);
        uvCtx.beginPath();
        uvCtx.moveTo(pa.x, pa.y);
        uvCtx.lineTo(pb.x, pb.y);
        uvCtx.lineTo(pc.x, pc.y);
        uvCtx.closePath();
        uvCtx.fill();
      }
      uvCtx.restore();
    }
    if (selectedEdges.size > 0) {
      uvCtx.save();
      uvCtx.strokeStyle = C.selectedEdge;
      uvCtx.lineWidth = LW.selectedEdge;
      const selGeom = getBodyGeometry();
      if (selGeom) {
        const uvArr = selGeom.attributes.uv.array;
        for (const sk of selectedEdges) {
          const [va, vb] = parseEdgeKey(sk);
          if (va == null) continue;
          const au = uvArr[va * 2], av = uvArr[va * 2 + 1];
          const bu = uvArr[vb * 2], bv = uvArr[vb * 2 + 1];
          if (!Number.isFinite(au) || !Number.isFinite(bu)) continue;
          const pa = uvToScreen(au, av, w, h);
          const pb = uvToScreen(bu, bv, w, h);
          uvCtx.beginPath();
          uvCtx.moveTo(pa.x, pa.y);
          uvCtx.lineTo(pb.x, pb.y);
          uvCtx.stroke();
        }
      }
      uvCtx.restore();
    }
    if (selectedVertices.size > 0) {
      uvCtx.save();
      uvCtx.fillStyle = C.hoverEdge;
      const r = Math.max(UV_EDITOR_CONFIG.selectedVertex.minRadius, UV_EDITOR_CONFIG.selectedVertex.baseRadius / state.getZoom());
      for (const vi of selectedVertices) {
        const uv = layout.uvs[vi];
        if (!uv) continue;
        const p = uvToScreen(uv[0], uv[1], w, h);
        uvCtx.beginPath();
        uvCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
        uvCtx.fill();
      }
      uvCtx.restore();
    }
  }

  function drawBoxSelect(w, h) {
    const boxSelectRect = state.getBoxSelectRect();
    const uvCtx = getUvCtx();
    if (!boxSelectRect || !uvCtx) return;
    const C = UV_EDITOR_CONFIG.colors;
    uvCtx.save();
    uvCtx.strokeStyle = C.boxSelectStroke;
    uvCtx.lineWidth = UV_EDITOR_CONFIG.lineWidths.grid;
    uvCtx.setLineDash(UV_EDITOR_CONFIG.dashes.boxSelect);
    const r = boxSelectRect;
    const x = Math.min(r.x0, r.x1);
    const y = Math.min(r.y0, r.y1);
    const wd = Math.abs(r.x1 - r.x0);
    const hd = Math.abs(r.y1 - r.y0);
    uvCtx.fillStyle = C.boxSelectFill;
    uvCtx.fillRect(x, y, wd, hd);
    uvCtx.strokeRect(x, y, wd, hd);
    uvCtx.restore();
    uvCtx.setLineDash([]);
  }

  function drawSlicePreview(w, h) {
    const uvCtx = getUvCtx();
    if (!uvCtx) return;
    const mode = state.getMode();
    const sliceFirst = state.getSliceFirst();
    if (mode !== 'slice' || !sliceFirst) return;
    const C = UV_EDITOR_CONFIG.colors;
    const sliceSecond = state.getSliceSecond();
    uvCtx.save();
    uvCtx.strokeStyle = C.hoverEdge;
    uvCtx.lineWidth = UV_EDITOR_CONFIG.lineWidths.hoverEdge;
    uvCtx.setLineDash(UV_EDITOR_CONFIG.dashes.seamUser);
    uvCtx.beginPath();
    uvCtx.moveTo(sliceFirst.x, sliceFirst.y);
    uvCtx.lineTo((sliceSecond || sliceFirst).x, (sliceSecond || sliceFirst).y);
    uvCtx.stroke();
    uvCtx.restore();
    uvCtx.setLineDash([]);
  }

  function drawOverlay(w, h) {
    const uvCtx = getUvCtx();
    if (!uvCtx) return;
    uvCtx.save();
    uvCtx.strokeStyle = UV_EDITOR_CONFIG.colors.overlayCross;
    uvCtx.lineWidth = UV_EDITOR_CONFIG.lineWidths.gridBorder;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const p = uvToScreen(u, v, w, h);
      uvCtx.beginPath();
      uvCtx.moveTo(p.x - 5, p.y);
      uvCtx.lineTo(p.x + 5, p.y);
      uvCtx.moveTo(p.x, p.y - 5);
      uvCtx.lineTo(p.x, p.y + 5);
      uvCtx.stroke();
    }
    uvCtx.restore();
  }

  /**
   * Main draw entry point. Called by the render loop via
   * `requestAnimationFrame`. Draws the background, grid,
   * layout, seams (via drawLayout), selection, hover,
   * box-select, slice preview, and overlay. Also updates
   * the stats line with the current island/face/vertex
   * count, seam count, pack efficiency, selection size,
   * and mode.
   */
  function draw() {
    if (!getEnabled()) return;
    const uvCanvas = getUvCanvas();
    const uvCtx = getUvCtx();
    if (!uvCanvas || !uvCtx) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = uvCanvas.width / dpr;
    const h = uvCanvas.height / dpr;
    uvCtx.fillStyle = UV_EDITOR_CONFIG.colors.bg;
    uvCtx.fillRect(0, 0, w, h);
    drawBackground(w, h);
    drawGrid(w, h);
    drawLayout(w, h);
    drawSelection(w, h);
    drawHover(w, h);
    drawBoxSelect(w, h);
    drawSlicePreview(w, h);
    drawOverlay(w, h);
    const statsEl = getStatsEl();
    const layout = getLayout();
    if (statsEl) {
      if (layout) {
        const islandCount = layout.islands.length;
        const seamCount = layout.seamEdges.length;
        const selectedFaces = state.getSelectedFaces();
        const selectedEdges = state.getSelectedEdges();
        const selectedVertices = state.getSelectedVertices();
        const selCount = selectedFaces.size + selectedEdges.size + selectedVertices.size;
        // Pack efficiency: sum of island bounding-box UV
        // areas / 1 (the unit square). Clamped to [0, 1].
        // This is an upper bound on the true efficiency
        // (the boxes can overlap; the packer minimizes
        // overlap via grid layout) but it's a useful
        // "how much of the UV space am I using" metric.
        const packEff = computePackEfficiency(layout);
        const mode = state.getMode();
        statsEl.textContent =
          `${islandCount} island${islandCount === 1 ? '' : 's'} \u00b7 ` +
          `${layout.faceCount} tris \u00b7 ${layout.vertexCount} verts \u00b7 ` +
          `${seamCount} seam${seamCount === 1 ? '' : 's'} \u00b7 ` +
          `pack: ${(packEff * 100).toFixed(0)}% \u00b7 ` +
          `sel: ${selCount} \u00b7 mode: ${mode}`;
      } else {
        statsEl.textContent = 'Click an asteroid in the 3D view';
      }
    }
  }

  return { draw, colorForIsland };
}
