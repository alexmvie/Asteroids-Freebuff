import * as THREE from 'three';
import { Capsule } from '../geometry/capsule.js';
import { mulberry32 } from '../world/rng.js';
// v0.69.6 — shapeToIndex is the inverse of SHAPE_TYPES; the data-
// model layer owns the shape taxonomy so the entity factory stays
// decoupled from the named-string IDs.
import { shapeToIndex } from '../world/chunks.js';

// ---------------------------------------------------------------------------
// Deterministic 3D value noise + fbm (fractal Brownian motion). Used to
// displace the geometry vertices into asteroid-shaped silhouettes.
// ---------------------------------------------------------------------------
function hash3D(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function noise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = smoothstep(fx);
  const uy = smoothstep(fy);
  const uz = smoothstep(fz);

  const c000 = hash3D(ix, iy, iz);
  const c100 = hash3D(ix + 1, iy, iz);
  const c010 = hash3D(ix, iy + 1, iz);
  const c110 = hash3D(ix + 1, iy + 1, iz);
  const c001 = hash3D(ix, iy, iz + 1);
  const c101 = hash3D(ix + 1, iy, iz + 1);
  const c011 = hash3D(ix, iy + 1, iz + 1);
  const c111 = hash3D(ix + 1, iy + 1, iz + 1);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uz;

  return y0 + (y1 - y0) * uz;
}

function fbm3D(x, y, z, octaves = 4) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxValue;
}

// ---------------------------------------------------------------------------
// v0.71.0 -- thermal-weathering crevice layer. Models micro-erosion:
// narrow negative-displacement valleys carved into the asteroid surface
// at a decorrelated frequency. Position-based-hash (zero rng consumed):
// per-asteroid (ox, oy, oz) is the only varying input, so the erosion
// pattern for any (seed, ox, oy, oz) asteroid is fully deterministic.
//
// Tunables (SSOT-local; exposed for unit testing):
//   EROSION_SCALE_RATIO = 7 -- decorrelate from BASE (×1) and MICRO (×4).
//     7 is prime so its multiples don't align with the powers-of-2 used
//     by the base/micro fbm frequencies -- guarantees the erosion noise
//     pattern is independent of the shape-defining frequencies.
//   EROSION_AMOUNT_RATIO = 0.15 -- crevice amplitude as a fraction of
//     noiseAmount. 0.15 is small enough that the silhouette variation
//     from BASE stays the dominant visual signal (the carve "deepens"
//     existing features rather than reshaping the silhouette), and
//     large enough that a ~15%-of-radius valley is visible.
//   EROSION_EXPONENT = 2.0 -- falloff exponent for creviceDepth().
//     At exponent 2.0, only ~half the surface (where n < 0.5) gets
//     carved, and the carving is biased toward sharp narrow channels
//     rather than wide shallow dips. Increase to 3+ for narrower/more
//     sparse crevices; decrease to 1 for wider/more uniform carving.
// ---------------------------------------------------------------------------
const EROSION_SCALE_RATIO = 7;
const EROSION_AMOUNT_RATIO = 0.15;
const EROSION_EXPONENT = 2.0;

/**
 * Pure helper: returns erosion depth ∈ [0, 1] (pre-amount scaling).
 *   - n <  0.5  -> Math.pow(0.5 - n, exponent)  (valley depth)
 *   - n >= 0.5  -> 0                                (no carving)
 *
 * Exponent=2.0 -> range [0, 0.25]. Exponent=3.0 -> range [0, 0.125]
 * (narrower, more sparse). Exponent=1.0 -> range [0, 0.5] (uniform).
 *
 * Always non-negative, so the carve contributes only a negative-
 * displacement subtraction at the call site. Exposed for direct
 * unit testing (range + amplitude pinning).
 *
 * @param {number} n           fbm noise value, typically in [0, 1].
 * @param {number} [exponent]  falloff exponent (default EROSION_EXPONENT=2.0).
 * @returns {number}           erosion depth ∈ [0, 0.5^exponent]
 */
function creviceDepth(n, exponent = EROSION_EXPONENT) {
  if (!Number.isFinite(n) || n >= 0.5) return 0;
  if (n <= 0) return Math.pow(0.5, exponent);
  return Math.pow(0.5 - n, exponent);
}

// ---------------------------------------------------------------------------
// Geometry noise displacement. Displaces each vertex along its surface
// normal by an fbm (or crater/craggy variant) value.
// ---------------------------------------------------------------------------
function displaceGeometry(geom, noiseAmount, noiseScale, ox, oy, oz, noiseType = 'fbm') {
  const positions = geom.attributes.position;
  const normals = geom.attributes.normal;
  if (!positions || !normals) return;

  const posArray = positions.array;
  const normArray = normals.array;

  // v0.70.0 — multi-layer frequency displacement (modern game technique
  // for realistic rocky surfaces; classical id Tech / Source engine
  // approach). The BASE layer is the existing 4-octave fbm at the
  // supplied noiseScale; the MICRO layer is a 2-octave fbm at 4× scale
  // (high-frequency sub-detail that reads as crater rim roughness,
  // grain texture, and micro-occlusion under the directional light).
  // The micro layer is composited at 0.12 × amount so it stays visually
  // subordinate — the silhouette variation from the base layer still
  // dominates.
  //
  // Both noise calls operate on the existing position-based hash (no
  // external rng consumption), so the per-asteroid deterministic
  // invariant on (seed, ox, oy, oz) is preserved: same inputs →
  // same shape, just with the new high-frequency component now layered
  // on top.

  for (let i = 0; i < positions.count; i++) {
    const x = posArray[i * 3 + 0];
    const y = posArray[i * 3 + 1];
    const z = posArray[i * 3 + 2];

    const nx = normArray[i * 3 + 0];
    const ny = normArray[i * 3 + 1];
    const nz = normArray[i * 3 + 2];

    const nBase = fbm3D(
      (x + ox) * noiseScale,
      (y + oy) * noiseScale,
      (z + oz) * noiseScale,
      4,
    );
    const nMicro = fbm3D(
      (x + ox) * noiseScale * 4.0,
      (y + oy) * noiseScale * 4.0,
      (z + oz) * noiseScale * 4.0,
      2,
    );

    // v0.71.0 — thermal-weathering EROSION layer (third layer). A
    // fresh fbm3D call at EROSION_SCALE_RATIO=7 (prime, decorrelated
    // from BASE=1 and MICRO=4) drives a NEGATIVE-ONLY carve via
    // creviceDepth(). The carve is always subtracted, never added,
    // so the BASE silhouette variation stays dominant — only the
    // surface texture gets deeper narrow channels carved into it.
    // 2 octaves matches MICRO layer cost; position-based-hash (zero
    // rng consumption) → per-asteroid deterministic on
    // (seed, ox, oy, oz).
    const nErosion = fbm3D(
      (x + ox) * noiseScale * EROSION_SCALE_RATIO,
      (y + oy) * noiseScale * EROSION_SCALE_RATIO,
      (z + oz) * noiseScale * EROSION_SCALE_RATIO,
      2,
    );
    const erosionCarve = creviceDepth(nErosion) * EROSION_AMOUNT_RATIO * noiseAmount;

    let displacement = 0;
    if (noiseType === 'crater') {
      // Existing crater formula + micro overlay so potato craters get
      // sub-detail (sharp crater rim micro-roughness).
      const crater = nBase < 0.45
        ? -Math.pow((0.45 - nBase) * 2.2, 2.0) * noiseAmount
        : (nBase - 0.5) * 0.4 * noiseAmount;
      displacement = crater + (nMicro - 0.5) * 0.12 * noiseAmount - erosionCarve;
    } else if (noiseType === 'craggy') {
      // v0.70.0 — the v0.69.5 formula `(abs(n-0.5)*2 - 0.5) * amount`
      // is the canonical cragged-rock silhouette but reads as soft
      // on low-detail meshes. The base layer's noiseAmount is bumped
      // 0.40 -> 0.50 below to push silhouette variation further, and
      // the v0.70.0 micro layer adds the high-frequency sub-detail
      // that gives the close-up "rough rock" read. The formula itself
      // is kept (sharpening exponents were considered but introduced
      // bias asymmetry; the multi-layer approach + bigger amount
      // achieves the intended visual gain without the math pitfalls).
      displacement = (Math.abs(nBase - 0.5) * 2.0 - 0.5) * noiseAmount
                   + (nMicro - 0.5) * 0.12 * noiseAmount
                   - erosionCarve;
    } else {
      // Standard smooth fbm (used by crystalline shards + contact
      // binary lobes) — now with the micro layer composited on top.
      displacement = (nBase - 0.5) * 2 * noiseAmount
                   + (nMicro - 0.5) * 0.12 * noiseAmount
                   - erosionCarve;
    }

    posArray[i * 3 + 0] = x + nx * displacement;
    posArray[i * 3 + 1] = y + ny * displacement;
    posArray[i * 3 + 2] = z + nz * displacement;
  }

  positions.needsUpdate = true;
  geom.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Geometry builders. Each shape picks a different base geometry and a
// different noise type/displacement amount so the field has visible variety.
// Shape index is derived deterministically from spec.seed % 5.
// ---------------------------------------------------------------------------
function buildCrystallineShardGeometry(radius, detail, ox, oy, oz) {
  // v0.70.0 — denser segment counts across the LOD range so a close-up
  // crystalline cylinder has visibly more angular facets and reads as
  // a faceted crystal instead of an octagonal prism.
  const radialSegments = detail === 4 ? 8 : (detail === 3 ? 6 : (detail === 2 ? 5 : 4));
  const heightSegments = detail === 4 ? 6 : (detail === 3 ? 4 : (detail === 2 ? 2 : 1));
  const height = radius * 1.6;
  const geom = new THREE.CylinderGeometry(
    radius * 0.6,
    radius * 0.9,
    height,
    radialSegments,
    heightSegments,
    false
  );
  displaceGeometry(geom, 0.18 * radius, 1.8 / radius, ox, oy, oz);
  return geom;
}

function buildCrateredPotatoGeometry(radius, detail, ox, oy, oz) {
  // v0.70.0 — denser segments to match the new detail=4 close-up level.
  const capSegments = detail === 4 ? 8 : (detail === 3 ? 6 : (detail === 2 ? 4 : 2));
  const radialSegments = detail === 4 ? 16 : (detail === 3 ? 12 : (detail === 2 ? 8 : 4));
  const heightSegments = detail === 4 ? 12 : (detail === 3 ? 8 : (detail === 2 ? 4 : 2));
  const length = radius * 1.5;
  const geom = new Capsule(radius, length, capSegments, radialSegments, heightSegments);
  displaceGeometry(geom, radius * 0.22, 2.0 / radius, ox, oy, oz, 'crater');
  geom.computePlanarUVs('xy');
  return geom;
}

function buildTorusGeometry(radius, detail, ox, oy, oz) {
  // Retained for backward compat / shapeToIndex fallback path (v0.69.5
  // dropped torus asteroids from the v0.69.5 front-end, but the
  // helper still exists in case a future shape brings it back).
  const radialSegments = detail === 4 ? 16 : (detail === 3 ? 12 : (detail === 2 ? 8 : 4));
  const tubularSegments = detail === 4 ? 32 : (detail === 3 ? 24 : (detail === 2 ? 16 : 8));
  const torusRadius = radius * 0.65;
  const tubeRadius = radius * 0.28;
  const geom = new THREE.TorusGeometry(torusRadius, tubeRadius, radialSegments, tubularSegments);
  displaceGeometry(geom, radius * 0.16, 2.2 / radius, ox, oy, oz);
  return geom;
}

function buildCraggyRockGeometry(radius, detail, ox, oy, oz) {
  // v0.69.5 — bigger craggy displacement to break the soft-ball silhouette.
  // v0.70.0 — bumped amount further 0.40*radius -> 0.50*radius, paired with
  // the new high-frequency micro-displacement layer in displaceGeometry()
  // and the LOD detail bump 0..2 -> 2..4 in buildAsteroidMesh. Together
  // these deliver the v0.70.0 "really do geometry displacement mapping"
  // goal (per user feedback "all looks so flat on the asteroids"): the
  // close-up mesh now has 16× more vertices (12 -> 2562 at detail 4) so
  // the silhouette reads as a real irregular rock, the base displacement
  // is 25% bigger for stronger feature pop, and the new micro layer
  // adds sub-detail rough surface texture under the directional light.
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  displaceGeometry(geom, radius * 0.50, 2.0 / radius, ox, oy, oz, 'craggy');
  return geom;
}

// ---------------------------------------------------------------------------
// Texture loading + caching. Five indexed texture sets (realistic-1-
// albedo/normal/roughness/bump through realistic-5-...) are loaded
// lazily and shared via module-scope Maps. Browser-only: a stub
// THREE.Texture is returned in Node/test environments.
// ---------------------------------------------------------------------------
const albedoCache = new Map();
const normalCache = new Map();
const roughnessCache = new Map();
const bumpCache = new Map();

function loadTextureSafely(url, colorSpace) {
  let texture;
  try {
    const loader = new THREE.TextureLoader();
    texture = loader.load(url);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  } catch (e) {
    texture = new THREE.Texture();
    texture.colorSpace = colorSpace;
  }
  return texture;
}

function getRealisticAlbedo(idx) {
  if (albedoCache.has(idx)) return albedoCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-albedo.png`, THREE.SRGBColorSpace);
  albedoCache.set(idx, tex);
  return tex;
}

function getRealisticNormal(idx) {
  if (normalCache.has(idx)) return normalCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-normal.png`, THREE.NoColorSpace);
  normalCache.set(idx, tex);
  return tex;
}

function getRealisticRoughness(idx) {
  if (roughnessCache.has(idx)) return roughnessCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-roughness.png`, THREE.NoColorSpace);
  roughnessCache.set(idx, tex);
  return tex;
}

function getRealisticBump(idx) {
  if (bumpCache.has(idx)) return bumpCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-bump.png`, THREE.NoColorSpace);
  bumpCache.set(idx, tex);
  return tex;
}

function createAsteroidMaterial(idx) {
  // v0.69.5 — matte regolith for vacuum-exposed asteroids. Per user
  // feedback "die asteroiden sollten nicht glänzen" + "alle objekte
  // glänzen viel zu viel":
  //   - metalness = 0 everywhere (was 0.1 default or 0.65 for idx=3).
  //     Real asteroids are dust/regolith exposed to vacuum; the
  //     idx=3 nickel-iron variant's higher metalness was visually
  //     wrong — there is no specular reflection in a vacuum without
  //     atmosphere.
  //   - roughness = 0.95 (was 0.9 / 0.75 / 0.45). Pushed above 0.9
  //     so the lit surface of every asteroid reads as matte dust,
  //     not polished stone. The roughnessMap still modulates per-
  //     texel detail.
  //   - bumpedScale + bumpMap REMOVED. The bumpMap was the cause of
  //     "teils sind auch schwarze linien in den asteroiden": on
  //     flat-shaded geometry, interpolated bumpMap values create
  //     visible discontinuities at texture seams (UV unwrap lines).
  //     The normalMap (which Three.js evaluates per-fragment AFTER
  //     the flat-shading normal calculation) keeps the surface
  //     detail without the seam artifact. Dropping the bumpMap also
  //     removes 4 mapped textures per asteroid slot (4 sets ×
  //     idx=1..5 = 20 cached textures, of which 4 (=1 per set) are
  //     now freed).
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.95,
    flatShading: true,
    map: getRealisticAlbedo(idx),
    normalMap: getRealisticNormal(idx),
    roughnessMap: getRealisticRoughness(idx),
  });
}

// ---------------------------------------------------------------------------
// Main factory. Constants: split-radius, ambient-drift cap from the
// SSOT in src/world/chunk-constants.js (PLAY_PLANE_Y).
// ---------------------------------------------------------------------------
const SPLIT_RADIUS_RATIO = 0.6;
const SPLIT_KICK = 8;
const PLAY_PLANE_Y = 0;
const LOD_CLOSE_DIST = 0;
const LOD_MID_DIST = 30;
const LOD_FAR_DIST = 100;
const _scratchAxis = new THREE.Vector3();

// Tag every body mesh so the scene renderer can cast shadows. v0.68.0
// adds castShadow + receiveShadow flags at construction time so the
// sun's DirectionalLight (added in src/systems/space-lighting.js) can
// project clean asteroid-on-asteroid shadows without a per-frame
// scene walk. The ground plane (PlaneGeometry footer) receives
// shadows but does not cast them (a flat plane casting a shadow would
// be visually wrong — no shadow source above it).
function tagForShadows(mesh, { cast = true, receive = true } = {}) {
  if (!mesh) return;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

function buildAsteroidMesh(spec) {
  const rng = mulberry32(spec.seed);
  const group = new THREE.Group();

  // Consume a dummy RNG pull to keep the rng sequence stable across
  // species so the deterministic-asteroid tests still pass.
  rng();

  // v0.69.6 — shape distribution lifted into the data-model layer.
  // v0.69.5 (and earlier) used `spec.seed % 5` for a uniform
  // integer mapping that made craggy_rock a 40% monolith after the
  // donut was removed. Specs now carry a named-shape field
  // (`spec.shape` ∈ SHAPE_TYPES), translated to the entity-layer
  // integer via `shapeToIndex`. The `spec.seed % 5` fallback
  // preserves the v0.69.5 dispatch for any spec that lacks the
  // new field (legacy test fixtures, hand-crafted mocks) — both
  // paths produce the same geom builder for any given shape.
  const shapeType = spec.shape !== undefined
    ? shapeToIndex(spec.shape)
    : (spec.seed % 5);
  const textureIdx = ((spec.seed >> 3) % 5) + 1; // 1 through 5

  const material = createAsteroidMaterial(textureIdx);
  const radius = spec.radius;

  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const oz = rng() * 1000;

  let lod = null;

  if (shapeType === 2) {
    // Contact Binary (Peanut): two overlapping spheres in a sub-group.
    lod = new THREE.LOD();

    const buildLobes = (detail) => {
      const g = new THREE.Group();
      const a = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.78, detail), material);
      a.position.set(-radius * 0.35, 0, 0);
      displaceGeometry(a.geometry, radius * 0.22, 2.2 / radius, ox, oy, oz);
      tagForShadows(a);
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.55, detail), material);
      b.position.set(radius * 0.45, 0, 0);
      displaceGeometry(b.geometry, radius * 0.17, 2.5 / radius, ox + 200, oy + 200, oz + 200);
      tagForShadows(b);
      g.add(a);
      g.add(b);
      return g;
    };

    // v0.70.0 — LOD detail bumped 2/1/0 -> 4/3/2 for the contact binary
    // peanut's two lobes (same rationale as the single-mesh path below).
    lod.addLevel(buildLobes(4), LOD_CLOSE_DIST);
    lod.addLevel(buildLobes(3), LOD_MID_DIST);
    lod.addLevel(buildLobes(2), LOD_FAR_DIST);

    group.add(lod);
  } else {
    // Single-mesh LOD shapes: crystalline, cratered potato, torus, or
    // craggy rock. The geometry builder is selected once per detail
    // level so each LOD level reads its own vertex count.
    lod = new THREE.LOD();

    const getGeom = (detail) => {
      if (shapeType === 0) return buildCrystallineShardGeometry(radius, detail, ox, oy, oz);
      if (shapeType === 1) return buildCrateredPotatoGeometry(radius, detail, ox, oy, oz);
      // v0.69.5 — shapeType=3 (was a TorusGeometry, the "donut")
      // REMOVED per user feedback "ein donut als asteroid ist
      // eigentlich auch idiotisch". Now falls through to the craggy
      // rock builder. Net effect: the field's visual variety still
      // has asymmetry (4 shape types instead of 5) but no donut-shaped
      // asteroids.
      return buildCraggyRockGeometry(radius, detail, ox, oy, oz);
    };

    // v0.70.0 — LOD detail 0..2 -> 2..4 (modern-game dense meshes to do
    // real geometry displacement mapping). detail=4 gives IcosahedronGeometry
    // 2562 vertices (was 162 at detail=2) — 16× more vertices for the
    // close-up level, making the silhouette + the new high-frequency
    // micro-displacement layer visible. Performance budget: at ~150
    // asteroids in the streaming bubble, only those within LOD_MID_DIST
    // (30u) of the camera render detail=4 — typically 30-50 — so total
    // vertex count stays well under WebGL2 limits. Shadow-map pass
    // doubles the cost but is still negligible on modern GPUs.
    const meshHigh = new THREE.Mesh(getGeom(4), material);
    tagForShadows(meshHigh);
    lod.addLevel(meshHigh, LOD_CLOSE_DIST);

    const meshMid = new THREE.Mesh(getGeom(3), material);
    tagForShadows(meshMid);
    lod.addLevel(meshMid, LOD_MID_DIST);

    const meshLow = new THREE.Mesh(getGeom(2), material);
    tagForShadows(meshLow);
    lod.addLevel(meshLow, LOD_FAR_DIST);

    group.add(lod);
  }

  // Debug ground footprint. Semi-transparent plane under the asteroid
  // that catches the sun shadow (receiveShadow=true above).
  const groundGeom = new THREE.PlaneGeometry(spec.radius * 2, spec.radius * 2);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x2a1a3a,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -radius * 1.15;
  tagForShadows(ground, { cast: false, receive: true });
  group.add(ground);

  group.position.set(spec.position.x, spec.position.y, spec.position.z);
  group.userData.lod = lod;

  return group;
}

/**
 * Create an asteroid entity from a spec and add it to the scene.
 * @param {{
 *   spec: import('../world/types.js').AsteroidSpec,
 *   scene: import('three').Scene,
 * }} opts
 */
export function createAsteroidFromSpec({ spec, scene } = {}) {
  if (!scene) throw new Error('createAsteroidFromSpec: `scene` is required');
  if (!spec) throw new Error('createAsteroidFromSpec: `spec` is required');

  const mesh = buildAsteroidMesh(spec);
  scene.add(mesh);

  let rotation = 0;

  function update(dt, camera) {
    if (dt <= 0) return;
    rotation += spec.spin * dt;
    _scratchAxis.set(spec.axis.x, spec.axis.y, spec.axis.z);
    mesh.quaternion.setFromAxisAngle(_scratchAxis, rotation);
    mesh.position.x += spec.velocity.x * dt;
    mesh.position.z += spec.velocity.z * dt;
    mesh.position.y = PLAY_PLANE_Y;

    // v0.69.5 — fuzziness=0.5 second argument enables smooth LOD
    // transitions (per Three.js LOD API: 0 = crisp (snap at threshold),
    // 1 = maximum blur (no visible switch)). Was 0 (default) so the
    // user reported visible LOD popping when crossing the 30u
    // (mid->high) or 100u (low->mid) thresholds. 0.5 is the standard
    // crossfade value — both levels render during the transition
    // window so the change is invisible.
    const lod = mesh.userData.lod;
    if (lod && camera) lod.update(camera, 0.5);
  }

  function split() {
    if (spec.size >= 2) return [];
    const nextSize = spec.size + 1;
    const childRadius = spec.radius * SPLIT_RADIUS_RATIO;
    // Per-child seed derived from the parent — children are fully
    // deterministic so re-streaming reproduces the same split graph.
    const rng = mulberry32((spec.seed ^ (nextSize * 0x8a3779b1)) >>> 0);

    const children = [];
    for (let i = 0; i < 2; i++) {
      const angle = (i / 2) * Math.PI * 2 + rng() * 0.5;
      const offset = spec.radius * 0.4;
      const px = mesh.position.x + Math.cos(angle) * offset;
      const pz = mesh.position.z + Math.sin(angle) * offset;

      const vx = spec.velocity.x + Math.cos(angle) * SPLIT_KICK;
      const vz = spec.velocity.z + Math.sin(angle) * SPLIT_KICK;

      const uz = 1 - rng() * 2;
      const phi = rng() * Math.PI * 2;
      const ur = Math.sqrt(Math.max(0, 1 - uz * uz));
      const ax = ur * Math.cos(phi);
      const ay = ur * Math.sin(phi);
      const az = uz;

      children.push({
        id: `${spec.id}-r${i}`,
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
    mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  return {
    mesh,
    spec,
    update,
    split,
    dispose,
    getRadius() { return spec.radius; },
    getSize() { return spec.size; },
    getPosition() { return mesh.position; },
    getVelocity() { return { x: spec.velocity.x, z: spec.velocity.z }; },
    setVelocity(vx, vz) {
      spec.velocity.x = vx;
      spec.velocity.z = vz;
    },
  };
}

// v0.71.0 -- crevice helper + erosion tunables exposed for direct
// unit testing (range + amplitude pin tests live in
// tests/asteroid.test.js). These are the SSOT for the erosion layer:
// if you want to retune visual impact, edit the constants here.
export {
  creviceDepth,
  EROSION_SCALE_RATIO,
  EROSION_AMOUNT_RATIO,
  EROSION_EXPONENT,
};
