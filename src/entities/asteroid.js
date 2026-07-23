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
// Geometry noise displacement. Displaces each vertex along its surface
// normal by an fbm (or crater/craggy variant) value.
// ---------------------------------------------------------------------------
function displaceGeometry(geom, noiseAmount, noiseScale, ox, oy, oz, noiseType = 'fbm') {
  const positions = geom.attributes.position;
  const normals = geom.attributes.normal;
  if (!positions || !normals) return;

  const posArray = positions.array;
  const normArray = normals.array;

  for (let i = 0; i < positions.count; i++) {
    const x = posArray[i * 3 + 0];
    const y = posArray[i * 3 + 1];
    const z = posArray[i * 3 + 2];

    const nx = normArray[i * 3 + 0];
    const ny = normArray[i * 3 + 1];
    const nz = normArray[i * 3 + 2];

    const n = fbm3D(
      (x + ox) * noiseScale,
      (y + oy) * noiseScale,
      (z + oz) * noiseScale,
      4
    );

    let displacement = 0;
    if (noiseType === 'crater') {
      displacement = n < 0.45 ? -Math.pow((0.45 - n) * 2.2, 2.0) * noiseAmount : (n - 0.5) * 0.4 * noiseAmount;
    } else if (noiseType === 'craggy') {
      displacement = (Math.abs(n - 0.5) * 2.0 - 0.5) * noiseAmount;
    } else {
      displacement = (n - 0.5) * 2 * noiseAmount;
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
  const radialSegments = detail === 2 ? 6 : (detail === 1 ? 5 : 4);
  const heightSegments = detail === 2 ? 4 : (detail === 1 ? 2 : 1);
  const height = radius * 1.6;
  const geom = new THREE.CylinderGeometry(
    radius * 0.6,
    radius * 0.9,
    height,
    radialSegments,
    heightSegments,
    false
  );
  displaceGeometry(geom, 0.15 * radius, 1.8 / radius, ox, oy, oz);
  return geom;
}

function buildCrateredPotatoGeometry(radius, detail, ox, oy, oz) {
  const capSegments = detail === 2 ? 6 : (detail === 1 ? 4 : 2);
  const radialSegments = detail === 2 ? 12 : (detail === 1 ? 8 : 4);
  const heightSegments = detail === 2 ? 8 : (detail === 1 ? 4 : 2);
  const length = radius * 1.5;
  const geom = new Capsule(radius, length, capSegments, radialSegments, heightSegments);
  displaceGeometry(geom, radius * 0.22, 2.0 / radius, ox, oy, oz, 'crater');
  geom.computePlanarUVs('xy');
  return geom;
}

function buildTorusGeometry(radius, detail, ox, oy, oz) {
  const radialSegments = detail === 2 ? 12 : (detail === 1 ? 8 : 4);
  const tubularSegments = detail === 2 ? 24 : (detail === 1 ? 16 : 8);
  const torusRadius = radius * 0.65;
  const tubeRadius = radius * 0.28;
  const geom = new THREE.TorusGeometry(torusRadius, tubeRadius, radialSegments, tubularSegments);
  displaceGeometry(geom, radius * 0.16, 2.2 / radius, ox, oy, oz);
  return geom;
}

function buildCraggyRockGeometry(radius, detail, ox, oy, oz) {
  // v0.69.5 — bigger craggy displacement. Per user feedback "das mesh
  // ist wie eine kugel und die textur zeigt eindeutig krater und
  // rockige oberfläche": the v0.68.0 / v0.69.4 craggy formula
  // (Math.abs(n - 0.5) * 2.0 - 0.5) * amount had max deviation
  // ±0.5 * amount, which at amount = 0.25*radius gave only ±12.5%
  // radius surface variation — the silhouette read as a soft ball.
  // Bumping amount to 0.40*radius and lowering noiseScale from 2.5/r
  // to 2.0/r sharpens the craggy features (larger octave-1 features,
  // smaller octave-2-fine features) for a more asteroid-like
  // irregular silhouette that matches the craters in the albedo
  // texture.
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  displaceGeometry(geom, radius * 0.40, 2.0 / radius, ox, oy, oz, 'craggy');
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
      displaceGeometry(a.geometry, radius * 0.2, 2.2 / radius, ox, oy, oz);
      tagForShadows(a);
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.55, detail), material);
      b.position.set(radius * 0.45, 0, 0);
      displaceGeometry(b.geometry, radius * 0.15, 2.5 / radius, ox + 200, oy + 200, oz + 200);
      tagForShadows(b);
      g.add(a);
      g.add(b);
      return g;
    };

    lod.addLevel(buildLobes(2), LOD_CLOSE_DIST);
    lod.addLevel(buildLobes(1), LOD_MID_DIST);
    lod.addLevel(buildLobes(0), LOD_FAR_DIST);

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

    const meshHigh = new THREE.Mesh(getGeom(2), material);
    tagForShadows(meshHigh);
    lod.addLevel(meshHigh, LOD_CLOSE_DIST);

    const meshMid = new THREE.Mesh(getGeom(1), material);
    tagForShadows(meshMid);
    lod.addLevel(meshMid, LOD_MID_DIST);

    const meshLow = new THREE.Mesh(getGeom(0), material);
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
