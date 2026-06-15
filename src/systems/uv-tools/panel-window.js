import { UV_EDITOR_CONFIG } from './config.js';

/**
 * Create the panel-window tool.
 *
 * Owns the floating panel's window-management behavior:
 *   - **Drag** the panel by its header (sets `dragging =
 *     'panel'`, tracks the delta from the initial
 *     grab-rect, clamps to the viewport via
 *     `UV_EDITOR_CONFIG.panelHeaderDrag.keepOnScreenWidth/Height`)
 *   - **Resize** by dragging the bottom-right grip
 *     (sets `dragging = 'resize'`, tracks the delta
 *     from the initial grab-rect, clamps to the
 *     viewport via `UV_EDITOR_CONFIG.panel.viewportPaddingX`
 *     + `panel.minWidth/Height`)
 *   - **2D canvas resize** when the panel is resized
 *     (adjusts the canvas's pixel buffer to match the
 *     new CSS size at the current device pixel ratio,
 *     then schedules a redraw)
 *   - **localStorage persistence** of the panel's rect
 *     on every drag/resize commit, so the next mount
 *     restores the position + size
 *
 * The factory shares the `dragging` and `dragStart` state
 * with the 2D-canvas pointer handlers (which use the same
 * `dragging` variable to track pan/translate/box-select
 * drags). Both sides read/write the variables via the
 * `getDragging`/`setDragging`/`getDragStart`/`setDragStart`
 * deps — neither side owns the variables outright. The
 * factory owns `initialPanelRect` privately (it's only
 * used by the panel drag/resize flow).
 *
 * @param {object} _state - editor state (unused; accepted
 *   for consistency with the other tool factories)
 * @param {object} deps
 * @param {() => HTMLElement | null} deps.getPanelEl - the
 *   floating panel element (set in `mount()`)
 * @param {() => HTMLElement | null} deps.getPanelHeader -
 *   the panel header (drag handle)
 * @param {() => HTMLElement | null} deps.getResizeGrip -
 *   the bottom-right resize grip
 * @param {() => HTMLCanvasElement | null} deps.getUvCanvas -
 *   the 2D canvas inside the panel (resized on panel resize)
 * @param {() => CanvasRenderingContext2D | null} deps.getUvCtx -
 *   the 2D canvas's 2D context
 * @param {() => string | null} deps.getDragging - shared
 *   with the 2D-canvas handlers; one of
 *   `'pan' | 'translate' | 'box' | 'panel' | 'resize' | null`
 * @param {(d: string | null) => void} deps.setDragging
 * @param {() => object | null} deps.getDragStart
 * @param {(d: object | null) => void} deps.setDragStart
 * @param {() => void} deps.scheduleDraw
 * @returns {{
 *   onPanelHeaderDown: (e: PointerEvent) => void,
 *   onResizeGripDown: (e: PointerEvent) => void,
 *   onWindowPointerMove: (e: PointerEvent) => void,
 *   onWindowPointerUp: (e: PointerEvent) => void,
 *   resizeCanvas: () => void,
 *   persistPanelRect: () => void,
 * }}
 */
export function createPanelWindowTool(_state, deps) {
  const {
    getPanelEl,
    getPanelHeader,
    getResizeGrip,
    getUvCanvas,
    getUvCtx,
    getDragging,
    setDragging,
    getDragStart,
    setDragStart,
    scheduleDraw,
  } = deps;

  if (typeof getPanelEl !== 'function') {
    throw new Error('createPanelWindowTool: `getPanelEl` must be a function');
  }
  if (typeof getPanelHeader !== 'function') {
    throw new Error('createPanelWindowTool: `getPanelHeader` must be a function');
  }
  if (typeof getResizeGrip !== 'function') {
    throw new Error('createPanelWindowTool: `getResizeGrip` must be a function');
  }
  if (typeof getUvCanvas !== 'function') {
    throw new Error('createPanelWindowTool: `getUvCanvas` must be a function');
  }
  if (typeof getUvCtx !== 'function') {
    throw new Error('createPanelWindowTool: `getUvCtx` must be a function');
  }
  if (typeof getDragging !== 'function') {
    throw new Error('createPanelWindowTool: `getDragging` must be a function');
  }
  if (typeof setDragging !== 'function') {
    throw new Error('createPanelWindowTool: `setDragging` must be a function');
  }
  if (typeof getDragStart !== 'function') {
    throw new Error('createPanelWindowTool: `getDragStart` must be a function');
  }
  if (typeof setDragStart !== 'function') {
    throw new Error('createPanelWindowTool: `setDragStart` must be a function');
  }
  if (typeof scheduleDraw !== 'function') {
    throw new Error('createPanelWindowTool: `scheduleDraw` must be a function');
  }

  // The panel's rect at the moment the user grabbed the
  // header/resize grip. Stored here (not in the
  // orchestrator's `let` block) because only the panel
  // drag/resize flow needs it. Cleared on pointerup.
  let initialPanelRect = null;

  /**
   * Pointerdown on the panel header → start a panel drag.
   * Captures the pointer on the header so the drag
   * continues even if the cursor leaves the header.
   * The window-level `onWindowPointerMove`/`onWindowPointerUp`
   * listeners do the actual drag math.
   */
  function onPanelHeaderDown(e) {
    const panelHeader = getPanelHeader();
    const panelEl = getPanelEl();
    if (e.target.closest('.uv-viewer-close')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    try { panelHeader.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const rect = panelEl.getBoundingClientRect();
    initialPanelRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragging('panel');
  }

  /**
   * Pointerdown on the resize grip → start a panel resize.
   * Same capture pattern as the header drag.
   */
  function onResizeGripDown(e) {
    const resizeGrip = getResizeGrip();
    const panelEl = getPanelEl();
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { resizeGrip.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const rect = panelEl.getBoundingClientRect();
    initialPanelRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragging('resize');
  }

  /**
   * Window-level pointermove. Handles BOTH panel drag
   * (`dragging === 'panel'`) and panel resize
   * (`dragging === 'resize'`). The 2D-canvas pan/translate/
   * box-select drags are handled by the canvas's own
   * pointermove listener; the window-level handler skips
   * them by checking `dragging` value.
   *
   * The drag math:
   *   - **Panel drag**: clamp the new top-left to the
   *     viewport using `UV_EDITOR_CONFIG.panelHeaderDrag.
   *     keepOnScreenWidth/Height` so the header never
   *     disappears off-screen.
   *   - **Panel resize**: clamp the new width/height to
   *     the viewport using `UV_EDITOR_CONFIG.panel.
   *     viewportPaddingX` + `panel.minWidth/Height` so the
   *     panel never shrinks below the minimum or grows
   *     past the viewport. After changing the size, calls
   *     `resizeCanvas()` to update the 2D canvas's pixel
   *     buffer.
   */
  function onWindowPointerMove(e) {
    const dragging = getDragging();
    const dragStart = getDragStart();
    if (!dragging) return;
    if (dragging === 'panel' && dragStart && initialPanelRect) {
      const panelEl = getPanelEl();
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const drag = UV_EDITOR_CONFIG.panelHeaderDrag;
      const nx = Math.max(0, Math.min(vw - drag.keepOnScreenWidth, initialPanelRect.x + dx));
      const ny = Math.max(0, Math.min(vh - drag.keepOnScreenHeight, initialPanelRect.y + dy));
      panelEl.style.left = `${nx}px`;
      panelEl.style.top = `${ny}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    } else if (dragging === 'resize' && dragStart && initialPanelRect) {
      const panelEl = getPanelEl();
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const pad = UV_EDITOR_CONFIG.panel.viewportPaddingX;
      const nw = Math.max(UV_EDITOR_CONFIG.panel.minWidth, Math.min(vw - pad, initialPanelRect.width + dx));
      const nh = Math.max(UV_EDITOR_CONFIG.panel.minHeight, Math.min(vh - pad, initialPanelRect.height + dy));
      panelEl.style.width = `${nw}px`;
      panelEl.style.height = `${nh}px`;
      resizeCanvas();
    }
  }

  /**
   * Window-level pointerup/pointercancel. On panel
   * drag/resize commit, persists the new rect to
   * localStorage so the next mount restores it. Then
   * clears the drag state (shared with the 2D-canvas
   * handlers).
   */
  function onWindowPointerUp(_e) {
    const dragging = getDragging();
    // The orchestrator's `onCanvasPointerUp` backup branch
    // may have already cleared the shared drag state (when
    // the pointer is released over the 2D canvas, that
    // handler fires first in the target phase). If so, this
    // window-level handler is a no-op — the early-return
    // avoids the triple-clear race.
    if (!dragging) return;
    if (dragging === 'panel' || dragging === 'resize') {
      persistPanelRect();
    }
    setDragging(null);
    setDragStart(null);
    initialPanelRect = null;
  }

  /**
   * Resize the 2D canvas's pixel buffer to match its
   * current CSS size at the current device pixel ratio.
   * Clamps the CSS size to a minimum of 320×200 (so the
   * canvas never collapses to 0). Resets the 2D context's
   * transform to (dpr, 0, 0, dpr, 0, 0) so 1 unit in
   * canvas-space = 1 CSS pixel. Schedules a redraw.
   *
   * Called on:
   *   - initial mount (after `uvCtx = uvCanvas.getContext('2d')`)
   *   - the window `resize` event (so the canvas tracks
   *     the browser window size)
   *   - the panel resize branch of `onWindowPointerMove`
   *     (so the canvas tracks the panel's new size)
   */
  function resizeCanvas() {
    const uvCanvas = getUvCanvas();
    const uvCtx = getUvCtx();
    if (!uvCanvas || !uvCtx) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const rect = uvCanvas.getBoundingClientRect();
    const cssW = Math.max(rect.width, 320);
    const cssH = Math.max(rect.height, 200);
    if (uvCanvas.width !== Math.round(cssW * dpr) ||
        uvCanvas.height !== Math.round(cssH * dpr)) {
      uvCanvas.width = Math.round(cssW * dpr);
      uvCanvas.height = Math.round(cssH * dpr);
    }
    uvCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }

  /**
   * Save the panel's current rect (left, top, width,
   * height) to `localStorage` under the key
   * `UV_EDITOR_CONFIG.persistenceKey`. The next `mount()`
   * reads this key and restores the position + size.
   * Silently no-ops if the panel isn't mounted or
   * localStorage throws (e.g., private mode, quota).
   */
  function persistPanelRect() {
    const panelEl = getPanelEl();
    if (!panelEl) return;
    try {
      const rect = panelEl.getBoundingClientRect();
      localStorage.setItem(UV_EDITOR_CONFIG.persistenceKey, JSON.stringify({
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      }));
    } catch (_) { /* ignore */ }
  }

  return {
    onPanelHeaderDown,
    onResizeGripDown,
    onWindowPointerMove,
    onWindowPointerUp,
    resizeCanvas,
    persistPanelRect,
  };
}
