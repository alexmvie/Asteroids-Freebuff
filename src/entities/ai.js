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
   *
   * v0.21.x — `Infinity` (was 300 in v0.21.0). The user reported
   * "egal wie weit Asteroiden entfernt sind, der nächstgelegene
   * ist zu attackieren". With Infinity, the only IDLE condition
   * is `asteroids === []` (an empty streaming buffer, e.g., at
   * session-start before the first chunk loads). At any time the
   * bubble contains ≥1 asteroid, the bot engages it — no range cap.
   * For tests, finite targetDist values still work (the predicate
   * is `nearest.dist < targetDist`, so smaller overrides reduce
   * the chase range as expected).
   */
  targetDist: Infinity,

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
   * reflex, no predictive kinematics. Default 6u.
   *
   * The trigger condition is `nearest.dist < panicDist`, so a
   * SMALLER panicDist yields FEWER dodge triggers (more committed
   * chase), a LARGER panicDist yields MORE triggers (more reactive).
   * 6u is the sweet spot: tight enough that 3–5u grazing-passes
   * don't trigger spurious dodge bursts, wide enough that head-on
   * collisions (≤4u) still get a panic-reflex.
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

// engageController deadband constants. Lifted to module scope so the
// BRAKE and APPROACH branches use the same steering tolerance and the
// thrust-on rules are namespaced — future tuning changes happen in
// one place rather than across two branches.
const YAW_DEADBAND = 0.15;             // both branches: yaw=±1 outside; yaw=0 inside
const APPROACH_THRUST_GATE = 0.30;     // APPROACH: thrust on when |targetDiff| < this AND closing slower than desired
const BRAKE_THRUST_GATE = Math.PI - 0.30;  // BRAKE: thrust on when facing ≤162° away from brake direction (avoid thrust-forward)

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
 * Pure: the chase controller. v0.21.x adds a BRAKE branch for true
 * "bremsen, drehen, linear aufsammeln" piloting. The user observed
 * the bot flying in circles around powerups because the v0.20.x
 * engageController had no closing-speed throttle — the ship's
 * forward momentum carried it past the target in wide arcs.
 *
 * Three branches:
 *
 *   1. PICKUP  — at the target itself, no thrust, no yaw.
 *
 *   2. BRAKE   — ship has notable XZ speed (>4) AND the projected
 *                closing speed exceeds the desired approach speed.
 *                Rotate to the opposite-of-velocity direction and
 *                thrust backward to shed speed. The thrust deadband
 *                is LOOSE (±0.50) so the dump can fire during the
 *                rotation itself — without this, the ~0.785s yaw
 *                flip at YAW_SPEED=4 would be wasted (no deceleration).
 *                Enabled when `speed > 4` AND `closingSpeed >
 *                desiredClosing`. The speed>4 floor prevents
 *                micro-oscillation at low idle speed.
 *
 *   3. APPROACH — align with target and thrust. Thrust is gated on
 *                alignment (|targetDiff| < 0.30) AND closing speed
 *                not yet at the desired rate (closingSpeed <
 *                desiredClosing). The combined gate prevents the
 *                "turn AND thrust simultaneously sideways" pattern
 *                — you must commit to a heading before accelerating.
 *
 * The BRAKE → APPROACH transition creates an "emergent coasting"
 * phase: when BRAKE stops firing (closing speed dropped), the ship
 * is still rotated ~180° away from the target. APPROACH then fires
 * yaw=±1 with thrust=false (|targetDiff| > 0.30), giving a clean
 * drift-turn with LINEAR_DRAG shedding the remaining speed. Once
 * ±0.30 of the target, thrust engages and the ship closes in
 * linearly. This is exactly the user's "zu bremsen und einfach zu
 * drehen und dann linear aufzusammeln" intent, achieved with no
 * explicit state machine — just deadband physics + the lack of
 * v0.12.x anti-feathering layers that turned this into a wobble.
 *
 * Why no Spin-Brake sub-phase: v0.12.x's spin-brake was added to
 * dampen |aiAngularVelocity|>1.0 oscillations during approach.
 * In v0.21.x the residual overshoot at ±0.15 yaw deadband is well
 * within the YAW_INERTIA_TAU=0.2 angular time-constant (overshoot
 * ≈0.05 rad). The simpler two-branch controller is calmer than the
 * v0.12.x three-branch version once the predictive-DODGE /
 * mode-hysteresis / debouncer confounding layers are gone.
 *
 * @param {{x:number,z:number}} aiPos
 * @param {number} aiYaw
 * @param {{x:number,z:number}} targetPos
 * @param {{x:number,z:number}} aiVel  ship's current XZ velocity
 * @returns {{ dist: number, yaw: number, thrust: boolean, diff: number, closingSpeed: number, branch: 'pickup'|'brake'|'approach' }}
 */
export function engageController(aiPos, aiYaw, targetPos, aiVel) {
  const dx = targetPos.x - aiPos.x;
  const dz = targetPos.z - aiPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) {
    // On top of (or inside) the target — pickup radius absorbs.
    return { dist: 0, yaw: 0, thrust: false, diff: 0, closingSpeed: 0, branch: 'pickup' };
  }
  const speed = Math.hypot(aiVel.x, aiVel.z);
  // Project velocity onto the line-of-sight to the target. Positive
  // closing speed = approaching; negative = receding. dy/dt per
  // tick, signed for direction.
  const closingSpeed = (dx * aiVel.x + dz * aiVel.z) / dist;
  // desiredClosing = Math.max(8, Math.min(40, dist))
  //
  // Three-zone approach-speed profile that fixes the v0.12.x-era
  // "circling powerups" symptom while keeping long-range intercepts
  // visibly engaged (not perpetually braked, as `Math.min(15, dist)`
  // produced at v0.21.x):
  //   * dist ≤ 8   → cap at 8 u/s — tight coast-in regardless of
  //                  how close the pickup. Ship cannot overshoot a
  //                  5u pickup when cruise is 8 u/s.
  //   * 8 < dist ≤ 40 → cruise at dist/2 (linear scale). 12u → 6;
  //                  32u → 16. Cruise speed feels deliberate.
  //   * dist > 40  → cap at 40 u/s. The bot still closes 200u
  //                  targets at 40 u/s (visible motion), not 15 u/s
  //                  (paralyzed cruise). BRAKE fires only when
  //                  closing is materially above 40.
  // Result: BRAKE→APPROACH→linear coast-in. Ship arrives at the
  // pickup at the cruise cap (no overshoot), applies delta-v exactly.
  const desiredClosing = Math.max(8, Math.min(40, dist));

  // ---- BRAKE branch: high speed + closing too fast ----
  // Trim-speed before overshooting. Rotate to opposite-velocity
  // direction; thrust backward when facing into the brake
  // direction. The speed>4 floor prevents an idle-velocity
  // BRAKE/APPROACH oscillation (the very-low-speed regime is
  // handled cleanly by APPROACH).
  if (speed > 4 && closingSpeed > desiredClosing) {
    const velAngle = Math.atan2(aiVel.z, aiVel.x);
    const brakeAngle = wrapAngle(velAngle + Math.PI);
    const brakeDiff = wrapAngle(brakeAngle - facingAngle(aiYaw));
    // See module-scope constants for the math behind each gate. The
    // gate choice here is `BRAKE_THRUST_GATE ≈ 162°`: when the ship
    // faces within 162° of the brake direction, thrust fires; when
    // it's facing within 18° of the TARGET direction, thrust is off
    // (would accelerate forward, opposite of brake).
    return {
      dist,
      yaw: brakeDiff > YAW_DEADBAND ? -1 : brakeDiff < -YAW_DEADBAND ? 1 : 0,
      thrust: Math.abs(brakeDiff) < BRAKE_THRUST_GATE,
      diff: brakeDiff,
      closingSpeed,
      branch: 'brake',
    };
  }

  // ---- APPROACH branch: align + thrust when in range ----
  const targetAngle = Math.atan2(dz, dx);
  const targetDiff = wrapAngle(targetAngle - facingAngle(aiYaw));
  return {
    dist,
    yaw: targetDiff > YAW_DEADBAND ? -1 : targetDiff < -YAW_DEADBAND ? 1 : 0,
    // Thrust only when aligned (within deadband) AND not already
    // at desired closing speed. The combined gate prevents the
    // "thrust-sideways-while-turning" pattern that produces slides.
    thrust: Math.abs(targetDiff) < APPROACH_THRUST_GATE && closingSpeed < desiredClosing,
    diff: targetDiff,
    closingSpeed,
    branch: 'approach',
  };
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
  aiVel = { x: 0, z: 0 }, // v0.21.x — required for engageController's BRAKE branch (defaults to zero when omitted).
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
    const ec = engageController(aiPos, aiYaw, target.pos, aiVel);
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
      // v0.21.x — forward the ship's current XZ velocity so the
      // engageController can run its BRAKE branch. The XZ slice is
      // intentional: ship.js' `velocity` includes a 0 Y component
      // and the brain only needs the XZ plane.
      aiVel: { x: ship.velocity.x, z: ship.velocity.z },
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
