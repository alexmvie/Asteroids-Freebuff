/**
 * Ship tunables — the single source of truth for ship physics.
 *
 * @fileoverview Previously inline in `src/entities/ship.js`. Extracted
 * to its own file so the ship has a clean SSOT for its physics
 * parameters and consumers can reference them without importing the
 * whole ship module (e.g. for the AI tuning, camera-offset math, etc.).
 *
 * Note: `PLAY_PLANE_Y` is intentionally NOT defined here. The world
 * data-model layer owns the play-plane Y coordinate (the play plane
 * is a world concept, not a ship concept). See
 * `../world/chunk-constants.js`. The ship imports it from there.
 */

/** Thrust acceleration along the facing direction (u/s^2). */
export const THRUST_ACCEL = 60;

/** Hard cap on ship speed (u/s). */
export const MAX_SPEED = 200;

/**
 * Linear drag coefficient (1/seconds). Higher = stronger drag.
 * Implemented as `v *= exp(-LINEAR_DRAG * dt)` so it's
 * framerate-independent.
 */
export const LINEAR_DRAG = 0.4;

/** Yaw rotation rate (rad/s). */
export const YAW_SPEED = 4.0;

/**
 * Max roll (lean) into turns (radians). ~26 degrees at the
 * default 0.45. Higher = more dramatic lean. The roll is
 * applied to the inner body sub-group; the outer group keeps
 * the ship's facing.
 */
export const ROLL_MAX = 0.45;

/**
 * Roll damping coefficient (1/seconds). Higher = snappier lean.
 * Implemented as `roll += (target - roll) * (1 - exp(-ROLL_DAMP * dt))`
 * so it's framerate-independent.
 */
export const ROLL_DAMP = 8.0;
