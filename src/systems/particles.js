/**
 * Particle system — smoke puffs and stone debris on asteroid destruction.
 *
 * Uses a fixed-size pool of `THREE.Sprite` objects (shared procedural
 * textures generated via canvas at init time — no external assets).
 * Two visual layers per explosion:
 *
 *   - **Smoke**: large, slow, white→grey puffs that expand and fade
 *     over ~1.5s. No gravity. Gives the explosion volume.
 *   - **Debris**: small, fast brown/grey stone chunks that fly outward,
 *     tumble, and fall under slight gravity over ~0.8s. Gives the
 *     explosion grit.
 *
 * Pool sizes are tuned for ~50 concurrent explosions at 60fps. Each
 * explosion emits `SMOKE_COUNT + DEBRIS_COUNT` sprites. Dead sprites
 * are recycled immediately (no GC pressure).
 *
 * @module systems/particles
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Smoke sprites emitted per explosion (scaled by asteroid radius). */
const SMOKE_COUNT = 8;
/** Debris sprites emitted per explosion (scaled by asteroid radius). */
const DEBRIS_COUNT = 10;

/** Total pool size — enough for ~50 concurrent explosions. */
const POOL_SIZE = (SMOKE_COUNT + DEBRIS_COUNT) * 50;

/** Smoke particle lifetime range (seconds). */
const SMOKE_LIFE_MIN = 0.8;
const SMOKE_LIFE_MAX = 1.6;
/** Smoke start size (world units) — scaled by asteroid radius. */
const SMOKE_SIZE_START = 0.4;
/** Smoke end size multiplier (expands to this × start size). */
const SMOKE_SIZE_END_MULT = 3.0;
/** Smoke initial velocity spread (world units/sec). */
const SMOKE_SPEED = 4.0;
/** Smoke drag coefficient (exponential decay). */
const SMOKE_DRAG = 1.5;

/** Debris particle lifetime range (seconds). */
const DEBRIS_LIFE_MIN = 0.4;
const DEBRIS_LIFE_MAX = 1.0;
/** Debris start size (world units) — scaled by asteroid radius. */
const DEBRIS_SIZE_START = 0.15;
/** Debris end size multiplier (shrinks slightly). */
const DEBRIS_SIZE_END_MULT = 0.3;
/** Debris initial velocity spread (world units/sec). */
const DEBRIS_SPEED = 18.0;
/** Debris drag coefficient. */
const DEBRIS_DRAG = 1.2;
/** Debris gravity (world units/sec², subtle downward pull). */
const DEBRIS_GRAVITY = 8.0;

// ---------------------------------------------------------------------------
// Procedural textures (generated once at init)
// ---------------------------------------------------------------------------

/**
 * Generate a soft radial-gradient circle on a canvas.
 * Used for smoke puffs.
 * @param {number} size  canvas width/height in pixels
 * @returns {HTMLCanvasElement}
 */
function makeSmokeCanvas(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  // White center → transparent edge, with a soft falloff.
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.3, 'rgba(220, 220, 220, 0.8)');
  grad.addColorStop(0.6, 'rgba(180, 180, 180, 0.4)');
  grad.addColorStop(1.0, 'rgba(150, 150, 150, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Generate a small irregular rocky chunk on a canvas.
 * Used for debris particles.
 * @param {number} size  canvas width/height in pixels
 * @returns {HTMLCanvasElement}
 */
function makeDebrisCanvas(size = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  // Draw an irregular polygon (5–7 vertices) in grey-brown tones.
  const verts = 5 + Math.floor(Math.random() * 3);
  ctx.beginPath();
  for (let i = 0; i < verts; i++) {
    const angle = (i / verts) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const r = half * (0.5 + Math.random() * 0.45);
    const x = half + Math.cos(angle) * r;
    const y = half + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  // Grey-brown fill with a subtle gradient.
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, '#8a7a6a');
  grad.addColorStop(0.7, '#6a5a4a');
  grad.addColorStop(1.0, '#4a3a2a');
  ctx.fillStyle = grad;
  ctx.fill();

  // Soft edge fade.
  ctx.globalCompositeOperation = 'destination-out';
  const fadeGrad = ctx.createRadialGradient(half, half, half * 0.3, half, half, half);
  fadeGrad.addColorStop(0.0, 'rgba(0,0,0,0)');
  fadeGrad.addColorStop(1.0, 'rgba(0,0,0,1)');
  ctx.fillStyle = fadeGrad;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}

// ---------------------------------------------------------------------------
// Particle pool entry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Particle
 * @property {THREE.Sprite} sprite
 * @property {THREE.Vector3} velocity
 * @property {number} life      remaining seconds
 * @property {number} maxLife    total lifetime
 * @property {number} sizeStart  start scale
 * @property {number} sizeEnd    end scale
 * @property {number} drag       exponential drag coefficient
 * @property {number} gravity    downward accel (0 = no gravity)
 * @property {boolean} active
 */

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the particle system.
 *
 * @param {{ scene: THREE.Scene }} opts
 * @returns {{
 *   emitExplosion: (pos: {x:number,y:number,z:number}, radius?: number) => void,
 *   update: (dt: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createParticleSystem({ scene } = {}) {
  if (!scene) throw new Error('createParticleSystem: `scene` is required');

  // Generate procedural textures once.
  const smokeCanvas = makeSmokeCanvas(64);
  const smokeTexture = new THREE.CanvasTexture(smokeCanvas);
  const debrisCanvas = makeDebrisCanvas(32);
  const debrisTexture = new THREE.CanvasTexture(debrisCanvas);

  // Shared materials — one for smoke, one for debris. Sprites share
  // the material but each gets its own color/opacity via sprite.material
  // cloning (see below).
  const smokeMaterialTemplate = new THREE.SpriteMaterial({
    map: smokeTexture,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });

  const debrisMaterialTemplate = new THREE.SpriteMaterial({
    map: debrisTexture,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });

  // ---- Pre-allocate pool ------------------------------------------------
  /** @type {Particle[]} */
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    // Alternate smoke/debris materials for even distribution.
    const isSmoke = i % 2 === 0;
    const mat = (isSmoke ? smokeMaterialTemplate : debrisMaterialTemplate).clone();
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 10; // above asteroids, below HUD
    scene.add(sprite);

    pool.push({
      sprite,
      velocity: new THREE.Vector3(),
      life: 0,
      maxLife: 1,
      sizeStart: 1,
      sizeEnd: 1,
      drag: 1,
      gravity: 0,
      active: false,
      isSmoke,
    });
  }

  // ---- Spawn helpers ----------------------------------------------------

  /**
   * Find the next inactive particle of the requested type.
   * @param {boolean} wantSmoke  true for smoke, false for debris
   * @returns {Particle | null}
   */
  function acquire(wantSmoke) {
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active && pool[i].isSmoke === wantSmoke) return pool[i];
    }
    return null; // pool exhausted for this type — skip silently
  }

  /**
   * Spawn one smoke particle at `pos`.
   * @param {{x:number,y:number,z:number}} pos
   * @param {number} radius  asteroid radius (scales size + speed)
   */
  function spawnSmoke(pos, radius) {
    const p = acquire(true);
    if (!p) return;
    const scale = Math.max(0.5, radius);
    const life = SMOKE_LIFE_MIN + Math.random() * (SMOKE_LIFE_MAX - SMOKE_LIFE_MIN);

    p.sprite.position.set(
      pos.x + (Math.random() - 0.5) * scale * 0.6,
      pos.y + (Math.random() - 0.5) * scale * 0.6,
      pos.z + (Math.random() - 0.5) * scale * 0.6,
    );
    p.velocity.set(
      (Math.random() - 0.5) * SMOKE_SPEED * scale,
      Math.random() * SMOKE_SPEED * scale * 0.5,
      (Math.random() - 0.5) * SMOKE_SPEED * scale,
    );
    p.life = life;
    p.maxLife = life;
    p.sizeStart = SMOKE_SIZE_START * scale;
    p.sizeEnd = SMOKE_SIZE_START * scale * SMOKE_SIZE_END_MULT;
    p.drag = SMOKE_DRAG;
    p.gravity = 0;
    p.active = true;

    // Tint: white to light grey, with slight warm variation.
    const brightness = 0.85 + Math.random() * 0.15;
    const warmth = Math.random() * 0.05;
    p.sprite.material.color.setRGB(brightness, brightness - warmth, brightness - warmth * 2);
    p.sprite.material.opacity = 0.7;
    p.sprite.visible = true;
  }

  /**
   * Spawn one debris particle at `pos`.
   * @param {{x:number,y:number,z:number}} pos
   * @param {number} radius  asteroid radius (scales speed)
   */
  function spawnDebris(pos, radius) {
    const p = acquire(false);
    if (!p) return;
    const scale = Math.max(0.5, radius);
    const life = DEBRIS_LIFE_MIN + Math.random() * (DEBRIS_LIFE_MAX - DEBRIS_LIFE_MIN);

    // Random direction on a sphere, biased upward slightly.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1) * 0.7; // bias toward horizontal
    const speed = DEBRIS_SPEED * scale * (0.5 + Math.random() * 0.5);

    p.sprite.position.set(
      pos.x + (Math.random() - 0.5) * scale * 0.3,
      pos.y + (Math.random() - 0.5) * scale * 0.3,
      pos.z + (Math.random() - 0.5) * scale * 0.3,
    );
    p.velocity.set(
      Math.sin(phi) * Math.cos(theta) * speed,
      Math.abs(Math.cos(phi)) * speed * 0.5 + speed * 0.2, // always upward
      Math.sin(phi) * Math.sin(theta) * speed,
    );
    p.life = life;
    p.maxLife = life;
    p.sizeStart = DEBRIS_SIZE_START * scale;
    p.sizeEnd = DEBRIS_SIZE_START * scale * DEBRIS_SIZE_END_MULT;
    p.drag = DEBRIS_DRAG;
    p.gravity = DEBRIS_GRAVITY;
    p.active = true;

    // Tint: warm grey-brown rock tones.
    const r = 0.35 + Math.random() * 0.2;
    const g = 0.28 + Math.random() * 0.15;
    const b = 0.2 + Math.random() * 0.1;
    p.sprite.material.color.setRGB(r, g, b);
    p.sprite.material.opacity = 1.0;
    p.sprite.visible = true;
  }

  // ---- Public API -------------------------------------------------------

  /**
   * Emit an explosion at the given world position.
   * @param {{x:number, y:number, z:number}} pos   world position
   * @param {number} [radius=2]                     asteroid radius (scales effect)
   */
  function emitExplosion(pos, radius = 2) {
    const smokeN = Math.round(SMOKE_COUNT * Math.min(radius / 3, 1.5));
    const debrisN = Math.round(DEBRIS_COUNT * Math.min(radius / 3, 1.5));
    for (let i = 0; i < smokeN; i++) spawnSmoke(pos, radius);
    for (let i = 0; i < debrisN; i++) spawnDebris(pos, radius);
  }

  /**
   * Per-frame update. Advances all active particles, applies physics,
   * fades, and recycles dead ones.
   * @param {number} dt  seconds since last frame
   */
  function update(dt) {
    if (dt <= 0) return;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }

      // Life ratio: 0 = just born, 1 = about to die.
      const t = 1 - p.life / p.maxLife;

      // Physics: drag + gravity.
      const dragFactor = Math.exp(-p.drag * dt);
      p.velocity.x *= dragFactor;
      p.velocity.y *= dragFactor;
      p.velocity.z *= dragFactor;
      p.velocity.y -= p.gravity * dt;

      // Position integration.
      p.sprite.position.x += p.velocity.x * dt;
      p.sprite.position.y += p.velocity.y * dt;
      p.sprite.position.z += p.velocity.z * dt;

      // Size: lerp from start to end.
      const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * t;
      p.sprite.scale.set(size, size, 1);

      // Opacity: hold at full for the first 20%, then fade out.
      const fadeStart = 0.2;
      const alpha = t < fadeStart ? 1.0 : 1.0 - (t - fadeStart) / (1.0 - fadeStart);
      p.sprite.material.opacity = alpha * (p.isSmoke ? 0.7 : 1.0);
    }
  }

  /**
   * Release all GPU resources and remove sprites from the scene.
   */
  function dispose() {
    for (const p of pool) {
      scene.remove(p.sprite);
      p.sprite.material.dispose();
    }
    smokeTexture.dispose();
    debrisTexture.dispose();
    smokeMaterialTemplate.dispose();
    debrisMaterialTemplate.dispose();
    pool.length = 0;
  }

  /**
   * Deactivate all live particles (e.g. on game reset). Sprites
   * are hidden but the pool stays intact for reuse.
   */
  function clear() {
    for (const p of pool) {
      p.active = false;
      p.sprite.visible = false;
    }
  }

  return { emitExplosion, update, clear, dispose };
}
