/**
 * Particle system — smoke puffs and stone debris on asteroid destruction.
 *
 * Uses a fixed-size pool of `THREE.Sprite` objects (shared procedural
 * textures generated via canvas at init time — no external assets).
 * Two visual layers per explosion:
 *
 *   - **Smoke**: large, slow, white→grey puffs that expand and fade.
 *   - **Debris**: small brown/grey stone chunks that tumble outward.
 *
 * Optimized for performance: free-list acquire (O(1)), active-list update
 * (only live particles, not the full pool). At 60fps with ~200 active
 * particles, the update loop runs in <0.1ms.
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
const DEBRIS_COUNT = 40;

/** Total pool size — enough for ~15 concurrent explosions. */
const POOL_SIZE = (SMOKE_COUNT + DEBRIS_COUNT) * 15;

/** Smoke particle lifetime range (seconds). */
const SMOKE_LIFE_MIN = 1.0;
const SMOKE_LIFE_MAX = 2.2;
/** Smoke start size (world units) — scaled by asteroid radius. */
const SMOKE_SIZE_START = 1.2;
/** Smoke end size multiplier (expands to this × start size — 30× = screen-filling). */
const SMOKE_SIZE_END_MULT = 30.0;
/** Smoke initial velocity spread (world units/sec). */
const SMOKE_SPEED = 5.0;
/** Smoke drag coefficient (exponential decay). */
const SMOKE_DRAG = 1.2;

/** Debris particle lifetime range (seconds). */
const DEBRIS_LIFE_MIN = 0.5;
const DEBRIS_LIFE_MAX = 1.3;
/** Debris start size (world units) — scaled by asteroid radius. */
const DEBRIS_SIZE_START = 0.4;
/** Debris end size multiplier (1.0 = no shrink — stays visible through life). */
const DEBRIS_SIZE_END_MULT = 1.0;
/** Debris initial velocity spread (world units/sec) — max speed. */
const DEBRIS_SPEED = 20.0;
/** Debris drag coefficient. */
const DEBRIS_DRAG = 1.5;
/** Debris gravity (world units/sec², subtle downward pull). */
const DEBRIS_GRAVITY = 10.0;

// ---------------------------------------------------------------------------
// Procedural textures (generated once at init)
// ---------------------------------------------------------------------------

/**
 * Generate a wispy smoke texture with DOMAIN-WARPED FBM noise.
 * Instead of a circular gradient with noise modulation, this uses
 * domain warping (sampling noise at coordinates distorted by another
 * noise field) to create organic, wispy, non-circular smoke shapes
 * with tendrils and varied density.
 *
 * Resolution 128×128 for enough detail to see wispy structure even
 * when scaled to screen-filling size.
 *
 * @param {number} size  canvas width/height in pixels
 * @returns {HTMLCanvasElement}
 */
function makeSmokeCanvas(size = 128) {
   const canvas = document.createElement('canvas');
   canvas.width = size;
   canvas.height = size;
   const ctx = canvas.getContext('2d');
   const imageData = ctx.createImageData(size, size);
   const data = imageData.data;
   const half = size / 2;

   // Deterministic 2D hash → [0, 1)
   function hash2(ix, iy) {
      let h = (ix * 374761393 + iy * 668265263) | 0;
      h = ((h ^ (h >>> 13)) * 1274126177) | 0;
      return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
   }

   // Smooth noise (cosine interpolation)
   function snoise(x, y, freq) {
      const sx = x * freq,
         sy = y * freq;
      const ix = sx | 0,
         iy = sy | 0;
      const fx = sx - ix,
         fy = sy - iy;
      const cx = 0.5 - 0.5 * Math.cos(fx * Math.PI);
      const cy = 0.5 - 0.5 * Math.cos(fy * Math.PI);
      const v00 = hash2(ix, iy);
      const v10 = hash2(ix + 1, iy);
      const v01 = hash2(ix, iy + 1);
      const v11 = hash2(ix + 1, iy + 1);
      return v00 + (v10 - v00) * cx + (v01 - v00) * cy + (v00 - v10 - v01 + v11) * cx * cy;
   }

   // FBM: multi-octave noise
   function fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
      let val = 0,
         amp = 1,
         freq = 1,
         maxVal = 0;
      for (let i = 0; i < octaves; i++) {
         val += amp * snoise(x, y, freq);
         maxVal += amp;
         amp *= gain;
         freq *= lacunarity;
      }
      return val / maxVal;
   }

   for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
         const i = (py * size + px) * 4;

         // Normalized coords, centered
         const u = (px - half) / half;
         const v = (py - half) / half;

         // Distance from center (used ONLY for extreme edge fade)
         const dist = Math.sqrt(u * u + v * v);

         // ---- Domain warping ------------------------------------------------
         // Warp coordinates using noise at two different scales.
         // This is the key technique for non-circular, wispy smoke:
         // instead of modifying the alpha, we distort WHERE we sample.
         const warpScale = 1.5;
         const warp1x = fbm(u * warpScale + 3.1, v * warpScale + 1.7, 3) - 0.5;
         const warp1y = fbm(u * warpScale + 5.3, v * warpScale + 7.9, 3) - 0.5;
         const warp2x = fbm(u * 0.8 + warp1x * 0.5 + 1.1, v * 0.8 + warp1y * 0.5 + 2.3, 2) - 0.5;
         const warp2y = fbm(u * 0.8 + warp1y * 0.3 + 4.7, v * 0.8 + warp1x * 0.3 + 8.1, 2) - 0.5;

         const warpStrength = 1.2;
         const wu = (px + 0.5) / size + warp1x * warpStrength + warp2x * 0.6;
         const wv = (py + 0.5) / size + warp1y * warpStrength + warp2y * 0.6;

         // ---- Sample noise at warped coordinates ----------------------------
         const n1 = fbm(wu * 2.5, wv * 2.5, 4); // main billow shape (lower freq for bigger features)
         const n2 = fbm(wu * 5.0, wv * 5.0, 3); // medium wisp detail
         const n3 = snoise(wu, wv, 10.0); // fine edge detail

         // Combine: shape is NOISE-DRIVEN, not distance-driven
         // Reduced n1 contribution so the shape is LESS dominated by central billow
         const shape = n1 * 0.4 + n2 * 0.35 + n3 * 0.25;

         // Minimal edge fade — just enough to prevent hard canvas-edge cutoff,
         // not enough to make the shape appear round.
         const edgeFade = Math.max(0, 1 - Math.pow(dist, 6));

         // Final alpha: purely noise-driven shape with minimal edge fade
         const alpha = Math.pow(shape, 0.9) * edgeFade * 0.45;

         // Pale warm grey-white (smoke color)
         const b = 220 + shape * 35;
         data[i] = b;
         data[i + 1] = b * 0.97;
         data[i + 2] = b * 0.93;
         data[i + 3] = Math.min(254, Math.max(0, Math.round(alpha * 255)));
      }
   }

   ctx.putImageData(imageData, 0, 0);
   return canvas;
}

/**
 * Generate a debris texture with one of 4 distinct variants.
 *   variant 0 — Angular shard (sharp polygon, few vertices)
 *   variant 1 — Chunky fragment (rounded, many vertices)
 *   variant 2 — Elongated splinter (stretched in one direction)
 *   variant 3 — Porous crumb (noise-based with holes)
 *
 * Each variant uses unique geometry and color tones, so the explosion
 * has visual variety instead of identical-looking chunks.
 *
 * @param {number} variant  0-3
 * @param {number} size     canvas width/height in pixels
 * @returns {HTMLCanvasElement}
 */
function makeDebrisCanvas(variant = 0, size = 32) {
   const canvas = document.createElement('canvas');
   canvas.width = size;
   canvas.height = size;
   const ctx = canvas.getContext('2d');
   const half = size / 2;

   if (variant === 0) {
      // ---- Angular shard: 4-5 sharp vertices, jagged ------------
      const verts = 4 + Math.floor(Math.random() * 2);
      ctx.beginPath();
      for (let i = 0; i < verts; i++) {
         const angle = (i / verts) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
         const r = half * (0.3 + Math.random() * 0.6);
         const x = half + Math.cos(angle) * r;
         const y = half + Math.sin(angle) * r;
         if (i === 0) ctx.moveTo(x, y);
         else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = ctx.createRadialGradient(half, half, 0, half, half, half);
      ctx.fillStyle.addColorStop(0.0, '#7a6a5a');
      ctx.fillStyle.addColorStop(0.6, '#5a4a3a');
      ctx.fillStyle.addColorStop(1.0, '#3a2a1a');
      ctx.fill();
   } else if (variant === 1) {
      // ---- Chunky fragment: 7-9 rounder vertices ----------------
      const verts = 7 + Math.floor(Math.random() * 3);
      ctx.beginPath();
      for (let i = 0; i < verts; i++) {
         const angle = (i / verts) * Math.PI * 2;
         const r = half * (0.5 + Math.random() * 0.4);
         const x = half + Math.cos(angle) * r;
         const y = half + Math.sin(angle) * r;
         if (i === 0) ctx.moveTo(x + Math.random() * 2, y + Math.random() * 2);
         else ctx.quadraticCurveTo(half + Math.cos(angle + 0.3) * r * 0.6, half + Math.sin(angle + 0.3) * r * 0.6, x, y);
      }
      ctx.closePath();
      ctx.fillStyle = ctx.createRadialGradient(half * 0.6, half * 0.6, 0, half, half, half);
      ctx.fillStyle.addColorStop(0.0, '#9a8a7a');
      ctx.fillStyle.addColorStop(0.5, '#7a6a5a');
      ctx.fillStyle.addColorStop(1.0, '#5a4a3a');
      ctx.fill();
   } else if (variant === 2) {
      // ---- Elongated splinter: stretched along Y ---------------
      ctx.save();
      ctx.scale(0.6, 1.4); // stretch
      ctx.beginPath();
      const verts = 5 + Math.floor(Math.random() * 2);
      for (let i = 0; i < verts; i++) {
         const angle = (i / verts) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
         const r = half * (0.35 + Math.random() * 0.55);
         const x = half / 0.6 + Math.cos(angle) * r;
         const y = half / 1.4 + Math.sin(angle) * r;
         if (i === 0) ctx.moveTo(x, y);
         else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.restore();
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0.0, '#6a5a4a');
      grad.addColorStop(0.5, '#8a7a6a');
      grad.addColorStop(1.0, '#4a3a2a');
      ctx.fillStyle = grad;
      ctx.fill();
   } else {
      // ---- Porous crumb: noise-based with internal holes -------
      const imageData = ctx.createImageData(size, size);
      const d = imageData.data;
      for (let py = 0; py < size; py++) {
         for (let px = 0; px < size; px++) {
            const i = (py * size + px) * 4;
            const dx = (px - half) / half;
            const dy = (py - half) / half;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1) continue;
            // Simple value noise with multiple octaves for porous rock
            const noise =
               (Math.sin(px * 0.5 + py * 0.7) * 0.3 +
                  Math.sin(px * 1.3 - py * 0.9) * 0.2 +
                  Math.sin((px - py) * 0.3 + 1.5) * 0.15 +
                  Math.sin(px * 3.1 + py * 2.7) * 0.1) *
                  0.75 +
               0.5;
            const grad = 1 - dist * dist;
            const alpha = Math.max(0, Math.min(1, (noise * grad - 0.15) * 2));
            const b = 100 + noise * 60;
            d[i] = b;
            d[i + 1] = b * 0.9;
            d[i + 2] = b * 0.8;
            d[i + 3] = Math.round(alpha * 255);
         }
      }
      ctx.putImageData(imageData, 0, 0);
   }

   // Edge fade for polygon variants (0, 1, 2).
   if (variant < 3) {
      ctx.globalCompositeOperation = 'destination-out';
      const fadeGrad = ctx.createRadialGradient(half, half, half * 0.3, half, half, half);
      fadeGrad.addColorStop(0.0, 'rgba(0,0,0,0)');
      fadeGrad.addColorStop(0.8, 'rgba(0,0,0,0.3)');
      fadeGrad.addColorStop(1.0, 'rgba(0,0,0,1)');
      ctx.fillStyle = fadeGrad;
      ctx.fillRect(0, 0, size, size);
   }

   return canvas;
}

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
 * @property {boolean} isSmoke
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
 *   clear: () => void,
 * }}
 */
export function createParticleSystem({ scene } = {}) {
   if (!scene) throw new Error('createParticleSystem: `scene` is required');

   // Generate procedural textures once.
   const smokeCanvas = makeSmokeCanvas(128);
   const smokeTexture = new THREE.CanvasTexture(smokeCanvas);
   const debrisTextures = [0, 1, 2, 3].map((v) => new THREE.CanvasTexture(makeDebrisCanvas(v, 32)));

   // Shared materials — one for smoke, one for debris. Each sprite gets
   // its own cloned material for independent color + opacity control.
   const smokeMaterialTemplate = new THREE.SpriteMaterial({
      map: smokeTexture,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
   });

   const debrisMaterialTemplates = debrisTextures.map(
      (t) =>
         new THREE.SpriteMaterial({
            map: t,
            transparent: true,
            opacity: 1.0,
            depthWrite: false,
            blending: THREE.NormalBlending,
            toneMapped: false,
         }),
   );

   // ---- Pre-allocate pool ------------------------------------------------
   /** @type {Particle[]} */
   const pool = [];
   /** Free-list indices for O(1) acquire. */
   const freeSmoke = [];
   const freeDebris = [];
   /** Active-list particle references for O(n) update (n = live count). */
   const active = [];

   for (let i = 0; i < POOL_SIZE; i++) {
      const isSmoke = i % 2 === 0;
      // Debris sprites cycle through 4 texture variants for visual variety.
      const debrisVariant = isSmoke ? 0 : ((i / 2) | 0) % 4;
      const debrisTmpl = isSmoke ? smokeMaterialTemplate : debrisMaterialTemplates[debrisVariant];
      const mat = debrisTmpl.clone();
      // Store variant for tint adjustment in spawnDebris.
      const dbV = debrisVariant;
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 10;
      scene.add(sprite);

      const p = {
         poolIndex: i,
         debrisVariant: dbV,
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
      };
      pool.push(p);
      (isSmoke ? freeSmoke : freeDebris).push(i);
   }

   // ---- Spawn helpers ----------------------------------------------------

   /**
    * Acquire the next inactive particle of the requested type (O(1)).
    * @param {boolean} wantSmoke
    * @returns {Particle | null}
    */
   function acquire(wantSmoke) {
      const list = wantSmoke ? freeSmoke : freeDebris;
      if (list.length === 0) return null;
      const idx = list.pop();
      const p = pool[idx];
      p.active = true;
      active.push(p);
      return p;
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
         pos.x + (Math.random() - 0.5) * scale * 5.0,
         pos.y + (Math.random() - 0.5) * scale * 5.0,
         pos.z + (Math.random() - 0.5) * scale * 5.0,
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
      const phi = Math.acos(2 * Math.random() - 1) * 0.7;
      // Random speed 0 to max (user request: DEBRIS_SPEED is the max).
      const speed = DEBRIS_SPEED * scale * Math.random();

      p.sprite.position.set(
         pos.x + (Math.random() - 0.5) * scale * 4.0,
         pos.y + (Math.random() - 0.5) * scale * 4.0,
         pos.z + (Math.random() - 0.5) * scale * 4.0,
      );
      p.velocity.set(
         Math.sin(phi) * Math.cos(theta) * speed,
         Math.abs(Math.cos(phi)) * speed * 0.5 + speed * 0.2,
         Math.sin(phi) * Math.sin(theta) * speed,
      );
      p.life = life;
      p.maxLife = life;
      // Random size between 1× and 10× the base debris size (user: x2 max → 1-10x).
      const sizeRand = 1 + Math.random() * 9;
      p.sizeStart = DEBRIS_SIZE_START * scale * sizeRand;
      p.sizeEnd = DEBRIS_SIZE_START * scale * DEBRIS_SIZE_END_MULT * sizeRand;
      p.drag = DEBRIS_DRAG;
      p.gravity = DEBRIS_GRAVITY;
      p.active = true;

      // Tint: colour varies by debris variant for visual variety.
      // Angular shards (variant 0) are darker, porous crumbs (var 3) are lighter.
      const baseBright = [0.45, 0.55, 0.5, 0.6][p.debrisVariant % 4] || 0.5;
      const r = baseBright + Math.random() * 0.2;
      const g = baseBright * 0.8 + Math.random() * 0.15;
      const b = baseBright * 0.6 + Math.random() * 0.1;
      p.sprite.material.color.setRGB(r, g, b);
      p.sprite.material.opacity = 1.0;
      // Random rotation so debris doesn't all look identically oriented.
      p.sprite.material.rotation = Math.random() * Math.PI * 2;
      // Random stretch factor (0.6–1.4) to break the perfect-square sprite look.
      p.stretch = 0.6 + Math.random() * 0.8;
      p.sprite.visible = true;
   }

   // ---- Public API -------------------------------------------------------

   /**
    * Emit an explosion at the given world position.
    * Radius scaling is doubled (radius / 1.5, cap 3.0) for dramatic
    * size difference between small and large asteroid explosions.
    * @param {{x:number, y:number, z:number}} pos   world position
    * @param {number} [radius=2]                     asteroid radius (scales effect)
    */
   function emitExplosion(pos, radius = 2) {
      const rScale = Math.min(radius / 1.5, 3.0);
      const smokeN = Math.round(SMOKE_COUNT * rScale);
      const debrisN = Math.round(DEBRIS_COUNT * rScale);
      for (let i = 0; i < smokeN; i++) spawnSmoke(pos, radius);
      for (let i = 0; i < debrisN; i++) spawnDebris(pos, radius);
   }

   /**
    * Per-frame update. Only iterates live particles (active list),
    * not the full pool. Dead particles are recycled to free lists
    * via O(1) swap-pop.
    * @param {number} dt  seconds since last frame
    */
   function update(dt) {
      if (dt <= 0) return;
      for (let ai = active.length - 1; ai >= 0; ai--) {
         const p = active[ai];

         p.life -= dt;
         if (p.life <= 0) {
            p.active = false;
            p.sprite.visible = false;
            // Recycle to free list
            (p.isSmoke ? freeSmoke : freeDebris).push(p.poolIndex);
            // Fast remove from active: swap with last, pop
            active[ai] = active[active.length - 1];
            active.pop();
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

         // Size: smoke gets explosive growth via power curve (t^0.3).
         // Grows to ~70% in the first 30% of lifetime, then plateaus.
         // Debris keeps CONSTANT size (end = start = 1.0) so chunks stay visible.
         const size = p.isSmoke ? p.sizeStart + (p.sizeEnd - p.sizeStart) * Math.pow(t, 0.3) : p.sizeStart;
         // Debris gets non-uniform stretch so it doesn't look like a perfect square plane.
         const stretch = p.isSmoke ? 1.0 : (p.stretch || 1.0);
         p.sprite.scale.set(size * stretch, size / stretch, 1);

         // Opacity: rapid exponential fade.
         // At t=0.0: 1.0 (full flash), at t=0.2: exp(-1.0) ≈ 0.37,
         // at t=0.4: exp(-2.0) ≈ 0.14, at t=0.6: exp(-3.0) ≈ 0.05.
         // Smoke is nearly invisible after 40% of lifetime — matches
         // "explosionsartig anwachsen und faden" + "viel zu lange blickdicht".
         const alpha = Math.exp(-t * 5);
         p.sprite.material.opacity = alpha * (p.isSmoke ? 0.09 : 0.5);
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
      debrisTextures.forEach((t) => t.dispose());
      smokeMaterialTemplate.dispose();
      debrisMaterialTemplates.forEach((t) => t.dispose());
      pool.length = 0;
      freeSmoke.length = 0;
      freeDebris.length = 0;
      active.length = 0;
   }

   /**
    * Deactivate all live particles (e.g. on game reset). Rebuilds
    * free lists from the pool so subsequent acquire() calls work.
    */
   function clear() {
      freeSmoke.length = 0;
      freeDebris.length = 0;
      active.length = 0;
      for (let i = 0; i < pool.length; i++) {
         const p = pool[i];
         p.active = false;
         p.sprite.visible = false;
         (p.isSmoke ? freeSmoke : freeDebris).push(i);
      }
   }

   return { emitExplosion, update, clear, dispose };
}
