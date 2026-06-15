/**
 * Public surface of the `src/systems/uv-tools/` subdirectory.
 * Consumers should import from `./uv-tools/index.js` rather
 * than reaching into the individual files.
 *
 * Owns:
 *   - `UV_EDITOR_CONFIG`           — the editor's tunables
 *   - geometry math (point/segment/triangle distances, 2D
 *     orientation + segment-crossing tests, HSV → RGB, pack
 *     efficiency)
 *   - 2D affine transform matrix builders (rotate, scale,
 *     mirror, flip U/V, snap-to-grid)
 *
 * Note: `orient2D` was an alias for `orient` and was dropped
 * in 2026 — callers should import `orient` directly.
 */

// Editor configuration (colors, line widths, snap step, …).
export { UV_EDITOR_CONFIG } from './config.js';

// Pure 2D geometry math.
export {
  pointToSegmentDist,
  pointToTriangleDist,
  orient,
  segmentsCross,
  hsvToRgb,
  computePackEfficiency,
} from './geometry-utils.js';

// Pure 2D affine transform matrix builders.
export {
  rotationMatrix,
  scaleMatrix,
  mirrorMatrix,
  flipUMatrix,
  flipVMatrix,
  snapToGrid,
} from './transforms.js';

// Editor state factory. Owns the editor's mutable state
// (mode, selections, seam keys, solver mode, visual toggles)
// and exposes it through a single object with getter/setter
// methods + change notifications. The orchestrator delegates
// to this factory instead of holding inline `let` variables.
export { createEditorState } from './editor-state.js';

// Tool factories. Each tool takes the editor state + a small
// `deps` object (getBodyGeometry, scheduleDraw, etc.) and
// returns the public tool methods. Splitting tools into
// one-file-per-tool is the next step; these are the
// first batch (state + transforms + clear-seams + frame +
// slice + view-toggles + translate + boundary-seams +
// re-unwrap + auto-unwrap + smart-unwrap + seam-3d +
// unwrap-io).
export { createTransformTools } from './transform-tools.js';
export { createClearSeamsTool } from './clear-seams.js';
export { createFrameTool } from './frame.js';
export { createSliceTool } from './slice.js';
export { createViewToggles } from './view-toggles.js';
export { createTranslateTool } from './translate.js';
export { createBoundarySeamsTool } from './boundary-seams.js';
export { createReUnwrapTool } from './re-unwrap.js';
export { createAutoUnwrapTool } from './auto-unwrap.js';
export { createSmartUnwrapTool } from './smart-unwrap.js';
export { createSeam3DToggleTool } from './seam-3d.js';
export { createUnwrapIO } from './unwrap-io.js';
export { createSelectionTools } from './selection-tools.js';
export { createPickAtPixelTool } from './pick-at-pixel.js';
export { createDrawTool } from './draw.js';
export { createPick3DTool } from './pick-3d.js';
export { createPanelWindowTool } from './panel-window.js';
export { createComputeLayoutTool } from './compute-layout.js';
export { createHotkeysTool } from './hotkeys.js';

// Shared unwrap result helper (used by re-unwrap, auto-unwrap,
// smart-unwrap, and the start-unwrap button). Factored out
// to avoid duplicating the same apply+notify skeleton in each
// tool file.
export { applyUnwrapResult, applyUnwrapAndNotify } from './unwrap-result.js';
