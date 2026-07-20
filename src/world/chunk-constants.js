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
 * v0.67.x — Per-asteroid probability [0.0, 1.0] of opting into the
 * "realistic" visual variant (textured PBR + 5 procedural shape
 * types in src/entities/realistic-asteroid.js) instead of the
 * standard noise-displaced asteroid type (noisy icosphere or
 * jittered capsule in src/entities/asteroid.js).
 *
 * The decision is a per-ASTEROID deterministic derivation from
 * `spec.seed` (byte 8–15 compared against `floor(WEIGHT * 256)`)
 * — zero added rng calls in `generateChunk`, so the existing chunk
 * seed sequence stays identical and `tests/world.test.js` keeps
 * passing without test snapshot churn.
 *
 * Per-asteroid (NOT per-chunk) decision so every chunk contains a
 * mix of both types at the configured proportion, instead of
 * all-or-nothing zones that would produce visible "realistic
 * pocket" artefacts as the ship traverses the streaming bubble.
 *
 *   0.0 = all standard, 1.0 = all realistic.
 *   0.3 = the project's recommended mix (per user request,
 *         "realistic dominant enough to be visible, standard
 *         still common enough to feel familiar").
 *
 * The dispatcher in `src/entities/asteroid.js`
 * (`createAsteroidFromSpec`) reads `spec.type` and routes to
 * the matching factory; split children inherit the parent's
 * `spec.type` in both factories so multi-generation splits
 * stay visually consistent.
 */
export const REALISTIC_ASTEROID_WEIGHT = 0.3;
