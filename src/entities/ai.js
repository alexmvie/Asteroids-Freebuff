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
   */
  targetDist: 100,

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
   * reflex, no predictive kinematics. Default 6u = roughly the
   * ship's own radius (the smallest meaningful "I'm about to die"
   * window). Reduce for tighter panic-window; raise for more
   * aggressive flight through denser fields.
   */
  panicDist: 6,

  /**
   * Half-angle of the fire cone (radians). Fire:true when any
   * asteroid appears within this cone relative to the ship's
   * facing direction. Default 0.35 rad ≈ 20°. Matches the legacy
   * default from v0.11.x.
   */
  fireConeHalfAngle: 0.35,
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
 * Pure: the single-mode chase controller. Turn toward target, thrust
 * when aligned. No BRAKE branch (no closing-speed throttle), no
 * Spin-Brake sub-phase (no inertia-opposing yaw). The ship's
 * `YAW_INERTIA_TAU=0.2` does the natural settling via angular
 * momentum — the brain stays out of the loop's way.
 *
 * Deadbands are small (±0.15 yaw, ±0.30 thrust) so the ship commits
 * to a heading and stays there. With no algorithmic correction of
 * inertia, a tight deadband would chatter across the alignment edge
 * (the legacy SPIN-BRAKE was designed to fix exactly this); without
 * a BRAKE branch, the ship just rolls past alignment under inertia
 * and the brain settles it on the next frame. The deadband is sized
 * to absorb the natural overshoot and not stutter.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} targetPos
 * @returns {{ dist: number, yaw: number, thrust: boolean, diff: number }}
 */
export function engageController(aiPos, aiYaw, targetPos) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // On top of (or inside) the target — pickup radius absorbs.
    return { dist: 0, yaw: 0, thrust: false, diff: 0 };
  }
  const targetAngle = Math.atan2(dz, dx);
  const diff = wrapAngle(targetAngle - facingAngle(aiYaw));
  const yaw = diff > 0.15 ? -1 : diff < -0.15 ? 1 : 0;
  const thrust = Math.abs(diff) < 0.30;
  return { dist, yaw, thrust, diff };
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
  asteroids,
  time, // kept for API parity with prior versions; not used internally anymore
  powerupPos = null,
  targetDist = DEFAULTS.targetDist,
  powerupBiasU = DEFAULTS.powerupBiasU,
  panicDist = DEFAULTS.panicDist,
  fireConeHalfAngle = DEFAULTS.fireConeHalfAngle,
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
    const ec = engageController(aiPos, aiYaw, target.pos);
    let fire = false;
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      if (isTargetInFront(aiPos, aiYaw, p, fireConeHalfAngle)) {
        fire = true;
        break;
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
export function createDemoAi({ scene, asteroids, weapon = null, getPowerupPos = null, options = {} } = {}) {
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
      asteroids,
      powerupPos: getPowerupPos ? getPowerupPos() : null,
      targetDist: opts.targetDist,
      powerupBiasU: opts.powerupBiasU,
      panicDist: opts.panicDist,
      fireConeHalfAngle: opts.fireConeHalfAngle,
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
