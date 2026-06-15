/**
 * Nebula visual constants.
 * Single source of truth for the procedural nebula skydome
 * (see `src/systems/nebula-background.js` + `nebula-debug-overlay.js`).
 *
 * @fileoverview Previously consolidated in `src/world/constants.js`.
 * Extracted to its own file so visual-system constants aren't mixed
 * with world-data-model constants.
 */

/**
 * Smoothing time constant (seconds) for the nebula fade in/out as
 * the ship crosses the `NEBULA_RENDER_THRESHOLD` boundary between
 * chunks. Higher = slower fade (more "in deep space" feel); lower
 * = snappier transitions.
 */
export const NEBULA_FADE_S = 0.6;

/**
 * The "1 = in a nebula chunk" full opacity of the nebula background.
 * Below 1.0 lets stars bleed through even in a nebula, which gives
 * a more cinematic look (the nebula is a tint over the stars, not a
 * curtain). 1.0 = opaque, 0.0 = invisible. 0.85 is the default.
 */
export const NEBULA_MAX_OPACITY = 0.85;

/**
 * Debug flag for the nebula threshold overlay. When true, the
 * render loop draws a small colored marker at the center of every
 * chunk in the active bubble:
 *   - green  = chunk's density > NEBULA_RENDER_THRESHOLD (nebula on)
 *   - red    = chunk's density ≤ NEBULA_RENDER_THRESHOLD (nebula off)
 * The marker sits 5 units above the play plane, so it's visible
 * from the chase camera. Toggle with `window.NEBULA_DEBUG = true`
 * in the browser devtools.
 */
export const NEBULA_DEBUG_DEFAULT = false;
