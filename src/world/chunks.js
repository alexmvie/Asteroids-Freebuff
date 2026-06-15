/**
 * Pure functions for the chunked asteroid-field world.
 * See SPEC.md for the full design rationale.
 *
 * @fileoverview No side effects, no Three.js, no DOM, no global state.
 *   Every public function in this module is a pure function of its inputs
 *   (modulo the cost of constructing an internal simplex permutation per
 *   call, which is deterministic given the same `systemSeed`).
 */
import { mulberry32 } from './rng.js';
import { makeSimplex2 } from './noise.js';
import {
  CHUNK_SIZE,
  MIN_ASTEROIDS_PER_CHUNK,
  MAX_ASTEROIDS_PER_CHUNK,
  DENSITY_FLOOR,
  NEBULA_RENDER_THRESHOLD,
  MAX_ASTEROID_DRIFT,
  PLAY_PLANE_Y,
} from './constants.js';

// ---------------------------------------------------------------------------
// Chunk hash
// ---------------------------------------------------------------------------

/**
 * 32-bit FNV-1a-style hash mixing integer chunk coords with a system seed.
 * Pure, allocation-free, deterministic.
 *
 * @param {number} cx          Integer chunk X coordinate.
 * @param {number} cz          Integer chunk Z coordinate.
 * @param {number} systemSeed  Per-system seed (Elite hook).
 * @returns {number}           32-bit unsigned integer in [0, 2^32).
 */
export function hashChunk(cx, cz, systemSeed) {
  let h = (systemSeed ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ (cx & 0xffff), 0x01000193) >>> 0;
  h = Math.imul(h ^ (cz & 0xffff), 0x01000193) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Density noise
// ---------------------------------------------------------------------------

/**
 * Two-octave 2D simplex sample at the chunk center, mapped to [0, 1].
 *
 * The first octave has a large period (~600 units) for big pockets of
 * dense or empty space. The second octave is finer (~120 units) for
 * local variation. Output is clamped to [0, 1].
 *
 * @param {number} cx
 * @param {number} cz
 * @param {number} systemSeed
 * @returns {number} Density in [0, 1].
 */
export function densityAt(cx, cz, systemSeed) {
  const simplex2 = makeSimplex2(systemSeed);
  const wx = (cx + 0.5) * CHUNK_SIZE;
  const wz = (cz + 0.5) * CHUNK_SIZE;
  const n1 = simplex2(wx * 0.0015, wz * 0.0015); // large pockets
  const n2 = simplex2(wx * 0.008,   wz * 0.008);   // local detail
  const raw = 0.5 * (n1 + 1) * 0.7 + 0.3 * (n2 + 1) * 0.3;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

// ---------------------------------------------------------------------------
// Nebula gating
// ---------------------------------------------------------------------------

/**
 * Whether a chunk's density noise is dense enough to render a per-chunk
 * nebula volume. Pure, deterministic function of (cx, cz, systemSeed).
 *
 * The threshold is global (one constant for the whole system) — the
 * underlying density noise does the per-chunk gating. Future per-system
 * variation can be added by switching this to a system-seeded lookup.
 *
 * @param {{cx:number,cz:number,systemSeed:number}} id
 * @returns {boolean} true if the chunk's density at the chunk center
 *   exceeds `NEBULA_RENDER_THRESHOLD`.
 */
export function chunkHasNebula(id) {
  return densityAt(id.cx, id.cz, id.systemSeed) > NEBULA_RENDER_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Generation helpers
// ---------------------------------------------------------------------------

/** @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Map an asteroid size tier to its world-space radius.
 * @param {0|1|2} size
 * @returns {number}
 */
export function sizeRadius(size) {
  if (size === 0) return 8;  // large
  if (size === 1) return 4;  // medium
  return 2;                  // small
}

/**
 * Uniform random size pick. (Could later be density-biased by passing
 * `density` in from the caller; kept simple for MVP.)
 * @param {() => number} rng
 * @returns {0|1|2}
 */
function pickSize(rng) {
  const r = rng();
  if (r < 0.3) return 0; // large
  if (r < 0.7) return 1; // medium
  return 2;              // small
}

/**
 * Sample a unit vector uniformly on the sphere.
 * @param {() => number} rng
 * @returns {{x:number,y:number,z:number}}
 */
function randomUnitVec3(rng) {
  const z = 1 - 2 * rng();
  const phi = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
}

/**
 * Sample a small drift vector in the XZ plane (Y=0) with magnitude <= maxSpeed.
 * @param {() => number} rng
 * @param {number} maxSpeed
 * @returns {{x:number,y:number,z:number}}
 */
function randomDriftVec3(rng, maxSpeed) {
  return {
    x: (rng() * 2 - 1) * maxSpeed,
    y: 0,
    z: (rng() * 2 - 1) * maxSpeed,
  };
}

// ---------------------------------------------------------------------------
// generateChunk (the headline pure function)
// ---------------------------------------------------------------------------

/**
 * Generate a chunk's full data deterministically from its ChunkId.
 *
 * @param {{cx:number,cz:number,systemSeed:number}} id
 * @returns {{
 *   id: {cx:number,cz:number,systemSeed:number},
 *   asteroids: Array<object>,
 *   densityNoise: number,
 *   generated: boolean
 * }}
 */
export function generateChunk(id) {
  const rng = mulberry32(hashChunk(id.cx, id.cz, id.systemSeed));
  const density = densityAt(id.cx, id.cz, id.systemSeed);

  let count;
  if (density < DENSITY_FLOOR) {
    count = 0;
  } else {
    count = Math.round(
      lerp(MIN_ASTEROIDS_PER_CHUNK, MAX_ASTEROIDS_PER_CHUNK, density),
    );
  }

  const asteroids = [];
  for (let i = 0; i < count; i++) {
    const size = pickSize(rng);
    asteroids.push({
      id: `${id.cx}-${id.cz}-${i}`,
      position: {
        x: (id.cx + rng()) * CHUNK_SIZE,
        y: PLAY_PLANE_Y,
        z: (id.cz + rng()) * CHUNK_SIZE,
      },
      radius: sizeRadius(size),
      size,
      axis: randomUnitVec3(rng),
      spin: lerp(0.1, 0.8, rng()),
      velocity: randomDriftVec3(rng, MAX_ASTEROID_DRIFT),
      seed: (rng() * 1e9) | 0,
    });
  }

  return {
    id: { cx: id.cx, cz: id.cz, systemSeed: id.systemSeed },
    asteroids,
    densityNoise: density,
    hasNebula: chunkHasNebula(id),
    generated: true,
  };
}
