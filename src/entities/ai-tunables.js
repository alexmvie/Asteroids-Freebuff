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

  // ------------------------------------------------------------------
  // Powerup velocity-error controller tunables
  // ------------------------------------------------------------------

  /** Cruise speed cap when approaching a powerup (u/s). */
  powerupCruiseSpeed: 60,

  /** Minimum average approach speed used to compute the intercept
   *  horizon (u/s). Lower = more accurate prediction for close powerups. */
  powerupMinApproachSpeed: 5,

  /** Gain that maps distance to desired average approach speed
   *  (u/s per unit distance). */
  powerupApproachGain: 0.5,

  /** Braking safety factor (0..1). Multiplies the theoretical max
   *  safe speed (dist * LINEAR_DRAG) to leave margin for errors. */
  powerupBrakeSafetyFactor: 0.8,

  /** Velocity-error magnitude below which the AI coasts (u/s).
   *  Prevents tiny thrust pulses when already on the right velocity. */
  powerupVelocityErrorThreshold: 5,

  /** Distance at which the AI switches to final-approach mode (u/s). */
  powerupFinalApproachDist: 5,

  /** Minimum closing speed to maintain during final approach (u/s).
   *  Prevents stalling just outside the collection radius. */
  powerupFinalApproachSpeed: 3,
});
