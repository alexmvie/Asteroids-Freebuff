/**
 * Hotkeys + tool-dispatch tool factory for the UV editor.
 *
 * Owns the two dispatch tables:
 *   - `handleTool(name)` — maps a `data-uv-tool` button name
 *     (set in `mount()`) to a public orchestrator method.
 *     Called from the toolbar's `click` listeners.
 *   - `onKeyDown(e)` — global keyboard handler. Maps keys
 *     (1/2/3/4, R, S, M, U, V, H, G, X, K, W, A, L, Z, ?, B, F,
 *     [, ], Esc, Ctrl+S, Ctrl+O) to the same public
 *     methods, with Cmd/Ctrl+S and Cmd/Ctrl+O reserved for
 *     save/load. Z now fires the START UNWRAP cascade (not
 *     the bare smart-unwrap); ? / \ toggles the advanced
 *     tools section.
 *
 * Splitting these out of the orchestrator keeps the big
 * `switch` statements in one file and lets the
 * orchestrator focus on lifecycle + DOM wiring.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to complete the per-tool split.
 *
 * @example
 *   const hotkeys = createHotkeysTool(state, deps);
 *   // toolbar click → handleTool('rot') → rotateSelection(15)
 *   // keydown     → onKeyDown(e)     → e.key === 'r' → rotateSelection(15)
 */

const KEYBOARD_HOTKEY_GUARD = (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return true;
  }
  return false;
};

/**
 * Create the hotkeys factory.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => boolean} deps.getEnabled - returns whether the
 *   editor is currently mounted/enabled. The keydown handler
 *   short-circuits to a no-op when disabled so the editor
 *   doesn't fight other UI for keystrokes.
 * @param {() => void} deps.setMode - orchestrator's setMode
 *   (updates the toolbar active state + scheduleDraw)
 * @param {(deg: number) => void} deps.rotateSelection
 * @param {(factor: number) => void} deps.scaleSelection
 * @param {() => void} deps.mirrorSelection
 * @param {() => void} deps.flipU
 * @param {() => void} deps.flipV
 * @param {() => void} deps.toggleSnap
 * @param {() => void} deps.toggleHeatmap
 * @param {() => void} deps.toggleWireframe
 * @param {() => void} deps.toggleLiveUnwrap
 * @param {() => void} deps.clearSeams
 * @param {() => void} deps.runReUnwrap
 * @param {() => void} deps.runAutoUnwrap
 * @param {() => void} deps.runSmartUnwrap
 * @param {() => void} deps.runStartUnwrap
 * @param {() => void} deps.toggleAdvanced
 * @param {() => void} deps.toggleKeyboardLegend
 * @param {() => void} deps.saveUnwrap
 * @param {() => void} deps.saveTemplate
 * @param {() => void} deps.loadUnwrap
 * @param {() => void} deps.startSlice
 * @param {() => void} deps.markBoundarySeams
 * @param {(mode: 'auto' | 'expert') => void} deps.setSolverMode
 * @param {() => void} deps.growSelection
 * @param {() => void} deps.shrinkSelection
 * @param {() => void} deps.frameSelection
 * @param {() => void} deps.cancelSlice
 * @param {() => void} deps.clearSelectionEdit
 * @returns {object} { handleTool, onKeyDown }
 */
export function createHotkeysTool(state, deps) {
  const {
    getEnabled,
    setMode,
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
    toggleKeyboardLegend,
    saveUnwrap,
    saveTemplate,
    loadUnwrap,
    startSlice,
    markBoundarySeams,
    setSolverMode,
    growSelection,
    shrinkSelection,
    frameSelection,
    cancelSlice,
    clearSelectionEdit,
  } = deps;

  /**
   * Dispatch a toolbar `data-uv-tool` value to its handler.
   * The `solver-select` case is a no-op because the `<select>`
   * element fires its own `change` event (handled in `mount()`);
   * listing it in the switch keeps the toolbar-button
   * iteration simple (every button has a data-uv-tool and
   * the click handler routes through here).
   */
  function handleTool(name) {
    switch (name) {
      case 'mode-face': setMode('face'); break;
      case 'mode-edge': setMode('edge'); break;
      case 'mode-vert': setMode('vertex'); break;
      case 'mode-island': setMode('island'); break;
      case 'mode-slice': startSlice(); break;
      case 'rot': rotateSelection(15); break;
      case 'scl-up': scaleSelection(1.1); break;
      case 'scl-dn': scaleSelection(1 / 1.1); break;
      case 'mir': mirrorSelection(); break;
      case 'flip-u': flipU(); break;
      case 'flip-v': flipV(); break;
      case 'snap': toggleSnap(); break;
      case 'heat': toggleHeatmap(); break;
      case 'wire': toggleWireframe(); break;
      case 'boundary': markBoundarySeams(); break;
      case 'clear-seams': clearSeams(); break;
      case 'unwrap': runReUnwrap(); break;
      case 'auto': runAutoUnwrap(); break;
      case 'live': toggleLiveUnwrap(); break;
      case 'save': saveUnwrap(); break;
      // SAVE TEMPLATE: per-type UV template (icosphere or
      // capsule). Writes to localStorage + downloads a
      // distributable JSON file named `asteroid-${type}-uv.json`.
      // See unwrap-io.js's `saveTemplate` for the full
      // rationale.
      case 'save-template': saveTemplate(); break;
      case 'load': loadUnwrap(); break;
      case 'smart-unwrap': runSmartUnwrap(); break;
      // START UNWRAP: the big primary CTA. Routes to the
      // auto-seam + cascade + fallback function. Without
      // this case, clicking the button is a no-op (the
      // switch falls through to the default branch).
      case 'start-unwrap': runStartUnwrap(); break;
      // '...': toggles the advanced tools section.
      case 'more': toggleAdvanced(); break;
      // The solver `<select>` handles its own `change` event;
      // the toolbar click iteration still routes through here
      // because every toolbar element has a `data-uv-tool`.
      case 'solver-select': /* handled by the select's `change` event */ break;
      case 'mode-auto': setSolverMode('auto'); break;
      case 'mode-expert': setSolverMode('expert'); break;
    }
  }

  /**
   * Global keydown handler. Bound to `window` in `mount()`.
   *
   * Short-circuits when:
   *   - the editor is disabled (avoids stealing keystrokes
   *     from other UI panels);
   *   - the focus is inside an `<input>` or `<textarea>` (the
   *     user is typing in a text field, not driving the
   *     editor).
   *
   * Ctrl/Cmd+S and Ctrl/Cmd+O are reserved for save/load —
   * matching the standard "Cmd-S to save" convention across
   * the rest of the app.
   */
  function onKeyDown(e) {
    if (!getEnabled()) return;
    if (KEYBOARD_HOTKEY_GUARD(e)) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); saveUnwrap(); return; }
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); loadUnwrap(); return; }
    }
    switch (e.key) {
      case '1': setMode('face'); break;
      case '2': setMode('edge'); break;
      case '3': setMode('vertex'); break;
      case '4': setMode('island'); break;
      case '[': growSelection(); break;
      case ']': shrinkSelection(); break;
      case 'b': case 'B': startSlice(); break;
      case 'f': case 'F': frameSelection(); break;
      case 'r': case 'R': rotateSelection(15); break;
      case 's': scaleSelection(e.shiftKey ? 1 / 1.1 : 1.1); break;
      case 'm': case 'M': mirrorSelection(); break;
      case 'u': case 'U': flipU(); break;
      case 'v': case 'V': flipV(); break;
      case 'h': case 'H': toggleHeatmap(); break;
      case 'g': case 'G': toggleSnap(); break;
      case 'x': case 'X': toggleWireframe(); break;
      case 'k': case 'K': clearSeams(); break;
      case 'w': case 'W': runReUnwrap(); break;
      case 'a': case 'A': runAutoUnwrap(); break;
      case 'l': case 'L': toggleLiveUnwrap(); break;
      case 'z': case 'Z': runStartUnwrap(); break;
      case '?': case '\\': toggleKeyboardLegend(); break;
      case 'Escape':
        if (state.getMode() === 'slice') cancelSlice();
        else clearSelectionEdit();
        break;
      default: return;
    }
    e.preventDefault();
  }

  return { handleTool, onKeyDown };
}
