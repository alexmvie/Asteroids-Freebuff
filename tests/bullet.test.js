/**
 * Unit tests for src/entities/bullet.js.
 *
 * Exercises the pool, fire, update, dispose lifecycle. We mock the Three.js
 * scene to avoid pulling WebGL into Node — the pool only uses scene.add()
 * and scene.remove(), both of which are trivial to stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBulletPool } from '../src/entities/bullet.js';

// ---- Mock scene ---------------------------------------------------------

function makeMockScene() {
  const added = [];
  const removed = [];
  return {
    add: (obj) => added.push(obj),
    remove: (obj) => removed.push(obj),
    added,
    removed,
  };
}

function makeBulletPool(capacity = 8) {
  const scene = makeMockScene();
  const pool = createBulletPool({ scene, capacity });
  return { scene, pool };
}

// ---- Pool construction --------------------------------------------------

test('createBulletPool: requires scene', () => {
  assert.throws(() => createBulletPool({}), /scene.*required/);
});

test('createBulletPool: rejects capacity < 1', () => {
  const scene = makeMockScene();
  assert.throws(() => createBulletPool({ scene, capacity: 0 }), /capacity/);
  assert.throws(() => createBulletPool({ scene, capacity: -3 }), /capacity/);
});

test('createBulletPool: starts with all bullets inactive', () => {
  const { pool } = makeBulletPool(8);
  assert.equal(pool.getCapacity(), 8);
  assert.equal(pool.getActiveCount(), 0);
  pool.dispose();
});

test('createBulletPool: adds `capacity` meshes to the scene', () => {
  const { scene, pool } = makeBulletPool(8);
  assert.equal(scene.added.length, 8);
  pool.dispose();
});

// ---- fire() -------------------------------------------------------------

test('fire: activates a bullet and returns its index', () => {
  const { pool } = makeBulletPool(8);
  const idx = pool.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
  });
  assert.equal(idx, 0);
  assert.equal(pool.getActiveCount(), 1);
  pool.dispose();
});

test('fire: sets position to origin and velocity along direction * speed', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({
    origin: { x: 10, y: 0, z: 20 },
    direction: { x: 0, y: 0, z: -1 },
    speed: 100,
  });
  let captured = null;
  pool.forEachActive((b) => { captured = b; });
  assert.ok(captured, 'expected one active bullet');
  assert.equal(captured.position.x, 10);
  assert.equal(captured.position.y, 0);
  assert.equal(captured.position.z, 20);
  assert.equal(captured.velocity.x, 0);
  assert.equal(captured.velocity.y, 0);
  assert.equal(captured.velocity.z, -100);
  pool.dispose();
});

test('fire: normalizes a non-unit direction', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 3, y: 0, z: 4 }, // length 5
    speed: 500, // → 100 u/s per unit → bullet moves at 500 u/s
  });
  let captured = null;
  pool.forEachActive((b) => { captured = b; });
  // Float tolerance: 3/5*500 = 300 exactly in math, but the FPU gives 300.00000000000006.
  // Bullets travel in the +direction they're fired; z=4 → vz = +400.
  assert.ok(Math.abs(captured.velocity.x - 300) < 1e-9, `vx: ${captured.velocity.x}`);
  assert.ok(Math.abs(captured.velocity.z - 400) < 1e-9, `vz: ${captured.velocity.z}`);
  pool.dispose();
});

test('fire: returns -1 if on cooldown', () => {
  const { pool } = makeBulletPool(8);
  const ok = pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(ok, 0);
  // No time has passed — cooldown is 0.18s, so this should fail.
  const denied = pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(denied, -1);
  assert.equal(pool.getActiveCount(), 1);
  pool.dispose();
});

test('fire: returns -1 when pool is exhausted', () => {
  // Capacity 1. Fire one bullet, advance time past the cooldown but
  // short of the lifetime — the slot is still occupied, so the next
  // fire should fail with -1.
  const { pool } = makeBulletPool(1);
  assert.equal(pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }), 0);
  pool.update(1); // cooldown (0.18) elapsed, bullet still alive (aged 1.0 < 1.5)
  assert.equal(pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }), -1);
  pool.dispose();
});

test('fire: returns -1 for missing origin / direction', () => {
  const { pool } = makeBulletPool(8);
  assert.equal(pool.fire({ direction: { x: 0, y: 0, z: -1 } }), -1);
  assert.equal(pool.fire({ origin: { x: 0, y: 0, z: 0 } }), -1);
  assert.equal(pool.fire({}), -1);
  assert.equal(pool.fire(), -1);
  pool.dispose();
});

test('fire: returns -1 for zero-length direction', () => {
  const { pool } = makeBulletPool(8);
  assert.equal(
    pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 } }),
    -1,
  );
  pool.dispose();
});

// ---- update() -----------------------------------------------------------

test('update: moves active bullets by velocity * dt', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, speed: 100 });
  pool.update(0.5);
  let captured = null;
  pool.forEachActive((b) => { captured = b; });
  assert.equal(captured.position.z, -50);
  pool.dispose();
});

test('update: decrements the cooldown over time', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  // Cooldown is 0.18s. After 0.10s we're still on cooldown.
  pool.update(0.10);
  assert.equal(pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }), -1);
  // After another 0.10s (total 0.20) cooldown has elapsed.
  pool.update(0.10);
  assert.notEqual(pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }), -1);
  pool.dispose();
});

test('update: despawns bullets past their lifetime (default 1.5s)', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(pool.getActiveCount(), 1);
  pool.update(1.5);
  assert.equal(pool.getActiveCount(), 0);
  pool.dispose();
});

test('update: no-op for non-positive dt (no NaN, no movement)', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  pool.update(0);
  pool.update(-1);
  let captured = null;
  pool.forEachActive((b) => { captured = b; });
  assert.equal(captured.position.x, 0);
  assert.equal(captured.position.z, 0);
  pool.dispose();
});

test('update: pool reuses slots after a despawn', () => {
  const { pool } = makeBulletPool(2);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  pool.update(2); // first bullet despawns
  assert.equal(pool.getActiveCount(), 0);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(pool.getActiveCount(), 1);
  pool.dispose();
});

// ---- dispose() ----------------------------------------------------------

test('dispose: removes all meshes from the scene and deactivates all bullets', () => {
  const { scene, pool } = makeBulletPool(4);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  pool.update(1.6); // first bullet despawns (lifetime 1.5)
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  assert.equal(pool.getActiveCount(), 1);
  pool.dispose();
  assert.equal(scene.removed.length, 4);
  assert.equal(pool.getActiveCount(), 0);
});

// ---- forEachActive ------------------------------------------------------

test('forEachActive: iterates only over live bullets', () => {
  const { pool } = makeBulletPool(8);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  pool.update(1);
  pool.fire({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } });
  pool.update(0.5); // bullet still alive

  const seen = [];
  pool.forEachActive((b) => seen.push(b.index));
  assert.equal(seen.length, 1);
  pool.dispose();
});
