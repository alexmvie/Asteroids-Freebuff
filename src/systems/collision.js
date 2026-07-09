/**
 * Narrow-phase collision — sphere-sphere overlap tests for ship↔asteroid
 * and bullet↔asteroid. Pure: no Three.js, no DOM, no allocations in the
 * hot path. The caller (main.js) handles the side effects of a hit
 * (despawning bullets, splitting asteroids, scoring, lives, game over).
 *
 * Conventions:
 *   - All positions are {x, y, z}.
 *   - All radii are scalar.
 *   - "Hit" means the spheres overlap (center distance < sum of radii).
 *   - A bullet can only hit one asteroid per frame (we break out of the
 *     inner loop on the first hit) but an asteroid can be hit by multiple
 *     bullets per frame (we keep iterating bullets). The caller is
 *     responsible for de-duplicating asteroid removals.
 *
 * @module collision
 */

// ---- Tunables (inline; extract later) -----------------------------------

/** Bullet collision radius (matches BULLET_RADIUS in src/entities/bullet.js). */
export const BULLET_RADIUS = 0.15;

/** Ship collision radius (approximate bounding sphere of the ship mesh).
 * Increased from 1.4 to 2.0 in v0.40.x to better match the 3x-scaled
 * visual mesh (the ship body cone has radius 1.0 at the base × 3 =
 * ~3 units wide; 2.0 covers most of the body while still allowing
 * the pointed nose / tail to overlap slightly without feeling unfair).
 * The previous 1.4 was too tight for the 3x-scaled ship, causing
 * visible overlaps without collision detection. */
export const SHIP_RADIUS = 2.0;

/** Score table by asteroid size (classic Asteroids convention). */
export const SCORE_BY_SIZE = Object.freeze({
  0: 20, // large
  1: 50, // medium
  2: 100, // small
});

// ---- Pure geometry ------------------------------------------------------

/**
 * Sphere-sphere overlap test. Returns true if the two spheres intersect.
 * Squared-distance compare avoids a Math.sqrt.
 *
 * @param {{x:number,y:number,z:number,r:number}} a
 * @param {{x:number,y:number,z:number,r:number}} b
 * @returns {boolean}
 */
export function spheresOverlap(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const r = a.r + b.r;
  return dx * dx + dy * dy + dz * dz < r * r;
}

// ---- Bullet ↔ asteroid --------------------------------------------------

/**
 * Find all bullet↔asteroid collisions in the current frame.
 *
 * Returns an array of `{ bulletIndex, asteroidIndex }` pairs. Each bullet
 * contributes at most one pair (we break on the first asteroid hit), but
 * the same asteroid may appear in multiple pairs if multiple bullets hit
 * it on the same frame — the caller is expected to de-dup with a `Set`.
 *
 * @param {{
 *   asteroids: Array<{ getPosition: () => {x:number,y:number,z:number}, getRadius: () => number }>,
 *   bullets: { forEachActive: (fn: (b: any, i: number) => void) => void },
 *   bulletRadius?: number,
 * }} opts
 * @returns {Array<{ bulletIndex: number, asteroidIndex: number }>}
 */
export function findBulletHits({ asteroids, bullets, bulletRadius = BULLET_RADIUS } = {}) {
  if (!asteroids || !bullets) return [];
  const hits = [];
  bullets.forEachActive((b, bulletIndex) => {
    const bp = b.position;
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      const ap = a.getPosition();
      if (spheresOverlap(
        { x: bp.x, y: bp.y, z: bp.z, r: bulletRadius },
        { x: ap.x, y: ap.y, z: ap.z, r: a.getRadius() },
      )) {
        hits.push({ bulletIndex, asteroidIndex: i });
        break; // one bullet → one asteroid
      }
    }
  });
  return hits;
}

// ---- Asteroid ↔ asteroid (push apart + elastic bounce) -----------------

/**
 * Find all overlapping asteroid-asteroid pairs. O(n²) in the number of
 * asteroids — acceptable for ~300 asteroids (~45K checks at <0.1ms).
 * Each pair is reported once (i < j).
 *
 * @param {Array<{getPosition: () => {x:number,y:number,z:number}, getRadius: () => number}>} asteroids
 * @returns {Array<{i:number, j:number}>}
 */
export function findAsteroidPairs(asteroids) {
  if (!asteroids || asteroids.length < 2) return [];
  const pairs = [];
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    const ap = a.getPosition();
    const ar = a.getRadius();
    for (let j = i + 1; j < asteroids.length; j++) {
      const b = asteroids[j];
      if (spheresOverlap(
        { x: ap.x, y: ap.y, z: ap.z, r: ar },
        { x: b.getPosition().x, y: b.getPosition().y, z: b.getPosition().z, r: b.getRadius() },
      )) {
        pairs.push({ i, j });
      }
    }
  }
  return pairs;
}

/**
 * Resolve an asteroid-asteroid collision: separate overlapping spheres
 * (push apart equally) and exchange velocity components along the
 * collision normal (mass-weighted elastic bounce with restitution 0.5).
 *
 * @param {{
 *   getPosition: () => {x:number,y:number,z:number},
 *   getRadius: () => number,
 *   getVelocity: () => {x:number,z:number},
 *   setVelocity: (vx:number, vz:number) => void,
 * }} a
 * @param {{
 *   getPosition: () => {x:number,y:number,z:number},
 *   getRadius: () => number,
 *   getVelocity: () => {x:number,z:number},
 *   setVelocity: (vx:number, vz:number) => void,
 * }} b
 */
export function resolveAsteroidCollision(a, b) {
  const ap = a.getPosition();
  const bp = b.getPosition();
  const ar = a.getRadius();
  const br = b.getRadius();

  const dx = bp.x - ap.x;
  const dz = bp.z - ap.z;
  const dist = Math.hypot(dx, dz);
  const minDist = ar + br;

  if (dist >= minDist || dist < 0.001) return;

  // Normalised direction from A to B
  const nx = dx / dist;
  const nz = dz / dist;

  // Separate: push both apart equally (mass-weighted)
  const massA = ar * ar * ar;
  const massB = br * br * br;
  const totalMass = massA + massB;
  const overlap = minDist - dist;
  const pushA = overlap * (massB / totalMass);
  const pushB = overlap * (massA / totalMass);
  ap.x -= nx * pushA;
  ap.z -= nz * pushA;
  bp.x += nx * pushB;
  bp.z += nz * pushB;

  // Mass-weighted elastic bounce along collision normal (restitution 0.5)
  const av = a.getVelocity();
  const bv = b.getVelocity();
  const relVn = (bv.x - av.x) * nx + (bv.z - av.z) * nz;
  if (relVn > 0) return; // already separating

  const restitution = 0.5;
  const impulse = -(1 + restitution) * relVn / totalMass;

  a.setVelocity(
    av.x - impulse * massB * nx,
    av.z - impulse * massB * nz,
  );
  b.setVelocity(
    bv.x + impulse * massA * nx,
    bv.z + impulse * massA * nz,
  );
}

// ---- Asteroid ↔ powerup (push powerup out of asteroid) ------------------

/**
 * Find the first asteroid that overlaps a power-up. Returns the asteroid
 * index, or -1 if no overlap.
 *
 * @param {{
 *   asteroids: Array<{getPosition: () => {x:number,y:number,z:number}, getRadius: () => number}>,
 *   powerup: { getPosition: () => {x:number,y:number,z:number}, getRadius: () => number },
 * }} opts
 * @returns {number} asteroid index, or -1
 */
export function findAsteroidPowerupIndex({ asteroids, powerup } = {}) {
  if (!asteroids || !powerup) return -1;
  const pp = powerup.getPosition();
  const pr = powerup.getRadius();
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    const ap = a.getPosition();
    if (spheresOverlap(
      { x: ap.x, y: ap.y, z: ap.z, r: a.getRadius() },
      { x: pp.x, y: pp.y, z: pp.z, r: pr },
    )) {
      return i;
    }
  }
  return -1;
}

/**
 * Resolve an asteroid-powerup collision: push the power-up outside the
 * asteroid and give it a velocity kick away from the asteroid surface.
 *
 * @param {{
 *   getPosition: () => {x:number,y:number,z:number},
 *   getRadius: () => number,
 * }} asteroid
 * @param {{
 *   getPosition: () => {x:number,y:number,z:number},
 *   pushAway: (vx:number, vz:number) => void,
 * }} powerup
 */
export function resolveAsteroidPowerupCollision(asteroid, powerup) {
  if (!asteroid || !powerup) return;
  const ap = asteroid.getPosition();
  const pp = powerup.getPosition();
  const ar = asteroid.getRadius();
  const pr = powerup.getRadius();

  const dx = pp.x - ap.x;
  const dz = pp.z - ap.z;
  const dist = Math.hypot(dx, dz);
  const minDist = ar + pr;

  if (dist >= minDist || dist < 0.001) return;

  // Normalised direction from asteroid to powerup
  const nx = dx / dist;
  const nz = dz / dist;

  // Push powerup out of the asteroid with a small buffer
  const overlap = minDist - dist;
  pp.x += nx * (overlap + 0.5);
  pp.z += nz * (overlap + 0.5);

  // Kick the powerup away (stronger for deeper overlaps)
  const kickStrength = 8 + overlap * 3;
  powerup.pushAway(nx * kickStrength, nz * kickStrength);
}

// ---- Ship ↔ asteroid ---------------------------------------------------

/**
 * Find the first asteroid that hits the ship. Returns the asteroid index
 * in the provided list, or -1 if no collision. (Only the first is
 * returned because the ship dies and is reset on any hit — there is no
 * "damage threshold" in the MVP.)
 *
 * @param {{
 *   ship: { position: {x:number,y:number,z:number} },
 *   asteroids: Array<{ getPosition: () => {x:number,y:number,z:number}, getRadius: () => number }>,
 *   shipRadius?: number,
 * }} opts
 * @returns {number} asteroid index, or -1
 */
export function findShipHit({ ship, asteroids, shipRadius = SHIP_RADIUS } = {}) {
  if (!ship || !asteroids) return -1;
  const sp = ship.position;
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    const ap = a.getPosition();
    if (spheresOverlap(
      { x: sp.x, y: sp.y, z: sp.z, r: shipRadius },
      { x: ap.x, y: ap.y, z: ap.z, r: a.getRadius() },
    )) {
      return i;
    }
  }
  return -1;
}

/**
 * Score awarded for destroying an asteroid of a given size.
 * Unknown sizes return 0.
 * @param {number} size  0 (large), 1 (medium), 2 (small)
 * @returns {number}
 */
export function scoreForSize(size) {
  return SCORE_BY_SIZE[size] || 0;
}
