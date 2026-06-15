import * as THREE from 'three';
import { createStarfield } from './systems/starfield.js';
import { createNebulaBackground } from './systems/nebula-background.js';
import { createNebulaDebugOverlay } from './systems/nebula-debug-overlay.js';
import { STARFIELD_COUNT, STARFIELD_RADIUS, STARFIELD_SIZE, NEBULA_DEBUG_DEFAULT } from './world/constants.js';
import {
  CHASE_DAMP,
  YAW_DAMP,
  CAMERA_ROLL_DAMP,
  FOLLOW_DISTANCE,
  FOLLOW_HEIGHT,
  FOLLOW_LOOK_AHEAD,
} from './scene/camera-constants.js';

// Local paths to the bgnebula background image (served by Vite from
// public/bgnebula/ at the root URL). This is v2 of the user-
// generated equirectangular skydome, produced via Nano Banana
// (Google's Gemini image model) for this game. The 1K variant is
// a 1024x506 downscale, used by pickNebulaUrl() for data-saver /
// reduced-data clients.
//
// NOTE on aspect ratio: the source is 2912x1440 (2.02:1), which is
// essentially the standard 2:1 equirectangular ratio. Three.js's
// EquirectangularReflectionMapping will use the texture as-is; the
// ~1% deviation from exact 2:1 is invisible at game scale. The 1K
// downscale preserves aspect ratio (1024x506, also 2.02:1).
//
// See CREDITS.md for attribution.
const NEBULA_IMAGE_URL_2K = '/bgnebula/bgnebula-2.png';
const NEBULA_IMAGE_URL_1K = '/bgnebula/bgnebula-2k.png';

/**
 * Pick the 1K nebula variant for clients that opt out of large
 * downloads. Both signals are advisory; when neither is set we
 * default to the 2K (best visual quality). Safe to call in
 * non-browser environments (returns the 2K when the APIs are
 * absent).
 */
function pickNebulaUrl() {
  const wantsSmall =
    (typeof navigator !== 'undefined' &&
      navigator.connection &&
      navigator.connection.saveData === true) ||
    (typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-data: reduce)').matches);
  return wantsSmall ? NEBULA_IMAGE_URL_1K : NEBULA_IMAGE_URL_2K;
}

/**
 * Build the Three.js scene for the game. Returns the long-lived handles
 * (renderer, scene, camera) plus a few utilities the rest of the app
 * will use as the ship and world streaming come online.
 *
 * @param {object} [opts]
 * @param {HTMLCanvasElement} [opts.canvas] Existing canvas to render into.
 * @returns {{
 *   renderer: THREE.WebGLRenderer,
 *   scene: THREE.Scene,
 *   camera: THREE.PerspectiveCamera,
 *   starfield: THREE.Points,
 *   setChaseTarget: (target: any) => void,
 *   updateCamera: (dt?: number) => void,
 * }}
 */
export function createScene({ canvas } = {}) {
  // --- Renderer ----------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    canvas,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x05060c, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Three.js does not auto-append the canvas to the DOM when none is
  // supplied to the constructor. The game expects a fullscreen canvas
  // mounted on <body>, so attach it once here.
  if (canvas == null && !document.body.contains(renderer.domElement)) {
    document.body.appendChild(renderer.domElement);
  }

  // --- Scene -------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060c);
  // Exponential fog gives a sense of distance without occluding the play area.
  scene.fog = new THREE.FogExp2(0x05060c, 0.0018);

  // --- Camera ------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    6000,
  );
  // Follow-camera config. All offsets (FOLLOW_DISTANCE, FOLLOW_HEIGHT,
  // FOLLOW_LOOK_AHEAD) and damping (CHASE_DAMP, YAW_DAMP, CAMERA_ROLL_DAMP)
  // are imported from './scene/camera-constants.js' — the single source
  // of truth for the camera's behavior. All offsets are in the ship's
  // local frame:
  //   - `FOLLOW_DISTANCE`  units BEHIND the ship (along the ship's facing)
  //   - `FOLLOW_HEIGHT`    units ABOVE the play plane
  //   - `FOLLOW_LOOK_AHEAD` units IN FRONT of the ship (where the camera looks)

  // Wrap an angle to [-PI, PI]. Used to damp the camera's offset yaw
  // toward the ship's actual yaw without taking the long way around.
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // Smoothed look-at + camera position. We lerp `currentTarget` toward
  // the chase target each frame, and `currentPos` toward the desired
  // offset position. This gives a damped follow.
  const desiredTarget = new THREE.Vector3(0, 0, 0);
  const currentTarget = new THREE.Vector3(0, 0, 0);
  const desiredPos = new THREE.Vector3(0, FOLLOW_HEIGHT, FOLLOW_DISTANCE);
  const currentPos = new THREE.Vector3(0, FOLLOW_HEIGHT, FOLLOW_DISTANCE);

  // Boom-arm yaw: the camera's offset direction (the "behind the ship"
  // vector) is damped separately from the look-at point. This keeps the
  // camera at a constant radius from the ship on sharp turns — without
  // it, the desired offset would swing through the ship's position
  // during a 180° turn, causing the camera to "bump" through the ship.
  // `null` = not seeded yet (will be initialised on the first frame
  // after a ship chase source is set).
  let smoothedYaw = null;

  // Bank-follow: the camera also rolls around its look direction
  // (camera-local +Z) to match the ship's lean. Damped independently
  // from the yaw so the camera eases into the bank instead of
  // snapping. `null` = not seeded yet (will be initialised on the
  // first frame after a ship chase source is set, or in
  // `setChaseTarget` on target switch). For non-ship chase sources
  // (plain Vector3 / {x,y,z} / function) the target roll is 0 and
  // `smoothedRoll` damps to 0, so the bank fades out.
  let smoothedRoll = null;

  /**
   * Source of the camera's look-at point. Resolved each frame in
   * `updateCamera`. Accepts a Vector3, a `{x,y,z}` plain object, a
   * ship entity (anything with a `.mesh.position`), or a function.
   * Pass `null` to disable chasing.
   */
  let chaseSource = null;

  function resolveChaseTarget() {
    if (chaseSource == null) return;
    const t = typeof chaseSource === 'function' ? chaseSource() : chaseSource;
    if (!t) return;
    if (t.isVector3) {
      desiredTarget.copy(t);
    } else if (t.mesh && t.mesh.position) {
      const p = t.mesh.position;
      desiredTarget.set(p.x, p.y, p.z);
    } else if (typeof t.x === 'number') {
      desiredTarget.set(t.x, t.y ?? 0, t.z ?? 0);
    }
  }

  function setChaseTarget(target) {
    chaseSource = target ?? null;
    // Seed the boom-arm yaw to the new ship's facing so the camera
    // doesn't sweep around the origin on target switch (AI → player or
    // vice versa). Also seed the bank-follow to the new ship's roll
    // so the camera doesn't snap on target switch. For non-ship
    // sources, leave them as-is: the next updateCamera call won't use
    // them (the world-space fallback kicks in) and the next ship
    // source will reseed them.
    if (
      chaseSource &&
      chaseSource.rotation &&
      typeof chaseSource.rotation.yaw === 'number'
    ) {
      smoothedYaw = chaseSource.rotation.yaw;
      smoothedRoll =
        typeof chaseSource.rotation.roll === 'number'
          ? chaseSource.rotation.roll
          : 0;
    }
  }

  /**
   * Per-frame camera update. If the chase source is a ship (anything with
   * a `rotation.yaw` field), the camera follows the ship's yaw: it sits
   * `FOLLOW_DISTANCE` units behind the ship (along its facing) and
   * `FOLLOW_HEIGHT` units above the play plane, looking at a point
   * `FOLLOW_LOOK_AHEAD` units in front of the ship. Otherwise it falls
   * back to a world-space chase: camera at (0, FOLLOW_HEIGHT,
   * FOLLOW_DISTANCE), looking at the chase target.
   *
   * `dt` defaults to 0.016s (~60fps) for callers that don't track dt.
   * Damping is framerate-independent via `1 - exp(-CHASE_DAMP * dt)`.
   */
  function updateCamera(dt = 0.016) {
    resolveChaseTarget();

    // ---- Compute yaw-relative offset + look-ahead (if ship) -----------
    let offsetX = 0;
    let offsetY = FOLLOW_HEIGHT;
    let offsetZ = FOLLOW_DISTANCE;
    let lookAheadX = 0;
    let lookAheadZ = 0;
    const isShip =
      chaseSource &&
      typeof chaseSource === 'object' &&
      chaseSource.rotation &&
      typeof chaseSource.rotation.yaw === 'number';
    if (isShip) {
      const actualYaw = chaseSource.rotation.yaw;
      // Boom-arm: damp the camera's offset direction toward the ship's
      // actual yaw. This keeps the camera at a constant radius from
      // the ship on sharp turns — the desired offset never swings
      // through the ship's position. `smoothedYaw` is seeded by
      // `setChaseTarget` on target switch, but we also handle the
      // first frame after a ship source is set in case it slipped
      // through (e.g. via `setChaseTarget(null)` then a ship).
      if (smoothedYaw == null) smoothedYaw = actualYaw;
      else {
        const yawDelta = wrapAngle(actualYaw - smoothedYaw);
        const yawT = 1 - Math.exp(-YAW_DAMP * dt);
        smoothedYaw += yawDelta * yawT;
      }

      // The camera *position* uses the smoothed yaw — the boom arm
      // stays at a constant radius from the ship. Behind the ship
      // (along the smoothed facing):
      //   behind.x = sin(smoothedYaw) * distance
      //   behind.z = cos(smoothedYaw) * distance
      const sinS = Math.sin(smoothedYaw);
      const cosS = Math.cos(smoothedYaw);
      offsetX = sinS * FOLLOW_DISTANCE;
      offsetZ = cosS * FOLLOW_DISTANCE;

      // The *look-ahead* uses the ship's actual yaw — the player sees
      // where they're actually going, not where the camera is pointing.
      // Look-ahead is in front of the ship (opposite the behind vector):
      const sinA = Math.sin(actualYaw);
      const cosA = Math.cos(actualYaw);
      lookAheadX = -sinA * FOLLOW_LOOK_AHEAD;
      lookAheadZ = -cosA * FOLLOW_LOOK_AHEAD;
    }

    // ---- Bank-follow: damp the camera's roll toward the ship's roll ----
    // The ship already maintains `rotation.roll` in radians (see
    // src/entities/ship.js). For ship chase sources we read it; for
    // non-ship sources (or ships without the field) the target is 0
    // and the bank fades out smoothly. This block runs
    // unconditionally so the fade-out works for setChaseTarget(null)
    // and friends.
    const shipRoll =
      isShip && typeof chaseSource.rotation.roll === 'number'
        ? chaseSource.rotation.roll
        : 0;
    if (smoothedRoll == null) {
      smoothedRoll = shipRoll;
    } else {
      const rollT = 1 - Math.exp(-CAMERA_ROLL_DAMP * dt);
      smoothedRoll += (shipRoll - smoothedRoll) * rollT;
    }

    // ---- Smooth the look-at point (with look-ahead baked in) ----------
    // `resolveChaseTarget` wrote the raw chase position into
    // `desiredTarget`. For ship chase sources, we offset it by the
    // look-ahead vector (otherwise lookAheadX/Z are 0 — a no-op).
    desiredTarget.x += lookAheadX;
    desiredTarget.z += lookAheadZ;
    const t = 1 - Math.exp(-CHASE_DAMP * dt);
    currentTarget.lerp(desiredTarget, t);

    // ---- Smooth the camera position (offset from smoothed target) ------
    desiredPos.set(
      currentTarget.x + offsetX,
      currentTarget.y + offsetY,
      currentTarget.z + offsetZ,
    );
    currentPos.lerp(desiredPos, t);

    camera.position.copy(currentPos);
    camera.lookAt(currentTarget);

    // Bank-follow: rotate the camera around its look direction
    // (camera-local +Z, which after `lookAt` points from the target
    // back toward the camera) by the smoothed roll. Sign convention:
    // positive ship roll = banked left (left wing dips) and positive
    // `camera.rotateZ` tilts the right side of the view up — the
    // same "banked left" feel. Damping lives in `smoothedRoll` (above)
    // so the camera eases into the bank instead of snapping.
    camera.rotateZ(smoothedRoll);

    // Nebula background follows the camera (so the player always feels
    // "inside" the nebula). Called after the camera position is
    // finalized for this frame. The second `dt` arg drives the
    // opacity fade (see setOpacityTarget in nebula-background.js).
    nebula.update(camera, dt);
  }

  // Initial camera placement (before any chase target is set).
  camera.position.copy(currentPos);
  camera.lookAt(currentTarget);

  // --- Lights ------------------------------------------------------------
  // Ambient base + a warm key + a cool fill. The asteroids will pick this
  // up via MeshStandardMaterial once they're added.
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xfff0d6, 1.3);
  key.position.set(200, 300, 150);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x6da4ff, 0.5);
  fill.position.set(-200, 80, -150);
  scene.add(fill);

  // --- Starfield ---------------------------------------------------------
  // Tunable from src/world/constants.js (STARFIELD_COUNT/RADIUS/SIZE/SEED).
  // The default seed makes the constellations fixed across reloads —
  // see src/systems/starfield.js for the determinism rationale.
  const starfield = createStarfield({
    count: STARFIELD_COUNT,
    radius: STARFIELD_RADIUS,
    size: STARFIELD_SIZE,
  });
  scene.add(starfield);

  // --- Nebula background -------------------------------------------------
  // User-generated skydome v2 (Nano Banana / Gemini) mapped onto a
  // large inside-out sphere that follows the camera. Provides a
  // deep-space backdrop behind the starfield. The image is bundled
  // locally in public/bgnebula/ (see NEBULA_IMAGE_URL above and
  // CREDITS.md for attribution). Wrapped equirectangularly so it
  // tiles around the player. `fog: false` keeps it crisp through
  // the scene fog. See src/systems/nebula-background.js for the
  // implementation.
  //
  // The nebula's opacity is driven by the ship's current chunk's
  // `chunkHasNebula` decision (see src/world/chunks.js +
  // NEBULA_RENDER_THRESHOLD). When the ship enters a "nebula chunk"
  // the sphere fades in; when it leaves, it fades out. See
  // src/main.js's render loop for the wiring.
  const nebula = createNebulaBackground({
    imageUrl: pickNebulaUrl(),
    radius: 5000,
  });
  nebula.mount(scene);

  // --- Nebula threshold debug overlay ------------------------------------
  // Per-chunk colored markers (green = above threshold, red = below)
  // over the active streaming bubble. Toggle with `window.NEBULA_DEBUG`
  // in the browser devtools. See src/systems/nebula-debug-overlay.js.
  const nebulaDebug = createNebulaDebugOverlay();
  nebulaDebug.setEnabled(!!NEBULA_DEBUG_DEFAULT);
  scene.add(nebulaDebug.mesh);

  // --- Resize ------------------------------------------------------------
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  return {
    renderer,
    scene,
    camera,
    starfield,
    nebula,
    nebulaDebug,
    setChaseTarget,
    updateCamera,
    /**
     * Release GPU resources held by the nebula (texture + geometry +
     * material). The starfield is THREE.Points with no separately
     * tracked geometry/material to dispose. The debug overlay
     * releases its instanced quad geometry + material via
     * `nebulaDebug.dispose()`.
     */
    dispose() {
      nebula.dispose();
      nebulaDebug.dispose();
    },
  };
}
