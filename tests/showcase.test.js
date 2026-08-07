import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createShowcase } from '../src/systems/showcase.js';

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
