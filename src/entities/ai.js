/**
 * Demo AI — an NPC ship for the DEMO attract state.
 *
 * v0.37.0 — Predictive AI (Intercept + Predictive Evade + Lead Fire).
 *
 * Three new features that give the AI foresight:
 *   1. INTERCEPT POINT: instead of flying to target's current position,
 *      predict where the target WILL BE when the ship arrives.
 *   2. PREDICTIVE EVADE: look ahead N seconds along the flight path.
 *      If a collision is projected, dodge early (before emergency EVADE).
 *   3. LEAD FIRE: predict asteroid position at bullet arrival time.
 *
 * Mode priority: EVADE (<8u) → PREDICTIVE EVADE (0.8s lookahead) →
 *                ENGAGE (asteroid/powerup) → IDLE
 *
 * See LOG.md for the full performance protocol.
 *
 * --------------------------------------------------------------------------
 * How this AI is tuned with video + frame analysis
 * --------------------------------------------------------------------------
 * 1. Capture gameplay video (hands-off):
 *      ./scripts/run-ai-loop.sh --mode browser --seconds 180 --fps 3
 *    This starts a Vite dev server, opens a headless browser, records the
 *    canvas at 3 fps, and writes frames to artifacts/ai-tuning-run/.
 * 2. Analyze the captured frames:
 *      python3 scripts/analyze_frames.py artifacts/ai-tuning-run --fps 3
 *    The script computes per-frame brightness + motion, detects idle
 *    streaks, and writes artifacts/ai-tuning-run/analysis.json.
 * 3. Inspect the metrics (idle %, high-motion %, max idle streak) to
 *    decide which behavior is failing (e.g. powerup collection, aiming,
 *    evasive wobble). Adjust the constants / controllers below, then
 *    re-capture. The loop is fully automated and repeatable.
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU } from './ship-constants.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Ship collision radius (matches SHIP_RADIUS in src/systems/collision.js).
 * Used for radius-aware evade and collision threat detection.
 * v0.42.0: raised from 1.4 to 3.0 to match the 3x-scaled visual mesh.
 */
const SHIP_RADIUS = 3.0;

/**
 * Predictive evade buffer (world units). Added to ship + asteroid radius
 * to compute the collision margin. Replaces the old fixed margin.
 * v0.38.1: 1.5u — reduced from 3.0u after frame analysis showed 84%
 * high-motion frames. The 3.0u buffer was too conservative in the dense
 * field (~300 asteroids in 440u bubble), triggering false-positive
 * collision detection on grazing passes at 60-120u range. At 1.5u,
 * a large asteroid (r=6) has margin 1.4+6+1.5=8.9u — still safe at
 * 40-80 u/s combined closing speed, but eliminates most grazing passes.
 */
const PREDICTIVE_EVADE_BUFFER = 1.5;

/**
 * Emergency evade buffer (world units). Added to ship + asteroid radius
 * for the emergency EVADE threshold. v0.37.1: 2.0u → 1.0u nach Browser-Test
 * (264/s vs 536/s peak — 2.0u war zu konservativ). 1.0u gibt minimal clearance
 * ohne den Score zu drücken.
 */
const EVADE_BUFFER = 1.0;

const DEFAULTS = Object.freeze({
  /** Reset the AI ship if it drifts beyond this radius from origin. */
  resetDist: 220,
  /** Spawn radius (XZ) for the initial position + on-reset placement. */
  spawnRadius: 30,
  /** Vertical jitter on spawn (cosmetic). */
  spawnJitterY: 0,
  /** Initial yaw (radians). */
  spawnYaw: 0,

  /**
   * Evade distance (world units). When the nearest asteroid is closer
   * than this, the AI thrusts 90° perpendicular — emergency reflex.
   * v0.34.1: 8u. Large asteroids have radius ~6u, ship radius ~1.4u,
   * collision at 7.4u center-distance. 8u provides minimal safe margin.
   * DO NOT reduce below 8 — the ship will collide with large asteroids.
   */
  evadeDist: 8,

  /**
   * Intercept look-ahead (seconds). Maximum horizon for predicting
   * the target's future position. The ship flies to the predicted
   * intercept point instead of the target's current position.
   * v0.37.0: 2.0s — caps prediction at distant targets.
   */
  interceptLookaheadS: 2.0,

  /**
   * Predictive evade look-ahead (seconds). The AI checks its current
   * flight path for collisions this far into the future. If a collision
   * is projected, it dodges perpendicular to its velocity vector.
   * v0.38.1: 0.8s — reduced from 1.5s after frame analysis showed 84%
   * high-motion frames. 1.5s at 50-80 u/s scans 75-120u, still too wide
   * in a 300-asteroid field. At 0.8s the corridor is ~40-64u, roughly
   * 1/3 of the streaming bubble width. Combined with the tightened
   * PREDICTIVE_EVADE_BUFFER (3.0→1.5), this eliminates most grazing-pass
   * false positives while keeping real collision protection.
   */
  predictiveEvadeLookahead: 0.8,

  /**
   * Predictive evade margin is now computed per-asteroid as:
   *   SHIP_RADIUS (1.4) + asteroid.getRadius() + PREDICTIVE_EVADE_BUFFER (1.5)
   * This constant is no longer a tunable default — see findCollisionThreat.
   * Retained as a no-op alias for backward compat in external callers.
   */
  predictiveEvadeMargin: 0,

  /**
   * Bullet speed (u/s) for lead-fire prediction. Must match
   * BULLET_SPEED in src/entities/bullet.js. Used to compute flight
   * time = dist / bulletSpeed, then predict asteroid position at
   * bullet arrival. Set to 0 to disable lead fire.
   * v0.37.0: 400 u/s — matches the bullet pool.
   */
  bulletSpeed: 400,

  /**
   * Powerup detour bias (world units). Powerups are high-value
   * targets, so the AI should go out of its way to collect them.
   * A powerup wins over the nearest asteroid when it is within
   * `best.dist + powerupBiasU`. v0.41.0: raised from 25 to 80 so
   * the AI actually chases powerups without abandoning combat for
   * pickups that are far across the field.
   * v0.41.1: raised to 9999 to make powerups absolute priority
   * within powerupMaxChaseDist (they still lose to emergency evade).
   */
  powerupBiasU: 9999,

  /**
   * Maximum distance (world units) at which the AI will chase a
   * powerup. Prevents the AI from flying 200u across the bubble
   * for a single pickup while ignoring all asteroids.
   * v0.41.0: added to cap powerup pursuit.
   * v0.41.1: raised to 250 so the AI can reach powerups anywhere
   * in the streaming bubble (~220u radius).
   */
  powerupMaxChaseDist: 250,

  /**
   * Thrust heading gate (radians). Ship thrusts when |heading diff|
   * is within this angle AND the target is beyond coastDist.
   * v0.38.2: 0.15 rad ≈ 8.6° — reduced from 0.25 rad (14°). Frame
   * analysis showed the wider gate caused constant high-speed motion
   * (88% high-motion frames). 0.15 enforces stop-turn-thrust behavior:
   * the ship turns toward target without thrusting, then accelerates
   * once nearly aligned. This keeps speed in check and prevents
   * perpetual orbiting at high velocity.
   */
  thrustHeadingGate: 0.15,

  /** Fire heading gate (radians). v0.35.0: 0.30 rad ≈ 17.2°. */
  fireHeadingGate: 0.30,

  /**
   * Fire distance range (world units). v0.38.0: increased upper bound to 90u
   * from 60u. 90u matches ~1/3 of the streaming bubble radius, letting the
   * AI engage targets earlier instead of cruising silently toward them.
   */
  fireMinDist: 0,
  fireMaxDist: 90,

  /** Target stickiness hysteresis (world units). */
  hysteresisU: 8,

  /** Laser fire heading gate (radians). 0.20 rad ≈ 11.5°. */
  laserFireHeadingGate: 0.20,

  /** Coast-in distance (world units). */
  coastDist: 40,
});

/**
 * Yaw deadband (radians). Stop turning when the predicted heading
 * is within this angle of the target. Spin-brake prediction
 * (YAW_INERTIA_TAU) prevents overshoot wobble.
 * 0.08 rad ≈ 4.6° — tight enough for accurate firing, loose enough
 * to not fight YAW_INERTIA_TAU settling.
 */
const YAW_DEADBAND = 0.08;

// --------------------------------------------------------------------------
// Private helpers
// --------------------------------------------------------------------------

/**
 * Normalize an angle to (-PI, PI].
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

// --------------------------------------------------------------------------
// Exported pure helpers
// --------------------------------------------------------------------------

/**
 * Convert a ship rotation `yaw` (ship.js convention: forward = (-sin(yaw), 0, -cos(yaw)))
 * into the angle of that forward vector in atan2(z, x) space.
 * yaw = 0 → faces -Z → atan2(z, x) = -π/2.
 *
 * @param {number} yaw  radians
 * @returns {number}    radians in (-PI, PI]
 */
export function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/**
 * Predict the intercept point between the ship and a moving target.
 * Uses 2 iterations of time-of-arrival refinement. For stationary targets
 * (velocity = 0) returns the current position. Caps prediction horizon
 * at `maxLookaheadS` so the AI doesn't over-lead distant targets.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos
 * @param {{x:number,z:number}} targetVel
 * @param {number} [maxLookaheadS=2.0]
 * @returns {{ point: {x:number,z:number}, time: number }}
 */
export function predictInterceptPoint(aiPos, aiVel, targetPos, targetVel, maxLookaheadS = DEFAULTS.interceptLookaheadS) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  const speed = Math.hypot(aiVel.x, aiVel.z);
  if (dist < 1) {
    return { point: { x: targetPos.x, z: targetPos.z }, time: 0 };
  }

  // v0.39.0: Always predict the target's future position, even when the
  // ship is currently slow. Without this, a stationary or slow ship
  // chasing a moving powerup aims at the powerup's current position and
  // misses the pickup. The prediction horizon is capped so the AI does not
  // over-lead distant targets.
  const targetSpeed = Math.hypot(targetVel.x, targetVel.z);
  if (targetSpeed < 0.01) {
    // Stationary target: aim at current position, but still report the
    // travel time (capped by the lookahead horizon) so callers can use
    // the time value consistently.
    const t = speed < 1 ? maxLookaheadS : Math.min(dist / speed, maxLookaheadS);
    return { point: { x: targetPos.x, z: targetPos.z }, time: t };
  }

  // Iterative intercept: start with time = dist / speed, refine twice.
  // If the ship is almost stationary, use a small effective speed so the
  // prediction stays bounded and doesn't snap to the far horizon.
  const effectiveSpeed = speed < 1 ? 1 : speed;
  let t = Math.min(dist / effectiveSpeed, maxLookaheadS);
  for (let i = 0; i < 2; i++) {
    const px = targetPos.x + targetVel.x * t;
    const pz = targetPos.z + targetVel.z * t;
    const newDist = Math.hypot(px - aiPos.x, pz - aiPos.z);
    t = Math.min(newDist / effectiveSpeed, maxLookaheadS);
  }
  return {
    point: { x: targetPos.x + targetVel.x * t, z: targetPos.z + targetVel.z * t },
    time: t,
  };
}

/**
 * Predict where a pushed powerup will come to rest.
 * Powerup push velocity decays exponentially (`drag = exp(-3 * dt)`),
 * so its final XZ position is `pos + vel / 3`. Aiming at the resting
 * point prevents the AI from over-leading a powerup that stops quickly.
 *
 * @param {{x:number,z:number}} pos
 * @param {{x:number,z:number}} vel
 * @returns {{x:number,z:number}}
 */
export function predictPowerupRestingPoint(pos, vel) {
  return {
    x: pos.x + vel.x / 3,
    z: pos.z + vel.z / 3,
  };
}

/**
 * Find the nearest collision threat along the ship's current flight path
 * within a look-ahead horizon. Uses closest-approach kinematics.
 *
 * Returns the asteroid with the smallest projected miss distance, or
 * null if no asteroid is on a collision course within the horizon.
 *
 * v0.38.1: Uses asteroid radius + SHIP_RADIUS + PREDICTIVE_EVADE_BUFFER (1.5).
 * Small asteroids (r=1) get smaller margin (3.9u), large ones
 * (r=6) get larger margin (8.9u).
 *
 * @param {{x:number,z:number}} aiPos
 * @param {{x:number,z:number}} aiVel
 * @param {Array<{getPosition: () => any, getVelocity?: () => any, getRadius?: () => number}>} asteroids
 * @param {number} [lookaheadS=0.8]
 * @returns {{ asteroid: any, tStar: number, closestDist: number } | null}
 */
export function findCollisionThreat(aiPos, aiVel, asteroids, lookaheadS = DEFAULTS.predictiveEvadeLookahead) {
  let best = null;
  let bestDist = Infinity;
  const ax = aiPos.x, az = aiPos.z;
  const vx = aiVel.x, vz = aiVel.z;
  const vMagSq = vx * vx + vz * vz;
  if (vMagSq < 0.01) return null; // stationary — can't predict

  for (const a of asteroids) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const p = a.getPosition();
    if (!p) continue;
    const vel = (typeof a.getVelocity === 'function') ? a.getVelocity() : { x: 0, z: 0 };

    // v0.37.1: Radius-aware margin — compute effective collision radius
    // for THIS asteroid: shipRadius + asteroidRadius + buffer.
    const astRadius = (typeof a.getRadius === 'function') ? a.getRadius() : 0;
    const effectiveMargin = SHIP_RADIUS + astRadius + PREDICTIVE_EVADE_BUFFER;

    // Relative motion: r(t) = r0 + v_rel * t
    const rx = p.x - ax;
    const rz = p.z - az;
    const rvx = vel.x - vx;
    const rvz = vel.z - vz;
    const rvMagSq = rvx * rvx + rvz * rvz;
    if (rvMagSq < 0.01) continue; // parallel / stationary relative

    // Time of closest approach (gradient of |r(t)|² = 0)
    const tStar = -(rx * rvx + rz * rvz) / rvMagSq;
    if (tStar < 0 || tStar > lookaheadS) continue;

    const projX = rx + rvx * tStar;
    const projZ = rz + rvz * tStar;
    const closestDist = Math.hypot(projX, projZ);

    if (closestDist < effectiveMargin && closestDist < bestDist) {
      bestDist = closestDist;
      best = { asteroid: a, tStar, closestDist };
    }
  }
  return best;
}

/**
 * Find the nearest asteroid to a point. Returns `null` if the list
 * is empty.
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
 * True if the given target position is in front of a ship at
 * `aiPos` facing `aiYaw`, within a half-angle cone of `halfAngle`.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw  radians
 * @param {{x:number,z:number}} targetPos
 * @param {number} halfAngle  radians
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
 * Pick the best in-range chase target.
 *
 * Rules:
 *   1. If a powerup exists and is within target range, it wins if
 *      `powerupDist < asteroidDist + powerupBiasU`.
 *   2. Otherwise, the nearest asteroid wins.
 *   3. If neither is in range, returns null (idle).
 *
 * Returns `{ pos, vel, mode, dist, radius }` where:
 *   - `vel` is the target's velocity (intercept prediction).
 *   - `radius` is the target's physical radius (0 for powerups).
 *   Powerups have a velocity (read from getVelocity if available) and radius 0.
 *
 * @param {{
 *   aiPos: {x:number,z:number},
 *   asteroids: Array<{getPosition: () => any, getVelocity?: () => any, getRadius?: () => number}>,
 *   powerupPos: {x:number,z:number} | null,
 *   powerupVel?: {x:number,z:number},
 *   powerupBiasU: number,
 *   powerupMaxChaseDist?: number,
 *   committedPos?: {x:number,z:number} | null,
 *   hysteresisU?: number,
 *   evadeDist?: number,
 * }} args
 * @returns {{ pos: {x:number,z:number}, vel: {x:number,z:number}, mode: 'asteroid'|'powerup', dist: number, radius?: number } | null}
 */
export function pickTarget({ aiPos, asteroids, powerupPos, powerupVel = { x: 0, z: 0 }, powerupBiasU, powerupMaxChaseDist = DEFAULTS.powerupMaxChaseDist, committedPos = null, hysteresisU = 8, evadeDist = DEFAULTS.evadeDist }) {
  const nearest = findNearestAsteroid(aiPos, asteroids);
  let best = null;
  if (nearest) {
    // v0.37.1: Include asteroid radius for surface-distance calculations.
    const astRadius = (typeof nearest.asteroid.getRadius === 'function')
      ? nearest.asteroid.getRadius()
      : 0;
    best = {
      pos: nearest.asteroid.getPosition(),
      vel: typeof nearest.asteroid.getVelocity === 'function'
        ? nearest.asteroid.getVelocity()
        : { x: 0, z: 0 },
      mode: 'asteroid',
      dist: nearest.dist,
      radius: astRadius,
    };
  }

  // v0.41.1: Evaluate powerup priority against the NEAREST asteroid,
  // NOT the committed target. Committed-target stickiness is applied
  // AFTER the powerup decision so a distant committed asteroid cannot
  // block a reachable powerup.
  if (powerupPos && typeof powerupPos.x === 'number') {
    const pDist = Math.hypot(powerupPos.x - aiPos.x, powerupPos.z - aiPos.z);
    // Powerups are absolute-priority targets. They win over asteroids
    // unless the nearest asteroid is an immediate collision threat (inside
    // the evade radius) or the powerup is too far away to chase. The old
    // "urgent asteroid" check (<35u) blocked powerup collection whenever
    // any asteroid was nearby, which is almost always true in the dense field.
    const asteroidIsThreat = best && best.mode === 'asteroid' && best.dist < evadeDist;
    const withinChaseRange = pDist <= powerupMaxChaseDist;
    if (best === null && withinChaseRange) {
      return { pos: powerupPos, vel: powerupVel, mode: 'powerup', dist: pDist, radius: 0 };
    }
    // Always collect close powerups.
    if (pDist < 25) {
      return { pos: powerupPos, vel: powerupVel, mode: 'powerup', dist: pDist, radius: 0 };
    }
    // Powerup wins if it's within the maximum chase distance and no
    // asteroid is an immediate collision threat. With powerupBiasU=9999,
    // the bias check is effectively "always win within range".
    if (!asteroidIsThreat && withinChaseRange && pDist < best.dist + powerupBiasU) {
      return { pos: powerupPos, vel: powerupVel, mode: 'powerup', dist: pDist, radius: 0 };
    }
  }

  // Target stickiness: if the committed target is still in the asteroid
  // list and the nearest alternative is only slightly closer, keep the
  // committed target. Reduces zigzag in dense fields — the AI finishes
  // what it started instead of constantly switching.
  // Applied AFTER the powerup decision so committed asteroids never
  // block powerup collection.
  if (committedPos && typeof committedPos.x === 'number' && best) {
    const cDist = Math.hypot(committedPos.x - aiPos.x, committedPos.z - aiPos.z);
    if (cDist < best.dist + hysteresisU) {
      // Committed target is close enough — prefer it.
      // Preserve radius for surface-distance brake/coast (v0.37.1).
      best = { pos: committedPos, vel: { x: 0, z: 0 }, mode: 'asteroid', dist: cDist, radius: best.radius };
    }
  }

  return best;
}

/**
 * Engagement controller: turn toward an aim point (e.g. bullet lead or
 * intercept point), thrust when aligned. The distance used for braking /
 * coasting is measured to the navigation point (the physical target), so
 * the ship can face one direction while decelerating based on the actual
 * target range.
 *
 * v0.37.0: intercept prediction — the `targetVel` parameter enables
 * aiming at the predicted future position of moving targets.
 * v0.39.1: `aimPos` parameter added so the ship can face the bullet-lead
 * point while braking/coasting based on the physical target position.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos  physical target (used for distance/brake/coast)
 * @param {number} [aiAngularVel=0]  for spin-brake prediction
 * @param {number} [thrustGate=0.15] heading gate for thrust
 * @param {number} [coastDist=40]    coast-in distance (center-to-center)
 * @param {boolean} [wasBraking=false] hysteresis: already braking
 * @param {boolean} [allowBrake=true] allow brake logic (flip 180° and thrust backward)
 * @param {number} [interceptLookaheadS=2.0] intercept horizon (unused when aimPos provided)
 * @param {number} [brakeDist=30] distance at which active braking starts.
 * @param {number} [interceptLookaheadS=2.0] intercept horizon (unused when aimPos provided)
 * @param {boolean} [allowCoast] allow coast-in (cut thrust when close + closing fast).
 *   Defaults to `allowBrake` for backward compat. Separated so powerups can
 *   coast without braking.
 * @param {{x:number,z:number}} [aimPos] point the ship should face (defaults to targetPos)
 * @returns {{ yaw: number, thrust: boolean, diff: number, dist: number, braking: boolean }}
 */
export function engageTarget(aiPos, aiYaw, aiVel, targetPos, aiAngularVel = 0, thrustGate = DEFAULTS.thrustHeadingGate, coastDist = DEFAULTS.coastDist, wasBraking = false, allowBrake = true, brakeDist = 30, interceptLookaheadS = DEFAULTS.interceptLookaheadS, allowCoast, aimPos = targetPos) {
  // Default allowCoast to allowBrake for backward compat.
  if (typeof allowCoast !== 'boolean') allowCoast = allowBrake;

  const dx = aimPos.x - aiPos.x;
  const dz = aimPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return { yaw: 0, thrust: false, diff: 0, dist: 0 };

  // Face toward intercept point
  const faceAngle = Math.atan2(dz, dx);
  const targetDiff = wrapAngle(faceAngle - facingAngle(aiYaw));
  const angVel = (typeof aiAngularVel === 'number') ? aiAngularVel : 0;
  const predictedDiff = wrapAngle(targetDiff + angVel * YAW_INERTIA_TAU);

  // Yaw: spin-brake prediction prevents wobble
  const yaw = predictedDiff > YAW_DEADBAND ? -1
    : predictedDiff < -YAW_DEADBAND ? 1
    : 0;

  // Thrust: fire engines when aligned AND either beyond coast-in
  // distance OR not closing fast.
  const vel = aiVel || { x: 0, z: 0 };
  const speed = Math.hypot(vel.x, vel.z);
  const closingSpeed = dist > 0.01 ? (vel.x * dx + vel.z * dz) / dist : 0;

  // v0.35.0 — active brake with speed-based hysteresis (FIX).
  // Brake and coast use center-to-center distance (not surface distance),
  // because the ship flies toward the center point. The radius-aware
  // EVADE and findCollisionThreat handle collision avoidance separately.
  const BRAKE_ENTER_SPEED = 20;
  const BRAKE_EXIT_SPEED = 10;
  const shouldStartBrake = allowBrake && dist < brakeDist && closingSpeed > BRAKE_ENTER_SPEED;
  const shouldKeepBraking = allowBrake && wasBraking && speed > BRAKE_EXIT_SPEED;
  if (shouldStartBrake || shouldKeepBraking) {
    const velAngle = Math.atan2(vel.z, vel.x);
    const brakeAngle = velAngle + Math.PI;
    const brakeDiff = wrapAngle(brakeAngle - facingAngle(aiYaw));
    const brakeYaw = brakeDiff > YAW_DEADBAND ? -1 : brakeDiff < -YAW_DEADBAND ? 1 : 0;
    return { yaw: brakeYaw, thrust: true, diff: brakeDiff, dist, braking: true };
  }

  const COAST_SPEED_THRESHOLD = 5;
  const shouldCoast = allowCoast && dist < coastDist && closingSpeed > COAST_SPEED_THRESHOLD;
  const isAligned = Math.abs(targetDiff) < thrustGate;
  const thrust = isAligned && !shouldCoast;

  return { yaw, thrust, diff: targetDiff, dist, braking: false };
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
 * Build a random spawn position within `radius` of the origin.
 * Pure.
 *
 * @param {number} radius
 * @param {() => number} [rng]
 * @returns {{ position: {x:number,y:number,z:number}, yaw: number }}
 */
export function pickAiSpawn(radius = DEFAULTS.spawnRadius, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const r = radius * (0.4 + rng() * 0.6);
  return {
    position: { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
    yaw: rng() * Math.PI * 2,
  };
}

/**
 * Pure: decide what the AI should do this tick.
 *
 * Returns `{ yaw, thrust, mode, fire, braking }` where:
 *   - `yaw`     ∈ {-1, 0, +1}
 *   - `thrust`  boolean
 *   - `mode`    'evade' | 'asteroid' | 'powerup' | 'idle'
 *   - `fire`    boolean
 *   - `braking` boolean  (hysteresis: true if actively braking)
 *
 * Priority: EVADE → PREDICTIVE EVADE → ENGAGE → IDLE
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   aiYaw: number,
 *   aiVel?: { x: number, z: number },
 *   aiAngularVel?: number,
 *   asteroids: Array<{ getPosition: () => any, getVelocity?: () => any }>,
 *   time: number,
 *   powerupPos?: { x: number, z: number } | null,
 *   evadeDist?: number,
 *   powerupBiasU?: number,
 *   committedPos?: {x:number,z:number} | null,
 *   hysteresisU?: number,
 *   fireMinDist?: number,
 *   fireMaxDist?: number,
 *   thrustHeadingGate?: number,
 *   fireHeadingGate?: number,
 *   activeWeapon?: 'bullet' | 'laser',
 *   laserFireHeadingGate?: number,
 *   wasBraking?: boolean,
 *   predictiveEvadeLookahead?: number,
 *   predictiveEvadeMargin?: number,
 *   interceptLookaheadS?: number,
 *   bulletSpeed?: number,
 *   panicDist?: number,
 * }} args
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  aiVel = { x: 0, z: 0 },
  aiAngularVel = 0,
  asteroids,
  time,
  powerupPos = null,
  powerupVel = { x: 0, z: 0 },
  evadeDist = DEFAULTS.evadeDist,
  powerupBiasU = DEFAULTS.powerupBiasU,
  powerupMaxChaseDist = DEFAULTS.powerupMaxChaseDist,
  fireMinDist = DEFAULTS.fireMinDist,
  fireMaxDist = DEFAULTS.fireMaxDist,
  thrustHeadingGate = DEFAULTS.thrustHeadingGate,
  fireHeadingGate = DEFAULTS.fireHeadingGate,
  activeWeapon = 'bullet',
  laserFireHeadingGate = DEFAULTS.laserFireHeadingGate,
  coastDist = DEFAULTS.coastDist,
  committedPos = null,
  hysteresisU = DEFAULTS.hysteresisU,
  wasBraking = false,
  // v0.37.0 predictive features
  predictiveEvadeLookahead = DEFAULTS.predictiveEvadeLookahead,
  interceptLookaheadS = DEFAULTS.interceptLookaheadS,
  bulletSpeed = DEFAULTS.bulletSpeed,
  // Legacy param
  panicDist = undefined,
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const ed = (panicDist !== undefined && evadeDist === DEFAULTS.evadeDist)
    ? panicDist : evadeDist;

  const speed = Math.hypot(aiVel.x, aiVel.z);
  const nearest = findNearestAsteroid(aiPos, asteroids);

  // ---- 1. EVADE (nearest asteroid within radius-aware threshold) ------
  // v0.37.1: Emergency evade threshold = shipRadius + asteroidRadius +
  // EVADE_BUFFER. For a large asteroid (r=6): 1.4 + 6 + 2 = 9.4u.
  // For a small asteroid (r=1): 1.4 + 1 + 2 = 4.4u.
  // This ensures the ship has EVADE_BUFFER=2.0u clearance before
  // collision regardless of target size.
  // v0.37.1: Radius-aware evade threshold.
  // The caller's `ed` (from evadeDist or panicDist) serves as a FLOOR —
  // the AI never evades at LESS than this distance. But for large
  // asteroids, the computed threshold (shipRadius + asteroidRadius +
  // EVADE_BUFFER) may be larger, triggering earlier evasion. Uses
  // Math.max so explicit test overrides still work (e.g. evadeDist=2
  // in engagement tests).
  let evadeThreshold = ed;
  if (nearest) {
    const nearRadius = (typeof nearest.asteroid.getRadius === 'function')
      ? nearest.asteroid.getRadius()
      : 0;
    evadeThreshold = Math.max(ed, SHIP_RADIUS + nearRadius + EVADE_BUFFER);
  }
  if (nearest && nearest.dist < evadeThreshold) {
    const threatAngle = Math.atan2(nearest.dz, nearest.dx);
    const escapeAngle = threatAngle + Math.PI / 2;
    const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
    return {
      yaw: diff > 0.05 ? -1 : diff < -0.05 ? 1 : 0,
      thrust: true,
      mode: 'evade',
      fire: false,
      braking: false,
    };
  }

  // ---- 1.5. PREDICTIVE EVADE (lookahead collision detection) -----------
  // v0.37.0: check if the ship's current trajectory intersects an asteroid
  // within the lookahead horizon. Dodge perpendicular to flight path BEFORE
  // the emergency EVADE triggers. Only fires when the ship is moving
  // (speed > 1) — stationary ships fall through to normal evade.
  if (speed > 1) {
    const collision = findCollisionThreat(aiPos, aiVel, asteroids, predictiveEvadeLookahead);
    if (collision) {
      const escapeAngle = Math.atan2(aiVel.z, aiVel.x) + Math.PI / 2;
      const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
      return {
        yaw: diff > 0.05 ? -1 : diff < -0.05 ? 1 : 0,
        thrust: true,
        mode: 'evade',
        fire: false,
        braking: false,
      };
    }
  }

  // ---- 2. ENGAGE (pick target + approach with intercept) --------------
  const target = pickTarget({ aiPos, asteroids, powerupPos, powerupVel, powerupBiasU, powerupMaxChaseDist, committedPos, hysteresisU, evadeDist: ed });
  if (target) {
    // v0.39.1: aim point is separate from navigation point.
    //   - Asteroids: face the bullet-lead point so the ship shoots where
    //     the target will be when bullets arrive.
    //   - Powerups: face the resting point (powerup velocity decays
    //     exponentially, so it stops much sooner than linear prediction).
    // Navigation (brake/coast distance) still uses the physical target pos.
    let aimPos = target.pos;
    if (target.mode === 'asteroid') {
      const dist = Math.hypot(target.pos.x - aiPos.x, target.pos.z - aiPos.z);
      const flightTime = bulletSpeed > 0 ? dist / bulletSpeed : 0;
      aimPos = {
        x: target.pos.x + target.vel.x * flightTime,
        z: target.pos.z + target.vel.z * flightTime,
      };
    } else if (target.mode === 'powerup') {
      aimPos = predictPowerupRestingPoint(target.pos, target.vel);
    }

    // v0.42.0: Powerups are non-colliding collectibles. The ship should
    // fly straight through them at full speed — active braking causes the
    // ship to flip 180° and arc away from the pickup, which is exactly the
    // "bogen" the user reported. Disable braking for powerups; rely on
    // linear drag and a tight coast-in distance to avoid overshoot.
    const isPowerup = target.mode === 'powerup';
    const ec = engageTarget(
      aiPos, aiYaw, aiVel, target.pos, aiAngularVel,
      thrustHeadingGate,
      isPowerup ? 8 : coastDist,
      wasBraking,
      !isPowerup, // allowBrake: false for powerups
      isPowerup ? 60 : 30,
      interceptLookaheadS,
      true, // allowCoast: true for powerups — cut thrust and glide into pickup radius
      aimPos,
    );

    // Fire discipline: fire when ANY asteroid is in the fire cone
    // within range. v0.37.0: uses LEAD FIRE — predicts asteroid
    // position at bullet arrival time.
    let fire = false;
    if (target.mode === 'powerup') {
      fire = false;
    } else if (activeWeapon === 'laser') {
      // Laser is instant — no lead needed.
      fire = isTargetInFront(aiPos, aiYaw, target.pos, laserFireHeadingGate);
    } else {
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        if (!p) continue;
        const dist = Math.hypot(p.x - aiPos.x, p.z - aiPos.z);
        if (dist < fireMinDist || dist > fireMaxDist) continue;

        // Distance-adaptive cone
        const adaptiveCone = Math.max(0.14, fireHeadingGate * (1 - dist / (fireMaxDist * 1.5)));

        // v0.37.0: Lead fire — predict asteroid position at bullet arrival.
        // bulletSpeed=0 disables lead (falls back to current position).
        let checkPos = p;
        if (bulletSpeed > 0) {
          const vel = (typeof a.getVelocity === 'function') ? a.getVelocity() : { x: 0, z: 0 };
          const flightTime = dist / bulletSpeed;
          if (flightTime > 0 && (vel.x !== 0 || vel.z !== 0)) {
            checkPos = { x: p.x + vel.x * flightTime, z: p.z + vel.z * flightTime };
          }
        }

        if (isTargetInFront(aiPos, aiYaw, checkPos, adaptiveCone)) {
          fire = true;
          break;
        }
      }
    }

    return {
      yaw: ec.yaw,
      thrust: ec.thrust,
      mode: target.mode,
      fire,
      braking: ec.braking,
    };
  }

  // ---- 3. IDLE (no targets) -------------------------------------------
  return { yaw: 0, thrust: false, mode: 'idle', fire: false, braking: false };
}

/**
 * Create a demo AI ship. Wires the brain to a live ship.
 *
 * @param {{
 *   scene: import('three').Scene,
 *   asteroids: Array<{ getPosition: () => any, getVelocity?: () => any }>,
 *   weapon?: { fire: (opts: any) => number | boolean } | null,
 *   getPowerupPos?: () => { x: number, z: number } | null,
 *   getActiveWeapon?: () => string,
 *   options?: object,
 * }} opts
 */
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, getPowerupVel = null, getActiveWeapon = null, options = {} } = {}) {
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
  let lastMode = 'idle';
  let isBraking = false;
  let lastDecision = {
    mode: 'idle',
    yaw: 0,
    thrust: false,
    fire: false,
    activeWeapon: 'bullet',
    target: null,
    nearest: null,
    threatsCount: 0,
  };
  let committedPos = null;

  function spawn() {
    const sp = pickAiSpawn(opts.spawnRadius, rng);
    ship.reset(sp.position);
    ship.rotation.yaw = sp.yaw;
    committedPos = null;
    isBraking = false;
  }

  /** Build the args the brain consumes from the live ship state. */
  function brainArgsFromShip() {
    return {
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      aiVel: { x: ship.velocity.x, z: ship.velocity.z },
      aiAngularVel: ship.angularVelocity,
      asteroids,
      time,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      powerupVel: getPowerupVel ? getPowerupVel() : { x: 0, z: 0 },
      evadeDist: opts.evadeDist,
      powerupBiasU: opts.powerupBiasU,
      powerupMaxChaseDist: opts.powerupMaxChaseDist,
      fireMinDist: opts.fireMinDist,
      fireMaxDist: opts.fireMaxDist,
      thrustHeadingGate: opts.thrustHeadingGate,
      fireHeadingGate: opts.fireHeadingGate,
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
      laserFireHeadingGate: opts.laserFireHeadingGate,
      coastDist: opts.coastDist,
      committedPos,
      hysteresisU: opts.hysteresisU,
      wasBraking: isBraking,
      // v0.37.0 predictive features
      predictiveEvadeLookahead: opts.predictiveEvadeLookahead,
      interceptLookaheadS: opts.interceptLookaheadS,
      bulletSpeed: opts.bulletSpeed,
    };
  }

  function update(dt) {
    if (dt <= 0) return;
    if (!enabled) return;
    time += dt;

    if (shouldResetAi(ship.position, opts.resetDist)) {
      spawn();
    }

    // Validate committedPos against live asteroids each frame.
    if (committedPos) {
      let found = false;
      let bestDist = Infinity;
      let bestPos = null;
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        if (!p) continue;
        const d = Math.hypot(p.x - committedPos.x, p.z - committedPos.z);
        if (d < bestDist) {
          bestDist = d;
          bestPos = p;
        }
        if (d < 5) { found = true; break; }
      }
      if (found && bestPos) {
        committedPos = { x: bestPos.x, z: bestPos.z };
      } else {
        committedPos = null;
      }
    }

    const args = brainArgsFromShip();
    const decision = brain ? brain.tick(args) : aiBrainTick(args);
    lastMode = decision.mode;
    isBraking = !!decision.braking;

    // Build decision snapshot for the AI debug overlay.
    const nearest = findNearestAsteroid(ship.position, asteroids);
    let threatsCount = 0;
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      const d = Math.hypot(p.x - ship.position.x, p.z - ship.position.z);
      if (d < opts.evadeDist) threatsCount += 1;
    }
    const target = pickTarget({
      aiPos: ship.position,
      asteroids,
      powerupPos: args.powerupPos,
      powerupVel: args.powerupVel,
      powerupBiasU: opts.powerupBiasU,
      powerupMaxChaseDist: opts.powerupMaxChaseDist,
    });
    lastDecision = {
      mode: decision.mode,
      yaw: decision.yaw,
      thrust: decision.thrust,
      fire: decision.fire,
      braking: !!decision.braking,
      activeWeapon: args.activeWeapon,
      target: target ? { pos: { ...target.pos }, mode: target.mode, dist: target.dist } : null,
      nearest: nearest ? { pos: { x: nearest.dx + ship.position.x, z: nearest.dz + ship.position.z }, dist: nearest.dist } : null,
      threatsCount,
    };

    // Track committed target for stickiness.
    if (decision.mode === 'asteroid') {
      const brainTarget = pickTarget({
        aiPos: ship.position, asteroids,
        powerupPos: args.powerupPos, powerupVel: args.powerupVel, powerupBiasU: opts.powerupBiasU,
        powerupMaxChaseDist: opts.powerupMaxChaseDist, committedPos, hysteresisU: opts.hysteresisU,
      });
      if (brainTarget) committedPos = { x: brainTarget.pos.x, z: brainTarget.pos.z };
    } else if (decision.mode !== 'powerup') {
      committedPos = null;
    }

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
    getLastDecision: () => Object.freeze({
      mode: lastDecision.mode,
      yaw: lastDecision.yaw,
      thrust: lastDecision.thrust,
      fire: lastDecision.fire,
      activeWeapon: lastDecision.activeWeapon,
      target: lastDecision.target
        ? Object.freeze({
            pos: Object.freeze({ ...lastDecision.target.pos }),
            mode: lastDecision.target.mode,
            dist: lastDecision.target.dist,
          })
        : null,
      nearest: lastDecision.nearest
        ? Object.freeze({
            pos: Object.freeze({ ...lastDecision.nearest.pos }),
            dist: lastDecision.nearest.dist,
          })
        : null,
      threatsCount: lastDecision.threatsCount,
      lookaheadThreats: 0,
      committedTargetSince: 0,
    }),
  };
}
