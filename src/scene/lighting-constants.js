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
 * which chunk the ship flies through.
 *
 * The chosen vector points up-and-to-the-right-IN-FRONT-LOW, so the
 * player sees a "sun near the horizon" by default in the camera's
 * normal view cone (the camera at ship + (0, 7, +22) looks toward
 * -Z + look-ahead with a 62° vertical FOV centred ~14° below
 * horizontal; sun at ship + (~410, ~136, -640) lands near the top
 * of the visible field, clearly above the play plane).
 *
 * History:
 *   - v0.68.0: z = +0.7, behind follow camera for yaw=0 ships.
 *   - v0.69.0: z flipped to -0.7, in front of camera again.
 *   - v0.69.2: y reduced 0.55 -> 0.15. The v0.69.0 y=0.55 placed the
 *     sun ~33° above horizontal (above the camera's +17° upper FOV
 *     edge) so default-yaw ships saw only the sky glow. The user
 *     complained "ich sehe keine sonnenkugel — vielleicht weil ich
 *     nicht rauf und runterdrehen kann? die sonne sollte aus
 *     unserer 2d ebene sichtbar sein — versatz: nach oben". y=0.15
 *     yields ~10° above horizontal — comfortably inside the FOV.
 *     Side effect: shadows are longer and duskier (cinematic).
 *
 * MUST be a unit vector. The factory does not normalize on read.
 */
export const SUN_DIRECTION = Object.freeze({
  x: 0.45,
  y: 0.15,
  z: -0.7,
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
 *
 * v0.69.4: bumped 70 -> 100u per user "make sun twice bright" — larger
 * halo extends visibly past the 30u core mesh for a more pronounced
 * soft glow.
 */
export const SUN_CORONA_RADIUS = 100;

/**
 * Intensity of the directional (shadow-casting) sun light. The
 * directional light is the "real" sun for shadow casting; the
 * PointLight + HemisphereLight add fill.
 *
 * Tuned for MeshStandardMaterial with PBR albedo/normal/roughness maps
 * (the asteroid textures). The sun is bright enough to cast defined
 * shadows without washing out the asteroid colors.
 *
 * v0.69.4: bumped 2.6 -> 5.2 per user "make sun twice bright". Doubled
 * to push the asteroid field visibly closer to the illumination limit
 * (white albedo values saturate). HemisphereLight fill unchanged so
 * shaded undersides don’t crush to pure black — the proportional gap
 * between lit and shaded sides widens to look more "sun-washed".
 */
export const DIRECTIONAL_INTENSITY = 5.2;

/**
 * Intensity of the PointLight at the sun position. Per user request
 * ("ein pointlight von dort") — kept as a small omnidirectional
 * contribution with `distance:0` + `decay:0` so it acts like a far-
 * away uniform fill (functionally a DirectionalLight for the visible
 * field, but technically a PointLight so the user's literal request
 * is satisfied). The PointLight does NOT cast shadows — the
 * DirectionalLight handles that with cheaper runtime cost.
 *
 * v0.69.4: 0.45 -> 0.90 per user "make sun twice bright" — doubled
 * to support the doubled directional intensity without deadening
 * shadow contrast.
 */
export const POINT_INTENSITY = 0.90;

/**
 * Intensity of the hemisphere environment fill. Sky/ground colors give
 * a cool→warm gradient so the asteroid shadows are not all the same
 * tone — the underside reads slightly warm (bounced light from the
 * "ground"), the top reads slightly cool (space background tint).
 *
 * v0.69.5: 0.55 -> 0.20 per user "schatten sollten aber eher hart sein
 * im weltraum". Lower hemisphere fill means the directional light's
 * shadow side of each asteroid falls more cleanly toward shadow-tone;
 * the difference between lit and shaded surfaces widens to look more
 * "harsh sun on airless rock" (Star Wars belt aesthetic). Was clamping
 * lit surfaces to albedo saturation while keeping shaded side too
 * washed-out for vacuum realism.
 *
 * v0.71.5: 0.20 -> 0.06 (research-backed). Real asteroids have NO
 * atmospheric fill — the shadow side of a boulder is effectively
 * pitch-black next to sunlit rock (Bennu/Ryugu photos). 0.06 keeps
 * shadowed undersides just barely readable for gameplay while the
 * lit/shaded contrast reads as "vacuum", not "diffuse studio light".
 * Combined with ACESFilmicToneMapping (v0.71.5) the lit side keeps
 * albedo detail instead of saturating.
 */
export const HEMISPHERE_INTENSITY = 0.06;

/**
 * Intensity of the pure ambient floor. Small enough that shadows are
 * still clearly visible, large enough that absolute-black zero-pixel
 * areas don't appear in deep crevices.
 *
 * v0.69.5: 0.08 -> 0.04 per user "schatten sollten aber eher hart sein
 * im weltraum". Lower ambient = harder shadow contrast at the cost of
 * slightly darker crevices. The dust/regolith textures still have
 * enough albedo detail that crevices remain readable.
 *
 * v0.71.5: 0.04 -> 0.01 (research-backed). Bare floor so no absolute
 * zero-black pixels appear in the deepest crevices, but the shadow
 * sides of asteroids now fall to near-black — the real "airless
 * rock" look (albedo of carbonaceous asteroids is 0.03-0.10, and
 * with ambient 0.01 the unlit side reads as that dark).
 */
export const AMBIENT_INTENSITY = 0.01;

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
