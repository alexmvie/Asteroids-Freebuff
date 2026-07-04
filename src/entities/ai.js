/**
 * Demo AI — an NPC ship for the DEMO attract state.
 *
 * v0.20.x — ground-up simplification. The previous architecture pinned
 * a 4-mode priority (DODGE > HUNT > TARGET > WANDER) on top of a
 * over-instrumented v0.12.x-v0.18.x stack (BRAKE/Spin-Brake sub-phases,
 * predictive-DODGE kinematics, target-prediction look-ahead, P300
 * reaction-latency buffer, mode-hysteresis cache, fire-cadence gate,
 * yawHoldTimeS/thrustHoldTimeS debounce). The interactions between
 * these layers were producing the visible "besoffen" (drunken)
 * behavior: predictive-DODGE firing on graze-passes, mode-hysteresis
 * reusing cached decisions at boundary cliffs, lead-fire ship-thrust-
 * strobing, and a BRAKE phase tuned for moving asteroids that
 * pathological-flipped the ship when chasing a static power-up.
 *
 * The new AI is a single-mode shooter. The user's stated intent —
 * "suche nächstgelegenen Asteroid → flieg in Schussreichweite →
 * feuer bis split → sammle extra → feuer weiter → fliege und lenke
 * so wenig wie möglich" — maps to three branches:
 *
 *   1. PANIC-DODGE  — within `panicDist`, thrust 90° perpendicular
 *                     to the nearest asteroid. Pure reflex, no
 *                     predictive kinematics, no BRAKE/Spin-Brake.
 *   2. ENGAGE       — otherwise: pick the best in-range target
 *                     (`pickTarget`) and apply the simple
 *                     `engageController` (turn-to-face + thrust-
 *                     when-aligned). No closing-speed throttle, no
 *                     inertia-opposing spin-brake. The ship's
 *                     `YAW_INERTIA_TAU=0.2` does the natural
 *                     settling. Fire at any asteroid in cone on
 *                     every engaged tick ("feuer bis split").
 *   3. IDLE         — no targets in range: stop, no thrust. The
 *                     strict "fly as little as possible" branch.
 *
 * The pure helpers (`engageController`, `pickTarget`, the simple
 * panic-dodge inline in `aiBrainTick`) are deterministic and easy
 * to reason about. The factory wrapper is now nearly trivial
 * — no observation buffer, no hysteresis cache, no debouncer, no
 * fire-cadence gate. The brain ticks; the ship reflects.
 *
 * The target-prioritization rule (`powerupBiasU: -30` default)
 * biases toward asteroids unless a powerup is significantly closer
 * (more than 30u) than the nearest asteroid — strictly opportunistic
 * pickup, matching the user's "ab und zu mal das extra einsammeln".
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU } from './ship-constants.js';

const DEFAULTS = Object.freeze({
  /** Reset the AI ship if it drifts beyond this radius from origin. */
  resetDist: 220,
  /** Spawn radius (XZ) for the initial position + on-reset placement. */
  spawnRadius: 30,
  /** Vertical jitter on spawn (cosmetic; scene has flat Y anyway). */
  spawnJitterY: 0,
  /** Initial yaw (radians). */
  spawnYaw: 0,

  /**
   * Maximum chase range (world units) for any target. Asteroids and
   * powerups beyond this fall through to IDLE.
   *
   * v0.21.x — `Infinity` (was 300 in v0.21.0). The user reported
   * "egal wie weit Asteroiden entfernt sind, der nächstgelegene
   * ist zu attackieren". With Infinity, the only IDLE condition
   * is `asteroids === []` (an empty streaming buffer, e.g., at
   * session-start before the first chunk loads). At any time the
   * bubble contains ≥1 asteroid, the bot engages it — no range cap.
   * For tests, finite targetDist values still work (the predicate
   * is `nearest.dist < targetDist`, so smaller overrides reduce
   * the chase range as expected).
   */
  targetDist: Infinity,

  /**
   * Powerup detour bias (world units). Powerup wins over the
   * in-range nearest asteroid if
   *   `powerupDist < asteroidDist + powerupBiasU`.
   * Negative bias = strictly opportunistic (powerup must be
   * significantly closer to win). Zero = nearest entity wins
   * (favors powerups). Positive = strongly favor powerups.
   * Default -30 keeps the AI focused on asteroids unless the
   * powerup is dramatically closer.
   */
  powerupBiasU: -30,

  /**
   * Panic-dodge distance (world units). When the nearest asteroid
   * is closer than this, the AI thrusts 90° perpendicular — pure
   * reflex, no predictive kinematics. Default 6u.
   *
   * The trigger condition is `nearest.dist < panicDist`, so a
   * SMALLER panicDist yields FEWER dodge triggers (more committed
   * chase), a LARGER panicDist yields MORE triggers (more reactive).
   * 6u is the sweet spot: tight enough that 3–5u grazing-passes
   * don't trigger spurious dodge bursts, wide enough that head-on
   * collisions (≤4u) still get a panic-reflex.
   */
  panicDist: 6,

  /**
   * Half-angle of the fire cone (radians). Fire:true when any
   * asteroid appears within this cone relative to the ship's
   * facing direction. Default 0.35 rad ≈ 20°. Matches the legacy
   * default from v0.11.x.
   */
  fireConeHalfAngle: 0.35,

  /**
   * v0.22.x (Distance-aware Fire) — minimum distance (world units)
   * at which the ship fires a bullet at an asteroid. Asteroids
   * below this distance are skipped to avoid (a) close-range
   * overspraying on bypass passes, (b) wasted shots when the ship
   * is already in impact range. Combined with `fireMaxDist` this
   * gives a calm-and-disciplined fire pattern:
   *   - ship closes inside fireMinDist → no bullet (already in
   *     impact range, want to maneuver not waste ammo)
   *   - ship beyond fireMaxDist → no bullet (wide-cone shots miss,
   *     ammo conservation)
   * The default 25u is the "sweet spot": not too close, not too
   * far. The user-reported complaint was "wild ballern" in
   * approaching targets — v0.21.x fired at any close asteroid
   * regardless of distance, creating spray arcs on bypass passes.
   */
  fireMinDist: 25,

  /**
   * v0.22.x (Distance-aware Fire) — maximum distance (world units)
   * at which the ship fires a bullet at an asteroid. Asteroids
   * beyond this distance are skipped (the wide fire cone at long
   * range produces mostly-missed shots; better to close in first).
   * Combined with `fireMinDist` this brackets the bullet's
   * effective fire window. The default 55u is well within bullet
   * speed (400 u/s) × reaction time (≈0.5s) so even distant
   * asteroids give the AI a few frames to close in before firing.
   */
  fireMaxDist: 55,

  /**
   * v0.22.x (Laser-Awareness) -- tight cone (~3 deg) for laser
   * mode lock-on. When activeWeapon === 'laser', the fire-loop
   * uses this narrow cone instead of bullet-mode's ~20 deg cone.
   * The user-reported "kein Plan was das Ship im Laser-Modus
   * tut" symptom is solved: bot's beam lines up with target
   * BEFORE firing (continuous beam + tight aim = turret mode),
   * no more wide sweep with mostly-misses.
   */
  laserFireConeHalfAngle: 0.05,

  /**
   * Lookahead horizon (seconds) for predictive collision avoidance.
   * v0.22.x — fires when ANY asteroid projects within
   * `lookaheadMinRadius` of the ship within this window. Default
   * 3.5s gives the bot a ~3.5s warning before entering a cluster —
   * enough to thrust-perpendicular and step off the flight path.
   *
   * User-feedback rationale: at v0.21.x the bot would fly
   * straight INTO asteroid swarms and get torn apart by the
   * split pieces. PANIC-DODGE only triggers at 6u (already too
   * late — ship is inside the cluster). Lookahead gives the bot
   * the STRATEGIC decision to break off BEFORE the cluster is
   * in panic range.
   */
  lookaheadTime: 3.5,

  /**
   * Lookahead miss-distance threshold (world units). The lookahead-
   * dodge branch fires when an asteroid projects within this radius
   * of the ship within `lookaheadTime` seconds. Default 6.0u gives
   * a generous clearing margin — ship will thrust-perpendicular to
   * avoid having a planet-size rock drift past its wing. Should be
   * larger than `panicDist` (the reflexive inner shell) so the two
   * shells don't overlap (avoidance-then-panic-touch).
   */
  lookaheadMinRadius: 6.0,
});

// --------------------------------------------------------------------------
// Private helpers
// --------------------------------------------------------------------------

/**
 * Normalize an angle to (-PI, PI]. The brain compares angles in a
 * single range to avoid ±2π wrap ambiguity in yaw steering.
 * @param {number} a
 * @returns {number}
 */
function wrapAngle(a) {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

// engageController deadband constants. Lifted to module scope so the
// BRAKE and APPROACH branches use the same steering tolerance and the
// thrust-on rules are namespaced — future tuning changes happen in
// one place rather than across two branches.
const YAW_DEADBAND = 0.15;             // both branches: yaw=±1 outside; yaw=0 inside
const APPROACH_THRUST_GATE = 0.30;     // APPROACH: thrust on when |targetDiff| < this AND closing slower than desired
const BRAKE_THRUST_GATE = Math.PI - 0.30;  // BRAKE: thrust on when facing ≤162° away from brake direction (avoid thrust-forward)

// --------------------------------------------------------------------------
// Exported pure helpers
// --------------------------------------------------------------------------

/**
 * Convert a ship rotation `yaw` (the convention used by `ship.js`,
 * where the forward vector is `(-sin(yaw), 0, -cos(yaw))`) into the
 * angle of that forward vector in the standard (x, z) `atan2(z, x)`
 * space used by the rest of the brain. `yaw = 0` means the ship
 * faces -Z, which in `atan2(z, x)` space is `-π/2`.
 *
 * @param {number} yaw  radians (ship.js convention)
 * @returns {number}    radians in (-PI, PI], atan2(z, x) convention
 */
export function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/**
 * Find the nearest asteroid to a point. Returns `null` if the list
 * is empty. Each asteroid must expose `getPosition()` returning
 * `{x,y,z}` (a live Three.js Vector3 or a plain object); the brain
 * only reads `.x` and `.z`.
 *
 * @param {{x:number,z:number}} pos
 * @param {Array<{getPosition: () => {x:number,z:number}}>} asteroids
 * @returns {{ dx:number, dz:number, dist:number, asteroid: any } | null}
 */
export function findNearestAsteroid(pos, asteroids) {
  let best = null;
  let bestDist = Infinity;
  for (const a of asteroids) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const p = a.getPosition();
    if (!p) continue;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      best = { dx, dz, dist: d, asteroid: a };
    }
  }
  return best;
}

/**
 * Pure kinematic helper: compute the time and distance at which the
 * ship at `aiPos` moving with velocity `aiVel` would be CLOSEST to a
 * static point at `targetPos` (XZ-plane). For the v0.22.x LOOKAHEAD-
 * DODGE branch: asteroids in this codebase have <0.5u/s ambient drift
 * (per MAX_ASTEROID_DRIFT in src/world/chunk-constants.js), so
 * treating them as static is a good approximation at MVP scale.
 *
 * Returns `{ tStar, projDist, valid }`:
 *   - `tStar`     — seconds. Positive = future closest approach.
 *                   Negative = target already past (currently moving
 *                   away from ship, no future threat).
 *                   Infinity = no relative motion (ship is stationary;
 *                   the closest distance is the current distance, no
 *                   time component).
 *   - `projDist`  — world units. Closest projected distance at t*;
 *                   falls back to current distance when tStar is
 *                   negative or infinite.
 *   - `valid`     — false when any input was malformed.
 *
 * Math (target static → relative velocity = -aiVel):
 *   relPos0  = targetPos - aiPos      (vector from ship to target, t=0)
 *   relVel   = -aiVel                 (target stays put; ship moves)
 *   tStar    = -(relPos0 · relVel) / ||relVel||²
 *            = (relPos0 · aiVel) / ||aiVel||²
 *   projDist² = ||relPos0||² - (relPos0 · relVel)² / ||relVel||²
 *
 * Edge cases:
 *   - aiVel is zero (stationary ship): tStar returns Infinity,
 *     projDist returns current distance. The LOOKAHEAD-DODGE branch
 *     treats this as "no trajectory threat, fall through to PANIC".
 *   - tStar < 0: target is already receding relative to ship motion;
 *     return tStar unchanged + current distance. Brain treats this
 *     as "safe, no threat".
 *
 * Used by the v0.22.x aiBrainTick LOOKAHEAD-DODGE branch to project
 * "if I keep flying this heading, will any asteroid pass within
 * lookaheadMinRadius of me inside lookaheadTime?" — if yes, thrust
 * perpendicular to escape the trajectory. Solves the v0.21.x
 * "flies straight into asteroid swarms" complaint.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos
 * @returns {{ tStar: number, projDist: number, valid: boolean }}
 */
export function computeClosestApproachTime(aiPos, aiVel, targetPos) {
  if (!aiPos || typeof aiPos.x !== 'number') {
    return { tStar: Infinity, projDist: Infinity, valid: false };
  }
  if (!targetPos || typeof targetPos.x !== 'number') {
    return { tStar: Infinity, projDist: Infinity, valid: false };
  }
  if (!aiVel || typeof aiVel.x !== 'number') {
    return { tStar: Infinity, projDist: Infinity, valid: false };
  }
  const rx = targetPos.x - aiPos.x;
  const rz = targetPos.z - aiPos.z;
  const vx = -aiVel.x;
  const vz = -aiVel.z;
  const vMagSq = vx * vx + vz * vz;
  // No relative motion: ship is stationary. Closest distance is
  // current distance; tStar is meaningless (Infinity).
  if (vMagSq < 1e-6) {
    return { tStar: Infinity, projDist: Math.hypot(rx, rz), valid: true };
  }
  const tStar = -(rx * vx + rz * vz) / vMagSq;
  // Target currently moving away → no future trajectory threat.
  if (tStar < 0) {
    return { tStar, projDist: Math.hypot(rx, rz), valid: true };
  }
  // projDist² = ||relPos||² - (relPos · relVel)² / ||relVel||²
  const rMagSq = rx * rx + rz * rz;
  const rDotV = rx * vx + rz * vz;
  const projDistSq = rMagSq - (rDotV * rDotV) / vMagSq;
  const projDist = Math.sqrt(Math.max(0, projDistSq));
  return { tStar, projDist, valid: true };
}

/**
 * True if the given target position is in front of a ship at
 * `aiPos` facing `aiYaw`, within a half-angle cone of `halfAngle`.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw  radians
 * @param {{x:number,z:number}} targetPos
 * @param {number} halfAngle  radians (e.g. 0.35 ≈ 20°)
 * @returns {boolean}
 */
export function isTargetInFront(aiPos, aiYaw, targetPos, halfAngle) {
  if (!aiPos || !targetPos) return false;
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  if (dx === 0 && dz === 0) return false;
  const targetAngle = Math.atan2(dz, dx);
  const facing = facingAngle(aiYaw);
  const diff = Math.abs(wrapAngle(targetAngle - facing));
  return diff < halfAngle;
}

/**
 * Pure: the chase controller. v0.21.x adds a BRAKE branch for true
 * "bremsen, drehen, linear aufsammeln" piloting. v0.22.x adds spin-
 * brake PREDICTION: the yaw command gates against `predictedDiff =
 * wrapAngle(targetDiff + aiAngularVel * YAW_INERTIA_TAU)` instead of
 * `targetDiff` directly. This eliminates the visible wobble that
 * v0.21.x still produced at the ±0.15 yaw deadband — the ship has
 * angular momentum (YAW_INERTIA_TAU=0.2s), and raw-diff gating
 * commands yaw=0 the moment the ship "crosses alignment", but the
 * residual angular velocity carries it past into the opposite
 * overshoot, forcing a corrective yaw=±1 on the next tick. By
 * gating against the predicted diff (where the ship WILL BE if
 * we stop commanding yaw now), we fire the counter-yaw BEFORE
 * the ship overshoots — a single decisive turn that settles
 * dead-center on the target. Math: angular displacement over
 * infinite horizon = aiAngularVel * YAW_INERTIA_TAU (the integral
 * of `angVel * exp(-t/τ)` from 0 to ∞).
 *
 * Three branches:
 *
 *   1. PICKUP  — at the target itself, no thrust, no yaw.
 *
 *   2. BRAKE   — ship has notable XZ speed (>4) AND the projected
 *                closing speed exceeds the desired approach speed.
 *                Rotate to the opposite-of-velocity direction and
 *                thrust backward to shed speed. v0.22.x — yaw gated
 *                against predictedBrakeDiff (per §above). Thrust
 *                still raw-diff gated (because thrust direction
 *                depends on FORWARD-facing vs BRAKE-facing, not on
 *                overshoot-correction). The speed>4 floor
 *                prevents micro-oscillation at low idle speed.
 *
 *   3. APPROACH — align with target and thrust. v0.22.x — yaw gated
 *                against predictedDiff (per §above). Thrust kept
 *                on raw-diff (because thrust is a state, not a
 *                correction — we want to know CURRENT alignment
 *                before accelerating forward).
 *
 * The BRAKE → APPROACH transition creates an "emergent coasting"
 * phase: when BRAKE stops firing (closing speed dropped), the ship
 * is still rotated ~180° away from the target. APPROACH then fires
 * yaw=±1 with thrust=false (|targetDiff| > 0.30), giving a clean
 * drift-turn with LINEAR_DRAG shedding the remaining speed. Once
 * ±0.30 of the target, thrust engages and the ship closes in
 * linearly. The v0.22.x spin-brake prediction closes the residual
 * wobble during this transition — the ship now lands dead-center
 * after the 180° flip instead of oscillating ±2–3° at the cone
 * edge.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} targetPos
 * @param {{x:number,z:number}} aiVel  ship's current XZ velocity
 * @param {number} [aiAngularVel=0]  ship's current angular velocity (rad/s).
 *   Defaults to 0 so 4-arg callsites from earlier v0.21.x tests/usage
 *   stay back-compat-safe. When 0, predictedDiff == rawDiff and the
 *   behavior is identical to v0.21.x.
 * @returns {{ dist: number, yaw: number, thrust: boolean, diff: number, closingSpeed: number, branch: 'pickup'|'brake'|'approach' }}
 */
export function engageController(aiPos, aiYaw, targetPos, aiVel, aiAngularVel = 0) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // On top of (or inside) the target — pickup radius absorbs.
    return { dist: 0, yaw: 0, thrust: false, diff: 0, closingSpeed: 0, branch: 'pickup' };
  }
  const speed = Math.hypot(aiVel.x, aiVel.z);
  // Project velocity onto the line-of-sight to the target. Positive
  // closing speed = approaching; negative = receding. dy/dt per
  // tick, signed for direction.
  const closingSpeed = (dx * aiVel.x + dz * aiVel.z) / dist;
  // desiredClosing = Math.max(8, Math.min(40, dist))
  //
  // Three-zone approach-speed profile that fixes the v0.12.x-era
  // "circling powerups" symptom while keeping long-range intercepts
  // visibly engaged (not perpetually braked, as `Math.min(15, dist)`
  // produced at v0.21.x):
  //   * dist ≤ 8   → cap at 8 u/s — tight coast-in regardless of
  //                  how close the pickup. Ship cannot overshoot a
  //                  5u pickup when cruise is 8 u/s.
  //   * 8 < dist ≤ 40 → cruise at dist/2 (linear scale). 12u → 6;
  //                  32u → 16. Cruise speed feels deliberate.
  //   * dist > 40  → cap at 40 u/s. The bot still closes 200u
  //                  targets at 40 u/s (visible motion), not 15 u/s
  //                  (paralyzed cruise). BRAKE fires only when
  //                  closing is materially above 40.
  // Result: BRAKE→APPROACH→linear coast-in. Ship arrives at the
  // pickup at the cruise cap (no overshoot), applies delta-v exactly.
  const desiredClosing = Math.max(8, Math.min(40, dist));

  // Spin-brake math note: predicting the asymptotic free-drift yaw
  // change (∫₀^∞ angVel·exp(-t/τ) dt = angVel·τ) OVER-estimates the
  // actual finite-horizon displacement by ~37% (only ~63% of the
  // asymptotic drift has occurred after one τ). For the wobble-fix
  // this is conservative — counter-yaw fires slightly earlier than
  // strictly needed, which is the correct direction (slight
  // over-correction is preferable to under-correction; the latter
  // is the wobble we're eliminating). Don't "fix" the apparent
  // overshoot by halving the multiplier — that's a different
  // (worse) heuristic.
  // ---- BRAKE branch: high speed + closing too fast ----
  // Trim-speed before overshooting. Rotate to opposite-velocity
  // direction; thrust backward when facing into the brake
  // direction. The speed>4 floor prevents an idle-velocity
  // BRAKE/APPROACH oscillation (the very-low-speed regime is
  // handled cleanly by APPROACH).
  if (speed > 4 && closingSpeed > desiredClosing) {
    const velAngle = Math.atan2(aiVel.z, aiVel.x);
    const brakeAngle = wrapAngle(velAngle + Math.PI);
    const brakeDiff = wrapAngle(brakeAngle - facingAngle(aiYaw));
    // See module-scope constants for the math behind each gate. The
    // gate choice here is `BRAKE_THRUST_GATE ≈ 162°`: when the ship
    // faces within 162° of the brake direction, thrust fires; when
    // it's facing within 18° of the TARGET direction, thrust is off
    // (would accelerate forward, opposite of brake).
    //
    // v0.22.x — spin-brake prediction. Predict the future angular
    // position over YAW_INERTIA_TAU (= total displacement if we let
    // the angular velocity decay naturally with no further input).
    // Gate yaw command against predictedBrakeDiff, not raw brakeDiff,
    // so the counter-yaw fires BEFORE the ship overshoots the brake
    // direction. The result is a single decisive landing on the
    // brake direction, not an oscillation across it.
    const predictedBrakeDiff = wrapAngle(brakeDiff + aiAngularVel * YAW_INERTIA_TAU);
    return {
      dist,
      yaw: predictedBrakeDiff > YAW_DEADBAND ? -1 : predictedBrakeDiff < -YAW_DEADBAND ? 1 : 0,
      // Thrust uses raw brakeDiff because it gates thrust ON when
      // facing the brake direction (forward thrust = brake in this
      // branch). The thrust gate is a STATE check, not a steering
      // correction — it can't benefit from the spin-brake prediction
      // because the desired state is "ship is rotated to brake
      // direction RIGHT NOW", which is the raw diff.
      thrust: Math.abs(brakeDiff) < BRAKE_THRUST_GATE,
      diff: brakeDiff, // raw diff for observability + tests
      closingSpeed,
      branch: 'brake',
    };
  }

  // ---- APPROACH branch: align + thrust when in range ----
  const targetAngle = Math.atan2(dz, dx);
  const targetDiff = wrapAngle(targetAngle - facingAngle(aiYaw));
  // v0.22.x — spin-brake prediction. Same math as BRAKE branch
  // (see above): predict the future angular position over
  // YAW_INERTIA_TAU so counter-yaw fires BEFORE the ship overshoots
  // alignment, settling in a single decisive turn.
  const predictedDiff = wrapAngle(targetDiff + aiAngularVel * YAW_INERTIA_TAU);
  return {
    dist,
    yaw: predictedDiff > YAW_DEADBAND ? -1 : predictedDiff < -YAW_DEADBAND ? 1 : 0,
    // Thrust uses raw targetDiff: thrust forward is a state, not a
    // steering correction. We thrust when we're CURRENTLY close to
    // alignment AND closing speed hasn't yet hit desired. The spin-
    // brake prediction only affects steering; thrust timing stays
    // coupled to current alignment so we don't thrust-then-overshoot.
    thrust: Math.abs(targetDiff) < APPROACH_THRUST_GATE && closingSpeed < desiredClosing,
    diff: targetDiff, // raw diff for observability + tests
    closingSpeed,
    branch: 'approach',
  };
}

/**
 * Pure: pick the best in-range chase target.
 *
 * Rules (in order):
 *   1. If `nearest` asteroid is within `targetDist`, it becomes the
 *      baseline candidate.
 *   2. If a powerup exists and is within `targetDist`, it's a
 *      candidate. It wins the tie-breaker against the asteroid if
 *      `powerupDist < asteroidDist + powerupBiasU`. With negative
 *      `powerupBiasU` (the default) the powerup must be SIGNIFICANTLY
 *      closer to win — strictly opportunistic pickup.
 *   3. If neither is in range, returns `null` (idle).
 *
 * @param {{
 *   aiPos: {x:number,z:number},
 *   asteroids: Array<{getPosition: () => any}>,
 *   powerupPos: {x:number,z:number} | null,
 *   targetDist: number,
 *   powerupBiasU: number,
 * }} args
 * @returns {{ pos: {x:number,z:number}, mode: 'asteroid'|'powerup', dist: number } | null}
 */
function pickTarget({ aiPos, asteroids, powerupPos, targetDist, powerupBiasU }) {
  const nearest = findNearestAsteroid(aiPos, asteroids);
  // Step 1: in-range asteroid as baseline.
  let best = null;
  if (nearest && nearest.dist < targetDist) {
    best = {
      pos: nearest.asteroid.getPosition(),
      mode: 'asteroid',
      dist: nearest.dist,
    };
  }
  if (!powerupPos || typeof powerupPos.x !== 'number') return best;
  const pDx = powerupPos.x - aiPos.x;
  const pDz = powerupPos.z - aiPos.z;
  const pDist = Math.hypot(pDx, pDz);
  if (pDist >= targetDist) return best;
  // Step 2: powerup is in range. Decide between asteroid + powerup.
  if (best === null) {
    // No asteroid target — powerup becomes the target.
    return { pos: powerupPos, mode: 'powerup', dist: pDist };
  }
  // Both in range. Bias decides.
  if (pDist < best.dist + powerupBiasU) {
    return { pos: powerupPos, mode: 'powerup', dist: pDist };
  }
  return best;
}

/**
 * Pure: decide what the AI should do this tick.
 *
 * Returns `{ yaw, thrust, mode, fire }` where:
 *   - `yaw`     ∈ {-1, 0, +1}       (steering; -1 = turn left, +1 = turn right)
 *   - `thrust`  boolean              (true = accelerate)
 *   - `mode`    'dodge' | 'asteroid' | 'powerup' | 'idle'
 *   - `fire`    boolean              (true when any asteroid is in the fire cone)
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   aiYaw: number,
 *   aiAngularVel?: number,
 *   asteroids: Array<{ getPosition: () => any }>,
 *   time: number,
 *   powerupPos?: { x: number, z: number } | null,
 *   targetDist?: number,
 *   powerupBiasU?: number,
 *   panicDist?: number,
 *   fireConeHalfAngle?: number,
 * }} args
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  aiVel = { x: 0, z: 0 }, // v0.21.x — required for engageController's BRAKE branch (defaults to zero when omitted).
  aiAngularVel = 0, // v0.22.x — required for engageController's spin-brake prediction (defaults to zero when omitted = v0.21.x behavior).
  asteroids,
  time, // kept for API parity with prior versions; not used internally anymore
  powerupPos = null,
  targetDist = DEFAULTS.targetDist,
  powerupBiasU = DEFAULTS.powerupBiasU,
  panicDist = DEFAULTS.panicDist,
  fireConeHalfAngle = DEFAULTS.fireConeHalfAngle,
  fireMinDist = DEFAULTS.fireMinDist, // v0.22.x — close-range skip for fire check
  fireMaxDist = DEFAULTS.fireMaxDist,
  activeWeapon = 'bullet', // v0.22.x Step 4 - 'bullet' | 'laser'; laser uses tight cone + no dist gate
  laserFireConeHalfAngle = DEFAULTS.laserFireConeHalfAngle, // v0.22.x — tight aim for laser-mode lock-on
  lookaheadTime = DEFAULTS.lookaheadTime, // v0.22.x — lookahead horizon for predictive dodge
  lookaheadMinRadius = DEFAULTS.lookaheadMinRadius, // v0.22.x — projDist threshold for lookahead dodge
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const nearest = findNearestAsteroid(aiPos, asteroids);

  // ---- 1. PANIC-DODGE (within panicDist) -----------------------------
  // Pure reflex: thrust 90° perpendicular to the nearest asteroid.
  // The escape direction is perpendicular to the THREAT position
  // (not the relative velocity — that's the predictive v0.18.x
  // approach). For a panic-window this is correct enough: the
  // threat is already nearby, so the perpendicular-to-current is
  // a meaningful off-axis.
  if (nearest && nearest.dist < panicDist) {
    const threatAngle = Math.atan2(nearest.dz, nearest.dx);
    const escapeAngle = threatAngle + Math.PI / 2;
    const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
    return {
      yaw: diff > 0.1 ? -1 : diff < -0.1 ? 1 : 0,
      thrust: true,
      mode: 'dodge',
      fire: false,
    };
  }

  // ---- 1b. LOOKAHEAD-DODGE (predictive, v0.22.x) ----------------------
  // STRATEGIC break off the flight path BEFORE the swarm is in panic
  // range. Iterates every asteroid, projects the ship's current
  // trajectory against each via computeClosestApproachTime, and
  // triggers a perpendicular escape when ANY asteroid projects
  // within `lookaheadMinRadius` inside `lookaheadTime`. Sits between
  // PANIC-DODGE and ENGAGE — far-horizon avoidance → close-horizon
  // reflex → chase. The escape direction is perpendicular to the
  // ship's CURRENT XZ velocity (not the threat position), so the
  // bot steps off its own flight path rather than weaving around a
  // single asteroid.
  //
  // Edge cases handled (each fails-open to other branches):
  //   - asteroids.length === 0          → fall through to ENGAGE / IDLE
  //   - lookaheadTime <= 0              → skip the branch entirely
  //     (e.g., tests disabling predictive avoidance)
  //   - ship velocity ≈ 0               → escape perpendicular to the
  //     THREAT position (same math as PANIC but at lookahead horizon)
  //   - tStar < 0 (target receding)     → safe, no threat from this
  //     asteroid, continue iteration
  //   - projDist > lookaheadMinRadius   → comfortable miss, continue
  if (asteroids.length > 0 && lookaheadTime > 0) {
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      const ca = computeClosestApproachTime(aiPos, aiVel, p);
      if (!ca.valid) continue;
      // v0.22.x patch: skip if the asteroid is currently RECEDING
      // (tStar < 0). The math says the past closest-approach was
      // close, but past-closest-approach is meaningless for threat
      // detection — only future closest approach matters. Without
      // this guard the bot wasted thrust dodging asteroids it was
      // already moving away from.
      if (ca.tStar < 0) continue;
      if (ca.tStar > lookaheadTime) continue;
      if (ca.projDist > lookaheadMinRadius) continue;
      // Threat confirmed: this asteroid is on the ship's flight path
      // within lookaheadMinRadius during lookaheadTime.
      let escapeAngle;
      const speedSq = aiVel.x * aiVel.x + aiVel.z * aiVel.z;
      if (speedSq < 1e-4) {
        // Stationary ship: escape perpendicular to the threat,
        // same off-axis math as the panic-dodge but at lookahead.
        const threatAngle = Math.atan2(p.z - aiPos.z, p.x - aiPos.x);
        escapeAngle = threatAngle + Math.PI / 2;
      } else {
        // Moving ship: escape perpendicular to the SHIP's velocity
        // (step off the flight path, not weave around the threat).
        const velAngle = Math.atan2(aiVel.z, aiVel.x);
        escapeAngle = velAngle + Math.PI / 2;
      }
      const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
      return {
        yaw: diff > 0.1 ? -1 : diff < -0.1 ? 1 : 0,
        thrust: true,
        mode: 'dodge',
        fire: false,
      };
    }
  }

  // ---- 2. ENGAGE (single-mode chase + fire) ---------------------------
  // Pick the best target and apply engageController. Fire at any
  // asteroid in cone on every tick — matches the user's "feuer bis
  // split, dann weiter auf die verbleibenden teile" intent.
  const target = pickTarget({
    aiPos,
    asteroids,
    powerupPos,
    targetDist,
    powerupBiasU,
  });
  if (target) {
    // v0.22.x — pass aiAngularVel so engageController's spin-brake
    // prediction can compute the future angular position over
    // YAW_INERTIA_TAU. Without this, the brain falls back to raw-diff
    // yaw gating and produces visible wobble at the ±0.15 deadband.
    const ec = engageController(aiPos, aiYaw, target.pos, aiVel, aiAngularVel);
    let fire = false;
    if (activeWeapon === 'laser') {
      // v0.22.x Step 4: laser-mode path - continuous beam, tight
      // cone on chase target, no dist gate (laser has 500u
      // effective range per LASER_LENGTH in src/entities/laser.js).
      // The user's complaint was that the AI ship had no plan in
      // laser mode (sweeping wildly, no lock-on). Laser mode now
      // LOCKS ON to the pickTarget result and aims dead-center
      // via laserFireConeHalfAngle (~3 deg), firing any tick the
      // chase target is in cone.
      //
      // Lock-on semantics (vs `swept widecone`): the fire-check
      // targets ONLY the chase target (target.pos), even if another
      // in-cone asteroid would make a clean shot. This is the
      // whole point of laser-mode — beam locks on the chase arc,
      // sweeps-and-misses at any in-cone asteroid while the chase
      // target sits off-axis. If a future refactor "optimizes"
      // this to scan all asteroids like bullet-mode, the locked-on
      // contract breaks and the player sees sweeping beam probes
      // again.
      //
      // Powerup-expiry smoothness: when the laser expires mid-
      // chase and the target is past bullet fireMaxDist=55, the
      // brain drops from laser-fire (no dist gate) to bullet-no-
      // fire (dist gate enforces) for ~1s until chase closes the
      // gap. Invisible in practice: chase cruises at ~40 u/s, gap
      // closes fast. Doc-as-test pin: the engageController always
      // closes the chase regardless of fire branch.
      fire = isTargetInFront(aiPos, aiYaw, target.pos, laserFireConeHalfAngle);
    } else {
      for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      // v0.22.x — distance-gated fire. Skip asteroids outside the
      // [fireMinDist, fireMaxDist] window to avoid (a) close-range
      // overspraying on bypass passes AND (b) far-range scattered
      // wide-cone shots that miss. The "wild ballern" symptom is
      // gone: the AI fires only at asteroids it can realistically
      // hit with the current cone alignment.
      const dist = Math.hypot(p.x - aiPos.x, p.z - aiPos.z);
      if (dist < fireMinDist || dist > fireMaxDist) continue;
      if (isTargetInFront(aiPos, aiYaw, p, fireConeHalfAngle)) {
        fire = true;
        break;
      }
    }
    }
    return { yaw: ec.yaw, thrust: ec.thrust, mode: target.mode, fire };
  }

  // ---- 3. IDLE (no targets in range) ----------------------------------
  // Strict "fly as little as possible": stop, no thrust, no yaw, no fire.
  return { yaw: 0, thrust: false, mode: 'idle', fire: false };
}

/**
 * Decide whether the AI has drifted too far from origin and should
 * be reset to a fresh spawn. Pure.
 *
 * @param {{x:number,z:number}} pos
 * @param {number} [resetDist=220]
 * @returns {boolean}
 */
export function shouldResetAi(pos, resetDist = DEFAULTS.resetDist) {
  if (!pos) return false;
  return Math.hypot(pos.x, pos.z) > resetDist;
}

/**
 * Build a random spawn position within `radius` of the origin (XZ
 * plane). Pure.
 *
 * @param {number} radius
 * @param {() => number} [rng]
 * @returns {{ position: {x:number,y:number,z:number}, yaw: number }}
 */
export function pickAiSpawn(radius = DEFAULTS.spawnRadius, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const r = radius * (0.4 + rng() * 0.6); // 0.4–1.0 × radius
  return {
    position: { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
    yaw: rng() * Math.PI * 2,
  };
}

/**
 * Create a demo AI ship. Wires the pure brain above to a live ship.
 *
 * v0.20.x — significantly simpler than v0.12.x-v0.18.x. The factory
 * no longer tracks: an observation buffer (no latency), a hysteresis
 * cache (no anti-thrash), a yawHoldTimeS/thrustHoldTimeS debouncer
 * (no visible strobing), or a fire-cadence timer (no gated bursts).
 * The brain ticks; the ship reflects. The state is just `time` for
 * the reset clock.
 *
 * @param {{
 *   scene: import('three').Scene,
 *   asteroids: Array<{ getPosition: () => any }>,
 *   weapon?: { fire: (opts: any) => number | boolean } | null,
 *   getPowerupPos?: () => { x: number, z: number } | null,
 *   options?: object,
 * }} opts
 */
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, getActiveWeapon = null, options = {} } = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;
  const brain = opts.brain || null;

  // ---- Initial spawn --------------------------------------------------
  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = initial.yaw;

  let time = 0;
  let enabled = true;
  // Last mode applied — kept for the `getLastMode()` API. Without
  // hysteresis this is mostly redundant with `getMode()`, but the
  // API surface stays stable for any caller that reads it.
  let lastMode = 'idle';

  function spawn() {
    const sp = pickAiSpawn(opts.spawnRadius, rng);
    ship.reset(sp.position);
    ship.rotation.yaw = sp.yaw;
  }

  /** Build the args the brain consumes from the live ship state. */
  function brainArgsFromShip() {
    return {
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      // v0.21.x — forward the ship's current XZ velocity so the
      // engageController can run its BRAKE branch. The XZ slice is
      // intentional: ship.js' `velocity` includes a 0 Y component
      // and the brain only needs the XZ plane.
      aiVel: { x: ship.velocity.x, z: ship.velocity.z },
      // v0.22.x — forward the ship's current angular velocity so
      // the engageController's spin-brake prediction can compute
      // the future angular position over YAW_INERTIA_TAU. Read
      // ship.angularVelocity as a getter (ship.js exposes a getter
      // for live state). Required for the wobble fix in Step 1.
      aiAngularVel: ship.angularVelocity,
      asteroids,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      targetDist: opts.targetDist,
      powerupBiasU: opts.powerupBiasU,
      panicDist: opts.panicDist,
      fireConeHalfAngle: opts.fireConeHalfAngle,
      // v0.22.x — forward the distance-gated fire opts so aiBrainTick's
      // bullet-mode fire loop skips asteroids outside [fireMinDist,
      // fireMaxDist]. Without these the brain falls back to v0.21.x
      // "wild ballern" behavior (spray at any in-cone asteroid
      // regardless of distance). The bullet fire is gated; the
      // chase itself remains unbounded (see Step 3 chained nudge).
      fireMinDist: opts.fireMinDist,
      fireMaxDist: opts.fireMaxDist,
      // v0.22.x Step 4 - active weapon (bullet|laser) forwarded
      // so aiBrainTick branches fire-loop between distance-gated
      // wide-cone (bullet, Step 3) and tight-cone laser path.
      // Default 'bullet' if no getActiveWeapon hook; back-compat
      // with existing callers (no-hook path = pure bullet AI).
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
      // v0.22.x — forward the lookahead opts so aiBrainTick's
      // LOOKAHEAD-DODGE branch can project the flight path against
      // the asteroid field and break off BEFORE a swarm gets in
      // panic range. Without these the brain falls back to v0.21.x
      // "flies-into-swarms" behavior.
      lookaheadTime: opts.lookaheadTime,
      lookaheadMinRadius: opts.lookaheadMinRadius,
      time,
    };
  }

  function update(dt) {
    if (dt <= 0) return;
    if (!enabled) return;
    time += dt;

    if (shouldResetAi(ship.position, opts.resetDist)) {
      spawn();
    }

    const args = brainArgsFromShip();
    const decision = brain ? brain.tick(args) : aiBrainTick(args);
    lastMode = decision.mode;

    ship.setYaw(decision.yaw);
    ship.setThrust(decision.thrust);
    ship.update(dt);

    if (decision.fire && weapon && typeof weapon.fire === 'function') {
      const yaw = ship.rotation.yaw;
      weapon.fire({
        origin: ship.position,
        direction: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
        asteroids,
      });
    }
  }

  function dispose() {
    if (typeof ship.dispose === 'function') {
      ship.dispose();
    } else if (ship.mesh && scene.children.includes(ship.mesh)) {
      scene.remove(ship.mesh);
    }
  }

  return {
    update,
    dispose,
    getShip: () => ship,
    setEnabled: (v) => { enabled = !!v; },
    isEnabled: () => enabled,
    getMode: () => {
      const args = brainArgsFromShip();
      return brain ? brain.tick(args).mode : aiBrainTick(args).mode;
    },
    getLastMode: () => lastMode,
  };
}
