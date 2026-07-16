/**
 * Demo / Pirate AI — v0.55.0 + v0.56.0.
 *
 * The brain is intentionally small. The whole game boils down to
 * five questions:
 *
 *   1. Is anything about to kill me?         → EVADE   (thrust perpendicular)
 *   2. Is there an attackable ship in range?→ PIRATE  (predict + steer + fire)
 *   3. Is there a powerup in range?         → COLLECT (predict + steer; coast-in)
 *   4. Is there an asteroid in range?       → ENGAGE  (predict + steer; fire)
 *   5. Nothing in range?                    → IDLE    (do nothing)
 *
 * v0.56.0 added the PIRATE behavior — the FIRST extension of the
 * registry this design was built for. Pirate AI is the foundation
 * for the future "pirate mode" (combat between AI ships + the
 * player ship). Future extensions (station landing, formation
 * flight, etc.) follow the same shape.
 *
 * Architecture
 * ------------
 *   1. Pure helpers (`facingAngle`, `wrapAngle`, `predictPosition`,
 *      `isTargetInFront`) — universal across any moving target.
 *   2. `evaluatePerception(args)` — turns raw world state into a
 *      snapshot `{ nearestAst, nearestPw, nearestShip }`. Add new
 *      fields here when new target types appear.
 *   3. `BEHAVIORS` — open-ended, priority-ordered registry. Each
 *      entry: `{ name, run(snap, args) }` returning a decision or
 *      null. Inserting a behavior at a priority slot is the ONLY
 *      change needed to add a new AI mode.
 *   4. `aiBrainTick(args)` — pure decision mapper. Calls perception,
 *      walks BEHAVIORS in order, returns the first non-null decision
 *      with `fire` set by the independent fire loop.
 *
 * Fire is decoupled from chase target. The ship can shoot any in-cone
 * target (asteroid OR ship). Pirate AI shoots ships; demo AI shoots
 * asteroids — same fire loop.
 *
 * Aggression is per-AI, controlled by the factory option
 * `aggroDist`. Set `aggroDist: 0` for pacifist AIs (the demo AI),
 * `aggroDist: 300` for aggressive AIs (pirates). Reads
 * `AI_TUNABLES.aggroDist` as the live fallback so the tuner panel
 * can adjust at runtime.
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
 *   - 13 of 22 AI_TUNABLES → purged.
 *
 * v0.56.0 ADDITIONS
 * ------------------
 *   - `evaluatePerception` adds `nearestShip` (from `args.ships`,
 *     duck-typed on `ship.position` / `ship.velocity`).
 *   - `BEHAVIORS = [evade, pirate, collect, engage, idle]`.
 *   - `evaluateFire` scans `args.ships` IN ADDITION to asteroids
 *     (universal in-cone + in-range check).
 *   - `aiBrainTick` accepts `aggroDist = AI_TUNABLES.aggroDist`.
 *   - `createDemoAi` factory accepts `getShips` callback for the
 *     perception layer; `options.aggroDist` overrides the live bag
 *     for this AI's pirate aggressiveness.
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
  /**
   * Default aggro distance for the pirate behavior (world units).
   * Factory callers override per-AI via `options.aggroDist`.
   * 0 = pacifist (the pirate behavior never fires — demo AI default).
   * 300 = aggressive (pirates chase + shoot any ship within 300u).
   */
  aggroDist: 0,
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
 * Wrap an angle into (-π, π].
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
 * powerups, ships. For targets with `vel.x === vel.z === 0`,
 * collapses to the current position.
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
 * `.getPosition()` for duck-typed asteroid-like objects; pass an
 * alternative for live-property targets (e.g. `s => s.position`
 * for ships where `position` is a live object reference).
 */
function findNearest(pos, items, getPos) {
  const getter = getPos || ((i) => i && i.getPosition && i.getPosition());
  let best = null;
  let bestDist = Infinity;
  for (const item of items) {
    if (!item) continue;
    const p = getter(item);
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
 * Compute heading error to a target position (radians, (-π, π]).
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
 * asteroid-like duck-typed object (must have `getPosition()` and
 * optionally `getVelocity()`).
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

/**
 * Ship-target prediction helper. Reads from a live ship object
 * (ship.position, ship.velocity) instead of asteroid-like methods.
 * Ships in this codebase don't expose `getPosition()` — position is
 * a direct property on the ship object.
 */
function predictShipPosition(ship, aiPos, bulletSpeed) {
  if (!ship || !ship.position || typeof ship.position.x !== 'number') return null;
  return predictPosition(
    { pos: ship.position, vel: ship.velocity || { x: 0, z: 0 } },
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
 * PIRATE behavior (v0.56.0): nearest ship within aggroDist →
 * predict at bullet flight + steer. The chase target type is 'ship',
 * but the universal `predictPosition` + `steerTo` helpers handle
 * every detail. Distinguishes from ENGAGE only by target type —
 * visible in the AI debug overlay as `mode: 'pirate'`.
 *
 * Per-AI aggression is controlled by `aggroDist`:
 *   - `aggroDist: 0` (demo AI default): never engages — the
 *     predicate `a.dist >= args.aggroDist` is always true → null.
 *   - `aggroDist: 300` (pirate default): chases + shoots any ship
 *     within 300u.
 */
function pirateBehavior(snap, args) {
  if (!snap.nearestShip || snap.nearestShip.dist >= args.aggroDist) return null;
  const s = snap.nearestShip;
  const predicted = predictShipPosition(s.item, args.aiPos, args.bulletSpeed);
  if (!predicted) return null;
  const steer = steerTo(args, predicted);
  return {
    yaw: steer.yaw,
    thrust: steer.thrust,
    mode: 'pirate',
    reason: `pirate target ${s.dist.toFixed(1)}u`,
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

// Priority order:
//   1. EVADE   — immediate threat to survival
//   2. PIRATE  — aggressive ships target other ships
//   3. COLLECT — per user spec, "priority to collect"
//   4. ENGAGE  — fallback for asteroids
//   5. IDLE    — no behavior matched
const BEHAVIORS = [
  { name: 'evade', run: evadeBehavior },
  { name: 'pirate', run: pirateBehavior },
  { name: 'collect', run: collectBehavior },
  { name: 'engage', run: engageBehavior },
  { name: 'idle', run: idleBehavior },
];

// ------------------------------------------------------------------
// Perception (snapshot of the world for the behavior layer)
// ------------------------------------------------------------------

/**
 * Evaluate perception — nearest asteroid, nearest powerup, nearest
 * ship. Returns a snapshot the behaviors read. Ship duck-typing is
 * live-property (`s.position` is an object ref) instead of the
 * asteroid-style `getPosition()` method.
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
  // Ships: live-property duck-typing (s.position is a ref, not a method).
  const nearestShip = findNearest(args.aiPos, args.ships || [], (s) => s.position);
  return { nearestAst, nearestPw, nearestShip };
}

// ------------------------------------------------------------------
// Fire loop (independent of chase target, scans asteroids AND ships)
// ------------------------------------------------------------------

/**
 * Decide whether the AI should fire this tick. Universal in-cone +
 * in-range check across every target type (asteroids + ships).
 * Independent of chase target so the ship can shoot while chasing.
 */
function evaluateFire(args) {
  // Asteroids (asteroid-like duck typing: getPosition + getVelocity).
  for (const a of args.asteroids || []) {
    if (!a || typeof a.getPosition !== 'function') continue;
    const predicted = predictAsteroidPosition(a, args.aiPos, args.bulletSpeed);
    if (!predicted) continue;
    const d = Math.hypot(predicted.x - args.aiPos.x, predicted.z - args.aiPos.z);
    if (d < args.fireMinDist || d > args.fireMaxDist) continue;
    if (isTargetInFront(args.aiPos, args.aiYaw, predicted, args.fireHeadingGate)) {
      return true;
    }
  }
  // Ships (live-property duck typing: position + velocity).
  for (const s of args.ships || []) {
    if (!s || !s.position) continue;
    const predicted = predictShipPosition(s, args.aiPos, args.bulletSpeed);
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
 * @param {Array?} args.ships     — optional, list of live ships (v0.56.0)
 * @param {{x,z}?} args.powerupPos — optional
 * @param {{x,z}?} args.powerupVel — optional
 * @param {number} args.evadeDist, args.aggroDist, args.powerupMaxChaseDist,
 *               args.thrustHeadingGate, args.yawDeadband,
 *               args.fireHeadingGate, args.fireMinDist, args.fireMaxDist,
 *               args.bulletSpeed — optional; fall through to AI_TUNABLES
 * @returns {{ yaw, thrust, mode, fire, reason }}
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  asteroids,
  ships = [],
  powerupPos = null,
  powerupVel = null,
  evadeDist = AI_TUNABLES.evadeDist,
  aggroDist = AI_TUNABLES.aggroDist,
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
  if (ships && !Array.isArray(ships)) {
    throw new Error('aiBrainTick: ships must be an array');
  }

  const args = {
    aiPos, aiYaw, asteroids, ships,
    powerupPos, powerupVel,
    evadeDist, aggroDist, powerupMaxChaseDist,
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
// Demo AI / Pirate AI factory (same API surface, pirate role via
// `options.aggroDist > 0`)
// ------------------------------------------------------------------

/**
 * Create an AI ship. The role (demo vs pirate) is selected via
 * `options.aggroDist` — pirates set it to a positive value (300 by
 * default in AI_TUNABLES) so the pirate behavior fires; demo AIs
 * leave it at 0 (default) so pirate never activates.
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene — required.
 * @param {Array}      cfg.asteroids — required.
 * @param {object?}    cfg.weapon — duck-typed `{ fire(opts) }`.
 * @param {function?}  cfg.getPowerupPos — () => { x, z } | null
 * @param {function?}  cfg.getPowerupVel — () => { x, z }
 * @param {function?}  cfg.getActiveWeapon — () => 'bullet' | 'laser'
 * @param {function?}  cfg.getShips — () => ship[] (v0.56.0). Each ship
 *                  must have live `.position` and `.velocity`.
 * @param {object?}    cfg.options — per-AI overrides:
 *     - resetDist, spawnRadius (factory-only, not in AI_TUNABLES)
 *     - aggroDist (0 for demo, 300 for pirate — overrides AI_TUNABLES)
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
  getShips = null,
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
  let disposed = false;
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
      ships: getShips ? getShips() : [],
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      powerupVel: getPowerupVel ? getPowerupVel() : { x: 0, z: 0 },
      activeWeapon: getActiveWeapon ? getActiveWeapon() : 'bullet',
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

    // Build the debug-overlay-friendly snapshot.
    const snap = evaluatePerception(args);
    const nearest = snap.nearestAst;
    let target = null;
    if (decision.mode === 'powerup' && snap.nearestPw) {
      target = { pos: snap.nearestPw.pos, mode: 'powerup', dist: snap.nearestPw.dist };
    } else if ((decision.mode === 'asteroid' || decision.mode === 'evade') && nearest) {
      target = { pos: nearest.pos, mode: 'asteroid', dist: nearest.dist };
    } else if (decision.mode === 'pirate' && snap.nearestShip) {
      const s = snap.nearestShip;
      target = { pos: s.pos, mode: 'ship', dist: s.dist };
    }
    let predictedPos = null;
    if (target && target.mode === 'asteroid') {
      predictedPos = predictAsteroidPosition(nearest.item, args.aiPos, args.bulletSpeed);
    } else if (target && target.mode === 'powerup') {
      predictedPos = predictPosition(snap.nearestPw, args.aiPos, args.bulletSpeed);
    } else if (target && target.mode === 'ship') {
      predictedPos = predictShipPosition(snap.nearestShip.item, args.aiPos, args.bulletSpeed);
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
    disposed = true;
    if (typeof ship.dispose === 'function') {
      ship.dispose();
    } else if (ship.mesh && scene.children.includes(ship.mesh)) {
      scene.remove(ship.mesh);
    }
  }

  /**
   * v0.60.0: has this AI been disposed? Cross-targeting pirates
   * (pirate1's `getShips` includes pirate2) need to filter out
   * dead pirates so their bullets keep firing at the survivors.
   * Without this guard a disposed pirate's stale ship object would
   * still pass the `position` null-check (it's still a valid
   * `{x,y,z}` reference, just no longer in the scene).
   */
  function isAlive() {
    return !disposed;
  }

  return {
    update,
    dispose,
    getShip: () => ship,
    isAlive,
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
