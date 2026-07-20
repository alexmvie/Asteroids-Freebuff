import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createRealisticAsteroidFromSpec } from '../src/entities/realistic-asteroid.js';

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
// 1. Textures Validation (similar to asteroid-textures.test.js)
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
// 2. Component Interface and Geometries Validation
// ---------------------------------------------------------------------------
test('RealisticAsteroid: creates a valid entity with correct interface', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(0); // shapeType = 0
  const asteroid = createRealisticAsteroidFromSpec({ spec, scene });

  assert.equal(typeof asteroid.update, 'function');
  assert.equal(typeof asteroid.split, 'function');
  assert.equal(typeof asteroid.dispose, 'function');
  assert.equal(asteroid.getRadius(), 10);
  assert.equal(asteroid.getSize(), 0);
  assert.ok(asteroid.getPosition() instanceof THREE.Vector3);
  assert.deepEqual(asteroid.getVelocity(), { x: 2, z: 4 });

  // Clean up
  asteroid.dispose();
});

test('RealisticAsteroid: supports LOD and builds all 5 shape types', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  for (let shapeType = 0; shapeType < 5; shapeType++) {
    // We pass seeds that map exactly to shapeType = seed % 5
    const spec = createMockSpec(shapeType);
    const asteroid = createRealisticAsteroidFromSpec({ spec, scene });
    
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

test('RealisticAsteroid: Contact Binary (shapeType=2) LOD levels contain sub-groups with 2 meshes', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(2); // shapeType = 2 (Contact Binary)
  const asteroid = createRealisticAsteroidFromSpec({ spec, scene });
  
  const lod = asteroid.mesh.userData.lod;
  for (let levelIdx = 0; levelIdx < 3; levelIdx++) {
    const levelObj = lod.levels[levelIdx].object;
    assert.ok(levelObj instanceof THREE.Group, 'LOD level for Contact Binary should be a Group');
    
    // The group should contain the 2 lobe meshes
    const lobeMeshes = levelObj.children.filter(c => c instanceof THREE.Mesh);
    assert.equal(lobeMeshes.length, 2, 'Contact binary LOD level should contain exactly 2 meshes');
  }

  asteroid.dispose();
});

test('RealisticAsteroid: split() behavior', () => {
  const scene = new THREE.Scene();

  // Size 0 should split into 2 children
  const asteroid0 = createRealisticAsteroidFromSpec({ spec: createMockSpec(0, 0), scene });
  const children0 = asteroid0.split();
  assert.equal(children0.length, 2);
  assert.equal(children0[0].size, 1);
  assert.ok(children0[0].radius < 10);
  assert.ok(children0[0].id.endsWith('-r0') || children0[0].id.endsWith('-r1'));
  asteroid0.dispose();

  // Size 2 should not split (returns [])
  const asteroid2 = createRealisticAsteroidFromSpec({ spec: createMockSpec(0, 2), scene });
  const children2 = asteroid2.split();
  assert.equal(children2.length, 0);
  asteroid2.dispose();
});

test('RealisticAsteroid: split() children carry type="realistic" (v0.67.x dispatch)', () => {
  // Without type propagation, realistic splits would render as standard
  // children on the next frame. This was the silent bug in the previous
  // architecture -- the createAsteroidFromSpec dispatcher in
  // src/entities/asteroid.js would route children with undefined `type`
  // to the standard factory, silently breaking visual continuity.
  const scene = new THREE.Scene();
  const asteroid = createRealisticAsteroidFromSpec({ spec: createMockSpec(0, 0), scene });
  const children = asteroid.split();
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(typeof child.type, 'string', 'child.type must be set so the dispatcher can route correctly');
    assert.equal(
      child.type,
      'realistic',
      `realistic split child should carry type="realistic", got "${child.type}"`,
    );
    // All other spec invariants still hold -- only the new field was added.
    assert.ok(typeof child.id === 'string', 'child.id should still be a string');
    assert.ok(child.id.endsWith('-r0') || child.id.endsWith('-r1'), 'child.id should keep the realistic-prefix suffix');
  }
  asteroid.dispose();
});

test('RealisticAsteroid: dispose() removes mesh from scene and disposes all geometries/materials', () => {
  const scene = new THREE.Scene();
  const spec = createMockSpec(2); // contact binary has the most sub-objects
  const asteroid = createRealisticAsteroidFromSpec({ spec, scene });
  
  assert.equal(scene.children.length, 1);
  asteroid.dispose();
  assert.equal(scene.children.length, 0);
});
