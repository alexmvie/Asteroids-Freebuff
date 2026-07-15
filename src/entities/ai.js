/**
 * Demo AI — an NPC ship for the DEMO attract state.
 *
 * v0.46.x — Live-tunable architecture.
 *
 * Architecture (perception → behaviors → arbitration → actuation):
 *   1. PERCEPTION: `buildContext()` turns raw world state into a clean
 *      context object the behaviors can read.
 *   2. BEHAVIORS: small, testable units that decide IF they want to run
 *      and WHAT they want to do. Every behavior returns a `reason`
 *      string so the debug overlay can explain WHY the AI did what it
 *      did ("EVADE: nearest 5.2u < evadeDist 10.0u"). Current
 *      behaviors: IDLE, ENGAGE, COLLECT (powerup), EVADE. Future
 *      stubs: FIGHT, LAND.
 *   3. ARBITRATION: `selectBehavior()` picks the highest-priority
 *      active behavior. Right now this is simple priority order;
 *      later it can become a goal-oriented planner without touching
 *      the behaviors.
 *   4. ACTUATION: the selected behavior returns `{ yaw, thrust,
 *      mode, reason }`, and an independent fire loop decides whether
 *      to shoot.
 *
 * Live tunables
 * -------------
 * Every tunable used by the brain is read per tick from
 * `AI_TUNABLES` (mutable bag in src/entities/ai-tunables.js).
 * Factory-time overrides win over the live values via
 * `opts.X ?? AI_TUNABLES.X`, so existing tests that inject factory
 * overrides keep working without re-wiring. The tuner panel
 * (src/ui/ai-tuners-panel.js) writes directly to AI_TUNABLES; a
 * slider drag is visible on the very next frame.
 *
 * This keeps the classic Asteroids AI simple and fast, but gives a
 * clean seam for future behaviors (ship combat, station landing,
 * formation flying, etc.) and a clean seam for runtime tuning
 * without app reloads.
 *
 * Fire and flight target are decoupled: the ship can chase a powerup
 * while still shooting asteroids in its forward cone.
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU, LINEAR_DRAG } from './ship-constants.js';
import { POWERUP_PUSH_DRAG } from './powerup.js';
import { AI_TUNABLES } from './ai-tunables.js';

// --------------------------------------------------------------------------
// Factory-only constants
// --------------------------------------------------------------------------
// Brain-level tunables live in AI_TUNABLES (live, mutable). These
// factory-only knobs are NOT part of the runtime tunable surface —
// they affect spawn logic at factory time only. Resetting the live
// tunables does NOT touch these.

const FACTORY_DEFAULTS = Object.freeze({
  /** Reset the AI ship if it drifts beyond this radius from origin. */
  resetDist: 400,
  /** Spawn radius (XZ) for the initial position + on-reset placement. */
  spawnRadius: 30,
  /** Initial yaw (radians). */
  spawnYaw: 0,
});

// --------------------------------------------------------------------------
// Per-tick defaults for values that are NOT in AI_TUNABLES
// --------------------------------------------------------------------------
// `activeWeapon` is flux (bullet/laser) decided by the powerup
// system; it isn't a tunable. `aiAngularVel` is a per-tick sensor
// read. These have static fallbacks used only by the pure function
// `aiBrainTick` when callers omit them.

const API_DEFAULTS = Object.freeze({
  activeWeapon: 'bullet',
  aiAngularVel: 0,
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
export function findBestAsteroidForChase(pos, asteroids, sizeBias = AI_TUNABLES.asteroidSizeBias) {
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
export function predictAsteroidPosition(asteroid, aiPos, bulletSpeed = AI_TUNABLES.bulletSpeed) {
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
  powerupMaxChaseDist = AI_TUNABLES.powerupMaxChaseDist,
  asteroidSizeBias = AI_TUNABLES.asteroidSizeBias,
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
  if (stickyPowerupPos && powerupTarget && powerupTarget.pos === stickyPowerupPos) {
    return powerupTarget;
  }
  if (powerupTarget) {
    return powerupTarget;
  }

  // Legacy/back-compat path: no yaw supplied → pure distance comparison.
  if (typeof aiYaw !== 'number') {
    if (bestAsteroid) {
      return { pos: bestAsteroid.pos, mode: 'asteroid', dist: bestAsteroid.dist };
    }
    return null;
  }

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
 * where raw world state is normalized before behaviors see it. The ctx
 * also carries EVERY AI_TUNABLES value read by the behaviors, so a
 * live tuner-panel drag is visible on the very next buildContext call.
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
  } = args;

  const nearest = findNearestAsteroid(aiPos, asteroids);
  const target = pickTarget({
    aiPos,
    aiYaw,
    asteroids,
    powerupPos,
    powerupMaxChaseDist: args.powerupMaxChaseDist,
    asteroidSizeBias: args.asteroidSizeBias,
    forwardConeHalfAngle: args.forwardConeHalfAngle,
    powerupNearBehindThreshold: args.powerupNearBehindThreshold,
  });

  return {
    // ---- pass-through state -------------------------------------
    aiPos,
    aiYaw,
    asteroids,
    powerupPos,
    powerupVel,
    stickyPowerupPos,
    stickyPowerupTime,
    aiVel,
    // ---- per-tick artifacts used by behaviors + debug overlay ---
    nearest,
    target,
    // ---- all live tunables, snapshotted from args for behavior
    //      consumption (so a slider drag is visible next tick) ---
    evadeDist: args.evadeDist,
    powerupMaxChaseDist: args.powerupMaxChaseDist,
    thrustHeadingGate: args.thrustHeadingGate,
    yawDeadband: args.yawDeadband,
    fireHeadingGate: args.fireHeadingGate,
    fireMinDist: args.fireMinDist,
    fireMaxDist: args.fireMaxDist,
    activeWeapon: args.activeWeapon,
    laserFireHeadingGate: args.laserFireHeadingGate,
    bulletSpeed: args.bulletSpeed,
    asteroidSizeBias: args.asteroidSizeBias,
    forwardConeHalfAngle: args.forwardConeHalfAngle,
    powerupNearBehindThreshold: args.powerupNearBehindThreshold,
    powerupThrustGate: args.powerupThrustGate,
    powerupStickyTime: args.powerupStickyTime,
    powerupCruiseSpeed: args.powerupCruiseSpeed,
    powerupMinApproachSpeed: args.powerupMinApproachSpeed,
    powerupApproachGain: args.powerupApproachGain,
    powerupBrakeSafetyFactor: args.powerupBrakeSafetyFactor,
    powerupVelocityErrorThreshold: args.powerupVelocityErrorThreshold,
    powerupFinalApproachDist: args.powerupFinalApproachDist,
    powerupFinalApproachSpeed: args.powerupFinalApproachSpeed,
    aiAngularVel: args.aiAngularVel,
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
 * Returns `{ yaw, thrust, mode: 'evade', reason }`. The reason
 * explains what threshold fired so the debug overlay can show
 * "EVADE: nearest 5.2u < evadeDist 10.0u" without recomputing
 * anything.
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

  const reason = `nearest ${nearest.dist.toFixed(1)}u < evadeDist ${ctx.evadeDist.toFixed(1)}u`;

  return {
    yaw: predictedDiff > yawDeadband ? -1 : predictedDiff < -yawDeadband ? 1 : 0,
    thrust,
    mode: 'evade',
    fire: false,
    braking: false,
    reason,
  };
}

/**
 * COLLECT behavior: chase and intercept a powerup.
 *
 * Uses a physics-based velocity-error controller:
 * 1. Predicts the powerup's position at an adaptive horizon using its
 *    current velocity and exponential drag (POWERUP_PUSH_DRAG).
 * 2. Computes a desired closing velocity that respects the ship's
 *    braking envelope (LINEAR_DRAG), so the ship arrives with low speed
 *    and does not overshoot the pickup radius.
 * 3. Steers toward the velocity-error vector (desired - current velocity),
 *    not just the position vector. This actively cancels tangential
 *    "orbiting" velocity and produces a smooth, deliberate approach.
 *
 * Each ctrl constant is sourced from ctx (not AI_TUNABLES directly),
 * so a tuner-panel drag updates behavior on the next tick.
 */
export function collectBehavior(ctx) {
  if (!ctx.target || ctx.target.mode !== 'powerup') return null;

  const targetPos = ctx.target.pos;
  const aiPos = ctx.aiPos;
  const aiYaw = ctx.aiYaw;
  const powerupVel = ctx.powerupVel || { x: 0, z: 0 };
  const aiVel = ctx.aiVel || { x: 0, z: 0 };

  const ctxDefaults = {
    // powerupThrustGate has no entry here on purpose — it falls
    // through to AI_TUNABLES.powerupThrustGate below (the previous
    // hardcoded duplicate of ctxDefaults.powerupCruiseSpeed was a
    // silent fallback bug).
    powerupThrustGate: AI_TUNABLES.powerupThrustGate,
    powerupCruiseSpeed: AI_TUNABLES.powerupCruiseSpeed,
    powerupMinApproachSpeed: AI_TUNABLES.powerupMinApproachSpeed,
    powerupApproachGain: AI_TUNABLES.powerupApproachGain,
    powerupBrakeSafetyFactor: AI_TUNABLES.powerupBrakeSafetyFactor,
    powerupVelocityErrorThreshold: AI_TUNABLES.powerupVelocityErrorThreshold,
    powerupFinalApproachDist: AI_TUNABLES.powerupFinalApproachDist,
    powerupFinalApproachSpeed: AI_TUNABLES.powerupFinalApproachSpeed,
  };

  // 1. Adaptive intercept horizon.
  const dx0 = targetPos.x - aiPos.x;
  const dz0 = targetPos.z - aiPos.z;
  const dist0 = Math.hypot(dx0, dz0);
  const cruiseSpeed = ctx.powerupCruiseSpeed ?? ctxDefaults.powerupCruiseSpeed;
  const minApproachSpeed = ctx.powerupMinApproachSpeed ?? ctxDefaults.powerupMinApproachSpeed;
  const approachGain = ctx.powerupApproachGain ?? ctxDefaults.powerupApproachGain;
  const desiredAvgSpeed = Math.min(
    cruiseSpeed,
    Math.max(minApproachSpeed, dist0 * approachGain),
  );
  const tGo = Math.max(0.2, dist0 / desiredAvgSpeed);

  // 2. Predict powerup position at tGo with exponential drag.
  const drag = POWERUP_PUSH_DRAG;
  const decayFactor = 1 - Math.exp(-drag * tGo);
  const predictedPos = {
    x: targetPos.x + powerupVel.x * decayFactor / drag,
    z: targetPos.z + powerupVel.z * decayFactor / drag,
  };

  // 3. Desired velocity to reach the predicted intercept point.
  const dx = predictedPos.x - aiPos.x;
  const dz = predictedPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);

  const brakeSafety = ctx.powerupBrakeSafetyFactor ?? ctxDefaults.powerupBrakeSafetyFactor;
  const maxSafeSpeed = Math.max(0, dist * LINEAR_DRAG * brakeSafety);
  const desiredSpeed = Math.min(maxSafeSpeed, cruiseSpeed);
  const dirX = dist > 0.001 ? dx / dist : 0;
  const dirZ = dist > 0.001 ? dz / dist : 0;

  const vDesX = dirX * desiredSpeed;
  const vDesZ = dirZ * desiredSpeed;

  // 4. Velocity error = desired - current.
  const vErrX = vDesX - aiVel.x;
  const vErrZ = vDesZ - aiVel.z;
  const vErrMag = Math.hypot(vErrX, vErrZ);

  const finalApproachDist = ctx.powerupFinalApproachDist ?? ctxDefaults.powerupFinalApproachDist;
  const inFinalApproach = dist0 < finalApproachDist;
  const steerTarget = inFinalApproach
    ? targetPos
    : { x: aiPos.x + vErrX, z: aiPos.z + vErrZ };

  const powerupThrustGate = ctx.powerupThrustGate ?? ctxDefaults.powerupThrustGate;
  const steeringCtx = {
    ...ctx,
    aiPos,
    aiYaw,
    thrustHeadingGate: powerupThrustGate,
  };
  const steer = steerToward(steeringCtx, steerTarget, 'powerup');

  const aligned = Math.abs(steer.predictedDiff) < powerupThrustGate;

  const finalApproachSpeed = ctx.powerupFinalApproachSpeed ?? ctxDefaults.powerupFinalApproachSpeed;
  const velErrThreshold = ctx.powerupVelocityErrorThreshold ?? ctxDefaults.powerupVelocityErrorThreshold;
  let thrust;
  if (inFinalApproach) {
    const dir0X = dist0 > 0.001 ? dx0 / dist0 : 0;
    const dir0Z = dist0 > 0.001 ? dz0 / dist0 : 0;
    const closingSpeed = (aiVel.x * dir0X + aiVel.z * dir0Z);
    thrust = aligned && closingSpeed < finalApproachSpeed;
  } else {
    thrust = aligned && vErrMag > velErrThreshold;
  }

  const closing0 = (aiVel.x * dx0 + aiVel.z * dz0) / Math.max(dist0, 0.001);
  const reason = `powerup ${dist0.toFixed(1)}u, closing ${closing0.toFixed(1)}u/s${inFinalApproach ? ' (final)' : ''}`;

  return { yaw: steer.yaw, thrust, mode: 'powerup', fire: false, braking: false, reason };
}

/**
 * ENGAGE behavior: chase the best asteroid with velocity-aware
 * approach control.
 *
 * Returns `{ yaw, thrust, mode: 'asteroid', reason }`.
 */
export function engageBehavior(ctx) {
  if (!ctx.target || ctx.target.mode !== 'asteroid') return null;
  const targetPos = ctx.target.pos;

  const dx = targetPos.x - ctx.aiPos.x;
  const dz = targetPos.z - ctx.aiPos.z;
  const dist = Math.hypot(dx, dz);

  const minApproach = 5;
  const maxApproach = 60;
  const desiredClosing = Math.max(
    minApproach,
    Math.min(maxApproach, dist * 0.4),
  );

  const thrustGate = Math.min(0.5, (ctx.thrustHeadingGate ?? 0.2) * 2.5);

  const steer = steerToward(ctx, targetPos, 'asteroid', {
    desiredClosingSpeed: desiredClosing,
    thrustGate,
  });

  // Find the size of the asteroid we're chasing for the reason text.
  let sizeText = '?';
  let targetAst = null;
  for (const a of (ctx.asteroids || [])) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const p = a.getPosition();
    if (!p) continue;
    if (Math.abs(p.x - targetPos.x) < 0.001 && Math.abs(p.z - targetPos.z) < 0.001) {
      targetAst = a;
      break;
    }
  }
  if (targetAst && typeof targetAst.getSize === 'function') {
    const s = targetAst.getSize();
    sizeText = s === 0 ? 'L' : s === 1 ? 'M' : 'S';
  }

  const reason = `asteroid ${sizeText} @ ${dist.toFixed(1)}u, closing ${desiredClosing.toFixed(1)}u/s`;

  return {
    yaw: steer.yaw,
    thrust: steer.thrust,
    mode: 'asteroid',
    fire: false,
    braking: false,
    reason,
  };
}

/**
 * IDLE behavior: nothing to do. Returns `{ mode: 'idle', reason }`.
 */
export function idleBehavior(ctx) {
  const n = (ctx.asteroids || []).length;
  const reason = n === 0 ? 'no asteroids in range' : `idle (${n} asteroids, none targetable)`;
  return { yaw: 0, thrust: false, mode: 'idle', fire: false, braking: false, reason };
}

// --------------------------------------------------------------------------
// Arbitration
// --------------------------------------------------------------------------

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
 * Every tunable arg has TWO layers:
 *   1. Caller-provided `args.X` (test/factory override — wins if set)
 *   2. Fallback to `AI_TUNABLES.X` (live tunable — visible in the
 *      tuner panel)
 *
 * The factory's `brainArgsFromShip()` already applies this pattern,
 * but the same defaults are replicated here so direct callers
 * (`aiBrainTick` in unit tests, e.g.) also get live-tunable behavior
 * when they don't pass a specific override.
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
  evadeDist = AI_TUNABLES.evadeDist,
  powerupMaxChaseDist = AI_TUNABLES.powerupMaxChaseDist,
  thrustHeadingGate = AI_TUNABLES.thrustHeadingGate,
  yawDeadband = AI_TUNABLES.yawDeadband,
  fireHeadingGate = AI_TUNABLES.fireHeadingGate,
  fireMinDist = AI_TUNABLES.fireMinDist,
  fireMaxDist = AI_TUNABLES.fireMaxDist,
  activeWeapon = API_DEFAULTS.activeWeapon,
  laserFireHeadingGate = AI_TUNABLES.laserFireHeadingGate,
  bulletSpeed = AI_TUNABLES.bulletSpeed,
  asteroidSizeBias = AI_TUNABLES.asteroidSizeBias,
  powerupThrustGate = AI_TUNABLES.powerupThrustGate,
  powerupStickyTime = AI_TUNABLES.powerupStickyTime,
  forwardConeHalfAngle = AI_TUNABLES.forwardConeHalfAngle,
  powerupNearBehindThreshold = AI_TUNABLES.powerupNearBehindThreshold,
  powerupCruiseSpeed = AI_TUNABLES.powerupCruiseSpeed,
  powerupMinApproachSpeed = AI_TUNABLES.powerupMinApproachSpeed,
  powerupApproachGain = AI_TUNABLES.powerupApproachGain,
  powerupBrakeSafetyFactor = AI_TUNABLES.powerupBrakeSafetyFactor,
  powerupVelocityErrorThreshold = AI_TUNABLES.powerupVelocityErrorThreshold,
  powerupFinalApproachDist = AI_TUNABLES.powerupFinalApproachDist,
  powerupFinalApproachSpeed = AI_TUNABLES.powerupFinalApproachSpeed,
  aiAngularVel = API_DEFAULTS.aiAngularVel,
} = {}) {
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
    forwardConeHalfAngle,
    powerupNearBehindThreshold,
    powerupThrustGate,
    powerupStickyTime,
    powerupCruiseSpeed,
    powerupMinApproachSpeed,
    powerupApproachGain,
    powerupBrakeSafetyFactor,
    powerupVelocityErrorThreshold,
    powerupFinalApproachDist,
    powerupFinalApproachSpeed,
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
export function shouldResetAi(pos, resetDist = FACTORY_DEFAULTS.resetDist) {
  if (!pos) return false;
  return Math.hypot(pos.x, pos.z) > resetDist;
}

/**
 * Build a random spawn position within `radius` of the origin.
 */
export function pickAiSpawn(radius = FACTORY_DEFAULTS.spawnRadius, rng = Math.random) {
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
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene            Required.
 * @param {Array}      cfg.asteroids         Required.
 * @param {object?}    cfg.weapon            Duck-typed `{ fire(opts) }`.
 * @param {function?}  cfg.getPowerupPos     () => { x, z } | null
 * @param {function?}  cfg.getPowerupVel     () => { x, z }
 * @param {function?}  cfg.getActiveWeapon   () => 'bullet' | 'laser'
 * @param {object?}    cfg.options           Per-AI overrides:
 *     - resetDist, spawnRadius (factory-only)
 *     - any brain tunable (overrides live AI_TUNABLES for tests)
 */
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, getPowerupVel = null, getActiveWeapon = null, options = {} } = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...FACTORY_DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;
  const brain = opts.brain || null;

  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = opts.spawnYaw;

  let time = 0;
  let enabled = true;
  let lastMode = 'idle';
  let stickyPowerupPos = null;
  let stickyPowerupSince = 0;
  let lastDecision = {
    mode: 'idle',
    yaw: 0,
    thrust: false,
    fire: false,
    reason: 'not yet ticked',
    activeWeapon: 'bullet',
    target: null,
    nearest: null,
    threatsCount: 0,
  };

  function spawn() {
    const sp = pickAiSpawn(opts.spawnRadius, rng);
    ship.reset(sp.position);
    ship.rotation.yaw = opts.spawnYaw;
  }

  /**
   * Build a fresh brain-args object every tick. v0.49.0 simplification:
   * the live-tunable lookup is delegated entirely to `aiBrainTick`'s
   * default-parameter destructuring (`evadeDist = AI_TUNABLES.evadeDist,
   * ...`), so this function only needs to forward the ship-derived
   * runtime state + the explicitly-passed factory overrides from
   * `opts` (resetDist, spawnRadius, spawnYaw, + any user-supplied
   * per-AI overrides for tests).
   *
   * Precedence (unchanged from v0.47.0):
   *   1. Caller explicitly passes `evadeDist: 50` (in args) → 50 wins.
   *   2. Factory time: `options.evadeDist = 30` (via `opts`) → 30 wins.
   *   3. Otherwise: `aiBrainTick`'s default destructures
   *      `evadeDist = AI_TUNABLES.evadeDist`, reading the LIVE bag.
   *      A slider drag (`AI_TUNABLES.evadeDist = 100`) is visible on
   *      the very next brain frame.
   *
   * Previously this function enumerated 19 `o.X ?? AI_TUNABLES.X` lines
   * inline. The duplication made the source of truth ambiguous and
   * obscured a thin test-mock round-7 quirk (now resolved). The
   * refactor keeps the line count low and ships a single fallback
   * pathway through `aiBrainTick`.
   */
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
      aiAngularVel: ship.angularVelocity,
      activeWeapon: getActiveWeapon ? getActiveWeapon() : API_DEFAULTS.activeWeapon,
      // Factory overrides (resetDist, spawnRadius, spawnYaw, +
      // any explicit per-AI overrides from `options`). The brain's
      // default-parameter destructuring handles the live-bag fallback
      // for unset keys.
      ...opts,
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

    if (decision.mode === 'powerup' && args.powerupPos) {
      stickyPowerupPos = args.powerupPos;
      stickyPowerupSince = time;
    } else if (stickyPowerupPos) {
      const stickyAge = time - stickyPowerupSince;
      if (stickyAge > args.powerupStickyTime) {
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
      if (d < args.evadeDist) threatsCount += 1;
    }

    const target = pickTarget({
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      asteroids,
      powerupPos: args.powerupPos,
      stickyPowerupPos,
      powerupMaxChaseDist: args.powerupMaxChaseDist,
      asteroidSizeBias: args.asteroidSizeBias,
      forwardConeHalfAngle: args.forwardConeHalfAngle,
      powerupNearBehindThreshold: args.powerupNearBehindThreshold,
    });

    let predictedPos = null;
    if (target && target.mode === 'asteroid') {
      const targetAsteroid = asteroids.find((a) => {
        if (!a || typeof a.getPosition !== 'function') return false;
        const p = a.getPosition();
        if (!p) return false;
        return Math.hypot(p.x - target.pos.x, p.z - target.pos.z) < 0.001;
      });
      if (targetAsteroid) {
        predictedPos = predictAsteroidPosition(targetAsteroid, ship.position, args.bulletSpeed);
      }
    }

    lastDecision = {
      mode: decision.mode,
      yaw: decision.yaw,
      thrust: decision.thrust,
      fire: decision.fire,
      braking: !!decision.braking,
      reason: decision.reason || '',
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
      reason: lastDecision.reason,
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
