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

// ---------------------------------------------------------------------------
// v0.11.0 SSOT lockstep — the per-type color is read by the HUD chip
// renderer (src/ui/hud.js addBuffChip) via powerupColorFor(type). If
// the variant registry's color for any of the 6 v0.11.0 types
// regresses, both the in-world mesh AND the HUD chip pick up the
// wrong color. This test pins the canonical values so any unintended
// change fails loudly.
// ---------------------------------------------------------------------------

test('v0.11.0 SSOT lockstep: powerupColorFor(type) returns canonical variant colors for all 6 v0.11.0 types', () => {
  // Import here (not at top) so the file still compiles if the export
  // were ever removed (the SSOT contract is enforced by the test
  // rather than by a static import dependency).
  return import('../src/entities/powerup.js').then(({ powerupColorFor }) => {
    const expected = {
      shield:  0x6effa8, // mint green
      speed:   0xff8844, // orange
      energy:  0xffe066, // gold-yellow
      credits: 0xffd166, // gold
      hull:    0xff5566, // danger red
      weapon:  0xcc66ff, // purple
    };
    for (const [type, want] of Object.entries(expected)) {
      const got = powerupColorFor(type);
      assert.equal(got, want,
        `${type}: powerupColorFor returned 0x${got.toString(16)} but variant registry expects 0x${want.toString(16)}. Both the in-world powerup mesh and the HUD chip would render the wrong color in lockstep.`);
    }
  });
});

test('v0.11.0 SSOT lockstep: powerupLabelFor(type) returns canonical variant labels for all 6 v0.11.0 types', () => {
  // Companion assertion to the color check (the HUD's chip text is
  // the type name — if the registry's label drifts, the chip text
  // drifts). Both label + color are paired in the variant row.
  return import('../src/entities/powerup.js').then(({ powerupLabelFor }) => {
    const expected = {
      shield:  'SHIELD',
      speed:   'SPEED',
      energy:  'ENERGY',
      credits: 'CREDITS',
      hull:    'HULL',
      weapon:  'WEAPON',
    };
    for (const [type, want] of Object.entries(expected)) {
      const got = powerupLabelFor(type);
      assert.equal(got, want,
        `${type}: powerupLabelFor returned "${got}" but variant registry expects "${want}"`);
    }
  });
});
