import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Group } from 'three';
import { createShip } from '../src/entities/ship.js';

function newShip() {
  return createShip({ scene: new Scene() });
}

test('Ship: creates with zero roll', () => {
  const ship = newShip();
  assert.equal(ship.rotation.roll, 0);
  assert.equal(ship.body.rotation.z, 0);
});

test('Ship: outer group (mesh) has no roll component on the Z axis', () => {
  const ship = newShip();
  // Even after a few updates, the OUTER group's Z rotation (roll) must
  // stay 0. Roll lives on the inner body group only.
  ship.setYaw(1);
  for (let i = 0; i < 10; i++) ship.update(0.016);
  assert.equal(ship.mesh.rotation.z, 0);
});

test('Ship: yawInput +1 produces a positive roll (lean left)', () => {
  const ship = newShip();
  ship.setYaw(1);
  for (let i = 0; i < 30; i++) ship.update(0.016); // ~0.5s
  assert.ok(ship.rotation.roll > 0,
    `expected roll > 0, got ${ship.rotation.roll}`);
  assert.ok(ship.body.rotation.z > 0,
    `expected body.rotation.z > 0, got ${ship.body.rotation.z}`);
});

test('Ship: yawInput -1 produces a negative roll (lean right)', () => {
  const ship = newShip();
  ship.setYaw(-1);
  for (let i = 0; i < 30; i++) ship.update(0.016); // ~0.5s
  assert.ok(ship.rotation.roll < 0,
    `expected roll < 0, got ${ship.rotation.roll}`);
  assert.ok(ship.body.rotation.z < 0,
    `expected body.rotation.z < 0, got ${ship.body.rotation.z}`);
});

test('Ship: yawInput 0 damps roll back toward 0', () => {
  const ship = newShip();
  // First lean left
  ship.setYaw(1);
  for (let i = 0; i < 30; i++) ship.update(0.016);
  const leanedRoll = ship.rotation.roll;
  assert.ok(leanedRoll > 0, 'should have leaned left first');

  // Now release yaw and let it damp back
  ship.setYaw(0);
  for (let i = 0; i < 30; i++) ship.update(0.016); // ~0.5s
  assert.ok(ship.rotation.roll < leanedRoll,
    `expected roll to decrease; was ${leanedRoll}, now ${ship.rotation.roll}`);
  assert.ok(Math.abs(ship.rotation.roll) < leanedRoll,
    'released yaw should pull the roll back toward 0');
});

test('Ship: long-term yawInput +1 converges to the max roll (~0.45 rad)', () => {
  const ship = newShip();
  ship.setYaw(1);
  for (let i = 0; i < 1000; i++) ship.update(0.016); // ~16s — plenty for convergence
  // Should be very close to the configured max (0.45 rad).
  assert.ok(Math.abs(ship.rotation.roll - 0.45) < 1e-3,
    `expected roll ~ 0.45, got ${ship.rotation.roll}`);
});

test('Ship: roll is independent of yaw \u2014 the outer group has the yaw, the body has the roll', () => {
  const ship = newShip();
  ship.setYaw(1);
  for (let i = 0; i < 30; i++) ship.update(0.016);
  // Outer (mesh) group has yaw but no roll/pitch
  assert.notEqual(ship.mesh.rotation.y, 0,
    'outer group should have yawed');
  assert.equal(ship.mesh.rotation.x, 0, 'no pitch on outer');
  assert.equal(ship.mesh.rotation.z, 0, 'no roll on outer');
  // Inner (body) group has the roll only
  assert.notEqual(ship.body.rotation.z, 0,
    'inner body group should have rolled');
  assert.equal(ship.body.rotation.x, 0, 'no pitch on body');
  assert.equal(ship.body.rotation.y, 0, 'no yaw on body');
});

test('Ship: reset() clears the roll', () => {
  const ship = newShip();
  ship.setYaw(1);
  for (let i = 0; i < 30; i++) ship.update(0.016);
  assert.notEqual(ship.rotation.roll, 0, 'should have rolled first');
  ship.reset({ x: 0, y: 0, z: 0 });
  assert.equal(ship.rotation.roll, 0);
  assert.equal(ship.body.rotation.z, 0);
});

test('Ship: update(dt <= 0) is a no-op (no roll change)', () => {
  const ship = newShip();
  ship.setYaw(1);
  ship.update(0);
  assert.equal(ship.rotation.roll, 0);
  ship.update(-1);
  assert.equal(ship.rotation.roll, 0);
});

test('Ship: setYaw clamps out-of-range inputs to [-1, +1]', () => {
  const ship = newShip();
  ship.setYaw(5);
  ship.setYaw(0);
  for (let i = 0; i < 200; i++) ship.update(0.016);
  // With yawInput=0, roll should still be 0 (not -0.45, which would
  // happen if setYaw(5) somehow leaked through).
  assert.equal(ship.rotation.roll, 0,
    `setYaw(5) should have been clamped to 0; roll is ${ship.rotation.roll}`);
});
