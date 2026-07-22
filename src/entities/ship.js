import {
  Group,
  Mesh,
  MeshStandardMaterial,
  ConeGeometry,
  BoxGeometry,
  Color,
  Box3,
  Vector3,
} from 'three';

import {
  THRUST_ACCEL,
  MAX_SPEED,
  LINEAR_DRAG,
  YAW_SPEED,
  ROLL_MAX,
  ROLL_DAMP,
  YAW_INERTIA_TAU,
  MAX_ENERGY,
  ENERGY_RECHARGE_PER_SEC,
  BUFF_DEFAULT_DURATIONS_S,
  SPAWN_SHIELD_DURATION_S,
} from './ship-constants.js';
// PLAY_PLANE_Y is owned by the world data-model layer (the play plane
// is a world concept, not a ship concept). See ../world/chunk-constants.js.
import { PLAY_PLANE_Y } from '../world/chunk-constants.js';
// v0.49.0: live-tunable ship max-speed. The panel writes
// `AI_TUNABLES.shipMaxSpeed`; the ship read falls back to the
// frozen `MAX_SPEED` constant if the bag is absent or the value
// is non-finite.
import { AI_TUNABLES } from './ai-tunables.js';

/**
 * Ship entity — a self-contained 3D ship with a 2DOF controller.
 *
 * Flight model:
 *   - `2dof` (default): yaw + thrust on the XZ plane; Y is locked to 0.
 *   - `6dof`: planned. The seam exists; the implementation throws so that
 *     any premature call is loud. Adding pitch/roll/full 3D motion will
 *     not require a refactor of consumers (setFlightMode / update).
 *
 * Public API:
 *   - `ship.mesh`               Three.js Group (faceted body + wings + glow)
 *   - `ship.position`           live {x, y, z} object (mutated each frame)
 *   - `ship.velocity`           live {x, y, z} object
 *   - `ship.rotation`           live {yaw, pitch, roll} in radians
 *   - `ship.flightMode`         '2dof' | '6dof' (read-only)
 *   - `ship.setThrust(boolean)`
 *   - `ship.setYaw(-1 | 0 | +1)`
 *   - `ship.setFlightMode('2dof' | '6dof')`
 *   - `ship.update(dt)`         advance physics; dt is seconds
 *   - `ship.reset(position?)`   snap back to a given world position
 *
 * @param {{ scene: import('three').Scene, position?: { x: number, y: number, z: number }, events?: import('../systems/events.js').EventBus }} opts
 */
export function createShip({ scene, position = { x: 0, y: 0, z: 0 }, events = null } = {}) {
  if (!scene) throw new Error('createShip: `scene` is required');

  // Tunables (THRUST_ACCEL, MAX_SPEED, LINEAR_DRAG, YAW_SPEED,
  // ROLL_MAX, ROLL_DAMP) are imported from ./ship-constants.js —
  // the single source of truth for ship physics. PLAY_PLANE_Y is
  // imported from ../world/chunk-constants.js (world owns it).
  // See src/scene/camera-constants.js for the matching camera tunables.

  // ---- Mesh assembly ---------------------------------------------------
  // Outer group: world position + yaw (the ship's facing).
  const group = new Group();
  group.position.set(position.x, position.y, position.z);

  // Inner body group: roll (the ship's "lean" around the forward axis).
  // The body, wings, and engine glow are children of the body group so
  // they all roll together. The outer group still controls yaw; the
  // two are decoupled so a lean doesn't change the ship's facing.
  // Scaling `body` triples the visual (mesh + glow) without
  // affecting the physics position, which is owned by the outer
  // `group` (the body scale is purely cosmetic — collisions and
  // camera follow the outer group, not the body).
  const body = new Group();
  body.scale.setScalar(3); // triple the visual size of mesh + glow
  group.add(body);

  // Body: 4-sided pyramid pointing forward (-Z). ConeGeometry's default tip
  // is +Y; rotateX(-PI/2) maps +Y → -Z.
  const bodyGeom = new ConeGeometry(1.0, 2.5, 4, 1);
  bodyGeom.rotateX(-Math.PI / 2);
  const bodyMat = new MeshStandardMaterial({
    color: 0xe6ecff,
    metalness: 0.3,
    roughness: 0.55,
    flatShading: true,
  });
  const bodyMesh = new Mesh(bodyGeom, bodyMat);
  // v0.68.0 -- body casts a shadow under the sun. also receives
  // shadows so other asteroids/projectiles project onto the hull.
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  body.add(bodyMesh);

  // Wings: two small angled boxes.
  const wingMat = new MeshStandardMaterial({
    color: 0x48dbfb,
    metalness: 0.4,
    roughness: 0.5,
    flatShading: true,
  });
  const wingGeom = new BoxGeometry(0.4, 0.2, 1.4);
  const wingL = new Mesh(wingGeom, wingMat);
  // v0.68.0 -- each wing casts + receives shadows.
  wingL.castShadow = true;
  wingL.receiveShadow = true;
  wingL.position.set(-0.95, -0.05, 0.15);
  wingL.rotation.z = Math.PI / 7;
  body.add(wingL);
  const wingR = new Mesh(wingGeom, wingMat);
  wingR.castShadow = true;
  wingR.receiveShadow = true;
  wingR.position.set(0.95, -0.05, 0.15);
  wingR.rotation.z = -Math.PI / 7;
  body.add(wingR);

  // Engine glow: a small inverted cone at the back, emissive material.
  // Tagged with `userData.isEngineGlow = true` so `loadShipModel` can
  // preserve it (the glow rolls with the ship's lean) while swapping
  // the cone body + wings for a GLB-loaded ship. The glow is an
  // additive overlay that looks correct on top of any ship model.
  //
  // Material: transparent by default, opacity 0 — the glow is only
  // visible when the thrust is on. `transparent: true` enables
  // per-frame alpha blending; `visible: false` (set in `update`)
  // skips the draw call entirely when the ship is idle. The
  // emissive color stays strong so the on-thrust glow is bright
  // cyan even at low opacity.
  const glowMat = new MeshStandardMaterial({
    color: 0x48dbfb,
    emissive: new Color(0x48dbfb),
    emissiveIntensity: 2.4, // peak intensity (only visible on thrust)
    transparent: true,      // allow per-frame opacity changes
    opacity: 0,             // invisible by default (toggled in update)
    depthWrite: false,      // don't occlude the model behind the glow
  });
  const glow = new Mesh(new ConeGeometry(0.35, 0.6, 8), glowMat);
  glow.rotation.x = Math.PI / 2; // tip points +Z (backward)
  glow.position.set(0, 0, 1.5);
  glow.userData.isEngineGlow = true;
  glow.visible = false;     // start hidden; update() toggles on thrust
  body.add(glow);

  scene.add(group);

  // ---- Mutable state (also exposed to consumers) ----------------------
  // v0.11.0: energy replaces the v0.10.x 3-lives mechanic. The ship
  // starts at MAX_ENERGY; hits deplete it; passive recharge restores it.
  // When `energy <= 0`, the ship dies (in GAME_OVER transition handler).
  // Buffs are a Map<type, expiresAt> — each entry means "this buff is
  // active until expiresAt seconds (game-time)". tickBuffs() decrements
  // per frame; addBuff(type) inserts with the configured duration;
  // removeBuff(type) drops the entry.
  const state = {
    position: { x: position.x, y: position.y, z: position.z },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0, roll: 0 }, // radians
    // Angular velocity (rad/s). Added in v0.8.0 to match the
    // trainer's env physics. The heading is now the integral of
    // this, not a direct command — the ship has actual angular
    // momentum. See YAW_INERTIA_TAU in ship-constants.js.
    angularVelocity: 0,
    // Energy (0..MAX_ENERGY). The damage sum plus regen decides life
    // or death.
    energy: MAX_ENERGY,
    // Active buffs (type → remaining seconds). Decayed each frame.
    /** @type {Map<string, number>} */
    buffs: new Map(),
  };

  // ---- Input (set by the input system; placeholder until it lands) ----
  let thrustOn = false;
  let yawInput = 0; // -1, 0, +1

  // ---- Public API -----------------------------------------------------
  function setThrust(on) {
    thrustOn = !!on;
  }

  function setYaw(direction) {
    yawInput = Math.max(-1, Math.min(1, direction));
  }

  function setFlightMode(mode) {
    if (mode !== '2dof' && mode !== '6dof') {
      throw new Error(`createShip: unknown flight mode "${mode}"`);
    }
    if (mode === '6dof') {
      // Planned. Don't silently no-op — make it loud.
      throw new Error('createShip: 6DOF flight is not implemented yet');
    }
    // No-op for '2dof'; no state needed (the getter hardcodes '2dof').
  }

  // ---- v0.11.0 Energy API ---------------------------------------------

  /**
   * Read the ship's current energy (in [0, MAX_ENERGY]). Used by the
   * HUD to draw the energy bar.
   * @returns {number}
   */
  function getEnergy() {
    return state.energy;
  }

  /**
   * Apply damage to the ship. Clamped to [0, MAX_ENERGY]. Returns the
   * new energy value. Callers may check isDead() after. Negative
   * inputs are clamped to 0 (heal is intentional via `addBuff`).
   * Emits `energy:changed` on the bus if `events` was supplied.
   * @param {number} amount
   * @returns {number} new energy
   */
  function takeDamage(amount) {
    const prev = state.energy;
    state.energy = Math.max(0, state.energy - Math.max(0, amount));
    if (events && state.energy !== prev) {
      events.emit('energy:changed', { value: state.energy, max: MAX_ENERGY });
    }
    return state.energy;
  }

  /**
   * Add (or replace) an active buff by type. Duration defaults to
   * BUFF_DEFAULT_DURATIONS_S[type] if not provided. The buff expires
   * after `duration` seconds.
   *
   * v0.11.0 supported buffs:
   *   - speed   — THRUST_ACCEL × 2
   *   - energy  — energyRechargeRate × 2 (passive regen multiplier)
   *   - credits — score × 2 (game-side multiplier for asteroid kills)
   *   - hull    — damage taken × 0.5
   *   - weapon  — fire rate × 2 (bullet cooldown halved)
   *
   * @param {'speed'|'energy'|'credits'|'hull'|'weapon'} type
   * @param {number} [duration]
   */
  function addBuff(type, duration) {
    const dur = typeof duration === 'number' && duration > 0
      ? duration
      : (BUFF_DEFAULT_DURATIONS_S[type] ?? 5);
    state.buffs.set(type, dur);
    if (events) {
      events.emit('buff:added', { type, duration: dur });
    }
  }

  /**
   * Remove an active buff immediately.
   * @param {string} type
   */
  function removeBuff(type) {
    state.buffs.delete(type);
  }

  /**
   * Read all currently active buffs as a plain { type, remaining }
   * array — for HUD rendering.
   * @returns {Array<{type:string, remaining:number}>}
   */
  function getActiveBuffs() {
    const out = [];
    for (const [type, remaining] of state.buffs.entries()) {
      out.push({ type, remaining });
    }
    return out;
  }

  /**
   * @returns {boolean} true iff the ship's energy has dropped to 0
   * (caller is responsible for triggering GAME_OVER / respawning).
   */
  function isDead() {
    return state.energy <= 0;
  }

  /**
   * v0.61.0 — Returns true while the shield buff is active. While
   * shielded, the player is invulnerable to all incoming damage
   * (from asteroids AND from pirate bullets). The buff decays via
   * the normal `update(dt)` tickbuffs path. Calling code in main.js
   * gates `takeDamage` + GAME_OVER transitions on `!isShielded()`.
   *
   * Lives next to `isDead` because the two are dual-purpose health
   * checks: isDead = energy fully depleted; isShielded = invulnerable
   * to next damage. Both are read by render-loop branches that have
   * to decide whether to apply a hit.
   *
   * @returns {boolean}
   */
  function isShielded() {
    return state.buffs.has('shield');
  }

  /**
   * v0.61.0 — Returns the shield buff's remaining duration in
   * seconds, or 0 if no shield buff is active. Used by main.js
   * to clip the HUD's `remaining` field when `activeType ===
   * 'shield'` so the bar never fills with the 15s active window
   * time after the 10s buff has expired (visually misleading).
   * Returns 0 for non-shield pickups too — the getter is safe to
   * call regardless of the active powerup type.
   *
   * @returns {number} seconds remaining (0 if no shield active)
   */
  function getShieldRemaining() {
    const v = state.buffs.get('shield');
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  /**
   * Read the hull-buff damage multiplier (1.0 if no hull buff;
   * 0.5 if hull is active).
   * @returns {number}
   */
  function getDamageMultiplier() {
    return state.buffs.has('hull') ? 0.5 : 1.0;
  }

  /**
   * Read the thrust multiplier (1.0 baseline; 2.0 if speed buff
   * is active).
   * @returns {number}
   */
  function getThrustMultiplier() {
    return state.buffs.has('speed') ? 2.0 : 1.0;
  }

  /**
   * Read the score multiplier (1.0 baseline; 2.0 if credits buff is active).
   * @returns {number}
   */
  function getScoreMultiplier() {
    return state.buffs.has('credits') ? 2.0 : 1.0;
  }

  /**
   * Advance physics. `dt` in seconds.
   * @param {number} dt
   */
  function update(dt) {
    if (dt <= 0) return;

    // ---- v0.11.0: passive energy recharge -----------------------------
    // Energy refills at ENERGY_RECHARGE_PER_SEC × (1 if no energy buff,
    // 2 if energy buff active). Capped at MAX_ENERGY. Stops at 0 (death).
    const energyBuffActive = state.buffs.has('energy');
    const rechargePerSec = ENERGY_RECHARGE_PER_SEC * (energyBuffActive ? 2 : 1);
    if (state.energy > 0 && state.energy < MAX_ENERGY) {
      const prev = state.energy;
      state.energy = Math.min(MAX_ENERGY, state.energy + rechargePerSec * dt);
      if (events && state.energy !== prev) {
        events.emit('energy:changed', { value: state.energy, max: MAX_ENERGY });
      }
    }

    // ---- v0.11.0: tick buffs (decrement timers, drop expired) ---------
    for (const [type, remaining] of state.buffs.entries()) {
      const next = remaining - dt;
      if (next <= 0) {
        state.buffs.delete(type);
        if (events) events.emit('buff:expired', { type });
      } else {
        state.buffs.set(type, next);
      }
    }

    // ---- 2DOF: yaw + XZ translation, Y locked -------------------------
    // Yaw (with angular momentum, mirrors the trainer's env so
    // trained brains feel identical to in-game ships). The angular
    // velocity ramps toward `yawInput * YAW_SPEED` with a first-
    // order time constant; the heading is the integral of
    // `angularVelocity`. YAW_INERTIA_TAU=0 falls back to the legacy
    // snap-to-target path.
    const targetAngularVel = yawInput * YAW_SPEED;
    if (YAW_INERTIA_TAU > 0) {
      const aT = 1 - Math.exp(-dt / YAW_INERTIA_TAU);
      state.angularVelocity += (targetAngularVel - state.angularVelocity) * aT;
    } else {
      state.angularVelocity = targetAngularVel;
    }
    state.rotation.yaw += state.angularVelocity * dt;

    // Roll (lean into the turn). The target roll is proportional to
    // the yaw input scaled to ROLL_MAX; the actual roll is damped
    // toward the target each frame so the lean eases in and out
    // smoothly. Sign: yawInput > 0 → targetRoll > 0 → positive Z
    // rotation, which tilts the left wing down (lean left).
    const targetRoll = yawInput * ROLL_MAX;
    const rollT = 1 - Math.exp(-ROLL_DAMP * dt);
    state.rotation.roll += (targetRoll - state.rotation.roll) * rollT;

    // Facing direction in the XZ plane. +Y rotation around Y axis means
    // forward (-Z) is at angle `yaw`: ( -sin(yaw), 0, -cos(yaw) ).
    const fwdX = -Math.sin(state.rotation.yaw);
    const fwdZ = -Math.cos(state.rotation.yaw);

    // Thrust (v0.11.0: speed buff doubles acceleration)
    const thrustMul = getThrustMultiplier();
    if (thrustOn) {
      state.velocity.x += fwdX * THRUST_ACCEL * thrustMul * dt;
      state.velocity.z += fwdZ * THRUST_ACCEL * thrustMul * dt;
    }

    // Drag (exponential decay, framerate-independent)
    const dragFactor = Math.exp(-LINEAR_DRAG * dt);
    state.velocity.x *= dragFactor;
    state.velocity.z *= dragFactor;

    // Speed cap (XZ plane only). v0.49.0: live-tunable via the
    // `AI_TUNABLES.shipMaxSpeed` slider in the tuner panel —
    // immediate per-frame effect with no app reload. The frozen
    // `MAX_SPEED` constant from ship-constants.js is the canonical
    // fallback used when the bag is missing or its value is
    // non-finite (defensive: a stale number from a buggy caller
    // would silently neuter the cap).
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    const liveMaxSpeed = (AI_TUNABLES && Number.isFinite(AI_TUNABLES.shipMaxSpeed))
      ? AI_TUNABLES.shipMaxSpeed
      : MAX_SPEED;
    if (speed > liveMaxSpeed) {
      const k = liveMaxSpeed / speed;
      state.velocity.x *= k;
      state.velocity.z *= k;
    }

    // Integrate position
    state.position.x += state.velocity.x * dt;
    state.position.z += state.velocity.z * dt;
    state.position.y = PLAY_PLANE_Y;

    // Push to mesh. The outer group has position + yaw only; the
    // inner body group has the roll (lean). This keeps the facing
    // decoupled from the lean, so a roll never changes the ship's
    // direction of travel.
    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.set(0, state.rotation.yaw, 0);
    body.rotation.set(0, 0, state.rotation.roll);

    // Engine glow: visible only on thrust, very transparent.
    // On thrust: visible + opacity 0.3 (subtle but visible) +
    //   bright emissive (2.4). Off thrust: hidden entirely so
    //   the player isn't distracted by a constant engine glow.
    // (Setting emissiveIntensity in the off branch is wasted —
    // `visible: false` skips the draw call entirely.)
    if (thrustOn) {
      glow.visible = true;
      glowMat.opacity = 0.3;
      glowMat.emissiveIntensity = 2.4;
    } else {
      glow.visible = false;
      glowMat.opacity = 0;
    }
  }

  function reset(p = { x: 0, y: 0, z: 0 }) {
    state.position.x = p.x;
    state.position.y = p.y;
    state.position.z = p.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.rotation.yaw = 0;
    state.rotation.pitch = 0;
    state.rotation.roll = 0;
    state.angularVelocity = 0; // v0.8.0: clear angular momentum on reset
    // v0.11.0: reset energy + buffs. (lives are gone) Emit
    // `buff:expired` for each cleared buff so bus listeners
    // (HUD/widgets) don't see buffs vanish silently; the buff
    // timers didn't tick down to 0 themselves, we cleared them.
    const clearedBuffs = Array.from(state.buffs.keys());
    // v0.69.1: capture any in-progress shield BEFORE state.buffs.clear().
    // v0.69.0 read AFTER clear(); Map was always empty so max(5, 0) = 5
    // silently shortened any 30s pickup shield to 5s on every respawn.
    const existingShield = state.buffs.get('shield');
    const preservedShieldS =
      Number.isFinite(existingShield) && existingShield > 0 ? existingShield : 0;
    state.energy = MAX_ENERGY;
    state.buffs.clear();
    if (events) {
      events.emit('energy:changed', { value: state.energy, max: MAX_ENERGY });
      for (const type of clearedBuffs) {
        events.emit('buff:expired', { type, reason: 'reset' });
      }
    }
    // v0.69.0 + v0.69.1 -- spawn-shield on every respawn. Closes the
    // "ich werde sofort wieder abgeschossen" gap. Applies to ALL reset
    // invocations (GAME_OVER, hit-survival, run-restart).
    //
    // **Honors any in-progress pickup shield** (v0.69.1 fix):
    // Math.max picks the larger of {SPAWN_SHIELD_DURATION_S=5, preservedShieldS}.
    // `existingShield` was captured BEFORE state.buffs.clear() above; preservedShieldS
    // is that captured value (or 0 if no shield was active). Net result:
    //   - fresh respawn (no shield active) -> 5s spawn shield,
    //   - mid-PLAYING respawn with 28s of 30s pickup still ticking -> still 28s,
    //   - respawn with 1s-expiring pickup -> bumped up to 5s.
    const spawnShieldDur = Math.max(SPAWN_SHIELD_DURATION_S, preservedShieldS);
    state.buffs.set('shield', spawnShieldDur);
    if (events) {
      events.emit('buff:added', {
        type: 'shield',
        duration: spawnShieldDur,
        reason: 'spawn',
      });
    }
    group.position.set(p.x, p.y, p.z);
    group.rotation.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
  }

  /**
   * Walk `body`'s children and dispose every geometry + material.
   * Skips children tagged with `userData.isEngineGlow = true` (the
   * engine glow is always present, even after a GLB swap). Idempotent.
   */
  function dispose() {
    if (!body) return;
    const toRemove = body.children.filter((c) => !c.userData?.isEngineGlow);
    for (const child of toRemove) {
      body.remove(child);
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        child.geometry.dispose();
      }
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
      }
      // Recurse for groups (the GLB root is a Group that contains
      // Meshes, which themselves own geometry + material).
      if (typeof child.traverse === 'function') {
        child.traverse((obj) => {
          if (obj !== child && obj.geometry && typeof obj.geometry.dispose === 'function') {
            obj.geometry.dispose();
          }
          if (obj !== child && obj.material) {
            const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of ms) {
              if (m && typeof m.dispose === 'function') m.dispose();
            }
          }
        });
      }
    }
  }

  return {
    mesh: group,
    body, // inner sub-group that holds the visual mesh; rolls for the lean
    position: state.position, // shared reference; live
    velocity: state.velocity, // shared reference; live
    rotation: state.rotation, // shared reference; live
    // Angular velocity (rad/s). Exposed as a getter in v0.11.0
    // so the trained brain's tick can see its own inertia live
    // (the brain's input feature 13 reads from this). Consumers
    // (main.js, ai.js) should pass `ship.angularVelocity` as
    // `aiAngularVelocity` to `brain.tick(args)`. The trainer's env
    // (`environment.js`) already exposes the same field via
    // `getState()` via a getter — same shape on both sides.
    // Previously a primitive snapshot, which silently went stale
    // on every `update(dt)` call.
    get angularVelocity() { return state.angularVelocity; },
    // v0.11.0: direct read-only handle on the energy level (avoids
    // forcing callers to call `getEnergy()`). Exposed via getter
    // so mutations from `takeDamage()` / `update(dt)` propagate
    // live — HUD polling reads the post-damage value, not a
    // frozen snapshot from object construction.
    get energy() { return state.energy; },
    buffs: state.buffs,
    get flightMode() { return '2dof'; }, // current implementation is 2DOF-only
    setThrust,
    setYaw,
    setFlightMode,
    update,
    reset,
    dispose,
    // v0.11.0 energy + buff API
    getEnergy,
    takeDamage,
    addBuff,
    removeBuff,
    getActiveBuffs,
    isDead,
    // v0.61.0
    isShielded,
    getShieldRemaining,
    getDamageMultiplier,
    getThrustMultiplier,
    getScoreMultiplier,
  };
}

/**
 * Asynchronously load a GLB model from `modelUrl` and swap it in as
 * the ship's visual mesh. The existing procedural mesh (cone body +
 * wings) is disposed and replaced by the GLB's scene graph. The
 * engine glow (tagged with `userData.isEngineGlow = true`) is
 * preserved so the ship still has a thrust-reactive exhaust.
 *
 * Two automatic normalizations are applied to the loaded model:
 *
 *   1. **Forward axis.** GLBs commonly use +Z forward (the Blender
 *      exporter default). Our ship physics uses -Z forward
 *      (`fwdX = -sin(yaw)`, `fwdZ = -cos(yaw)` in `createShip.update`).
 *      We detect the model's dominant forward axis by checking whether
 *      the bbox center Z is positive, and rotate 180° around Y if so.
 *
 *   2. **Scale.** The model's longest axis is normalized to
 *      `targetMax` world units (default 2.0), matching the procedural
 *      ship's scale (~2.0 wide, ~2.5 long). The bbox is re-centered
 *      on origin so yaw/roll happen around the visual center.
 *
 * On failure, the procedural mesh stays in place and a warning is
 * logged. The function never throws.
 *
 * The `GLTFLoader` import is **lazy** (inside the function body) so
 * the import is only triggered when this function is called. Node
 * tests that don't call `loadShipModel` never load the GLTFLoader.
 *
 * @param {object} ship - a ship object returned by `createShip`.
 * @param {string} modelUrl - URL of the GLB (e.g. '/models/skyfighter.glb').
 * @param {object} [opts]
 * @param {number} [opts.targetMax=2.0] - target longest-axis size in world units.
 * @param {number} [opts.modelRotationY=0] - extra Y-axis rotation in radians applied after the auto-detected forward-axis rotation. Use this to fix a GLB that loads facing the wrong direction (e.g. +π/2 to rotate a -X-facing model to -Z forward).
 * @returns {Promise<{ success: boolean, error?: Error, glbRoot?: Object, scale?: number, rotated?: boolean }>}
 */
export async function loadShipModel(ship, modelUrl, opts = {}) {
  if (!ship || !ship.body) {
    return { success: false, error: new Error('loadShipModel: ship and ship.body are required') };
  }
  if (!modelUrl || typeof modelUrl !== 'string') {
    return { success: false, error: new Error('loadShipModel: modelUrl is required') };
  }
  const { targetMax = 2.0, modelRotationY = 0 } = opts;

  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[loadShipModel] GLTFLoader import failed; keeping procedural mesh:`, e.message);
    }
    return { success: false, error: e };
  }

  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelUrl);
    const glbRoot = gltf.scene;
    if (!glbRoot) {
      throw new Error('GLB has no scene');
    }

    // ---- 1. Auto-detect forward axis --------------------------------
    // Compute the initial bbox BEFORE any rotation/scale. If the
    // bbox center Z is positive, the model's "nose" is in the +Z
    // direction and we rotate 180° around Y to flip it to -Z
    // forward, matching the ship physics.
    const bbox = new Box3().setFromObject(glbRoot);
    const center = new Vector3();
    bbox.getCenter(center);
    const nosePointsPositiveZ = center.z > 0;
    // Combine the auto-detected forward-axis rotation (0 or π)
    // with the user-supplied extra rotation (`modelRotationY`).
    // The result is one composed rotation applied before the
    // scale step, so the bbox-driven centering still works.
    glbRoot.rotation.y = (nosePointsPositiveZ ? Math.PI : 0) + modelRotationY;

    // ---- 2. Auto-scale ----------------------------------------------
    // Recompute the bbox after the rotation. Normalize so the
    // longest axis is `targetMax` units.
    bbox.setFromObject(glbRoot);
    const size = new Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? targetMax / maxDim : 1;
    glbRoot.scale.setScalar(scale);

    // ---- 3. Re-center on origin -------------------------------------
    // Recompute the bbox after scaling, then translate so the bbox
    // is centered on the body's local origin. Yaw/roll happen
    // around the visual center, not a bbox offset.
    bbox.setFromObject(glbRoot);
    bbox.getCenter(center);
    glbRoot.position.sub(center);

    // ---- 4. Swap meshes ---------------------------------------------
    // Dispose the procedural body + wings (NOT the engine glow) and
    // add the GLB root as a child of `body`. The existing
    // `ship.dispose()` method handles the inverse operation.
    const toRemove = ship.body.children.filter((c) => !c.userData?.isEngineGlow);
    for (const child of toRemove) {
      ship.body.remove(child);
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        child.geometry.dispose();
      }
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
      }
    }
    // v0.68.0 -- walk the loaded GLB root and tag every Mesh
  // with castShadow + receiveShadow so the sun's DirectionalLight
  // also projects the GLB-ship onto nearby asteroids. Without
  // this, only the procedural ship would cast; the GLB ship (what
  // the player actually sees once the load completes) would float
  // shadowlessly.
  glbRoot.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  ship.body.add(glbRoot);

    return { success: true, glbRoot, scale, rotated: nosePointsPositiveZ };
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[loadShipModel] GLB load failed for "${modelUrl}"; keeping procedural mesh:`, e.message);
    }
    return { success: false, error: e };
  }
}
