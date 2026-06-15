/**
 * Public surface of the scene subdirectory.
 * Consumers should import from `src/scene/index.js` rather than
 * reaching into individual files.
 *
 * Note: `src/scene.js` (the top-level scene factory) is NOT
 * re-exported from here — the file path is intentionally flat
 * (no `src/scene/scene.js` doubling). This subdirectory only
 * holds scene-adjacent modules that need their own directory
 * (currently just the camera tunables).
 */

// Follow-camera tunables (chase camera behavior).
export {
  FOLLOW_DISTANCE,
  FOLLOW_HEIGHT,
  FOLLOW_LOOK_AHEAD,
  CHASE_DAMP,
  YAW_DAMP,
  CAMERA_ROLL_DAMP,
} from './camera-constants.js';
