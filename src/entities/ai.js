/**
 * Demo AI — an NPC ship for the DEMO attract state.
 *
 * v0.47.0 — Modular AI foundation.
 *
 * Architecture (perception → behaviors → arbitration → actuation):
 *   1. PERCEPTION: `buildContext()` turns raw world state into a clean
 *      context object the behaviors can read.
 *   2. BEHAVIORS: small, testable units that decide IF they want to run
 *      and WHAT they want to do. Current behaviors: EVADE, ENGAGE,
 *      COLLECT (powerup), IDLE. Future stubs: FIGHT, LAND.
 *   3. ARBITRATION: `selectBehavior()` picks the highest-priority active
 *      behavior. Right now this is simple priority order; later it can
 *      become a goal-oriented planner without touching the behaviors.
 *   4. ACTUATION: the selected behavior returns `{ yaw, thrust, mode }`,
 *      and an independent fire loop decides whether to shoot.
 *
 * This keeps the classic Asteroids AI simple and fast, but gives a
 * clean seam for future behaviors (ship combat, station landing,
 * formation flying, etc.).
 *
 * Fire and flight target are decoupled: the ship can chase a powerup
 * while still shooting asteroids in its forward cone.
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU } from './ship-constants.js';
import { POWERUP_PUSH_DRAG } from './powerup.js';
import { AI_TUNABLES } from './ai-tunables.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  /** Reset the AI ship if it drifts beyond this radius from origin. */
  resetDist: 400,
  /** Spawn radius (XZ) for the initial position + on-reset placement. */
  spawnRadius: 30,
  /** Initial yaw (radians). */
  spawnYaw: 0,

  /**
   * Emergency evade distance (world units). When the nearest asteroid is
   * closer than this, the AI thrusts 90° perpendicular to escape.
   * Classic Asteroids: react late, then get out fast.
   */
  evadeDist: AI_TUNABLES.evadeDist,

  /**
   * Powerups are chased when they are within this range. The AI
   * prioritises powerups over asteroids while they are reachable.
   * Must be >= powerup-system SPAWN_MAX_DIST (200) so the AI can see
   * every powerup that spawns inside the streaming bubble.
   */
  powerupMaxChaseDist: AI_TUNABLES.powerupMaxChaseDist,

  /**
   * Heading gate for thrust (radians). The ship only thrusts when it is
   * roughly facing the target. Wide enough to feel responsive, tight
   * enough to avoid endless circling.
   */
  thrustHeadingGate: AI_TUNABLES.thrustHeadingGate,

  /**
   * Yaw deadband (radians). When the predicted heading error is within
   * this band, the AI commands no yaw. Must be larger than the angular
   * momentum overshoot caused by YAW_INERTIA_TAU to avoid left/right
   * wobble.
   */
  yawDeadband: 0.10,

  /**
   * Heading gate for firing (radians). Slightly wider than the thrust gate
   * so the ship can shoot while still turning onto the target.
   * v0.47.1: widened from 0.35 to 0.40 for a more generous fire cone.
   */
  fireHeadingGate: AI_TUNABLES.fireHeadingGate,

  /**
   * Fire distance range (world units).
   * v0.47.1: fireMaxDist raised from 120 to 150 for a wider engagement
   * envelope.
   */
  fireMinDist: AI_TUNABLES.fireMinDist,
  fireMaxDist: AI_TUNABLES.fireMaxDist,

  /** Laser fire heading gate (radians). */
  laserFireHeadingGate: 0.30,

  /**
   * Bullet speed (world units per second). Used for lead-fire prediction.
   * Must match the bullet pool's default speed.
   */
  bulletSpeed: 400,

  /**
   * Size bias for chase target selection (world units). Larger asteroids
   * are preferred: effective distance = dist - (2 - size) * sizeBias.
   * size 0 = large, size 1 = medium, size 2 = small.
   */
  asteroidSizeBias: AI_TUNABLES.asteroidSizeBias,

  /**
   * Half-angle of the forward cone used for target priority. Targets
   * inside this cone are preferred over targets behind the ship.
   */
  forwardConeHalfAngle: Math.PI / 2,

  /**
   * Powerups that are behind the ship but closer than this threshold
   * are still chased (the "near-behind" exception).
   */
  powerupNearBehindThreshold: 40,

  /**
   * Heading gate for powerup collection (radians). Tightened to
   * the yaw deadband so the ship turns onto the target BEFORE
   * thrusting. Thrusting while still turning causes the ship to
   * curve past the powerup and enter an orbit; this prevents it.
   */
  powerupThrustGate: AI_TUNABLES.powerupThrustGate,

  /**
   * Once a powerup has been selected as the chase target, it stays the
   * chase target for this many seconds, even if an asteroid briefly
   * looks more attractive. This eliminates the visible target-switching.
   */
  powerupStickyTime: 3.0,
});

// --------------------------------------------------------------------------
// Private helpers
// --------------------------------------------------------------------------

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
 */
export function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/**
 * Find the nearest asteroid to a point.
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
      best = { dx, dz, dist: d, asteroid: a, pos: p };
    }
  }
  return best;
}

/**
 * Find the best asteroid to chase, preferring larger asteroids.
 * Effective distance = dist - (2 - size) * sizeBias.
 * size 0 = large, size 1 = medium, size 2 = small.
 */
export function findBestAsteroidForChase(pos, asteroids, sizeBias = DEFAULTS.asteroidSizeBias) {
  let best = null;
  let bestScore = Infinity;
  for (const a of asteroids) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const p = a.getPosition();
    if (!p) continue;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const size = typeof a.getSize === 'function' ? a.getSize() : 2;
    const score = dist - (2 - size) * sizeBias;
    if (score < bestScore) {
      bestScore = score;
      best = { dx, dz, dist, asteroid: a, pos: p };
    }
  }
  return best;
}

/**
 * True if the target is in front of the ship within the given half-angle.
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
 * Predict where an asteroid will be when the bullet arrives.
 * Returns the predicted position. If the asteroid has no velocity,
 * returns its current position.
 */
export function predictAsteroidPosition(asteroid, aiPos, bulletSpeed = DEFAULTS.bulletSpeed) {
  if (!asteroid || typeof asteroid.getPosition !== 'function') return null;
  const pos = asteroid.getPosition();
  if (!pos) return null;
  const dx = pos.x - aiPos.x;
  const dz = pos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  const flightTime = dist / Math.max(bulletSpeed, 1);
  const vel = typeof asteroid.getVelocity === 'function' ? asteroid.getVelocity() : { x: 0, z: 0 };
  return {
    x: pos.x + (vel.x || 0) * flightTime,
    z: pos.z + (vel.z || 0) * flightTime,
  };
}

/**
 * Compute the signed angle from the ship's facing to a target position.
 * Returns a value in [-π, π].
 */
function headingDiffToTarget(aiPos, aiYaw, targetPos) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const targetAngle = Math.atan2(dz, dx);
  return wrapAngle(targetAngle - facingAngle(aiYaw));
}

/**
 * Pick the best target.
 *
 * Rules:
 *   - A reachable powerup is always preferred over asteroids.
 *     This keeps the AI from switching targets constantly.
 *   - If no powerup is reachable, chase the best asteroid.
 *
 * Back-compat: if `aiYaw` is omitted, falls back to the legacy distance-only
 * comparison so existing callers/tests keep working.
 */
export function pickTarget({
  aiPos,
  aiYaw,
  asteroids,
  powerupPos,
  stickyPowerupPos = null,
  powerupMaxChaseDist = DEFAULTS.powerupMaxChaseDist,
  asteroidSizeBias = DEFAULTS.asteroidSizeBias,
}) {
  const bestAsteroid = findBestAsteroidForChase(aiPos, asteroids, asteroidSizeBias);

  // Powerup evaluation.
  let powerupTarget = null;
  if (powerupPos && typeof powerupPos.x === 'number') {
    const pdx = powerupPos.x - aiPos.x;
    const pdz = powerupPos.z - aiPos.z;
    const pDist = Math.hypot(pdx, pdz);
    if (pDist <= powerupMaxChaseDist) {
      powerupTarget = { pos: powerupPos, mode: 'powerup', dist: pDist };
    }
  }

  // Reachable powerup always wins — this is the key to stopping the
  // visible target-switching between asteroids and powerups.
  // If we have a sticky powerup target, keep chasing it as long as
  // it is still reachable.
  if (stickyPowerupPos && powerupTarget && powerupTarget.pos === stickyPowerupPos) {
    return powerupTarget;
  }
  if (powerupTarget) {
    return powerupTarget;
  }

  // Legacy/back-compat path: no yaw supplied → pure distance comparison.
  // (Keep this after the powerup branch so reachable powerups still win.)
  if (typeof aiYaw !== 'number') {
    if (bestAsteroid) {
      return { pos: bestAsteroid.pos, mode: 'asteroid', dist: bestAsteroid.dist };
    }
    return null;
  }

  // No powerup; chase the best asteroid.
  if (bestAsteroid) {
    return { pos: bestAsteroid.pos, mode: 'asteroid', dist: bestAsteroid.dist };
  }

  return null;
}

// --------------------------------------------------------------------------
// Perception
// --------------------------------------------------------------------------

/**
 * Build a context object from raw brain inputs. This is the single place
 * where raw world state is normalized before behaviors see it.
 *
 * @param {object} args - the same args aiBrainTick receives
 * @returns {object} ctx
 */
function buildContext(args) {
  const {
    aiPos,
    aiYaw,
    asteroids,
    powerupPos = null,
    powerupVel = null,
    stickyPowerupPos = null,
    stickyPowerupTime = 0,
    aiVel = null,
    evadeDist = DEFAULTS.evadeDist,
    powerupMaxChaseDist = DEFAULTS.powerupMaxChaseDist,
    thrustHeadingGate = DEFAULTS.thrustHeadingGate,
    yawDeadband = DEFAULTS.yawDeadband,
    fireHeadingGate = DEFAULTS.fireHeadingGate,
    fireMinDist = DEFAULTS.fireMinDist,
    fireMaxDist = DEFAULTS.fireMaxDist,
    activeWeapon = 'bullet',
    laserFireHeadingGate = DEFAULTS.laserFireHeadingGate,
    bulletSpeed = DEFAULTS.bulletSpeed,
    asteroidSizeBias = DEFAULTS.asteroidSizeBias,
    forwardConeHalfAngle = DEFAULTS.forwardConeHalfAngle,
    powerupNearBehindThreshold = DEFAULTS.powerupNearBehindThreshold,
    powerupThrustGate = DEFAULTS.powerupThrustGate,
    powerupStickyTime = DEFAULTS.powerupStickyTime,
    aiAngularVel = 0,
  } = args;

  const nearest = findNearestAsteroid(aiPos, asteroids);
  const target = pickTarget({
    aiPos,
    aiYaw,
    asteroids,
    powerupPos,
    powerupMaxChaseDist,
    asteroidSizeBias,
    forwardConeHalfAngle,
    powerupNearBehindThreshold,
  });

  return {
    aiPos,
    aiYaw,
    asteroids,
    powerupPos,
    powerupVel,
    stickyPowerupPos,
    stickyPowerupTime,
    aiVel,
    nearest,
    target,
    evadeDist,
    powerupMaxChaseDist,
    thrustHeadingGate,
    yawDeadband,
    fireHeadingGate,
    fireMinDist,
    fireMaxDist,
    activeWeapon,
    laserFireHeadingGate,
    bulletSpeed,
    asteroidSizeBias,
    powerupThrustGate,
    powerupStickyTime,
    aiAngularVel,
  };
}

// --------------------------------------------------------------------------
// Behaviors
// --------------------------------------------------------------------------

/**
 * Compute the signed heading error from the ship's facing to a target.
 * Positive means the target is to the left of the facing vector.
 */
function headingErrorToTarget(ctx, targetPos) {
  const dx = targetPos.x - ctx.aiPos.x;
  const dz = targetPos.z - ctx.aiPos.z;
  const faceAngle = Math.atan2(dz, dx);
  return wrapAngle(faceAngle - facingAngle(ctx.aiYaw));
}

/**
 * Compute the projection of the ship's velocity onto the line to the
 * target. Positive = moving toward the target, negative = moving away.
 */
function closingSpeedToTarget(ctx, targetPos) {
  const aiVel = ctx.aiVel || { x: 0, z: 0 };
  const dx = targetPos.x - ctx.aiPos.x;
  const dz = targetPos.z - ctx.aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return 0;
  return (aiVel.x * dx + aiVel.z * dz) / dist;
}

/**
 * Turn toward a target position and thrust when aligned.
 * Shared by ENGAGE and COLLECT.
 *
 * Uses angular-velocity prediction to counter-steer before the ship's
 * angular momentum can overshoot the target. This removes the visible
 * left/right wobble caused by YAW_INERTIA_TAU.
 *
 * If `opts.desiredClosingSpeed` is provided, thrust is gated on the
 * current closing speed too: the ship coasts when it is already
 * closing faster than desired, and thrusts when it is slower. This
 * prevents overshoot and gives the AI real speed management.
 */
export function steerToward(ctx, targetPos, mode, opts = {}) {
  const {
    desiredClosingSpeed = null,
    thrustGate = ctx.thrustHeadingGate,
  } = opts;

  const targetDiff = headingErrorToTarget(ctx, targetPos);

  // Predict where the heading will be one yaw time-constant from now,
  // so the AI starts counter-steering before the ship overshoots.
  const angularVel = ctx.aiAngularVel || 0;
  const predictedDiff = wrapAngle(targetDiff + angularVel * YAW_INERTIA_TAU);
  const yawDeadband = ctx.yawDeadband ?? 0.10;

  const yaw = predictedDiff > yawDeadband ? -1 : predictedDiff < -yawDeadband ? 1 : 0;
  // Use the predicted heading for thrust too: if the ship is about to
  // overshoot the target, don't accelerate into the overshoot.
  let thrust = Math.abs(predictedDiff) < thrustGate;

  // Speed management: if a desired closing speed was requested, only
  // thrust when we are closing slower than desired. Linear drag will
  // naturally slow us down when thrust is off.
  if (thrust && desiredClosingSpeed !== null) {
    const closing = closingSpeedToTarget(ctx, targetPos);
    thrust = closing < desiredClosingSpeed;
  }

  return { yaw, thrust, mode, fire: false, braking: false, predictedDiff };
}

/**
 * EVADE behavior: something is very close — get away safely.
 *
 * If the ship is drifting toward the threat, turn retrograde (away
 * from the threat) and thrust to cancel the closing velocity. If the
 * ship is already drifting away, thrust perpendicular to widen the
 * gap. This is much safer than always thrusting 90° perpendicular,
 * which can carry the ship straight into the threat if it was
 * already moving toward it.
 */
export function evadeBehavior(ctx) {
  const nearest = ctx.nearest;
  if (!nearest || nearest.dist >= ctx.evadeDist) return null;

  const aiVel = ctx.aiVel || { x: 0, z: 0 };
  const closing = (aiVel.x * nearest.dx + aiVel.z * nearest.dz) / Math.max(nearest.dist, 0.001);

  let targetDiff;
  if (closing > -5) {
  // Moving toward the threat (or only slowly away): turn directly
  // away from it and thrust hard.
  const escapeAngle = Math.atan2(-nearest.dz, -nearest.dx);
  targetDiff = wrapAngle(escapeAngle - facingAngle(ctx.aiYaw));
} else {
  // Already moving away: thrust perpendicular to widen the gap
  // while preserving escape velocity.
  const threatAngle = Math.atan2(nearest.dz, nearest.dx);
  const escapeAngle = threatAngle + Math.PI / 2;
  targetDiff = wrapAngle(escapeAngle - facingAngle(ctx.aiYaw));
}

// Same angular-velocity prediction as steerToward to avoid overshoot.
const angularVel = ctx.aiAngularVel || 0;
const predictedDiff = wrapAngle(targetDiff + angularVel * YAW_INERTIA_TAU);
const yawDeadband = ctx.yawDeadband ?? 0.10;

// Thrust if roughly aligned, OR if the threat is very close and
// we need to get away now regardless of facing.
const veryClose = nearest.dist < ctx.evadeDist * 0.5;
const thrust = Math.abs(predictedDiff) < 0.6 || veryClose;

return {
  yaw: predictedDiff > yawDeadband ? -1 : predictedDiff < -yawDeadband ? 1 : 0,
  thrust,
  mode: 'evade',
  fire: false,
  braking: false,
};
}  /**
   * COLLECT behavior: chase and collect a powerup.
   *
   * Turn toward the powerup and thrust with a distance-adaptive
   * approach speed. Far away the ship is allowed to cruise faster;
   * close to the pickup it slows down so it doesn't overshoot the
   * generous collection radius. This prevents the "thrust while
   * turning → curve past → loop" failure mode while still reaching
   * distant powerups before they expire.
   */
  export function collectBehavior(ctx) {
    if (!ctx.target || ctx.target.mode !== 'powerup') return null;

    const targetPos = ctx.target.pos;
    const aiPos = ctx.aiPos;
    const aiYaw = ctx.aiYaw;
    const powerupVel = ctx.powerupVel || { x: 0, z: 0 };
    const aiVel = ctx.aiVel || { x: 0, z: 0 };

    // Short prediction: powerups are kicked by asteroid collisions but
    // decay their push velocity exponentially (drag = POWERUP_PUSH_DRAG),
    // so the maximum distance they can travel from a push is |v0|/drag.
    // Use that bound instead of a naive linear extrapolation.
    const PREDICTION_TIME = 1.0 / POWERUP_PUSH_DRAG;
    const predictedPos = {
      x: targetPos.x + powerupVel.x * PREDICTION_TIME,
      z: targetPos.z + powerupVel.z * PREDICTION_TIME,
    };

    // Reuse the shared steering helper for yaw. Keep the heading
    // error so we can gate thrust independently.
    const steeringCtx = {
      ...ctx,
      aiPos,
      aiYaw,
      thrustHeadingGate: ctx.powerupThrustGate ?? DEFAULTS.powerupThrustGate,
    };
    const steer = steerToward(steeringCtx, predictedPos, 'powerup');

    // Distance-adaptive approach speed. We want to arrive at the
    // pickup with a controlled speed so the ship doesn't fly
    // straight through the collection radius.
    //   - far away: up to maxApproachSpeed
    //   - close: down to minApproachSpeed
    const dx = predictedPos.x - aiPos.x;
    const dz = predictedPos.z - aiPos.z;
    const dist = Math.hypot(dx, dz);
    const closingSpeed = dist > 0.001 ? (aiVel.x * dx + aiVel.z * dz) / dist : 0;

    const minApproachSpeed = 5;
    const maxApproachSpeed = 30;
    const desiredClosing = Math.max(
      minApproachSpeed,
      Math.min(maxApproachSpeed, dist * 0.3),
    );

    // Only thrust if we are facing the target (|predictedDiff| within
    // the powerup gate) AND we are not already closing faster than
    // desired. If we are closing too fast, drag will slow us; if we
    // are too slow or stationary, thrust catches us up.
    const aligned = Math.abs(steer.predictedDiff) < (ctx.powerupThrustGate ?? DEFAULTS.powerupThrustGate);
    const needMoreClosing = closingSpeed < desiredClosing;
    const thrust = aligned && needMoreClosing;

    return { yaw: steer.yaw, thrust, mode: 'powerup', fire: false, braking: false };
  }

/**
 * ENGAGE behavior: chase the best asteroid with velocity-aware
 * approach control.
 *
 * Far away the ship sprints toward the target; close to the target
 * it coasts in so it doesn't fly past. The desired closing speed is
 * a function of distance: arrive fast, then brake with drag.
 */
export function engageBehavior(ctx) {
  if (!ctx.target || ctx.target.mode !== 'asteroid') return null;
  const targetPos = ctx.target.pos;

  const dx = targetPos.x - ctx.aiPos.x;
  const dz = targetPos.z - ctx.aiPos.z;
  const dist = Math.hypot(dx, dz);

  // Desired closing speed ramps with distance:
  //   - at 0u:  5 u/s (minimum, keeps the ship responsive)
  //   - at 50u: 20 u/s
  //   - at 150u+: 60 u/s cap
  // This is intentionally conservative relative to MAX_SPEED so the
  // ship can still turn and fire accurately.
  const minApproach = 5;
  const maxApproach = 60;
  const desiredClosing = Math.max(
    minApproach,
    Math.min(maxApproach, dist * 0.4),
  );

  // Widen the thrust gate for asteroids so the ship can turn AND
  // thrust at the same time (classic Asteroids feel). The old 0.2
  // rad gate forced the ship to stop turning before thrusting,
  // making it sluggish.
  const thrustGate = Math.min(0.5, (ctx.thrustHeadingGate ?? 0.2) * 2.5);

  return steerToward(ctx, targetPos, 'asteroid', {
    desiredClosingSpeed: desiredClosing,
    thrustGate,
  });
}

/**
 * IDLE behavior: nothing to do.
 */
export function idleBehavior(ctx) {
  return { yaw: 0, thrust: false, mode: 'idle', fire: false, braking: false };
}

// --------------------------------------------------------------------------
// Arbitration
// --------------------------------------------------------------------------

/**
 * Ordered list of behaviors. Already sorted by priority descending.
 * The first behavior that returns a non-null decision wins.
 */
export const BEHAVIORS = [
  { name: 'idle', run: idleBehavior, priority: 0 },
  { name: 'engage', run: engageBehavior, priority: 10 },
  // COLLECT outranks EVADE so the AI actually reaches powerups
  // instead of forever dodging nearby asteroids. In DEMO the AI
  // has no lives, so flying through a cluster to grab a pickup is
  // the desired spectacle.
  { name: 'collect', run: collectBehavior, priority: 110 },
  { name: 'evade', run: evadeBehavior, priority: 100 },
].sort((a, b) => b.priority - a.priority);

/**
 * Select the active behavior for this tick.
 * Returns `{ behavior, decision }`.
 */
export function selectBehavior(ctx) {
  for (const behavior of BEHAVIORS) {
    const decision = behavior.run(ctx);
    if (decision) {
      return { behavior: behavior.name, decision };
    }
  }
  // Should never happen because idleBehavior always returns a decision.
  return { behavior: 'idle', decision: idleBehavior(ctx) };
}

// --------------------------------------------------------------------------
// Fire loop
// --------------------------------------------------------------------------

/**
 * Decide whether the AI should fire this tick. Fire is independent of
 * the selected behavior so the ship can shoot asteroids while chasing
 * powerups.
 */
export function evaluateFire(ctx) {
  const { aiPos, aiYaw, asteroids, activeWeapon, laserFireHeadingGate } = ctx;

  if (activeWeapon === 'laser') {
    const nearest = ctx.nearest;
    return nearest ? isTargetInFront(aiPos, aiYaw, nearest.pos, laserFireHeadingGate) : false;
  }

  for (const a of asteroids) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const predicted = predictAsteroidPosition(a, aiPos, ctx.bulletSpeed);
    if (!predicted) continue;
    const d = Math.hypot(predicted.x - aiPos.x, predicted.z - aiPos.z);
    if (d < ctx.fireMinDist || d > ctx.fireMaxDist) continue;
    if (isTargetInFront(aiPos, aiYaw, predicted, ctx.fireHeadingGate)) {
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Public brain API
// --------------------------------------------------------------------------

/**
 * Decide what the AI should do this tick.
 *
 * Returns `{ yaw, thrust, mode, fire, braking }`.
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  asteroids,
  powerupPos = null,
  powerupVel = null,
  stickyPowerupPos = null,
  stickyPowerupTime = 0,
  aiVel = null,
  evadeDist = DEFAULTS.evadeDist,
  powerupMaxChaseDist = DEFAULTS.powerupMaxChaseDist,
  thrustHeadingGate = DEFAULTS.thrustHeadingGate,
  yawDeadband = DEFAULTS.yawDeadband,
  fireHeadingGate = DEFAULTS.fireHeadingGate,
  fireMinDist = DEFAULTS.fireMinDist,
  fireMaxDist = DEFAULTS.fireMaxDist,
  activeWeapon = 'bullet',
  laserFireHeadingGate = DEFAULTS.laserFireHeadingGate,
  bulletSpeed = DEFAULTS.bulletSpeed,
  asteroidSizeBias = DEFAULTS.asteroidSizeBias,
  powerupThrustGate = DEFAULTS.powerupThrustGate,
  powerupStickyTime = DEFAULTS.powerupStickyTime,
  aiAngularVel = 0,
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const ctx = buildContext({
    aiPos,
    aiYaw,
    asteroids,
    powerupPos,
    powerupVel,
    stickyPowerupPos,
    stickyPowerupTime,
    aiVel,
    evadeDist,
    powerupMaxChaseDist,
    thrustHeadingGate,
    yawDeadband,
    fireHeadingGate,
    fireMinDist,
    fireMaxDist,
    activeWeapon,
    laserFireHeadingGate,
    bulletSpeed,
    asteroidSizeBias,
    forwardConeHalfAngle: DEFAULTS.forwardConeHalfAngle,
    powerupNearBehindThreshold: DEFAULTS.powerupNearBehindThreshold,
    powerupThrustGate,
    powerupStickyTime,
    aiAngularVel,
  });

  const { decision } = selectBehavior(ctx);
  decision.fire = evaluateFire(ctx);
  return decision;
}

// --------------------------------------------------------------------------
// Factory helpers
// --------------------------------------------------------------------------

/**
 * Decide whether the AI has drifted too far from origin.
 */
export function shouldResetAi(pos, resetDist = DEFAULTS.resetDist) {
  if (!pos) return false;
  return Math.hypot(pos.x, pos.z) > resetDist;
}

/**
 * Build a random spawn position within `radius` of the origin.
 */
export function pickAiSpawn(radius = DEFAULTS.spawnRadius, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const r = radius * (0.4 + rng() * 0.6);
  return {
    position: { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
    yaw: rng() * Math.PI * 2,
  };
}

// --------------------------------------------------------------------------
// Demo AI factory
// --------------------------------------------------------------------------

/**
 * Create a demo AI ship. Wires the brain to a live ship.
 */
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, getPowerupVel = null, getActiveWeapon = null, options = {} } = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;
  const brain = opts.brain || null;

  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = initial.yaw;

  let time = 0;
  let enabled = true;
  let lastMode = 'idle';
  // Sticky powerup target: once the AI commits to a powerup, it keeps
  // chasing it for a short time to eliminate visible target-switching.
  let stickyPowerupPos = null;
  let stickyPowerupSince = 0;
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

  function spawn() {
    const sp = pickAiSpawn(opts.spawnRadius, rng);
    ship.reset(sp.position);
    ship.rotation.yaw = sp.yaw;
  }

  function brainArgsFromShip() {
    return {
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      asteroids,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      powerupVel: getPowerupVel ? getPowerupVel() : { x: 0, z: 0 },
      stickyPowerupPos,
      stickyPowerupTime: time - stickyPowerupSince,
      aiVel: ship.velocity,
      evadeDist: opts.evadeDist,
      powerupMaxChaseDist: opts.powerupMaxChaseDist,
      thrustHeadingGate: opts.thrustHeadingGate,
      yawDeadband: opts.yawDeadband,
      fireHeadingGate: opts.fireHeadingGate,
      fireMinDist: opts.fireMinDist,
      fireMaxDist: opts.fireMaxDist,
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
      laserFireHeadingGate: opts.laserFireHeadingGate,
      bulletSpeed: opts.bulletSpeed,
      asteroidSizeBias: opts.asteroidSizeBias,
      forwardConeHalfAngle: opts.forwardConeHalfAngle,
      powerupNearBehindThreshold: opts.powerupNearBehindThreshold,
      powerupThrustGate: opts.powerupThrustGate,

      aiAngularVel: ship.angularVelocity,
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

    // Update sticky powerup target state. If the brain is chasing a
    // powerup, commit to it. If not, keep the commitment alive for
    // powerupStickyTime seconds so a brief asteroid priority doesn't
    // make the ship zigzag.
    if (decision.mode === 'powerup' && args.powerupPos) {
      stickyPowerupPos = args.powerupPos;
      stickyPowerupSince = time;
    } else if (stickyPowerupPos) {
      const stickyAge = time - stickyPowerupSince;
      if (stickyAge > opts.powerupStickyTime) {
        stickyPowerupPos = null;
      }
    }

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
      aiYaw: ship.rotation.yaw,
      asteroids,
      powerupPos: args.powerupPos,
      stickyPowerupPos,
      powerupMaxChaseDist: opts.powerupMaxChaseDist,
      asteroidSizeBias: opts.asteroidSizeBias,
      forwardConeHalfAngle: opts.forwardConeHalfAngle,
      powerupNearBehindThreshold: opts.powerupNearBehindThreshold,
    });

    // Compute the lead-fire predicted intercept point for the chase
    // target (asteroids only — powerups are static and don't need lead).
    let predictedPos = null;
    if (target && target.mode === 'asteroid') {
      const targetAsteroid = asteroids.find((a) => {
        if (!a || typeof a.getPosition !== 'function') return false;
        const p = a.getPosition();
        if (!p) return false;
        return Math.hypot(p.x - target.pos.x, p.z - target.pos.z) < 0.001;
      });
      if (targetAsteroid) {
        predictedPos = predictAsteroidPosition(targetAsteroid, ship.position, opts.bulletSpeed);
      }
    }

    lastDecision = {
      mode: decision.mode,
      yaw: decision.yaw,
      thrust: decision.thrust,
      fire: decision.fire,
      braking: !!decision.braking,
      activeWeapon: args.activeWeapon,
      target: target ? { pos: { ...target.pos }, mode: target.mode, dist: target.dist } : null,
      predictedPos: predictedPos ? { ...predictedPos } : null,
      nearest: nearest ? { pos: { x: nearest.dx + ship.position.x, z: nearest.dz + ship.position.z }, dist: nearest.dist } : null,
      threatsCount,
    };

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
