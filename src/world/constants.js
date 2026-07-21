/**
 * Re-export shim for backward compatibility.
 *
 * The world's tunable values used to live in a single
 * `src/world/constants.js` file. They are now split by domain into
 * the files below (SSOT, one source of truth per concern):
 *
 *   - `chunk-constants.js`  — chunk/asteroid/world data-model tunables
 *   - `starfield-constants.js` — procedural starfield visual tunables
 *   - `nebula-constants.js` — nebula skydome visual tunables
 *
 * This file re-exports every constant with the SAME NAME so existing
 * `import { X } from './world/constants.js'` statements continue to
 * work unchanged. New code should import from the domain-specific
 * file directly.
 *
 * @fileoverview Compatibility shim. See the per-domain files for
 * authoritative documentation.
 */

export {
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
} from './chunk-constants.js';

export {
  STARFIELD_COUNT,
  STARFIELD_RADIUS,
  STARFIELD_SIZE,
  STARFIELD_SEED,
} from './starfield-constants.js';

export {
  NEBULA_FADE_S,
  NEBULA_MAX_OPACITY,
  NEBULA_DEBUG_DEFAULT,
} from './nebula-constants.js';
