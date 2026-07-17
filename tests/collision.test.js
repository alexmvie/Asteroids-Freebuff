/**
 * Unit tests for src/systems/collision.js.
 *
 * Pure logic only — no Three.js, no DOM. We mock asteroids and bullets
 * as plain objects that satisfy the duck-typed API:
 *   - asteroid.getPosition() → {x,y,z}
 *   - asteroid.getRadius()   → number
 *   - bullet.position        → {x,y,z}
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  spheresOverlap,
  findBulletHits,
  findShipHit,
  scoreForSize,
  SCORE_BY_SIZE,
  BULLET_RADIUS,
  SHIP_RADIUS,
  findAsteroidPairs,
  resolveAsteroidCollision,
  findAsteroidPowerupIndex,
  resolveAsteroidPowerupCollision,
  findBulletShipHits,
} from '../src/systems/collision.js';
import { createSpatialHash } from '../src/systems/spatial-hash.js';

// ---- Helpers ------------------------------------------------------------

/**
 * Build a fake asteroid with the duck-typed API collision.js expects.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} r
 * @param {{x:number,z:number}} [vel]
 */
function fakeAsteroid(x, y, z, r, vel) {
  const v = vel || { x: 0, z: 0 };
  const pos = { x, y, z };
  return {
    getPosition: () => pos,
    getRadius: () => r,
    getVelocity: () => ({ x: v.x, z: v.z }),
    setVelocity(vx, vz) { v.x = vx; v.z = vz; },
  };
}

/**
 * Build a fake bullet with the duck-typed API the pool exposes.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function fakeBullet(x, y, z) {
  return { position: { x, y, z } };
}

/**
 * Build a fake powerup with the duck-typed API for collision + push.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} r
 */
function fakePowerup(x, y, z, r) {
  const pos = { x, y, z };
  let _pushVx = 0;
  let _pushVz = 0;
  return {
    getPosition: () => pos,
    getRadius: () => r,
    getPushVx: () => _pushVx,
    getPushVz: () => _pushVz,
    pushAway(vx, vz) { _pushVx += vx; _pushVz += vz; },
  };
}

/**
 * Build a fake bullet pool that captures the forEachActive callback and
 * invokes it for each bullet + index. Mirrors the real pool's API surface.
 * @param {Array<{position:{x,y,z}}>} bullets
 */
function fakeBulletPool(bullets) {
  return {
    forEachActive(fn) {
      for (let i = 0; i < bullets.length; i++) fn(bullets[i], i);
    },
  };
}

// ---- spheresOverlap -----------------------------------------------------

test('spheresOverlap: identical centers always overlap', () => {
  assert.equal(spheresOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 0, y: 0, z: 0, r: 1 }), true);
});

test('spheresOverlap: touching but not overlapping → false (strict <)', () => {
  // centers 2 apart, radii 1+1=2 → distance equals sum → false (we use <)
  assert.equal(spheresOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 2, y: 0, z: 0, r: 1 }), false);
});

test('spheresOverlap: overlapping by an epsilon → true', () => {
  assert.equal(spheresOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 1.9, y: 0, z: 0, r: 1 }), true);
});

test('spheresOverlap: far apart → false', () => {
  assert.equal(spheresOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 100, y: 0, z: 0, r: 1 }), false);
});

test('spheresOverlap: 3D distance, not just X axis', () => {
  // corners of a 1.5-edge cube: distance = sqrt(3*1.5^2) ≈ 2.598
  // radii 1+1=2 → no overlap
  assert.equal(spheresOverlap(
    { x: 0, y: 0, z: 0, r: 1 },
    { x: 1.5, y: 1.5, z: 1.5, r: 1 },
  ), false);
  // same idea but centers 1.0 apart on each axis → diagonal = sqrt(3) ≈ 1.73 < 2
  assert.equal(spheresOverlap(
    { x: 0, y: 0, z: 0, r: 1 },
    { x: 1.0, y: 1.0, z: 1.0, r: 1 },
  ), true);
});

test('spheresOverlap: large/small asymmetry (bullet vs ship)', () => {
  // bullet r=0.15, ship r=1.4 → sum = 1.55. Centers 1.5 apart → overlap.
  assert.equal(spheresOverlap(
    { x: 0, y: 0, z: 0, r: 0.15 },
    { x: 1.5, y: 0, z: 0, r: 1.4 },
  ), true);
  // Centers 1.6 apart → no overlap.
  assert.equal(spheresOverlap(
    { x: 0, y: 0, z: 0, r: 0.15 },
    { x: 1.6, y: 0, z: 0, r: 1.4 },
  ), false);
});

// ---- findBulletHits -----------------------------------------------------

test('findBulletHits: empty lists → no hits', () => {
  const bullets = fakeBulletPool([]);
  assert.deepEqual(findBulletHits({ asteroids: [], bullets }), []);
});

test('findBulletHits: no asteroids → no hits', () => {
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  assert.deepEqual(findBulletHits({ asteroids: [], bullets }), []);
});

test('findBulletHits: bullet inside asteroid → hit', () => {
  const asteroids = [fakeAsteroid(0, 0, 0, 5)];
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const hits = findBulletHits({ asteroids, bullets });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bulletIndex, 0);
  assert.equal(hits[0].asteroidIndex, 0);
});

test('findBulletHits: bullet far from asteroid → no hit', () => {
  const asteroids = [fakeAsteroid(100, 0, 0, 5)];
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  assert.deepEqual(findBulletHits({ asteroids, bullets }), []);
});

test('findBulletHits: bullet chooses first matching asteroid in iteration order', () => {
  // Asteroid 0 is near (hits), asteroid 1 is far (misses). The bullet
  // reports asteroid 0 — we don't promise "nearest", only "first match".
  const asteroids = [
    fakeAsteroid(5, 0, 0, 10),  // near
    fakeAsteroid(50, 0, 0, 10), // far
  ];
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const hits = findBulletHits({ asteroids, bullets });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].asteroidIndex, 0);
});

test('findBulletHits: one bullet can only hit one asteroid per frame', () => {
  // Two overlapping asteroids in the same place; bullet should hit the
  // first one (index 0) and stop.
  const asteroids = [
    fakeAsteroid(0, 0, 0, 5),
    fakeAsteroid(0, 0, 0, 5),
  ];
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const hits = findBulletHits({ asteroids, bullets });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].asteroidIndex, 0);
});

test('findBulletHits: multiple bullets can hit the same asteroid', () => {
  const asteroids = [fakeAsteroid(0, 0, 0, 5)];
  const bullets = fakeBulletPool([
    fakeBullet(0, 0, 0),
    fakeBullet(1, 0, 0),
    fakeBullet(2, 0, 0),
  ]);
  const hits = findBulletHits({ asteroids, bullets });
  // Three bullets, all hit the same asteroid index 0. Caller is
  // responsible for de-duping with a Set.
  assert.equal(hits.length, 3);
  for (const h of hits) {
    assert.equal(h.asteroidIndex, 0);
  }
});

test('findBulletHits: each bullet gets its correct index', () => {
  const asteroids = [fakeAsteroid(0, 0, 0, 5), fakeAsteroid(100, 0, 0, 5)];
  const bullets = fakeBulletPool([
    fakeBullet(0, 0, 0),  // hits asteroid 0
    fakeBullet(100, 0, 0), // hits asteroid 1
    fakeBullet(200, 0, 0), // hits neither
  ]);
  const hits = findBulletHits({ asteroids, bullets });
  assert.equal(hits.length, 2);
  const byIdx = new Map(hits.map((h) => [h.bulletIndex, h.asteroidIndex]));
  assert.equal(byIdx.get(0), 0);
  assert.equal(byIdx.get(1), 1);
});

test('findBulletHits: bulletRadius option narrows the hit zone', () => {
  // Bullet at (1.5, 0, 0), asteroid at origin, r=1.4.
  // Default bullet r=0.15 → sum=1.55. Centers 1.5 apart → 1.5 < 1.55 → hit.
  // bulletRadius=0.05 → sum=1.45. 1.5 < 1.45? No → miss.
  const asteroids = [fakeAsteroid(0, 0, 0, 1.4)];
  const bullets = fakeBulletPool([fakeBullet(1.5, 0, 0)]);
  assert.equal(findBulletHits({ asteroids, bullets }).length, 1);
  assert.equal(findBulletHits({ asteroids, bullets, bulletRadius: 0.05 }).length, 0);
});

test('findBulletHits: swept-sphere catches fast bullet passing through small asteroid', () => {
  // Bullet radius 0.15, asteroid radius 1.5. Bullet crosses the asteroid
  // during the frame and ends up past it. The discrete position check at
  // the end point misses; swept-sphere should catch it.
  const asteroids = [fakeAsteroid(0, 0, 0, 1.5)];
  const b = {
    position: { x: -2, y: 0, z: 0 },
    velocity: { x: -500, y: 0, z: 0 },
  };
  const bullets = {
    forEachActive(fn) { fn(b, 0); },
  };
  // Without dt (discrete only) → bullet at (-2,0,0), asteroid r=1.5,
  // centers 2 apart, sum=1.65 → miss.
  assert.deepEqual(findBulletHits({ asteroids, bullets }).length, 0);
  // With dt=0.02 (20ms at 50 FPS): previous pos = (-2 + 10, 0, 0) = (8,0,0).
  // Path segment from (8,0,0) to (-2,0,0) passes through origin.
  // Distance from origin to segment = 0 < 0.15 + 1.5 → hit.
  const hits = findBulletHits({ asteroids, bullets, dt: 0.02 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bulletIndex, 0);
  assert.equal(hits[0].asteroidIndex, 0);
});

test('findBulletHits: missing args → empty list, no throw', () => {
  assert.deepEqual(findBulletHits({}), []);
  assert.deepEqual(findBulletHits({ asteroids: [] }), []);
  assert.deepEqual(findBulletHits({ bullets: fakeBulletPool([]) }), []);
});

// ---- findShipHit --------------------------------------------------------

test('findShipHit: empty asteroids → -1', () => {
  const ship = { position: { x: 0, y: 0, z: 0 } };
  assert.equal(findShipHit({ ship, asteroids: [] }), -1);
});

test('findShipHit: asteroid far from ship → -1', () => {
  const ship = { position: { x: 0, y: 0, z: 0 } };
  const asteroids = [fakeAsteroid(100, 0, 0, 5)];
  assert.equal(findShipHit({ ship, asteroids }), -1);
});

test('findShipHit: asteroid touches ship → returns index', () => {
  const ship = { position: { x: 0, y: 0, z: 0 } };
  const asteroids = [fakeAsteroid(2, 0, 0, 5)]; // ship r=1.4, asteroid r=5 → sum=6.4
  assert.equal(findShipHit({ ship, asteroids }), 0);
});

test('findShipHit: returns the first hit in iteration order', () => {
  const ship = { position: { x: 0, y: 0, z: 0 } };
  const asteroids = [
    fakeAsteroid(100, 0, 0, 5), // miss
    fakeAsteroid(1, 0, 0, 5),   // hit
    fakeAsteroid(0, 0, 0, 5),   // also hit
  ];
  assert.equal(findShipHit({ ship, asteroids }), 1);
});

test('findShipHit: shipRadius option tightens the test', () => {
  const ship = { position: { x: 0, y: 0, z: 0 } };
  // Asteroid sized so the default ship hits, but a tiny ship misses.
  // centers 2 apart, asteroid r=1.5.
  const asteroids = [fakeAsteroid(2, 0, 0, 1.5)];
  // Default SHIP_RADIUS=1.4, sum=2.9 → 2 < 2.9 → hit
  assert.equal(findShipHit({ ship, asteroids }), 0);
  // shipRadius=1.4 (explicit), same as default → hit
  assert.equal(findShipHit({ ship, asteroids, shipRadius: 1.4 }), 0);
  // shipRadius=0.5, sum=2.0 → 2 < 2.0? No → miss
  assert.equal(findShipHit({ ship, asteroids, shipRadius: 0.5 }), -1);
  // shipRadius=0, sum=1.5 → 2 < 1.5? No → miss
  assert.equal(findShipHit({ ship, asteroids, shipRadius: 0 }), -1);
});

test('findShipHit: missing args → -1, no throw', () => {
  assert.equal(findShipHit({}), -1);
  assert.equal(findShipHit({ ship: { position: { x: 0, y: 0, z: 0 } } }), -1);
  assert.equal(findShipHit({ asteroids: [fakeAsteroid(0, 0, 0, 1)] }), -1);
});

// ---- scoreForSize / SCORE_BY_SIZE ---------------------------------------

test('SCORE_BY_SIZE: classic Asteroids table (large=20, medium=50, small=100)', () => {
  assert.equal(SCORE_BY_SIZE[0], 20);
  assert.equal(SCORE_BY_SIZE[1], 50);
  assert.equal(SCORE_BY_SIZE[2], 100);
});

test('SCORE_BY_SIZE: frozen', () => {
  assert.throws(() => { SCORE_BY_SIZE[0] = 999; });
});

test('scoreForSize: returns the table value for known sizes', () => {
  assert.equal(scoreForSize(0), 20);
  assert.equal(scoreForSize(1), 50);
  assert.equal(scoreForSize(2), 100);
});

test('scoreForSize: returns 0 for unknown sizes', () => {
  assert.equal(scoreForSize(3), 0);
  assert.equal(scoreForSize(-1), 0);
  assert.equal(scoreForSize(undefined), 0);
});

// ---- findAsteroidPairs -------------------------------------------------

test('findAsteroidPairs: empty list → []', () => {
  assert.deepEqual(findAsteroidPairs([]), []);
});

test('findAsteroidPairs: single asteroid → []', () => {
  assert.deepEqual(findAsteroidPairs([fakeAsteroid(0, 0, 0, 5)]), []);
});

test('findAsteroidPairs: two overlapping asteroids → one pair', () => {
  const asteroids = [
    fakeAsteroid(0, 0, 0, 5),
    fakeAsteroid(3, 0, 0, 5), // centers 3 apart, radii 5+5=10 → overlap
  ];
  const pairs = findAsteroidPairs(asteroids);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].i, 0);
  assert.equal(pairs[0].j, 1);
});

test('findAsteroidPairs: two far apart → []', () => {
  const asteroids = [
    fakeAsteroid(0, 0, 0, 5),
    fakeAsteroid(100, 0, 0, 5),
  ];
  assert.deepEqual(findAsteroidPairs(asteroids), []);
});

test('findAsteroidPairs: three overlapping all pairs', () => {
  // All three at origin with r=10 → all overlap each other → 3 pairs
  const asteroids = [
    fakeAsteroid(0, 0, 0, 10),
    fakeAsteroid(0, 0, 0, 10),
    fakeAsteroid(0, 0, 0, 10),
  ];
  const pairs = findAsteroidPairs(asteroids);
  assert.equal(pairs.length, 3);
  // Each pair i<j
  for (const { i, j } of pairs) {
    assert.ok(i < j);
  }
});

test('findAsteroidPairs: null/undefined → []', () => {
  assert.deepEqual(findAsteroidPairs(null), []);
  assert.deepEqual(findAsteroidPairs(undefined), []);
});

// ---- resolveAsteroidCollision -------------------------------------------

test('resolveAsteroidCollision: separates overlapping asteroids', () => {
  const a = fakeAsteroid(0, 0, 0, 5, { x: 0, z: 0 });
  const b = fakeAsteroid(2, 0, 0, 5, { x: 0, z: 0 }); // overlap by 8 units
  resolveAsteroidCollision(a, b);
  const ap = a.getPosition();
  const bp = b.getPosition();
  const dist = Math.hypot(bp.x - ap.x, bp.z - ap.z);
  assert.ok(dist >= 9.99); // minDist = 10, pushed apart
});

test('resolveAsteroidCollision: equal masses push apart equally', () => {
  const a = fakeAsteroid(0, 0, 0, 5, { x: 0, z: 0 });
  const b = fakeAsteroid(2, 0, 0, 5, { x: 0, z: 0 });
  resolveAsteroidCollision(a, b);
  const ap = a.getPosition();
  const bp = b.getPosition();
  // Equal masses: both move equally. Center stayed at 1.
  const centerX = (ap.x + bp.x) / 2;
  assert.ok(Math.abs(centerX - 1) < 0.01, 'center of mass preserved');
});

test('resolveAsteroidCollision: transfers momentum (equal mass, A moving toward B)', () => {
  const a = fakeAsteroid(0, 0, 0, 5, { x: 10, z: 0 }); // moving right
  const b = fakeAsteroid(8, 0, 0, 5, { x: 0, z: 0 });  // stationary
  resolveAsteroidCollision(a, b);
  const av = a.getVelocity();
  const bv = b.getVelocity();
  // A lost some speed to B (both now moving right, but B got a kick)
  assert.ok(av.x < 10, 'A lost speed');
  assert.ok(bv.x > 0, 'B gained speed');
});

test('resolveAsteroidCollision: larger mass barely moves', () => {
  const big = fakeAsteroid(0, 0, 0, 10, { x: 0, z: 0 }); // r=10, mass=1000
  const small = fakeAsteroid(3, 0, 0, 1, { x: 5, z: 0 }); // r=1, mass=1
  const bigPosBefore = { ...big.getPosition() };
  resolveAsteroidCollision(big, small);
  const bigPos = big.getPosition();
  // Big asteroid barely moved
  assert.ok(Math.abs(bigPos.x - bigPosBefore.x) < 1, 'big barely moved');
});

test('resolveAsteroidCollision: non-overlapping does nothing', () => {
  const a = fakeAsteroid(0, 0, 0, 5, { x: 10, z: 0 });
  const b = fakeAsteroid(30, 0, 0, 5, { x: 0, z: 0 });
  const aVelBefore = { ...a.getVelocity() };
  const aPosBefore = { ...a.getPosition() };
  resolveAsteroidCollision(a, b);
  assert.equal(a.getVelocity().x, aVelBefore.x);
  assert.equal(a.getPosition().x, aPosBefore.x);
});

test('resolveAsteroidCollision: already separating does nothing', () => {
  const a = fakeAsteroid(0, 0, 0, 5, { x: -5, z: 0 }); // moving left
  const b = fakeAsteroid(2, 0, 0, 5, { x: 5, z: 0 });  // moving right (away from A)
  const avBefore = a.getVelocity().x;
  const bvBefore = b.getVelocity().x;
  resolveAsteroidCollision(a, b);
  // Relative velocity along normal (B→A direction) is positive → already separating
  assert.equal(a.getVelocity().x, avBefore);
  assert.equal(b.getVelocity().x, bvBefore);
});

// ---- findAsteroidPowerupIndex -------------------------------------------

test('findAsteroidPowerupIndex: no asteroids → -1', () => {
  const pu = fakePowerup(0, 0, 0, 1.5);
  assert.equal(findAsteroidPowerupIndex({ asteroids: [], powerup: pu }), -1);
});

test('findAsteroidPowerupIndex: no powerup → -1', () => {
  const asteroids = [fakeAsteroid(0, 0, 0, 5)];
  assert.equal(findAsteroidPowerupIndex({ asteroids }), -1);
});

test('findAsteroidPowerupIndex: overlapping → returns index', () => {
  const asteroids = [
    fakeAsteroid(100, 0, 0, 5),
    fakeAsteroid(0, 0, 0, 5), // this one overlaps the powerup at (2,0,0)
  ];
  const pu = fakePowerup(2, 0, 0, 1.5); // asteroid r=5, powerup r=1.5, sum=6.5
  // centers 2 apart, 2 < 6.5 → overlap
  assert.equal(findAsteroidPowerupIndex({ asteroids, powerup: pu }), 1);
});

test('findAsteroidPowerupIndex: not overlapping → -1', () => {
  const asteroids = [fakeAsteroid(0, 0, 0, 5)];
  const pu = fakePowerup(100, 0, 0, 1.5);
  assert.equal(findAsteroidPowerupIndex({ asteroids, powerup: pu }), -1);
});

// ---- resolveAsteroidPowerupCollision -------------------------------------

test('resolveAsteroidPowerupCollision: pushes powerup out and kicks away', () => {
  const ast = fakeAsteroid(0, 0, 0, 5);
  const pu = fakePowerup(2, 0, 0, 1.5); // overlapping (2 < 6.5)
  const originalPuX = pu.getPosition().x;
  resolveAsteroidPowerupCollision(ast, pu);
  // Powerup pushed out (further from origin)
  assert.ok(pu.getPosition().x > originalPuX, 'powerup pushed away');
  // Distance between centers >= minDist
  const dist = Math.hypot(
    pu.getPosition().x - ast.getPosition().x,
    pu.getPosition().z - ast.getPosition().z,
  );
  assert.ok(dist >= 6.5 - 0.01, 'powerup outside asteroid radius');
  // Push velocity set (positive X = away from asteroid)
  assert.ok(pu.getPushVx() > 0, 'kick velocity in X');
});

test('resolveAsteroidPowerupCollision: not overlapping does nothing', () => {
  const ast = fakeAsteroid(0, 0, 0, 5);
  const pu = fakePowerup(100, 0, 0, 1.5);
  const puX = pu.getPosition().x;
  resolveAsteroidPowerupCollision(ast, pu);
  assert.equal(pu.getPosition().x, puX);
  assert.equal(pu.getPushVx(), 0);
});

test('resolveAsteroidPowerupCollision: null/undefined is no-op', () => {
  // Should not throw
  resolveAsteroidPowerupCollision(null, null);
  resolveAsteroidPowerupCollision(undefined, undefined);
  resolveAsteroidPowerupCollision(fakeAsteroid(0, 0, 0, 5), null);
  resolveAsteroidPowerupCollision(null, fakePowerup(0, 0, 0, 1.5));
});

// ---- Constants sanity ---------------------------------------------------

test('BULLET_RADIUS and SHIP_RADIUS are positive scalars', () => {
  assert.ok(typeof BULLET_RADIUS === 'number' && BULLET_RADIUS > 0);
  assert.ok(typeof SHIP_RADIUS === 'number' && SHIP_RADIUS > 0);
});

test('SHIP_RADIUS is 3.0 (v0.42.x matches 3x-scaled visual mesh)', () => {
  assert.equal(SHIP_RADIUS, 3.0);
});

// ---- Spatial-hash parity (v0.64.x broad-phase) ------------------------

test('hash path: findBulletHits with spatialHash matches O(N²) result', () => {
  // Build a 30-asteroid field with realistic positions + radii. For
  // each find* function below, we run BOTH paths (with and without
  // the spatialHash arg) and assert identical output. The narrow-phase
  // contract must not change just because we have a different
  // candidate-selection strategy.
  const entities = [];
  for (let i = 0; i < 30; i++) {
    entities.push({
      position: { x: (i % 6) * 30, y: 0, z: Math.floor(i / 6) * 30 },
      radius: 2,
      spec: { size: 0, radius: 2 },
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }

  // Inject a small cluster that crosses cell boundaries so the hash
  // has to span multiple cells for the same query point. Plain-object
  // positions need direct field assignment (no `.set` method on a
  // raw `{x,y,z}` object).
  entities[0].position.x = -1;
  entities[0].position.y = 0;
  entities[0].position.z = -1;
  entities[1].position.x = 15;
  entities[1].position.y = 0;
  entities[1].position.z = 15; // crosses cell boundary at x=16
  entities[2].position.x = 16;
  entities[2].position.y = 0;
  entities[2].position.z = 0;  // right at the boundary

  const bullets = [
    { position: { x: 0, y: 0, z: 0 }, index: 0 },             // inside 0
    { position: { x: -1000, y: 0, z: -1000 }, index: 1 },     // far away
    { position: { x: 30, y: 0, z: 30 }, index: 2 },            // hits an asteroid at 30,30
    { position: { x: 17, y: 0, z: 17 }, index: 3 },           // near 1 + 2
  ];

  const BULLET_RADIUS = 2; // wide enough to bite the boundaries
  const noHash = findBulletHits({ asteroids: entities, bullets: { forEachActive(fn) { for (let i = 0; i < bullets.length; i++) fn(bullets[i], i); } }, bulletRadius: BULLET_RADIUS });

  const hash = createSpatialHash({ cellSize: 16 });
  hash.rebuild(entities);
  const withHash = findBulletHits({
    asteroids: entities,
    bullets: { forEachActive(fn) { for (let i = 0; i < bullets.length; i++) fn(bullets[i], i); } },
    bulletRadius: BULLET_RADIUS,
    spatialHash: hash,
  });

  // Sort both for stable comparison (set semantics: at most one hit per bullet).
  const sortFn = (a, b) => a.bulletIndex - b.bulletIndex || a.asteroidIndex - b.asteroidIndex;
  assert.deepEqual([...noHash].sort(sortFn), [...withHash].sort(sortFn));
});

test('hash path: findAsteroidPairs with spatialHash matches O(N²) result', () => {
  // Compact cluster of overlapping asteroids — the hash path must
  // produce the same `i<j` pair list as the legacy sweep.
  const entities = [];
  for (let i = 0; i < 10; i++) {
    entities.push({
      position: { x: i * 3, y: 0, z: 0 },
      radius: 5, // r=5 + r=5 = 10 — every neighbor within 6u overlaps
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }
  // Add two far-away entities to force long-range miss pairs.
  entities.push({
    position: { x: 1000, y: 0, z: 0 },
    radius: 5,
    getPosition() { return this.position; },
    getRadius() { return this.radius; },
  });
  entities.push({
    position: { x: -1000, y: 0, z: 0 },
    radius: 5,
    getPosition() { return this.position; },
    getRadius() { return this.radius; },
  });

  const noHash = findAsteroidPairs(entities);
  const hash = createSpatialHash({ cellSize: 16 });
  hash.rebuild(entities);
  const withHash = findAsteroidPairs(entities, { spatialHash: hash });

  const sortFn = (a, b) => a.i - b.i || a.j - b.j;
  assert.deepEqual([...noHash].sort(sortFn), [...withHash].sort(sortFn));
});

test('hash path: findShipHit with spatialHash matches O(N²) result', () => {
  const ship = { position: { x: 50, y: 0, z: 25 } };
  const asteroids = [];
  for (let i = 0; i < 20; i++) {
    asteroids.push({
      position: { x: i * 7, y: 0, z: 0 },
      radius: 2,
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }
  // Place an asteroid inside the ship's collision sphere.
  asteroids.push({
    position: { x: 52, y: 0, z: 24 },
    radius: 2,
    getPosition() { return this.position; },
    getRadius() { return this.radius; },
  });

  assert.equal(findShipHit({ ship, asteroids }), findShipHit({ ship, asteroids: asteroids.slice() }));
  const hash = createSpatialHash({ cellSize: 16 });
  hash.rebuild(asteroids);
  assert.equal(findShipHit({ ship, asteroids }), findShipHit({ ship, asteroids, spatialHash: hash }));
});

test('hash path: findBulletShipHits with spatialHash matches O(N²) result', () => {
  const ships = [
    { position: { x: 10, y: 0, z: 0 } },
    { position: { x: 100, y: 0, z: 0 } },
    { position: { x: -50, y: 0, z: -50 } },
  ];
  const bullets = [
    { position: { x: 10, y: 0, z: 0 } },     // hits ship 0
    { position: { x: 100, y: 0, z: 0 } },   // hits ship 1
    { position: { x: -50, y: 0, z: -50 } }, // hits ship 2
    { position: { x: 1000, y: 0, z: 1000 } }, // misses all
  ];
  const bulletsObj = {
    forEachActive(fn) { for (let i = 0; i < bullets.length; i++) fn(bullets[i], i); },
  };

  const noHash = findBulletShipHits({ bullets: bulletsObj, ships, bulletRadius: 0.15, shipRadius: 3.0 });
  const hash = createSpatialHash({ cellSize: 8 });
  hash.rebuild(ships);
  const withHash = findBulletShipHits({
    bullets: bulletsObj,
    ships,
    bulletRadius: 0.15,
    shipRadius: 3.0,
    spatialHash: hash,
  });
  const sortFn = (a, b) => a.bulletIndex - b.bulletIndex || a.shipIndex - b.shipIndex;
  assert.deepEqual([...noHash].sort(sortFn), [...withHash].sort(sortFn));
});

test('hash path: findAsteroidPowerupIndex with spatialHash matches O(N²) result', () => {
  const pu = { getPosition: () => ({ x: 0, y: 0, z: 0 }), getRadius: () => 1.5 };
  const asteroids = [];
  for (let i = 0; i < 20; i++) {
    asteroids.push({
      position: { x: i * 5, y: 0, z: 0 },
      radius: 2,
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }
  // Inject an asteroid that overlaps the powerup (at origin).
  asteroids[3] = {
    position: { x: 0.5, y: 0, z: 0.5 },
    radius: 2,
    getPosition() { return this.position; },
    getRadius() { return this.radius; },
  };
  const noHash = findAsteroidPowerupIndex({ asteroids, powerup: pu });
  const hash = createSpatialHash({ cellSize: 16 });
  hash.rebuild(asteroids);
  const withHash = findAsteroidPowerupIndex({ asteroids, powerup: pu, spatialHash: hash });
  assert.equal(noHash, withHash);
});

test('hash path: null/missing spatialHash falls back to O(N²) (back-compat)', () => {
  // Regression: passing `null`, `undefined`, or omitting the param all
  // must invoke the existing O(N²) sweep unchanged. This is the
  // back-compat contract for every pre-v0.64.x call site.
  const asteroids = [{
    position: { x: 0, y: 0, z: 0 },
    radius: 2,
    getPosition() { return this.position; },
    getRadius() { return this.radius; },
  }];
  const bulletPool = {
    forEachActive(fn) { fn({ position: { x: 0, y: 0, z: 0 } }, 0); },
  };
  // Omit param
  assert.equal(findBulletHits({ asteroids, bullets: bulletPool }).length, 1);
  // Explicit undefined
  assert.equal(findBulletHits({ asteroids, bullets: bulletPool, spatialHash: undefined }).length, 1);
  // Explicit null
  assert.equal(findBulletHits({ asteroids, bullets: bulletPool, spatialHash: null }).length, 1);
  // Empty hash (no candidates)
  const emptyHash = createSpatialHash({ cellSize: 16 });
  assert.equal(findBulletHits({ asteroids, bullets: bulletPool, spatialHash: emptyHash }).length, 0);
});

// ---- findBulletShipHits (v0.60.0 — pirate combat loop) -----------------

/**
 * Build a fake ship with the live-property duck typing the AI ships
 * use (`.position` is an object ref, not a `getPosition()` method).
 */
function fakeShip(x, z) {
  return { position: { x, y: 0, z } };
}

test('findBulletShipHits: empty lists → no hits', () => {
  assert.deepEqual(findBulletShipHits({ bullets: fakeBulletPool([]), ships: [] }), []);
});

test('findBulletShipHits: bullet inside ship → hit', () => {
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const ships = [fakeShip(0, 0)];
  const hits = findBulletShipHits({ bullets, ships });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bulletIndex, 0);
  assert.equal(hits[0].shipIndex, 0);
});

test('findBulletShipHits: bullet far from ship → no hit', () => {
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const ships = [fakeShip(100, 0)];
  assert.deepEqual(findBulletShipHits({ bullets, ships }), []);
});

test('findBulletShipHits: one bullet hits first matching ship only', () => {
  // Bullet at origin; ship 0 at (1,0,0) (hit) + ship 1 at (-1,0,0) (also hit).
  // Bullet should report ship 0 (first in iteration order).
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const ships = [fakeShip(1, 0), fakeShip(-1, 0)];
  const hits = findBulletShipHits({ bullets, ships });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].shipIndex, 0);
});

test('findBulletShipHits: multiple bullets → multiple ship hits', () => {
  const bullets = fakeBulletPool([
    fakeBullet(0, 0, 0),
    fakeBullet(50, 0, 0),
  ]);
  const ships = [fakeShip(0, 0), fakeShip(50, 0)];
  const hits = findBulletShipHits({ bullets, ships });
  assert.equal(hits.length, 2);
});

test('findBulletShipHits: ships with null position are skipped (dead pirates)', () => {
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const ships = [
    { position: null }, // dead pirate (disposed but still in array)
    fakeShip(0, 0),     // live player
  ];
  const hits = findBulletShipHits({ bullets, ships });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].shipIndex, 1);
});

test('findBulletShipHits: ships with non-finite position are skipped', () => {
  const bullets = fakeBulletPool([fakeBullet(0, 0, 0)]);
  const ships = [
    { position: { x: NaN, z: 0 } },
    fakeShip(0, 0),
  ];
  const hits = findBulletShipHits({ bullets, ships });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].shipIndex, 1);
});

test('findBulletShipHits: missing args → empty list, no throw', () => {
  assert.deepEqual(findBulletShipHits({}), []);
  assert.deepEqual(findBulletShipHits({ bullets: fakeBulletPool([]) }), []);
  assert.deepEqual(findBulletShipHits({ ships: [] }), []);
});

test('findBulletShipHits: swept-sphere catches fast bullet passing through ship', () => {
  // Bullet at (-2,0,0) with velocity (-500,0,0); ship at origin.
  // Default SHIP_RADIUS=3.0 (v0.42.x bumped from 1.4 to match the 3x
  // scaled visual mesh), so the discrete check at (-2,0,0) would
  // HIT (sum=3.15 > 2). Use shipRadius=0.5 override to isolate the
  // swept-sphere logic from the radius-based discrete match.
  // Without dt: bullet at (-2,0,0), ship r=0.5, sum=0.65 → miss.
  const ships = [fakeShip(0, 0)];
  const b = {
    position: { x: -2, y: 0, z: 0 },
    velocity: { x: -500, y: 0, z: 0 },
  };
  const bullets = { forEachActive(fn) { fn(b, 0); } };
  assert.deepEqual(findBulletShipHits({ bullets, ships, shipRadius: 0.5 }), []);
  // With dt=0.02: previous pos = (8,0,0). Path passes through origin.
  // Distance from origin to segment = 0 < 0.5 + 0.15 = 0.65 → hit.
  const hits = findBulletShipHits({ bullets, ships, shipRadius: 0.5, dt: 0.02 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bulletIndex, 0);
  assert.equal(hits[0].shipIndex, 0);
});
