/**
 * Starfield visual constants.
 * Single source of truth for the procedural Three.js Points starfield
 * (see `src/systems/starfield.js`).
 *
 * @fileoverview Previously consolidated in `src/world/constants.js`.
 * Extracted to its own file so visual-system constants aren't mixed
 * with world-data-model constants.
 */

/** Number of stars in the procedural starfield. */
export const STARFIELD_COUNT = 4000;

/**
 * Base radius of the star sphere. The actual placement is
 * `radius × (0.85 + random × 0.3)`, so the spread is
 * `[0.85 * radius, 1.15 * radius]`.
 */
export const STARFIELD_RADIUS = 2500;

/** Point size for each star (sizeAttenuation: false, so this is in screen pixels). */
export const STARFIELD_SIZE = 1.4;

/**
 * Seed for the deterministic starfield. The starfield is purely
 * decorative (not part of the gameplay world), but seeding it makes
 * the star pattern "fixed" across reloads — the same constellation
 * shows up on every page load. Set to `null` to fall back to
 * `Math.random()` (the original behavior).
 */
export const STARFIELD_SEED = 0xc0ffee;
