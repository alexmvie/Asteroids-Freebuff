/**
 * Power-up entity — a collectible 3D object that grants the ship a temporary
 * ability. The first power-up is the laser (see src/entities/laser.js).
 *
 * Visual:
 *   - A glTF model loaded from /models/powerup-laser.glb (set in
 *     POWERUP_GLB_URL). Loaded asynchronously; the factory initially shows a
 *     procedural fallback mesh (cyan emissive cone) and swaps in the GLB
 *     once it loads.
 *   - Spins slowly around Y and bobs up/down.
 *   - An emissive "halo" ring under the entity (cosmetic — the actual
 *     collision uses a sphere of POWERUP_RADIUS).
 *
 * Lifecycle:
 *   - createPowerUp({ scene, spec }) → entity
 *   - entity.update(dt)   advance spin + bob
 *   - entity.isExpired()  true after the lifetime has elapsed
 *   - entity.dispose()    remove from scene, release geometry + material
 *
 * Determinism: the visual spin and bob are functions of `dt` (and an
 * internal `age` accumulator), not of `Math.random`. The spawn position
 * is supplied via `spec.position` and the spawn time via `spec.spawnTime`
 * (used by the bob phase).
 *
 * @param {{
 *   scene: import('three').Scene,
 *   spec: {
 *     type: string,                         // e.g. 'laser'
 *     position: { x:number, y:number, z:number },
 *     lifetime?: number,                    // seconds; default POWERUP_LIFETIME_S
 *     spawnTime?: number,                   // seconds since boot; offsets the bob phase
 *   },
 * }} opts
 */

import {
  Group,
  Mesh,
  ConeGeometry,
  RingGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Color,
  Box3,
  Vector3,
} from 'three';

const POWERUP_GLB_URL = '/models/powerup-laser.glb';
const POWERUP_RADIUS = 1.5;
/**
 * Default power-up lifetime in seconds. The power-up despawns if
 * not collected within this window. Exported so the power-up system
 * (src/systems/powerup-system.js) can use it as a per-state default
 * (e.g. shorter in DEMO so the user sees the cycle more often).
 */
export const POWERUP_LIFETIME_S = 30;
const SPIN_SPEED = 1.2; // rad/s
const BOB_AMPLITUDE = 0.35; // world units
const BOB_FREQUENCY = 0.9; // Hz
const FALLBACK_COLOR = 0x4dabf7; // sky blue (slightly more blue than the game's primary cyan)

// ---- GLB cache (loaded once, shared across all power-ups of this type) --
// Module-scoped promise so multiple concurrent `createPowerUp` calls all
// await the same load. The resolved value is the normalized GLB root
// (centered on origin, longest axis ≈ POWERUP_GLB_TARGET_SIZE units) or
// `null` if the load failed.
let _glbRoot = null;
let _glbLoading = null;
const POWERUP_GLB_TARGET_SIZE = 3.0;

/**
 * Lazily load (and normalize) the power-up GLB. The mesh is centered on
 * origin and uniformly scaled so the longest bbox axis is
 * POWERUP_GLB_TARGET_SIZE units. No forward-axis auto-rotation: the GLB
 * is meant to be viewed from all sides (it's a static prop, not a ship).
 *
 * @returns {Promise<import('three').Group | null>}
 */
function loadPowerUpGlb() {
  if (_glbRoot !== null) return Promise.resolve(_glbRoot);
  if (_glbLoading) return _glbLoading;
  _glbLoading = (async () => {
    let GLTFLoader;
    try {
      ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
    } catch (_) {
      return null;
    }
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(POWERUP_GLB_URL);
      const root = gltf.scene;
      if (!root) throw new Error('GLB has no scene');

      // Center on origin + normalize scale.
      const bbox = new Box3().setFromObject(root);
      const center = new Vector3();
      bbox.getCenter(center);
      const size = new Vector3();
      bbox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? POWERUP_GLB_TARGET_SIZE / maxDim : 1;
      root.scale.setScalar(scale);
      root.position.sub(center.multiplyScalar(scale));
      _glbRoot = root;
      return root;
    } catch (_) {
      return null;
    } finally {
      _glbLoading = null;
    }
  })();
  return _glbLoading;
}

/**
 * Build the procedural fallback mesh (used until the GLB loads, or forever
 * if the GLB load fails). A short upright cone with a strong emissive
 * glow so the power-up reads as "pick me up!" even without the model.
 *
 * @returns {Mesh}
 */
function buildFallbackMesh() {
  const geom = new ConeGeometry(0.7, 1.8, 8, 1);
  // Default cone tip is +Y; leave as-is (the power-up is meant to be
  // viewed from the side, and the engine cone is the same way).
  const mat = new MeshStandardMaterial({
    color: FALLBACK_COLOR,
    emissive: new Color(FALLBACK_COLOR),
    emissiveIntensity: 0.9,
    metalness: 0.3,
    roughness: 0.4,
  });
  return new Mesh(geom, mat);
}

/**
 * Build the halo ring under the power-up. Cosmetic — sits at the power-up's
 * base (Y = 0 in local space) and rotates with the group. The alpha is
 * intentionally low so the ring reads as a "glow on the floor" not a hard
 * decal.
 *
 * @returns {Mesh}
 */
function buildHaloRing() {
  const geom = new RingGeometry(POWERUP_RADIUS * 1.1, POWERUP_RADIUS * 1.5, 36);
  const mat = new MeshBasicMaterial({
    color: FALLBACK_COLOR,
    transparent: true,
    opacity: 0.45,
    side: 2, // DoubleSide
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new Mesh(geom, mat);
  ring.rotation.x = -Math.PI / 2; // lay flat in the XZ plane
  ring.position.y = -0.6; // sit below the body
  return ring;
}

/**
 * Build a thin emissive beam column rising through the power-up. Cosmetic
 * beacon — makes the power-up pop visually against the dark space
 * background. (The actual collision is a sphere of POWERUP_RADIUS, not
 * the column.)
 *
 * @returns {Mesh}
 */
function buildBeacon() {
  const geom = new CylinderGeometry(0.05, 0.05, 2.6, 6, 1, true);
  const mat = new MeshBasicMaterial({
    color: FALLBACK_COLOR,
    transparent: true,
    opacity: 0.6,
    side: 2, // DoubleSide
    depthWrite: false,
    toneMapped: false,
  });
  return new Mesh(geom, mat);
}

export function createPowerUp({ scene, spec } = {}) {
  if (!scene) throw new Error('createPowerUp: `scene` is required');
  if (!spec) throw new Error('createPowerUp: `spec` is required');
  if (!spec.position || typeof spec.position.x !== 'number') {
    throw new Error('createPowerUp: `spec.position` must have numeric x/y/z');
  }
  if (!spec.type) throw new Error('createPowerUp: `spec.type` is required');

  const lifetime = spec.lifetime ?? POWERUP_LIFETIME_S;

  // ---- Group (the entity's transform node) ----------------------------
  const group = new Group();
  group.position.set(spec.position.x, spec.position.y, spec.position.z);

  // ---- Initial visual: procedural fallback ---------------------------
  const fallback = buildFallbackMesh();
  group.add(fallback);
  group.add(buildHaloRing());
  group.add(buildBeacon());
  group.userData.visual = fallback;

  scene.add(group);

  // ---- Async: swap in the GLB if it loads -----------------------------
  loadPowerUpGlb().then((glbRoot) => {
    if (!glbRoot) return; // keep the fallback
    group.remove(fallback);
    if (fallback.geometry) fallback.geometry.dispose();
    if (fallback.material) fallback.material.dispose();
    group.add(glbRoot);
    group.userData.visual = glbRoot;
  });

  // ---- Per-frame state -----------------------------------------------
  let age = 0;
  let rotation = 0;
  // Bob phase offset so two power-ups spawned at the same moment don't
  // bob in lockstep. `spec.spawnTime` is optional; default 0.
  const phase = ((spec.spawnTime ?? 0) * BOB_FREQUENCY * Math.PI * 2) % (Math.PI * 2);
  const baseY = spec.position.y;

  /**
   * Advance the spin + bob animation. `dt` in seconds.
   * @param {number} dt
   */
  function update(dt) {
    if (dt <= 0) return;
    age += dt;
    rotation += SPIN_SPEED * dt;
    group.rotation.y = rotation;
    const bob = Math.sin(age * Math.PI * 2 * BOB_FREQUENCY + phase) * BOB_AMPLITUDE;
    group.position.y = baseY + bob;
  }

  /** True if the power-up has been in the world for >= its lifetime. */
  function isExpired() {
    return age >= lifetime;
  }

  function dispose() {
    scene.remove(group);
    for (const child of group.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  return {
    mesh: group,
    spec,
    update,
    dispose,
    /** @returns {number} collision radius in world units */
    getRadius() { return POWERUP_RADIUS; },
    /** @returns {{x:number,y:number,z:number}} live world position (mutated) */
    getPosition() { return group.position; },
    isExpired,
  };
}

/**
 * Module-scope test seam: drop the GLB cache so the next `createPowerUp`
 * call re-loads the GLB from scratch. Tests don't use this; it's a safety
 * hatch for hot-reload during development.
 */
export function _resetGlbCache() {
  _glbRoot = null;
  _glbLoading = null;
}
