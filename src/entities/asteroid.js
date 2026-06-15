import * as THREE from 'three';
import { NoisyIcosphere } from '../geometry/noisy-icosphere.js';
import { Capsule } from '../geometry/capsule.js';
import { mulberry32 } from '../world/rng.js';

/**
 * Returns the body type for an asteroid spec: 'icosphere' (seed
 * bit 0 = 0) or 'capsule' (seed bit 0 = 1). Used by the UV
 * editor's per-type template system (one save covers all
 * asteroids of the same body type). Exported so the UV editor
 * can name the saved JSON file by type and so the
 * `createAsteroidFromSpec` factory can look up the right
 * template at creation time.
 *
 * @param {import('../world/types.js').AsteroidSpec} spec
 * @returns {'icosphere' | 'capsule'}
 */
export function getAsteroidType(spec) {
  return (spec.seed & 1) === 1 ? 'capsule' : 'icosphere';
}

/**
 * Asteroid entity — turns a data-model `AsteroidSpec` (from src/world/chunks.js)
 * into a live Three.js mesh with spin, ambient drift, and a split() method
 * for the collision layer to call.
 *
 * Visual:
 *   - IcosahedronGeometry, detail 0 (12 vertices, 20 faces)
 *   - Deterministic per-vertex jitter driven by the spec's `seed` field
 *   - MeshStandardMaterial with `flatShading: true` for the faceted look
 *
 * Lifecycle (per frame):
 *   - update(dt)        advance spin + ambient drift
 *   - split()           on hit; returns 0–2 child specs (small asteroids return [])
 *   - dispose()         when the chunk unloads; releases geometry + material
 *
 * Determinism: the visual jitter and split() children both key off
 * `spec.seed`, so given the same spec you get the same mesh and same
 * children. This matters when the world layer re-creates asteroids
 * for re-streamed chunks.
 */
const SPLIT_RADIUS_RATIO = 0.6; // child_radius = parent_radius * this
const SPLIT_KICK = 8; // u/s, outward velocity on split
const PLAY_PLANE_Y = 0;

/**
 * Bump strength on the asteroid material. 0.05 is a conservative value
 * for a 1024×1024 height map at typical game-scale asteroid radii;
 * the visual effect is subtle relief without the silhouette getting
 * noisy. Tunable per-material if a future pass wants stronger relief.
 *
 * Declared BEFORE the SHARED_MATERIAL_PARAMS constant that uses it
 * (the const is evaluated top-to-bottom; the previous ordering
 * tripped a TDZ ReferenceError at module load time).
 */
const BUMP_SCALE = 0.05;

/**
 * Shared `MeshStandardMaterial` parameters for BOTH asteroid body
 * types. The icosphere and capsule use the SAME material
 * parameters (same 4 PBR maps, same metalness/roughness/etc.) so
 * they look consistent across the field — the only difference
 * is the geometry shape itself.
 *
 * Note: the PBR texture maps are NOT listed here. The textures
 * load lazily (the underlying `THREE.TextureLoader` needs a
 * browser `Image` global, so they're not available at module-init
 * time) and are assigned in `createAsteroidMaterial`. Keeping
 * them out of this frozen object avoids the previous foot-gun
 * where `map: null` was spread first and the explicit assignment
 * had to override it — any reorder or refactor that put the
 * explicit assignment BEFORE the spread would silently produce
 * a null-map (black) material.
 */
const SHARED_MATERIAL_PARAMS = Object.freeze({
  color: 0xffffff,
  metalness: 0.1,
  roughness: 0.9,
  bumpScale: BUMP_SCALE,
  flatShading: true,
});

/**
 * Build the shared PBR material for an asteroid body. Lazily
 * initializes the 4 shared PBR textures (loaded once at module
 * scope and shared across every asteroid, so the GPU reuses
 * the same texture for hundreds of meshes).
 *
 * @returns {THREE.MeshStandardMaterial}
 */
function createAsteroidMaterial() {
  return new THREE.MeshStandardMaterial({
    ...SHARED_MATERIAL_PARAMS,
    map: getAsteroidAlbedo(),
    normalMap: getAsteroidNormal(),
    roughnessMap: getAsteroidRoughness(),
    bumpMap: getAsteroidBump(),
  });
}

// Module-scoped scratch — safe in single-threaded JS.
const _scratchAxis = new THREE.Vector3();

/**
 * Build the faceted mesh for one asteroid. Pure (no scene, no side effects).
 *
 * Each asteroid is a `THREE.Group` containing either a noise-displaced
 * icosphere with a 3-level LOD (irregular rock) or a jittered capsule
 * (potato). The group is a single transformable node, so `update()` /
 * `split()` / collision work unchanged (the spin applies to the whole
 * group; the bounding radius is still `spec.radius`).
 *
 * If `uvDebugOverlay` is provided, a debug mesh (sharing the body's
 * geometry) is attached to the body. The debug mesh shows a 10×10
 * UV grid (one cell per 0.1×0.1 UV, colored by region) when the
 * overlay is enabled — useful for tuning the unwrap live in the
 * browser via `window.ASTEROID_UV_DEBUG`. See
 * `src/systems/asteroid-uv-debug-overlay.js` for the overlay.
 *
 * @param {import('../world/types.js').AsteroidSpec} spec
 * @param {object} [uvDebugOverlay] optional UV debug overlay
 * @returns {THREE.Group}
 */
function buildAsteroidMesh(spec, uvDebugOverlay) {
  const rng = mulberry32(spec.seed);
  const group = new THREE.Group();

  // Preserve the original rng sequence (no-op; see commit history).
  rng();

  // Pick the asteroid type deterministically from the seed (no rng
  // consumption). bit 0: 0 = noisy icosphere (LOD), 1 = capsule.
  // Splitting the population roughly 50/50 between the two types so
  // the field has visual variety.
  const isCapsule = (spec.seed & 1) === 1;

  // Build the body. Each branch returns `{ lowestY, lod, debugMeshes }`:
  //   - `lowestY`: the body's lowest y in local space (for the ground)
  //   - `lod`: the THREE.LOD if the body is a LOD, else null
  //   - `debugMeshes`: array of overlay-attached meshes (for cleanup)
  let bodyResult;
  if (isCapsule) {
    bodyResult = buildCapsuleBody(group, spec, rng, uvDebugOverlay);
  } else {
    bodyResult = buildNoisyIcosphereBody(group, spec, rng, uvDebugOverlay);
  }

  // ---- DEBUG: square ground footprint -------------------------------
  // A flat square under the asteroid. Sits 0.15 × spec.radius below
  // the body's lowest point, giving a small visual gap. Rotates with
  // the group (it is a child, not a world-space ground). Easy to
  // remove once the visual is finalised.
  addDebugGround(group, spec, bodyResult.lowestY - spec.radius * 0.15);

  group.position.set(spec.position.x, spec.position.y, spec.position.z);

  // Attach the LOD reference + debug-mesh list to the group so the
  // entity's update / dispose methods can find them. `null` for
  // `lod` on capsule bodies; `[]` for `debugMeshes` if no overlay
  // was supplied.
  group.userData.lod = bodyResult.lod;
  group.userData.debugMeshes = bodyResult.debugMeshes || [];
  return group;
}

// LOD switch distances (in world units, camera-to-asteroid distance).
//   detail 2 (162 vertices) when within CLOSE_DIST
//   detail 1 (42 vertices)  when within MID_DIST
//   detail 0 (12 vertices)  beyond MID_DIST
const LOD_CLOSE_DIST = 0;
const LOD_MID_DIST = 30;
const LOD_FAR_DIST = 100;

// Asteroid PBR texture set — a 4-map collection cropped from the
// user-provided 2048×2048 atlas (`public/textures/asteroid-1.png`).
// The atlas is a 2×2 grid (left-to-right, top-to-bottom reading order):
//
//   ┌──────────────┬──────────────┐
//   │  albedo      │  normal      │   1024×1024 each
//   │  (sRGB)      │  (linear)    │   power-of-two resize from ~1018×1019 crops
//   ├──────────────┼──────────────┤
//   │  roughness   │  bump        │
//   │  (linear)    │  (linear)    │
//   └──────────────┴──────────────┘
//
// The 4 quadrants are separated by a ~10px black outline in the source
// image. The crops are taken tightly (1px margin from the separator)
// so the black outline never enters the final material — see the
// crop commands in `scripts/build-asteroid-textures.sh` (or the
// commit message) for the exact pixel bounds.
//
// **Color-space discipline.** Three.js applies the sRGB gamma curve
// to color textures and the *inverse* to data textures. Mixing these
// up silently ruins the look: an albedo loaded as linear washes out,
// a normal loaded as sRGB double-decodes. We set `colorSpace` per
// loader (sRGB for albedo, `NoColorSpace` for the 3 data maps).
//
// **Served by Vite from public/textures/ at the root URL.** All 4 are
// loaded once at module scope and shared across every asteroid (the
// GPU reuses the same texture for hundreds of meshes). `RepeatWrapping`
// is a no-op with the current UVs (both icosphere built-in and capsule
// cylindrical map to [0, 1]) but safe if a future UV pass goes outside
// [0, 1].
const ASTEROID_ALBEDO_URL    = '/textures/asteroid-albedo.png';
const ASTEROID_NORMAL_URL    = '/textures/asteroid-normal.png';
const ASTEROID_ROUGHNESS_URL = '/textures/asteroid-roughness.png';
const ASTEROID_BUMP_URL      = '/textures/asteroid-bump.png';

let _asteroidAlbedo = null;
let _asteroidNormal = null;
let _asteroidRoughness = null;
let _asteroidBump = null;

/**
 * Lazily load (and cache) the shared asteroid albedo texture. sRGB.
 * Browser-only: the underlying `THREE.TextureLoader` needs an `Image`
 * global, so the first call in Node will throw — but `asteroid.js`
 * is only imported by the game's browser code path (`src/main.js`),
 * so this is safe.
 * @returns {THREE.Texture}
 */
function getAsteroidAlbedo() {
  if (_asteroidAlbedo) return _asteroidAlbedo;
  const loader = new THREE.TextureLoader();
  _asteroidAlbedo = loader.load(ASTEROID_ALBEDO_URL);
  _asteroidAlbedo.colorSpace = THREE.SRGBColorSpace;
  _asteroidAlbedo.wrapS = THREE.RepeatWrapping;
  _asteroidAlbedo.wrapT = THREE.RepeatWrapping;
  return _asteroidAlbedo;
}

/**
 * Lazily load (and cache) the shared asteroid normal map. **Linear
 * data, NOT sRGB** — normal vectors must not be gamma-decoded.
 * `NoColorSpace` tells Three.js to skip the sRGB→linear conversion.
 * @returns {THREE.Texture}
 */
function getAsteroidNormal() {
  if (_asteroidNormal) return _asteroidNormal;
  const loader = new THREE.TextureLoader();
  _asteroidNormal = loader.load(ASTEROID_NORMAL_URL);
  _asteroidNormal.colorSpace = THREE.NoColorSpace;
  _asteroidNormal.wrapS = THREE.RepeatWrapping;
  _asteroidNormal.wrapT = THREE.RepeatWrapping;
  return _asteroidNormal;
}

/**
 * Lazily load (and cache) the shared asteroid roughness map.
 * Linear data (one channel of microfacet-roughness values). Like the
 * normal map, `NoColorSpace` to skip sRGB decoding.
 * @returns {THREE.Texture}
 */
function getAsteroidRoughness() {
  if (_asteroidRoughness) return _asteroidRoughness;
  const loader = new THREE.TextureLoader();
  _asteroidRoughness = loader.load(ASTEROID_ROUGHNESS_URL);
  _asteroidRoughness.colorSpace = THREE.NoColorSpace;
  _asteroidRoughness.wrapS = THREE.RepeatWrapping;
  _asteroidRoughness.wrapT = THREE.RepeatWrapping;
  return _asteroidRoughness;
}

/**
 * Lazily load (and cache) the shared asteroid bump map. Linear data
 * (height field for the per-fragment derivative bump). `NoColorSpace`.
 * The actual `bumpScale` is set on the material (default 1.0, can be
 * tuned for stronger/weaker relief).
 * @returns {THREE.Texture}
 */
function getAsteroidBump() {
  if (_asteroidBump) return _asteroidBump;
  const loader = new THREE.TextureLoader();
  _asteroidBump = loader.load(ASTEROID_BUMP_URL);
  _asteroidBump.colorSpace = THREE.NoColorSpace;
  _asteroidBump.wrapS = THREE.RepeatWrapping;
  _asteroidBump.wrapT = THREE.RepeatWrapping;
  return _asteroidBump;
}

/**
 * Build the "irregular rock" body: a noise-displaced icosphere with
 * a 3-level LOD (detail 2 / detail 1 / detail 0 at close / mid / far
 * distances). Each LOD level uses the same per-instance noise offsets
 * and parameters, so they all represent the same asteroid at
 * different geometric resolutions. The noise is fbm-based (4 octaves)
 * and applied along the radial direction. Returns `{ lowestY, lod,
 * debugMeshes }`.
 */
function buildNoisyIcosphereBody(group, spec, rng, uvDebugOverlay) {
  const radius = spec.radius;

  // Per-asteroid noise offsets — generated once and shared across
  // all LOD levels so they all represent the same asteroid.
  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const oz = rng() * 1000;

  // Noise parameters (consistent across LOD levels):
  //   amount = 25% of radius (moderate irregularity)
  //   scale  = 2.0 / radius (consistent feature count regardless of size)
  const noiseAmount = 0.25 * radius;
  const noiseScale = 2.0 / radius;

  // Shared material across LOD levels (they all represent the same
  // asteroid, so they should look the same). One material for the
  // whole asteroid field (created per-body, but the 4 PBR maps are
  // shared at the module-scope loader).
  const material = createAsteroidMaterial();

  const lod = new THREE.LOD();

  // Level 0: close (detail 2, 162 vertices)
  const geomHigh = new NoisyIcosphere(
    radius, 2, noiseAmount, noiseScale, ox, oy, oz,
  );
  // Icosphere has default spherical UVs from IcosahedronGeometry —
  // no per-vertex UV unwrapping needed.
  const meshHigh = new THREE.Mesh(geomHigh, material);
  lod.addLevel(meshHigh, LOD_CLOSE_DIST);

  // Level 1: mid (detail 1, 42 vertices)
  const geomMid = new NoisyIcosphere(
    radius, 1, noiseAmount, noiseScale, ox, oy, oz,
  );
  const meshMid = new THREE.Mesh(geomMid, material);
  lod.addLevel(meshMid, LOD_MID_DIST);

  // Level 2: far (detail 0, 12 vertices)
  const geomLow = new NoisyIcosphere(
    radius, 0, noiseAmount, noiseScale, ox, oy, oz,
  );
  const meshLow = new THREE.Mesh(geomLow, material);
  lod.addLevel(meshLow, LOD_FAR_DIST);

  // If the UV debug overlay is supplied, attach a debug mesh to
  // each LOD level (the LOD picks the active child each frame; the
  // debug mesh is a sibling of the body on each level so it shows
  // up on all 3 detail levels).
  const debugMeshes = [];
  if (uvDebugOverlay) {
    const kinds = [
      { mesh: meshHigh, geom: geomHigh },
      { mesh: meshMid, geom: geomMid },
      { mesh: meshLow, geom: geomLow },
    ];
    for (const { mesh, geom } of kinds) {
      const debugMesh = uvDebugOverlay.attach(geom, 'icosphere');
      mesh.add(debugMesh);
      debugMeshes.push(debugMesh);
    }
  }

  group.add(lod);

  // Lowest y of the icosphere (worst case: -radius × (1 + noiseAmount/radius)
  // = -(radius + noiseAmount) = -1.25 × radius for the default 25% noise).
  return { lowestY: -(radius + noiseAmount), lod, debugMeshes };
}

/**
 * Body height segments for the capsule asteroid. The "pipe" (the
 * cylindrical middle of the capsule, between the two hemispherical
 * caps) is subdivided into this many quads along the +Y axis. More
 * segments = more vertices for `jitter()` to displace = a more
 * irregular, asteroid-like surface. The 2DOF MVP ships with 6
 * segments, which gives 7 body rings × 9 verts/ring = 63 body
 * vertices (vs. 18 with the default `heightSegments=1`).
 *
 * Tunable from this constant. The planar UV unwrap handles the
 * higher vertex count cleanly (one UV per vertex, computed from
 * the live local position).
 */
const CAPSULE_HEIGHT_SEGMENTS = 6;

/**
 * Which axis-aligned plane the capsule's planar UV unwrap projects
 * onto. `'xy'` gives a side view (U = x, V = y) — the best default
 * for the vertical capsule shape because the long axis is one of
 * the texture coordinates, so the texture runs the full length of
 * the potato. The other options are `'xz'` (top-down) and `'yz'`
 * (side view rotated 90°). The unwrap is in the mesh's LOCAL
 * frame, so the texture is "stuck to" the mesh — different
 * asteroids show different parts of the texture.
 *
 * Exported so `main.js` can sync the initial value of the
 * `window.ASTEROID_UV_PLANE` runtime setter (see
 * `src/systems/asteroid-uv-debug-overlay.js`). The runtime setter
 * can also change the plane live without rebuilding.
 */
export const CAPSULE_UV_PLANE = 'xy';

/**
 * Build the "potato" body: a single capsule with normal jitter for a
 * bumpy, irregular surface. Slightly elongated (length = 1.5 × R) so
 * it reads as a distinct shape vs the noisy-icosphere rocks.
 * Returns `{ lowestY, lod: null }`.
 *
 * Geometry polish: the body pipe is subdivided into
 * `CAPSULE_HEIGHT_SEGMENTS` quads along its length (default 6),
 * giving `jitter()` many more vertices to displace for a visibly
 * asteroid-like irregular surface. The cap segments stay at the
 * default 4 — they already have enough detail.
 *
 * Mapping: a local planar UV unwrap (`Capsule.computePlanarUVs`)
 * is applied AFTER `jitter()` so the UVs align with the displaced
 * surface and the texture is stuck to the mesh (no world-space
 * tricks). The same 4-map PBR `MeshStandardMaterial` is used as
 * the icosphere body — one material API, one set of textures,
 * two body types.
 */
function buildCapsuleBody(group, spec, rng, uvDebugOverlay) {
  const capsuleRadius = spec.radius;
  const capsuleLength = spec.radius * 1.5; // slightly elongated

  const geom = new Capsule(
    capsuleRadius,
    capsuleLength,
    4,                       // capSegments (unchanged)
    8,                       // radialSegments (unchanged)
    CAPSULE_HEIGHT_SEGMENTS, // body subdivisions
  );
  // Jitter (15% of radius). The capsule's `jitter()` method moves
  // each merged vertex along its local z axis (the surface normal).
  // The index buffer is unchanged, so the surface stays connected,
  // and the normal-direction displacement produces a visibly bumpy
  // "potato" surface without creating holes or twisted faces.
  // Regression-tested in tests/capsule.test.js.
  geom.jitter(capsuleRadius * 0.15, rng);
  // Simple planar UV projection after jitter so the texture aligns
  // with the displaced surface. `computePlanarUVs` projects onto the
  // xy plane (side view), giving a clean texture mapping for the
  // vertical capsule shape.
  geom.computePlanarUVs(CAPSULE_UV_PLANE);

  // Same material as the icosphere body — shared PBR maps, same
  // metalness/roughness. The visual difference between the two
  // body types is now the geometry shape alone, not the shading.
  const material = createAsteroidMaterial();

  const capsule = new THREE.Mesh(geom, material);
  // If the UV debug overlay is supplied, attach a debug mesh as a
  // child of the body mesh. The debug mesh shares the geometry
  // (no extra memory) and renders the 10x10 UV grid pattern.
  const debugMeshes = [];
  if (uvDebugOverlay) {
    const debugMesh = uvDebugOverlay.attach(geom, 'capsule');
    capsule.add(debugMesh);
    debugMeshes.push(debugMesh);
  }
  group.add(capsule);

  return { lowestY: -(capsuleLength / 2 + capsuleRadius), lod: null, debugMeshes };
}

/**
 * Add the debug square ground footprint. Sits horizontally below the
 * body at `groundY` in the group's local frame. Rotates with the
 * group (it is a child, not a world-space ground).
 */
function addDebugGround(group, spec, groundY) {
  const groundGeom = new THREE.PlaneGeometry(spec.radius * 2, spec.radius * 2);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x1a2a3a,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2; // horizontal in the group's local frame
  ground.position.y = groundY;
  group.add(ground);
}

/**
 * Create an asteroid entity from a spec and add it to the scene.
 * @param {{
 *   spec: import('../world/types.js').AsteroidSpec,
 *   scene: import('three').Scene,
 *   uvDebugOverlay?: object,
 * }} opts
 */
/**
 * localStorage key prefix for per-type UV templates saved by the
 * UV editor's SAVE TEMPLATE button. The full key is
 * `asteroid-uv-template-${type}` (e.g. `asteroid-uv-template-icosphere`).
 * Templates are plain JSON (same shape as the SAVE JSON file,
 * minus the per-instance metadata) and are applied 1:1 by
 * vertex index to the new asteroid's body geometry on creation.
 */
const UV_TEMPLATE_KEY_PREFIX = 'asteroid-uv-template-';

/**
 * If a UV template has been saved for this asteroid's body
 * type, copy its UV attribute onto the new geometry. Vertex
 * count must match (same detail level on icosphere, same
 * capsule parameters) — the function silently no-ops on a
 * mismatch (a future change in mesh parameters would need a
 * re-save). The seams from the template are stashed on
 * `mesh.userData.templateSeams` so the UV editor can pick
 * them up the next time the user opens this asteroid.
 *
 * @param {THREE.Group} mesh
 * @param {import('../world/types.js').AsteroidSpec} spec
 */
function applyUvTemplate(mesh, spec) {
  if (typeof localStorage === 'undefined') return;
  const type = getAsteroidType(spec);
  let raw;
  try { raw = localStorage.getItem(UV_TEMPLATE_KEY_PREFIX + type); }
  catch (_) { return; } // localStorage disabled / quota
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (_) { return; }
  if (!data || !Array.isArray(data.uvs)) return;
  const body = mesh.children[0];
  if (!body) return;
  // Use the same body the UV editor reads from (highest-detail
  // LOD level for icospheres, the capsule mesh for capsules).
  const geom = body.isLOD ? body.levels[0].object.geometry : body.geometry;
  if (!geom || !geom.attributes.uv) return;
  const uvAttr = geom.attributes.uv;
  if (uvAttr.array.length !== data.uvs.length) return; // vertex count mismatch
  for (let i = 0; i < uvAttr.array.length; i++) uvAttr.array[i] = data.uvs[i];
  uvAttr.needsUpdate = true;
  // Stash seams so the editor can adopt them if the user opens
  // this asteroid. The editor's seam-set is session-scoped;
  // the template's seams only take effect when the user
  // opens the editor for this asteroid.
  if (Array.isArray(data.seams)) {
    mesh.userData.templateSeams = new Set(data.seams);
  }
}

export function createAsteroidFromSpec({ spec, scene, uvDebugOverlay }) {
  if (!scene) throw new Error('createAsteroidFromSpec: `scene` is required');
  if (!spec) throw new Error('createAsteroidFromSpec: `spec` is required');

  const mesh = buildAsteroidMesh(spec, uvDebugOverlay);
  // Apply any per-type UV template saved by the UV editor's
  // SAVE TEMPLATE button. Runs AFTER the mesh is built so the
  // geometry's `uv` attribute is fully populated. The 1:1 UV
  // copy assumes matching vertex counts across asteroids of
  // the same type (true for the current mesh parameters).
  applyUvTemplate(mesh, spec);
  scene.add(mesh);

  let rotation = 0; // accumulated angle (radians) around `spec.axis`

  /**
   * Per-frame update. The `camera` argument is required for asteroids
   * with a LOD body (so the LOD can pick the right level); it's a
   * no-op for non-LOD bodies.
   * @param {number} dt seconds
   * @param {THREE.Camera} [camera] required for LOD updates
   */
  function update(dt, camera) {
    if (dt <= 0) return;
    rotation += spec.spin * dt;
    _scratchAxis.set(spec.axis.x, spec.axis.y, spec.axis.z);
    mesh.quaternion.setFromAxisAngle(_scratchAxis, rotation);
    mesh.position.x += spec.velocity.x * dt;
    mesh.position.z += spec.velocity.z * dt;
    mesh.position.y = PLAY_PLANE_Y;

    // Update the LOD (if the body is one). `LOD.update(camera)` is a
    // no-op for LODs with 0 or 1 levels, so it's safe to call every
    // frame for all asteroids.
    const lod = mesh.userData.lod;
    if (lod && camera) lod.update(camera);
  }

  /**
   * Split this asteroid into 0–2 smaller children.
   * Small asteroids (size 2) return [] — they vanish on hit.
   * Children are positioned at the parent's current world location with
   * a small offset and an outward velocity kick.
   * @returns {Array<import('../world/types.js').AsteroidSpec>}
   */
  function split() {
    if (spec.size >= 2) return [];
    const nextSize = spec.size + 1;
    const childRadius = spec.radius * SPLIT_RADIUS_RATIO;
    const rng = mulberry32((spec.seed ^ (nextSize * 0x9e3779b1)) >>> 0);

    const children = [];
    for (let i = 0; i < 2; i++) {
      const angle = (i / 2) * Math.PI * 2 + rng() * 0.5;
      const offset = spec.radius * 0.4;
      const px = mesh.position.x + Math.cos(angle) * offset;
      const pz = mesh.position.z + Math.sin(angle) * offset;

      const vx = spec.velocity.x + Math.cos(angle) * SPLIT_KICK;
      const vz = spec.velocity.z + Math.sin(angle) * SPLIT_KICK;

      // Random unit-vector axis
      const uz = 1 - rng() * 2;
      const phi = rng() * Math.PI * 2;
      const ur = Math.sqrt(Math.max(0, 1 - uz * uz));
      const ax = ur * Math.cos(phi);
      const ay = ur * Math.sin(phi);
      const az = uz;

      children.push({
        id: `${spec.id}-s${i}`,
        position: { x: px, y: PLAY_PLANE_Y, z: pz },
        radius: childRadius,
        size: nextSize,
        axis: { x: ax, y: ay, z: az },
        spin: 0.5 + rng() * 1.5,
        velocity: { x: vx, y: 0, z: vz },
        seed: (rng() * 1e9) | 0,
      });
    }
    return children;
  }

  function dispose() {
    scene.remove(mesh);
    // If a UV debug overlay was supplied, unregister every debug
    // mesh we attached. The overlay's shared material is NOT
    // disposed here (it's shared across all asteroids; the
    // overlay's `dispose()` handles it when the overlay is
    // disposed).
    const debugMeshes = mesh.userData.debugMeshes || [];
    for (const dm of debugMeshes) {
      if (uvDebugOverlay && typeof uvDebugOverlay.detach === 'function') {
        uvDebugOverlay.detach(dm);
      }
      // The debug mesh's parent (the body mesh) is being disposed
      // below; the debug mesh will be garbage-collected as part
      // of the recursive dispose.
    }
    // `mesh` is a Group containing a debug ground plane + body mesh
    // (LOD or capsule), each with its own geometry and material.
    // Release both per child.
    for (const child of mesh.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  return {
    mesh,
    spec,
    update,
    split,
    dispose,
    /** @returns {number} collision radius in world units */
    getRadius() { return spec.radius; },
    /** @returns {{x:number,y:number,z:number}} live world position (mutated) */
    getPosition() { return mesh.position; },
  };
}
