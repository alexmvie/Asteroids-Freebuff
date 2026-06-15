/**
 * Pick-at-pixel tool factory for the UV editor.
 *
 * Owns the 2D canvas picking logic. Given a pixel
 * coordinate, returns the face/edge/vertex under the
 * cursor (or null). Mode-aware: in edge mode the edge
 * tolerance is widened to make seam-marking easier.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const tool = createPickAtPixelTool(state, deps);
 *   const hit = tool.pickAtPixel(px, py, w, h);
 */

import { UV_EDITOR_CONFIG } from './config.js';
import {
  pointToSegmentDist,
  pointToTriangleDist,
} from './geometry-utils.js';
import { buildEdgeKey } from '../../geometry/uv-unwrapping.js';

/**
 * Create the pick-at-pixel tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => object | null} deps.getLayout
 * @param {(u: number, v: number, w: number, h: number) => {x: number, y: number}} deps.uvToScreen
 * @returns {object} { pickAtPixel }
 */
export function createPickAtPixelTool(state, deps) {
  const { getLayout, uvToScreen } = deps;

  /**
   * Find the face/edge/vertex under the given pixel
   * coordinate. Returns `{ kind: 'face', faces: [fi] }`,
   * `{ kind: 'edge', key, uvA, uvB, va, vb }`,
   * `{ kind: 'vertex', index }`, or null.
   *
   * Face hits use the centroid distance; vertex hits use
   * point distance; edge hits use point-to-segment
   * distance. In edge mode the edge tolerance is widened
   * by 1.5x so seam-marking (1px lines) is easier.
   *
   * Edge keys are VERTEX-edge keys (buildEdgeKey format),
   * not UV-edge keys — this is the same key used for seam
   * storage, so a clicked edge matches a marked seam
   * 1:1 regardless of the current UVs.
   */
  function pickAtPixel(px, py, w, h) {
    const layout = getLayout();
    if (!layout) return null;
    const tol = UV_EDITOR_CONFIG.hitTolerance;
    const mode = state.getMode();
    // Mode-aware pick order. The default order (face → vertex
    // → edge) makes sense in face/island mode where the user
    // wants to grab a face. In vertex mode, vertices live
    // INSIDE faces, so the face hit would always win and the
    // user would never be able to select (and therefore move)
    // a vertex — even though they're in vertex mode. The
    // user reported: "i cannot move selected vertices" — the
    // root cause was that click events in vertex mode were
    // returning face hits, so `selectedVertices` stayed empty
    // and the drag translated whatever was already selected
    // (usually the previously-selected face, or nothing).
    // Same problem in edge mode for edge hits (1px lines are
    // hard to aim at; the face would always win). The fix is
    // to invert the pick order based on the current mode:
    // vertex mode → try vertex FIRST; edge mode → try edge
    // FIRST; otherwise the existing face-first order.
    if (mode === 'vertex') {
      let bestVert = -1, bestVertDist = tol.vertex * tol.vertex;
      for (let vi = 0; vi < layout.uvs.length; vi++) {
        const p = uvToScreen(layout.uvs[vi][0], layout.uvs[vi][1], w, h);
        const dx = p.x - px, dy = p.y - py;
        const d = dx*dx + dy*dy;
        if (d < bestVertDist) { bestVertDist = d; bestVert = vi; }
      }
      if (bestVert >= 0) {
        return { kind: 'vertex', index: bestVert };
      }
      // No vertex within tolerance — fall through to face so
      // the user can still select a face and start a box-select.
    }
    if (mode === 'edge') {
      // Edge mode also inverts: try edge first, with the
      // 1.5× widened tolerance so the user can actually
      // hit the 1px lines.
      const edgeTol = tol.edge * 1.5;
      let bestEdge = null, bestEdgeDist = edgeTol * edgeTol;
      const seen = new Set();
      for (const island of layout.islands) {
        for (const fi of island.faces) {
          const face = layout.faces[fi];
          const uvs = [face.uvA, face.uvB, face.uvC];
          const verts = [face.a, face.b, face.c];
          for (let i = 0; i < 3; i++) {
            const uvA = uvs[i];
            const uvB = uvs[(i + 1) % 3];
            const va = verts[i];
            const vb = verts[(i + 1) % 3];
            const k = buildEdgeKey(va, vb);
            if (seen.has(k)) continue;
            seen.add(k);
            const pa = uvToScreen(uvA[0], uvA[1], w, h);
            const pb = uvToScreen(uvB[0], uvB[1], w, h);
            const d = pointToSegmentDist(px, py, pa, pb);
            if (d < bestEdgeDist) {
              bestEdge = { kind: 'edge', key: k, uvA, uvB, va, vb };
            }
          }
        }
      }
      if (bestEdge) return bestEdge;
      // No edge within tolerance — fall through to face.
    }
    // Default (face / island mode) and the fall-through
    // cases: face first, then vertex, then edge.
    let bestFace = -1, bestDist = tol.face * tol.face;
    for (const island of layout.islands) {
      for (const fi of island.faces) {
        const face = layout.faces[fi];
        const pa = uvToScreen(face.uvA[0], face.uvA[1], w, h);
        const pb = uvToScreen(face.uvB[0], face.uvB[1], w, h);
        const pc = uvToScreen(face.uvC[0], face.uvC[1], w, h);
        const d = pointToTriangleDist(px, py, pa, pb, pc);
        if (d < bestDist) { bestDist = d; bestFace = fi; }
      }
    }
    if (bestFace >= 0) {
      return { kind: 'face', faces: [bestFace] };
    }
    // Try vertex (in face mode, if the click was just outside
    // any face's tolerance but still near a vertex).
    let bestVert = -1, bestVertDist = tol.vertex * tol.vertex;
    for (let vi = 0; vi < layout.uvs.length; vi++) {
      const p = uvToScreen(layout.uvs[vi][0], layout.uvs[vi][1], w, h);
      const dx = p.x - px, dy = p.y - py;
      const d = dx*dx + dy*dy;
      if (d < bestVertDist) { bestVertDist = d; bestVert = vi; }
    }
    if (bestVert >= 0) {
      return { kind: 'vertex', index: bestVert };
    }
    // Try edge. In face mode the default tolerance is used
    // (no 1.5× widening — the user is not in seam-marking
    // mode, so the click is probably genuinely on a face
    // boundary).
    const edgeTol = tol.edge;
    let bestEdge = null, bestEdgeDist = edgeTol * edgeTol;
    const seen = new Set();
    for (const island of layout.islands) {
      for (const fi of island.faces) {
        const face = layout.faces[fi];
        const uvs = [face.uvA, face.uvB, face.uvC];
        const verts = [face.a, face.b, face.c];
        for (let i = 0; i < 3; i++) {
          const uvA = uvs[i];
          const uvB = uvs[(i + 1) % 3];
          const va = verts[i];
          const vb = verts[(i + 1) % 3];
          const k = buildEdgeKey(va, vb);
          if (seen.has(k)) continue;
          seen.add(k);
          const pa = uvToScreen(uvA[0], uvA[1], w, h);
          const pb = uvToScreen(uvB[0], uvB[1], w, h);
          const d = pointToSegmentDist(px, py, pa, pb);
          if (d < bestEdgeDist) {
            bestEdge = { kind: 'edge', key: k, uvA, uvB, va, vb };
          }
        }
      }
    }
    return bestEdge;
  }

  return { pickAtPixel };
}
