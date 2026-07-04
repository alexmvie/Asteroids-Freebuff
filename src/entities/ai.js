/**
 * Demo AI — an NPC ship that hunts power-ups, targets the nearest
 * asteroid, and dodges close threats. Uses the same ship look as
 * the player (injected via `shipFactory` so the same mesh + physics
 * can be shared, and so tests can swap in a mock ship).
 *
 * Behavior priority (evaluated each tick):
 *
 *   1. HUNT    — chase a pending power-up within `powerupHuntDist`.
 *                Uses the same 2-phase intercept controller as TARGET.
 *                Fires whenever an asteroid is in the ship's fire cone
 *                (not just the chase target), so the AI keeps shooting
 *                while pursuing the bonus — addresses the v0.11.x
 *                "AI doesn't shoot asteroids" complaint.
 *   2. DODGE   — if any asteroid is within `dodgeDist`, thrust
 *                perpendicular to escape.
 *   3. TARGET  — if any asteroid is within `targetDist`, chase the
 *                nearest one with the same intercept controller.
 *                Fires when the chased asteroid is in cone.
 *   4. WANDER  — no power-up, no asteroids in range. Pick a random
 *                heading; thrust when aligned.
 *
 * The brain is a pure function (`aiBrainTick`) — ship position + yaw +
 * asteroid list + time → `{ yaw, thrust, mode, fire }`. The factory
 * wraps the brain, holds the wander clock, drives the ship, applies
 * a min-hold-time debounce on yaw/thrust flips (to prevent visible
 * strobing from frame-to-frame brain toggles), and disposes the mesh
 * on teardown.
 *
 * Infinite lives: the AI is decorative and never collides with the
 * player. The collision layer only checks `demoAsteroids` against
 * the player ship; the AI ship is not a target. Reset to a fresh
 * spawn if it drifts beyond `resetDist`.
 *
 * v0.12.x — ground-up rewrite of the over-engineered v0.11.x HUNT
 * controller. The previous version stacked 5 phases
 * (HARD COMMIT, FINAL APPROACH, TANGENTIAL orbit, BRAKE, APPROACH)
 * that interacted badly in live gameplay:
 *
 *   - HARD COMMIT (no thrust below powerupCommitDist) caused the
 *     ship to rest in front of pickups instead of coasting into them.
 *   - TANGENTIAL counter-steer (which fires when tangential velocity
 *     dominates closing velocity) triggered on transient tangential
 *     spikes during normal approaches, producing visible yaw wobble.
 *   - HUNT mode never returned fire:true, so the AI couldn't shoot
 *     asteroids while chasing power-ups.
 *
 * The new brain uses ONE interceptor (brake/approach) for both HUNT
 * and TARGET, and HUNT fires at any in-cone asteroid.
 */

import { createShip } from './ship.js';

const DEFAULTS = Object.freeze({
  /** Dodges when any asteroid is within this many world units. */
  dodgeDist: 14,
  /** Targets the nearest asteroid when any are within this many units. */
  targetDist: 90,
  /**
   * Seconds between random heading changes during WANDER. v0.12.x —
   * raised 1.5→2.5 to fix the "nervous left/right without a target"
   * complaint. Frequent re-orientation with random headings kept
   * the ship visibly re-aligning every frame. 2.5s is closer to a
   * human's "pick a heading and ride it out" cadence.
   */
  wanderTurnPeriod: 2.5,
  /** If the AI drifts beyond this radius from origin, reset it. */
  resetDist: 220,
  /** Spawn radius (XZ) from origin for the initial position. */
  spawnRadius: 30,
  /** Vertical jitter on spawn (cosmetic, scene has flat Y anyway). */
  spawnJitterY: 0,
  /** Initial yaw (radians). */
  spawnYaw: 0,
  /**
   * Half-angle of the "in front" cone (radians) for the TARGET-mode
   * fire decision AND for the HUNT-mode asteroid-shot check.
   * The AI fires when any in-range asteroid is within this cone
   * relative to the ship's actual facing direction.
   */
  fireConeHalfAngle: 0.35,
  /**
   * Maximum pursuit range for power-ups (world units). Beyond this
   * the AI ignores the power-up and falls through to asteroid
   * hunting (or wander).
   */
  powerupHuntDist: 500,
  /**
   * Minimum hold time (seconds) before the AI's yaw command can
   * flip to a DIFFERENT non-zero value. Returning to 0 (release)
   * applies immediately. Without this, the brain's ±1 strobing
   * (one frame -1, next frame +1) produces visible heading stutter
   * even with the ship's angular inertia. 0.18s matches the natural
   * upper limit for human keyboard play (~5.5 keypresses/sec) and
   * the existing bullet cooldown. Set to 0 to disable humanization.
   */
  yawHoldTimeS: 0.18,
  /**
   * Minimum hold time (seconds) before thrust can flip. Without
   * this, the brain can strobe thrust on/off every frame (also
   * produces visible stutter on thrust-glow + acceleration).
   * 0.10s feels natural for keyboard play. Set to 0 to disable.
   */
  thrustHoldTimeS: 0.10,

  // ----------------------------------------------------------------------
  // v0.13.x -- Demo AI humanization (sensors + intent + decisions)
  // ----------------------------------------------------------------------
  // The v0.12.x brain was functionally correct (right mode, right
  // direction) but felt robotic -- instant reaction, perfect target
  // lock, machine-gun fire. Real pilots obey three limiting factors
  // that we now model explicitly:
  //
  //   1. Sensor delay (reactionLatencyS): the brain reads a snapshot
  //      from N ms ago, not the live frame. The decision lags the
  //      world by ~250ms (the human P300 cognitive reaction window).
  //
  //   2. Intent commitment (modeHysteresisS): a real pilot doesn't
  //      instantly abandon a chase when the target slips out of
  //      frame. The brain's last-decision is reused for a short
  //      grace period on a downshift (TARGET -> WANDER), removing
  //      the visible mode-thrash at range boundaries. Upgrades
  //      (WANDER -> DODGE) bypass the window -- survival is
  //      immediate.
  //
  //   3. Decision granularity (fireMinIntervalS): real triggers
  //      have a cadence. Even with a target in cone, a pilot pulls
  //      the trigger every ~300ms rather than every frame. Without
  //      this, the brain machine-guns the entire field once it
  //      finds the cone. The laser (held-fire model) is unaffected.
  //
  // The coastInDist and gapAwareDist knobs tighten the physical
  // behavior: close-range coast-in prevents the ship from ramming
  // past pickups, and smart-wander picks the heading with the LEAST
  // nearby-aspect against nearby asteroids (instead of spinning 180
  // degrees toward a rock wall every 2.5s).

  /**
   * v0.13.x -- sensor delay / reaction latency (seconds). The brain
   * is fed a snapshot of the game state from this many seconds in
   * the past, not the current frame. Models human cognitive
   * reaction latency (~250ms is the P300 refractory window).
   * Combined with the ship's angular momentum (yawInertiaTau=0.2),
   * this kills the "instant perfect tracking" feel of v0.12.x.
   * Set to 0 to disable (the brain sees live state -- useful for
   * tests that need a deterministic mode-switch).
   */
  reactionLatencyS: 0.25,
  /**
   * v0.13.x -- minimum interval (seconds) between successful fire
   * commands from the brain. Models trigger cadence: a pilot pulls
   * the trigger every ~300ms even with the target in cone, vs.
   * machine-gun bursts the prior brain fired every frame. Only
   * affects the AI's bullet fire (via the factory's `weapon.fire`
   * callback). The laser (held-fire model in main.js) is
   * independent -- the laser is held continuously while Space is
   * held, not gated per-fire. Set to 0 to disable.
   */
  fireMinIntervalS: 0.30,
  /**
   * v0.13.x -- close-range coast-in distance for HUNT mode (world
   * units). When the AI is chasing a power-up and the distance drops
   * below this, the brain overrides intercept's thrust to `false`
   * so the ship coasts into the pickup radius (~2u) instead of
   * ramming past it. The pickup radius absorbs the ship regardless,
   * but coasting ensures the pickup registers cleanly. Outside
   * HUNT (TARGET asteroid chase), this is a no-op -- asteroids are
   * static, and the AI doesn't need precision pickup there.
   */
  coastInDist: 6,
  /**
   * v0.13.x -- smart-wander gap-aware threshold (world units). When
   * picking a new wander heading and the nearest asteroid is closer
   * than this distance, the brain samples 8 candidate headings
   * evenly offset around a `rng()` rotation and picks the one with
   * the LEAST nearby-aspect interference score (sum of inverse
   * distances to asteroids within +/-60 degrees of each candidate).
   * Beyond this distance, the legacy bias/random logic applies
   * (preserves the v0.12.x calmness behavior over sparsely
   * populated space). One rng() call per refresh regardless -- no
   * observable rng-budget change.
   */
  gapAwareDist: 80,
  /**
   * v0.14.x -- target-prediction look-ahead (seconds). For TARGET
   * mode (asteroid chase), the brain intercepts the predicted
   * future position = current_pos + vel * interceptLookaheadS instead
   * of chasing the current position. Models the real-pilot reflex
   * of "leading the target" -- if the asteroid is drifting at
   * `vel`, chasing where it WILL BE prevents the visible "lag"
   * of a chase that always falls behind. Power-ups (HUNT mode)
   * and DODGE use current position -- power-ups are static so no
   * prediction helps; DODGE is immediate threat, awaiting the AI's
   * current best escape angle.
   *
   * The current MVP's ambient asteroid drift is < 0.5 u/s, so the
   * eye-visible effect is small for the production field. But the
   * API is forward-compatible with Elite expansions (faster
   * enemies, motion-capable objects) where the look-ahead scale
   * matters. Set to 0 to disable; uses current position only.
   */
  interceptLookaheadS: 0.5,
  /**
   * v0.16.x -- nominal bullet speed (units/sec) for dynamic bullet-flight-time
   * lead. The TARGET and HUNT lead-fire loops compute
   * `fireLeadS = Math.min(dist / bulletSpeed, interceptLookaheadS)` per-target
   * so the predicted point matches the bullet's actual flight time, NOT a
   * fixed human-reaction lag. With the production `BULLET_SPEED = 400 u/s`,
   * the flight time collapses to ~0.1s for 40u targets, ~0.225s for 90u
   * targets, etc. The fixed `interceptLookaheadS` remains as the cognitive
   * cap (a pilot won't project farther than ~0.5s of intent regardless of
   * physics). Set to 0 to disable dynamic lead -- the brain falls back to
   * the fixed `interceptLookaheadS` everywhere (legacy v0.14.x/v0.15.x).
   */
  bulletSpeed: 400,
  /**
   * v0.18.x -- predictive-DODGE look-ahead (seconds). For each
   * asteroid, project the relative motion against the ship; if the
   * CLOSEST approach within this window is < `dodgeMarginU`, the
   * brain DODGEs. Without this, DODGE fires only when the asteroid
   * is already within `dodgeDist` (14u raw), giving the ship < 500ms
   * to start escaping for fast-drifting rocks. With prediction, the
   * AI commits to an escape vector 1-2 seconds EARLIER -- the
   * difference between "reactive panic" and "threading the needle".
   * Math: pure 2-body kinematics (see `computeClosestApproach`).
   * Set to 0 to disable predictive DODGE; falls back to the legacy
   * "current dist < dodgeDist" trigger (v0.12.x).
   */
  dodgeLookaheadS: 1.0,
  /**
   * v0.18.x -- projected miss-distance threshold (world units) for
   * triggering DODGE. The threat must be predicted to come within
   * this radius of the ship (over the lookahead window) before the
   * brain commits to an escape. Default 2.5u = roughly the largest
   * asteroid radius (the small chunks are ~1u, the large are 4u);
   * 2.5u covers the "asteroid will clip my wing" condition broadly
   * without inflating to safe-distance panic. Higher = more
   * aggressive DODGE (sooner, tighter margin); lower = more
   * aggressive flight (let grazing passes if they really graze).
   * The legacy `dodgeDist` radius (14u) bounds the lookahead's
   * HORIZON speed: a fast-moving asteroid that won't enter the
   * inner 14u shell within `dodgeLookaheadS` seconds is NOT a
   * predictive threat and falls through to whatever else (HUNT
   * / TARGET / WANDER) is dominant.
   */
  dodgeMarginU: 2.5,
});

/**
 * Normalize an angle to (-PI, PI].
 * @param {number} a
 * @returns {number}
 */
function wrapAngle(a) {
  // Two-arg atan2-style wrap; keeps yaw steering in a single range.
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/**
 * Convert a ship rotation `yaw` (the convention used by `ship.js`,
 * where the forward vector is `(-sin(yaw), 0, -cos(yaw))`) into the
 * angle of that forward vector in the standard (x, z) `atan2(z, x)`
 * space used by the rest of the brain.
 *
 * The two are NOT the same: `yaw = 0` means the ship faces -Z, which
 * in `atan2(z, x)` space is `-π/2`. The relationship is
 * `facingAngle = -π/2 - yaw (mod 2π)`.
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
 * `{x,y,z}` (a live Three.js Vector3 or a plain object). The caller
 * can also use a mock that returns `{x,z}` — the brain only reads
 * `.x` and `.z`.
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
 * Pure: v0.13.x smart-wander heading pick. When the nearest asteroid
 * is closer than `gapAwareDist`, sample N=8 candidate headings evenly
 * offset around a `rng()` rotation and pick the one with the LEAST
 * nearby-aspect interference score. Each asteroid within `gapAwareDist`
 * of the ship contributes `-1 / max(1, dist)` to a candidate's score
 * IF the asteroid is within +/-60 degrees of the candidate's direction
 * (i.e. it would "be in front of" the ship if it flew that heading).
 *
 * The lower the score, the better. We pick the highest (least negative).
 *
 * Beyond `gapAwareDist` OR when no asteroids are within the gap-aware
 * range, falls through to the legacy logic so existing tests that count
 * rng() calls and rely on the bias/jitter formula stay deterministic:
 *
 *   - If `nearest.dist < awarenessDist` (= targetDist * 2.5): jittered
 *     bias toward the nearest asteroid's direction, +/-27 degrees.
 *   - Otherwise: random heading in [-PI, PI].
 *
 * Consumption invariant: exactly 1 `rng()` call per refresh, regardless
 * of which branch fires (preserves the v0.12.x 'wander keeps the same
 * heading' deterministic contract used in tests/ai.test.js).
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   nearest: { dist: number } | null,
 *   asteroids: Array<{ getPosition: () => any }>,
 *   gapAwareDist: number,
 *   awarenessDist: number,
 *   rng: () => number,
 * }} args
 * @returns {number} heading in radians (atan2 frame)
 */
export function pickWanderHeading({ aiPos, nearest, asteroids, gapAwareDist, awarenessDist, rng }) {
  // ---- Gap-aware branch: nearby asteroid exists ----------------------
  if (nearest && nearest.dist < gapAwareDist) {
    const offset = rng() * Math.PI * 2;       // 1 rng call
    const N = 8;
    const halfConeRad = Math.PI / 3;          // +/-60 degrees "in front" cone
    let bestHeading = offset;
    let bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const candidate = offset + (i / N) * Math.PI * 2;
      let score = 0;
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        if (!p) continue;
        const dx = p.x - aiPos.x;
        const dz = p.z - aiPos.z;
        const d = Math.hypot(dx, dz);
        if (d > gapAwareDist) continue;
        const angDiff = Math.abs(wrapAngle(Math.atan2(dz, dx) - candidate));
        if (angDiff < halfConeRad) {
          score -= 1 / Math.max(1, d);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestHeading = candidate;
      }
    }
    return bestHeading;
  }
  // ---- Legacy v0.12.x branch (preserves existing tests) --------------
  if (nearest && nearest.dist < awarenessDist) {
    const targetAngle = Math.atan2(nearest.dz, nearest.dx);
    const jitter = (rng() * 2 - 1) * Math.PI * 0.15;   // 1 rng call
    return targetAngle + jitter;
  }
  return (rng() * 2 - 1) * Math.PI;                   // 1 rng call
}

/**
 * True if the given target position is in front of a ship at `aiPos`
 * facing `aiYaw`, within a half-angle cone of `halfAngle` radians.
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
 * Pure: v0.14.x target-prediction helper. Returns the future
 * position of a target moving at `vel` over `lookAheadS` seconds.
 * Conservative when input is null/zero/null lookAheadS:
 *   - pos == null    -> returns null (callers should bail)
 *   - vel == null    -> returns pos (no velocity to predict on)
 *   - lookAheadS <= 0 -> returns pos (prediction disabled)
 *
 * Used by the AI's TARGET-mode intercept: instead of chasing
 * `asteroid.getPosition()` (always behind a drifting asteroid),
 * the brain chases `predictPosition(getPos, getVel, 0.5)`. The
 * ship's inertia (yawInertiaTau = 0.2s) means a ~0.5s lookahead
 * is comfortable for the AI to commit to a heading without
 * overshooting. Power-ups have no velocity so HUNT mode falls
 * through to current position; DODGE stays on current position
 * (immediate threat, no time to predict).
 *
 * @param {{x:number, z:number} | null} pos  current world position
 * @param {{x:number, z:number} | null} vel  velocity (XZ plane only)
 * @param {number} lookAheadS  seconds (0 or negative to disable)
 * @returns {{x:number, z:number} | null} predicted future position
 */
export function predictPosition(pos, vel, lookAheadS) {
  if (!pos) return null;
  if (!vel || lookAheadS <= 0) return pos;
  return {
    x: pos.x + vel.x * lookAheadS,
    z: pos.z + vel.z * lookAheadS,
  };
}

/**
 * Pure: v0.14.x defensive helper. Reads a velocity snapshot from an
 * asteroid-like entity if it exposes `getVelocity()`; otherwise
 * returns null. The brain uses this so callers without a `velocity`
 * API (e.g. legacy test fixtures, mock asteroids in unit tests) still
 * work -- the prediction falls through to current position.
 *
 * @param {{ getVelocity?: () => any } | null | undefined} asteroid
 * @returns {{x:number, z:number} | null}
 */
export function lookupAsteroidVel(asteroid) {
  if (!asteroid || typeof asteroid.getVelocity !== 'function') return null;
  const vel = asteroid.getVelocity();
  if (!vel || typeof vel.x !== 'number' || typeof vel.z !== 'number') return null;
  return vel;
}

/**
 * Pure: v0.18.x 2-body closest-approach kinematics. Given the
 * asteroid's position and velocity RELATIVE to the ship (pRel,
 * vRel) and a lookahead window in seconds, returns the minimum
 * distance between them over `t in [0, lookaheadS]` and the time
 * at which that minimum occurs (clamped to the window).
 *
 * Math: relative motion `R(t) = pRel + vRel * t` traces a line in
 * the XZ plane. The squared distance is a parabola in `t`:
 *
 *   d^2(t) = |pRel|^2 + 2(pRel . vRel) t + |vRel|^2 t^2
 *
 * Its derivative is `2(pRel . vRel + |vRel|^2 t)` -- zero at
 *
 *   tStar = -pRel . vRel / |vRel|^2.
 *
 * Plugging back: `dStar^2 = |pRel|^2 - (pRel . vRel)^2 / |vRel|^2`.
 *
 * Edge cases (handled explicitly so callers don't have to):
 *   - `|vRel|^2 == 0` (no relative motion): the asteroid hovers
 *     or moves in perfect lockstep. The closest distance over
 *     ANY window is `|pRel|`, and `tStar = 0`. Returns
 *     `{ closestDist: |pRel|, tStar: 0 }` -- treats it as an
 *     immediate threat (zero relative velocity IS a threat if the
 *     asteroid is already close).
 *   - `tStar < 0`: the asteroid is RECEDING (passing through its
 *     closest point before the start of the window). The min over
 *     `[0, lookaheadS]` is at `t=0` -- `closestDist = |pRel|`.
 *   - `tStar > lookaheadS`: the asteroid is still approaching at
 *     the horizon edge. The min over the window is at `t =
 *     lookaheadS`. Honors the cognitive cap so the brain never
 *     commits to dodging based on an event outside its look-ahead.
 *   - Walking the path for `tStar` after clamping yields the
 *     WINDOWED minimum, not the closed-form geodesic minimum.
 *
 * The brain uses `closestDist` ONLY (not `tStar`) -- if the asteroid
 * is going to come within `dodgeMarginU` of the ship at any time in
 * the next `lookaheadS` seconds, the brain DODGEs. `tStar` may be
 * added to a future visualization HUD ("Threat: t=0.32s, d=0.5u")
 * but isn't on the critical-path for the steering decision.
 *
 * @param {{ pRel: { x: number, z: number }, vRel: { x: number, z: number }, lookaheadS: number }} args
 * @returns {{ closestDist: number, tStar: number }}
 */
export function computeClosestApproach({ pRel, vRel, lookaheadS }) {
  if (!pRel || typeof pRel.x !== 'number' || typeof pRel.z !== 'number') {
    return { closestDist: Infinity, tStar: 0 };
  }
  // |pRel|^2 -- the CURRENT distance squared (always non-negative).
  const pRelMagSq = pRel.x * pRel.x + pRel.z * pRel.z;
  if (!vRel || typeof vRel.x !== 'number' || typeof vRel.z !== 'number') {
    return { closestDist: Math.sqrt(pRelMagSq), tStar: 0 };
  }
  const vRelMagSq = vRel.x * vRel.x + vRel.z * vRel.z;
  if (vRelMagSq === 0) {
    // No relative motion -- current distance IS the closest distance.
    return { closestDist: Math.sqrt(pRelMagSq), tStar: 0 };
  }
  // pRel . vRel -- sign tells us whether the closing velocity is
  // positive (approaching) or negative (receding).
  const pRelDotVRel = pRel.x * vRel.x + pRel.z * vRel.z;
  // Time of closest approach (unconstrained). Negative =>
  // asteroid is at its closest point RIGHT NOW and moving away.
  const tStarFree = -pRelDotVRel / vRelMagSq;
  // Clamp tStar to the lookahead window. When tStarFree is OUTSIDE
  // [0, lookaheadS], the minimum over the window sits at the
  // boundary (parabola is convex -- strictly monotonic over any
  // bounded interval). When tStarFree is INSIDE the window, the
  // geodesic minimum IS the unconstrained minimum (gradient zero).
  const tStar = Math.max(0, Math.min(lookaheadS, tStarFree));
  // Walk the relative path forward for `tStar` seconds (clamped) and
  // measure the distance to origin AT THAT POINT. This computes the
  // WINDOWED minimum uniformly across all three cases:
  //   - tStar = tStarFree (in window): distance at the geodesic
  //     minimum. Mathematically equivalent to the closed-form
  //     `sqrt(|pRel|^2 - (pRel.vRel)^2 / |vRel|^2)`.
  //   - tStar = 0   (receding,      tStarFree < 0): distance at
  //     t=0 -- the asteroid's actual position right now (which IS
  //     the closest point in our window).
  //   - tStar = lookaheadS (slow approach, tStarFree > S): distance
  //     at the horizon edge.
  // The previous closed-form subtraction returned the UNCONSTRAINED
  // global minimum -- for a receding asteroid sitting at tStarFree=-0.2s
  // the formula gives the parabolic minimum at t=-0.2 (before our
  // window opens), which is meaningless for the lookahead decision.
  // Boundaries are now handled by walking the path, not by closed
  // form. No division-by-zero (vRelMagSq=0 is the early-return above).
  // No floating-point negatives (we sum squares, not subtract).
  const cx = pRel.x + vRel.x * tStar;
  const cz = pRel.z + vRel.z * tStar;
  const closestDist = Math.sqrt(cx * cx + cz * cz);
  return { closestDist, tStar };
}

/**
 * Pure: 2-phase intercept controller. Given a target position +
 * the ship's current velocity, return the steering + thrust that
 * approaches the target without overshooting in tight orbits.
 *
 * The v0.11.x 5-phase controller over-engineered this with per-phase
 * hardening that interacted badly in live gameplay. v0.12.x reduces
 * it to: BRAKE if closing too fast, otherwise APPROACH (or coast).
 *
 * v0.12.x — added a 5th arg `aiAngularVelocity` (default 0) for
 * SPIN-BRAKING inside the APPROACH branch. Without this, the ship's
 * angular inertia carries it across the steering deadband after the
 * brain stops commanding yaw, producing a visible left/right wiggle
 * as the ship oscillates past ±0.2 rad twice per "approach". The
 * spin-brake applies a counter-yaw to cancel the residual angular
 * velocity once the target is well within the steering deadband,
 * settling the heading. This is the most direct fix for the
 * "still nervous without a target" complaint — the wiggle was
 * visible even in WANDER mode via the heading-jitter refresh.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos
 * @param {number} [aiAngularVelocity=0] ship's current yaw rate. When
 *   |angVel| > 1.0 and the target is well within ±0.35 rad of forward,
 *   the brain applies opposite yaw to cancel inertia.
 * @returns {{ dist: number, yaw: number, thrust: boolean, diff: number, closingSpeed: number }}
 */
export function intercept(aiPos, aiYaw, aiVel, targetPos, aiAngularVelocity = 0) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // On top of (or inside) the target — let pickup radius absorb
    // the ship; no need to thrust. Demo AI never rams into pickups
    // head-first because the pickup radius (~2u) brings the ship
    // out of speed before contact.
    return { dist, yaw: 0, thrust: false, diff: 0, closingSpeed: 0 };
  }
  const facing = facingAngle(aiYaw);
  const speed = Math.hypot(aiVel.x, aiVel.z);
  const closingSpeed = (dx * aiVel.x + dz * aiVel.z) / dist;
  // desiredClosing: approach speed scales with distance but caps at
  // 15 u/s so very-close pickups (dist < 15) coast in at a low
  // desiredClosing.
  const desiredClosing = Math.min(15, dist);

  let yaw;
  let thrust;
  if (closingSpeed > desiredClosing && speed > 4) {
    // BRAKE: flip and burn opposite velocity. This is what kills
    // tangential orbiting — when the ship is closing from far
    // away at high speed, BRAKE rotates the velocity vector back
    // toward the target and burns it down.
    const brakeAngle = Math.atan2(-aiVel.z, -aiVel.x);
    const brakeDiff = wrapAngle(brakeAngle - facing);
    yaw = brakeDiff > 0.35 ? -1 : brakeDiff < -0.35 ? 1 : 0; // wider deadband 0.2 → 0.35
    // Thrust when pointed into the brake direction.
    thrust = Math.abs(brakeDiff) < 0.5;
  } else {
    // APPROACH / coast-in: steer toward target, thrust when
    // aligned AND we still need closing speed.
    const targetAngle = Math.atan2(dz, dx);
    const targetDiff = wrapAngle(targetAngle - facing);
    // v0.12.x — SPIN-BRAKE sub-phase. If the ship has significant
    // angular velocity AND the target is well within the steering
    // deadband (|targetDiff| < 0.35), the ship's natural inertia would
    // carry it past alignment and back across the deadband. Apply
    // opposite yaw to STOP the rotation rather than command steering
    // toward the target. Thrust is suspended during the brake so the
    // ship isn't accelerating through the deadband either.
    if (Math.abs(aiAngularVelocity) > 1.0 && Math.abs(targetDiff) < 0.35) {
      // Brake: oppose the current spin direction. Positive angVel =
      // ship rotating CCW (yaw rate > 0), so apply yaw=-1 to push
      // it back. Tested with `intercept(pos, yaw, vel, target, 2)`
      // for the positive-spin case.
      yaw = aiAngularVelocity > 0 ? -1 : 1;
      thrust = false;
      return {
        dist, yaw, thrust,
        diff: targetDiff,
        closingSpeed,
      };
    }
    yaw = targetDiff > 0.35 ? -1 : targetDiff < -0.35 ? 1 : 0; // wider deadband 0.2 → 0.35
    thrust = Math.abs(targetDiff) < 0.5 && closingSpeed < desiredClosing;
  }
  return { dist, yaw, thrust, diff: wrapAngle(Math.atan2(dz, dx) - facing), closingSpeed };
}

/**
 * Pure: HUNT-specific controller for STATIC targets (power-ups).
 *
 * The target doesn't move, so the trailer of v0.12.x's intercept
 * controller (BRAKE phase + Spin-Brake sub-phase) was producing
 * visible "wild left/right" wobble during long power-up chases:
 *
 *   - BRAKE flips the ship 180° at peak closing velocity. With a
 *     STATIC target (the power-up never moves), going 180° around
 *     at top speed is gratuitous — the ship lurches between
 *     "thrust toward" and "thrust away from a phantom threat",
 *     producing visible flailing at 200u distances.
 *   - Spin-Brake fires only at |aiAngularVelocity| > 1.0. Below
 *     the threshold, the ship's angular inertia carries the
 *     heading past alignment and back across the deadband,
 *     producing residual wiggles even at small angular velocities.
 *     The static target doesn't justify a sophisticated deadband-
 *     tuned brake; simpler is calmer.
 *
 * v0.19.x — dedicated HUNT controller: turn to face the target,
 * thrust when aligned, and trust the ship's `YAW_INERTIA_TAU=0.2`
 * angular momentum to settle the heading. No BRAKE phase, no
 * Spin-Brake sub-phase, no closing-speed throttle. The CALLER
 * still applies the existing `coastInDist` override for the
 * last-mile coast-in (preserved verbatim from aiBrainTick).
 *
 * Deadbands are slightly tighter than intercept's because HUNT
 * has no moving-target urgency:
 *   - yaw ±0.20 rad (vs intercept's ±0.35)
 *   - thrust ±0.35 rad (vs intercept's ±0.50)
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos
 * @returns {{ dist: number, yaw: number, thrust: boolean, diff: number, closingSpeed: number }}
 */
export function huntController(aiPos, aiYaw, aiVel, targetPos) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // On top of (or inside) the target — pickup radius absorbs.
    return { dist, yaw: 0, thrust: false, diff: 0, closingSpeed: 0 };
  }
  const targetAngle = Math.atan2(dz, dx);
  const diff = wrapAngle(targetAngle - facingAngle(aiYaw));
  const closingSpeed = (dx * aiVel.x + dz * aiVel.z) / dist;
  // Yaw deadband ±0.20: tighter than intercept's ±0.35 to encourage
  // steady alignment on a static target. The v0.12.x intercept's wider
  // deadband is tuned for moving targets where overcorrecting into a
  // chase orbit is worse than undercorrecting — irrelevant for HUNT.
  const yaw = diff > 0.20 ? -1 : diff < -0.20 ? 1 : 0;
  // Thrust whenever aligned within ±0.35 rad. There's no overshoot
  // concern with a static target, so the closingSpeed < desiredClosing
  // gate from intercept doesn't apply here — always close the gap.
  const thrust = Math.abs(diff) < 0.35;
  return { dist, yaw, thrust, diff, closingSpeed };
}

/**
 * Pure: pick the best in-range chase target. Returns `null` when
 * nothing's pressing. The power-up takes priority over an asteroid
 * chase (the player can see the AI chase the bonus instead of
 * chasing an asteroid mid-field). The returned object's `mode`
 * field distinguishes HUNT (power-up chase) from TARGET (asteroid
 * chase) for the HUD.
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   powerupPos: { x: number, z: number } | null,
 *   powerupHuntDist: number,
 *   targetDist: number,
 * }} args
 * @param {{ dist: number, asteroid: any } | null} nearestAsteroid
 * @returns {{ pos: { x: number, z: number }, mode: 'hunt' | 'target', dist: number } | null}
 */
function pickChase(args, nearestAsteroid) {
  if (args.powerupPos && typeof args.powerupPos.x === 'number') {
    const dx = args.powerupPos.x - args.aiPos.x;
    const dz = args.powerupPos.z - args.aiPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < args.powerupHuntDist) {
      return { pos: args.powerupPos, mode: 'hunt', dist };
    }
  }
  if (nearestAsteroid && nearestAsteroid.dist < args.targetDist) {
    return {
      pos: nearestAsteroid.asteroid.getPosition(),
      mode: 'target',
      dist: nearestAsteroid.dist,
    };
  }
  return null;
}

/**
 * Pure: decide what the AI should do this tick.
 *
 * Returns `{ yaw, thrust, mode, fire }` where:
 *   - `yaw`     ∈ {-1, 0, +1}       (steering; -1 = turn left, +1 = turn right)
 *   - `thrust`  boolean              (true = accelerate)
 *   - `mode`    'hunt' | 'dodge' | 'target' | 'wander'
 *   - `fire`    boolean              (true when a target ~ an asteroid for
 *                                     TARGET mode, or any asteroid for
 *                                     HUNT mode, is roughly in front of
 *                                     the ship — within the fire cone)
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   aiYaw: number,
 *   aiVel?: { x: number, z: number },
 *   aiAngularVelocity?: number,           // v0.12.x — for spin-brake
 *   asteroids: Array<{ getPosition: () => any }>,
 *   time: number,
 *   powerupPos?: { x: number, z: number } | null,
 *   dodgeDist?: number,
 *   targetDist?: number,
 *   wanderTurnPeriod?: number,
 *   wanderHeading?: number | null,
 *   wanderHeadingExpiresAt?: number,
 *   fireConeHalfAngle?: number,
 *   powerupHuntDist?: number,
 *   gapAwareDist?: number,                // v0.13.x — smart-wander threshold
 *   coastInDist?: number,                 // v0.13.x — close-range coast-in
 *   rng?: () => number,
 * }} args
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  aiVel = { x: 0, z: 0 },
  aiAngularVelocity = 0,
  asteroids,
  time,
  powerupPos = null,
  dodgeDist = DEFAULTS.dodgeDist,
  targetDist = DEFAULTS.targetDist,
  wanderTurnPeriod = DEFAULTS.wanderTurnPeriod,
  wanderHeading = null,
  wanderHeadingExpiresAt = 0,
  fireConeHalfAngle = DEFAULTS.fireConeHalfAngle,
  powerupHuntDist = DEFAULTS.powerupHuntDist,
  gapAwareDist = DEFAULTS.gapAwareDist,
  coastInDist = DEFAULTS.coastInDist,
  interceptLookaheadS = DEFAULTS.interceptLookaheadS,
  bulletSpeed = DEFAULTS.bulletSpeed,
  dodgeLookaheadS = DEFAULTS.dodgeLookaheadS,
  dodgeMarginU = DEFAULTS.dodgeMarginU,
  rng = Math.random,
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const nearest = findNearestAsteroid(aiPos, asteroids);

  // ---- 1. DODGE (highest priority) ------------------------------------
  // v0.18.x -- predictive DODGE: project each asteroid's relative
  // motion against the ship; if the projected closest approach
  // (within `dodgeLookaheadS` seconds) is < `dodgeMarginU`, trigger
  // the escape. Without this, DODGE fires only when the asteroid
  // is already within `dodgeDist` (currently 14u), which gives the
  // ship < 500ms to start escaping for fast-drifting rocks. With
  // prediction, the AI commits to an escape vector 1-2 seconds
  // earlier -- the difference between "threading the needle" and
  // "threading your way past safety pressure".
  //
  // `findDodgeAsteroid` returns the asteroid with the LOWEST
  // projected miss-distance (worst physical hit), with the
  // `computeClosestApproach({ pRel, vRel, lookaheadS })` helper
  // handling all the 2-body kinematics. When `dodgeLookaheadS=0`
  // (predictive disabled) or no projected threat is found within
  // the lookahead, fall back to the legacy "current dist < dodgeDist"
  // check. The predictive superset always covers the legacy cases
  // when lookaheadS > 0, so the legacy fallback fires only when
  // prediction is off.
  //
  // The escape angle is unchanged from v0.12.x: thrust 90° counter-
  // clockwise from the threat's CURRENT position. Future iterations
  // could shift to "perpendicular to relative velocity" (which gives
  // a guaranteed-missing trajectory) but the perpendicular-to-current
  // heuristic is well-tested and matches the existing semantics.
  function findDodgeAsteroid() {
    if (!aiVel) return nearest && nearest.dist < dodgeDist ? { asteroid: nearest.asteroid } : null;
    if (dodgeLookaheadS > 0) {
      let worst = null;
      let worstDist = Infinity;
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const aPos = a.getPosition();
        if (!aPos) continue;
        const aVel = lookupAsteroidVel(a);
        const vRel = {
          x: (aVel?.x ?? 0) - aiVel.x,
          z: (aVel?.z ?? 0) - aiVel.z,
        };
        const pRel = { x: aPos.x - aiPos.x, z: aPos.z - aiPos.z };
        const { closestDist } = computeClosestApproach({ pRel, vRel, lookaheadS: dodgeLookaheadS });
        if (closestDist < dodgeMarginU && closestDist < worstDist) {
          worstDist = closestDist;
          worst = a;
        }
      }
      if (worst) return { asteroid: worst };
    }
    // Fall-through: when predictive is off or no projected threats,
    // use the legacy "in current dodgeDist" check.
    if (nearest && nearest.dist < dodgeDist) return { asteroid: nearest.asteroid };
    return null;
  }
  const dodgeTarget = findDodgeAsteroid();
  if (dodgeTarget) {
    // Steer 90° counter-clockwise from the threat direction (in the
    // (x, z) atan2 frame), so the ship thrusts perpendicular to
    // the threat and escapes out the port (left) side. The diff is
    // in the atan2 frame — we compare the ship's ACTUAL facing
    // direction (facingAngle(yaw) = atan2(-cos(yaw), -sin(yaw)))
    // to the escape direction. Comparing to `yaw` directly would be
    // off by a 90° offset, because yaw=0 means the ship faces -Z,
    // not 0. See `facingAngle` for the math.
    const aPos = dodgeTarget.asteroid.getPosition();
    const threatAngle = Math.atan2(aPos.z - aiPos.z, aPos.x - aiPos.x);
    const escapeAngle = threatAngle + Math.PI / 2;
    const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
    return {
      yaw: diff > 0.1 ? -1 : diff < -0.1 ? 1 : 0,
      thrust: true,
      mode: 'dodge',
      fire: false,
    };
  }

  // ---- 2. HUNT or TARGET (intercept controller) -----------------------
  // Same controller drives both modes; HUNT additionally fires at
  // any in-cone asteroid (the AI shoots during the bonus chase so
  // it doesn't look like the brain is asleep mid-chase).
  const chase = pickChase(
    { aiPos, powerupPos, powerupHuntDist, targetDist },
    nearest,
  );
  if (chase) {
    // v0.15.x -- "lead when the lead aligns": both steer (intercept)
    // and fire (isTargetInFront, below) use the SAME predicted
    // point so the bullet (which inherits the ship's yaw via
    // main.js) meets the asteroid where it WILL BE rather than
    // where it WAS. v0.14.x only updated the steer side; fire
    // stayed on the current position which caused bullets to fire
    // off the past. v0.15.x closes that asymmetry for both TARGET
    // (single-asteroid fire check) and HUNT (per-asteroid loop).
    // Power-ups have no velocity, so HUNT-mode chase target stays
    // on the current position; DODGE stays on current too
    // (immediate threat, no time to predict).
    let targetPos = chase.pos;
    if (chase.mode === 'target') {
      const vel = lookupAsteroidVel(nearest && nearest.asteroid);
      // v0.16.x -- dynamic bullet-flight-time lead. We aim at where
      // the asteroid WILL BE when the bullet arrives, not at where
      // it will be in `interceptLookaheadS` seconds. Bullet flight
      // time for the current gap = dist / bulletSpeed (e.g. 90u TARGET
      // range = 0.225s, 14u DODGE range = 0.035s). The cap on
      // `interceptLookaheadS` remains so that very long chases don't
      // project farther than the brain's comfort zone.
      const distToTarget = Math.hypot(
        chase.pos.x - aiPos.x,
        chase.pos.z - aiPos.z,
      );
      const leadS = bulletSpeed > 0
        ? Math.min(distToTarget / bulletSpeed, interceptLookaheadS)
        : interceptLookaheadS;
      targetPos = predictPosition(chase.pos, vel, leadS) || chase.pos;
    }
    // v0.19.x -- HUNT/TARGET controller split. The HUNT-mode brain
    // uses `huntController` (no BRAKE, no Spin-Brake) because the
    // target is static and the v0.12.x intercept's trailer-of-
    // sophistication was producing visible wobble. TARGET keeps the
    // full intercept() controller (BRAKE + closing-speed throttle +
    // spin-brake) because moving asteroids warrant the heavier
    // machinery. Both paths share the same return shape so the
    // fire-path + coast-in logic below is identical regardless of
    // which controller fired.
    const ic = chase.mode === 'hunt'
      ? huntController(aiPos, aiYaw, aiVel, targetPos)
      : intercept(aiPos, aiYaw, aiVel, targetPos, aiAngularVelocity);
    let fire = false;
    if (chase.mode === 'target') {
      // v0.15.x -- lead-fire: use targetPos (predicted). The ship
      // has already rotated to point at targetPos via intercept();
      // firing when the predicted point is in cone is the natural
      // lead-shot — the bullet inherits the ship's direction and
      // meets the asteroid at its future position.
      fire = isTargetInFront(aiPos, aiYaw, targetPos, fireConeHalfAngle);
    } else {
      // HUNT: fire at any asteroid in cone (not just the chased
      // power-up). v0.15.x -- also lead-fire per asteroid: apply
      // predictPosition to each asteroid's current position so the
      // fire check uses the same predicted point the ship is
      // steering toward. The contract becomes "lead when the lead
      // aligns": both steer and fire converge on the future point.
      // Walks the asteroid list and breaks on first match — O(n) cheap.
      //
      // v0.16.x -- per-asteroid BULLET-FLIGHT-TIME lead. Instead of
      // a uniform `interceptLookaheadS` (= 0.5s default), each
      // asteroid's prediction is scaled to ITS distance:
      // `flightTime = dist / bulletSpeed`, capped at
      // `interceptLookaheadS` for cognitive comfort. Close rocks
      // (5u away, 400 u/s bullet) get ~12ms of lead; far ones
      // (90u away) get ~225ms. Without this, the uniform 0.5s lead
      // overshoots close targets (bullets arrive in ~12ms, not 500ms)
      // and undershoots distant ones (bullets arrive in 225ms+, fired
      // as if the lead needs 500ms). The cap is still the cognitive
      // comfort ceiling — the pilot won't commit to a lead beyond
      // their forward-prediction horizon regardless of physics.
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        if (!p) continue;
        const aVel = lookupAsteroidVel(a);
        const aDist = Math.hypot(p.x - aiPos.x, p.z - aiPos.z);
        const aLeadS = bulletSpeed > 0
          ? Math.min(aDist / bulletSpeed, interceptLookaheadS)
          : interceptLookaheadS;
        const aPredicted = predictPosition(p, aVel, aLeadS) || p;
        if (isTargetInFront(aiPos, aiYaw, aPredicted, fireConeHalfAngle)) {
          fire = true;
          break;
        }
      }
    }
    // v0.13.x -- close-range coast-in. When chasing the power-up
    // and within coastInDist of the pickup, override intercet's
    // thrust to false so the ship coasts into the pickup radius
    // (~2u) instead of ramming past it. Pickup radius absorbs the
    // ship regardless, but coasting prevents the AI from overshooting
    // the pickup at full thrust. Only applies to HUNT (pickups);
    // TARGET asteroid chase has no pickup radius and the AI's
    // collision-vs-asteroids is irrelevant (the AI doesn't die on
    // asteroid hits in v0.11.x).
    let thrust = ic.thrust;
    if (chase.mode === 'hunt' && chase.dist < coastInDist) {
      thrust = false;
    }
    return { yaw: ic.yaw, thrust, mode: chase.mode, fire };
  }

  // ---- 3. WANDER (default) --------------------------------------------
  // Pick (or refresh) a wander heading. The heading is an angle in
  // the (x, z) atan2 frame, so we compare it to the ship's actual
  // facing direction (facingAngle), not to `yaw` directly.
  //
  // v0.12.x logic for sparsely populated space (nearest beyond
  // gapAwareDist): when there's an asteroid in awareness range
  // (2.5x targetDist), bias the heading toward it with +/-27 degree
  // jitter. Otherwise pick random in [-PI, PI].
  //
  // v0.13.x -- smart-wander for DENSE space (nearest within
  // gapAwareDist = 80 units): sample 8 candidate headings evenly
  // offset around a rng() rotation, pick the one with the LEAST
  // nearby-aspect interference. This stops the ship from beelining
  // into a rock wall that happens to be in its current heading
  // direction. Existing v0.12.x determinism is preserved exactly
  // when the gap-aware branch doesn't trigger (the legacy branch
  // consumes the same 1 rng() call and produces the same numeric
  // output for tests/ai.test.js's existing fixtures).
  let heading = wanderHeading;
  let expiresAt = wanderHeadingExpiresAt;
  if (heading === null || time >= expiresAt) {
    const awarenessDist = targetDist * 2.5;
    heading = pickWanderHeading({
      aiPos,
      nearest,
      asteroids,
      gapAwareDist,
      awarenessDist,
      rng,
    });
    expiresAt = time + wanderTurnPeriod;
  }
  const diff = wrapAngle(heading - facingAngle(aiYaw));
  // v0.12.x — wider thrust-aligned deadband 0.6 → 0.7 so the ship
  // commits to thrust earlier and cruises. Combined with the
  // ±0.15 yaw steering deadband, this gives the WANDER the
  // "pick a heading and ride it out" feel of a human pilot — no
  // visible left/right oscillation during the long trek phase
  // between heading refreshes.
  const aligned = Math.abs(diff) < 0.7;
  return {
    yaw: diff > 0.15 ? -1 : diff < -0.15 ? 1 : 0, // wider deadband 0.1 → 0.15
    thrust: aligned,
    mode: 'wander',
    fire: false,
    _wanderHeading: heading,
    _wanderHeadingExpiresAt: expiresAt,
  };
}

/**
 * Decide whether the AI has drifted too far and should be reset.
 * Pure — no side effects.
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
 * @param {{
 *   scene: import('three').Scene,
 *   asteroids: Array<{ getPosition: () => any }>,
 *   weapon?: { fire: (opts: any) => number | boolean } | null,
 *   getPowerupPos?: () => { x: number, z: number } | null,
 *   options?: object,
 * }} opts
 */
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, options = {} } = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;
  const brain = opts.brain || null;

  // ---- Initial spawn ---------------------------------------------------
  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = initial.yaw;

  // ---- Wander state (mutable, private) --------------------------------
  let wanderHeading = null;
  let wanderHeadingExpiresAt = 0;
  let time = 0;
  let lastMode = 'wander';
  // v0.11.x — debounce state (humanization). Tracks the last
  // applied yaw + thrust command and the time at which it flipped.
  let lastYaw = 0;
  let lastYawFlipAt = -Infinity;
  let lastThrust = false;
  let lastThrustFlipAt = -Infinity;

  let enabled = true;

  // v0.13.x -- reaction latency observation buffer. Each tick we
  // snapshot the live ship state; the brain reads the snapshot that
  // is at least reactionLatencyS old. The buffer is capped at
  // BUFFER_CAP so long play sessions don't accumulate snapshots
  // unboundedly.
  let observationBuffer = [];
  // v0.13.x -- fire cadence: timestamp of the last successful fire.
  // The brain can ask for fire=true every frame; the SHIP only fires
  // every fireMinIntervalS, matching a real pilot's trigger cadence.
  let lastFireAt = -Infinity;
  // v0.13.x -- mode-hysteresis state. Tracks the last applied mode's
  // priority and the time it changed, so we can reuse the cached
  // decision on a downgrade for modeHysteresisS(-- anti-thrash).
  let lastModeChangeAt = -Infinity;
  let cachedDecision = null;
  const MODE_PRIORITY = Object.freeze({ dodge: 4, hunt: 3, target: 2, wander: 1 });

  function captureObservation() {
    return {
      aiPos: { x: ship.position.x, z: ship.position.z },
      aiYaw: ship.rotation.yaw,
      aiVel: { x: ship.velocity.x, z: ship.velocity.z },
      aiAngularVelocity: ship.angularVelocity ?? 0,
      // asteroid/powerup shared refs are ok; positions are static.
      asteroids,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      time,
    };
  }

  function argsFromObs(obs) {
    return {
      aiPos: obs.aiPos,
      aiYaw: obs.aiYaw,
      aiVel: obs.aiVel,
      aiAngularVelocity: obs.aiAngularVelocity,
      asteroids: obs.asteroids,
      time: obs.time,
      powerupPos: obs.powerupPos,
      dodgeDist: opts.dodgeDist,
      targetDist: opts.targetDist,
      wanderTurnPeriod: opts.wanderTurnPeriod,
      fireConeHalfAngle: opts.fireConeHalfAngle,
      powerupHuntDist: opts.powerupHuntDist,
      gapAwareDist: opts.gapAwareDist,
      coastInDist: opts.coastInDist,
      interceptLookaheadS: opts.interceptLookaheadS,
      bulletSpeed: opts.bulletSpeed,
      dodgeLookaheadS: opts.dodgeLookaheadS,
      dodgeMarginU: opts.dodgeMarginU,
      wanderHeading,
      wanderHeadingExpiresAt,
      rng,
    };
  }

  /**
   * Pick the snapshot in `buffer` whose `time` is closest to
   * (currentTime - latencyS) WITHOUT exceeding the cutoff. Iterating
   * without `break` gives the LAST eligible snapshot -- the one
   * closest to the latency target. Falls back to buffer[0] (the
   * oldest we have) when the buffer isn't old enough yet
   * (cold start, just-after-reset, or latencyS > buffer span).
   */
  function pickDelayedObservation(buffer, currentTime, latencyS) {
    const cutoff = currentTime - latencyS;
    let delayed = null;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].time <= cutoff) {
        delayed = buffer[i];
      }
    }
    return delayed || buffer[0];
  }

  /** Used by getMode() -- returns the LIVE brain args (not delayed). */
  function brainArgsFromShip() {
    // v0.16.x: forward interceptLookaheadS + bulletSpeed too so the
    // displayed mode reflects the same dynamic-lead contract the
    // production brain call uses (was missing these two before).
    // v0.18.x: forward dodgeLookaheadS + dodgeMarginU too so the
    // dashboard's "current mode" reflects the same predictive-DODGE
    // contract the production brain call uses -- if predictive
    // triggers fire here, getMode() will return 'dodge' and the
    // HUD will agree with the actual ship behavior.
    return {
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      aiVel: ship.velocity,
      aiAngularVelocity: ship.angularVelocity ?? 0,
      asteroids,
      time,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      dodgeDist: opts.dodgeDist,
      targetDist: opts.targetDist,
      wanderTurnPeriod: opts.wanderTurnPeriod,
      fireConeHalfAngle: opts.fireConeHalfAngle,
      powerupHuntDist: opts.powerupHuntDist,
      interceptLookaheadS: opts.interceptLookaheadS,
      bulletSpeed: opts.bulletSpeed,
      dodgeLookaheadS: opts.dodgeLookaheadS,
      dodgeMarginU: opts.dodgeMarginU,
      wanderHeading,
      wanderHeadingExpiresAt,
      rng,
    };
  }

  function update(dt) {
    if (dt <= 0) return;
    if (!enabled) return;
    time += dt;

    if (shouldResetAi(ship.position, opts.resetDist)) {
      const spawn = pickAiSpawn(opts.spawnRadius, rng);
      ship.reset(spawn.position);
      ship.rotation.yaw = spawn.yaw;
      wanderHeading = null;
      wanderHeadingExpiresAt = 0;
      // v0.13.x -- reset wipes stale snapshots (previous spawn
      // coords) AND the cached decision so the AI doesn't chase
      // an old wander heading after teleport.
      observationBuffer = [];
      cachedDecision = null;
    }

    // ---- v0.13.x: capture observation, pick delayed snapshot -----
    observationBuffer.push(captureObservation());
    const BUFFER_CAP = 32;
    while (observationBuffer.length > BUFFER_CAP) observationBuffer.shift();

    const sourceObs = (opts.reactionLatencyS > 0)
      ? pickDelayedObservation(observationBuffer, time, opts.reactionLatencyS)
      : observationBuffer[observationBuffer.length - 1];

    const args = argsFromObs(sourceObs);
    const rawDecision = brain ? brain.tick(args) : aiBrainTick(args);

    // ---- v0.13.x: mode-hysteresis (cached-decision reuse) ---------
    // On DOWNGRADE within modeHysteresisS, reuse the previous
    // decision's commands -- a real pilot commits to a chase and
    // doesn't instantly abandon when the target slips out of frame.
    // Upgrades (WANDER -> DODGE) are always immediate.
    let decision = rawDecision;
    if (opts.modeHysteresisS > 0 && cachedDecision !== null) {
      const currentPri = MODE_PRIORITY[cachedDecision.mode] ?? 0;
      const newPri = MODE_PRIORITY[rawDecision.mode] ?? 0;
      const sinceModeChange = time - lastModeChangeAt;
      if (newPri < currentPri && sinceModeChange < opts.modeHysteresisS) {
        decision = cachedDecision;
      }
    }
    if (decision !== cachedDecision || decision.mode !== lastMode) {
      lastMode = decision.mode;
      lastModeChangeAt = time;
    }
    cachedDecision = decision;
    if (decision._wanderHeading !== undefined) {
      wanderHeading = decision._wanderHeading;
    }
    if (decision._wanderHeadingExpiresAt !== undefined) {
      wanderHeadingExpiresAt = decision._wanderHeadingExpiresAt;
    }

    // ---- v0.11.x: humanize virtual key presses ----------------------
    // The brain's ±1 strobing produces visible heading stutter even
    // with the ship's angular inertia, and rapid thrust on/off
    // strobing produces engine-glow flicker + acceleration stutter.
    // We hold the previous command for the minimum hold time before
    // accepting a flip to a DIFFERENT non-zero value. Returning to
    // 0 (release a yaw) is NOT a flip and applies immediately so the
    // brain can stop turning as fast as it wants.
    let effectiveYaw = decision.yaw;
    let effectiveThrust = decision.thrust;
    if (opts.yawHoldTimeS > 0) {
      const yawIsFlip = decision.yaw !== 0 && decision.yaw !== lastYaw;
      if (yawIsFlip && (time - lastYawFlipAt) < opts.yawHoldTimeS) {
        effectiveYaw = lastYaw;
      } else if (yawIsFlip) {
        lastYaw = decision.yaw;
        lastYawFlipAt = time;
      } else if (decision.yaw === 0) {
        lastYaw = 0;
      }
    }
    if (opts.thrustHoldTimeS > 0) {
      const thrustIsFlip = decision.thrust !== lastThrust;
      if (thrustIsFlip && (time - lastThrustFlipAt) < opts.thrustHoldTimeS) {
        effectiveThrust = lastThrust;
      } else if (thrustIsFlip) {
        lastThrust = decision.thrust;
        lastThrustFlipAt = time;
      }
    }

    ship.setYaw(effectiveYaw);
    ship.setThrust(effectiveThrust);
    ship.update(dt);

    if (decision.fire && weapon && typeof weapon.fire === 'function') {
      // v0.13.x -- fire cadence gating. The brain can ask for fire
      // every frame; the SHIP only fires every fireMinIntervalS,
      // matching a real pilot's trigger cadence. First fire of the
      // run is always allowed (lastFireAt = -Infinity).
      let effectiveFire = true;
      if (opts.fireMinIntervalS > 0) {
        if ((time - lastFireAt) < opts.fireMinIntervalS) {
          effectiveFire = false;
        } else {
          lastFireAt = time;
        }
      }
      if (effectiveFire) {
        const yaw = ship.rotation.yaw;
        weapon.fire({
          origin: ship.position,
          direction: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
          asteroids,
        });
      }
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
