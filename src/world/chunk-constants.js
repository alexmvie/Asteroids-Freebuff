/**
 * Chunk-generation + asteroid constants for the chunked asteroid field.
 * This is the single source of truth for the world data-model layer's
 * tunable values. See SPEC.md for the full design rationale.
 *
 * @fileoverview Previously consolidated in `src/world/constants.js`.
 * Extracted to its own file so the world layer has a clean SSOT for
 * chunk/asteroid values (separated from the visual-system constants
 * that live in the same file historically).
 */

/** World units per chunk side. */
export const CHUNK_SIZE = 200;

/**
 * Number of chunks (in each direction) within the active streaming bubble
 * around the ship. The active region is a square of (2 * BUBBLE_RADIUS_CHUNKS + 1)
 * chunks per side, centered on the ship's chunk.
 */
export const BUBBLE_RADIUS_CHUNKS = 3;

/**
 * Soft pre-load margin (in chunks) beyond the active bubble.
 * Reserved for future pre-fetch optimization; not used in MVP.
 */
export const STREAMING_MARGIN_CHUNKS = 1;

/**
 * Lower bound on asteroids per chunk when density > DENSITY_FLOOR.
 */
export const MIN_ASTEROIDS_PER_CHUNK = 1;

/**
 * Upper bound on asteroids per chunk in dense pockets.
 */
export const MAX_ASTEROIDS_PER_CHUNK = 12;

/**
 * Chunks with density below this floor spawn 0 asteroids (void zones).
 * Value in [0, 1].
 */
export const DENSITY_FLOOR = 0.1;

/**
 * TTL (seconds) that an evicted chunk is held in the recently-evicted cache
 * before being fully dropped. Allows fast re-entry without regeneration.
 */
export const RECENTLY_EVICTED_TTL_S = 10;

/**
 * Initial system seed for MVP. A single constant star-system.
 * In the future this will be replaced by a per-jump system seed (Elite hook).
 */
export const INITIAL_SYSTEM_SEED = 0xa570e210 >>> 0;

/**
 * Maximum ambient drift speed for asteroids, in world units per second.
 * Asteroids slowly translate through space; this caps the magnitude.
 */
export const MAX_ASTEROID_DRIFT = 0.5;

/**
 * Fixed Y coordinate for ship and asteroids in the 2DOF MVP.
 * Y is reserved in all data structures so the 6DOF upgrade is non-breaking.
 */
export const PLAY_PLANE_Y = 0;

/**
 * Background nebula density threshold for rendering. Only chunks with
 * density above this value will have nebulae drawn. Value in [0, 1].
 * (Consumed by the streaming / nebula-volume layer, not the visual
 * skydome. The skydome fades independently of this threshold.)
 */
export const NEBULA_RENDER_THRESHOLD = 0.1;

/**
 * v0.69.6 — Asteroid shape enumeration (single source of truth).
 *
 * Each named type is rendered by a distinct geometry builder in
 * `src/entities/asteroid.js` (crystalline_shard → cylindrical
 * CylinderGeometry+jitter, cratered_potato → Capsule+crater
 * displacement, contact_binary → dual-icosphere peanut, craggy_rock
 * → Icosphere+craggy displacement). The strings are the canonical
 * IDs persisted on `AsteroidSpec.shape`; the entity factory
 * translates them to integer shapeType values via `shapeToIndex`
 * in `src/world/chunks.js`.
 *
 * Why an enum and not just integers: the SSOT for the shape
 * taxonomy lives here so the data-model layer (chunk generation,
 * test fixtures) and the entity layer (geometry dispatch) agree.
 * v0.69.5 dropped the legacy shapeType=3 'torus' (the donut, which
 * the user reported as "idiotisch") — the v0.69.6 enum therefore
 * has 4 entries, not 5.
 */
export const SHAPE_TYPES = Object.freeze({
  CRYSTALLINE_SHARD: 'crystalline_shard',
  CRATERED_POTATO: 'cratered_potato',
  CONTACT_BINARY: 'contact_binary',
  CRAGGY_ROCK: 'craggy_rock',
});

/**
 * v0.69.6 — Per-shape-type distribution weights (percentages,
 * must sum to 100). See `pickShapeType` in `src/world/chunks.js`
 * for the cumulative-distribution sampler.
 *
 * VISUAL GOAL — more variety in the asteroid field:
 *   - v0.69.5 removed the donut/torus shape, leaving craggy_rock in
 *     2 of the 5 shapeType slots → craggy combined = 40% of the
 *     field, which reads as monotonous when flying through.
 *   - crystalline_shard and cratered_potato have the most
 *     distinctive alien silhouettes (cylinder vs capsule, regular
 *     vs cratered); boosting them breaks the icosphere-monoculture.
 *   - contact_binary pulled back to 10% so it remains an
 *     occasional "wtf is that?" variety rather than recurring
 *     eye-candy.
 *
 * TARGET DISTRIBUTION (single-source-of-truth edit point — bumping
 * these numbers is the only knob to rebalance the field):
 *   - crystalline_shard: 30% (was ~20%)
 *   - cratered_potato:   30% (was ~20%)
 *   - contact_binary:    10% (was ~20%)
 *   - craggy_rock:       30% (was ~40%)
 */
export const SHAPE_WEIGHTS = Object.freeze({
  crystalline_shard: 30,
  cratered_potato: 30,
  contact_binary: 10,
  craggy_rock: 30,
});

/**
 * v0.69.6 — Sum-validates `SHAPE_WEIGHTS` (must total 100).
 * Exported so tests can call it explicitly; the module-load
 * assertion in `src/world/chunks.js` also fails fast if a future
 * edit accidentally breaks the sum.
 *
 * @param {Record<string, number>} [w]  Defaults to SHAPE_WEIGHTS.
 * @returns {boolean}
 */
export function validateShapeWeights(w = SHAPE_WEIGHTS) {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return sum === 100;
}
