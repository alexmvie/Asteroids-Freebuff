/**
 * Editor state interface for the UV editor.
 *
 * Thin getter/setter wrapper around the orchestrator's
 * inline `let` variables. The orchestrator builds a bindings
 * object (with closures over its variables) and passes it
 * here; the returned state object exposes the public API the
 * tool factories use. Reads return the current value of the
 * `let` variable; writes update the variable in place. This
 * keeps the orchestrator's inline `let` variables and the
 * tool factories in sync automatically — no parallel state,
 * no drift, no manual sync layer.
 *
 * @fileoverview State interface for `src/systems/uv-unwrap-viewer.js`.
 * The factory takes a bindings object with getter/setter
 * callbacks and returns a state object that delegates to
 * them. The orchestrator's `let` variables remain the
 * single source of truth; the state object is just a
 * read/write interface.
 *
 * @example
 *   const state = createEditorState({
 *     getMode: () => mode,
 *     setMode: (m) => { mode = m; },
 *     getSelectedFaces: () => selectedFaces,
 *     getSnapEnabled: () => snapEnabled,
 *     setSnapEnabled: (v) => { snapEnabled = v; },
 *   });
 *   state.setMode('face');
 *   const isOn = state.getSnapEnabled();
 */

import { UV_EDITOR_CONFIG } from './config.js';

/**
 * Create an editor state interface backed by the orchestrator's
 * `let` variables via closure-bound getters/setters.
 *
 * @param {object} bindings - getter/setter callbacks for each
 *   piece of state. Every binding is required.
 * @returns {object} state with getter/setter methods that
 *   delegate to the bindings
 */
export function createEditorState(bindings) {
  return {
    // Mode
    getMode: bindings.getMode,
    setMode: bindings.setMode,

    // Selections (returned by ref — callers mutate in place)
    getSelectedFaces: bindings.getSelectedFaces,
    getSelectedEdges: bindings.getSelectedEdges,
    getSelectedVertices: bindings.getSelectedVertices,
    clearSelections: bindings.clearSelections,

    // Box-select rect
    getBoxSelectRect: bindings.getBoxSelectRect,
    setBoxSelectRect: bindings.setBoxSelectRect,

    // 2D view camera (pan/zoom)
    getZoom: bindings.getZoom,
    setZoom: bindings.setZoom,
    getPanX: bindings.getPanX,
    setPanX: bindings.setPanX,
    getPanY: bindings.getPanY,
    setPanY: bindings.setPanY,

    // Slice tool endpoints
    getSliceFirst: bindings.getSliceFirst,
    getSliceSecond: bindings.getSliceSecond,
    setSliceFirst: bindings.setSliceFirst,
    setSliceSecond: bindings.setSliceSecond,
    clearSlice: bindings.clearSlice,

    // Visual toggles
    getSnapEnabled: bindings.getSnapEnabled,
    setSnapEnabled: bindings.setSnapEnabled,
    // snap step is a constant from the config, not an
    // orchestrator `let` — return it directly.
    getSnapStep: () => UV_EDITOR_CONFIG.snap.step,
    getHeatmapEnabled: bindings.getHeatmapEnabled,
    setHeatmapEnabled: bindings.setHeatmapEnabled,
    getMeshWireframe: bindings.getMeshWireframe,
    setMeshWireframe: bindings.setMeshWireframe,
    getBackgroundMode: bindings.getBackgroundMode,
    setBackgroundMode: bindings.setBackgroundMode,

    // Seams
    getSeamKeys: bindings.getSeamKeys,
    setSeamKeys: bindings.setSeamKeys,
    clearSeamKeys: bindings.clearSeamKeys,

    // Live re-unwrap toggle
    getLiveUnwrapEnabled: bindings.getLiveUnwrapEnabled,
    setLiveUnwrapEnabled: bindings.setLiveUnwrapEnabled,

    // Solver mode + expert pick
    getSolverMode: bindings.getSolverMode,
    setSolverMode: bindings.setSolverMode,
    getExpertSolverId: bindings.getExpertSolverId,
    setExpertSolverId: bindings.setExpertSolverId,

    // START UNWRAP panel — adjustable parameters that drive
    // the cascade. All have sensible defaults from the config
    // and are read at the moment runStartUnwrap is invoked
    // (so the user can tweak them between presses without
    // re-mounting the editor).
    getAutoSeamEnabled: bindings.getAutoSeamEnabled,
    setAutoSeamEnabled: bindings.setAutoSeamEnabled,
    getAutoSeamThreshold: bindings.getAutoSeamThreshold,
    setAutoSeamThreshold: bindings.setAutoSeamThreshold,
    getPackMargin: bindings.getPackMargin,
    setPackMargin: bindings.setPackMargin,
    getStretchBudget: bindings.getStretchBudget,
    setStretchBudget: bindings.setStretchBudget,
    getTargetIslandCount: bindings.getTargetIslandCount,
    setTargetIslandCount: bindings.setTargetIslandCount,

    // Hover state
    getHoveredEdge: bindings.getHoveredEdge,
    setHoveredEdge: bindings.setHoveredEdge,
    getHoveredFace: bindings.getHoveredFace,
    setHoveredFace: bindings.setHoveredFace,
  };
}
