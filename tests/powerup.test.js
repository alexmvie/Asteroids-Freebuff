/**
 * Tests for the power-up entity — see src/entities/powerup.js.
 *
 * The GLB load is async and the test environment has no GLB asset
 * loader, so we never assert on the loaded mesh. The fallback mesh
 * (emissive cone + halo ring + beacon) is always present and is
 * what these tests exercise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPowerUp } from '../src/entities/powerup.js';

function makeScene() {
  return new THREE.Scene();
}

test('createPowerUp throws without scene', () => {
  assert.throws(() => createPowerUp({}), /scene.*required/);
});

test('createPowerUp throws without spec', () => {
  assert.throws(() => createPowerUp({ scene: makeScene() }), /spec.*required/);
});

test('createPowerUp throws when spec.position is missing', () => {
  assert.throws(
    () => createPowerUp({ scene: makeScene(), spec: { type: 'laser' } }),
    /position/,
  );
});

test('createPowerUp throws when spec.type is missing', () => {
  assert.throws(
    () =>
      createPowerUp({
        scene: makeScene(),
        spec: { position: { x: 0, y: 0, z: 0 } },
      }),
    /type/,
  );
});

test('createPowerUp throws when spec.position is missing', () => {
  assert.throws(
    () => createPowerUp({ scene: makeScene(), spec: { type: 'laser' } }),
    /position/,
  );
});

test('createPowerUp throws when spec.type is missing', () => {
  assert.throws(
    () =>
      createPowerUp({
        scene: makeScene(),
        spec: { position: { x: 0, y: 0, z: 0 } },
      }),
    /type/,
  );
});

test('initial state: visible, position set, not expired, has radius', () => {
  const pu = createPowerUp({
    scene: makeScene(),
    spec: { type: 'laser', position: { x: 10, y: 2, z: -5 } },
  });
  const p = pu.getPosition();
  assert.equal(p.x, 10);
  assert.equal(p.z, -5);
  assert.equal(pu.getRadius(), 1.5);
  assert.equal(pu.isExpired(), false);
  pu.dispose();
});

test('update advances rotation and bobs the Y position', () => {
  const pu = createPowerUp({
    scene: makeScene(),
    spec: { type: 'laser', position: { x: 0, y: 2, z: 0 } },
  });
  const p = pu.getPosition();
  const y0 = p.y;
  // Several updates over 1 second — bob should move Y by a non-zero amount
  for (let i = 0; i < 60; i++) pu.update(1 / 60);
  // Bob amplitude is 0.35, so we expect |Δy| <= 0.7
  assert.notEqual(p.y, y0, 'Y should have moved by the bob');
  assert.ok(Math.abs(p.y - y0) <= 0.7, `bob within 0.7 of baseY, got Δy=${p.y - y0}`);
  pu.dispose();
});

test('isExpired returns true after lifetime elapses', () => {
  const pu = createPowerUp({
    scene: makeScene(),
    spec: { type: 'laser', position: { x: 0, y: 0, z: 0 }, lifetime: 0.5 },
  });
  assert.equal(pu.isExpired(), false);
  pu.update(0.6);
  assert.equal(pu.isExpired(), true);
  pu.dispose();
});

test('isExpired is false just before the lifetime elapses', () => {
  const pu = createPowerUp({
    scene: makeScene(),
    spec: { type: 'laser', position: { x: 0, y: 0, z: 0 }, lifetime: 1.0 },
  });
  pu.update(0.99);
  assert.equal(pu.isExpired(), false);
  pu.dispose();
});

test('dispose removes the entity from the scene', () => {
  const scene = makeScene();
  const pu = createPowerUp({
    scene,
    spec: { type: 'laser', position: { x: 0, y: 0, z: 0 } },
  });
  assert.ok(scene.children.length >= 1, 'entity was added to the scene');
  pu.dispose();
  assert.equal(scene.children.length, 0, 'dispose removed the entity from the scene');
});

test('mesh is a Three.js Group', () => {
  const pu = createPowerUp({
    scene: makeScene(),
    spec: { type: 'laser', position: { x: 0, y: 0, z: 0 } },
  });
  assert.ok(pu.mesh instanceof THREE.Group, 'mesh is a THREE.Group');
  pu.dispose();
});
