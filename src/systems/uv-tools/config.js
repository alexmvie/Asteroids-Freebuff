/**
 * UV editor configuration — the single source of truth for
 * all tunable values in the UV editor.
 *
 * @fileoverview Previously inlined in `src/systems/uv-unwrap-viewer.js`
 * (the 106K char god-function). Extracted to its own file so the
 * editor has a clean SSOT for its tunables and the orchestrator
 * can shrink.
 *
 *   - `snap.*`        grid-snap step (UV units)
 *   - `hitTolerance.*` per-mode pixel tolerance for 2D pick (face/vertex/edge)
 *   - `zoom.*`        min / max / wheel-factor for the 2D pan/zoom
 *   - `panel.*`       min width / height (px) for the draggable panel
 *   - `persistenceKey` localStorage key for the panel's saved rect
 *   - `colors.*`      2D canvas stroke / fill / highlight colors
 *   - `lineWidths.*`  per-element stroke widths (px)
 *   - `dashes.*`      line-dash patterns (for seams / box-select)
 */

export const UV_EDITOR_CONFIG = {
  snap: { step: 0.05 },
  hitTolerance: {
    face: 12,    // px — face click area (triangle proximity)
    vertex: 12,  // px — vertex click area (was 8; bumped so the
                 //   user can grab a vertex for slight adjustments
                 //   without pixel-perfect aim)
    edge: 10,    // px — edge click area (was 5; too small to hit)
  },
  zoom: {
    min: 0.05,   // much wider range than the old [0.2, 40]
    max: 200,
    factor: 0.0015, // wheel sensitivity (exp curve)
  },
  panel: {
    minWidth: 360,
    minHeight: 320,
    viewportPaddingX: 40,
    viewportPaddingY: 40,
  },
  // Live re-unwrap: when ON, seam changes (2D or 3D) trigger a
  // debounced re-unwrap + repack so the UV layout stays in sync
  // with the seam set. When OFF, the user presses W (or clicks
  // UNWRAP) to apply. Default ON (Blender-style "Live Unwrap").
  liveUnwrap: {
    debounceMs: 200,
  },
  // Auto-seam detection (dihedral angle). 1° is the most
  // aggressive default and works for the NOISIEST asteroid
  // geometry (the per-vertex jitter at 15% of radius still
  // produces > 1° dihedrals on most internal edges). 5° was
  // too conservative — it missed too many noise ridges and
  // left the capsule as a single island. 30° (the old default)
  // only caught hard-surface creases. Both are user-adjustable
  // in the START UNWRAP panel. If the dihedral-only detection
  // still returns 0 seams (very smooth meshes), the START
  // UNWRAP button falls back to a shape-aware strategy
  // (capsule cap-body junction detection — always 90° for the
  // capsule body).
  auto: {
    thresholdDeg: 3,
  },
  // START UNWRAP button — one-click best unwrap. The cascade
  // stops at the first solver that beats `stretchBudget` (30×
  // — "be strict, stop as soon as something is good enough").
  // If the cascade's best is still above `fallbackStretch`
  // (80× — "try harder than the cascade gives up at"), the
  // function falls back to `smart-uv-project` (abf++ with
  // auto-seam) for a guaranteed result on closed meshes like
  // the capsule. The two are independent: the cascade is
  // opportunistic (low budget), the fallback is the last
  // resort (high budget).
  startUnwrap: {
    stretchBudget: 30,
    fallbackStretch: 80,
    // Pack margin (UV units of whitespace between packed
    // islands). Lower = tighter packing (more efficient use
    // of the texture atlas, but islands can touch), higher
    // = more breathing room (less efficient but clearer to
    // see the islands in the UV view). 0.04 = 4% on each
    // side, the production default.
    packMargin: 0.04,
    // Target island count (0 = disabled, use auto-seam as-is).
    // When > 0, runStartUnwrap enforces the target after the
    // auto-seam step: if too many seams, drop the weakest by
    // dihedral; if too few, split the largest island along its
    // sharpest internal edge. Default 0 to preserve the
    // previous behavior — the user opts in by setting it.
    targetIslandCount: 0,
    // Min / max for the START UNWRAP panel number inputs.
    // Clamped in the panel's `change` handler so out-of-range
    // values silently snap to the closest valid number.
    range: {
      thresholdDeg:    { min: 1, max: 90 },
      packMargin:      { min: 0, max: 0.2 },
      stretchBudget:   { min: 5, max: 500 },
      targetIslandCount: { min: 0, max: 16 },
    },
  },
  persistenceKey: 'uvViewerRect',
  colors: {
    bg:              '#0a0a14',
    checkerBg:       '#1a1a2e',
    checkerAlt:      '#232336',
    gridLine:        'rgba(72, 219, 251, 0.15)',
    gridBorder:      'rgba(72, 219, 251, 0.5)',
    vertexDot:       'rgba(230, 237, 246, 0.7)',
    seamAuto:        '#ff3344',
    seamUser:        '#ffeb3b',
    hoverEdge:       '#48dbfb',
    selectedEdge:    '#ffeb3b',
    selectedFace:    'rgba(72, 219, 251, 0.35)',
    boxSelectStroke: 'rgba(72, 219, 251, 0.8)',
    boxSelectFill:   'rgba(72, 219, 251, 0.08)',
    overlayCross:    'rgba(72, 219, 251, 0.85)',
    wireframeEdge:   'rgba(72, 219, 251, 0.9)',
  },
  lineWidths: {
    edge: 1,
    seamAuto: 2,
    seamUser: 2.5,
    selectedEdge: 3,
    hoverEdge: 4,
    wireframe: 2,
    grid: 1,
    gridBorder: 1.5,
  },
  dashes: {
    seamUser: [6, 3],
    boxSelect: [4, 4],
  },
  checker: {
    cells: 20,
  },
  vertices: {
    minDotRadius: 1,
    baseDotRadius: 1.5,
  },
  selectedVertex: {
    minRadius: 3,
    baseRadius: 4,
  },
  texture: {
    alpha: 0.45,
  },
  panelHeaderDrag: {
    keepOnScreenHeight: 32,
    keepOnScreenWidth: 80,
  },
  fileDownload: {
    revokeTimeoutMs: 1000,
  },
};
