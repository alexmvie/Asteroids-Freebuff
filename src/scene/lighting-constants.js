/**
 * Space-lighting tunables — the single source of truth for the v0.68.0
 * sun system.
 *
 * @fileoverview Mirrors the SSOT pattern of `src/scene/camera-constants.js`
 * and `src/entities/ship-constants.js`: a dedicated module that owns
 * the literal values, with consumers importing the names rather than
 * inlining magic numbers. Adjust here — every consumer follows.
 */

/**
 * Direction of the sun in world space (unit vector). The sun mesh +
 * lights sit at `ship.position + SUN_DIRECTION * SUN_DISTANCE` so the
 * sun is always on the same screen side relative to the ship, no matter
 * which chunk the ship flies through. The chosen vector points up-and-
 * to-the-right-behind, so the player sees a "high afternoon sun" by
 * default.
 *
 * MUST be a unit vector. The factory does not normalize on read.
 */
export const SUN_DIRECTION = Object.freeze({
  x: 0.45,
  y: 0.55,
  z: 0.7,
});

/**
 * Distance from the ship's position to the sun's position (world
 * units). 800 is far enough that rays from a PointLight with
 * `distance:0` are effectively parallel for the visible asteroid field,
 * yet close enough that the sun is a clearly visible (not microscopic)
 * mesh on screen.
 */
export const SUN_DISTANCE = 800;

/**
 * Radius of the visible sun sphere.
 */
export const SUN_MESH_RADIUS = 30;

/**
 * Radius of the corona/halo sphere. Renders behind the sun sphere with
 * transparent material — gives the sun a soft glow without true bloom
 * post-processing (which v0.68.0 does not have).
 */
export const SUN_CORONA_RADIUS = 70;

/**
 * Intensity of the directional (shadow-casting) sun light. The
 * directional light is the "real" sun for shadow casting; the
 * PointLight + HemisphereLight add fill.
 *
 * Tuned for MeshStandardMaterial with PBR albedo/normal/roughness maps
 * (the asteroid textures). The sun is bright enough to cast defined
 * shadows without washing out the asteroid colors.
 */
export const DIRECTIONAL_INTENSITY = 2.6;

/**
 * Intensity of the PointLight at the sun position. Per user request
 * ("ein pointlight von dort") — kept as a small omnidirectional
 * contribution with `distance:0` + `decay:0` so it acts like a far-
 * away uniform fill (functionally a DirectionalLight for the visible
 * field, but technically a PointLight so the user's literal request
 * is satisfied). The PointLight does NOT cast shadows — the
 * DirectionalLight handles that with cheaper runtime cost.
 */
export const POINT_INTENSITY = 0.45;

/**
 * Intensity of the hemisphere environment fill. Sky/ground colors give
 * a cool→warm gradient so the asteroid shadows are not all the same
 * tone — the underside reads slightly warm (bounced light from the
 * "ground"), the top reads slightly cool (space background tint).
 */
export const HEMISPHERE_INTENSITY = 0.55;

/**
 * Intensity of the pure ambient floor. Small enough that shadows are
 * still clearly visible, large enough that absolute-black zero-pixel
 * areas don't appear in deep crevices.
 */
export const AMBIENT_INTENSITY = 0.08;

/**
 * Sun color — slightly warm white (yellow tint, like real sunlight).
 * Applied to DirectionalLight.color + PointLight.color + Sun
 * MeshBasicMaterial.color (so the visible sun matches the lighting).
 */
export const SUN_COLOR = 0xfff8e7;

/**
 * Corona color — warmer yellow for the halo glow sphere.
 */
export const SUN_CORONA_COLOR = 0xffeaa0;

/**
 * HemisphereLight sky color (read from the +Y half).
 */
export const HEMISPHERE_SKY_COLOR = 0x4a6a9e;

/**
 * HemisphereLight ground color (read from the -Y half).
 */
export const HEMISPHERE_GROUND_COLOR = 0x4a3528;

/**
 * AmbientLight color — pure white (let the fill color be decided by
 * the hemisphere + sun).
 */
export const AMBIENT_COLOR = 0xffffff;

/**
 * Shadow map resolution (pixels per side). 2048² is enough for clean
 * shadows on large asteroids without crushing the framerate.
 */
export const SHADOW_MAP_SIZE = 2048;

/**
 * Orthographic shadow camera bounds (half-side, world units). The
 * shadow frustum is `+/- SHADOW_FRUSTUM_HALF_SIZE` around the ship in
 * each axis, giving a 600u × 600u shadow volume. At 2048² map size,
 * that's ~3.4 px/world-unit — the shadow of a 16u-diameter asteroid
 * spans ~54 pixels. Tight enough to keep shadows crisp inside the
 * visible asteroid field.
 *
 * Tied to the streaming bubble scale: the bubble is 7 chunks wide
 * (1400u), so 600u covers the ship + the closest 2 chunks in each
 * direction. Far chunks won't cast visible shadows (acceptable —
 * they aren't on screen).
 */
export const SHADOW_FRUSTUM_HALF_SIZE = 300;

/**
 * Shadow camera near/far (world units). Near is the closest depth the
 * shadow camera should consider (must be > 0 for orthographic); far
 * must reach beyond the sun's offset distance or shadows near the
 * far edge will clip.
 */
export const SHADOW_NEAR = 0.5;
export const SHADOW_FAR = SUN_DISTANCE * 1.5;
