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
 * Mode priority: EVADE (<8u) → PREDICTIVE EVADE (3s lookahead) →
 *                ENGAGE (asteroid/powerup) → IDLE
 *
 * See LOG.md for the full performance protocol.
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU } from './ship-constants.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Ship collision radius (matches SHIP_RADIUS in src/systems/collision.js).
 * Used for radius-aware evade and collision threat detection.
 */
const SHIP_RADIUS = 1.4;

/**
 * Predictive evade buffer (world units). Added to ship + asteroid radius
 * to compute the collision margin. Replaces the old fixed margin.
 * v0.37.1: 3.0u buffer beyond ship+asteroid combined radius.
 */
const PREDICTIVE_EVADE_BUFFER = 3.0;

/**
 * Emergency evade buffer (world units). Added to ship + asteroid radius
 * for the emergency EVADE threshold. v0.37.1: 2.0u → 1.0u nach Browser-Test
 * (264/s vs 536/s peak — 2.0u war zu konservativ). 1.0u gibt minimal clearance
 * ohne den Score zu drücken.
 */
const EVADE_BUFFER = 1.0;

const DEFAULTS = Object.freeze({  /** Reset the AI ship if it drifts beyond this radius from origin. */
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
   * v0.37.0: 3.0s — early enough to avoid clusters, short enough to
   * not over-dodge on curved approaches.
   */
  predictiveEvadeLookahead: 3.0,

  /**
   * Predictive evade margin is now computed per-asteroid as:
   *   SHIP_RADIUS (1.4) + asteroid.getRadius() + PREDICTIVE_EVADE_BUFFER (3.0)
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
   * Powerup detour bias (world units). Powerups only win over an
   * asteroid when they are genuinely nearby or the asteroid is not
   * already in an attackable range. This keeps the demo AI focused
   * on actual combat instead of constantly detouring for pickups.
   */
  powerupBiasU: 25,

  /**
   * Thrust heading gate (radians). Ship thrusts when |heading diff|
   * is within this angle AND the target is beyond coastDist.
   * v0.36.0: 0.10 rad ≈ 5.7° — tight stop-turn-thrust.
   */
  thrustHeadingGate: 0.10,

  /** Fire heading gate (radians). v0.35.0: 0.30 rad ≈ 17.2°. */
  fireHeadingGate: 0.30,

  /** Fire distance range (world units). v0.35.0: reduced to 60u. */
  fireMinDist: 0,
  fireMaxDist: 60,

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
  if (speed < 1 || dist < 1) {
    return { point: { x: targetPos.x, z: targetPos.z }, time: 0 };
  }

  // Iterative intercept: start with time = dist / speed, refine twice.
  let t = Math.min(dist / speed, maxLookaheadS);
  for (let i = 0; i < 2; i++) {
    const px = targetPos.x + targetVel.x * t;
    const pz = targetPos.z + targetVel.z * t;
    const newDist = Math.hypot(px - aiPos.x, pz - aiPos.z);
    t = Math.min(newDist / speed, maxLookaheadS);
  }
  return {
    point: { x: targetPos.x + targetVel.x * t, z: targetPos.z + targetVel.z * t },
    time: t,
  };
}

/**
 * Find the nearest collision threat along the ship's current flight path
 * within a look-ahead horizon. Uses closest-approach kinematics.
 *
 * Returns the asteroid with the smallest projected miss distance, or
 * null if no asteroid is on a collision course within the horizon.
 *
 * v0.37.1: Uses asteroid radius + SHIP_RADIUS + buffer instead of fixed
 * margin. Small asteroids (r=1) get smaller margin (5.4u), large ones
 * (r=6) get larger margin (10.4u).
 *
 * @param {{x:number,z:number}} aiPos
 * @param {{x:number,z:number}} aiVel
 * @param {Array<{getPosition: () => any, getVelocity?: () => any, getRadius?: () => number}>} asteroids
 * @param {number} [lookaheadS=3.0]
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
 *   Powerups have velocity (0,0) and radius 0.
 *
 * @param {{
 *   aiPos: {x:number,z:number},
 *   asteroids: Array<{getPosition: () => any, getVelocity?: () => any, getRadius?: () => number}>,
 *   powerupPos: {x:number,z:number} | null,
 *   powerupBiasU: number,
 *   committedPos?: {x:number,z:number} | null,
 *   hysteresisU?: number,
 * }} args
 * @returns {{ pos: {x:number,z:number}, vel: {x:number,z:number}, mode: 'asteroid'|'powerup', dist: number, radius?: number } | null}
 */
export function pickTarget({ aiPos, asteroids, powerupPos, powerupBiasU, committedPos = null, hysteresisU = 8 }) {
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

  // Target stickiness: if the committed target is still in the asteroid
  // list and the nearest alternative is only slightly closer, keep the
  // committed target. Reduces zigzag in dense fields — the AI finishes
  // what it started instead of constantly switching.
  if (committedPos && typeof committedPos.x === 'number' && best) {
    const cDist = Math.hypot(committedPos.x - aiPos.x, committedPos.z - aiPos.z);
    if (cDist < best.dist + hysteresisU) {
      // Committed target is close enough — prefer it.
      // Preserve radius for surface-distance brake/coast (v0.37.1).
      best = { pos: committedPos, vel: { x: 0, z: 0 }, mode: 'asteroid', dist: cDist, radius: best.radius };
    }
  }

  if (powerupPos && typeof powerupPos.x === 'number') {
    const pDist = Math.hypot(powerupPos.x - aiPos.x, powerupPos.z - aiPos.z);
    const asteroidIsUrgent = best && best.mode === 'asteroid' && best.dist < 35;
    // Collect powerups that are very close (<25u) regardless of asteroid urgency.
    // v0.37.2: increased from 18 to 25 for more reliable nearby pickup.
    const powerupIsClose = pDist < 25;
    if (best === null) {
      return { pos: powerupPos, vel: { x: 0, z: 0 }, mode: 'powerup', dist: pDist, radius: 0 };
    }
    if (powerupIsClose) {
      return { pos: powerupPos, vel: { x: 0, z: 0 }, mode: 'powerup', dist: pDist, radius: 0 };
    }
    // v0.37.2: powerup wins over an urgent asteroid if it's CLOSER than the asteroid.
    // Previously asteroidIsUrgent blocked ALL powerup collection below 35u, even
    // when the powerup was right next to the ship (e.g. powerup at 20u, asteroid at 30u).
    if ((!asteroidIsUrgent || pDist < best.dist) && pDist < best.dist + powerupBiasU) {
      return { pos: powerupPos, vel: { x: 0, z: 0 }, mode: 'powerup', dist: pDist, radius: 0 };
    }
  }

  return best;
}

/**
 * Engagement controller: turn toward target (with intercept prediction),
 * thrust when aligned AND beyond coast-in distance. Within coastDist,
 * engines cut and LINEAR_DRAG decelerates the ship naturally.
 *
 * v0.37.0: intercept prediction — the `targetVel` parameter enables
 * aiming at the predicted future position of moving targets.
 * v0.37.1: `targetRadius` parameter for surface-distance brake/coast.
 *   Brake and coast decisions use SURFACE distance (center distance minus
 *   target radius) instead of center-to-center distance. This ensures
 *   consistent braking behavior regardless of target size: the ship
 *   starts braking at the same surface distance for large and small
 *   asteroids.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} aiVel
 * @param {{x:number,z:number}} targetPos
 * @param {{x:number,z:number}} [targetVel] for intercept prediction
 * @param {number} [aiAngularVel=0]  for spin-brake prediction
 * @param {number} [thrustGate=0.10] heading gate for thrust
 * @param {number} [coastDist=40]    coast-in distance (center-to-center)
 * @param {boolean} [wasBraking=false] hysteresis: already braking
 * @param {boolean} [allowBrake=true] allow brake logic (flip 180° and thrust backward)
 * @param {number} [interceptLookaheadS=2.0] intercept horizon
 * @param {boolean} [allowCoast] allow coast-in (cut thrust when close + closing fast).
 *   Defaults to `allowBrake` for backward compat. Separated so powerups can
 *   coast without braking.
 * @returns {{ yaw: number, thrust: boolean, diff: number, dist: number, braking: boolean }}
 */
export function engageTarget(aiPos, aiYaw, aiVel, targetPos, aiAngularVel = 0, thrustGate = DEFAULTS.thrustHeadingGate, coastDist = DEFAULTS.coastDist, wasBraking = false, allowBrake = true, targetVel = null, interceptLookaheadS = DEFAULTS.interceptLookaheadS, allowCoast) {
  // Default allowCoast to allowBrake for backward compat.
  if (typeof allowCoast !== 'boolean') allowCoast = allowBrake;

  // v0.37.0: Intercept prediction — aim at where the target WILL BE.
  // For stationary targets (powerups, or no vel data) this is a no-op.
  let aimPos = targetPos;
  if (targetVel && aiVel) {
    const intercept = predictInterceptPoint(aiPos, aiVel, targetPos, targetVel, interceptLookaheadS);
    aimPos = intercept.point;
  }

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
  const BRAKE_DIST = 40;
  const BRAKE_ENTER_SPEED = 20;
  const BRAKE_EXIT_SPEED = 10;
  const shouldStartBrake = allowBrake && dist < BRAKE_DIST && closingSpeed > BRAKE_ENTER_SPEED;
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
  evadeDist = DEFAULTS.evadeDist,
  powerupBiasU = DEFAULTS.powerupBiasU,
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
  const target = pickTarget({ aiPos, asteroids, powerupPos, powerupBiasU, committedPos, hysteresisU });
  if (target) {
    const ec = engageTarget(aiPos, aiYaw, aiVel, target.pos, aiAngularVel, thrustHeadingGate, coastDist, wasBraking, target.mode !== 'powerup', target.vel, interceptLookaheadS, true);

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
      evadeDist: opts.evadeDist,
      powerupBiasU: opts.powerupBiasU,
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
      powerupBiasU: opts.powerupBiasU,
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
        powerupPos: args.powerupPos, powerupBiasU: opts.powerupBiasU,
        committedPos, hysteresisU: opts.hysteresisU,
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
