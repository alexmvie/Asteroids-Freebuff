/**
 * JSDoc type definitions for the chunked world data model.
 * See SPEC.md for the full design rationale.
 *
 * @fileoverview This file contains only JSDoc typedefs — no runtime code.
 * Editors and (optionally) a JSDoc-aware type checker consume these.
 * Keeping them in a single file makes the data model easy to find and
 * refactor as the project grows toward Elite.
 */

/**
 * A 3D vector in world space.
 * @typedef {Object} Vec3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * Asteroid size tier.
 *   0 = large
 *   1 = medium
 *   2 = small
 * @typedef {0|1|2} AsteroidSize
 */

/**
 * Integer chunk coordinates plus the system seed that scopes this chunk's
 * identity. Together, these uniquely and deterministically identify a chunk
 * within the (possibly multi-system) universe.
 * @typedef {Object} ChunkId
 * @property {number} cx
 * @property {number} cz
 * @property {number} systemSeed
 */

/**
 * Pure data describing an asteroid. The entity layer turns a spec into a
 * live mesh; the spec itself must remain pure (no Three.js references,
 * no closures, no time-based state) so chunk regeneration is reproducible.
 *
 * @typedef {Object} AsteroidSpec
 * @property {string}   id          // stable within the chunk, e.g. "12-7-3"
 * @property {Vec3}     position    // world space
 * @property {number}   radius      // collision + render radius
 * @property {AsteroidSize} size
 * @property {Vec3}     axis        // unit rotation axis
 * @property {number}   spin        // rad/s, around `axis`
 * @property {Vec3}     velocity    // ambient drift
 * @property {number}   seed        // for procedural mesh variation
 */

/**
 * A chunk's full data, plus cached density for inspection/debugging.
 * @typedef {Object} Chunk
 * @property {ChunkId} id
 * @property {AsteroidSpec[]} asteroids
 * @property {number}  densityNoise    // cached [0,1] density at chunk center
 * @property {boolean} generated
 */

/**
 * Streaming-layer state. The only mutable top-level world structure.
 * Keys in `active` and `recentlyGone` are strings of the form "cx,cz"
 * (the canonical chunk key from `chunkKey(cx, cz)` in `world.js`).
 *
 * `active` stores chunks by their bare Chunk object — they're live
 * and their entities exist in the scene.
 *
 * `recentlyGone` stores **envelopes** of the form
 * `{ chunk: Chunk, evictedAt: number }` so the soft-cache layer can
 * enforce the `RECENTLY_EVICTED_TTL_S` TTL on re-entry. The envelope
 * is an internal detail of the streaming layer; consumers reading
 * `recentlyGone` (currently nobody does — only `evictStaleChunks`
 * and `updateStreamingBubble`) must unwrap `.chunk` to get the data.
 *
 * @typedef {Object} World
 * @property {Map<string, Chunk>} active
 * @property {Map<string, { chunk: Chunk, evictedAt: number }>} recentlyGone
 * @property {number} systemSeed
 */

// Empty export so this file is treated as an ES module by tooling.
export {};
