import * as THREE from 'three';
import { Capsule } from '../geometry/capsule.js';
import { mulberry32 } from '../world/rng.js';

// ---------------------------------------------------------------------------
// Deterministic 3D value noise + fbm (fractal Brownian motion)
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
// General-purpose geometry noise displacement
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

    // Compute noise based on original position
    const n = fbm3D(
      (x + ox) * noiseScale,
      (y + oy) * noiseScale,
      (z + oz) * noiseScale,
      4
    );

    let displacement = 0;
    if (noiseType === 'crater') {
      // Crater: flat-bottomed or sharp-sloped dips
      displacement = n < 0.45 ? -Math.pow((0.45 - n) * 2.2, 2.0) * noiseAmount : (n - 0.5) * 0.4 * noiseAmount;
    } else if (noiseType === 'craggy') {
      // Turbulent, ridged noise for craggy rock
      displacement = (Math.abs(n - 0.5) * 2.0 - 0.5) * noiseAmount;
    } else {
      // Standard fbm
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
// Geometry Builders per Shape
// ---------------------------------------------------------------------------

// Shape 0: Crystalline Shard (Prism)
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

// Shape 1: Cratered Potato (Capsule with craters)
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

// Shape 3: Torus Donut Rock
function buildTorusGeometry(radius, detail, ox, oy, oz) {
  const radialSegments = detail === 2 ? 12 : (detail === 1 ? 8 : 4);
  const tubularSegments = detail === 2 ? 24 : (detail === 1 ? 16 : 8);
  const torusRadius = radius * 0.65;
  const tubeRadius = radius * 0.28;
  const geom = new THREE.TorusGeometry(torusRadius, tubeRadius, radialSegments, tubularSegments);
  displaceGeometry(geom, radius * 0.16, 2.2 / radius, ox, oy, oz);
  return geom;
}

// Shape 4: Craggy/Angular Rock
function buildCraggyRockGeometry(radius, detail, ox, oy, oz) {
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  displaceGeometry(geom, radius * 0.25, 2.5 / radius, ox, oy, oz, 'craggy');
  return geom;
}

// ---------------------------------------------------------------------------
// Texture Loading and Caching
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

function createRealisticMaterial(idx) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: idx === 3 ? 0.65 : 0.1, // nickel-iron is more metallic
    roughness: idx === 3 ? 0.45 : (idx === 4 ? 0.75 : 0.9), // metallic and volcanic are smoother/shinier
    bumpScale: 0.05,
    flatShading: true,
    map: getRealisticAlbedo(idx),
    normalMap: getRealisticNormal(idx),
    roughnessMap: getRealisticRoughness(idx),
    bumpMap: getRealisticBump(idx),
  });
}

// ---------------------------------------------------------------------------
// Main Factory & Component
// ---------------------------------------------------------------------------
const SPLIT_RADIUS_RATIO = 0.6;
const SPLIT_KICK = 8;
const PLAY_PLANE_Y = 0;
const LOD_CLOSE_DIST = 0;
const LOD_MID_DIST = 30;
const LOD_FAR_DIST = 100;
const _scratchAxis = new THREE.Vector3();

function buildRealisticAsteroidMesh(spec) {
  const rng = mulberry32(spec.seed);
  const group = new THREE.Group();

  // Consume a dummy RNG pull to maintain seed offset parity
  rng();

  // Determine shape and texture set deterministically from seed
  const shapeType = spec.seed % 5;
  const textureIdx = ((spec.seed >> 3) % 5) + 1; // 1 to 5

  const material = createRealisticMaterial(textureIdx);
  const radius = spec.radius;

  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const oz = rng() * 1000;

  let lod = null;

  if (shapeType === 2) {
    // Contact Binary (Peanut) - constructed from two overlapping spheres in a sub-group
    lod = new THREE.LOD();
    
    // LOD 2 (High detail)
    const gHigh = new THREE.Group();
    const meshAHigh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.78, 2), material);
    meshAHigh.position.set(-radius * 0.35, 0, 0);
    displaceGeometry(meshAHigh.geometry, radius * 0.2, 2.2 / radius, ox, oy, oz);
    const meshBHigh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.55, 2), material);
    meshBHigh.position.set(radius * 0.45, 0, 0);
    displaceGeometry(meshBHigh.geometry, radius * 0.15, 2.5 / radius, ox + 200, oy + 200, oz + 200);
    gHigh.add(meshAHigh);
    gHigh.add(meshBHigh);
    lod.addLevel(gHigh, LOD_CLOSE_DIST);

    // LOD 1 (Mid detail)
    const gMid = new THREE.Group();
    const meshAMid = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.78, 1), material);
    meshAMid.position.set(-radius * 0.35, 0, 0);
    displaceGeometry(meshAMid.geometry, radius * 0.2, 2.2 / radius, ox, oy, oz);
    const meshBMid = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.55, 1), material);
    meshBMid.position.set(radius * 0.45, 0, 0);
    displaceGeometry(meshBMid.geometry, radius * 0.15, 2.5 / radius, ox + 200, oy + 200, oz + 200);
    gMid.add(meshAMid);
    gMid.add(meshBMid);
    lod.addLevel(gMid, LOD_MID_DIST);

    // LOD 0 (Low detail)
    const gLow = new THREE.Group();
    const meshALow = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.78, 0), material);
    meshALow.position.set(-radius * 0.35, 0, 0);
    displaceGeometry(meshALow.geometry, radius * 0.2, 2.2 / radius, ox, oy, oz);
    const meshBLow = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.55, 0), material);
    meshBLow.position.set(radius * 0.45, 0, 0);
    displaceGeometry(meshBLow.geometry, radius * 0.15, 2.5 / radius, ox + 200, oy + 200, oz + 200);
    gLow.add(meshALow);
    gLow.add(meshBLow);
    lod.addLevel(gLow, LOD_FAR_DIST);

    group.add(lod);
  } else {
    // Shapes with simple single-mesh LOD configurations
    lod = new THREE.LOD();
    
    // Helper to generate geometry for a specific shape type at a given detail level
    const getGeom = (detail) => {
      if (shapeType === 0) return buildCrystallineShardGeometry(radius, detail, ox, oy, oz);
      if (shapeType === 1) return buildCrateredPotatoGeometry(radius, detail, ox, oy, oz);
      if (shapeType === 3) return buildTorusGeometry(radius, detail, ox, oy, oz);
      return buildCraggyRockGeometry(radius, detail, ox, oy, oz); // shapeType === 4
    };

    const meshHigh = new THREE.Mesh(getGeom(2), material);
    lod.addLevel(meshHigh, LOD_CLOSE_DIST);

    const meshMid = new THREE.Mesh(getGeom(1), material);
    lod.addLevel(meshMid, LOD_MID_DIST);

    const meshLow = new THREE.Mesh(getGeom(0), material);
    lod.addLevel(meshLow, LOD_FAR_DIST);

    group.add(lod);
  }

  // Debug Ground Footprint
  const groundGeom = new THREE.PlaneGeometry(spec.radius * 2, spec.radius * 2);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x2a1a3a, // unique dark purple ground for realistic ones
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -radius * 1.15;
  group.add(ground);

  group.position.set(spec.position.x, spec.position.y, spec.position.z);
  group.userData.lod = lod;

  return group;
}

export function createRealisticAsteroidFromSpec({ spec, scene } = {}) {
  if (!scene) throw new Error('createRealisticAsteroidFromSpec: scene is required');
  if (!spec) throw new Error('createRealisticAsteroidFromSpec: spec is required');

  const mesh = buildRealisticAsteroidMesh(spec);
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

    const lod = mesh.userData.lod;
    if (lod && camera) lod.update(camera);
  }

  function split() {
    if (spec.size >= 2) return [];
    const nextSize = spec.size + 1;
    const childRadius = spec.radius * SPLIT_RADIUS_RATIO;
    // Modified multiplier to make child seeds unique but deterministic
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
        id: `${spec.id}-r${i}`, // 'r' prefix for realistic splits
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
