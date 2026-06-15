import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';
import { createNebulaBackground } from '../src/systems/nebula-background.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const NEBULA_ASSET = resolve(PROJECT_ROOT, 'public/bgnebula/bgnebula-2.png');
const NEBULA_ASSET_1K = resolve(PROJECT_ROOT, 'public/bgnebula/bgnebula-2k.png');

// 1x1 white PNG (base64). Used as a no-network-needed imageUrl so the
// texture loader has something to attempt; the loader is expected to
// fail in Node (no `Image` global), and the module's defensive
// try/catch falls back to a stub texture.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

test('NebulaBackground: throws when `imageUrl` is missing', () => {
  assert.throws(() => createNebulaBackground(), /imageUrl is required/);
  assert.throws(() => createNebulaBackground({}), /imageUrl is required/);
});

test('NebulaBackground: returns { mesh, mount, update, dispose }', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  assert.ok(nebula.mesh);
  assert.equal(typeof nebula.mount, 'function');
  assert.equal(typeof nebula.update, 'function');
  assert.equal(typeof nebula.dispose, 'function');
});

test('NebulaBackground: mesh is a THREE.Mesh with SphereGeometry and MeshBasicMaterial', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  assert.ok(nebula.mesh.isMesh);
  assert.ok(nebula.mesh.geometry instanceof THREE.SphereGeometry);
  assert.ok(nebula.mesh.material.isMeshBasicMaterial);
});

test('NebulaBackground: material side is BackSide (we view the inside of the sphere)', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  assert.equal(nebula.mesh.material.side, THREE.BackSide);
});

test('NebulaBackground: renderOrder is -1 (background) and frustumCulled is false', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  assert.equal(nebula.mesh.renderOrder, -1);
  assert.equal(nebula.mesh.frustumCulled, false);
});

test('NebulaBackground: material is not affected by scene fog (fog: false)', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  assert.equal(nebula.mesh.material.fog, false);
});

test('NebulaBackground: custom radius is applied to the geometry', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG, radius: 1234 });
  // SphereGeometry stores the radius in `parameters.radius`
  assert.equal(nebula.mesh.geometry.parameters.radius, 1234);
});

test('NebulaBackground: update(camera) moves the mesh to the camera position', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  const camera = new THREE.Object3D();
  camera.position.set(100, 200, 300);
  nebula.update(camera);
  assert.equal(nebula.mesh.position.x, 100);
  assert.equal(nebula.mesh.position.y, 200);
  assert.equal(nebula.mesh.position.z, 300);
});

test('NebulaBackground: update(null) is a no-op', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  nebula.mesh.position.set(10, 20, 30);
  const before = nebula.mesh.position.clone();
  nebula.update(null);
  assert.deepEqual(nebula.mesh.position, before);
});

test('NebulaBackground: mount adds the mesh to the scene', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  const scene = new THREE.Scene();
  assert.equal(scene.children.length, 0);
  nebula.mount(scene);
  assert.equal(scene.children.length, 1);
  assert.ok(scene.children.includes(nebula.mesh));
});

test('NebulaBackground: a second mount to the same scene is a no-op', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  const scene = new THREE.Scene();
  nebula.mount(scene);
  nebula.mount(scene);
  assert.equal(
    scene.children.filter((c) => c === nebula.mesh).length,
    1,
    'mesh should appear exactly once in the scene',
  );
});

test('NebulaBackground: mount moves the mesh between scenes', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  const sceneA = new THREE.Scene();
  const sceneB = new THREE.Scene();
  nebula.mount(sceneA);
  assert.ok(sceneA.children.includes(nebula.mesh));
  nebula.mount(sceneB);
  assert.ok(!sceneA.children.includes(nebula.mesh));
  assert.ok(sceneB.children.includes(nebula.mesh));
});

test('NebulaBackground: dispose removes the mesh and clears the scene reference', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  const scene = new THREE.Scene();
  nebula.mount(scene);
  assert.ok(scene.children.includes(nebula.mesh));
  nebula.dispose();
  assert.ok(!scene.children.includes(nebula.mesh));
});

test('NebulaBackground: dispose is safe to call without a prior mount', () => {
  const nebula = createNebulaBackground({ imageUrl: TINY_PNG });
  // Should not throw
  nebula.dispose();
});

test('NebulaBackground: bundled bgnebula asset exists and is a non-trivial PNG', () => {
  // Regression guard: the local asset path is referenced from
  // src/scene.js (NEBULA_IMAGE_URL). If a refactor accidentally
  // drops the file from the repo, this test catches it before the
  // player sees a blank background in production.
  assert.ok(
    existsSync(NEBULA_ASSET),
    `expected bundled bgnebula asset at ${NEBULA_ASSET}`,
  );
  const size = statSync(NEBULA_ASSET).size;
  assert.ok(
    size > 100_000,
    `bundled bgnebula asset is suspiciously small (${size} bytes) — was the asset re-encoded at low quality?`,
  );
  // Quick PNG magic-number check (signature = 0x89 50 4E 47 0D 0A 1A 0A).
  // We don't read the file in full; just the first 8 bytes are enough
  // to catch a renamed .jpg or a corrupt download.
  const head = readFileSync(NEBULA_ASSET).subarray(0, 8);
  assert.equal(head[0], 0x89, 'asset is not a PNG (missing signature byte 0)');
  assert.equal(head[1], 0x50, 'asset is not a PNG (missing "P")');
  assert.equal(head[2], 0x4e, 'asset is not a PNG (missing "N")');
  assert.equal(head[3], 0x47, 'asset is not a PNG (missing "G")');
});

test('NebulaBackground: bundled 1K bgnebula asset exists (dev fallback)', () => {
  assert.ok(
    existsSync(NEBULA_ASSET_1K),
    `expected bundled 1K bgnebula asset at ${NEBULA_ASSET_1K}`,
  );
  assert.ok(statSync(NEBULA_ASSET_1K).size > 10_000);
});
