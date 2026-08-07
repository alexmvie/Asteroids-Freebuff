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
  // v0.69.6 — shape-distribution SSOT (re-exported from the shim
  // so chunks.js's `import { SHAPE_TYPES, ... } from './constants.js'`
  // resolves through chunk-constants.js, matching the SHIM pattern
  // documented at the top of this file).
  SHAPE_TYPES,
  SHAPE_WEIGHTS,
  validateShapeWeights,
  // v0.71.1 — size-tier SSOT (same re-export pattern as the SHAPE_*
  // block above). `src/world/chunks.js`'s `sizeRadius()` /
  // `pickSize()` and the `validateSizeWeights()` guard all import
  // from './constants.js' for backward-compat with the SHIM pattern;
  // those branches only resolved when this shim gained these
  // re-exports, fixing the `SyntaxError: does not provide an export
  // named 'ASTEROID_RADIUS_BY_SIZE'` that broke tests/world.test.js,
  // tests/asteroid.test.js, and tests/powerup-system.test.js.
  ASTEROID_RADIUS_BY_SIZE,
  ASTEROID_SIZE_WEIGHTS,
  validateSizeWeights,
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
