/**
 * Public surface of the systems module.
 * Consumers should import from `src/systems/index.js` rather than
 * reaching into individual files.
 */

// Collision (narrow-phase) — pure functions + constants.
export {
  BULLET_RADIUS,
  SHIP_RADIUS,
  SCORE_BY_SIZE,
  spheresOverlap,
  findBulletHits,
  findShipHit,
  scoreForSize,
} from './collision.js';

// Event bus (pub/sub).
export { createEventBus } from './events.js';

// State machine (DEMO / PLAYING / GAME_OVER).
export { State } from './state-types.js';
export { createStateMachine } from './state.js';

// Input (keyboard).
export {
  createInputState,
  bindKeyboard,
  tickInput,
  createInputSystem,
} from './input.js';

// Starfield (procedural Three.js Points).
export { createStarfield } from './starfield.js';

// Nebula background (skydome).
export { createNebulaBackground } from './nebula-background.js';
export { createNebulaDebugOverlay } from './nebula-debug-overlay.js';

// Asteroid field (streaming + entity lifecycle).
export { createAsteroidField } from './asteroid-field.js';
export { createParticleSystem } from './particles.js';
