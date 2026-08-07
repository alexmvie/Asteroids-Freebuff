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
 * `src/entities/asteroid.js` (spinning_top → icosphere with latitudinal
 * equatorial ridge like Bennu/Ryugu, cratered_potato → Capsule + real
 * carved crater geometry, rubble_pile → N-lobe contact pile like
 * Itokawa, elongated_potato → stretched icosphere like Eros,
 * craggy_rock → Icosphere + ridged displacement). The strings are the
 * canonical IDs persisted on `AsteroidSpec.shape`; the entity factory
 * translates them to integer shapeType values via `shapeToIndex`
 * in `src/world/chunks.js`.
 *
 * History: v0.69.5 dropped the legacy shapeType=3 'torus' (donut).
 * v0.71.5 (research-backed — Bennu/Ryugu/Itokawa/Eros spacecraft
 * imagery) replaced 'crystalline_shard' (looked like a crystal, not
 * an asteroid) with 'spinning_top', generalized 'contact_binary'
 * (2 lobes) to 'rubble_pile' (3–6 lobes, Itokawa-style), and added
 * 'elongated_potato' (Eros-style 1.6× stretch). The enum therefore
 * has 5 entries.
 */
export const SHAPE_TYPES = Object.freeze({
  SPINNING_TOP: 'spinning_top',
  CRATERED_POTATO: 'cratered_potato',
  RUBBLE_PILE: 'rubble_pile',
  ELONGATED_POTATO: 'elongated_potato',
  CRAGGY_ROCK: 'craggy_rock',
});

/**
 * v0.69.6 — Per-shape-type distribution weights (percentages,
 * must sum to 100). See `pickShapeType` in `src/world/chunks.js`
 * for the cumulative-distribution sampler.
 *
 * v0.71.5 — Rebalanced for the 5-shape realistic pool:
 *   - spinning_top: 20% — iconic Bennu/Ryugu silhouette
 *   - cratered_potato: 25% — the "classic" asteroid, with real
 *     carved crater bowls (v0.71.5 Worley craters)
 *   - rubble_pile: 15% — Itokawa-style loose contact pile
 *   - elongated_potato: 15% — Eros-style stretched rock
 *   - craggy_rock: 25% — ridged irregular monolith
 */
export const SHAPE_WEIGHTS = Object.freeze({
  spinning_top: 20,
  cratered_potato: 25,
  rubble_pile: 15,
  elongated_potato: 15,
  craggy_rock: 25,
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

// -----------------------------------------------------------------------
// v0.71.0 — Asteroid size tier SSOT
// -----------------------------------------------------------------------

/**
 * v0.71.0 — Asteroid size tier integer enum.
 *
 * Used as the type for `AsteroidSpec.size` (see `src/world/types.js`).
 * Each value indexes into `ASTEROID_RADIUS_BY_SIZE` for the world-space
 * radius and into `ASTEROID_SIZE_WEIGHTS` for the per-tier distribution
 * weight in chunk generation.
 *
 *   - 0 = LARGE   (radius 8)  — the v0.69.x "big" tier
 *   - 1 = MEDIUM  (radius 4)  — average asteroid
 *   - 2 = SMALL   (radius 2)  — fragment splinters
 *   - 3 = HUGE    (radius 30) — NEW v0.71.0: 10× SHIP_RADIUS, the
 *                                "really huge" tier the user asked
 *                                for. Apex tier: doesn't split on
 *                                destruction (asteroid.js's split()
 *                                guard `if (spec.size >= 2) return [];`
 *                                already covers this — size 3 is
 *                                >= 2 so it never produces children).
 */
export const ASTEROID_SIZE = Object.freeze({
  LARGE: 0,
  MEDIUM: 1,
  SMALL: 2,
  HUGE: 3,
});

/**
 * v0.71.0 — Per-tier world-space radius (single source of truth).
 *
 * Used by both rendering (`src/entities/asteroid.js` reads
 * `spec.radius` to size its LOD geometry) and collision
 * (`src/systems/collision.js` reads `spec.radius` for sphere tests).
 * Same radius for visual and physics — keeps the sphere-sphere
 * collision honest against what the player sees.
 *
 * HUGE = 30 (= 10 × SHIP_RADIUS = 10 × 3.0) matches the user's
 * "really huge like 10x ship size" target.
 *
 * Fits well inside the streaming bubble: BUBBLE_RADIUS_CHUNKS=3
 * × CHUNK_SIZE=200 = 600u radius bubble, so a 30u radius (60u
 * diameter) huge asteroid is <10% of the bubble radius.
 */
export const ASTEROID_RADIUS_BY_SIZE = Object.freeze({
  0: 8,   // LARGE
  1: 4,   // MEDIUM
  2: 2,   // SMALL
  3: 30,  // HUGE
});

/**
 * v0.71.0 — Per-tier distribution weights (percentages, must sum to 100).
 *
 * TARGET DISTRIBUTION (single-source-of-truth edit point — bumping
 * these numbers is the only knob to rebalance the size field):
 *   - small:  35%  (was 30% — bumped from 30% to compensate for
 *                    the new huge tier stealing share from the
 *                    small/medium/large bulk)
 *   - medium: 35%  (was 40%)
 *   - large:  25%  (was 30%)
 *   - huge:    5%  (NEW; rare "really huge" tier)
 *
 * Visual goal: at ~300 asteroids in the streaming bubble,
 * 5% huge = ~15 huge. Frequent enough to read as a recurring
 * visual landmark without crowding the field with monsters.
 *
 * Cumulative-distribution sampler lives in `src/world/chunks.js`
 * (see `pickSize`).
 */
export const ASTEROID_SIZE_WEIGHTS = Object.freeze({
  0: 25,  // LARGE
  1: 35,  // MEDIUM
  2: 35,  // SMALL
  3: 5,   // HUGE
});

/**
 * v0.71.0 — Sum-validates `ASTEROID_SIZE_WEIGHTS` (must total 100).
 * Same fail-fast contract as `validateShapeWeights`.
 *
 * @param {Record<number, number>} [w]  Defaults to ASTEROID_SIZE_WEIGHTS.
 * @returns {boolean}
 */
export function validateSizeWeights(w = ASTEROID_SIZE_WEIGHTS) {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return sum === 100;
}

/**
 * v0.71.0 — Score table (mirrors `SCORE_BY_SIZE` in
 * `src/systems/collision.js` but lives in the data-model layer as
 * the SSOT for size-tier scoring values).
 *
 *   - 0 = LARGE:  20 pts (classic Asteroids convention)
 *   - 1 = MEDIUM: 50 pts
 *   - 2 = SMALL:  100 pts (small = high value, classic Asteroids)
 *   - 3 = HUGE:   200 pts (NEW: 2× small reward for the rare apex kill;
 *                       rewards the player for engaging the dangerous
 *                       tier without trivializing it).
 *
 * `SCORE_BY_SIZE` in collision.js re-exports this so existing UI
 * consumers stay backward-compatible.
 */
export const ASTEROID_SCORE_BY_SIZE = Object.freeze({
  0: 20,   // LARGE
  1: 50,   // MEDIUM
  2: 100,  // SMALL
  3: 200,  // HUGE (v0.71.0)
});
