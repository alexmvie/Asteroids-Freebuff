import {
  buildEdgeKey,
  parseEdgeKey,
  reunwrap,
  computeStretch,
  stretchToColor,
  detectIslands,
  autoDetectSeams,
  computeAllDihedrals,
  walkEdgeLoop,
} from '../geometry/uv-unwrapping.js';
import {
  solveWith,
  solveAutomatic,
  SOLVER_IDS,
  SOLVER_LABELS,
  SOLVER_DESCRIPTIONS,
} from '../geometry/uv-solvers.js';
import {
  UV_EDITOR_CONFIG,
  segmentsCross,
  createEditorState,
  applyUnwrapResult,
  applyUnwrapAndNotify,
  createTransformTools,
  createClearSeamsTool,
  createFrameTool,
  createSliceTool,
  createViewToggles,
  createTranslateTool,
  createBoundarySeamsTool,
  createReUnwrapTool,
  createAutoUnwrapTool,
  createSmartUnwrapTool,
  createSeam3DToggleTool,
  createUnwrapIO,
  createSelectionTools,
  createPickAtPixelTool,
  createDrawTool,
  createPick3DTool,
  createPanelWindowTool,
  createComputeLayoutTool,
  createHotkeysTool,
} from './uv-tools/index.js';

// UV_EDITOR_CONFIG and the geometry/transform helpers are now
// imported from `./uv-tools/` (extracted in 2026 to shrink this
// 2735-line orchestrator). The full per-tool split
// (one-file-per-tool with factory pattern) is deferred to a
// future turn — see SPEC.md §13 / AGENTS.md followups.

/**
 * UV Unwrap Editor — a 3ds-Max-style UV editor in a floating,
 * draggable, resizable side panel.
 *
 * Extends the read-only viewer with:
 *   - **Draggable + resizable panel** (header is the drag handle,
 *     bottom-right corner is the resize grip).
 *   - **Selection**: click a face / edge / vertex in the 2D
 *     canvas to select. Shift+click to add. Box-select by
 *     dragging on empty space.
 *   - **Translate**: drag the selection to move it. Grid snap
 *     (default ON, snap to 0.05) is applied.
 *   - **Rotate / scale / mirror / flip**: hotkeys R, S, M, U, V
 *     (and toolbar buttons). All transforms are around the
 *     selection's centroid.
 *   - **Stretch heatmap**: per-face stretch (3D area / UV area)
 *     color-coded green→yellow→red. Toggled with H.
 *   - **Seam marking**: click an edge in the 2D canvas to mark
 *     / unmark it as a UV seam. Default mode is "seam" (the
 *     most useful for the user's current task: fixing the
 *     capsule's bad unwrap).
 *   - **Re-unwrap**: with seams marked, press W (or click
 *     "UNWRAP") to compute a Tutte embedding for each island
 *     and pack into [0, 1]². The new UVs are written to the
 *     geometry's `uv` attribute and pushed to the GPU live.
 *   - **Save / load JSON**: download the current UV attribute
 *     and seam set as a JSON file; load it back.
 *
 * Mode toggles (in the toolbar):
 *   - 1 / FACE  → face mode (default)
 *   - 2 / EDGE  → edge mode (click edges to mark/unmark seams)
 *   - 3 / VERT  → vertex mode
 *
 * Hotkeys (work whenever the panel is open):
 *   - 1/2/3: mode (face/edge/vertex)
 *   - R: rotate +15° around centroid
 *   - S: scale × 1.1 around centroid
 *   - Shift+S: scale × 0.9 around centroid
 *   - M: mirror across U=V diagonal
 *   - U: flip U axis
 *   - V: flip V axis
 *   - H: toggle stretch heatmap
 *   - G: toggle grid snap
 *   - W: re-unwrap with current seams
 *   - Esc: clear selection
 *
 * 3D selection (unchanged from the viewer):
 *   - Hover an asteroid body → yellow emissive highlight
 *   - Click an asteroid body → load its UV into the editor
 *
 * Lifecycle:
 *   - Created once at boot. `setEnabled(true)` mounts the panel;
 *     `setEnabled(false)` unmounts. The 3D canvas listeners are
 *     only active while enabled.
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   camera: THREE.Camera,
 *   getAsteroids: () => Array<{ mesh: THREE.Group, dispose: Function }>,
 * }} opts
 */
export function createUvUnwrapViewer({ canvas, camera, getAsteroids }) {
  if (!canvas) throw new Error('createUvUnwrapViewer: `canvas` is required');
  if (!camera) throw new Error('createUvUnwrapViewer: `camera` is required');
  if (typeof getAsteroids !== 'function') {
    throw new Error('createUvUnwrapViewer: `getAsteroids` is required');
  }

  // ---- State ------------------------------------------------------------
  // The orchestrator's `let` variables below are the single
  // source of truth. The `state` object (built further down)
  // is a thin getter/setter interface over them — it doesn't
  // own its own state, it just delegates to closures over
  // these `let` variables. This keeps the inline code below
  // and the tool factories in sync automatically.

  let panelEl = null;
  let uvCanvas = null;
  let uvCtx = null;
  let rafHandle = null;
  let enabled = false;
  let layout = null; // for the currently selected body
  let cachedSeamKeys = new Set();
  let textureImg = null;
  let textureReady = false;
  let selectedEntity = null;
  let hoveredEntity = null;
  let panX = 0, panY = 0, zoom = 1;
  let backgroundMode = 'checker';
  // Whether the advanced tools section (the '...' button's
  // revealed row) is currently shown. Persisted across
  // mount/unmount so the user's choice is remembered when the
  // editor is closed and re-opened in the same session.
  let advancedOpen = false;
  // START UNWRAP panel — adjustable parameters that drive
  // the cascade. Read at the moment runStartUnwrap is invoked
  // so the user can tweak them between presses. Defaults come
  // from UV_EDITOR_CONFIG (so the editor's behavior is
  // consistent across runs).
  let autoSeamEnabled = true;
  let autoSeamThreshold = UV_EDITOR_CONFIG.auto.thresholdDeg;
  let packMargin = UV_EDITOR_CONFIG.startUnwrap.packMargin;
  let stretchBudget = UV_EDITOR_CONFIG.startUnwrap.stretchBudget;
  // Target island count (0 = disabled). When > 0, runStartUnwrap
  // enforces the target after the auto-seam step: too many
  // seams → drop the weakest by dihedral; too few → split the
  // largest island along its sharpest internal edge. Mirrors
  // Blender's "Smart UV Project" target-count input.
  let targetIslandCount = UV_EDITOR_CONFIG.startUnwrap.targetIslandCount;
  // Smart Unwrap state: which solver mode (auto / expert) and
  // which solver is selected in the expert dropdown. 'auto' runs
  // the cascade; 'expert' uses the explicit solverId.
  let solverMode = 'auto';
  let expertSolverId = 'square-tutte';

  // Editor state
  let mode = 'face'; // 'face' | 'edge' | 'vertex' | 'island' | 'slice'
  let selectedFaces = new Set();
  let selectedEdges = new Set();
  let selectedVertices = new Set();
  let boxSelectRect = null; // {x0, y0, x1, y1} in canvas pixels
  // Slice tool: click two points in 2D, all edges the line
  // crosses become seams. The first click sets `sliceFirst`;
  // the second click executes the slice and exits slice mode.
  // The line is previewed between the two clicks so the user
  // can see what they're about to cut.
  let sliceFirst = null; // {x, y} in canvas CSS pixels or null
  let sliceSecond = null; // ditto
  let snapEnabled = true;
  let heatmapEnabled = false;
  let meshWireframe = false; // wireframe-only overlay (skips face fills)
  let seamKeys = new Set(); // user-marked seams (UV-edge keys)
  let liveUnwrapEnabled = true; // LIVE button in toolbar — default ON
  let liveUnwrapTimer = null; // debounce handle for the live re-unwrap
  const seamChangeListeners = new Set(); // callbacks for 3D overlay + status updates
  // Drag state shared by the 2D-canvas pointer handlers
  // (pan/translate/box-select) AND the panel-window tool
  // (panel drag/resize). Both sides write directly to these
  // `let` variables — the factory uses the `setDragging` /
  // `setDragStart` dep callbacks, and the 2D-canvas handlers
  // use direct assignment. Either mechanism works because
  // `let` is captured by reference; the inconsistency is
  // documented here for future maintainers.
  let dragging = null; // 'pan' | 'translate' | 'box' | 'panel' | 'resize'
  let dragStart = null;
  let hoveredEdge = null; // { kind: 'edge', key, uvA, uvB } or null
  let hoveredFace = null; // face index or null

  // ---- Editor state interface -------------------------------------------
  // `createEditorState` is a thin getter/setter wrapper: it
  // takes a bindings object (with closures over the
  // orchestrator's inline `let` variables above) and returns
  // a state object whose reads/writes delegate to those
  // bindings. This keeps the orchestrator's `let` variables
  // and the tool factories in sync automatically — no
  // parallel state, no drift, no manual sync layer.
  const state = createEditorState({
    // Mode
    getMode: () => mode,
    setMode: (m) => { mode = m; },

    // Selections (returned by ref — callers mutate in place)
    getSelectedFaces: () => selectedFaces,
    getSelectedEdges: () => selectedEdges,
    getSelectedVertices: () => selectedVertices,
    clearSelections: () => {
      selectedFaces.clear();
      selectedEdges.clear();
      selectedVertices.clear();
    },

    // Box-select rect
    getBoxSelectRect: () => boxSelectRect,
    setBoxSelectRect: (r) => { boxSelectRect = r; },

    // 2D view camera (pan/zoom)
    getZoom: () => zoom,
    setZoom: (z) => { zoom = z; },
    getPanX: () => panX,
    setPanX: (x) => { panX = x; },
    getPanY: () => panY,
    setPanY: (y) => { panY = y; },

    // Slice tool endpoints
    getSliceFirst: () => sliceFirst,
    getSliceSecond: () => sliceSecond,
    setSliceFirst: (p) => { sliceFirst = p; },
    setSliceSecond: (p) => { sliceSecond = p; },
    clearSlice: () => { sliceFirst = null; sliceSecond = null; },

    // Visual toggles
    getSnapEnabled: () => snapEnabled,
    setSnapEnabled: (v) => { snapEnabled = v; },
    getHeatmapEnabled: () => heatmapEnabled,
    setHeatmapEnabled: (v) => { heatmapEnabled = v; },
    getMeshWireframe: () => meshWireframe,
    setMeshWireframe: (v) => { meshWireframe = v; },
    getBackgroundMode: () => backgroundMode,
    setBackgroundMode: (m) => { backgroundMode = m; },

    // Seams
    getSeamKeys: () => seamKeys,
    setSeamKeys: (s) => { seamKeys = s; },
    clearSeamKeys: () => { seamKeys.clear(); },

    // Live re-unwrap toggle
    getLiveUnwrapEnabled: () => liveUnwrapEnabled,
    setLiveUnwrapEnabled: (v) => { liveUnwrapEnabled = v; },

    // Solver mode + expert pick
    getSolverMode: () => solverMode,
    setSolverMode: (m) => { solverMode = m; },
    getExpertSolverId: () => expertSolverId,
    setExpertSolverId: (id) => { expertSolverId = id; },

    // START UNWRAP panel — read at the moment runStartUnwrap
    // is invoked, so the user can tweak between presses.
    getAutoSeamEnabled: () => autoSeamEnabled,
    setAutoSeamEnabled: (v) => { autoSeamEnabled = !!v; },
    getAutoSeamThreshold: () => autoSeamThreshold,
    setAutoSeamThreshold: (v) => {
      const r = UV_EDITOR_CONFIG.startUnwrap.range.thresholdDeg;
      autoSeamThreshold = Math.max(r.min, Math.min(r.max, Number(v) || r.min));
    },
    getPackMargin: () => packMargin,
    setPackMargin: (v) => {
      const r = UV_EDITOR_CONFIG.startUnwrap.range.packMargin;
      packMargin = Math.max(r.min, Math.min(r.max, Number(v) || 0));
    },
    getStretchBudget: () => stretchBudget,
    setStretchBudget: (v) => {
      const r = UV_EDITOR_CONFIG.startUnwrap.range.stretchBudget;
      stretchBudget = Math.max(r.min, Math.min(r.max, Number(v) || r.min));
    },
    getTargetIslandCount: () => targetIslandCount,
    setTargetIslandCount: (v) => {
      const r = UV_EDITOR_CONFIG.startUnwrap.range.targetIslandCount;
      const n = Math.round(Number(v) || 0);
      targetIslandCount = Math.max(r.min, Math.min(r.max, n));
    },

    // Hover state
    getHoveredEdge: () => hoveredEdge,
    setHoveredEdge: (e) => { hoveredEdge = e; },
    getHoveredFace: () => hoveredFace,
    setHoveredFace: (f) => { hoveredFace = f; },
  });

  // ---- Tool factories --------------------------------------------------
  // The transform tools factory takes the editor state + deps
  // (getBodyGeometry, scheduleDraw, etc.) and returns the
  // public transform methods. The factory's internal
  // `applyTransform` helper handles the centroid computation,
  // snap, and UV update — the orchestrator no longer owns
  // those details. The factory is instantiated after the
  // state and helper closures so it can capture them.
  // parseEdgeKey is imported from uv-unwrapping.js (not from
  // uv-tools/) to keep the dependency explicit.
  const transforms = createTransformTools(state, {
    getBodyGeometry, // defined later in this file
    scheduleDraw,    // defined later in this file
    parseEdgeKey,    // imported at the top of this file
    onAfterApply: recomputeLayout,
  });

  // The clear-seams tool factory wraps the `clearSeams()`
  // method. The orchestrator no longer needs to implement
  // the body of clearSeams inline. `getStatsEl` is a getter
  // (not a value) because `statsEl` is set in `mount()`,
  // after the factory is instantiated — calling
  // `getStatsEl()` at `clearSeams()` time gives us the
  // late-bound value.
  const clearSeamsTool = createClearSeamsTool(state, {
    getStatsEl: () => statsEl, // statsEl is set in mount()
    scheduleDraw,
    notifySeamChange, // defined later in this file
  });

  // The frame tool: fits the 2D camera (pan + zoom) to the
  // current selection's UV bounding box. Reads/writes
  // zoom/pan via the state interface.
  const frameTool = createFrameTool(state, {
    getLayout: () => layout,
    getUvCanvas: () => uvCanvas,
    getBodyGeometry,
    parseEdgeKey,
    scheduleDraw,
    getStatsEl: () => statsEl,
  });

  // The slice tool: two-click cut that marks every crossed
  // edge as a seam. `setMode` is the orchestrator's setMode
  // (which updates the toolbar + scheduleDraw).
  const sliceTool = createSliceTool(state, {
    getLayout: () => layout,
    getBodyGeometry,
    getUvCanvas: () => uvCanvas,
    screenToUv, // defined later in this file
    buildEdgeKey, // imported at the top of this file
    segmentsCross, // imported at the top of this file
    scheduleDraw,
    getStatsEl: () => statsEl,
    notifySeamChange,
    setMode: (m) => setMode(m), // forward to the orchestrator's setMode
  });

  // The view-toggles factory: heatmap, wireframe, live
  // re-unwrap. `getToolsEl` is a getter because toolsEl is
  // set in mount().
  const viewToggles = createViewToggles(state, {
    scheduleDraw,
    getStatsEl: () => statsEl,
    getToolsEl: () => toolsEl,
    notifySeamChange,
  });

  // The translate tool: applies (du, dv) to the selected
  // vertices' UVs. `onAfterTranslate` recomputes the layout
  // for re-rendering.
  const translateTool = createTranslateTool(state, {
    getBodyGeometry,
    parseEdgeKey,
    scheduleDraw,
    onAfterTranslate: recomputeLayout,
  });

  // The boundary-seams tool: marks every island boundary
  // edge as a seam.
  const boundarySeamsTool = createBoundarySeamsTool(state, {
    getLayout: () => layout,
    getBodyGeometry,
    buildEdgeKey,
    parseEdgeKey,
    scheduleDraw,
    getStatsEl: () => statsEl,
    notifySeamChange,
  });

  // The re-unwrap tool: re-computes the UV layout using the
  // current seam set and writes the new UVs to the geometry.
  // Uses `notifySeamChangeKeepResult` (not `notifySeamChange`)
  // so the live re-unwrap timer doesn't fire right after and
  // overwrite the just-applied result with a Tutte re-solve.
  // (This also breaks the previous infinite-loop in
  // re-unwrap → notifySeamChange → scheduleLiveUnwrap →
  // re-unwrap, which fired every debounceMs forever.)
  const reUnwrapTool = createReUnwrapTool(state, {
    getBodyGeometry,
    reunwrap, // imported at the top of this file
    scheduleDraw,
    notifySeamChange: notifySeamChangeKeepResult,
    onAfterApply: recomputeLayout,
  });

  // The auto-unwrap tool: auto-detects seams by dihedral
  // angle, adds them to seamKeys, then calls reunwrap
  // directly (no cross-tool dep on reUnwrapTool). Same
  // "keep result, don't re-unwrap" rationale as re-unwrap
  // and smart-unwrap — the just-applied unwrap is the
  // intentional result, the live debounce would clobber it.
  const autoUnwrapTool = createAutoUnwrapTool(state, {
    getBodyGeometry,
    autoDetectSeams, // imported at the top of this file
    reunwrap, // imported at the top of this file
    scheduleDraw,
    getStatsEl: () => statsEl,
    notifySeamChange: notifySeamChangeKeepResult,
    onAfterApply: recomputeLayout,
  });

  // The smart-unwrap tool: one-click cascade that auto-picks
  // the best solver (Auto mode) or uses the solver from the
  // dropdown (Expert mode). Same "keep result" rationale —
  // the user's carefully-selected solver (e.g. ABF++ in
  // Expert mode) must not be overwritten 200ms later by a
  // Tutte re-solve triggered by the live debounce.
  const smartUnwrapTool = createSmartUnwrapTool(state, {
    getBodyGeometry,
    solveAutomatic, // imported at the top of this file
    solveWith, // imported at the top of this file
    scheduleDraw,
    getStatsEl: () => statsEl,
    notifySeamChange: notifySeamChangeKeepResult,
    onAfterApply: recomputeLayout,
  });

  // The 3D seam toggle: public API for the 3D mini viewport
  // to toggle a seam by vertex-edge pair.
  const seam3DToggleTool = createSeam3DToggleTool(state, {
    buildEdgeKey, // imported at the top of this file
    scheduleDraw,
    notifySeamChange,
  });

  // The unwrap I/O tool: save/load the current UV attribute
  // + seam set as a JSON file, plus the per-TYPE
  // `saveTemplate` (see unwrap-io.js for the full rationale).
  const unwrapIO = createUnwrapIO(state, {
    getBodyGeometry,
    getSelectedEntity: () => selectedEntity,
    describeEntity, // defined later in this file
    scheduleDraw,
    onAfterApply: recomputeLayout,
  });

  // The selection tools: grow/shrink selection, island
  // lookup, box-select commit.
  const selectionTools = createSelectionTools(state, {
    getLayout: () => layout,
    getBodyGeometry,
    getUvCanvas: () => uvCanvas,
    uvToScreen, // defined later in this file
    parseEdgeKey, // imported at the top of this file
    getStatsEl: () => statsEl,
    scheduleDraw,
  });

  // The pick-at-pixel tool: find the face/edge/vertex
  // under a given pixel coordinate in the 2D canvas.
  const pickAtPixelTool = createPickAtPixelTool(state, {
    getLayout: () => layout,
    uvToScreen, // defined later in this file
  });

  // The drawing tool: owns all 2D canvas rendering
  // (background, grid, layout, hover, selection,
  // box-select, slice preview, overlay) plus the texture
  // loader and island color helper.
  const drawTool = createDrawTool(state, {
    getEnabled: () => enabled,
    getUvCanvas: () => uvCanvas,
    getUvCtx: () => uvCtx,
    getLayout: () => layout,
    getBodyGeometry,
    getSelectedEntity: () => selectedEntity,
    getStatsEl: () => statsEl,
    uvToScreen, // defined later in this file
  });

  // The 3D-pick tool: owns the raycaster + meshToEntity
  // Map + internal hoveredEntity state + the 3D-canvas
  // event handlers. `canvas` and `camera` come from the
  // orchestrator's closure (they're set at construction
  // time, not in mount()). `onPickEntity` forwards to the
  // orchestrator's `selectAsteroid` so clicking an
  // asteroid body loads its UV into the editor.
  const pick3DTool = createPick3DTool(state, {
    canvas,
    camera,
    getAsteroids,
    getEnabled: () => enabled,
    onPickEntity: (entity) => selectAsteroid(entity),
  });

  // The panel-window tool: owns the panel drag/resize
  // handlers + 2D canvas resize + localStorage
  // persistence. Shares `dragging` and `dragStart` with the
  // 2D-canvas pointer handlers (which use the same
  // variables to track pan/translate/box-select drags) —
  // both sides read/write via the getter/setter deps.
  // The factory owns `initialPanelRect` privately.
  const panelWindowTool = createPanelWindowTool(state, {
    getPanelEl: () => panelEl,
    getPanelHeader: () => panelHeader,
    getResizeGrip: () => resizeGrip,
    getUvCanvas: () => uvCanvas,
    getUvCtx: () => uvCtx,
    getDragging: () => dragging,
    setDragging: (d) => { dragging = d; },
    getDragStart: () => dragStart,
    setDragStart: (d) => { dragStart = d; },
    scheduleDraw,
  });

  // The compute-layout tool: owns the `computeLayout(entity)`
  // function that builds the UV layout (faces, seamEdges,
  // faceAdjacency, islands, uvs) from the selected
  // asteroid's geometry. Stateless — every call returns a
  // fresh object. The result is stored on the orchestrator's
  // `layout` `let` variable and read by the
  // drawing/selection/picking tools via `getLayout`.
  // `getColorForIsland` is a getter (not a direct reference)
  // for consistency with the late-bound-DOM dep pattern
  // used by the other tool factories — even though
  // `drawTool` is instantiated at the top of the
  // orchestrator, the getter keeps the pattern uniform.
  const computeLayoutTool = createComputeLayoutTool(state, {
    buildEdgeKey, // imported at the top of this file
    getColorForIsland: () => drawTool.colorForIsland,
  });

  // The hotkeys tool: owns the toolbar-button dispatch
  // table (`handleTool`) and the global keydown handler
  // (`onKeyDown`). All deps are callbacks to the
  // orchestrator's public methods — the factory just maps
  // button names / keys to calls. Instantiated after the
  // other tool factories so its deps can reference them
  // (e.g. `setMode` updates the toolbar active state).
  const hotkeysTool = createHotkeysTool(state, {
    getEnabled: () => enabled,
    setMode: (m) => setMode(m),
    rotateSelection,
    scaleSelection,
    mirrorSelection,
    flipU,
    flipV,
    toggleSnap,
    toggleHeatmap,
    toggleWireframe,
    toggleLiveUnwrap,
    clearSeams,
    runReUnwrap,
    runAutoUnwrap,
    runSmartUnwrap,
    runStartUnwrap,
    toggleAdvanced,
    saveUnwrap,
    saveTemplate: unwrapIO.saveTemplate,
    loadUnwrap,
    startSlice,
    markBoundarySeams,
    setSolverMode,
    growSelection,
    shrinkSelection,
    frameSelection,
    cancelSlice,
    clearSelectionEdit,
  });

  // ---- Seam change notification ----------------------------------------
  // Whenever seamKeys is mutated (2D click, 3D click via the edit
  // screen's mini viewport, AUTO, BOUND, CLEAR, load JSON), we
  // notify all registered listeners AND schedule a debounced live
  // re-unwrap (if LIVE is ON). This keeps the 3D seam overlay in
  // sync with the 2D side and makes seam changes feel live.

  function notifySeamChange() {
    for (const fn of seamChangeListeners) {
      try { fn(getSeamState()); } catch (_) { /* ignore */ }
    }
    if (liveUnwrapEnabled) scheduleLiveUnwrap();
  }

  // Variant of `notifySeamChange` for the tool-RESULT paths
  // (smart-unwrap, auto-unwrap, re-unwrap, start-unwrap).
  // Fires the seam listeners (so the 3D overlay updates) but
  // CANCELS the pending live-re-unwrap timer instead of
  // scheduling a new one. The just-applied result IS the
  // intentional result — running Tutte over it 200ms later
  // would silently overwrite a high-quality ABF++ / LSCM
  // layout with a lower-quality Tutte re-solve (the bug the
  // user reported: "I click SMART, it looks perfect for a
  // second, then collapses"). Also fixes the latent
  // infinite-loop in re-unwrap → scheduleLiveUnwrap →
  // re-unwrap, which fired every debounceMs forever.
  function notifySeamChangeKeepResult() {
    for (const fn of seamChangeListeners) {
      try { fn(getSeamState()); } catch (_) { /* ignore */ }
    }
    if (liveUnwrapTimer != null) {
      clearTimeout(liveUnwrapTimer);
      liveUnwrapTimer = null;
    }
  }

  function scheduleLiveUnwrap() {
    if (liveUnwrapTimer != null) clearTimeout(liveUnwrapTimer);
    liveUnwrapTimer = setTimeout(() => {
      liveUnwrapTimer = null;
      runReUnwrap();
    }, UV_EDITOR_CONFIG.liveUnwrap.debounceMs);
  }

  function getSeamState() {
    return {
      // Both sets are VERTEX-edge keys (`buildEdgeKey(va, vb)`).
      // The 3D mini viewport overlay can match directly to
      // `geometry.index.array[face * 3 + i]` — no UV lookup
      // needed, and the seams survive re-unwrap because the
      // vertex topology doesn't change. The previous version
      // exposed UV-edge keys, which silently desynced from the
      // geometry after the first re-unwrap.
      userSeamKeys: new Set(seamKeys), // defensive copy
      autoSeamKeys: layout ? new Set(layout.seamEdges.map((e) => e.vertKey)) : new Set(),
      isLiveUnwrapEnabled: liveUnwrapEnabled,
      seamCount: seamKeys.size,
    };
  }

  function addSeamChangeListener(fn) {
    seamChangeListeners.add(fn);
    return () => seamChangeListeners.delete(fn);
  }

  // DOM refs (set on mount)
  let nameEl = null, statsEl = null, closeBtn = null, resetBtn = null, bgBtn = null;
  let keysBtn = null, keysModalEl = null;
  let panelHeader = null, resizeGrip = null, toolsEl = null, modeLabelEl = null;
  let pickerEl = null; // asteroid picker <select> (set in mount())
  let pickerSyncInterval = null; // setInterval handle; cleared in unmount()

  // ===========================================================================
  // Public API
  // ===========================================================================

  function mount(parentEl = document.body) {
    if (panelEl) return;
    if (!parentEl) throw new Error('mount: parentEl is required');    panelEl = document.createElement('div');
    panelEl.className = 'uv-viewer';
    panelEl.dataset.uvViewer = '';
    // When mounted under a non-body parent (e.g. the edit
    // screen's .edit-screen__uv host), fill the parent instead
    // of floating. The CSS rule `.uv-viewer--embedded` handles
    // the rest.
    if (parentEl !== document.body) {
      panelEl.classList.add('uv-viewer--embedded');
    }
    panelEl.innerHTML = `
      <div class="uv-viewer__header" data-uv-viewer-header>
        <span class="uv-viewer__title">UV EDITOR</span>
        <span class="uv-viewer__name" data-uv-viewer-name>—</span>
        <button class="uv-viewer__close" type="button" data-uv-viewer-close aria-label="Close editor">×</button>
      </div>
      <canvas class="uv-viewer__canvas" data-uv-viewer-canvas></canvas>
      <div class="uv-viewer__tools" data-uv-viewer-tools>
        <!-- Big primary action: one-click best unwrap. The user
             said "I don't want to play with settings", so this
             is the dominant control. It auto-seams if needed
             and runs ABF++ directly (the highest-quality solver
             — the user said "select ASF++ and click SMART"
             is the perfect result, so START UNWRAP just does
             that in one step). -->
        <button class="uv-viewer__tool uv-viewer__tool--start-unwrap" type="button" data-uv-tool="start-unwrap" title="One-click ABF++ unwrap — auto-seams + ABF++ (the best solver). (Z)">START UNWRAP</button>
        <!-- Asteroid picker (combo). The user wanted a way to
             select an object from all the asteroids without
             having to click it in the 3D view. The dropdown
             lists every asteroid from getAsteroids(), labeled
             "icosphere/capsule #N (r=...)". On change, calls
             selectAsteroid(entity). Synced every 1s + on
             selectAsteroid so newly-streamed chunks appear
             automatically. -->
        <select class="uv-viewer__select uv-viewer__asteroid-picker" data-uv-tool="asteroid-picker" title="Pick an asteroid to edit">
          <option value="">— pick asteroid —</option>
        </select>
        <!-- All the rest of the tools (params panel, LIVE, HEAT,
             SNAP, mode picker, transforms, AUTO, UNWRAP, SMART,
             solver picker, mode toggle, WIRE, BOUND, CLEAR,
             SAVE, SAVE TEMPLATE, LOAD) live behind the '...'
             button. The user said "hide all other stuff behind
             ..." so the visible row is just START UNWRAP +
             the picker + the '...' button. -->
        <button class="uv-viewer__tool uv-viewer__tool--more" type="button" data-uv-tool="more" title="Show / hide advanced tools">…</button>
        <!-- Advanced tools (hidden by default, shown when '...'
             is clicked). Contains: params panel, LIVE/HEAT/SNAP,
             mode picker, transforms, unwrap family, solver
             picker, view toggles, seam management, save/load.
             The "advanced" class drives the show/hide via the
             .uv-viewer__tools__advanced CSS rule. -->
        <div class="uv-viewer__tools__advanced" data-uv-advanced>
          <span class="uv-viewer__tools__sep"></span>
          <!-- Adjustable params for the START UNWRAP button.
               Each control has a tooltip explaining what it
               does and the valid range. Now in the advanced
               section per the user's "hide all other stuff
               behind '...'" request. -->
          <div class="uv-viewer__start-params" data-uv-start-params>
            <label class="uv-viewer__start-param" title="Auto-detect seams by dihedral angle before unwrapping. ON = no need to mark seams manually. OFF = use only your marked seams (if any).">
              <input type="checkbox" data-uv-start-param="auto-seam" />
              <span>AUTO</span>
            </label>
            <label class="uv-viewer__start-param" title="Dihedral angle threshold (1-90°). Edges with dihedral > this become seams. LOWER = more seams (better for noisy geometry, can over-segment smooth shapes). 5° is the default for noisy asteroids; 30° for clean hard-surface meshes.">
              <span>THRESH</span>
              <input type="number" min="1" max="90" step="1" data-uv-start-param="threshold" />
              <span class="uv-viewer__start-param__unit">°</span>
            </label>
            <label class="uv-viewer__start-param" title="Pack margin (0-20%). Spacing between packed islands in the unit square. 0% = islands touch (max density), 4% = default, 20% = generous breathing room.">
              <span>MARGIN</span>
              <input type="number" min="0" max="0.2" step="0.01" data-uv-start-param="margin" />
              <span class="uv-viewer__start-param__unit">×</span>
            </label>
            <label class="uv-viewer__start-param" title="Stretch budget (5-500×). ABF++ runs once; this is informational only (the budget gate is gone since we picked the solver upfront).">
              <span>BUDGET</span>
              <input type="number" min="5" max="500" step="1" data-uv-start-param="budget" />
              <span class="uv-viewer__start-param__unit">×</span>
            </label>
            <label class="uv-viewer__start-param" title="Target island count (0-16). 0 = disabled (use auto-seam as-is). >0 = enforce: too many seams → drop the weakest by dihedral; too few → split the largest island along its sharpest internal edge. Mirrors Blender's Smart UV Project target count.">
              <span>ISLANDS</span>
              <input type="number" min="0" max="16" step="1" data-uv-start-param="islands" />
            </label>
          </div>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="live" data-uv-active="1" title="Live re-unwrap on seam change (L)">LIVE</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="heat" title="Stretch heatmap (H)">HEAT</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="snap" data-uv-active="1" title="Grid snap (G)">SNAP</button>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mode-face" data-uv-active="1" title="Face mode (1)">FACE</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mode-edge" title="Edge / seam mode (2)">EDGE</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mode-vert" title="Vertex mode (3)">VERT</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mode-island" title="Island mode (4)">ISLAND</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mode-slice" title="Slice tool (B)">SLICE</button>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="rot" title="Rotate 15° (R)">ROT</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="scl-up" title="Scale up (S)">S+</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="scl-dn" title="Scale down (Shift+S)">S−</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="mir" title="Mirror (M)">MIR</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="flip-u" title="Flip U">U</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="flip-v" title="Flip V">V</button>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="auto" title="Auto-detect seams + unwrap (A)">AUTO</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="unwrap" title="Re-unwrap with current seams (W)">UNWRAP</button>
          <button class="uv-viewer__tool uv-viewer__tool--primary" type="button" data-uv-tool="smart-unwrap" title="Smart Unwrap cascade (Z)">★ SMART</button>
          <select class="uv-viewer__select" data-uv-tool="solver-select" title="Expert solver picker">
            <option value="square-tutte" selected>Square Tutte</option>
            <option value="circle-tutte">Circle Tutte</option>
            <option value="lscm">LSCM</option>
            <option value="abf++">ABF++</option>
            <option value="smart-uv-project">Smart UV Project</option>
          </select>
          <div class="uv-viewer__mode-toggle" data-uv-tool="mode-toggle" title="Auto / Expert">
            <button type="button" class="uv-viewer__mode-btn uv-viewer__mode-btn--active" data-uv-mode="auto">AUTO</button>
            <button type="button" class="uv-viewer__mode-btn" data-uv-mode="expert">EXPERT</button>
          </div>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="wire" title="Wireframe overlay (X)">WIRE</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="boundary" title="Mark all island boundary edges as seams">BOUND</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="clear-seams" title="Clear all user-marked seams (K)">CLEAR</button>
          <span class="uv-viewer__tools__sep"></span>
          <button class="uv-viewer__tool" type="button" data-uv-tool="save" title="Save this asteroid's unwrap to JSON (per-instance)">SAVE</button>
          <button class="uv-viewer__tool uv-viewer__tool--template" type="button" data-uv-tool="save-template" title="Save the current UV layout as a per-TYPE template (icosphere or capsule). Applied to every new asteroid of that type, and downloaded as a distributable JSON file.">SAVE TEMPLATE</button>
          <button class="uv-viewer__tool" type="button" data-uv-tool="load" title="Load unwrap from JSON">LOAD</button>
        </div>
      </div>
      <div class="uv-viewer__footer">
        <span class="uv-viewer__stats" data-uv-viewer-stats>Click an asteroid in the 3D view</span>
        <button class="uv-viewer__btn" type="button" data-uv-viewer-bg>BG: CHECKER</button>
        <button class="uv-viewer__btn" type="button" data-uv-viewer-reset>RESET</button>
        <button class="uv-viewer__btn uv-viewer__btn--keys" type="button" data-uv-viewer-keys title="Show keyboard shortcuts (?)">?</button>
        <span class="uv-viewer__resize-grip" data-uv-viewer-resize title="Drag to resize"></span>
      </div>
      <!-- Keyboard legend modal. Toggled by the '?' button
           in the footer; click the backdrop or the close
           button to dismiss. Lists every hotkey + its action
           so the user doesn't have to remember (or hover
           every button to read its tooltip). The modal lives
           inside the panel so it inherits the panel's
           positioning — the CSS rule positions it as a
           centered overlay relative to the panel. -->
      <div class="uv-viewer__keys" data-uv-viewer-keys-modal hidden>
        <div class="uv-viewer__keys__backdrop" data-uv-viewer-keys-close></div>
        <div class="uv-viewer__keys__panel" role="dialog" aria-labelledby="uv-viewer__keys__title">
          <div class="uv-viewer__keys__header">
            <span class="uv-viewer__keys__title" id="uv-viewer__keys__title">KEYBOARD SHORTCUTS</span>
            <button class="uv-viewer__keys__close" type="button" data-uv-viewer-keys-close aria-label="Close">×</button>
          </div>
          <div class="uv-viewer__keys__body">
            <table class="uv-viewer__keys__table">
              <thead><tr><th>Key</th><th>Action</th></tr></thead>
              <tbody>
                <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>Mode: Face / Edge / Vertex / Island</td></tr>
                <tr><td><kbd>B</kbd></td><td>Slice tool (two-click cut)</td></tr>
                <tr><td><kbd>F</kbd></td><td>Frame selection (fit to bbox)</td></tr>
                <tr><td><kbd>R</kbd></td><td>Rotate selection 15°</td></tr>
                <tr><td><kbd>S</kbd> / <kbd>Shift</kbd>+<kbd>S</kbd></td><td>Scale up ×1.1 / down ×0.9</td></tr>
                <tr><td><kbd>M</kbd></td><td>Mirror (across U=V)</td></tr>
                <tr><td><kbd>U</kbd> <kbd>V</kbd></td><td>Flip U / Flip V</td></tr>
                <tr><td><kbd>H</kbd></td><td>Toggle stretch heatmap</td></tr>
                <tr><td><kbd>G</kbd></td><td>Toggle grid snap</td></tr>
                <tr><td><kbd>X</kbd></td><td>Toggle wireframe overlay</td></tr>
                <tr><td><kbd>K</kbd></td><td>Clear all seams</td></tr>
                <tr><td><kbd>W</kbd></td><td>Re-unwrap with current seams</td></tr>
                <tr><td><kbd>A</kbd></td><td>Auto-detect seams + unwrap</td></tr>
                <tr><td><kbd>L</kbd></td><td>Toggle live re-unwrap</td></tr>
                <tr><td><kbd>Z</kbd></td><td>START UNWRAP (one-click ABF++)</td></tr>
                <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Grow / Shrink selection</td></tr>
                <tr><td><kbd>Alt</kbd>+Click</td><td>Mark / unmark an entire edge loop as seam</td></tr>
                <tr><td><kbd>?</kbd> or <kbd>\</kbd></td><td>Toggle advanced tools</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Cancel slice / clear selection</td></tr>
                <tr><td><kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd></td><td>Save this asteroid's unwrap to JSON</td></tr>
                <tr><td><kbd>Ctrl/Cmd</kbd>+<kbd>O</kbd></td><td>Load unwrap from JSON</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    parentEl.appendChild(panelEl);

    // Restore saved position/size if any.
    try {
      const saved = JSON.parse(localStorage.getItem(UV_EDITOR_CONFIG.persistenceKey) || 'null');
      if (saved) {
        panelEl.style.left = saved.left;
        panelEl.style.top = saved.top;
        panelEl.style.width = saved.width;
        panelEl.style.height = saved.height;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      }
    } catch (_) { /* ignore */ }

    // Re-apply the persisted advanced-section state on
    // remount so closing + reopening the editor preserves the
    // user's choice (the toggle state lives in the
    // `advancedOpen` `let` variable, not in localStorage —
    // a fresh page is a fresh start).
    const advancedEl = panelEl.querySelector('[data-uv-advanced]');
    if (advancedEl) {
      advancedEl.classList.toggle('uv-viewer__tools__advanced--hidden', !advancedOpen);
    }
    const moreBtn = panelEl.querySelector('[data-uv-tool="more"]');
    if (moreBtn) {
      moreBtn.classList.toggle('uv-viewer__tool--more--active', advancedOpen);
    }

    nameEl = panelEl.querySelector('[data-uv-viewer-name]');
    statsEl = panelEl.querySelector('[data-uv-viewer-stats]');
    closeBtn = panelEl.querySelector('[data-uv-viewer-close]');
    resetBtn = panelEl.querySelector('[data-uv-viewer-reset]');
    bgBtn = panelEl.querySelector('[data-uv-viewer-bg]');
    keysBtn = panelEl.querySelector('[data-uv-viewer-keys]');
    keysModalEl = panelEl.querySelector('[data-uv-viewer-keys-modal]');
    panelHeader = panelEl.querySelector('[data-uv-viewer-header]');
    resizeGrip = panelEl.querySelector('[data-uv-viewer-resize]');
    toolsEl = panelEl.querySelector('[data-uv-viewer-tools]');
    pickerEl = panelEl.querySelector('[data-uv-tool="asteroid-picker"]');
    uvCanvas = panelEl.querySelector('[data-uv-viewer-canvas]');
    uvCtx = uvCanvas.getContext('2d');

    // Asteroid picker (combo). List every asteroid from
    // getAsteroids(); on change, call selectAsteroid(entity).
    // The dropdown is repopulated by `syncAsteroidPicker()`
    // on mount + every 1s (handles streamed-in / despawned
    // chunks without per-frame cost).
    if (pickerEl) {
      pickerEl.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === '') return;
        // Values are asteroid spec.id (stable across
        // additions/removals; the index in demoAsteroids
        // shifts on split/despawn).
        const asteroids = getAsteroids();
        const entity = asteroids.find((a) => a.spec && a.spec.id === v);
        if (entity) selectAsteroid(entity);
      });
      syncAsteroidPicker();
      // Repopulate on a 1s interval so newly-streamed
      // chunks appear in the dropdown without per-frame
      // work. Cleared in unmount().
      pickerSyncInterval = setInterval(syncAsteroidPicker, 1000);
    }
    panelWindowTool.resizeCanvas();
    window.addEventListener('resize', panelWindowTool.resizeCanvas);

    closeBtn.addEventListener('click', () => setEnabled(false));
    resetBtn.addEventListener('click', () => { panX = 0; panY = 0; zoom = 1; scheduleDraw(); });
    bgBtn.addEventListener('click', toggleBackground);
    // Keyboard legend: open/close the modal. The '?' button
    // toggles; clicking the backdrop or the close button
    // dismisses. The legend is also dismissable via the
    // global `?` hotkey (already handled by hotkeysTool which
    // fires `toggleAdvanced` — we wire the legend's open
    // state separately here, so '?' opens the legend AND
    // toggles the advanced section). The '?' button is the
    // primary path; the global hotkey opens the legend via
    // a separate toggleKeyboardLegend() call wired below.
    if (keysBtn) {
      keysBtn.addEventListener('click', () => toggleKeyboardLegend());
    }
    if (keysModalEl) {
      for (const closer of keysModalEl.querySelectorAll('[data-uv-viewer-keys-close]')) {
        closer.addEventListener('click', () => toggleKeyboardLegend(false));
      }
    }
    panelHeader.addEventListener('pointerdown', panelWindowTool.onPanelHeaderDown);
    resizeGrip.addEventListener('pointerdown', panelWindowTool.onResizeGripDown);

    // START UNWRAP panel — wire the 4 inputs (auto-seam
    // toggle, threshold, margin, budget) to the editor state.
    // The `change` event is used for checkboxes (fires on
    // toggle) and number inputs (fires on commit/blur).
    // The `input` event is also wired on the number inputs so
    // the user gets live feedback as they type (no need to
    // blur or press Enter to see the value land in state).
    const autoSeamCb = panelEl.querySelector('[data-uv-start-param="auto-seam"]');
    if (autoSeamCb) {
      autoSeamCb.checked = state.getAutoSeamEnabled();
      autoSeamCb.addEventListener('change', () => {
        state.setAutoSeamEnabled(autoSeamCb.checked);
      });
    }
    const thresholdInput = panelEl.querySelector('[data-uv-start-param="threshold"]');
    if (thresholdInput) {
      thresholdInput.value = state.getAutoSeamThreshold();
      thresholdInput.addEventListener('input', () => {
        state.setAutoSeamThreshold(thresholdInput.value);
      });
      thresholdInput.addEventListener('change', () => {
        // Clamp on commit so the visible value reflects the
        // stored value (silent snap for out-of-range).
        thresholdInput.value = state.getAutoSeamThreshold();
      });
    }
    const marginInput = panelEl.querySelector('[data-uv-start-param="margin"]');
    if (marginInput) {
      marginInput.value = state.getPackMargin();
      marginInput.addEventListener('input', () => {
        state.setPackMargin(marginInput.value);
      });
      marginInput.addEventListener('change', () => {
        marginInput.value = state.getPackMargin();
      });
    }
    const budgetInput = panelEl.querySelector('[data-uv-start-param="budget"]');
    if (budgetInput) {
      budgetInput.value = state.getStretchBudget();
      budgetInput.addEventListener('input', () => {
        state.setStretchBudget(budgetInput.value);
      });
      budgetInput.addEventListener('change', () => {
        budgetInput.value = state.getStretchBudget();
      });
    }
    const islandsInput = panelEl.querySelector('[data-uv-start-param="islands"]');
    if (islandsInput) {
      islandsInput.value = state.getTargetIslandCount();
      islandsInput.addEventListener('input', () => {
        state.setTargetIslandCount(islandsInput.value);
      });
      islandsInput.addEventListener('change', () => {
        islandsInput.value = state.getTargetIslandCount();
      });
    }

    // Tools footer
    for (const btn of toolsEl.querySelectorAll('[data-uv-tool]')) {
      btn.addEventListener('click', () => hotkeysTool.handleTool(btn.dataset.uvTool));
    }
    // Solver dropdown (Expert mode picker) — fires on
    // `change` (not click) since it's a <select>. The
    // `solverId` is the select's current value.
    const solverSelect = toolsEl.querySelector('[data-uv-tool="solver-select"]');
    if (solverSelect) {
      solverSelect.addEventListener('change', (e) => {
        const newId = e.target.value;
        if (SOLVER_IDS.includes(newId)) {
          expertSolverId = newId;
          if (statsEl) {
            statsEl.textContent = `Solver: ${SOLVER_LABELS[newId] || newId}`;
          }
        }
      });
    }
    // Mode toggle (Auto / Expert) — the two buttons inside
    // `[data-uv-tool="mode-toggle"]` carry their own
    // `data-uv-mode` attribute (auto | expert).
    const modeToggle = toolsEl.querySelector('[data-uv-tool="mode-toggle"]');
    if (modeToggle) {
      for (const btn of modeToggle.querySelectorAll('[data-uv-mode]')) {
        btn.addEventListener('click', () => setSolverMode(btn.dataset.uvMode));
      }
    }

    // 2D canvas
    uvCanvas.addEventListener('pointerdown', onCanvasPointerDown);
    uvCanvas.addEventListener('pointermove', onCanvasPointerMove);
    uvCanvas.addEventListener('pointerup', onCanvasPointerUp);
    uvCanvas.addEventListener('pointercancel', onCanvasPointerUp);
    uvCanvas.addEventListener('wheel', onCanvasWheel, { passive: false });

    // Hotkeys
    window.addEventListener('keydown', hotkeysTool.onKeyDown);
    window.addEventListener('pointermove', panelWindowTool.onWindowPointerMove);
    window.addEventListener('pointerup', panelWindowTool.onWindowPointerUp);
    window.addEventListener('pointercancel', panelWindowTool.onWindowPointerUp);

    // 3D canvas
    canvas.addEventListener('pointermove', pick3DTool.onPointerMove);
    canvas.addEventListener('pointerleave', pick3DTool.onLeave);
    canvas.addEventListener('click', pick3DTool.onClick);

    scheduleDraw();
  }

  function unmount() {
    if (!panelEl) return;
    pick3DTool.clearHover();
    if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    window.removeEventListener('resize', panelWindowTool.resizeCanvas);
    window.removeEventListener('keydown', hotkeysTool.onKeyDown);
    window.removeEventListener('pointermove', panelWindowTool.onWindowPointerMove);
    window.removeEventListener('pointerup', panelWindowTool.onWindowPointerUp);
    window.removeEventListener('pointercancel', panelWindowTool.onWindowPointerUp);
    canvas.removeEventListener('pointermove', pick3DTool.onPointerMove);
    canvas.removeEventListener('pointerleave', pick3DTool.onLeave);
    canvas.removeEventListener('click', pick3DTool.onClick);
    panelEl.remove();
    panelEl = null;
    uvCanvas = null; uvCtx = null;
    nameEl = statsEl = closeBtn = resetBtn = bgBtn = null;
    keysBtn = keysModalEl = null;
    panelHeader = resizeGrip = toolsEl = modeLabelEl = null;
    pickerEl = null;
    if (pickerSyncInterval != null) {
      clearInterval(pickerSyncInterval);
      pickerSyncInterval = null;
    }
    layout = null;
    textureImg = null; textureReady = false;
    selectedEntity = null;
    panX = panY = 0; zoom = 1;
    dragging = null; dragStart = null;
  }

  /**
   * Repopulate the asteroid picker dropdown with the current
   * list of asteroids from `getAsteroids()`. Labels use
   * `describeEntity` ("icosphere #N (r=...)") so the user can
   * tell two similar asteroids apart. Sets the selected value
   * to the currently selected entity (if any) so the dropdown
   * stays in sync with `selectAsteroid`. Called on mount, on
   * `selectAsteroid`, and on a 1s interval (handles
   * streamed-in / despawned chunks).
   *
   * O(N) in the asteroid count; for ~200 asteroids the
   * innerHTML rewrite is <0.5ms. The 1s interval caps the
   * cost at ~0.5ms/sec — negligible.
   */
  function syncAsteroidPicker() {
    if (!pickerEl) return;
    const asteroids = getAsteroids();
    const selectedId = selectedEntity && selectedEntity.spec ? selectedEntity.spec.id : '';
    // Build the option list as a single innerHTML write
    // (faster than appending one at a time on a long list).
    // The leading placeholder is the "no selection" option.
    let html = '<option value="">— pick asteroid —</option>';
    for (const a of asteroids) {
      if (!a || !a.spec) continue;
      const label = describeEntity(a).replace(/</g, '&lt;');
      html += `<option value="${a.spec.id}">${label}</option>`;
    }
    pickerEl.innerHTML = html;
    // Restore the selected value (innerHTML rewrite clears
    // selection state). The current selectedEntity's spec.id
    // is stable; if it's no longer in the list (e.g. the
    // asteroid was just destroyed), the dropdown falls back
    // to the placeholder.
    pickerEl.value = asteroids.some((a) => a.spec && a.spec.id === selectedId)
      ? selectedId
      : '';
  }

  function setEnabled(value) {
    const v = !!value;
    if (v === enabled) return;
    enabled = v;
    if (enabled) {
      if (!panelEl) mount();
      panelEl.classList.add('uv-viewer--visible');
      scheduleDraw();
    } else {
      if (panelEl) {
        panelEl.classList.remove('uv-viewer--visible');
        pick3DTool.clearHover();
      }
    }
  }
  function isEnabled() { return enabled; }
  function getSelectedAsteroid() { return selectedEntity; }

  function selectAsteroid(entity) {
    if (!entity) { clearSelection(); return; }
    selectedEntity = entity;
    layout = computeLayoutTool.computeLayout(entity);
    // Reset transform + selection + seams for the new body.
    selectedFaces.clear(); selectedEdges.clear(); selectedVertices.clear();
    seamKeys.clear();
    panX = 0; panY = 0; zoom = 1;
    textureImg = null; textureReady = false;
    if (nameEl) nameEl.textContent = describeEntity(entity);
    // Keep the asteroid picker in sync with the new selection
    // (set in selectAsteroid rather than the interval so the
    // dropdown updates instantly on 3D click + on programmatic
    // selection from the edit screen).
    if (pickerEl) {
      const v = entity.spec && entity.spec.id;
      pickerEl.value = v || '';
    }
    scheduleDraw();
  }

  function clearSelection() {
    selectedEntity = null;
    layout = null;
    selectedFaces.clear(); selectedEdges.clear(); selectedVertices.clear();
    if (nameEl) nameEl.textContent = '—';
    if (statsEl) statsEl.textContent = 'Click an asteroid in the 3D view';
    scheduleDraw();
  }

  function dispose() { unmount(); }

  // ===========================================================================
  // 2D canvas — pan / zoom / select / translate / box-select
  // ===========================================================================

  function onCanvasPointerDown(e) {
    if (!uvCanvas) return;
    uvCanvas.setPointerCapture(e.pointerId);
    const rect = uvCanvas.getBoundingClientRect();
    const px = e.offsetX, py = e.offsetY;
    // If clicked on the panel header / footer, the panel handles it.
    if (e.target !== uvCanvas) {
      // Let the panel's own drag/resize handle it.
      return;
    }
    // Slice mode: clicks set the two endpoints of the cut
    // line. Don't do any pick/select work in this mode.
    if (state.getMode() === 'slice') {
      if (!state.getSliceFirst()) {
        state.setSliceFirst({ x: px, y: py });
        state.setSliceSecond(null);
        if (statsEl) {
          statsEl.textContent = 'SLICE: click the second point (Esc to cancel).';
        }
        scheduleDraw();
      } else {
        state.setSliceSecond({ x: px, y: py });
        sliceTool.executeSlice();
        // Exit slice mode on success — the user can hit B
        // again to start another slice.
        setMode('face');
        state.clearSlice();
      }
      return;
    }
    // Determine the hit. In face mode, hit the face. In edge
    // mode, hit the nearest edge. In vertex mode, hit the
    // nearest vertex.
    const hit = pickAtPixelTool.pickAtPixel(px, py, rect.width, rect.height);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Pan
      dragging = 'pan';
      dragStart = { x: e.clientX, y: e.clientY, panX, panY };
    } else if (e.button === 0) {
      if (hit) {
        if (mode === 'edge' && hit.kind === 'edge') {
          if (e.altKey && hit.va != null && hit.vb != null) {
            // Alt+Click: toggle every edge in the loop (Blender
            // "Mark Loop as Seam" workflow). The loop edges
            // come back as vertex pairs, which is exactly what
            // seamKeys stores — no UV lookup, no risk of the
            // seam detaching after a re-unwrap.
            const geom = getBodyGeometry();
            if (geom) {
              const loop = walkEdgeLoop(geom, hit.va, hit.vb);
              for (const { va, vb } of loop) {
                const k = buildEdgeKey(va, vb);
                if (seamKeys.has(k)) seamKeys.delete(k); else seamKeys.add(k);
              }
              if (statsEl) {
                statsEl.textContent = `Alt+Click loop: toggled ${loop.length} edge${loop.length === 1 ? '' : 's'} as seams.`;
              }
              notifySeamChange();
              scheduleDraw();
            }
          } else {
            // Plain click: toggle just this edge.
            const k = hit.key;
            if (seamKeys.has(k)) seamKeys.delete(k); else seamKeys.add(k);
            updateSelectionFromSeamToggle(hit);
            notifySeamChange();
            scheduleDraw();
          }
        } else if (mode === 'island' && hit.kind === 'face') {
          // Island mode: click a face to select the whole
          // island (replace, or add to selection with Shift).
          if (!e.shiftKey) {
            selectedFaces.clear();
            selectedEdges.clear();
            selectedVertices.clear();
          }
          for (const fi of hit.faces) {
            const island = selectionTools.findIslandOfFace(fi);
            if (island) {
              for (const f of island.faces) selectedFaces.add(f);
            } else {
              selectedFaces.add(fi);
            }
          }
          scheduleDraw();
        } else {
          // Add to selection (or replace).
          if (!e.shiftKey) {
            selectedFaces.clear();
            selectedEdges.clear();
            selectedVertices.clear();
          }
          if (hit.kind === 'face') {
            for (const f of hit.faces) selectedFaces.add(f);
          } else if (hit.kind === 'edge') {
            selectedEdges.add(hit.key);
          } else if (hit.kind === 'vertex') {
            selectedVertices.add(hit.index);
          }
          // Start translate.
          dragging = 'translate';
          dragStart = { x: px, y: py, panX, panY, lastTranslate: { du: 0, dv: 0 } };
          // Visual feedback for "I'm now dragging" — the
          // user said "make vertices moveable by the mouse".
          // In vertex mode the cursor changes from `grab`
          // (set in pointermove) to `grabbing`. In face
          // mode the cursor stays `move` (no change). The
          // release path (onCanvasPointerUp) restores the
          // appropriate cursor.
          if (mode === 'vertex') {
            uvCanvas.style.cursor = 'grabbing';
          }
        }
      } else {
        // Start box-select.
        dragging = 'box';
        dragStart = { x: px, y: py };
        if (!e.shiftKey) {
          selectedFaces.clear();
          selectedEdges.clear();
          selectedVertices.clear();
        }
        boxSelectRect = { x0: px, y0: py, x1: px, y1: py };
        scheduleDraw();
      }
    }
  }
  function onCanvasPointerMove(e) {
    if (!uvCanvas) return;
    const rect = uvCanvas.getBoundingClientRect();
    const px = e.offsetX, py = e.offsetY;
    if (dragging === 'pan' && dragStart) {
      panX = dragStart.panX + (e.clientX - dragStart.x);
      panY = dragStart.panY + (e.clientY - dragStart.y);
      scheduleDraw();
    } else if (dragging === 'translate' && dragStart) {
      const w = rect.width, h = rect.height;
      const uvAt = screenToUv(px, py, w, h);
      const uvStart = screenToUv(dragStart.x, dragStart.y, w, h);
      const du = uvAt.x - uvStart.x;
      const dv = uvAt.y - uvStart.y;
      const lastDu = dragStart.lastTranslate.du;
      const lastDv = dragStart.lastTranslate.dv;
      const ddu = du - lastDu;
      const ddv = dv - lastDv;
      dragStart.lastTranslate = { du, dv };
      applyTranslate(ddu, ddv);
      scheduleDraw();
    } else if (dragging === 'box' && dragStart) {
      boxSelectRect = { x0: dragStart.x, y0: dragStart.y, x1: px, y1: py };
      scheduleDraw();
    } else if (!dragging) {
      // Idle: update hover state so the user gets a visual cue
      // about which edge/face their cursor is over. Crucial
      // for edge selection — the edges are 1px lines and hard
      // to aim at without a hover highlight.
      const hit = pickAtPixelTool.pickAtPixel(px, py, rect.width, rect.height);
      const newHoveredEdge = hit && hit.kind === 'edge' ? hit : null;
      const newHoveredFace = hit && hit.kind === 'face' ? hit.faces[0] : null;
      if (newHoveredEdge !== hoveredEdge || newHoveredFace !== hoveredFace) {
        hoveredEdge = newHoveredEdge;
        hoveredFace = newHoveredFace;
        scheduleDraw();
      }
      // Cursor feedback: grab in vertex mode (suggests
      // "you can drag this to move it"), pointer in edge
      // mode (suggests "click to mark as a seam"), move in
      // face mode (suggests "you can translate the
      // selection"). The user said "make vertices moveable
      // by the mouse" — the grab cursor is the cue that
      // vertex mode supports drag-to-move. The actual drag
      // is started by onCanvasPointerDown + the 'translate'
      // drag mode; while dragging, the cursor switches to
      // 'grabbing' in onCanvasPointerDown.
      if (mode === 'vertex') {
        uvCanvas.style.cursor = hoveredFace != null ? 'grab' : 'default';
      } else if (mode === 'edge') {
        uvCanvas.style.cursor = hoveredEdge ? 'pointer' : 'crosshair';
      } else {
        uvCanvas.style.cursor = hoveredFace != null ? 'move' : 'default';
      }
    }
    // 'panel' and 'resize' drags are handled by the
    // window-level pointermove listener (onWindowPointerMove) so
    // the user can drag the panel even when the cursor leaves
    // the 2D canvas.
  }
  function onCanvasPointerUp(e) {
    if (!uvCanvas) return;
    try { uvCanvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (dragging === 'box' && boxSelectRect) {
      selectionTools.commitBoxSelect();
      boxSelectRect = null;
      scheduleDraw();
    } else if (dragging === 'panel' || dragging === 'resize') {
      // Backup branch: the window-level
      // `panelWindowTool.onWindowPointerUp` normally
      // handles panel drag/resize commits, but if the
      // pointer is released over the 2D canvas (and
      // pointer capture was lost on the panel header),
      // this handler fires first.
      panelWindowTool.persistPanelRect();
    }
    // Restore the cursor after a translate drag in vertex
    // mode (we forced 'grabbing' in pointerdown; the next
    // pointermove will re-evaluate the cursor based on the
    // new hover state, so we don't need to set it here).
    // The branch is kept narrow: only the vertex-mode
    // drag is the one that swapped cursors.
    dragging = null;
    dragStart = null;
  }
  function onCanvasWheel(e) {
    e.preventDefault();
    if (!uvCanvas) return;
    const rect = uvCanvas.getBoundingClientRect();
    const px = e.offsetX, py = e.offsetY;
    const uvBefore = screenToUv(px, py, rect.width, rect.height);
    const z = UV_EDITOR_CONFIG.zoom;
    const factor = Math.exp(-e.deltaY * z.factor);
    zoom = Math.max(z.min, Math.min(z.max, zoom * factor));
    const uvAfter = screenToUv(px, py, rect.width, rect.height);
    panX += (uvAfter.x - uvBefore.x) * (rect.width * zoom);
    panY -= (uvAfter.y - uvBefore.y) * (rect.height * zoom);
    scheduleDraw();
  }

  function toggleBackground() {
    state.setBackgroundMode(state.getBackgroundMode() === 'checker' ? 'texture' : 'checker');
    if (bgBtn) bgBtn.textContent = `BG: ${state.getBackgroundMode().toUpperCase()}`;
    scheduleDraw();
  }

  /**
   * Show / hide the keyboard legend modal. The '?' button
   * in the footer toggles; the global `?` hotkey (wired
   * via the orchestrator's keyboard handler below) opens
   * the legend. Pass `false` to force-close (used by the
   * backdrop click + close button). When the legend is
   * open, the global hotkey also closes it (Esc-like
   * behavior, but for the legend).
   *
   * The modal lives inside the panel so it inherits the
   * panel's positioning — the CSS rule positions it as a
   * centered overlay relative to the panel. `hidden` is
   * the standard HTML attribute for show/hide; the CSS
   * rule `[hidden]` is built into every browser.
   */
  function toggleKeyboardLegend(force) {
    if (!keysModalEl) return;
    const willOpen = typeof force === 'boolean' ? force : keysModalEl.hasAttribute('hidden');
    if (willOpen) {
      keysModalEl.removeAttribute('hidden');
    } else {
      keysModalEl.setAttribute('hidden', '');
    }
    if (keysBtn) keysBtn.classList.toggle('uv-viewer__btn--active', willOpen);
  }

  function uvToScreen(u, v, w, h) {
    return {
      x: w / 2 + (u - 0.5) * w * zoom + panX,
      y: h / 2 + (0.5 - v) * h * zoom + panY,
    };
  }
  function screenToUv(sx, sy, w, h) {
    return {
      x: (sx - w / 2 - panX) / (w * zoom) + 0.5,
      y: 0.5 - (sy - h / 2 - panY) / (h * zoom),
    };
  }

  // ===========================================================================
  // Picking in the 2D canvas
  // ===========================================================================

  // `pickAtPixel` and `commitBoxSelect` are intentionally NOT
  // wrapped here — callers use `pickAtPixelTool.pickAtPixel(...)`
  // and `selectionTools.commitBoxSelect()` directly. Adding
  // thin wrappers just for them is noise; the other tools
  // (transforms, slice, etc.) are wrapped because they appear
  // on the public return object.

  function updateSelectionFromSeamToggle(_hit) { /* no-op: selection stays as-is */ }

  // Inline no-op kept for backward compat. The pick + commit is
  // done by the box-select code in onCanvasPointerDown.

  /**
   * Enter slice mode. The next two clicks in the 2D canvas
   * mark every edge the line between them crosses as a seam.
   * Slice mode is a "two-shot" interaction (first click sets
   * the start, second click commits), so it's a separate
   * state from the regular pick/select modes. Esc cancels.
   */
  function startSlice() {
    sliceTool.startSlice();
  }

  function cancelSlice() {
    sliceTool.cancelSlice();
  }

  /**
   * Execute the slice: for every edge in the layout, check if
   * the segment (sliceFirst, sliceSecond) crosses the edge's
   * UV-space segment. Crossing uses the standard orientation
   * test (sign of the cross product on both sides). Touching
   * at a shared vertex does NOT count as crossing — otherwise
   * any click near a vertex would explode the seam set.
   */
  function executeSlice() {
    sliceTool.executeSlice();
  }

  /**
   * Fit the 2D camera to the current selection's UV bounding
   * box. If nothing is selected, frames the whole layout.
   * Mirrors Blender's `F` shortcut and RizomUV's "Frame
   * Selection" — a one-key way to "zoom to what I clicked on"
   * after marking seams or selecting faces.
   */
  function frameSelection() {
    frameTool.frameSelection();
  }

  // Selection tool wrappers — the actual grow/shrink/find
  // logic lives in the selectionTools factory. These
  // wrappers exist only to keep the public API stable for
  // the hotkey handler + return object.
  function findIslandOfFace(faceIdx) {
    return selectionTools.findIslandOfFace(faceIdx);
  }
  function growSelection() {
    selectionTools.growSelection();
  }
  function shrinkSelection() {
    selectionTools.shrinkSelection();
  }

  // ===========================================================================
  // Transforms (applied to the live geometry's UV attribute)
  // ===========================================================================

  function getBodyGeometry() {
    if (!selectedEntity) return null;
    const body = selectedEntity.mesh && selectedEntity.mesh.children && selectedEntity.mesh.children[0];
    if (!body) return null;
    if (body.isLOD) {
      return body.levels[0] && body.levels[0].object && body.levels[0].object.geometry;
    }
    return body.geometry;
  }

  // Shared callback: recompute the layout for re-rendering
  // after a transform or translate mutates the UVs. Used by
  // both the transforms and translate factories.
  function recomputeLayout() {
    layout = computeLayoutTool.computeLayout(selectedEntity);
  }

  function applyTranslate(du, dv) {
    translateTool.applyTranslate(du, dv);
  }

  // Transform tool wrappers — the actual transform logic
  // (centroid, snap, UV update) lives in the `transforms`
  // factory above. These wrappers exist only to (a) keep
  // the public API stable for the hotkey handler + return
  // object, and (b) document which tool corresponds to
  // which factory method.
  function rotateSelection(deg) {
    transforms.rotateSelection(deg);
  }
  function scaleSelection(factor) {
    transforms.scaleSelection(factor);
  }
  function mirrorSelection() {
    // Mirror across the line y = x.
    transforms.mirrorSelection();
  }
  function flipU() {
    transforms.flipU();
  }
  function flipV() {
    transforms.flipV();
  }
  function clearSelectionEdit() {
    selectedFaces.clear(); selectedEdges.clear(); selectedVertices.clear();
    scheduleDraw();
  }

  // ===========================================================================
  // Seam marking + re-unwrap
  // ===========================================================================

  function runReUnwrap() {
    reUnwrapTool.runReUnwrap();
  }

  /**
   * Auto-detect seams by dihedral angle (curvature-based) and
   * run the unwrap. Uses the dihedral threshold from
   * UV_EDITOR_CONFIG (default 30°). The detected seams are
   * added to `seamKeys` so the user can SEE them highlighted
   * in the 2D panel (and the 3D mesh, via the seam change
   * listeners) — the previous version only used them
   * internally for unwrapping, which made the button feel
   * like a no-op.
   */
  function runAutoUnwrap() {
    autoUnwrapTool.runAutoUnwrap();
  }

  // Exported as a public API member (see the return object at
  // the bottom of this file) so the 3D mini viewport can use
  // the same encoder when building its seam overlay — no
  // duplicated encoding logic, no risk of desync.

  /**
   * Public API for the 3D mini viewport to toggle a seam.
   * See the seam-3d tool for the full implementation.
   */
  function toggleSeamFrom3D(va, vb) {
    return seam3DToggleTool.toggleSeamFrom3D(va, vb);
  }

  // ===========================================================================
  // Save / load JSON
  // ===========================================================================

  function saveUnwrap() {
    unwrapIO.saveUnwrap();
  }

  // Per-type UV template (icosphere or capsule). Writes to
  // localStorage + downloads a distributable JSON file.
  // See unwrap-io.js's `saveTemplate` for the full
  // rationale. The forwarder exists so the public API
  // (and the hotkeysTool deps) reference a local
  // function — same pattern as saveUnwrap/loadUnwrap.
  function saveTemplate() {
    unwrapIO.saveTemplate();
  }

  function loadUnwrap() {
    unwrapIO.loadUnwrap();
  }

  // ===========================================================================
  // Tools + hotkeys
  // ===========================================================================
  // Both `handleTool(name)` and `onKeyDown(e)` now live in
  // the `hotkeysTool` factory (src/systems/uv-tools/hotkeys.js).
  // The factory owns the two dispatch tables; this
  // orchestrator just wires them up to the toolbar click
  // handlers (in `mount()`) and the window keydown event
  // (also in `mount()`/`unmount()`).

  function setMode(m) {
    state.setMode(m);
    if (toolsEl) {
      for (const btn of toolsEl.querySelectorAll('[data-uv-tool^="mode-"]')) {
        // `island` mode maps to the data-uv-tool="mode-island"
        // button; the others use the `vert` slug for `vertex`.
        const expected = m === 'vertex' ? 'mode-vert' : `mode-${m}`;
        btn.dataset.uvActive = btn.dataset.uvTool === expected ? '1' : '0';
      }
    }
    scheduleDraw();
  }

  function toggleSnap() {
    // The factory flips `snapEnabled` via the state
    // interface; we read the new value back to update the
    // toolbar button's active state.
    transforms.toggleSnap();
    if (toolsEl) {
      const btn = toolsEl.querySelector('[data-uv-tool="snap"]');
      if (btn) btn.dataset.uvActive = state.getSnapEnabled() ? '1' : '0';
    }
  }
  function toggleHeatmap() {
    viewToggles.toggleHeatmap();
  }
  function toggleWireframe() {
    viewToggles.toggleWireframe();
  }
  function toggleLiveUnwrap() {
    viewToggles.toggleLiveUnwrap();
  }
  function clearSeams() {
    // The clear-seams tool factory does the work (clears
    // seamKeys, updates the stats line, notifies the
    // seam-change listeners, schedules a redraw).
    clearSeamsTool.clearSeams();
  }

  /**
   * One-click smart unwrap. In Auto mode, runs the cascade and
   * picks the best solver. In Expert mode, uses the solver
   * selected in the dropdown. The result is applied to the
   * geometry, the seams are added to `seamKeys` (so the user
   * can see them highlighted in the 2D panel + 3D mesh), and
   * a quality report is shown in the stats line.
   *
   * Mirrors Blender's "Smart UV Project" workflow but with our
   * own solver selection (xatlas is not available on npm, so
   * we use our hand-rolled square-Tutte placement as the
   * default — it's the best for the cylinder-body case).
   */
  function runSmartUnwrap() {
    smartUnwrapTool.runSmartUnwrap();
  }

  /**
   * Enforce a target island count by trimming weakest seams
   * (when over target) or splitting the largest island along
   * its sharpest internal edge (when under target). Returns
   * `{ removed, added }` so the caller can log a summary.
   *
   * @param {THREE.BufferGeometry} geom
   * @param {Set<number>} seamKeys - mutated in place
   * @param {number} target
   * @param {Map<number, number>|null} dihedralMap - edge key → dihedral in degrees; null if unavailable (non-indexed geometry)
   * @returns {{ removed: number, added: number }}
   */
  function enforceTargetIslands(geom, seamKeys, target, dihedralMap) {
    if (target <= 0) return { removed: 0, added: 0 };
    let removed = 0, added = 0;
    // ---- Over target: drop the weakest seams -----------------
    // Iterate: pick the seam with the smallest dihedral,
    // remove it, re-detect islands. Stop when at or under
    // target. Each removal is O(seams × islandDetect), which
    // is fine for typical asteroid complexity (<1k seams).
    let islands = detectIslands(geom, seamKeys);
    while (islands.length > target && dihedralMap && seamKeys.size > 0) {
      // Find the current seam with the smallest dihedral.
      let weakestKey = null;
      let weakestDeg = Infinity;
      for (const k of seamKeys) {
        const d = dihedralMap.get(k);
        if (d != null && d < weakestDeg) {
          weakestDeg = d;
          weakestKey = k;
        }
      }
      if (weakestKey == null) break;
      seamKeys.delete(weakestKey);
      removed++;
      const next = detectIslands(geom, seamKeys);
      // If island count didn't drop, the seam was a no-op
      // (didn't actually separate any faces). Stop trimming
      // to avoid an infinite loop.
      if (next.length >= islands.length) {
        // Re-add the seam we just removed (it was necessary)
        // and break — we've hit the "can't drop further" wall.
        seamKeys.add(weakestKey);
        removed--;
        break;
      }
      islands = next;
    }
    // ---- Under target: split the largest island --------------
    // Iterate: find the largest island (most faces), find
    // its sharpest INTERNAL edge (both endpoints in the
    // island, highest dihedral, not already a seam), add it
    // as a seam, re-detect. Stops at target or when no more
    // internal edges can be split.
    islands = detectIslands(geom, seamKeys);
    while (islands.length < target && dihedralMap) {
      // Find the largest island.
      let largest = null;
      let largestSize = 0;
      for (const island of islands) {
        if (island.faces.length > largestSize) {
          largestSize = island.faces.length;
          largest = island;
        }
      }
      if (!largest) break;
      // Build a Set of vertices in the largest island for
      // fast "is this edge internal to the island?" checks.
      const islandVerts = new Set();
      for (const fi of largest.faces) {
        // face index → vertices via the geometry's index buffer.
        // Use `getBodyGeometry()` indirectly — we have `geom`.
        const idxArr = geom.index ? geom.index.array : null;
        if (!idxArr) break;
        islandVerts.add(idxArr[fi * 3 + 0]);
        islandVerts.add(idxArr[fi * 3 + 1]);
        islandVerts.add(idxArr[fi * 3 + 2]);
      }
      // Walk every edge, find the sharpest one that is
      // (a) not already a seam and (b) internal to the
      // largest island.
      let bestKey = null;
      let bestDeg = -Infinity;
      for (const [k, deg] of dihedralMap) {
        if (seamKeys.has(k)) continue;
        const [va, vb] = parseEdgeKey(k);
        if (!islandVerts.has(va) || !islandVerts.has(vb)) continue;
        if (deg > bestDeg) {
          bestDeg = deg;
          bestKey = k;
        }
      }
      if (bestKey == null) break;
      seamKeys.add(bestKey);
      added++;
      const next = detectIslands(geom, seamKeys);
      if (next.length <= islands.length) {
        // Splitting didn't increase island count (shouldn't
        // happen for an internal edge, but guard anyway).
        seamKeys.delete(bestKey);
        added--;
        break;
      }
      islands = next;
    }
    return { removed, added };
  }

  /**
   * One-click best unwrap. This is the START UNWRAP button —
   * the user said "I don't want to play with settings" and
   * also said "START UNWRAP should do -> select ASF++ and
   * click SMART. then we have a perfect result." So this
   * function just runs ABF++ directly (the highest-quality
   * solver, the one the user said produces a perfect result
   * on every asteroid). No cascade, no fallback — the user
   * told us the answer.
   *
   * Steps:
   *   1. If no seams are marked AND auto-seam is on, auto-detect
   *      them (dihedral angle, with a shape-aware fallback for
   *      capsules that always has at least the cap-body
   *      junction seams). Same auto-seam logic as before.
   *   2. Optionally enforce a target island count (still
   *      supported via the params panel — same as before).
   *   3. Run ABF++ once. The result is applied + the 3D
   *      overlay is notified (without scheduling a live
   *      re-unwrap, which would clobber the result — see
   *      `notifySeamChangeKeepResult`).
   *
   * Shows a clear "Done" message in the stats line so the
   * user can see the result (solver, max stretch, elapsed ms)
   * without opening the advanced menu.
   */
  function runStartUnwrap() {
    const geom = getBodyGeometry();
    if (!geom) return;
    // Snapshot the adjustable params at the moment the button
    // is pressed (so the user can tweak between presses
    // without re-mounting the editor).
    const autoEnabled = state.getAutoSeamEnabled();
    const threshold = state.getAutoSeamThreshold();
    const margin = state.getPackMargin();
    const targetIslands = state.getTargetIslandCount();
    // Step 1: auto-seam if none marked AND auto-seam is on.
    // Identical to the previous implementation — ABF++ still
    // needs seams to work with, and a closed-mesh (capsule,
    // sphere, etc.) without seams falls through to LSCM
    // territory which is worse than the previous cascade.
    const seamKeysLocal = state.getSeamKeys();
    if (autoEnabled && seamKeysLocal.size === 0) {
      // Run the dihedral auto-seam, then (if it returns
      // nothing) try a shape-aware fallback. One consolidated
      // console message summarizes the outcome.
      let detected = null;
      let detectError = null;
      try {
        detected = autoDetectSeams(geom, threshold);
      } catch (e) {
        // Non-indexed geometry throws here (the noisy
        // icosphere is non-indexed; the capsule is indexed).
        // We fall through to the shape-aware fallback below.
        detectError = e.message;
      }
      if (detected && detected.size > 0) {
        for (const k of detected) seamKeysLocal.add(k);
        if (typeof console !== 'undefined') {
          console.info(`[runStartUnwrap] auto-seam: ${detected.size} seams (dihedral ${threshold}°)`);
        }
      } else if (selectedEntity && selectedEntity.spec && (selectedEntity.spec.seed & 1)) {
        // Shape-aware fallback for capsules (seed & 1): the
        // cap-body junction is always a 90° dihedral, so a
        // 60° threshold catches it. The capsule body becomes
        // one island, each cap becomes its own — 3 islands
        // total, the canonical "good" capsule unwrap.
        let sharpCount = 0;
        try {
          const sharpSeams = autoDetectSeams(geom, 60);
          for (const k of sharpSeams) seamKeysLocal.add(k);
          sharpCount = sharpSeams.size;
        } catch (_) { /* swallow — ABF++ can still run with no seams */ }
        if (typeof console !== 'undefined') {
          const reason = detectError ? `auto-seam threw: ${detectError}` : `dihedral ${threshold}° caught nothing`;
          // detectError → warn (geometry is non-indexed); otherwise info
          const log = detectError ? console.warn : console.info;
          log(`[runStartUnwrap] auto-seam: 0 seams (${reason}); +${sharpCount} from capsule cap-body fallback (3 islands expected)`);
        }
      } else if (typeof console !== 'undefined') {
        const reason = detectError
          ? `failed: ${detectError} (geometry may be non-indexed)`
          : `0 seams (dihedral ${threshold}° caught nothing)`;
        // detectError → warn (geometry is non-indexed); otherwise info
        const log = detectError ? console.warn : console.info;
        log(`[runStartUnwrap] auto-seam: ${reason}; ABF++ will run on full connected mesh (1 island)`);
      }
    }

    // Step 1b: enforce target island count. If the auto-seam
    // step above produced too many or too few islands, trim
    // or split to match the target. Same as the previous
    // implementation — still useful for power users who
    // want a specific island count for their texture
    // atlas layout.
    if (targetIslands > 0 && seamKeysLocal.size > 0) {
      let dihedralMap = null;
      try { dihedralMap = computeAllDihedrals(geom); }
      catch (_) { dihedralMap = null; }
      const result = enforceTargetIslands(geom, seamKeysLocal, targetIslands, dihedralMap);
      if (result.removed > 0 || result.added > 0) {
        if (typeof console !== 'undefined') {
          console.info(`[runStartUnwrap] target-islands: ${targetIslands} (removed ${result.removed} weakest seams, added ${result.added} split seams)`);
        }
      }
    }
    // Step 2: run ABF++ directly. No cascade (no point
    // trying cheaper solvers first when the user told us
    // ABF++ is the right answer — "select ASF++ and click
    // SMART. then we have a perfect result"). No fallback
    // (ABF++ always produces a result).
    const startMs = performance.now();
    const result = solveWith(geom, 'abf++', {
      seamKeys: seamKeysLocal,
      thresholdDeg: threshold,
      margin,
    });
    // Shared apply+notify skeleton. Use
    // `notifySeamChangeKeepResult` (not `notifySeamChange`)
    // so the live re-unwrap timer doesn't fire 200ms later
    // and overwrite the just-applied ABF++ result with a
    // Tutte re-solve — see the bug in smart-unwrap for the
    // full rationale.
    const added = applyUnwrapAndNotify(geom, result, seamKeysLocal, {
      onAfterApply: recomputeLayout,
      notifySeamChange: notifySeamChangeKeepResult,
      scheduleDraw,
    });
    const ms = (performance.now() - startMs).toFixed(0);
    if (statsEl) {
      statsEl.textContent =
        `✓ DONE: ${result.islandCount} island${result.islandCount === 1 ? '' : 's'} · ` +
        `${result.seamCount} seam${result.seamCount === 1 ? '' : 's'} ` +
        `(${added} auto-added) · ` +
        `solver: ${result.solverId} · ` +
        `max stretch: ${result.maxStretch.toFixed(1)}× · ${ms}ms`;
    }
  }

  /**
   * Toggle the advanced tools section (the '...' button).
   * When shown, the mode picker / transforms / solver picker
   * / view toggles / save-load are revealed. When hidden,
   * only the essential row + START UNWRAP are visible.
   * The state is persisted in the `advancedOpen` `let`
   * variable so closing + reopening the editor preserves
   * the user's choice within the same session.
   */
  function toggleAdvanced() {
    advancedOpen = !advancedOpen;
    const advanced = panelEl && panelEl.querySelector('[data-uv-advanced]');
    if (!advanced) return;
    advanced.classList.toggle('uv-viewer__tools__advanced--hidden', !advancedOpen);
    const moreBtn = panelEl.querySelector('[data-uv-tool="more"]');
    if (moreBtn) {
      moreBtn.classList.toggle('uv-viewer__tool--more--active', advancedOpen);
    }
  }

  /**
   * Toggle between Automatic (cascade) and Expert (manual solver
   * pick via the dropdown) modes. Updates the UI to reflect the
   * new mode — in particular, the solver dropdown is disabled
   * (visually + functionally) when in Auto mode because the
   * cascade ignores it.
   */
  function setSolverMode(mode) {
    if (mode !== 'auto' && mode !== 'expert') return;
    solverMode = mode;
    if (toolsEl) {
      for (const btn of toolsEl.querySelectorAll('[data-uv-mode]')) {
        btn.classList.toggle('uv-viewer__mode-btn--active', btn.dataset.uvMode === mode);
      }
      // Disable the solver dropdown in Auto mode — the cascade
      // auto-picks the best solver, so the user's pick is inert.
      const solverSelect = toolsEl.querySelector('[data-uv-tool="solver-select"]');
      if (solverSelect) {
        solverSelect.disabled = (mode === 'auto');
      }
    }
    if (statsEl) {
      statsEl.textContent = mode === 'auto'
        ? 'Solver mode: AUTO (cascade auto-picks the best solver).'
        : `Solver mode: EXPERT (using ${SOLVER_LABELS[expertSolverId] || expertSolverId}).`;
    }
  }
  /**
   * Find the boundary edges of an island. Returns an array of
   * `[va, vb]` vertex-index pairs — the edges of the island
   * that are touched by exactly ONE face in the island. These
   * are the "naturally cut" edges of the unwrap: the ones that
   * are free to be seams because the geometry already isolates
   * them (open-mesh boundary) or because the user has marked
   * adjacent edges as seams elsewhere.
   *
   * For a closed mesh, an island's boundary IS the seam set
   * restricted to that island — so this function is the
   * "ensure all island boundaries are sealed" operation. For
   * an open mesh, it also picks up the mesh's natural boundary
   * edges (edges with only 1 face in the whole mesh), which
   * would otherwise need to be marked manually.
   */
  /**
   * Mark every boundary edge of every island as a seam. See
   * the boundary-seams tool for the full implementation.
   */
  function markBoundarySeams() {
    boundarySeamsTool.markBoundarySeams();
  }

  // The inline `onKeyDown` function was removed in 2026 —
  // its body now lives in `hotkeysTool.onKeyDown` (see
  // src/systems/uv-tools/hotkeys.js). The orchestrator
  // wires the factory method to the `window` keydown event
  // in `mount()`/`unmount()`.

  // hsvToRgb is imported from ./uv-tools/geometry-utils.js and
  // called directly by drawTool.colorForIsland() in the
  // compute-layout tool. No local wrapper needed — the
  // import is in scope.

  function describeEntity(entity) {
    if (!entity || !entity.spec) return 'Unknown';
    const s = entity.spec;
    const kind = s.seed & 1 ? 'capsule' : 'icosphere';
    return `${kind} #${s.id} (r=${s.radius.toFixed(1)})`;
  }

  // ===========================================================================
  // Drawing
  // ===========================================================================

  function scheduleDraw() {
    if (!enabled) return;
    if (!uvCanvas) return;
    if (rafHandle != null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      drawTool.draw();
    });
  }

  return {
    mount, unmount,
    setEnabled, isEnabled,
    getSelectedAsteroid,
    selectAsteroid, clearSelection,
    // 3D-pick public API (exposed for the edit screen so it
    // can pick the same way the viewer does). Forwarded
    // directly to the pick3DTool — no thin wrapper.
    pickAt3D: pick3DTool.pickAt3D,
    rotateSelection, scaleSelection, mirrorSelection, flipU, flipV,
    runReUnwrap, runAutoUnwrap, saveUnwrap, saveTemplate, loadUnwrap,
    setMode,
    // Exposed so the F hotkey / keydown test can verify the
    // camera moved after a framing operation. Returns a
    // snapshot of the current 2D view state.
    getView: () => ({ panX, panY, zoom }),
    // Exposed for tests + the F hotkey path. The viewer is
    // mounted only when needed, but tests want a public way
    // to exercise the framing math without dispatching a
    // synthetic keydown event.
    frameSelection,
    // Seam state for the 3D mini viewport overlay:
    addSeamChangeListener,
    getSeamState,
    toggleSeamFrom3D,
    dispose,
  };
}

