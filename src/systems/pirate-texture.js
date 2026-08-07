/**
 * Pirate texture — procedural canvas texture for the pirate ships.
 *
 * Renders once on a power-of-two canvas (256x256) using the standard
 * 2D context API and wraps the result as a Three.js CanvasTexture.
 * Applied to pirate ship materials (body + wings as color map, engine
 * glow as emissive map) so the pirates look visibly distinct from the
 * smooth white/cyan player and demo AI ships.
 *
 * Design
 * ------
 *   - **Base**: dark charcoal (#1a1a1a) -- reads as "industrial" /
 *     "hostile" rather than the player's clean off-white body.
 *   - **Hazard stripes**: alternating dark-red (#aa2222) and base
 *     charcoal, drawn at 45° across the full canvas. 6 stripes across
 *     the 256px width = ~42px stripe period.
 *   - **Warning triangles**: 4 small amber (#ffaa00) triangles
 *     scattered around the canvas (deterministic positions via a
 *     mulberry31 RNG so the texture is reproducible across reloads).
 *     They reinforce "hostile NPC" without going full skull motif.
 *
 * The canvas is the Single Source of Truth for the texture content.
 * `createPirateTexture({ size, seed })` is pure -- the same `(size,
 * seed)` always produces the same pixels. The factory is safe to call
 * once at boot, then cache the texture and reuse for both pirate ships.
 *
 * Browser-only
 * ------------
 * This factory uses `document.createElement('canvas')` and the 2D
 * context. In Node tests it throws -- consumers should treat the
 * factory as browser-only (it's wired in `src/main.js` at game boot,
 * not from any Node-testable code path).
 *
 * @file src/systems/pirate-texture.js
 */

import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

// ------------------------------------------------------------------
// Internal: pure helpers for the canvas drawing
// ------------------------------------------------------------------

/**
 * Mulberry32 PRNG factory. Seeded for reproducibility.
 * @param {number} seed
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paint a charcoal + diagonal-red hazard-stripe pattern onto `ctx`.
 * Pure visual side effect on the canvas; deterministic given `ctx` +
 * `size`.
 */
function paintHazardStripes(ctx, size) {
  // Base charcoal fill.
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, size, size);

  // Diagonal stripes. 6 stripes at 45° alternating dark-red + base.
  const stripeCount = 6;
  const stripeWidth = (size * 2) / stripeCount;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.translate(-size, -size);
  for (let i = 0; i < stripeCount * 2; i++) {
    ctx.fillStyle = (i % 2 === 0) ? '#aa2222' : '#1a1a1a';
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, size * 2);
  }
  ctx.restore();
}

/**
 * Paint 4 amber warning triangles at deterministic positions. Pure
 * side effect on `ctx`.
 */
function paintWarningTriangles(ctx, size, rng) {
  ctx.fillStyle = '#ffaa00';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  const radius = size * 0.06;
  const positions = [];
  for (let i = 0; i < 4; i++) {
    // Deterministic positions: mulberry32 advances each iteration.
    const cx = size * (0.15 + rng() * 0.7);
    const cy = size * (0.15 + rng() * 0.7);
    positions.push({ cx, cy });
  }
  for (const { cx, cy } of positions) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx + radius, cy + radius);
    ctx.lineTo(cx - radius, cy + radius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// ------------------------------------------------------------------
// Public factory
// ------------------------------------------------------------------

/**
 * Create the procedural pirate texture. Returns a `THREE.CanvasTexture`
 * ready to use as `material.map` (albedo) or `material.emissiveMap`.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=256] — canvas size (must be power-of-2 for
 *                  WebGL mipmapping).
 * @param {number} [opts.seed=1337] — RNG seed for triangle placement.
 *                  Different seeds produce different triangle layouts;
 *                  same seed always reproduces the same canvas.
 * @param {number} [opts.repeat=2] — texture.repeat set to (repeat,
 *                  repeat). 2x2 tiling makes the stripes look
 *                  finer-grained on the ship mesh than the canvas
 *                  suggests.
 * @returns {THREE.CanvasTexture}
 */
export function createPirateTexture({ size = 256, seed = 1337, repeat = 2 } = {}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('createPirateTexture: requires a browser environment (document.createElement)');
  }
  if (size <= 0 || (size & (size - 1)) !== 0) {
    throw new Error(`createPirateTexture: size must be a positive power of 2 (got ${size})`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('createPirateTexture: 2D context unavailable');
  }

  // Paint layers in order: charcoal base -> hazard stripes -> warning triangles.
  const rng = mulberry32(seed);
  paintHazardStripes(ctx, size);
  paintWarningTriangles(ctx, size, rng);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  // sRGB decoding so the reds don't get gamma-clipped to near-black.
  // Emissive use still works correctly because modern three.js
  // expects sRGB-encoded textures and applies the inverse at sample.
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Apply the pirate texture to a ship's body + wing materials (as color
 * map) and to its engine glow (as emissive map). Walks the ship's
 * mesh tree and operates on every Mesh that owns a material. The
 * `tintShipAs(colorHex)` call (from v0.56.0) is typically applied
 * FIRST so the canvas colors are blended with the red tint.
 *
 * @param {object} ship — ship object returned by `createShip`
 * @param {THREE.Texture} texture — the result of `createPirateTexture()`
 */
export function applyPirateTexture(ship, texture) {
  if (!ship || !ship.mesh || !texture) {
    throw new Error('applyPirateTexture: ship and texture are required');
  }
  ship.mesh.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      if (obj.userData && obj.userData.isEngineGlow) {
        obj.material.emissiveMap = texture;
      } else {
        obj.material.map = texture;
      }
      obj.material.needsUpdate = true;
    }
  });
}
