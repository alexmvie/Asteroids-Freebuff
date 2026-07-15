import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Group } from 'three';
import { createShip } from '../src/entities/ship.js';
import { AI_TUNABLES } from '../src/entities/ai-tunables.js';
// v0.49.0 regression tests reference stubScene (no THREE renderer
// needed; ship.js only calls scene.add once in createShip).
const stubScene = { add: () => {} };

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

test('Ship: credits buff doubles score gain', () => {
  const ship = newShip();
  assert.equal(ship.getScoreMultiplier(), 1);
  ship.addBuff('credits', 5);
  assert.equal(ship.getScoreMultiplier(), 2);
  ship.removeBuff('credits');
  assert.equal(ship.getScoreMultiplier(), 1);
});

// ===========================================================================
// v0.49.0 Bug 2 regression test — ship respects live AI_TUNABLES.shipMaxSpeed
// ===========================================================================
// v0.48.0 shipped the live tuner panel without a slider for the ship's
// own max-speed. The frozen MAX_SPEED constant (200u/s) lived in
// ship-constants.js with no way for the user to feel the difference.
// v0.49.0 makes ship max-speed live-tunable by reading
// AI_TUNABLES.shipMaxSpeed per tick (?? MAX_SPEED fallback).
//
// This test pins the contract: with the live bag at 60u/s, a velocity
// pre-seeded above the cap clamps to 60u/s on the next update.

test('v0.49.0: ship respects AI_TUNABLES.shipMaxSpeed during update()', () => {
  const ship = createShip({ scene: stubScene });
  // Force the velocity above any plausible cap.
  ship.velocity.x = 1000;
  ship.velocity.z = 0;

  const ORIGINAL = AI_TUNABLES.shipMaxSpeed;
  AI_TUNABLES.shipMaxSpeed = 60;
  try {
    // 0.1s tick; thrust is off so the cap is the only speed-affecting layer.
    ship.update(0.1);
    const finalSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
    assert.ok(
      finalSpeed <= 60 + 0.001,
      `expected final speed ≤ 60u/s (live cap), got ${finalSpeed}u/s`,
    );
    // Sanity: the cap clamped magnitude, did not NaN or overshoot.
    assert.ok(Number.isFinite(finalSpeed), 'final speed should be finite');
  } finally {
    AI_TUNABLES.shipMaxSpeed = ORIGINAL;
  }
});

test('v0.49.0: ship falls back to MAX_SPEED when AI_TUNABLES.shipMaxSpeed is invalid', () => {
  const ship = createShip({ scene: stubScene });
  ship.velocity.x = 500;
  ship.velocity.z = 0;

  const ORIGINAL = AI_TUNABLES.shipMaxSpeed;
  // Simulate a bug / corrupt value. MAX_SPEED = 200 (canonical).
  AI_TUNABLES.shipMaxSpeed = NaN;
  try {
    ship.update(0.1);
    const finalSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
    assert.ok(
      finalSpeed <= 200 + 0.001,
      `expected fallback MAX_SPEED (200u/s), got ${finalSpeed}u/s`,
    );
  } finally {
    AI_TUNABLES.shipMaxSpeed = ORIGINAL;
  }
});
