import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createShowcase, orbitCameraPosition } from '../src/systems/showcase.js';
import { createStarfield } from '../src/systems/starfield.js';
import { createNebulaBackground } from '../src/systems/nebula-background.js';
import { createSpaceLighting } from '../src/systems/space-lighting.js';

// ---------------------------------------------------------------------------
// v0.72.0 — Object-Viewer showcase mode tests.
//
// The showcase reuses the game's EXACT rendering setup (same scene /
// camera / lights / nebula / shadow map) but runs no game logic. These
// tests pin the catalogue contract (every 3D object the game can
// produce is present, in a stable order) and the isolation contract
// (activating hides non-showcase meshes, deactivating restores the
// original visibility flags — DEMO-state rules survive the round trip).
// ---------------------------------------------------------------------------

function makeHarness() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 20000);
  const nebula = { update: () => {} };
  const updateLighting = () => {};
  // A fake "game mesh" that should be hidden while the showcase is
  // active (mimics an asteroid/field entity) + one that must survive
  // (mimics starfield / nebula / sun with userData.showcaseKeep).
  const gameMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  gameMesh.name = 'game-asteroid';
  const keepMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  keepMesh.userData.showcaseKeep = true;
  scene.add(gameMesh);
  scene.add(keepMesh);

  const showcase = createShowcase({ scene, camera, nebula, updateLighting });
  return { scene, camera, showcase, gameMesh, keepMesh };
}

test('Showcase: catalogue has all 13 game objects in stable order', () => {
  const { showcase } = makeHarness();
  assert.equal(showcase.getCount(), 13);

  const labels = [];
  showcase.activate();
  for (let i = 0; i < showcase.getCount(); i++) {
    showcase.setIndex(i);
    labels.push(showcase.getLabel());
  }
  showcase.deactivate();

  // 5 asteroid shapes (texture 1) + player ship + pirate + 6 power-ups.
  assert.equal(labels[0], 'Asteroid · Spinning Top (Bennu/Ryugu) · Texture 1/5');
  assert.equal(labels[1], 'Asteroid · Cratered Potato · Texture 1/5');
  assert.equal(labels[2], 'Asteroid · Rubble Pile (Itokawa) · Texture 1/5');
  assert.equal(labels[3], 'Asteroid · Elongated Potato (Eros) · Texture 1/5');
  assert.equal(labels[4], 'Asteroid · Craggy Rock · Texture 1/5');
  assert.equal(labels[5], 'Player Ship · Skyfighter');
  assert.equal(labels[6], 'Pirate Ship · Hazard');
  assert.equal(labels[7], 'Power-up · SHIELD');
  assert.equal(labels[8], 'Power-up · SPEED');
  assert.equal(labels[9], 'Power-up · ENERGY');
  assert.equal(labels[10], 'Power-up · CREDITS');
  assert.equal(labels[11], 'Power-up · HULL');
  assert.equal(labels[12], 'Power-up · WEAPON');
});

test('Showcase: asteroid texture navigation cycles 1..5', () => {
  const { showcase } = makeHarness();
  showcase.activate();
  showcase.setIndex(0);
  assert.ok(showcase.getLabel().includes('Texture 1/5'));

  showcase.texNext();
  assert.ok(showcase.getLabel().includes('Texture 2/5'));
  showcase.texNext();
  showcase.texNext();
  showcase.texNext();
  assert.ok(showcase.getLabel().includes('Texture 5/5'));
  showcase.texNext();
  assert.ok(showcase.getLabel().includes('Texture 1/5'), 'texNext wraps 5->1');
  showcase.texPrev();
  assert.ok(showcase.getLabel().includes('Texture 5/5'), 'texPrev wraps 1->5');

  // Texture navigation is a no-op for non-asteroid entries.
  showcase.setIndex(5); // player ship
  showcase.texNext();
  assert.equal(showcase.getLabel(), 'Player Ship · Skyfighter');
  showcase.deactivate();
});

test('Showcase: activate hides game meshes, deactivate restores visibility', () => {
  const { showcase, gameMesh, keepMesh } = makeHarness();
  gameMesh.visible = true;
  keepMesh.visible = true;

  showcase.activate();
  assert.equal(gameMesh.visible, false, 'game mesh hidden while showcase active');
  assert.equal(keepMesh.visible, true, 'showcaseKeep mesh (starfield/sun) stays visible');

  showcase.deactivate();
  assert.equal(gameMesh.visible, true, 'game mesh restored after deactivate');
  assert.equal(keepMesh.visible, true);
});

test('Showcase: pre-existing hidden game meshes stay hidden after round trip', () => {
  const { showcase, gameMesh } = makeHarness();
  // Simulate DEMO-state rule: player ship is hidden at boot. The
  // showcase must preserve that exact flag, not blindly set true.
  gameMesh.visible = false;

  showcase.activate();
  assert.equal(gameMesh.visible, false);
  showcase.deactivate();
  assert.equal(gameMesh.visible, false, 'original hidden flag preserved');
});

test('Showcase: activate/deactivate without camera/nebula does not throw', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const showcase = createShowcase({ scene, camera });
  assert.doesNotThrow(() => showcase.activate());
  assert.equal(showcase.isActive(), true);
  assert.doesNotThrow(() => showcase.update(0.016));
  assert.doesNotThrow(() => showcase.deactivate());
  assert.equal(showcase.isActive(), false);
});

// ---------------------------------------------------------------------------
// v0.72.3 — Orbit camera + body-class + view-toggle contracts.
// ---------------------------------------------------------------------------

test('Showcase orbit: orbitCameraPosition math (pure helper)', () => {
  // theta = 0 → camera on +Z axis at distance dist.
  const p0 = orbitCameraPosition(0, 0, 10);
  assert.deepEqual(p0, { x: 0, y: 0, z: 10 });
  // theta = PI/2 → camera on +X axis.
  const p90 = orbitCameraPosition(Math.PI / 2, 0, 10);
  assert.ok(Math.abs(p90.x - 10) < 1e-9 && Math.abs(p90.z) < 1e-9, 'azimuth rotates around Y');
  // phi = PI/2 → camera straight above (top-down).
  const top = orbitCameraPosition(0, Math.PI / 2, 10);
  assert.ok(Math.abs(top.y - 10) < 1e-9 && Math.abs(top.z) < 1e-9, 'elevation lifts the camera');
  // Radius is preserved in all directions.
  const r = (p) => Math.hypot(p.x, p.y, p.z);
  assert.ok(Math.abs(r(p0) - 10) < 1e-9);
  assert.ok(Math.abs(r(orbitCameraPosition(1.3, 0.7, 24)) - 24) < 1e-9);
  // Target offset shifts the orbit center.
  const off = orbitCameraPosition(0, 0, 10, { x: 5, y: 0, z: 0 });
  assert.deepEqual(off, { x: 5, y: 0, z: 10 });
});

test('Showcase orbit: selecting an object frames the camera at the entry distance', () => {
  const { showcase, camera } = makeHarness();
  showcase.activate();
  showcase.setIndex(0); // spinning top: dist 24, height 5
  const d = Math.hypot(camera.position.x, camera.position.y, camera.position.z);
  assert.ok(Math.abs(d - 24) < 0.01, `camera at entry dist (got ${d})`);
  assert.ok(camera.position.y > 3 && camera.position.y < 7, `camera lifted (y=${camera.position.y})`);
  showcase.deactivate();
});

test('Showcase: activate adds / deactivate removes the body showcase-active class', () => {
  const adds = [];
  const removes = [];
  const fakeBody = {
    classList: { add: (c) => adds.push(c), remove: (c) => removes.push(c) },
    appendChild: () => {},
  };
  const realDoc = globalThis.document;
  globalThis.document = {
    body: fakeBody,
    // No canvas → orbit controls skip their listeners; no overlay DOM.
    querySelector: () => null,
    createElement: () => ({
      className: '', style: {}, innerHTML: '', textContent: '',
      querySelector: () => null, appendChild: () => {},
    }),
  };
  try {
    const { showcase } = makeHarness();
    showcase.activate();
    assert.ok(adds.includes('showcase-active'), 'body tagged on activate');
    showcase.deactivate();
    assert.ok(removes.includes('showcase-active'), 'body untagged on deactivate');
  } finally {
    globalThis.document = realDoc;
  }
});

test('Showcase: requires scene and camera', () => {
  // Note: the throw message uses backticks around `scene`/`camera`, so
  // the regex must not anchor on plain words without the ticks.
  assert.throws(() => createShowcase({}), /`scene` and `camera` are required/);
  assert.throws(() => createShowcase({ scene: new THREE.Scene() }), /`scene` and `camera` are required/);
});

test('Showcase: deactivate after activate builds no lingering meshes in scene', () => {
  const { scene, showcase } = makeHarness();
  const before = scene.children.length;
  showcase.activate();
  showcase.setIndex(0); // build an asteroid
  showcase.deactivate();
  assert.equal(scene.children.length, before, 'showcase objects fully removed on deactivate');
});

// ---------------------------------------------------------------------------
// v0.72.1 — REAL backdrop objects carry the showcaseKeep contract.
//
// The isolation pass hides every non-tagged mesh/points/line while the
// showcase is active. The user asked for "exakt das selbe rendering
// setup" — so the deep-space backdrop (starfield, nebula, sun disc)
// must survive. The unit-level mechanism was already covered above
// with fake meshes; these tests pin the REAL production objects to the
// contract so a future refactor of starfield.js / nebula-background.js
// / space-lighting.js cannot silently drop the tag.
// ---------------------------------------------------------------------------

test('Showcase: starfield group + every Points layer is showcaseKeep-tagged', () => {
  const starfield = createStarfield();
  assert.equal(starfield.userData.showcaseKeep, true, 'starfield group tagged');
  let pointsCount = 0;
  starfield.traverse((o) => {
    if (o.isPoints) {
      pointsCount += 1;
      assert.equal(o.userData.showcaseKeep, true, 'starfield Points layer tagged');
    }
  });
  assert.ok(pointsCount >= 3, 'starfield has its 3 layer Points objects');
});

test('Showcase: nebula sphere is showcaseKeep-tagged', () => {
  const nebula = createNebulaBackground({ imageUrl: '/bgnebula/bgnebula-2.png' });
  assert.equal(nebula.mesh.userData.showcaseKeep, true, 'nebula mesh tagged');
});

test('Showcase: sun mesh + corona are showcaseKeep-tagged', () => {
  const lighting = createSpaceLighting();
  assert.equal(lighting.sunMesh.userData.showcaseKeep, true, 'sun mesh tagged');
  assert.equal(lighting.coronaMesh.userData.showcaseKeep, true, 'corona mesh tagged');
});
