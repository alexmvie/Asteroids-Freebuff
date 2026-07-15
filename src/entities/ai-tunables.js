/**
 * AI tunables — constants the tuner panel in src/ui/ai-tuners-panel.js
 * can adjust at runtime.
 *
 * ARCHITECTURE
 * ------------
 * This is the single source of truth (SSOT) for every demo-AI
 * tunable. Two exports:
 *
 *   - `AI_TUNABLE_DEFAULTS` — frozen Object containing the production
 *     defaults for every key. Never mutated. Used by:
 *       • `resetAITunables()` to restore the live config
 *       • tests that pin the canonical defaults
 *       • the tuner panel's reset button (renders the same numbers
 *         back into the live bag)
 *
 *   - `AI_TUNABLES` — plain mutable object, mirror copy of the
 *     defaults. THIS is what src/entities/ai.js reads every tick.
 *     Every slider in the tuner panel writes directly to keys on
 *     this object. New keys must be added to BOTH the frozen
 *     defaults AND the live bag.
 *
 * Why mutable (instead of the project's usual `Object.freeze` SSOT
 * pattern): the ship / camera / world constants are *invariants*
 * (the ship physics constants really should not change at runtime).
 * AI tunables are *parameters* — they're meant to be tweaked. Keeping
 * them frozen defeated the entire purpose of having a tunable
 * surface. The frozen defaults export preserves the SSOT contract
 * for "what are the canonical defaults" without preventing runtime
 * experimentation.
 *
 * Consumers
 * ---------
 *   - src/entities/ai.js — reads `AI_TUNABLES.X` via the ctx object
 *     passed to every behavior. The brain services one decision per
 *     tick, so a slider drag is visible on the very next frame.
 *   - src/ui/ai-tuners-panel.js — writes to `AI_TUNABLES.X` from
 *     <input type="range"> events.
 *   - src/ui/ai-debug-overlay.js — reads `AI_TUNABLES.X` for the
 *     "what threshold just fired" rows in the WHY panel.
 *   - scripts/ai_tuning_loop.py — keeps working (it edits the source
 *     file), but is no longer the primary workflow.
 *
 * @file src/entities/ai-tunables.js
 */

export const AI_TUNABLE_DEFAULTS = Object.freeze({
  // ----------------------------------------------------------------
  // Fire discipline
  // ----------------------------------------------------------------

  /** Heading gate for firing (radians). Wider = looser aim. */
  fireHeadingGate: 0.4,

  /** Minimum fire distance (world units). Closer asteroids ignored. */
  fireMinDist: 20,

  /** Maximum fire distance (world units). Far asteroids ignored. */
  fireMaxDist: 200,

  /** Bullet speed (world units per second). Used for lead prediction. */
  bulletSpeed: 400,

  // ----------------------------------------------------------------
  // Thrust
  // ----------------------------------------------------------------

  /** Heading gate for thrust (radians). Aligned -> thrust ON. */
  thrustHeadingGate: 0.2,

  /** Yaw deadband (radians). Inside this band, AI commands no yaw. */
  yawDeadband: 0.10,

  // ----------------------------------------------------------------
  // Evade
  // ----------------------------------------------------------------

  /** Emergency evade distance (world units). nearest.dist < evadeDist -> EVADE. */
  evadeDist: 10,

  // ----------------------------------------------------------------
  // Powerup collection (collectBehavior)
  // ----------------------------------------------------------------

  /** Powerup chase radius (world units). Beyond this, AI ignores. */
  powerupMaxChaseDist: 350,

  /** Heading gate for powerup thrust (radians). Tighter than asteroids. */
  powerupThrustGate: 0.2,

  /** Sticky commitment time (seconds). Once chasing a powerup, stay on it. */
  powerupStickyTime: 3.0,

  /** Cruise speed cap when approaching a powerup (u/s). */
  powerupCruiseSpeed: 60,

  /** Minimum average approach speed used to compute the intercept horizon (u/s). */
  powerupMinApproachSpeed: 5,

  /** Gain mapping distance to desired avg approach speed (u/s per u). */
  powerupApproachGain: 0.5,

  /** Braking safety factor (0..1). Multiplies (dist * LINEAR_DRAG) margin. */
  powerupBrakeSafetyFactor: 0.8,

  /** Velocity-error magnitude below which the AI coasts (u/s). */
  powerupVelocityErrorThreshold: 5,

  /** Distance at which the AI switches to final-approach mode (u). */
  powerupFinalApproachDist: 5,

  /** Minimum closing speed to maintain during final approach (u/s). */
  powerupFinalApproachSpeed: 3,

  /** Laser fire heading gate (radians). Tight cone for the laser. */
  laserFireHeadingGate: 0.30,

  // ----------------------------------------------------------------
  // Target selection (pickTarget)
  // ----------------------------------------------------------------

  /** Bias for asteroid size when choosing a chase target (u / size-class). */
  asteroidSizeBias: 12,

  /** Half-angle of the forward cone used for target priority. */
  forwardConeHalfAngle: Math.PI / 2,

  /** Powerups that are near-behind are still chased (world units). */
  powerupNearBehindThreshold: 40,
});

const LIVE_TUNABLES = { ...AI_TUNABLE_DEFAULTS };

/**
 * Plain mutable bag. Mirrors {@link AI_TUNABLE_DEFAULTS} keys.
 * Read by src/entities/ai.js each tick; written by the tuner
 * panel's input handlers.
 *
 * Direct assignment is the contract: `AI_TUNABLES.fireHeadingGate = 0.5`
 * takes effect on the next brain tick. No setters, no proxies — the
 * UI does ~120 writes/second while a slider is being dragged and
 * proxies add measurable overhead at that rate.
 *
 * Keys not present here MUST be added to BOTH `LIVE_TUNABLES` (here)
 * AND `AI_TUNABLE_DEFAULTS` (above) — otherwise `resetAITunables()`
 * will silently lose them and the tuner panel will show no slider.
 */
export const AI_TUNABLES = LIVE_TUNABLES;

/**
 * Restore all live tunable values to their frozen defaults. Wired to
 * the tuner panel's "RESET" button.
 *
 * Mutates the live bag in place so observers (`ai.js`, debug
 * overlay) read fresh defaults on the next read without any
 * invalidation ceremony.
 */
export function resetAITunables() {
  Object.assign(LIVE_TUNABLES, AI_TUNABLE_DEFAULTS);
}

/**
 * Snapshot the live tunable values as a plain JSON-safe object.
 * Used by the tuner panel's "COPY JSON" button to produce a paste-
 * ready snippet.
 */
export function exportAITunables() {
  return { ...LIVE_TUNABLES };
}

/**
 * Apply a snapshot (e.g. from a JSON paste) to the live tunables.
 * Unknown keys are dropped — the live bag never grows new entries.
 * NaN / non-number values are rejected.
 *
 * @param {object|null|undefined} snapshot
 */
export function applyAITunables(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const key of Object.keys(AI_TUNABLE_DEFAULTS)) {
    const v = snapshot[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      LIVE_TUNABLES[key] = v;
    }
  }
}
