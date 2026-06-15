/**
 * Laser weapon — the ship's "piercing beam" fired while the laser
 * power-up is active (see src/entities/powerup.js).
 *
 * Visual:
 *   - A long thin cylinder mesh (the "core" beam) with a second slightly
 *     larger additive-blended cylinder (the "glow" halo). Both run from
 *     the ship's position outward in the firing direction for
 *     LASER_LENGTH units — well beyond the active streaming bubble, so
 *     the beam "cuts into the depth of space" past the visible field.
 *   - Bright sky-blue, `toneMapped: false` so it pops against the dark
 *     nebula, transparent so the beam fades in/out cleanly.
 *
 * Hit detection (pure, no Three.js scene walk):
 *   - For each asteroid in the supplied list, project the asteroid's
 *     center onto the beam's parametric axis `[0, LASER_LENGTH]`,
 *     clamp the parameter to the segment, and test the distance from
 *     the asteroid's center to the closest point on the segment against
 *     the asteroid's radius. A hit means the sphere intersects the
 *     beam's axis. Hits are accumulated in a `pendingHits` Set
 *     (asteroid entity references); the collision layer in main.js
 *     consumes them.
 *
 * Lifecycle:
 *   - `laser.fire({ origin, direction, asteroids })` — start a pulse
 *     (rejected if on cooldown). Computes hits for this pulse.
 *   - `laser.update(dt, ship, asteroids)` — advance the fire timer and
 *     cooldown; while firing, follow the ship and re-accumulate hits
 *     (so a moving ship "sweeps" the beam through new asteroids).
 *   - `laser.getPendingHits()` — Set of asteroid entities hit by the
 *     current pulse. Caller consumes via `consumeHit(entity)`.
 *
 * Tunables (inline; extract later if needed):
 *   - `LASER_DURATION_S`    how long the beam is visible per pulse
 *   - `LASER_COOLDOWN_S`    min time between pulses
 *   - `LASER_LENGTH`        beam reach (world units)
 *   - `LASER_RADIUS`        beam thickness
 *
 * @param {{ scene: import('three').Scene }} opts
 */

import {
  Mesh,
  CylinderGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  Vector3,
} from 'three';

// ---- Tunables -----------------------------------------------------------
const LASER_DURATION_S = 0.12; // beam visible per pulse
const LASER_COOLDOWN_S = 0.08; // min seconds between pulses
// Beam reach (world units). Long enough to extend well past the active
// streaming bubble (7x7 chunks, ~700 units across) and "cut into the
// depth of space", but short enough that the transparent cylinder
// doesn't fill a huge portion of the screen and cause GPU overdraw.
// The previous value (2000) was causing dramatic frame-rate drops
// when the laser was active — the 2000-unit transparent DoubleSide
// cylinder was shading a massive screen-space area every frame.
const LASER_LENGTH = 500;
const LASER_RADIUS = 0.18; // beam core thickness
const LASER_COLOR = 0x4dabf7; // sky blue (a touch more blue than the game's primary cyan)
const _up = new Vector3(0, 1, 0);

export function createLaser({ scene } = {}) {
  if (!scene) throw new Error('createLaser: `scene` is required');

  // ---- Beam meshes ----------------------------------------------------
  // Core beam: thin, opaque-ish cylinder. Sits at the beam's base when
  // translated by +Y * (length/2) and oriented along the dir vector.
  const coreGeom = new CylinderGeometry(LASER_RADIUS, LASER_RADIUS, LASER_LENGTH, 8, 1, true);
  coreGeom.translate(0, LASER_LENGTH / 2, 0); // base at local origin, tip at +Y * length
  const coreMat = new MeshBasicMaterial({
    color: LASER_COLOR,
    transparent: true,
    opacity: 0.9,
    // FrontSide only — the back face of a thin cylinder is barely
    // visible from the chase camera's view and rendering it doubles
    // the per-fragment cost. With the previous DoubleSide + 2000-unit
    // length, the GPU was shading the entire beam twice per fragment,
    // causing dramatic frame-rate drops when the laser was active.
    side: 0, // FrontSide
    depthWrite: false,
    toneMapped: false,
  });
  const core = new Mesh(coreGeom, coreMat);
  core.visible = false;
  scene.add(core);

  // Glow halo: larger, very transparent, additive — gives the "core
  // + glow" laser look without a custom shader.
  const glowGeom = new CylinderGeometry(
    LASER_RADIUS * 2.8,
    LASER_RADIUS * 2.8,
    LASER_LENGTH,
    8,
    1,
    true,
  );
  glowGeom.translate(0, LASER_LENGTH / 2, 0);
  const glowMat = new MeshBasicMaterial({
    color: LASER_COLOR,
    transparent: true,
    opacity: 0.32,
    // FrontSide only — same perf reasoning as the core. The glow
    // contributes to the additive halo but the back face adds little
    // visible difference while doubling the fragment work.
    side: 0, // FrontSide
    depthWrite: false,
    toneMapped: false,
    blending: AdditiveBlending,
  });
  const glow = new Mesh(glowGeom, glowMat);
  glow.visible = false;
  scene.add(glow);

  // ---- State ----------------------------------------------------------
  let firing = false;
  let fireTimer = 0;
  let cooldownTimer = 0;
  /** @type {Set<object>} asteroid entities hit by the current pulse */
  const pendingHits = new Set();

  // Cached vectors (avoid per-frame allocations)
  const _origin = new Vector3();
  const _dir = new Vector3();

  /**
   * Pure: does a sphere (asteroid) intersect the beam's line segment?
   * Standard point-to-segment distance test. The segment runs from
   * `origin` to `origin + dir * length`. The asteroid is a sphere at
   * `ap` with radius `r`.
   *
   * @param {{x:number,y:number,z:number}} ap  asteroid center
   * @param {number} r                          asteroid radius
   * @param {Vector3} origin                    beam origin
   * @param {Vector3} dir                       beam direction (unit)
   * @param {number} length                     beam length
   * @returns {boolean}
   */
  function rayHitsBeam(ap, r, origin, dir, length) {
    if (!ap) return false;
    const ax = ap.x - origin.x;
    const az = ap.z - origin.z;
    // Project onto dir (signed distance along the beam axis)
    const tRaw = ax * dir.x + az * dir.z;
    // Clamp to [0, length] — the closest point on the SEGMENT to the
    // asteroid center. (Asteroids past the beam's tip use t=length; the
    // beam tip itself can still hit an asteroid if the sphere extends
    // backward along the axis past the tip.)
    const t = tRaw < 0 ? 0 : tRaw > length ? length : tRaw;
    const cx = origin.x + dir.x * t;
    const cz = origin.z + dir.z * t;
    const dx = ap.x - cx;
    const dz = ap.z - cz;
    return dx * dx + dz * dz < r * r;
  }

  /**
   * Accumulate hits for the current beam (origin, dir, length) into
   * `pendingHits`. Re-iterates the asteroid list every call — cheap
   * (≤ 300 asteroids in the streaming bubble).
   *
   * @param {Array<{getPosition: () => any, getRadius: () => number}>} asteroids
   */
  function accumulateHits(asteroids) {
    if (!asteroids) return;
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      if (!a || pendingHits.has(a)) continue;
      if (rayHitsBeam(a.getPosition(), a.getRadius(), _origin, _dir, LASER_LENGTH)) {
        pendingHits.add(a);
      }
    }
  }

  /**
   * Orient both beam meshes from `origin` in `direction`. Direction does
   * not need to be unit-length (we normalize).
   */
  function placeBeam(origin, direction) {
    _origin.copy(origin);
    _dir.set(direction.x, direction.y || 0, direction.z);
    if (_dir.lengthSq() < 1e-6) return false;
    _dir.normalize();
    core.position.copy(_origin);
    core.quaternion.setFromUnitVectors(_up, _dir);
    glow.position.copy(_origin);
    glow.quaternion.setFromUnitVectors(_up, _dir);
    return true;
  }

  /**
   * Start a laser pulse. Returns true on success, false if the call
   * was rejected (cooldown active, missing args, zero-length direction).
   *
   * @param {{
   *   origin: { x: number, y?: number, z: number },
   *   direction: { x: number, y?: number, z: number },
   *   asteroids?: Array<object>,
   * }} args
   * @returns {boolean}
   */
  function fire({ origin, direction, asteroids } = {}) {
    if (cooldownTimer > 0) return false;
    if (!origin || typeof origin.x !== 'number') return false;
    if (!direction || typeof direction.x !== 'number') return false;
    if (!placeBeam(origin, direction)) return false;

    firing = true;
    fireTimer = LASER_DURATION_S;
    cooldownTimer = LASER_COOLDOWN_S;
    core.visible = true;
    glow.visible = true;
    pendingHits.clear();
    accumulateHits(asteroids);
    return true;
  }

  /**
   * Per-frame update. Decrements timers. While `firing`, the beam
   * follows the ship's current position+direction (so a moving ship
   * sweeps the beam through new asteroids — the "cut through multiple
   * in a row" feel). If the ship is `null` (e.g. paused), the beam
   * stays at its last-known position and stops accumulating new hits.
   *
   * @param {number} dt
   * @param {{ position: {x:number,y:number,z:number}, rotation: { yaw: number } } | null} ship
   * @param {Array<object>} [asteroids]
   */
  function update(dt, ship, asteroids) {
    if (dt <= 0) return;
    if (cooldownTimer > 0) {
      cooldownTimer = Math.max(0, cooldownTimer - dt);
    }
    if (!firing) return;

    fireTimer -= dt;
    if (fireTimer <= 0) {
      firing = false;
      core.visible = false;
      glow.visible = false;
      pendingHits.clear();
      return;
    }

    // While firing, follow the ship (visual + hit accumulation).
    if (ship && ship.position) {
      const yaw = ship.rotation?.yaw || 0;
      placeBeam(ship.position, { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
      accumulateHits(asteroids);
    }
  }

  function isFiring() { return firing; }
  function isOnCooldown() { return cooldownTimer > 0; }
  function getCooldownRemaining() { return cooldownTimer; }
  function getFireTimeRemaining() { return firing ? fireTimer : 0; }
  /** @returns {Set<object>} asteroid entities hit by the current pulse */
  function getPendingHits() { return pendingHits; }
  /** Remove an entity from the pending set (called by the collision layer). */
  function consumeHit(asteroid) { pendingHits.delete(asteroid); }

  /**
   * Force the laser to stop firing immediately. Used by the power-up
   * system when the active laser is cancelled (e.g. the player dies
   * mid-firing). Hides both meshes, clears pending hits, resets the
   * timers. The next `fire()` call will start fresh.
   */
  function stop() {
    firing = false;
    fireTimer = 0;
    cooldownTimer = 0;
    core.visible = false;
    glow.visible = false;
    pendingHits.clear();
  }

  function dispose() {
    scene.remove(core);
    scene.remove(glow);
    coreGeom.dispose();
    coreMat.dispose();
    glowGeom.dispose();
    glowMat.dispose();
  }

  return {
    fire,
    update,
    dispose,
    stop,
    isFiring,
    isOnCooldown,
    getCooldownRemaining,
    getFireTimeRemaining,
    getPendingHits,
    consumeHit,
  };
}
