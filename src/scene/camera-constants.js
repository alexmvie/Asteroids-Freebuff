/**
 * Follow-camera tunables — the single source of truth for the
 * chase camera's behavior.
 *
 * @fileoverview Previously inline in `src/scene.js`. Extracted to
 * its own file so the camera is data-driven and consumers (e.g.
 * future camera presets, camera-shake effects, etc.) can reference
 * the values without importing the whole scene module.
 */

/**
 * Distance behind the ship (along the ship's facing) in world units.
 * Higher = camera farther from the ship.
 */
export const FOLLOW_DISTANCE = 22;

/**
 * Distance above the play plane in world units. Higher = camera
 * looks down at the ship from a higher angle.
 */
export const FOLLOW_HEIGHT = 7;

/**
 * Distance in front of the ship (along the ship's facing) where
 * the camera looks. Higher = look further ahead of the ship
 * (more cinematic, less "looking at the ship itself" feel).
 */
export const FOLLOW_LOOK_AHEAD = 6;

/**
 * Camera position damping coefficient (1/seconds).
 * Higher = snappier follow (camera catches up to target faster).
 * Implemented as `pos.lerp(target, 1 - exp(-CHASE_DAMP * dt))`
 * so it's framerate-independent.
 */
export const CHASE_DAMP = 6.0;

/**
 * Camera boom-arm yaw damping coefficient (1/seconds).
 * Lower = camera lags more on turns (boom-arm feel). The camera
 * offset direction eases toward the ship's actual yaw so it stays
 * at a constant radius from the ship on sharp turns (no "bump
 * through" on 180° turns).
 */
export const YAW_DAMP = 4.0;

/**
 * Camera bank-follow damping coefficient (1/seconds).
 * Higher = snappier bank follow. The camera rolls around its
 * look direction to match the ship's lean (left wing dips →
 * banked left). See `src/entities/ship.js` for the ship's roll
 * update.
 */
export const CAMERA_ROLL_DAMP = 6.0;
