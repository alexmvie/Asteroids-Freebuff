/**
 * Demo AI — an NPC ship for the DEMO attract state.
 *
 * v0.30.x — radical simplification driven by simulation data. v0.29.x's
 * speed management + soft-yaw-guard + aggressive powerup bias (60u) locked
 * the ship into chasing distant powerups it never reached:
 *   - 84% of time in powerup mode, 0 collected
 *   - Only 16u traveled in 45s (avg 0.36 u/s!)
 *   - Mode locked: 7 transitions total
 *
 * The fix drops all speed-management machinery and returns to a simple
 * "see asteroid → fly toward it → shoot" controller:
 *
 *   1. Turn toward target (wide thrust gate: 0.52 rad ≈ 30°)
 *   2. Thrust whenever roughly aligned (no soft yaw guard, no speed cap)
 *   3. Fire at any in-cone asteroid
 *   4. Powerups are STRICTLY opportunistic (bias reduced to 15u)
 *   5. Tight evade zone (8u) for emergencies only
 *
 * The ship's LINEAR_DRAG handles natural deceleration.
 */

import { createShip } from './ship.js';
import { YAW_INERTIA_TAU } from './ship-constants.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

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
   * v0.30.x: tightened to 8u so evade is truly last-resort.
   */
  evadeDist: 8,

  /**
   * Powerup detour bias (world units). Powerup wins over nearest
   * asteroid if `powerupDist < asteroidDist + powerupBiasU`.
   * v0.30.x: reduced from 60 to 15 — strictly opportunistic.
   * A powerup must be within 15u of the nearest asteroid's distance
   * to steal focus. Prevents the "locked onto distant powerup" bug.
   */
  powerupBiasU: 15,

  /**
   * Thrust heading gate (radians). Ship thrusts when |heading diff|
   * is within this angle. No soft yaw guard — thrust happens
   * whenever roughly aligned, even during turns.
   * 0.30 rad ≈ 17° — moderate. 96% of thrust goes toward target.
   */
  thrustHeadingGate: 0.30,

  /**
   * Fire heading gate (radians). Ship fires when |heading diff|
   * is within this angle. 0.10 rad ≈ 5.7° — tight for accuracy.
   * At 40u: offset = 40*sin(5.7°) ≈ 4u → within asteroid radius.
   */
  fireHeadingGate: 0.10,

  /**
   * Fire distance range (world units). Ship fires at asteroids
   * within [fireMinDist, fireMaxDist]. v0.30.x: wider range for
   * more firing.
   */
  fireMinDist: 8,
  fireMaxDist: 120,

  /**
   * Fire cone half-angle for checking if ANY asteroid is in front
   * (not just the chase target). NOTE: v0.30.x fire loop uses
   * `fireHeadingGate` instead; this is kept for legacy callers.
   */
  fireConeHalfAngle: 0.35,

  /**
   * Laser fire heading gate (radians). Tighter than bullet mode —
   * the laser locks on the chase target specifically.
   */
  laserFireHeadingGate: 0.05,
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
 * @param {{
 *   aiPos: {x:number,z:number},
 *   asteroids: Array<{getPosition: () => any}>,
 *   powerupPos: {x:number,z:number} | null,
 *   powerupBiasU: number,
 * }} args
 * @returns {{ pos: {x:number,z:number}, mode: 'asteroid'|'powerup', dist: number } | null}
 */
export function pickTarget({ aiPos, asteroids, powerupPos, powerupBiasU }) {
  const nearest = findNearestAsteroid(aiPos, asteroids);
  let best = null;
  if (nearest) {
    best = {
      pos: nearest.asteroid.getPosition(),
      mode: 'asteroid',
      dist: nearest.dist,
    };
  }

  if (powerupPos && typeof powerupPos.x === 'number') {
    const pDist = Math.hypot(powerupPos.x - aiPos.x, powerupPos.z - aiPos.z);
    if (best === null) {
      return { pos: powerupPos, mode: 'powerup', dist: pDist };
    }
    if (pDist < best.dist + powerupBiasU) {
      return { pos: powerupPos, mode: 'powerup', dist: pDist };
    }
  }

  return best;
}

/**
 * Simple engagement controller: turn toward target, thrust when
 * roughly aligned. No speed management, no soft yaw guard, no
 * active braking. The ship's LINEAR_DRAG handles deceleration.
 *
 * v0.30.x: stripped all speed-management complexity. The v0.29.x
 * controller's isSteady + desiredClosing thresholds locked the ship
 * into "turn without thrusting" for the majority of ticks (analysis
 * showed only 45% thrust in powerup mode, 15% in asteroid mode).
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} aiVel  kept for backward compat, unused
 * @param {{x:number,z:number}} targetPos
 * @param {number} [aiAngularVel=0]  for spin-brake prediction
 * @param {number} [thrustGate=0.52] heading gate for thrust
 * @returns {{ yaw: number, thrust: boolean, diff: number, dist: number }}
 */
export function engageTarget(aiPos, aiYaw, aiVel, targetPos, aiAngularVel = 0, thrustGate = DEFAULTS.thrustHeadingGate) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return { yaw: 0, thrust: false, diff: 0, dist: 0 };

  // Face toward target (no braking — always approach)
  const faceAngle = Math.atan2(dz, dx);
  const targetDiff = wrapAngle(faceAngle - facingAngle(aiYaw));
  const angVel = (typeof aiAngularVel === 'number') ? aiAngularVel : 0;
  const predictedDiff = wrapAngle(targetDiff + angVel * YAW_INERTIA_TAU);

  // Yaw: spin-brake prediction prevents wobble
  const yaw = predictedDiff > YAW_DEADBAND ? -1
    : predictedDiff < -YAW_DEADBAND ? 1
    : 0;

  // Thrust: fire engines whenever roughly aligned (no coasting, no speed cap).
  // The ship naturally flies past targets → engines cut → turns around while
  // LINEAR_DRAG decelerates → clean fly-by attack pattern.
  const thrust = Math.abs(targetDiff) < thrustGate;

  return { yaw, thrust, diff: targetDiff, dist };
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
 * Returns `{ yaw, thrust, mode, fire }` where:
 *   - `yaw`     ∈ {-1, 0, +1}
 *   - `thrust`  boolean
 *   - `mode`    'evade' | 'asteroid' | 'powerup' | 'idle'
 *   - `fire`    boolean
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   aiYaw: number,
 *   aiVel?: { x: number, z: number },
 *   aiAngularVel?: number,
 *   asteroids: Array<{ getPosition: () => any }>,
 *   time: number,
 *   powerupPos?: { x: number, z: number } | null,
 *   evadeDist?: number,
 *   powerupBiasU?: number,
 *   fireConeHalfAngle?: number,
 *   fireMinDist?: number,
 *   fireMaxDist?: number,
 *   thrustHeadingGate?: number,
 *   fireHeadingGate?: number,
 *   activeWeapon?: 'bullet' | 'laser',
 *   laserFireHeadingGate?: number,
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
  // Legacy param accepted for backward compat (treated as evadeDist alias)
  panicDist = undefined,
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  // Use evadeDist (new) or panicDist (legacy) — whichever is provided.
  const ed = (panicDist !== undefined && evadeDist === DEFAULTS.evadeDist)
    ? panicDist : evadeDist;

  const nearest = findNearestAsteroid(aiPos, asteroids);

  // ---- 1. EVADE (nearest asteroid within evadeDist) --------------------
  // Emergency reflex: thrust 90° perpendicular to the nearest asteroid.
  // Always thrust + turn simultaneously for maximum escape velocity.
  if (nearest && nearest.dist < ed) {
    const threatAngle = Math.atan2(nearest.dz, nearest.dx);
    const escapeAngle = threatAngle + Math.PI / 2;
    const diff = wrapAngle(escapeAngle - facingAngle(aiYaw));
    return {
      yaw: diff > 0.05 ? -1 : diff < -0.05 ? 1 : 0,
      thrust: true,
      mode: 'evade',
      fire: false,
    };
  }

  // ---- 2. ENGAGE (pick target + approach) -----------------------------
  const target = pickTarget({ aiPos, asteroids, powerupPos, powerupBiasU });
  if (target) {
    const ec = engageTarget(aiPos, aiYaw, aiVel, target.pos, aiAngularVel, thrustHeadingGate);

    // Fire discipline: fire when ANY asteroid is in the fire cone
    // AND within the fire distance range. Matches "feuer bis split,
    // dann weiter auf die verbleibenden Teile" — the AI shoots
    // whatever is in front of it, not just the chase target.
    let fire = false;
    if (activeWeapon === 'laser') {
      // Laser locks on the chase target specifically, tight cone.
      fire = isTargetInFront(aiPos, aiYaw, target.pos, laserFireHeadingGate);
    } else {
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        if (!p) continue;
        const dist = Math.hypot(p.x - aiPos.x, p.z - aiPos.z);
        if (dist < fireMinDist || dist > fireMaxDist) continue;
        if (isTargetInFront(aiPos, aiYaw, p, fireHeadingGate)) {
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
    };
  }

  // ---- 3. IDLE (no targets) -------------------------------------------
  return { yaw: 0, thrust: false, mode: 'idle', fire: false };
}

/**
 * Create a demo AI ship. Wires the brain to a live ship.
 *
 * @param {{
 *   scene: import('three').Scene,
 *   asteroids: Array<{ getPosition: () => any }>,
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
      fireConeHalfAngle: opts.fireConeHalfAngle,
      fireMinDist: opts.fireMinDist,
      fireMaxDist: opts.fireMaxDist,
      thrustHeadingGate: opts.thrustHeadingGate,
      fireHeadingGate: opts.fireHeadingGate,
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
      laserFireHeadingGate: opts.laserFireHeadingGate,
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
      activeWeapon: args.activeWeapon,
      target: target ? { pos: { ...target.pos }, mode: target.mode, dist: target.dist } : null,
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
      // Legacy field — no longer computed, always 0 for overlay compat
      lookaheadThreats: 0,
      committedTargetSince: 0,
    }),
  };
}
