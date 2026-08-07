import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  createAsteroidFromSpec,
  placeCraterCenters,
  craterContribution,
  placeBoulderCenters,
  boulderContribution,
} from '../src/entities/asteroid.js';

// Helper to construct a mock spec
function createMockSpec(seed, size = 0, radius = 10) {
  return {
    id: `mock-1-2-${seed}`,
    position: { x: 10, y: 0, z: 20 },
    radius,
    size,
    axis: { x: 0, y: 1, z: 0 },
    spin: 0.5,
    velocity: { x: 2, y: 0, z: 4 },
    seed,
  };
}

// ---------------------------------------------------------------------------
// 1. Textures Validation: 5 texture sets × 4 maps = 20 PNG files must exist
// (sized exactly 1024×1024, valid PNG signature).
// ---------------------------------------------------------------------------
const TEXTURE_DIR = 'public/textures';
const MAP_TYPES = ['albedo', 'normal', 'roughness', 'bump'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

for (let idx = 1; idx <= 5; idx++) {
  for (const map of MAP_TYPES) {
    const path = `${TEXTURE_DIR}/realistic-${idx}-${map}.png`;

    test(`Realistic texture ${idx} ${map}: file exists and is a valid PNG`, () => {
      assert.ok(existsSync(path), `expected texture file at ${path}`);
      const size = statSync(path).size;
      assert.ok(size > 50_000, `texture is suspiciously small (${size} bytes)`);

      // PNG Signature check
      const head = readFileSync(path).subarray(0, 8);
      for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        assert.equal(head[i], PNG_SIGNATURE[i], `byte ${i} of ${path} mismatch`);
      }
    });

    test(`Realistic texture ${idx} ${map}: dimensions are exactly 1024x1024`, () => {
      const head = readFileSync(path).subarray(0, 24);
      const w = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19];
      const h = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23];
      assert.equal(w, 1024, `${path} width is ${w}, expected 1024`);
      assert.equal(h, 1024, `${path} height is ${h}, expected 1024`);
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Component interface + 5-shape geometry coverage
// ---------------------------------------------------------------------------
test('Asteroid: creates a valid entity with correct interface', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(0); // shapeType = 0
  const asteroid = createAsteroidFromSpec({ spec, scene });

  assert.equal(typeof asteroid.update, 'function');
  assert.equal(typeof asteroid.split, 'function');
  assert.equal(typeof asteroid.dispose, 'function');
  assert.equal(asteroid.getRadius(), 10);
  assert.equal(asteroid.getSize(), 0);
  assert.ok(asteroid.getPosition() instanceof THREE.Vector3);
  assert.deepEqual(asteroid.getVelocity(), { x: 2, z: 4 });

  asteroid.dispose();
});

test('Asteroid: no NaN vertices in any geometry — including split children (v0.71.6 regression)', () => {
  // v0.71.6 — found via browser console: "computed radius is NaN" on
  // _IcosahedronGeometry. Root cause: buildSpinningTopGeometry's
  // `Math.pow(1 - Math.abs(lat), 1.5)` — IcosahedronGeometry detail 3
  // produces 12 vertices with |y|/radius = 1.0000000397 (floating-
  // point overshoot), so 1 - |lat| went slightly negative and
  // `Math.pow(negative, 1.5)` = NaN. Split children (seed % 5 = 0 →
  // spinning top) triggered it constantly in-game. Tripwire: every
  // position coordinate of every geometry must be finite.
  const scene = new THREE.Scene();
  const spec = createMockSpec(316267805); // known-bad seed (detail-3 pole overshoot)
  const asteroid = createAsteroidFromSpec({ spec, scene });

  const bad = [];
  asteroid.mesh.traverse((obj) => {
    if (obj.geometry && obj.geometry.attributes.position) {
      const arr = obj.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) {
          bad.push(`${obj.geometry.type}[${i}]=${arr[i]}`);
        }
      }
    }
  });
  assert.equal(bad.length, 0, `non-finite vertices found: ${bad.slice(0, 5).join(', ')}`);

  // Also verify the generated split children are NaN-free (the in-game
  // failure mode: AI shoots → split → corrupted child asteroid).
  for (const child of asteroid.split()) {
    const scene2 = new THREE.Scene();
    const childA = createAsteroidFromSpec({ spec: child, scene: scene2 });
    childA.mesh.traverse((obj) => {
      if (obj.geometry && obj.geometry.attributes.position) {
        const arr = obj.geometry.attributes.position.array;
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) {
            bad.push(`${obj.geometry.type}[${i}]=${arr[i]}`);
          }
        }
      }
    });
    childA.dispose();
  }
  assert.equal(bad.length, 0, `non-finite vertices found (incl. split children): ${bad.slice(0, 5).join(', ')}`);

  asteroid.dispose();
});

test('Asteroid: supports LOD and builds all 5 shape types', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  for (let shapeType = 0; shapeType < 5; shapeType++) {
    // We pass seeds that map exactly to shapeType = seed % 5
    const spec = createMockSpec(shapeType);
    const asteroid = createAsteroidFromSpec({ spec, scene });

    const mesh = asteroid.mesh;
    assert.ok(mesh instanceof THREE.Group);

    // Check LOD is attached
    const lod = mesh.userData.lod;
    assert.ok(lod instanceof THREE.LOD);
    assert.equal(lod.levels.length, 3, `shape ${shapeType} should have 3 LOD levels`);

    // Verify LOD update runs without throwing
    assert.doesNotThrow(() => {
      asteroid.update(0.016, camera);
    });

    asteroid.dispose();
  }
});

test('Asteroid: Rubble Pile (shapeType=2) LOD levels contain sub-groups with 3-6 lobes, same pile at every level', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(2); // shapeType = 2 (Rubble Pile)
  const asteroid = createAsteroidFromSpec({ spec, scene });

  const lod = asteroid.mesh.userData.lod;
  const lobeCounts = [];
  for (let levelIdx = 0; levelIdx < 3; levelIdx++) {
    const levelObj = lod.levels[levelIdx].object;
    assert.ok(levelObj instanceof THREE.Group, 'LOD level for Rubble Pile should be a Group');

    // The group should contain 3..6 lobe meshes (Itokawa-style pile).
    const lobeMeshes = levelObj.children.filter(c => c instanceof THREE.Mesh);
    assert.ok(
      lobeMeshes.length >= 3 && lobeMeshes.length <= 6,
      `Rubble pile LOD level ${levelIdx} should have 3-6 lobes, got ${lobeMeshes.length}`,
    );
    lobeCounts.push(lobeMeshes.length);
  }
  // Deterministic pile layout: all LOD levels must show the SAME lobe
  // count (only mesh density changes with distance).
  assert.equal(
    new Set(lobeCounts).size, 1,
    `rubble pile lobe count should be identical across LOD levels, got ${lobeCounts.join(',')}`,
  );

  asteroid.dispose();
});

// ---------------------------------------------------------------------------
// v0.71.5 — Worley-crater helpers (research-backed: real impact
// craters are bowl-shaped depressions with raised rims — Bennu, Ryugu,
// Eros, Lutetia imagery). Deterministic placement + signed bowl/rim
// contribution, exported from src/entities/asteroid.js for testing.
// ---------------------------------------------------------------------------

test('placeCraterCenters: deterministic — same (ox,oy,oz) → same centers', () => {
  const a = placeCraterCenters(10, 20, 30, 4);
  const b = placeCraterCenters(10, 20, 30, 4);
  assert.deepEqual(a, b, 'same offsets must produce identical crater fields');
});

test('placeCraterCenters: different offsets → different fields', () => {
  const a = placeCraterCenters(10, 20, 30, 4);
  const b = placeCraterCenters(11, 20, 30, 4);
  assert.notDeepEqual(a, b, 'different offsets must produce different crater fields');
});

test('placeCraterCenters: centers are unit vectors with sane ranges', () => {
  for (const seed of [1, 99, 12345]) {
    const centers = placeCraterCenters(seed, seed * 2, seed * 3, 6);
    assert.equal(centers.length, 6, 'should place exactly the requested count');
    for (const c of centers) {
      const len = Math.hypot(c.x, c.y, c.z);
      assert.ok(Math.abs(len - 1) < 1e-9, `crater center not unit: ${len}`);
      assert.ok(c.angularRadius > 0 && c.angularRadius < Math.PI, 'angular radius in (0, PI)');
      assert.ok(c.depth > 0, 'depth positive');
      assert.ok(c.rim > 0, 'rim positive');
    }
  }
});

test('craterContribution: bowl dips negative at center, rim raises just outside the edge, zero far away', () => {
  const c = { x: 0, y: 0, z: 1, angularRadius: 0.5, depth: 1.0, rim: 0.4 };
  // Center (t=0): pure bowl depression, roughly -depth.
  const center = craterContribution({ x: 0, y: 0, z: 1 }, c);
  assert.ok(center < -0.9, `center should be a deep depression, got ${center}`);
  // Just outside the rim edge (t≈1.1): raised rim (positive).
  const rimAngle = 0.5 * 1.1;
  const rimDir = {
    x: Math.sin(rimAngle),
    y: 0,
    z: Math.cos(rimAngle),
  };
  const rim = craterContribution(rimDir, c);
  assert.ok(rim > 0, `rim should be raised, got ${rim}`);
  // Far away (t=2): no influence.
  const farAngle = 0.5 * 2.0;
  const farDir = { x: Math.sin(farAngle), y: 0, z: Math.cos(farAngle) };
  assert.equal(craterContribution(farDir, c), 0, 'far from crater → 0');
});

test('craterContribution: symmetric around the crater axis', () => {
  const c = { x: 0, y: 0, z: 1, angularRadius: 0.5, depth: 1.0, rim: 0.4 };
  const t = 0.7; // inside the bowl, off-center
  const angle = 0.5 * t;
  const a = craterContribution({ x: Math.sin(angle), y: 0, z: Math.cos(angle) }, c);
  const b = craterContribution({ x: -Math.sin(angle), y: 0, z: Math.cos(angle) }, c);
  assert.ok(Math.abs(a - b) < 1e-12, 'contribution should be symmetric about the crater axis');
});

test('Asteroid: split() behavior', () => {
  const scene = new THREE.Scene();

  // Size 0 should split into 2 children
  const asteroid0 = createAsteroidFromSpec({ spec: createMockSpec(0, 0), scene });
  const children0 = asteroid0.split();
  assert.equal(children0.length, 2);
  assert.equal(children0[0].size, 1);
  assert.ok(children0[0].radius < 10);
  assert.ok(children0[0].id.endsWith('-r0') || children0[0].id.endsWith('-r1'));
  asteroid0.dispose();

  // Size 2 should not split (returns [])
  const asteroid2 = createAsteroidFromSpec({ spec: createMockSpec(0, 2), scene });
  const children2 = asteroid2.split();
  assert.equal(children2.length, 0);
  asteroid2.dispose();
});

// v0.68.0 -- the v0.67.x "split() children carry type='realistic'" test
// was removed: there is no `type` discriminator anymore. The pure
// factory contract is now: every asteroid goes through createAsteroidFromSpec;
// split children are just smaller specs that re-enter the same factory,
// which builds the textured-PBR mesh deterministically.

test('Asteroid: dispose() removes mesh from scene and disposes all geometries/materials', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(2); // contact binary has the most sub-objects
  const asteroid = createAsteroidFromSpec({ spec, scene });

  assert.equal(scene.children.length, 1);
  asteroid.dispose();
  assert.equal(scene.children.length, 0);
});

// ---------------------------------------------------------------------------
// 3. Shadow flags (v0.68.0) — body meshes must cast + receive so the
// sun's DirectionalLight projects asteroid-on-asteroid shadows.
// The ground footprint receives but does not cast (a flat plane
// casting a shadow would be visually wrong — no shadow source above
// it). Tripwire test for the sun-light wiring.
// ---------------------------------------------------------------------------
test('Asteroid: body meshes have castShadow + receiveShadow enabled (sun lighting)', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(0); // shapeType 0 (single-mesh LOD)
  const asteroid = createAsteroidFromSpec({ spec, scene });

  // Walk the LOD levels, every Mesh should cast+receive shadows.
  const lod = asteroid.mesh.userData.lod;
  for (const level of lod.levels) {
    const obj = level.object;
    if (obj instanceof THREE.Mesh) {
      assert.equal(obj.castShadow, true, `body mesh should cast shadow at lod distance ${level.distance}`);
      assert.equal(obj.receiveShadow, true, `body mesh should receive shadow at lod distance ${level.distance}`);
    }
  }

  asteroid.dispose();
});

test('Asteroid: no debug ground plane in the entity (v0.71.6 photoreal cleanup)', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(0);
  const asteroid = createAsteroidFromSpec({ spec, scene });

  // The group should contain ONLY the LOD — the v0.71.6 pass removed
  // the debug ground footprint (a floating semi-transparent plane +
  // fake sun shadow that broke the "asteroids float in empty space"
  // look). Tripwire: a PlaneGeometry reappearing means the debug
  // plane was re-added.
  const planes = [];
  asteroid.mesh.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.PlaneGeometry) {
      planes.push(obj);
    }
  });
  assert.equal(planes.length, 0, 'no PlaneGeometry should exist in the asteroid entity');

  asteroid.dispose();
});

// ---------------------------------------------------------------------------
// v0.71.6 — Boulder-layer helpers (research-backed: Bennu/Ryugu/
// Itokawa surfaces are covered in discrete rocks — the most
// distinguishing surface feature of a real asteroid). Positive mounds
// with steep-edge falloff, deterministic placement per (ox, oy, oz).
// ---------------------------------------------------------------------------

test('placeBoulderCenters: deterministic — same (ox,oy,oz) → same centers', () => {
  const a = placeBoulderCenters(10, 20, 30, 6);
  const b = placeBoulderCenters(10, 20, 30, 6);
  assert.deepEqual(a, b, 'same offsets must produce identical boulder fields');
});

test('placeBoulderCenters: different offsets → different fields', () => {
  const a = placeBoulderCenters(10, 20, 30, 6);
  const b = placeBoulderCenters(11, 20, 30, 6);
  assert.notDeepEqual(a, b, 'different offsets must produce different boulder fields');
});

test('placeBoulderCenters: centers are unit vectors with sane ranges', () => {
  for (const seed of [1, 99, 12345]) {
    const centers = placeBoulderCenters(seed, seed * 2, seed * 3, 6);
    assert.equal(centers.length, 6, 'should place exactly the requested count');
    for (const b of centers) {
      const len = Math.hypot(b.x, b.y, b.z);
      assert.ok(Math.abs(len - 1) < 1e-9, `boulder center not unit: ${len}`);
      assert.ok(b.angularRadius > 0 && b.angularRadius < Math.PI, 'angular radius in (0, PI)');
      assert.ok(b.height > 0, 'height positive');
      assert.ok(b.sharpness >= 1, 'sharpness >= 1 (rock profile, not smooth hill)');
    }
  }
});

test('boulderContribution: positive-only mound, zero outside the rock edge', () => {
  const b = { x: 0, y: 0, z: 1, angularRadius: 0.2, height: 1.0, sharpness: 2.0 };
  // Dead center: full height.
  const center = boulderContribution({ x: 0, y: 0, z: 1 }, b);
  assert.equal(center, 1.0, 'center of the rock = full height');
  // Halfway to the edge: positive but less than height.
  const midAngle = 0.2 * 0.5;
  const mid = boulderContribution(
    { x: Math.sin(midAngle), y: 0, z: Math.cos(midAngle) },
    b,
  );
  assert.ok(mid > 0 && mid < 1, `mid should be in (0, 1), got ${mid}`);
  // At the edge (t=1): exactly 0 (steep base — no smooth skirt).
  const edge = boulderContribution({ x: Math.sin(0.2), y: 0, z: Math.cos(0.2) }, b);
  assert.equal(edge, 0, 'rock edge should return exactly 0');
  // Outside the edge: 0.
  const far = boulderContribution({ x: 0, y: 1, z: 0 }, b);
  assert.equal(far, 0, 'far from the rock → 0');
  // Never negative anywhere.
  assert.ok(center >= 0 && mid >= 0 && edge >= 0 && far >= 0, 'boulder contribution must never be negative');
});

test('Asteroid: boulder layer actually displaces geometry outward (v0.71.6 integration)', () => {
  // Tripwire against a silently no-op boulder layer: an asteroid with
  // boulders must push vertices OUT past the base icosphere radius.
  // Compare max vertex radius of the high-LOD mesh (detail 4) against
  // the nominal spec radius — the craggy shape (shapeType 4) gets the
  // densest boulder field (8) so it's the strongest signal.
  const scene = new THREE.Scene();
  const spec = { ...createMockSpec(4), shape: 'craggy_rock', radius: 8 };
  const asteroid = createAsteroidFromSpec({ spec, scene });
  const high = asteroid.mesh.userData.lod.levels[0].object;

  let maxR = 0;
  high.traverse((m) => {
    if (!(m instanceof THREE.Mesh)) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
  });

  // Base radius 8 + up to 0.55×8 displacement + up to 0.45×8 boulder
  // cap → maxR must clearly exceed the bare icosphere (8) by a
  // boulder-sized margin.
  assert.ok(maxR > 8 * 1.3, `boulders should push the silhouette out, maxR=${maxR.toFixed(2)} (expected > 10.4)`);
  asteroid.dispose();
});

test('Asteroid: craters pull the surface below the base radius (v0.71.6 integration)', () => {
  // Companion check: the cratered potato (shapeType 1, 'crater' noise)
  // must have vertices BELOW the base radius — real impact bowls are
  // depressions, not just flat stains. The capsule body has only 461
  // vertices at detail 4, so randomly-placed craters don't guarantee a
  // vertex at the deepest bowl point; minR ≈ 0.77× radius in practice.
  // Threshold 0.85× is robust against that sampling while still
  // proving the carve pulls the surface in.
  const scene = new THREE.Scene();
  const spec = { ...createMockSpec(1), shape: 'cratered_potato', radius: 8 };
  const asteroid = createAsteroidFromSpec({ spec, scene });
  const high = asteroid.mesh.userData.lod.levels[0].object;

  let minR = Infinity;
  high.traverse((m) => {
    if (!(m instanceof THREE.Mesh)) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      minR = Math.min(minR, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
  });

  assert.ok(minR < 8 * 0.85, `craters should carve below the base radius, minR=${minR.toFixed(2)} (expected < 6.8)`);
  asteroid.dispose();
});

test('boulderContribution: sharpness steepens the falloff (rock vs hill)', () => {
  const b = { x: 0, y: 0, z: 1, angularRadius: 0.2, height: 1.0 };
  const t = 0.7; // 70% of the way to the edge
  const angle = 0.2 * t;
  const dir = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
  const soft = boulderContribution(dir, { ...b, sharpness: 1.5 });
  const hard = boulderContribution(dir, { ...b, sharpness: 4.0 });
  // At t=0.7, (1-t²)=0.51; 0.51^1.5 ≈ 0.36 vs 0.51^4 ≈ 0.068.
  assert.ok(hard < soft, `sharpness 4 should fall off faster than 1.5 (${hard} vs ${soft})`);
});
