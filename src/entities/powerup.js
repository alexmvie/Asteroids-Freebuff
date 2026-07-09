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
  BoxGeometry,
  IcosahedronGeometry,
  CapsuleGeometry,
  TorusGeometry,
  OctahedronGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Color,
  Box3,
  Vector3,
} from 'three';

// (No duplicate geometry import block — all 7 fallback shapes are
// resolved via direct named imports above.)

const POWERUP_GLB_URL = '/models/powerup-laser.glb';
const POWERUP_RADIUS = 1.5;

/**
 * v0.11.0 powerup type registry — selects the procedural fallback
 * mesh + halo tint per powerup type. Bump this map when adding a new
 * type; add to POWERUP_SPAWN_WEIGHTS in src/systems/powerup-system.js and
 * `src/world/types.js PowerupType`. Each entry provides:
 *   - shape(): a Three.js Mesh to use as the visual body
 *   - color(): hex int for the halo ring + beacon
 *   - label(): short uppercase string for HUD readout
 *
 * The 6 entries below mirrors the trainer's POWERUP_TYPE_INDEX
 * exactly — same keys, same indices. The legacy '/laser' type
 * string was dropped in v0.11.0: powerup-system.js now emits
 * `spec.type = 'shield'` (the new first pickup), matching the
 * trainer's index. No silent fallback — unknown types render as
 * 'UNKNOWN' via the helper functions below.
 */
const POWERUP_TYPE_VARIANTS = {
  shield: {
    shape: 'icosahedron',
    color: 0x6effa8, // mint green
    label: 'SHIELD',
  },
  speed: {
    shape: 'capsule',
    color: 0xff8844, // orange
    label: 'SPEED',
  },
  energy: {
    shape: 'torus',
    color: 0xffe066, // gold-yellow
    label: 'ENERGY',
  },
  credits: {
    shape: 'cylinder',
    color: 0xffd166, // gold
    label: 'CREDITS',
  },
  hull: {
    shape: 'cube',
    color: 0xff5566, // danger red
    label: 'HULL',
  },
  weapon: {
    shape: 'octahedron',
    color: 0xcc66ff, // purple
    label: 'WEAPON',
  },
};

/**
 * Build the v0.11.0 procedural fallback body mesh for the given
 * powerup type. Pure helper — no GLB, no shared state. Each shape
 * is ~10–20 vertices so cheap to allocate per powerup. Tint via the
 * specified color so the player can tell at a glance whether to chase
 * the mint-green shield or the purple weapon.
 */
function buildTypeShapeMesh(typeStr) {
  const variant = POWERUP_TYPE_VARIANTS[typeStr] ?? POWERUP_TYPE_VARIANTS.shield;
  const { shape, color } = variant;
  let geom;
  switch (shape) {
    case 'icosahedron': geom = new IcosahedronGeometry(0.8, 0); break;
    case 'capsule':     geom = new CapsuleGeometry(0.5, 1.0, 4, 8); break;
    case 'torus':       geom = new TorusGeometry(0.7, 0.25, 8, 24); break;
    case 'cylinder':    geom = new CylinderGeometry(0.6, 0.6, 0.2, 16, 1); break;
    case 'cube':        geom = new BoxGeometry(1.0, 1.0, 1.0); break;
    case 'octahedron':  geom = new OctahedronGeometry(0.9, 0); break;
    case 'cone':
    default:            geom = new ConeGeometry(0.7, 1.8, 8, 1);
  }
  const mat = new MeshStandardMaterial({
    color,
    emissive: new Color(color),
    emissiveIntensity: 0.9,
    metalness: 0.3,
    roughness: 0.4,
  });
  const mesh = new Mesh(geom, mat);
  return mesh;
}

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
function buildFallbackMesh(type = 'laser') {
  return buildTypeShapeMesh(type);
}

/**
 * Build the halo ring under the power-up. Cosmetic — sits at the power-up's
 * base (Y = 0 in local space) and rotates with the group. The alpha is
 * intentionally low so the ring reads as a "glow on the floor" not a hard
 * decal.
 *
 * @returns {Mesh}
 */
function buildHaloRing(type = 'laser') {
  const variant = POWERUP_TYPE_VARIANTS[type] ?? POWERUP_TYPE_VARIANTS.shield;
  const geom = new RingGeometry(POWERUP_RADIUS * 1.1, POWERUP_RADIUS * 1.5, 36);
  const mat = new MeshBasicMaterial({
    color: variant.color,
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
function buildBeacon(type = 'laser') {
  const variant = POWERUP_TYPE_VARIANTS[type] ?? POWERUP_TYPE_VARIANTS.shield;
  const geom = new CylinderGeometry(0.05, 0.05, 2.6, 6, 1, true);
  const mat = new MeshBasicMaterial({
    color: variant.color,
    transparent: true,
    opacity: 0.6,
    side: 2, // DoubleSide
    depthWrite: false,
    toneMapped: false,
  });
  return new Mesh(geom, mat);
}

/** Public helper: the short uppercase label for a powerup type (e.g.
 *  'SHIELD'). Used by the HUD to show what was just picked up. */
export function powerupLabelFor(type) {
  const v = POWERUP_TYPE_VARIANTS[type];
  return v ? v.label : 'PICKUP';
}

/** Public helper: hex color tint for a powerup type. Used by the
 *  HUD buff-chip CSS to recolor per type. */
export function powerupColorFor(type) {
  const v = POWERUP_TYPE_VARIANTS[type];
  return v ? v.color : 0x4dabf7;
}

export function createPowerUp({ scene, spec } = {}) {
  if (!scene) throw new Error('createPowerUp: `scene` is required');
  if (!spec) throw new Error('createPowerUp: `spec.type` is required');
  if (!spec.position || typeof spec.position.x !== 'number') {
    throw new Error('createPowerUp: `spec.position` must have numeric x/y/z');
  }
  if (!spec.type) throw new Error('createPowerUp: `spec.type` is required');

  const lifetime = spec.lifetime ?? POWERUP_LIFETIME_S;

  // ---- Group (the entity's transform node) ----------------------------
  const group = new Group();
  group.position.set(spec.position.x, spec.position.y, spec.position.z);

  // ---- Initial visual: procedural fallback (per-type shape + tint) --
  const fallback = buildFallbackMesh(spec.type);
  group.add(fallback);
  group.add(buildHaloRing(spec.type));
  group.add(buildBeacon(spec.type));
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
  let _pushVx = 0;
  let _pushVz = 0;
  // Bob phase offset so two power-ups spawned at the same moment don't
  // bob in lockstep. `spec.spawnTime` is optional; default 0.
  const phase = ((spec.spawnTime ?? 0) * BOB_FREQUENCY * Math.PI * 2) % (Math.PI * 2);
  const baseY = spec.position.y;

  /**
   * Advance the spin + bob animation. `dt` in seconds.
   * @param {number} dt
   */
  /**
   * Push the power-up away from a point (e.g. an asteroid collision).
   * The push velocity decays exponentially each frame so the power-up
   * drifts to a stop after a second or two.
   * @param {number} vx
   * @param {number} vz
   */
  function pushAway(vx, vz) {
    _pushVx += vx;
    _pushVz += vz;
  }

  function update(dt) {
    if (dt <= 0) return;
    age += dt;
    rotation += SPIN_SPEED * dt;
    group.rotation.y = rotation;
    const bob = Math.sin(age * Math.PI * 2 * BOB_FREQUENCY + phase) * BOB_AMPLITUDE;
    group.position.y = baseY + bob;
    // Apply push velocity with exponential decay (asteroid collisions).
    if (_pushVx !== 0 || _pushVz !== 0) {
      group.position.x += _pushVx * dt;
      group.position.z += _pushVz * dt;
      const drag = Math.exp(-3.0 * dt);
      _pushVx *= drag;
      _pushVz *= drag;
    }
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
    /** Push the power-up away (e.g. from an asteroid collision). */
    pushAway,
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
