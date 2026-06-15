import {
  Group,
  Mesh,
  MeshStandardMaterial,
  ConeGeometry,
  BoxGeometry,
  Color,
  Box3,
  Vector3,
} from 'three';

import {
  THRUST_ACCEL,
  MAX_SPEED,
  LINEAR_DRAG,
  YAW_SPEED,
  ROLL_MAX,
  ROLL_DAMP,
} from './ship-constants.js';
// PLAY_PLANE_Y is owned by the world data-model layer (the play plane
// is a world concept, not a ship concept). See ../world/chunk-constants.js.
import { PLAY_PLANE_Y } from '../world/chunk-constants.js';

/**
 * Ship entity — a self-contained 3D ship with a 2DOF controller.
 *
 * Flight model:
 *   - `2dof` (default): yaw + thrust on the XZ plane; Y is locked to 0.
 *   - `6dof`: planned. The seam exists; the implementation throws so that
 *     any premature call is loud. Adding pitch/roll/full 3D motion will
 *     not require a refactor of consumers (setFlightMode / update).
 *
 * Public API:
 *   - `ship.mesh`               Three.js Group (faceted body + wings + glow)
 *   - `ship.position`           live {x, y, z} object (mutated each frame)
 *   - `ship.velocity`           live {x, y, z} object
 *   - `ship.rotation`           live {yaw, pitch, roll} in radians
 *   - `ship.flightMode`         '2dof' | '6dof' (read-only)
 *   - `ship.setThrust(boolean)`
 *   - `ship.setYaw(-1 | 0 | +1)`
 *   - `ship.setFlightMode('2dof' | '6dof')`
 *   - `ship.update(dt)`         advance physics; dt is seconds
 *   - `ship.reset(position?)`   snap back to a given world position
 *
 * @param {{ scene: import('three').Scene, position?: { x: number, y: number, z: number } }} opts
 */
export function createShip({ scene, position = { x: 0, y: 0, z: 0 } } = {}) {
  if (!scene) throw new Error('createShip: `scene` is required');

  // Tunables (THRUST_ACCEL, MAX_SPEED, LINEAR_DRAG, YAW_SPEED,
  // ROLL_MAX, ROLL_DAMP) are imported from ./ship-constants.js —
  // the single source of truth for ship physics. PLAY_PLANE_Y is
  // imported from ../world/chunk-constants.js (world owns it).
  // See src/scene/camera-constants.js for the matching camera tunables.

  // ---- Mesh assembly ---------------------------------------------------
  // Outer group: world position + yaw (the ship's facing).
  const group = new Group();
  group.position.set(position.x, position.y, position.z);

  // Inner body group: roll (the ship's "lean" around the forward axis).
  // The body, wings, and engine glow are children of the body group so
  // they all roll together. The outer group still controls yaw; the
  // two are decoupled so a lean doesn't change the ship's facing.
  // Scaling `body` triples the visual (mesh + glow) without
  // affecting the physics position, which is owned by the outer
  // `group` (the body scale is purely cosmetic — collisions and
  // camera follow the outer group, not the body).
  const body = new Group();
  body.scale.setScalar(3); // triple the visual size of mesh + glow
  group.add(body);

  // Body: 4-sided pyramid pointing forward (-Z). ConeGeometry's default tip
  // is +Y; rotateX(-PI/2) maps +Y → -Z.
  const bodyGeom = new ConeGeometry(1.0, 2.5, 4, 1);
  bodyGeom.rotateX(-Math.PI / 2);
  const bodyMat = new MeshStandardMaterial({
    color: 0xe6ecff,
    metalness: 0.3,
    roughness: 0.55,
    flatShading: true,
  });
  const bodyMesh = new Mesh(bodyGeom, bodyMat);
  body.add(bodyMesh);

  // Wings: two small angled boxes.
  const wingMat = new MeshStandardMaterial({
    color: 0x48dbfb,
    metalness: 0.4,
    roughness: 0.5,
    flatShading: true,
  });
  const wingGeom = new BoxGeometry(0.4, 0.2, 1.4);
  const wingL = new Mesh(wingGeom, wingMat);
  wingL.position.set(-0.95, -0.05, 0.15);
  wingL.rotation.z = Math.PI / 7;
  body.add(wingL);
  const wingR = new Mesh(wingGeom, wingMat);
  wingR.position.set(0.95, -0.05, 0.15);
  wingR.rotation.z = -Math.PI / 7;
  body.add(wingR);

  // Engine glow: a small inverted cone at the back, emissive material.
  // Tagged with `userData.isEngineGlow = true` so `loadShipModel` can
  // preserve it (the glow rolls with the ship's lean) while swapping
  // the cone body + wings for a GLB-loaded ship. The glow is an
  // additive overlay that looks correct on top of any ship model.
  //
  // Material: transparent by default, opacity 0 — the glow is only
  // visible when the thrust is on. `transparent: true` enables
  // per-frame alpha blending; `visible: false` (set in `update`)
  // skips the draw call entirely when the ship is idle. The
  // emissive color stays strong so the on-thrust glow is bright
  // cyan even at low opacity.
  const glowMat = new MeshStandardMaterial({
    color: 0x48dbfb,
    emissive: new Color(0x48dbfb),
    emissiveIntensity: 2.4, // peak intensity (only visible on thrust)
    transparent: true,      // allow per-frame opacity changes
    opacity: 0,             // invisible by default (toggled in update)
    depthWrite: false,      // don't occlude the model behind the glow
  });
  const glow = new Mesh(new ConeGeometry(0.35, 0.6, 8), glowMat);
  glow.rotation.x = Math.PI / 2; // tip points +Z (backward)
  glow.position.set(0, 0, 1.5);
  glow.userData.isEngineGlow = true;
  glow.visible = false;     // start hidden; update() toggles on thrust
  body.add(glow);

  scene.add(group);

  // ---- Mutable state (also exposed to consumers) ----------------------
  const state = {
    position: { x: position.x, y: position.y, z: position.z },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0, roll: 0 }, // radians
  };

  // ---- Input (set by the input system; placeholder until it lands) ----
  let thrustOn = false;
  let yawInput = 0; // -1, 0, +1

  // ---- Public API -----------------------------------------------------
  function setThrust(on) {
    thrustOn = !!on;
  }

  function setYaw(direction) {
    yawInput = Math.max(-1, Math.min(1, direction));
  }

  function setFlightMode(mode) {
    if (mode !== '2dof' && mode !== '6dof') {
      throw new Error(`createShip: unknown flight mode "${mode}"`);
    }
    if (mode === '6dof') {
      // Planned. Don't silently no-op — make it loud.
      throw new Error('createShip: 6DOF flight is not implemented yet');
    }
    state._flightMode = mode; // eslint-disable-line no-unused-vars
  }

  /**
   * Advance physics. `dt` in seconds.
   * @param {number} dt
   */
  function update(dt) {
    if (dt <= 0) return;

    // ---- 2DOF: yaw + XZ translation, Y locked -------------------------
    // Yaw
    state.rotation.yaw += yawInput * YAW_SPEED * dt;

    // Roll (lean into the turn). The target roll is proportional to
    // the yaw input scaled to ROLL_MAX; the actual roll is damped
    // toward the target each frame so the lean eases in and out
    // smoothly. Sign: yawInput > 0 → targetRoll > 0 → positive Z
    // rotation, which tilts the left wing down (lean left).
    const targetRoll = yawInput * ROLL_MAX;
    const rollT = 1 - Math.exp(-ROLL_DAMP * dt);
    state.rotation.roll += (targetRoll - state.rotation.roll) * rollT;

    // Facing direction in the XZ plane. +Y rotation around Y axis means
    // forward (-Z) is at angle `yaw`: ( -sin(yaw), 0, -cos(yaw) ).
    const fwdX = -Math.sin(state.rotation.yaw);
    const fwdZ = -Math.cos(state.rotation.yaw);

    // Thrust
    if (thrustOn) {
      state.velocity.x += fwdX * THRUST_ACCEL * dt;
      state.velocity.z += fwdZ * THRUST_ACCEL * dt;
    }

    // Drag (exponential decay, framerate-independent)
    const dragFactor = Math.exp(-LINEAR_DRAG * dt);
    state.velocity.x *= dragFactor;
    state.velocity.z *= dragFactor;

    // Speed cap (XZ plane only)
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      state.velocity.x *= k;
      state.velocity.z *= k;
    }

    // Integrate position
    state.position.x += state.velocity.x * dt;
    state.position.z += state.velocity.z * dt;
    state.position.y = PLAY_PLANE_Y;

    // Push to mesh. The outer group has position + yaw only; the
    // inner body group has the roll (lean). This keeps the facing
    // decoupled from the lean, so a roll never changes the ship's
    // direction of travel.
    group.position.set(state.position.x, state.position.y, state.position.z);
    group.rotation.set(0, state.rotation.yaw, 0);
    body.rotation.set(0, 0, state.rotation.roll);

    // Engine glow: visible only on thrust, very transparent.
    // On thrust: visible + opacity 0.3 (subtle but visible) +
    //   bright emissive (2.4). Off thrust: hidden entirely so
    //   the player isn't distracted by a constant engine glow.
    // (Setting emissiveIntensity in the off branch is wasted —
    // `visible: false` skips the draw call entirely.)
    if (thrustOn) {
      glow.visible = true;
      glowMat.opacity = 0.3;
      glowMat.emissiveIntensity = 2.4;
    } else {
      glow.visible = false;
      glowMat.opacity = 0;
    }
  }

  function reset(p = { x: 0, y: 0, z: 0 }) {
    state.position.x = p.x;
    state.position.y = p.y;
    state.position.z = p.z;
    state.velocity.x = 0;
    state.velocity.y = 0;
    state.velocity.z = 0;
    state.rotation.yaw = 0;
    state.rotation.pitch = 0;
    state.rotation.roll = 0;
    group.position.set(p.x, p.y, p.z);
    group.rotation.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
  }

  /**
   * Walk `body`'s children and dispose every geometry + material.
   * Skips children tagged with `userData.isEngineGlow = true` (the
   * engine glow is always present, even after a GLB swap). Idempotent.
   */
  function dispose() {
    if (!body) return;
    const toRemove = body.children.filter((c) => !c.userData?.isEngineGlow);
    for (const child of toRemove) {
      body.remove(child);
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        child.geometry.dispose();
      }
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
      }
      // Recurse for groups (the GLB root is a Group that contains
      // Meshes, which themselves own geometry + material).
      if (typeof child.traverse === 'function') {
        child.traverse((obj) => {
          if (obj !== child && obj.geometry && typeof obj.geometry.dispose === 'function') {
            obj.geometry.dispose();
          }
          if (obj !== child && obj.material) {
            const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of ms) {
              if (m && typeof m.dispose === 'function') m.dispose();
            }
          }
        });
      }
    }
  }

  return {
    mesh: group,
    body, // inner sub-group that holds the visual mesh; rolls for the lean
    position: state.position, // shared reference; live
    velocity: state.velocity, // shared reference; live
    rotation: state.rotation, // shared reference; live
    get flightMode() { return '2dof'; }, // current implementation is 2DOF-only
    setThrust,
    setYaw,
    setFlightMode,
    update,
    reset,
    dispose,
  };
}

/**
 * Asynchronously load a GLB model from `modelUrl` and swap it in as
 * the ship's visual mesh. The existing procedural mesh (cone body +
 * wings) is disposed and replaced by the GLB's scene graph. The
 * engine glow (tagged with `userData.isEngineGlow = true`) is
 * preserved so the ship still has a thrust-reactive exhaust.
 *
 * Two automatic normalizations are applied to the loaded model:
 *
 *   1. **Forward axis.** GLBs commonly use +Z forward (the Blender
 *      exporter default). Our ship physics uses -Z forward
 *      (`fwdX = -sin(yaw)`, `fwdZ = -cos(yaw)` in `createShip.update`).
 *      We detect the model's dominant forward axis by checking whether
 *      the bbox center Z is positive, and rotate 180° around Y if so.
 *
 *   2. **Scale.** The model's longest axis is normalized to
 *      `targetMax` world units (default 2.0), matching the procedural
 *      ship's scale (~2.0 wide, ~2.5 long). The bbox is re-centered
 *      on origin so yaw/roll happen around the visual center.
 *
 * On failure, the procedural mesh stays in place and a warning is
 * logged. The function never throws.
 *
 * The `GLTFLoader` import is **lazy** (inside the function body) so
 * the import is only triggered when this function is called. Node
 * tests that don't call `loadShipModel` never load the GLTFLoader.
 *
 * @param {object} ship - a ship object returned by `createShip`.
 * @param {string} modelUrl - URL of the GLB (e.g. '/models/skyfighter.glb').
 * @param {object} [opts]
 * @param {number} [opts.targetMax=2.0] - target longest-axis size in world units.
 * @param {number} [opts.modelRotationY=0] - extra Y-axis rotation in radians applied after the auto-detected forward-axis rotation. Use this to fix a GLB that loads facing the wrong direction (e.g. +π/2 to rotate a -X-facing model to -Z forward).
 * @returns {Promise<{ success: boolean, error?: Error, glbRoot?: Object, scale?: number, rotated?: boolean }>}
 */
export async function loadShipModel(ship, modelUrl, opts = {}) {
  if (!ship || !ship.body) {
    return { success: false, error: new Error('loadShipModel: ship and ship.body are required') };
  }
  if (!modelUrl || typeof modelUrl !== 'string') {
    return { success: false, error: new Error('loadShipModel: modelUrl is required') };
  }
  const { targetMax = 2.0, modelRotationY = 0 } = opts;

  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[loadShipModel] GLTFLoader import failed; keeping procedural mesh:`, e.message);
    }
    return { success: false, error: e };
  }

  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelUrl);
    const glbRoot = gltf.scene;
    if (!glbRoot) {
      throw new Error('GLB has no scene');
    }

    // ---- 1. Auto-detect forward axis --------------------------------
    // Compute the initial bbox BEFORE any rotation/scale. If the
    // bbox center Z is positive, the model's "nose" is in the +Z
    // direction and we rotate 180° around Y to flip it to -Z
    // forward, matching the ship physics.
    const bbox = new Box3().setFromObject(glbRoot);
    const center = new Vector3();
    bbox.getCenter(center);
    const nosePointsPositiveZ = center.z > 0;
    // Combine the auto-detected forward-axis rotation (0 or π)
    // with the user-supplied extra rotation (`modelRotationY`).
    // The result is one composed rotation applied before the
    // scale step, so the bbox-driven centering still works.
    glbRoot.rotation.y = (nosePointsPositiveZ ? Math.PI : 0) + modelRotationY;

    // ---- 2. Auto-scale ----------------------------------------------
    // Recompute the bbox after the rotation. Normalize so the
    // longest axis is `targetMax` units.
    bbox.setFromObject(glbRoot);
    const size = new Vector3();
    bbox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? targetMax / maxDim : 1;
    glbRoot.scale.setScalar(scale);

    // ---- 3. Re-center on origin -------------------------------------
    // Recompute the bbox after scaling, then translate so the bbox
    // is centered on the body's local origin. Yaw/roll happen
    // around the visual center, not a bbox offset.
    bbox.setFromObject(glbRoot);
    bbox.getCenter(center);
    glbRoot.position.sub(center);

    // ---- 4. Swap meshes ---------------------------------------------
    // Dispose the procedural body + wings (NOT the engine glow) and
    // add the GLB root as a child of `body`. The existing
    // `ship.dispose()` method handles the inverse operation.
    const toRemove = ship.body.children.filter((c) => !c.userData?.isEngineGlow);
    for (const child of toRemove) {
      ship.body.remove(child);
      if (child.geometry && typeof child.geometry.dispose === 'function') {
        child.geometry.dispose();
      }
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
      }
    }
    ship.body.add(glbRoot);

    return { success: true, glbRoot, scale, rotated: nosePointsPositiveZ };
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[loadShipModel] GLB load failed for "${modelUrl}"; keeping procedural mesh:`, e.message);
    }
    return { success: false, error: e };
  }
}
