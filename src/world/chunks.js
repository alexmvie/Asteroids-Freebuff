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
  SHAPE_TYPES,
  SHAPE_WEIGHTS,
  validateShapeWeights,
} from './constants.js';

// v0.69.6 — fail fast if SHAPE_WEIGHTS is malformed (sum != 100).
// Catches drift during development: if a future edit bumps one
// weight without compensating the others, the sampler would assign
// some asteroids to a non-existent bucket or skip the last bucket
// entirely. Better to throw at module-load than to silently corrupt
// the streaming field's distribution on every page load.
if (!validateShapeWeights()) {
  const sum = Object.values(SHAPE_WEIGHTS).reduce((a, b) => a + b, 0);
  throw new Error(`SHAPE_WEIGHTS must sum to 100, got ${sum}`);
}

// v0.69.6 — inverse of SHAPE_TYPES. Maps a named shape to the
// legacy integer shapeType used by `src/entities/asteroid.js`'s
// `buildAsteroidMesh` switch (0 = crystalline, 1 = cratered,
// 2 = binary, 3 = craggy). Lives in the data-model layer so the
// entity factory stays decoupled from SHAPE_TYPES' string IDs —
// only `pickShapeType` (which produces the string names) is
// called by chunk generation; only `shapeToIndex` (which consumes
// the strings) is called by the entity factory.
const SHAPE_TO_INDEX = Object.freeze({
  crystalline_shard: 0,
  cratered_potato: 1,
  contact_binary: 2,
  craggy_rock: 3,
});

/**
 * v0.69.6 — Inverse of SHAPE_TYPES. Returns the integer shapeType
 * that the entity factory uses to dispatch geometry builders.
 * Defensive: unknown shapes fall back to craggy_rock (3) so a
 * future SHAPE_TYPES addition without a matching SHAPE_TO_INDEX
 * entry never produces a non-asteroid entity.
 *
 * @param {string} shape  One of SHAPE_TYPES values.
 * @returns {0|1|2|3}
 */
export function shapeToIndex(shape) {
  const idx = SHAPE_TO_INDEX[shape];
  return typeof idx === 'number' ? idx : 3;
}

/**
 * v0.69.6 — Cumulative-distribution sampler over SHAPE_WEIGHTS.
 * Pure function of `rng()`. Returns one of the SHAPE_TYPES values,
 * preserving the chunk's deterministic sequence (same (cx, cz,
 * systemSeed) → same shape stream).
 *
 * Algorithm: draw r ~ [0, 100), walk SHAPE_WEIGHTS in declaration
 * order accumulating the cumulative sum, return the first bucket
 * whose cumulative exceeds r. Object.entries on a frozen plain
 * object preserves insertion order. The fallback at the bottom
 * handles a degenerate `rng = () => 1` (returns the last bucket)
 * — should never trigger in practice because `mulberry32` returns
 * values in [0, 1).
 *
 * @param {() => number} rng   Returns [0, 1).
 * @returns {string}           A SHAPE_TYPES key (e.g. 'crystalline_shard').
 */
export function pickShapeType(rng) {
  const r = rng() * 100; // [0, 100)
  let cum = 0;
  for (const [k, w] of Object.entries(SHAPE_WEIGHTS)) {
    cum += w;
    if (r < cum) return k;
  }
  const entries = Object.keys(SHAPE_WEIGHTS);
  return entries[entries.length - 1]; // defensive: r === 100.0
}

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

  // v0.68.0 — every asteroid is now the textured-PBR realistic
  // variant. The v0.67.x per-asteroid realistic-vs-standard mix
  // was removed by user request ("alte Asteroiden komplett raus").
  // The pure chunk-seed sequence below is unchanged, so the
  // deterministic invariants in tests/world.test.js still pass.
  //
  // v0.69.6 — per-shape-type distribution. pickShapeType(rng)
  // consumes one extra rng() value per asteroid (picked FIRST,
  // before size/position/axis/etc.) so the entity layer can read
  // `spec.shape` instead of falling back to `spec.seed % 5` (the
  // uniform distribution that made craggy_rock a 40% monolithic
  // after the v0.69.5 donut removal). The seed stream shifts
  // downstream, which is fine: no test pins specific values, only
  // invariants (determinism, axis-unit, drift cap, etc.) — all
  // of which the new stream still satisfies.
  const asteroids = [];
  for (let i = 0; i < count; i++) {
    const shape = pickShapeType(rng);
    const size = pickSize(rng);
    const px = (id.cx + rng()) * CHUNK_SIZE;
    const pz = (id.cz + rng()) * CHUNK_SIZE;
    const axis = randomUnitVec3(rng);
    const spin = lerp(0.1, 0.8, rng());
    const velocity = randomDriftVec3(rng, MAX_ASTEROID_DRIFT);
    const seed = (rng() * 1e9) | 0;
    asteroids.push({
      id: `${id.cx}-${id.cz}-${i}`,
      shape,
      position: { x: px, y: PLAY_PLANE_Y, z: pz },
      radius: sizeRadius(size),
      size,
      axis,
      spin,
      velocity,
      seed,
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
