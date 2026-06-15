/**
 * Public surface of the entities module.
 * Consumers should import from `src/entities/index.js` rather than
 * reaching into individual files.
 */

// Player + AI ship.
export { createShip } from './ship.js';

// Asteroid (uses the noisy icosphere or capsule body).
export { CAPSULE_UV_PLANE, createAsteroidFromSpec } from './asteroid.js';

// Bullet pool (fixed-size, pre-allocated).
export { createBulletPool } from './bullet.js';

// Demo AI (NPC ship visible in DEMO state).
export {
  findNearestAsteroid,
  aiBrainTick,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
} from './ai.js';
