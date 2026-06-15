/**
 * Demo AI — an NPC ship that wanders, targets the nearest asteroid, and
 * dodges close threats. Uses the same ship look as the player (injected
 * via `shipFactory` so the same mesh + physics can be shared, and so
 * tests can swap in a mock ship).
 *
 * Behaviors (priority order, evaluated each tick):
 *
 *   1. DODGE   — if any asteroid is within `dodgeDist`, thrust perpendicular
 *                to escape (steer 90° from the threat, full thrust).
 *   2. TARGET  — if any asteroid is within `targetDist`, steer toward the
 *                nearest one, full thrust.
 *   3. WANDER  — no asteroids in range. Pick a random heading, full thrust;
 *                pick a new heading every `wanderTurnPeriod` seconds.
 *
 * The brain is a pure function (`aiBrainTick`) — it takes the ship's
 * current position + yaw, the live asteroid list, and a `time` clock, and
 * returns `{ yaw, thrust, mode }` where `yaw ∈ {-1, 0, +1}` and
 * `thrust ∈ {true, false}`. The factory wraps the brain, holds the
 * wander clock, drives the ship, and disposes the mesh on teardown.
 *
 * Infinite lives: the AI is decorative and never collides with the player.
 * The collision layer (`processCollisions`) only checks `demoAsteroids`
 * against the player ship; the AI ship is not a target.
 *
 * If the AI drifts too far from the world origin (e.g. chasing an asteroid
 * out of the local area), it resets to a fresh spawn position so the
 * player always has a visible NPC in the demo field.
 */

import { createShip } from './ship.js';

const DEFAULTS = Object.freeze({
  /** Dodges when any asteroid is within this many world units. */
  dodgeDist: 14,
  /** Targets the nearest asteroid when any are within this many units. */
  targetDist: 90,
  /** Seconds between random heading changes during WANDER. */
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
   * fire decision. The AI fires when the absolute angular difference
   * between the ship's facing and the target direction is less than
   * this value. ~0.35 rad ≈ 20° — a forgiving cone that rewards
   * aggressive pursuit without making the AI feel like a turret.
   */
  fireConeHalfAngle: 0.35,
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
 * `facingAngle = -π/2 - yaw (mod 2π)`. This helper centralizes the
 * conversion so the brain's steering + the `isTargetInFront` check
 * agree on which direction the ship is actually pointing.
 *
 * @param {number} yaw  radians (ship.js convention)
 * @returns {number}    radians in (-PI, PI], atan2(z, x) convention
 */
export function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/**
 * Find the nearest asteroid to a point. Returns `null` if the list is empty.
 * Each asteroid must expose `getPosition()` returning `{x,y,z}` (a live
 * Three.js Vector3 or a plain object). The caller can also use a mock
 * that returns `{x,z}` — the brain only reads `.x` and `.z`.
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
 * True if the given target position is in front of a ship at `aiPos`
 * facing `aiYaw`, within a half-angle cone of `halfAngle` radians.
 *
 * The ship's forward direction in world space (matching ship.js) is
 * `(-sin(yaw), 0, -cos(yaw))` in (x, z). The angle of that vector in
 * the (x, z) plane is `atan2(-cos(yaw), -sin(yaw))` — we centralize
 * that in `facingAngle(yaw)`. We compare it to the angle of the
 * target direction (from the ship to the target): `atan2(dz, dx)`.
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
  // Guard against zero-length target direction.
  if (dx === 0 && dz === 0) return false;
  const targetAngle = Math.atan2(dz, dx);
  const facing = facingAngle(aiYaw);
  const diff = Math.abs(wrapAngle(targetAngle - facing));
  return diff < halfAngle;
}

/**
 * Pure: decide what the AI should do this tick.
 *
 * Returns `{ yaw, thrust, mode, fire }` where:
 *   - `yaw`     ∈ {-1, 0, +1}  (steering; -1 = turn left, +1 = turn right)
 *   - `thrust`  boolean         (true = accelerate)
 *   - `mode`    'dodge' | 'target' | 'wander'
 *   - `fire`    boolean         (true when the target is roughly in
 *                                front of the ship — only in TARGET mode)
 *
 * @param {{
 *   aiPos: { x: number, z: number },
 *   aiYaw: number,                            // current yaw in radians
 *   asteroids: Array<{ getPosition: () => any }>,
 *   time: number,                             // seconds since boot (for wander clock)
 *   dodgeDist?: number,
 *   targetDist?: number,
 *   wanderTurnPeriod?: number,
 *   wanderHeading?: number | null,            // current wander target (radians); null = pick one
 *   wanderHeadingExpiresAt?: number,          // time at which to pick a new wander heading
 *   fireConeHalfAngle?: number,
 *   rng?: () => number,                       // injectable for tests; default Math.random
 * }} args
 */
export function aiBrainTick({
  aiPos,
  aiYaw,
  asteroids,
  time,
  dodgeDist = DEFAULTS.dodgeDist,
  targetDist = DEFAULTS.targetDist,
  wanderTurnPeriod = DEFAULTS.wanderTurnPeriod,
  wanderHeading = null,
  wanderHeadingExpiresAt = 0,
  fireConeHalfAngle = DEFAULTS.fireConeHalfAngle,
  rng = Math.random,
}) {
  if (!aiPos) throw new Error('aiBrainTick: aiPos is required');
  if (typeof aiYaw !== 'number') throw new Error('aiBrainTick: aiYaw must be a number');
  if (!Array.isArray(asteroids)) throw new Error('aiBrainTick: asteroids must be an array');

  const nearest = findNearestAsteroid(aiPos, asteroids);

  // ---- 1. DODGE (highest priority) -------------------------------------
  if (nearest && nearest.dist < dodgeDist) {
    // Steer 90° counter-clockwise from the threat direction (in the
    // (x, z) atan2 frame), so the ship thrusts perpendicular to the
    // threat and escapes out the port (left) side. The diff is in
    // the atan2 frame — we compare the ship's ACTUAL facing
    // direction (facingAngle(yaw) = atan2(-cos(yaw), -sin(yaw))) to
    // the escape direction. Comparing to `yaw` directly would be
    // off by a 90° offset, because yaw=0 means the ship faces -Z,
    // not 0. See `facingAngle` for the math.
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

  // ---- 2. TARGET (middle priority) ------------------------------------
  if (nearest && nearest.dist < targetDist) {
    // Steer toward the nearest asteroid. The angle to the target from
    // our position is atan2(dz, dx) in the (x, z) plane. Our facing
    // angle in the SAME plane is `facingAngle(aiYaw)`. The signed
    // shortest rotation from facing to target is the steering.
    //
    // The brain returns `yaw: +1` to mean "turn right" — the ship
    // applies that as `yaw += YAW_SPEED * dt`, which makes the facing
    // angle in atan2 space DECREASE (yaw and facing are anti-
    // correlated). So the diff sign flips:
    //   diff > 0  → target is to the right of facing → yaw: -1
    //   diff < 0  → target is to the left of facing  → yaw: +1
    // which is the opposite sign of the (wrong) `aiYaw`-based diff
    // the older code used.
    const targetAngle = Math.atan2(nearest.dz, nearest.dx);
    const diff = wrapAngle(targetAngle - facingAngle(aiYaw));
    // Fire when the target is roughly in front (within the cone).
    // isTargetInFront reads the asteroid's *current* world position
    // (so a fast-moving target can dodge the AI's aim — same as the
    // player trying to lead a moving target).
    const targetPos = nearest.asteroid.getPosition();
    const fire = isTargetInFront(aiPos, aiYaw, targetPos, fireConeHalfAngle);
    return {
      yaw: diff > 0.1 ? -1 : diff < -0.1 ? 1 : 0,
      thrust: true,
      mode: 'target',
      fire,
    };
  }

  // ---- 3. WANDER (default) --------------------------------------------
  // Pick (or refresh) a wander heading. We always emit yaw + thrust on
  // a wander tick — the factory decides whether to commit a heading
  // change by mutating `wanderHeading` / `wanderHeadingExpiresAt`. The
  // heading is an angle in the (x, z) atan2 frame, so we compare it
  // to the ship's actual facing direction, not to `yaw` directly.
  let heading = wanderHeading;
  let expiresAt = wanderHeadingExpiresAt;
  if (heading === null || time >= expiresAt) {
    // New heading: a random angle in (-PI, PI].
    heading = (rng() * 2 - 1) * Math.PI;
    expiresAt = time + wanderTurnPeriod;
  }
  const diff = wrapAngle(heading - facingAngle(aiYaw));
  return {
    yaw: diff > 0.1 ? -1 : diff < -0.1 ? 1 : 0,
    thrust: true,
    mode: 'wander',
    fire: false,
    // Side-channel: the factory reads these to maintain wander state.
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
 * Build a random spawn position within `radius` of the origin (XZ plane).
 * Pure.
 *
 * @param {number} radius
 * @param {() => number} [rng]
 * @returns {{ position: {x:number,y:number,z:number}, yaw: number }}
 */
export function pickAiSpawn(radius = DEFAULTS.spawnRadius, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const r = radius * (0.4 + rng() * 0.6); // 0.4–1.0 × radius, so the AI isn't always at the edge
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
 *   weapon?: { fire: (opts: any) => number | boolean } | null,  // duck-typed weapon (laser or bullets)
 *   options?: {
 *     dodgeDist?: number,
 *     targetDist?: number,
 *     wanderTurnPeriod?: number,
 *     resetDist?: number,
 *     spawnRadius?: number,
 *     fireConeHalfAngle?: number,
 *     shipFactory?: (opts: { scene: import('three').Scene, position: {x:number,y:number,z:number} }) => any,
 *     rng?: () => number,
 *   },
 * }} opts
 */
export function createDemoAi({ scene, asteroids, weapon = null, options = {} } = {}) {
  if (!scene) throw new Error('createDemoAi: `scene` is required');
  if (!Array.isArray(asteroids)) throw new Error('createDemoAi: `asteroids` must be an array');

  const opts = { ...DEFAULTS, ...options };
  const rng = opts.rng || Math.random;
  const shipFactory = opts.shipFactory || createShip;

  // ---- Initial spawn ---------------------------------------------------
  const initial = pickAiSpawn(opts.spawnRadius, rng);
  const ship = shipFactory({ scene, position: initial.position });
  ship.rotation.yaw = initial.yaw;

  // ---- Wander state (mutable, private) --------------------------------
  // `wanderHeading` is in the (x, z) atan2 frame, NOT the ship's yaw
  // space. The brain's WANDER branch compares `heading - facingAngle(
  // aiYaw)`, and `facingAngle` returns an atan2 angle. We start with
  // `null` and let the brain pick a fresh heading in atan2 space on
  // the first tick (the `time >= expiresAt` check below — time is 0
  // before the first `update(dt)`, but the brain reads `time` after
  // the factory's `time += dt`, so it's strictly > 0).
  let wanderHeading = null;
  let wanderHeadingExpiresAt = 0;
  let time = 0;

  // ---- Per-tick --------------------------------------------------------
  // When paused (enabled = false), the AI is a no-op — no movement,
  // no shooting, no brain activity. Used to pause the AI outside of
  // DEMO (see Phase 5: state-driven lifecycle).
  let enabled = true;

  function update(dt) {
    if (dt <= 0) return;
    if (!enabled) return;
    time += dt;

    // Reset if too far from origin
    if (shouldResetAi(ship.position, opts.resetDist)) {
      const spawn = pickAiSpawn(opts.spawnRadius, rng);
      ship.reset(spawn.position);
      ship.rotation.yaw = spawn.yaw;
      // Clear the wander heading so the brain picks a fresh one in
      // atan2 space on the next tick (see the init comment for why
      // we don't seed it from the ship's yaw).
      wanderHeading = null;
      wanderHeadingExpiresAt = 0;
    }

    // Decide what to do
    const decision = aiBrainTick({
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      asteroids,
      time,
      dodgeDist: opts.dodgeDist,
      targetDist: opts.targetDist,
      wanderTurnPeriod: opts.wanderTurnPeriod,
      fireConeHalfAngle: opts.fireConeHalfAngle,
      wanderHeading,
      wanderHeadingExpiresAt,
      rng,
    });

    // Commit wander state changes (side-channel from brain)
    if (decision._wanderHeading !== undefined) {
      wanderHeading = decision._wanderHeading;
    }
    if (decision._wanderHeadingExpiresAt !== undefined) {
      wanderHeadingExpiresAt = decision._wanderHeadingExpiresAt;
    }

    ship.setYaw(decision.yaw);
    ship.setThrust(decision.thrust);
    ship.update(dt);

    // Fire when the brain says the target is in front. The `weapon`
    // is duck-typed (just needs `.fire({ origin, direction, asteroids? })`)
    // so the caller can route through a bullet pool, a laser weapon,
    // or a smart "use laser if active else bullets" wrapper. The
    // weapon / pool handles its own cooldown (most per-frame calls
    // are rejected when the pool is on cooldown). The AI's effective
    // fire rate matches the player's: ~5.5 shots/sec for bullets,
    // 12.5 pulses/sec for the laser.
    if (decision.fire && weapon && typeof weapon.fire === 'function') {
      const yaw = ship.rotation.yaw;
      weapon.fire({
        origin: ship.position,
        direction: { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) },
        // The AI passes the asteroid list so the laser can raycast
        // for piercing hits. The bullet pool ignores it.
        asteroids,
      });
    }
  }

  function dispose() {
    // Reuse the ship's own dispose semantics if available; otherwise
    // remove the mesh from the scene.
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
    /** Pause or resume the AI. When paused, update() is a no-op. */
    setEnabled: (v) => { enabled = !!v; },
    isEnabled: () => enabled,
    /** Exposed for tests / dev tooling. */
    getMode: () => aiBrainTick({
      aiPos: ship.position,
      aiYaw: ship.rotation.yaw,
      asteroids,
      time,
      dodgeDist: opts.dodgeDist,
      targetDist: opts.targetDist,
      wanderTurnPeriod: opts.wanderTurnPeriod,
      fireConeHalfAngle: opts.fireConeHalfAngle,
      wanderHeading,
      wanderHeadingExpiresAt,
      rng,
    }).mode,
  };
}
