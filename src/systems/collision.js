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

/** Ship collision radius (approximate bounding sphere of the ship mesh). */
export const SHIP_RADIUS = 1.4;

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
