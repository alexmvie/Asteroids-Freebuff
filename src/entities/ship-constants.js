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

/**
 * Yaw inertia time constant (seconds). The ship's angular velocity
 * is a state variable that ramps toward `yawInput * YAW_SPEED` with
 * a first-order time constant, instead of being set instantly every
 * frame. Gives the ship a real-spacecraft feel — the heading lags
 * the brain's command by ~`YAW_INERTIA_TAU` seconds, which makes
 * the AI's hand-coded humanization (v0.13.x spin-brake) settle
 * the heading without oscillation.
 *
 * `0` = snap to target each frame (legacy). `0.2` = real-ship feel
 * (takes ~0.2s to start/stop rotating, like a real spacecraft).
 *
 * Why keep this on the hand-coded AI branch: the AI's intercept
 * controller and the chase coast-in use `angularVelocity` to spin-
 * brake (see `intercept(aiPos, aiYaw, aiVel, target, aiAngularVelocity)`
 * in `src/entities/ai.js`). The inertia makes the visible
 * heading change lag the brain's command by exactly the right
 * amount for the spin-brake heuristic to settle the heading
 * without the left/right wobble it had with snap-to-target.
 */
export const YAW_INERTIA_TAU = 0.2;

// ---------------------------------------------------------------------------
// v0.11.0: Energy + buffs (game-side SSOT)
// ---------------------------------------------------------------------------
// This file is the SOLE owner of these constants on the
// `refine-coded-ai` branch (no trainer to lockstep with). The
// game-side ship reads them directly; the power-up system consumes
// `BUFF_DEFAULT_DURATIONS_S` for the active-buff duration on
// pickup. Tweak here and the change propagates automatically.

/** Max ship energy (sole SSOT on the `refine-coded-ai` branch). */
export const MAX_ENERGY = 100;

/** Base energy recharge rate (energy/s). Doubled while the energy
 *  buff is active. */
export const ENERGY_RECHARGE_PER_SEC = 5;

/**
 * Per-buff default duration (seconds). Used by `ship.addBuff(type)`
 * when the caller doesn't pass an explicit `duration`. Shield is
 * intentionally NOT a buff — it's an instant effect: refill +
 * max-100 energy.
 */
export const BUFF_DEFAULT_DURATIONS_S = Object.freeze({
  speed: 5,
  energy: 8,
  credits: 5,
  hull: 12,
  weapon: 10,
  // v0.61.0 — shield grants 10s of invincibility when picked up.
  // Sole SSOT for the duration; the power-up system reads it on
  // activate (see src/systems/powerup-system.js).
  shield: 10,
});
