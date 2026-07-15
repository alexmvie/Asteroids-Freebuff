/**
 * Demo AI — clean-room rewrite (v0.55.0).
 *
 * The brain is intentionally small. The whole game boils down to four
 * questions:
 *
 *   1. Is anything about to kill me?    → EVADE  (thrust perpendicular)
 *   2. Is there a powerup in range?    → COLLECT (predict + steer; coast-in)
 *   3. Is there an asteroid in range?  → ENGAGE  (predict + steer; fire)
 *   4. Nothing in range?               → IDLE   (do nothing)
 *
 * The user's spec ("simple Asteroids AI") is exactly this. We
 * deliberately collapsed the v0.46–v0.49 collection into a single
 * steer-toward-predicted-position controller with a one-line coast-in
 * gate, then removed every behavior-specific tunable.
 *
 * Architecture
 * ------------
 *   1. Pure helpers (`facingAngle`, `wrapAngle`, `predictPosition`,
 *      `isTargetInFront`) — universal across any moving target.
 *   2. `evaluatePerception(args)` — turns raw world state into a
 *      snapshot `{ nearestAst, nearestPw, nearestShip? }`. Add new
 *      fields here when new target types appear.
 *   3. `BEHAVIORS` — open-ended, priority-ordered registry. Each
 *      entry: `{ name, run(snap, args) }` returning a decision or
 *      null. Inserting a behavior at a priority slot is the ONLY
 *      change needed to add a new AI mode (pirate, station lander,
 *      formation flight, etc.).
 *   4. `aiBrainTick(args)` — pure decision mapper. Calls perception,
 *      walks BEHAVIORS in order, returns the first non-null decision
 *      with `fire` set by the independent fire loop.
 *
 * Fire is decoupled from chase target — the ship can shoot an
 * asteroid while chasing a powerup. Tests pin this contract.
 *
 * What was deliberately REMOVED (and why)
 * ---------------------------------------
 *   - Velocity-error controller / final-approach guard → replaced by
 *     `predict + steer` + a single `POWERUP_COAST_DIST` for stationary
 *     pickups.
 *   - Angular-velocity prediction (YAW_INERTIA_TAU counter-steer) →
 *     ship.js already has YAW_INERTIA_TAU; the AI doesn't need to
 *     model it.
 *   - Adaptive closing-speed throttle → coast-in alone handles close
 *     range.
 *   - Sticky powerup commitment → re-evaluating every tick fixes the
 *     "stale target" bug.
 *   - 14 of 22 AI_TUNABLES → purged.
 */

import { createShip } from './ship.js';
import { AI_TUNABLES } from './ai-tunables.js';

// ------------------------------------------------------------------
// Factory-only constants (not part of the runtime tunable surface)
// ------------------------------------------------------------------

const FACTORY_DEFAULTS = Object.freeze({
  /** Reset the AI ship if it drifts beyond this radius from origin. */
  resetDist: 400,
  /** Spawn radius (XZ) for the initial position + on-reset placement. */
  spawnRadius: 30,
  /** Initial yaw (radians). */
  spawnYaw: 0,
});

/**
 * Coast-in distance (world units) for the COLLECT behavior. When the
 * ship is closer than this to a stationary target, thrust is cut and
 * LINEAR_DRAG handles the deceleration. The single brake that
 * prevents "fly past and orbit forever" at high cruise speed.
 */
const POWERUP_COAST_DIST = 5;

// ------------------------------------------------------------------
// Pure math helpers
// ------------------------------------------------------------------

/**
 * Wrap an angle into [-π, π).
 */
export function wrapAngle(a) {
  const TAU = Math.PI * 2;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return r;
}

/**
 * Ship forward direction in atan2(z, x) space.
 * yaw=0 → forward=(-sin(0), 0, -cos(0)) = (0,0,-1) → angle = -π/2.
 */
export function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/**
 * Predict a target's position at ship arrival time.
 * `target = { pos: {x,z}, vel?: {x,z} }`. Universal — asteroids,
 * powerups, future ships, future moving stations.
 */
export function predictPosition(target, aiPos, bulletSpeed) {
  if (!target || !target.pos || typeof target.pos.x !== 'number') return null;
  const dx = target.pos.x - aiPos.x;
  const dz = target.pos.z - aiPos.z;
  const d = Math.hypot(dx, dz);
  const t = d / Math.max(bulletSpeed, 1);
  const vx = (target.vel && typeof target.vel.x === 'number') ? target.vel.x : 0;
  const vz = (target.vel && typeof target.vel.z === 'number') ? target.vel.z : 0;
  return { x: target.pos.x + vx * t, z: target.pos.z + vz * t };
}

/**
 * True iff a target position is in front of the ship within
 * `halfAngle` radians. Ship-yaw convention: yaw 0 faces -Z.
 */
export function isTargetInFront(aiPos, aiYaw, targetPos, halfAngle) {
  if (!aiPos || !targetPos) return false;
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  if (dx === 0 && dz === 0) return false;
  const targetAngle = Math.atan2(dz, dx);
  const diff = Math.abs(wrapAngle(targetAngle - facingAngle(aiYaw)));
  return diff < halfAngle;
}

/**
 * Find the nearest item in a list to `pos`. `getPos` defaults to
 * `.getPosition()` for duck-typed asteroid-like objects.
 *
 * Returns `{ item, dx, dz, dist, pos }` or null.
 */
function findNearest(pos, items, getPos = (i) => i && i.getPosition && i.getPosition()) {
  let best = null;
  let bestDist = Infinity;
  for (const item of items) {
    if (!item) continue;
    const p = getPos(item);
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      best = { item, dx, dz, dist: d, pos: p };
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Universal steering (one helper, used by every non-idle behavior)
// ------------------------------------------------------------------

/**
 * Compute heading error to a target position (radians, [-π, π]).
 */
function headingError(args, targetPos) {
  const dx = targetPos.x - args.aiPos.x;
  const dz = targetPos.z - args.aiPos.z;
  if (dx === 0 && dz === 0) return 0;
  const targetAngle = Math.atan2(dz, dx);
  return wrapAngle(targetAngle - facingAngle(args.aiYaw));
}

/**
 * Turn a heading error into a {-1, 0, +1} yaw command.
 * Positive error = target is LEFT of ship's facing → yaw=-1 (turn right
 * per ship.js convention).
 */
function yawCommandFromError(err, deadband) {
  if (Math.abs(err) < deadband) return 0;
  return err > 0 ? -1 : 1;
}

/**
 * Universal steer helper. Returns `{ yaw, thrust, err }`.
 * Thrust is ON when |err| < thrustHeadingGate, unless `forceThrust`.
 */
function steerTo(args, targetPos, { forceThrust = false } = {}) {
  const err = headingError(args, targetPos);
  const yaw = yawCommandFromError(err, args.yawDeadband);
  const thrust = forceThrust || Math.abs(err) < args.thrustHeadingGate;
  return { yaw, thrust, err };
}

/**
 * The asteroid-specific prediction helper. Calls the universal
 * `predictPosition` after extracting `pos + vel` from an
 * asteroid-like duck-typed object.
 */
function predictAsteroidPosition(asteroid, aiPos, bulletSpeed) {
  if (!asteroid || typeof asteroid.getPosition !== 'function') return null;
  const pos = asteroid.getPosition();
  if (!pos) return null;
  return predictPosition(
    { pos, vel: typeof asteroid.getVelocity === 'function' ? asteroid.getVelocity() : null },
    aiPos,
    bulletSpeed,
  );
}

// ------------------------------------------------------------------
// Behavior registry (priority-ordered, future-extensible)
// ------------------------------------------------------------------

/**
 * EVADE behavior: nearest asteroid within evadeDist → turn 90° perpendicular,
 * thrust hard. Uses `forceThrust` because perpendicular is still the
 * safest escape vector even when misaligned.
 */
function evadeBehavior(snap, args) {
  const a = snap.nearestAst;
  if (!a || a.dist >= args.evadeDist) return null;
  const threatAngle = Math.atan2(a.dz, a.dx);
  // 90° perpendicular, pick the +90° side (consistent).
  const escapeAngle = threatAngle + Math.PI / 2;
  const targetPos = {
    x: args.aiPos.x + Math.cos(escapeAngle),
    z: args.aiPos.z + Math.sin(escapeAngle),
  };
  const steer = steerTo(args, targetPos, { forceThrust: true });
  return {
    yaw: steer.yaw,
    thrust: steer.thrust,
    mode: 'evade',
    reason: `asteroid ${a.dist.toFixed(1)}u < ${args.evadeDist.toFixed(1)}u`,
  };
}

/**
 * COLLECT behavior: reachable powerup → predict + steer + coast-in.
 * Stationary powerups collapse `predictPosition` to current pos, but
 * the same code path handles a moving powerup if powerups ever drift.
 */
function collectBehavior(snap, args) {
  if (!snap.nearestPw || snap.nearestPw.dist >= args.powerupMaxChaseDist) return null;
  const pw = snap.nearestPw;
  const predicted = predictPosition(pw, args.aiPos, args.bulletSpeed);
  if (!predicted) return null;
  const dist = pw.dist;
  const coastIn = dist < POWERUP_COAST_DIST;
  const steer = steerTo(args, predicted, { forceThrust: false });
  return {
    yaw: steer.yaw,
    thrust: !coastIn && steer.thrust,
    mode: 'powerup',
    reason: `powerup ${dist.toFixed(1)}u${coastIn ? ' (coast)' : ''}`,
  };
}

/**
 * ENGAGE behavior: nearest asteroid → predict at bullet flight + steer.
 * Same code path for moving and stationary asteroids.
 */
function engageBehavior(snap, args) {
  if (!snap.nearestAst) return null;
  const ast = snap.nearestAst;
  const predicted = predictAsteroidPosition(ast.item, args.aiPos, args.bulletSpeed);
  const targetPos = predicted || ast.pos;
  const steer = steerTo(args, targetPos);
  return {
    yaw: steer.yaw,
    thrust: steer.thrust,
    mode: 'asteroid',
    reason: `asteroid ${ast.dist.toFixed(1)}u`,
  };
}

/**
 * IDLE behavior: fallback when no target is in range.
 */
function idleBehavior() {
  return { yaw: 0, thrust: false, mode: 'idle', reason: 'no targets in range' };
}

// Priority order: EVADE wins (immediate threat), then COLLECT (user
// priority per the spec), then ENGAGE, then IDLE as fallback. Insert
// future behaviors (pirate, land) at the right priority slot here.
const BEHAVIORS = [
  { name: 'evade', run: evadeBehavior },
  { name: 'collect', run: collectBehavior },
  { name: 'engage', run: engageBehavior },
  { name: 'idle', run: idleBehavior },
];

// ------------------------------------------------------------------
// Perception (snapshot of the world for the behavior layer)
// ------------------------------------------------------------------

/**
 * Evaluate perception — nearest asteroid, nearest powerup, future: ships,
 * stations, etc. Returns a snapshot the behaviors read.
 */
function evaluatePerception(args) {
  const nearestAst = findNearest(args.aiPos, args.asteroids || []);
  const nearestPw = args.powerupPos
    ? {
        pos: args.powerupPos,
        vel: args.powerupVel || { x: 0, z: 0 },
        dist: Math.hypot(
          args.powerupPos.x - args.aiPos.x,
          args.powerupPos.z - args.aiPos.z,
        ),
      }
    : null;
  return { nearestAst, nearestPw };
}

// ------------------------------------------------------------------
// Fire loop (independent of chase target)
// ------------------------------------------------------------------

/**
 * Decide whether the AI should fire this tick. Scans every asteroid,
 * predicts its position at bullet flight time, and fires if any is
 * in the forward cone + fire range. Independent of chase target so
 * the ship can shoot while chasing a powerup.
 */
function evaluateFire(args) {
  if (!args.asteroids) return false;
  for (const a of args.asteroids) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const predicted = predictAsteroidPosition(a, args.aiPos, args.bulletSpeed);
    if (!predicted) continue;
    const d = Math.hypot(predicted.x - args.aiPos.x, predicted.z - args.aiPos.z);
    if (d < args.fireMinDist || d > args.fireMaxDist) continue;
    if (isTargetInFront(args.aiPos, args.aiYaw, predicted, args.fireHeadingGate)) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------
// Public brain
// ------------------------------------------------------------------

/**
 * Decide what the AI should do this tick. Pure function.
 *
 * @param {object} args
 * @param {{x,y,z}} args.aiPos — required
 * @param {number} args.aiYaw  — required (radians, ship.js convention)
 * @param {Array}  args.asteroids — required (array of duck-typed entities)
 * @param {{x,z}?} args.powerupPos — optional; falling null = no powerup in scene
 * @param {{x,z}?} args.powerupVel — optional; defaults to {0,0}
 * @param {number} args.evadeDist, args.powerupMaxChaseDist,
 *               args.thrustHeadingGate, args.yawDeadband,
 *               args.fireHeadingGate, args.fireMinDist, args.fireMaxDist,
 *               args.bulletSpeed — optional; fall through to AI_TUNABLES
 * @returns {{ yaw, thrust, mode, fire, reason }}
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  asteroids,
  powerupPos = null,
  powerupVel = null,
  evadeDist = AI_TUNABLES.evadeDist,
  powerupMaxChaseDist = AI_TUNABLES.powerupMaxChaseDist,
  thrustHeadingGate = AI_TUNABLES.thrustHeadingGate,
  yawDeadband = AI_TUNABLES.yawDeadband,
  fireHeadingGate = AI_TUNABLES.fireHeadingGate,
  fireMinDist = AI_TUNABLES.fireMinDist,
  fireMaxDist = AI_TUNABLES.fireMaxDist,
  bulletSpeed = AI_TUNABLES.bulletSpeed,
} = {}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const args = {
    aiPos, aiYaw, asteroids,
    powerupPos, powerupVel,
    evadeDist, powerupMaxChaseDist,
    thrustHeadingGate, yawDeadband,
    fireHeadingGate, fireMinDist, fireMaxDist,
    bulletSpeed,
  };
  const snap = evaluatePerception(args);
  for (const b of BEHAVIORS) {
    const decision = b.run(snap, args);
    if (decision) {
      decision.fire = evaluateFire(args);
      return decision;
    }
  }
  // Should never reach here (idle always returns), but keep the
  // fallback for behavior-registry safety.
  return { yaw: 0, thrust: false, mode: 'idle', fire: false, reason: 'no behavior fired' };
}

// ------------------------------------------------------------------
// Factory helpers (unchanged API surface)
// ------------------------------------------------------------------

export function shouldResetAi(pos, resetDist = FACTORY_DEFAULTS.resetDist) {
  if (!pos) return false;
  return Math.hypot(pos.x, pos.z) > resetDist;
}

export function pickAiSpawn(radius = FACTORY_DEFAULTS.spawnRadius, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const r = radius * (0.4 + rng() * 0.6);
  return {
    position: { x: Math.cos(angle) * r, y: 0, z: Math.sin(angle) * r },
    yaw: rng() * Math.PI * 2,
  };
}

// ------------------------------------------------------------------
// Demo AI factory (same API surface, simplified internals)
// ------------------------------------------------------------------

/**
 * Create a demo AI ship. Wires the pure brain to a live ship.
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene — required.
 * @param {Array}      cfg.asteroids — required.
 * @param {object?}    cfg.weapon — duck-typed `{ fire(opts) }`.
 * @param {function?}  cfg.getPowerupPos — () => { x, z } | null
 * @param {function?}  cfg.getPowerupVel — () => { x, z }
 * @param {function?}  cfg.getActiveWeapon — () => 'bullet' | 'laser'
 * @param {object?}    cfg.options — per-AI overrides:
 *     - resetDist, spawnRadius (factory-only, not in AI_TUNABLES)
 *     - shipFactory, rng (test seam)
 *     - any brain tunable (overrides AI_TUNABLES for this AI)
 */
export function createDemoAi({
  scene,
  asteroids,
  weapon = null,
  getPowerupPos = null,
  getPowerupVel = null,
  getActiveWeapon = null,
  options = {},
} = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...FACTORY_DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;

  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = opts.spawnYaw;

  let time = 0;
  let enabled = true;
  let lastMode = 'idle';
  let lastDecision = {
    mode: 'idle',
    yaw: 0,
    thrust: false,
    fire: false,
    reason: 'not yet ticked',
    activeWeapon: 'bullet',
    target: null,
    predictedPos: null,
    nearest: null,
    threatsCount: 0,
  };

  function spawn() {
    const sp = pickAiSpawn(opts.spawnRadius, rng);
    ship.reset(sp.position);
    ship.rotation.yaw = opts.spawnYaw;
  }

  function brainArgsFromShip() {
    return {
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      asteroids,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      powerupVel: getPowerupVel ? getPowerupVel() : { x: 0, z: 0 },
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
    const decision = aiBrainTick(args);
    lastMode = decision.mode;

    // Build the debug-overlay-friendly snapshot (target + predictedPos
    // + nearest + threatsCount). Kept identical to the previous
    // API surface so the debug overlay continues to render.
    const snap = evaluatePerception(args);
    const nearest = snap.nearestAst;
    let target = null;
    if (decision.mode === 'powerup' && snap.nearestPw) {
      target = { pos: snap.nearestPw.pos, mode: 'powerup', dist: snap.nearestPw.dist };
    } else if ((decision.mode === 'asteroid' || decision.mode === 'evade') && nearest) {
      target = { pos: nearest.pos, mode: 'asteroid', dist: nearest.dist };
    }
    let predictedPos = null;
    if (target && target.mode === 'asteroid') {
      predictedPos = predictAsteroidPosition(nearest.item, args.aiPos, args.bulletSpeed);
    } else if (target && target.mode === 'powerup') {
      predictedPos = predictPosition(snap.nearestPw, args.aiPos, args.bulletSpeed);
    }
    let threatsCount = 0;
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      const d = Math.hypot(p.x - ship.position.x, p.z - ship.position.z);
      if (d < args.evadeDist) threatsCount += 1;
    }

    lastDecision = {
      mode: decision.mode,
      yaw: decision.yaw,
      thrust: decision.thrust,
      fire: decision.fire,
      reason: decision.reason || '',
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
      target: target ? { pos: { ...target.pos }, mode: target.mode, dist: target.dist } : null,
      predictedPos: predictedPos ? { ...predictedPos } : null,
      nearest: nearest
        ? { pos: { x: nearest.dx + ship.position.x, z: nearest.dz + ship.position.z }, dist: nearest.dist }
        : null,
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
    getMode: () => aiBrainTick(brainArgsFromShip()).mode,
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
      predictedPos: lastDecision.predictedPos
        ? Object.freeze({ ...lastDecision.predictedPos })
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
