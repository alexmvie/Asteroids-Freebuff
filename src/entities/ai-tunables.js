/**
 * AI tunables — constants the tuning loop can adjust without
 * touching src/entities/ai.js.
 *
 * These values are imported by ai.js and exposed here so that
 * automated tuning scripts (scripts/ai_tuning_loop.py) can edit
 * a small, well-defined file instead of regex-patching the AI
 * implementation.
 *
 * @file src/entities/ai-tunables.js
 */

export const AI_TUNABLES = Object.freeze({
  /** Heading gate for firing (radians). */
  fireHeadingGate: 0.4,

  /** Heading gate for thrust (radians). */
  thrustHeadingGate: 0.2,

  /** Emergency evade distance (world units). */
  evadeDist: 10,

  /** Maximum distance at which the AI chases a powerup. */
  powerupMaxChaseDist: 350,

  /** Minimum fire distance (world units). */
  fireMinDist: 20,

  /** Maximum fire distance (world units). */
  fireMaxDist: 200,

  /** Heading gate for powerup collection thrust (radians). */
  powerupThrustGate: 0.2,

  /** Bias for asteroid size when choosing a chase target. */
  asteroidSizeBias: 12,
});
