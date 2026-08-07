/**
 * Public surface of the ui module.
 * Consumers should import from `src/ui/index.js` rather than
 * reaching into individual files.
 */

// HUD (top bar + attract-mode overlay).
export { createHud, formatScore } from './hud.js';

// Debug HUD (FPS, state, score, scene geometry stats).
export { createDebugHud } from './debug-hud.js';

// Column toggle (shared by the debug column + the AI tuners column).
export { createColumnToggle } from './column-toggle.js';
