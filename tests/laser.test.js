/**
 * Tests for the laser weapon — see src/entities/laser.js.
 *
 * Focus:
 *   - Fire/cooldown state machine
 *   - Hit accumulation (point-to-segment distance test)
 *   - Update semantics (decrement timers, follow ship, sweep hits)
 *   - consumeHit for the collision layer
 *   - Argument validation
 *
 * Runs in Node — no jsdom needed; the laser's hit test is pure
 * math over positions, and the meshes are simple Three.js objects
 * that don't need a GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLaser } from '../src/entities/laser.js';

function makeScene() {
  return new THREE.Scene();
}

function makeAsteroid(x, z, r) {
  return {
    getPosition: () => ({ x, y: 0, z }),
    getRadius: () => r,
  };
}

test('createLaser throws without scene', () => {
  assert.throws(() => createLaser({}), /scene.*required/);
});

test('initial state: not firing, not on cooldown, no pending hits', () => {
  const laser = createLaser({ scene: makeScene() });
  assert.equal(laser.isFiring(), false);
  assert.equal(laser.isOnCooldown(), false);
  assert.equal(laser.getCooldownRemaining(), 0);
  assert.equal(laser.getFireTimeRemaining(), 0);
  assert.equal(laser.getPendingHits().size, 0);
  laser.dispose();
});

test('fire starts firing and computes hits for in-path asteroids', () => {
  const laser = createLaser({ scene: makeScene() });
  const asteroids = [
    makeAsteroid(0, -10, 1),   // in beam path (10 units forward)
    makeAsteroid(0, -50, 1),   // in beam path (50 units forward)
    makeAsteroid(0, 100, 1),   // BEHIND the ship (positive Z)
    makeAsteroid(1000, 0, 1),  // to the side, not hit
  ];
  const result = laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 }, // forward = -Z
    asteroids,
  });
  assert.equal(result, true);
  assert.equal(laser.isFiring(), true);
  const hits = laser.getPendingHits();
  assert.equal(hits.size, 2, 'should hit two in-path asteroids');
  assert.ok(hits.has(asteroids[0]));
  assert.ok(hits.has(asteroids[1]));
  assert.ok(!hits.has(asteroids[2]), 'asteroid behind ship is not hit');
  assert.ok(!hits.has(asteroids[3]), 'asteroid to the side is not hit');
  laser.dispose();
});

test('fire with no direction is rejected', () => {
  const laser = createLaser({ scene: makeScene() });
  assert.equal(laser.fire({}), false);
  assert.equal(laser.fire({ origin: { x: 0, y: 0, z: 0 } }), false);
  assert.equal(
    laser.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 } }),
    false,
    'zero-length direction rejected',
  );
  laser.dispose();
});

test('cooldown rejects a second fire', () => {
  const laser = createLaser({ scene: makeScene() });
  const asteroids = [makeAsteroid(0, -10, 1)];
  const r1 = laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids,
  });
  assert.equal(r1, true);
  // Immediately fire again — should be rejected
  const r2 = laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids,
  });
  assert.equal(r2, false, 'second fire within cooldown is rejected');
  laser.dispose();
});

test('update decrements fire timer and ends firing', () => {
  const laser = createLaser({ scene: makeScene() });
  laser.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(laser.isFiring(), true);
  laser.update(0.5, null, []); // long enough to end firing (duration is 0.12s)
  assert.equal(laser.isFiring(), false);
  assert.equal(laser.getFireTimeRemaining(), 0);
  laser.dispose();
});

test('update decrements cooldown over time', () => {
  const laser = createLaser({ scene: makeScene() });
  laser.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(laser.isOnCooldown(), true);
  laser.update(0.5, null, []); // > cooldown (0.08s)
  assert.equal(laser.isOnCooldown(), false);
  laser.dispose();
});

test('pending hits are cleared when firing ends', () => {
  const laser = createLaser({ scene: makeScene() });
  const a = makeAsteroid(0, -10, 1);
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [a],
  });
  assert.equal(laser.getPendingHits().size, 1);
  laser.update(0.5, null, []); // end firing
  assert.equal(laser.getPendingHits().size, 0);
  laser.dispose();
});

test('consumeHit removes an entity from the pending set', () => {
  const laser = createLaser({ scene: makeScene() });
  const a = makeAsteroid(0, -10, 1);
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [a],
  });
  assert.equal(laser.getPendingHits().size, 1);
  laser.consumeHit(a);
  assert.equal(laser.getPendingHits().size, 0);
  // Consuming a non-pending entity is a silent no-op
  laser.consumeHit(makeAsteroid(99, 99, 1));
  laser.dispose();
});

test('update while firing sweeps new hits as the ship moves', () => {
  const laser = createLaser({ scene: makeScene() });
  const ship = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0 }, // forward = -Z
  };
  // First fire with no asteroids in the path
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [],
  });
  assert.equal(laser.getPendingHits().size, 0);
  // Update with a fresh asteroid in the path — the beam follows the
  // ship and should pick it up.
  const a = makeAsteroid(0, -10, 1);
  laser.update(0.01, ship, [a]);
  assert.equal(laser.getPendingHits().size, 1);
  assert.ok(laser.getPendingHits().has(a));
  laser.dispose();
});

test('asteroid to the side of the beam is not hit', () => {
  const laser = createLaser({ scene: makeScene() });
  // Beam: origin (0,0,0), dir (0,0,-1), length 2000.
  // Asteroid: (5, 0, -10). Distance from beam axis = 5 > radius 1. No hit.
  const a = makeAsteroid(5, -10, 1);
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [a],
  });
  assert.equal(laser.getPendingHits().size, 0);
  laser.dispose();
});

test('asteroid grazing the beam is hit (boundary inclusive)', () => {
  const laser = createLaser({ scene: makeScene() });
  // Beam at z-axis. Asteroid at (0.9, 0, -10), radius 1 → center 0.9
  // from beam axis, just within radius 1.
  const a = makeAsteroid(0.9, -10, 1);
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [a],
  });
  assert.equal(laser.getPendingHits().size, 1);
  laser.dispose();
});

test('asteroid past the beam tip is still hit if the sphere extends back', () => {
  const laser = createLaser({ scene: makeScene() });
  // Asteroid center at z = -600 (past the 500-unit tip), radius 200.
  // The closest point on the segment to the asteroid is the tip at
  // z = -500. Distance = 100 < 200. Should hit. (Test was written
  // for the old 2000-unit tip; updated for the perf fix that
  // shortened the beam.)
  const a = makeAsteroid(0, -600, 200);
  laser.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    asteroids: [a],
  });
  assert.equal(laser.getPendingHits().size, 1);
  laser.dispose();
});

test('dispose releases meshes', () => {
  const scene = makeScene();
  const laser = createLaser({ scene });
  // 2 meshes added: core + glow
  assert.equal(scene.children.length, 2);
  laser.dispose();
  assert.equal(scene.children.length, 0);
});
