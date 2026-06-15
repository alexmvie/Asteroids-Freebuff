/**
 * Headless training environment — simulates the ship, asteroids, bullets,
 * power-ups, and laser without any Three.js or rendering.
 *
 * Uses the same pure physics as `src/entities/ship.js` and the same
 * collision logic as `src/systems/collision.js`. The world is a fixed
 * 3×3 chunk field (deterministic, same seed every episode) so the
 * network learns a consistent scenario.
 *
 * Episode ends when the ship dies (hits an asteroid) or when
 * `maxDurationS` elapses.
 *
 * Public API:
 *   - `createTrainingEnvironment(options)` → env
 *   - `env.reset()` — respawn ship at origin, fresh field
 *   - `env.step(action)` — advance one frame (fixed dt), returns { done, hit }
 *   - `env.getState()` → Float32Array (features for the network)
 *   - `env.getScore()` → number
 *   - `env.getSurvivalTime()` → number
 *   - `env.getPowerupsCollected()` → number
 *   - `env.isLaserActive()` → boolean
 */

import {
  THRUST_ACCEL,
  MAX_SPEED,
  LINEAR_DRAG,
  YAW_SPEED,
  ROLL_MAX,
  ROLL_DAMP,
} from '../entities/ship-constants.js';
import { PLAY_PLANE_Y } from '../world/chunk-constants.js';
import { generateChunk, hashChunk } from '../world/chunks.js';
import { mulberry32 } from '../world/rng.js';
import { spheresOverlap } from '../systems/collision.js';

// ---------------------------------------------------------------------------
// Fixed training constants
// ---------------------------------------------------------------------------

const TRAIN_FIELD_RADIUS_CHUNKS = 2; // 5×5 chunks
const TRAIN_SYSTEM_SEED = 42; // fixed for consistency

// Bullet tunables (same as src/entities/bullet.js)
const BULLET_SPEED = 400;
const BULLET_RADIUS = 0.15;
const BULLET_LIFETIME = 1.5;
const BULLET_COOLDOWN = 0.18;

// Laser tunables (same as src/entities/laser.js)
const LASER_LENGTH = 500;
const LASER_DURATION = 0.12;
const LASER_COOLDOWN = 0.08;

// Power-up tunables (same as src/systems/powerup-system.js)
const POWERUP_ACTIVE_DURATION = 15;
const POWERUP_RESPAWN_DELAY = 5;
const POWERUP_LIFETIME = 30;
const POWERUP_RADIUS = 1.5;

// Ship collision radius
const SHIP_RADIUS = 1.4;

// Score table
const SCORE_BY_SIZE = Object.freeze({ 0: 20, 1: 50, 2: 100 });

// State feature normalizers
const NORM_POS = 500;
const NORM_VEL = MAX_SPEED;
const NORM_DIST = 500;
const NORM_RADIUS = 8;

// ---------------------------------------------------------------------------
// Pure ship physics update (headless mirror of ship.js)
// ---------------------------------------------------------------------------

function updateShipPhysics(state, dt, yawInput, thrustOn) {
  // Yaw
  state.rotation.yaw += yawInput * YAW_SPEED * dt;

  // Roll
  const targetRoll = yawInput * ROLL_MAX;
  const rollT = 1 - Math.exp(-ROLL_DAMP * dt);
  state.rotation.roll += (targetRoll - state.rotation.roll) * rollT;

  // Facing
  const fwdX = -Math.sin(state.rotation.yaw);
  const fwdZ = -Math.cos(state.rotation.yaw);

  // Thrust
  if (thrustOn) {
    state.velocity.x += fwdX * THRUST_ACCEL * dt;
    state.velocity.z += fwdZ * THRUST_ACCEL * dt;
  }

  // Drag
  const dragFactor = Math.exp(-LINEAR_DRAG * dt);
  state.velocity.x *= dragFactor;
  state.velocity.z *= dragFactor;

  // Speed cap
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  if (speed > MAX_SPEED) {
    const k = MAX_SPEED / speed;
    state.velocity.x *= k;
    state.velocity.z *= k;
  }

  // Integrate
  state.position.x += state.velocity.x * dt;
  state.position.z += state.velocity.z * dt;
  state.position.y = PLAY_PLANE_Y;
}

// ---------------------------------------------------------------------------
// Laser hit detection (pure mirror of laser.js)
// ---------------------------------------------------------------------------

function rayHitsBeam(asteroidPos, asteroidRadius, origin, dir, length) {
  const ax = asteroidPos.x - origin.x;
  const az = asteroidPos.z - origin.z;
  const tRaw = ax * dir.x + az * dir.z;
  const t = tRaw < 0 ? 0 : tRaw > length ? length : tRaw;
  const cx = origin.x + dir.x * t;
  const cz = origin.z + dir.z * t;
  const dx = asteroidPos.x - cx;
  const dz = asteroidPos.z - cz;
  return dx * dx + dz * dz < asteroidRadius * asteroidRadius;
}

// ---------------------------------------------------------------------------
// Environment factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   maxDurationS?: number,
 *   dt?: number,
 *   fieldRadiusChunks?: number,
 *   systemSeed?: number,
 * }} [opts]
 */
export function createTrainingEnvironment(opts = {}) {
  const maxDurationS = opts.maxDurationS ?? 60;
  const dt = opts.dt ?? 1 / 60;
  const fieldRadiusChunks = opts.fieldRadiusChunks ?? TRAIN_FIELD_RADIUS_CHUNKS;
  const systemSeed = opts.systemSeed ?? TRAIN_SYSTEM_SEED;

  // ---- Mutable state (reset every episode) --------------------------------
  let time = 0;
  let score = 0;
  let survivalTime = 0;
  let powerupsCollected = 0;
  let died = false;

  /** @type {Array<{position:{x,y,z}, velocity:{x,y,z}, radius:number, size:number, id:string}>} */
  let asteroids = [];

  /** @type {Array<{position:{x,y,z}, velocity:{x,y,z}, age:number}>} */
  let bullets = [];

  let bulletCooldown = 0;

  // Power-up state
  let pendingPowerup = null; // {position:{x,y,z}, age:number}
  let laserActive = false;
  let laserRemaining = 0;
  let laserCooldown = 0;
  let laserFiring = false;
  let laserFireTimer = 0;
  let respawnTimer = 0;

  // Ship state
  const ship = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0, roll: 0 },
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function generateField() {
    const list = [];
    for (let cx = -fieldRadiusChunks; cx <= fieldRadiusChunks; cx++) {
      for (let cz = -fieldRadiusChunks; cz <= fieldRadiusChunks; cz++) {
        const chunk = generateChunk({ cx, cz, systemSeed });
        for (const a of chunk.asteroids) {
          list.push({
            id: a.id,
            position: { x: a.position.x, y: a.position.y, z: a.position.z },
            velocity: { x: a.velocity.x, y: a.velocity.y, z: a.velocity.z },
            radius: a.radius,
            size: a.size,
            spin: a.spin,
            axis: a.axis,
          });
        }
      }
    }
    return list;
  }

  function pickSpawnPosition() {
    const rng = mulberry32(hashChunk(0, 0, systemSeed) + Math.floor(time * 1000));
    const angle = rng() * Math.PI * 2;
    const dist = 30 + rng() * 70;
    return {
      x: ship.position.x + Math.cos(angle) * dist,
      y: 2,
      z: ship.position.z + Math.sin(angle) * dist,
    };
  }

  function reset() {
    time = 0;
    score = 0;
    survivalTime = 0;
    powerupsCollected = 0;
    died = false;

    ship.position = { x: 0, y: 0, z: 0 };
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.rotation = { yaw: 0, pitch: 0, roll: 0 };

    asteroids = generateField();
    bullets = [];
    bulletCooldown = 0;

    pendingPowerup = null;
    laserActive = false;
    laserRemaining = 0;
    laserCooldown = 0;
    laserFiring = false;
    laserFireTimer = 0;
    respawnTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  /**
   * @param {{
   *   yaw: number,   // -1, 0, or 1
   *   thrust: boolean,
   *   fire: boolean,
   * }} action
   * @returns {{ done: boolean, hit: boolean }}
   */
  function step(action) {
    if (died) return { done: true, hit: false };

    time += dt;
    survivalTime += dt;

    // 1. Ship physics
    updateShipPhysics(ship, dt, action.yaw, action.thrust);

    // 2. Update bullets
    if (bulletCooldown > 0) bulletCooldown = Math.max(0, bulletCooldown - dt);

    for (const b of bullets) {
      b.age += dt;
      b.position.x += b.velocity.x * dt;
      b.position.y += b.velocity.y * dt;
      b.position.z += b.velocity.z * dt;
    }
    bullets = bullets.filter((b) => b.age < BULLET_LIFETIME);

    // 3. Fire weapon
    if (action.fire) {
      if (laserActive && !laserFiring && laserCooldown <= 0) {
        // Fire laser
        laserFiring = true;
        laserFireTimer = LASER_DURATION;
        laserCooldown = LASER_COOLDOWN;
      } else if (!laserActive && bulletCooldown <= 0) {
        // Fire bullet
        const yaw = ship.rotation.yaw;
        const dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
        const len = Math.hypot(dir.x, dir.z);
        if (len > 1e-6) {
          const inv = 1 / len;
          bullets.push({
            position: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
            velocity: { x: dir.x * inv * BULLET_SPEED, y: 0, z: dir.z * inv * BULLET_SPEED },
            age: 0,
          });
          bulletCooldown = BULLET_COOLDOWN;
        }
      }
    }

    // 4. Laser cooldown + firing timer
    if (laserCooldown > 0) laserCooldown = Math.max(0, laserCooldown - dt);
    if (laserFiring) {
      laserFireTimer -= dt;
      if (laserFireTimer <= 0) {
        laserFiring = false;
      }
    }

    // 5. Power-up system
    //   a) Active laser countdown
    if (laserActive) {
      laserRemaining -= dt;
      if (laserRemaining <= 0) {
        laserActive = false;
        respawnTimer = POWERUP_RESPAWN_DELAY;
      }
    }

    //   b) Pending power-up lifetime
    if (pendingPowerup) {
      pendingPowerup.age += dt;
      if (pendingPowerup.age >= POWERUP_LIFETIME) {
        pendingPowerup = null;
        respawnTimer = POWERUP_RESPAWN_DELAY;
      } else {
        // Check pickup
        const dx = ship.position.x - pendingPowerup.position.x;
        const dz = ship.position.z - pendingPowerup.position.z;
        const distSq = dx * dx + dz * dz;
        const r = POWERUP_RADIUS + 0.5;
        if (distSq < r * r) {
          pendingPowerup = null;
          laserActive = true;
          laserRemaining = POWERUP_ACTIVE_DURATION;
          powerupsCollected += 1;
          respawnTimer = POWERUP_RESPAWN_DELAY;
        }
      }
    } else if (respawnTimer > 0) {
      respawnTimer -= dt;
      if (respawnTimer <= 0) {
        pendingPowerup = {
          position: pickSpawnPosition(),
          age: 0,
        };
      }
    } else {
      // Spawn first power-up immediately
      pendingPowerup = {
        position: pickSpawnPosition(),
        age: 0,
      };
    }

    // 6. Update asteroids (drift)
    for (const a of asteroids) {
      a.position.x += a.velocity.x * dt;
      a.position.z += a.velocity.z * dt;
    }

    // 7. Collision detection
    //   a) Bullet-asteroid
    const hits = [];
    for (let bIdx = 0; bIdx < bullets.length; bIdx++) {
      const b = bullets[bIdx];
      for (let aIdx = 0; aIdx < asteroids.length; aIdx++) {
        const a = asteroids[aIdx];
        if (spheresOverlap(
          { x: b.position.x, y: b.position.y, z: b.position.z, r: BULLET_RADIUS },
          { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
        )) {
          hits.push({ bulletIndex: bIdx, asteroidIndex: aIdx });
          break; // one bullet → one asteroid
        }
      }
    }

    //   b) Laser-asteroid (while firing)
    const laserHits = [];
    if (laserFiring) {
      const yaw = ship.rotation.yaw;
      const origin = ship.position;
      const dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      for (let aIdx = 0; aIdx < asteroids.length; aIdx++) {
        const a = asteroids[aIdx];
        if (rayHitsBeam(a.position, a.radius, origin, dir, LASER_LENGTH)) {
          laserHits.push(aIdx);
        }
      }
    }

    // Apply hits (reverse order for index stability)
    const hitSet = new Set();
    for (const h of hits) hitSet.add(h.asteroidIndex);
    for (const h of laserHits) hitSet.add(h);
    const sortedIndices = [...hitSet].sort((a, b) => b - a);

    for (const aIdx of sortedIndices) {
      const a = asteroids[aIdx];
      score += SCORE_BY_SIZE[a.size] || 0;

      // Spawn children (split asteroid)
      if (a.size === 0) {
        // Large → 2 medium
        asteroids.push(
          { id: a.id + '-a', position: { x: a.position.x - 2, y: a.position.y, z: a.position.z }, velocity: { x: a.velocity.x - 5, y: 0, z: a.velocity.z }, radius: 4, size: 1, spin: 0.3, axis: { x: 0, y: 1, z: 0 } },
          { id: a.id + '-b', position: { x: a.position.x + 2, y: a.position.y, z: a.position.z }, velocity: { x: a.velocity.x + 5, y: 0, z: a.velocity.z }, radius: 4, size: 1, spin: 0.3, axis: { x: 0, y: 1, z: 0 } },
        );
      } else if (a.size === 1) {
        // Medium → 2 small
        asteroids.push(
          { id: a.id + '-a', position: { x: a.position.x - 1, y: a.position.y, z: a.position.z }, velocity: { x: a.velocity.x - 3, y: 0, z: a.velocity.z }, radius: 2, size: 2, spin: 0.5, axis: { x: 0, y: 1, z: 0 } },
          { id: a.id + '-b', position: { x: a.position.x + 1, y: a.position.y, z: a.position.z }, velocity: { x: a.velocity.x + 3, y: 0, z: a.velocity.z }, radius: 2, size: 2, spin: 0.5, axis: { x: 0, y: 1, z: 0 } },
        );
      }
      // Small → disappears
      asteroids.splice(aIdx, 1);
    }

    // Remove bullets that hit
    const hitBulletSet = new Set(hits.map((h) => h.bulletIndex));
    bullets = bullets.filter((_, i) => !hitBulletSet.has(i));

    //   c) Ship-asteroid collision
    for (const a of asteroids) {
      if (spheresOverlap(
        { x: ship.position.x, y: ship.position.y, z: ship.position.z, r: SHIP_RADIUS },
        { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
      )) {
        died = true;
        return { done: true, hit: true };
      }
    }

    // 8. Check time limit
    if (survivalTime >= maxDurationS) {
      return { done: true, hit: false };
    }

    return { done: false, hit: false };
  }

  // -------------------------------------------------------------------------
  // State extraction (features for the neural network)
  // -------------------------------------------------------------------------

  /**
   * Extract features and return a normalized Float32Array.
   * @returns {Float32Array}
   */
  function getState() {
    const features = new Float32Array(11);

    // 0: speed / MAX_SPEED
    const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
    features[0] = speed / NORM_VEL;

    // 1-2: yaw as sin/cos
    features[1] = Math.sin(ship.rotation.yaw);
    features[2] = Math.cos(ship.rotation.yaw);

    // 3-6: nearest asteroid
    let nearestA = null;
    let nearestADist = Infinity;
    for (const a of asteroids) {
      const dx = a.position.x - ship.position.x;
      const dz = a.position.z - ship.position.z;
      const d = Math.hypot(dx, dz);
      if (d < nearestADist) {
        nearestADist = d;
        nearestA = a;
      }
    }
    if (nearestA) {
      features[3] = (nearestA.position.x - ship.position.x) / NORM_DIST;
      features[4] = (nearestA.position.z - ship.position.z) / NORM_DIST;
      features[5] = nearestADist / NORM_DIST;
      features[6] = nearestA.radius / NORM_RADIUS;
    } else {
      features[3] = 0;
      features[4] = 0;
      features[5] = 1;
      features[6] = 0;
    }

    // 7-9: nearest power-up
    if (pendingPowerup) {
      const dx = pendingPowerup.position.x - ship.position.x;
      const dz = pendingPowerup.position.z - ship.position.z;
      const d = Math.hypot(dx, dz);
      features[7] = dx / NORM_DIST;
      features[8] = dz / NORM_DIST;
      features[9] = d / NORM_DIST;
    } else {
      features[7] = 0;
      features[8] = 0;
      features[9] = 1;
    }

    // 10: laser active
    features[10] = laserActive ? 1 : 0;

    return features;
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  function getScore() { return score; }
  function getSurvivalTime() { return survivalTime; }
  function getPowerupsCollected() { return powerupsCollected; }
  function isLaserActive() { return laserActive; }
  function getShipPosition() { return { x: ship.position.x, y: ship.position.y, z: ship.position.z }; }
  function getShipVelocity() { return { x: ship.velocity.x, y: ship.velocity.y, z: ship.velocity.z }; }
  function getShipRotation() { return { yaw: ship.rotation.yaw, pitch: ship.rotation.pitch, roll: ship.rotation.roll }; }
  function getAsteroidCount() { return asteroids.length; }
  function getBulletCount() { return bullets.length; }
  function hasDied() { return died; }

  return {
    reset,
    step,
    getState,
    getScore,
    getSurvivalTime,
    getPowerupsCollected,
    isLaserActive,
    getShipPosition,
    getShipVelocity,
    getShipRotation,
    getAsteroidCount,
    getBulletCount,
    hasDied,
  };
}
