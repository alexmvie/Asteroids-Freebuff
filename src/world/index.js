/**
 * Public surface of the world module.
 * Consumers should import from `src/world/index.js` rather than reaching
 * into individual files, so we can refactor internals freely.
 *
 * Constants are re-exported from the domain-specific files (chunk / starfield
 * / nebula) so consumers get one stable import surface. The old
 * `src/world/constants.js` shim is kept for any code that hasn't migrated
 * yet.
 */
export {
  // Chunk + asteroid (world data-model)
  CHUNK_SIZE,
  BUBBLE_RADIUS_CHUNKS,
  STREAMING_MARGIN_CHUNKS,
  MIN_ASTEROIDS_PER_CHUNK,
  MAX_ASTEROIDS_PER_CHUNK,
  DENSITY_FLOOR,
  RECENTLY_EVICTED_TTL_S,
  INITIAL_SYSTEM_SEED,
  MAX_ASTEROID_DRIFT,
  PLAY_PLANE_Y,
  NEBULA_RENDER_THRESHOLD,
  // Starfield (visual)
  STARFIELD_COUNT,
  STARFIELD_RADIUS,
  STARFIELD_SIZE,
  STARFIELD_SEED,
  // Nebula (visual)
  NEBULA_FADE_S,
  NEBULA_MAX_OPACITY,
  NEBULA_DEBUG_DEFAULT,
} from './constants.js';

export { mulberry32 } from './rng.js';
export { makeSimplex2 } from './noise.js';
export { hashChunk, densityAt, chunkHasNebula, sizeRadius, generateChunk } from './chunks.js';

// Streaming layer (added 2026): the runtime that decides which
// chunks should be live based on the ship's position. Sits one
// layer above chunks.js — chunks.js generates the data, world.js
// decides what to keep in memory.
export {
  createWorld,
  worldToChunk,
  chunkKey,
  updateStreamingBubble,
  evictStaleChunks,
  getActiveChunks,
} from './world.js';
