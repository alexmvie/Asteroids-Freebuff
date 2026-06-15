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
} from '../src/systems/collision.js';

// ---- Helpers ------------------------------------------------------------

/**
 * Build a fake asteroid with the duck-typed API collision.js expects.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} r
 */
function fakeAsteroid(x, y, z, r) {
  return {
    getPosition: () => ({ x, y, z }),
    getRadius: () => r,
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

// ---- Constants sanity ---------------------------------------------------

test('BULLET_RADIUS and SHIP_RADIUS are positive scalars', () => {
  assert.ok(typeof BULLET_RADIUS === 'number' && BULLET_RADIUS > 0);
  assert.ok(typeof SHIP_RADIUS === 'number' && SHIP_RADIUS > 0);
});
