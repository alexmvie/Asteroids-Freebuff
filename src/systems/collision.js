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
 * Increased to 3.0 in v0.42.x to match the 3x-scaled visual mesh
 * (the ship body cone has radius 1.0 at the base × 3 = ~3 units
 * wide; the full wingspan is ~6 units). The previous 2.0 was still
 * too tight, causing the visual wings and nose to overlap asteroids
 * without registering hits. */
export const SHIP_RADIUS = 3.0;

/**
 * Score table by asteroid size (classic Asteroids convention + the
 * v0.71.0 HUGE apex tier). Mirrors `ASTEROID_SCORE_BY_SIZE` in
 * `src/world/chunk-constants.js` — kept in sync manually so the
 * collision layer (UI/feedback concern) doesn't have to import
 * from the world data-model layer for what is essentially a
 * presentation table.
 *
 *   - 0 = large:  20 pts
 *   - 1 = medium: 50 pts
 *   - 2 = small:  100 pts
 *   - 3 = huge:   200 pts  (v0.71.0 — 2× small reward for the rare
 *                           apex kill; balances the rarity with
 *                           a meaningful payoff)
 */
export const SCORE_BY_SIZE = Object.freeze({
  0: 20,   // large
  1: 50,   // medium
  2: 100,  // small
  3: 200,  // huge (v0.71.0)
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
 * Squared distance from a point to a line segment in 2D (XZ plane).
 * Used for swept-sphere bullet collision so fast bullets don't tunnel
 * through small asteroids between frames.
 *
 * @param {{x:number,z:number}} p
 * @param {{x:number,z:number}} a segment start
 * @param {{x:number,z:number}} b segment end
 * @returns {number}
 */
function distSqToSegment2D(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) {
    const ddx = p.x - a.x;
    const ddz = p.z - a.z;
    return ddx * ddx + ddz * ddz;
  }
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projZ = a.z + t * dz;
  const ddx = p.x - projX;
  const ddz = p.z - projZ;
  return ddx * ddx + ddz * ddz;
}

/**
 * Find all bullet↔asteroid collisions in the current frame.
 *
 * Returns an array of `{ bulletIndex, asteroidIndex }` pairs. Each bullet
 * contributes at most one pair (we break on the first asteroid hit), but
 * the same asteroid may appear in multiple pairs if multiple bullets hit
 * it on the same frame — the caller is expected to de-dup with a `Set`.
 *
 * v0.42.0: swept-sphere check. Fast bullets (400 u/s) can move ~6.7 units
 * per frame at 60 FPS, which is larger than small asteroids. We test the
 * segment from the bullet's previous position to its current position
 * against each asteroid's sphere in the XZ plane (the game is 2DOF on XZ).
 *
 * v0.64.x: optional `spatialHash` (from `src/systems/spatial-hash.js`).
 * When provided, the asteroid list is queried via the hash's 3x3 cell
 * neighborhood scan instead of the O(N²) sweep. The hash's
 * `queryCandidates(x, z)` returns `{ entity, index }` pairs that map
 * directly to the asteroids array. When absent, the original
 * iteration-order scan runs unchanged (every existing test still
 * passes). The hash path is picked at integration time by main.js when
 * the asteroid set is large enough (~50+ asteroids) to make the
 * broad-phase worthwhile.
 *
 * @param {{
 *   asteroids: Array<{ getPosition: () => {x:number,y:number,z:number}, getRadius: () => number }>,
 *   bullets: { forEachActive: (fn: (b: any, i: number) => void) => void },
 *   bulletRadius?: number,
 *   dt?: number,
 *   spatialHash?: { queryCandidates: (x:number, z:number) => Array<{ entity: any, index: number }> } | null,
 * }} opts
 * @returns {Array<{ bulletIndex: number, asteroidIndex: number }>}
 */
export function findBulletHits({
  asteroids,
  bullets,
  bulletRadius = BULLET_RADIUS,
  dt = 0,
  spatialHash = null,
} = {}) {
  if (!asteroids || !bullets) return [];
  const hits = [];
  bullets.forEachActive((b, bulletIndex) => {
    const bp = b.position;
    // Previous position: current - velocity * dt. If dt is missing or
    // zero, fall back to a discrete position check.
    const useSwept = dt > 0 && b.velocity;
    const prevX = useSwept ? bp.x - b.velocity.x * dt : bp.x;
    const prevZ = useSwept ? bp.z - b.velocity.z * dt : bp.z;
    const prevY = useSwept ? bp.y - b.velocity.y * dt : bp.y;
    if (spatialHash) {
      // Broad-phase via spatial hash. Skip the O(N²) scan entirely;
      // iterate only the 3x3 cell neighborhood around the bullet.
      const candidates = spatialHash.queryCandidates(bp.x, bp.z);
      for (let c = 0; c < candidates.length; c++) {
        const cand = candidates[c];
        const a = cand.entity;
        const ap = a.getPosition();
        const ar = a.getRadius();
        if (spheresOverlap(
          { x: bp.x, y: bp.y, z: bp.z, r: bulletRadius },
          { x: ap.x, y: ap.y, z: ap.z, r: ar },
        )) {
          hits.push({ bulletIndex, asteroidIndex: cand.index });
          break; // one bullet → one asteroid
        }
        if (useSwept) {
          const distSq = distSqToSegment2D(
            { x: ap.x, z: ap.z },
            { x: prevX, z: prevZ },
            { x: bp.x, z: bp.z },
          );
          const combinedR = bulletRadius + ar;
          if (distSq < combinedR * combinedR) {
            hits.push({ bulletIndex, asteroidIndex: cand.index });
            break;
          }
        }
      }
      return;
    }
    // Original O(N²) sweep — preserved for the no-hash call path.
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      const ap = a.getPosition();
      const ar = a.getRadius();
      // Discrete check first (handles slow/stationary bullets).
      if (spheresOverlap(
        { x: bp.x, y: bp.y, z: bp.z, r: bulletRadius },
        { x: ap.x, y: ap.y, z: ap.z, r: ar },
      )) {
        hits.push({ bulletIndex, asteroidIndex: i });
        break; // one bullet → one asteroid
      }
      // Swept-sphere check in XZ plane (2DOF play plane).
      if (useSwept) {
        const distSq = distSqToSegment2D(
          { x: ap.x, z: ap.z },
          { x: prevX, z: prevZ },
          { x: bp.x, z: bp.z },
        );
        const combinedR = bulletRadius + ar;
        if (distSq < combinedR * combinedR) {
          hits.push({ bulletIndex, asteroidIndex: i });
          break;
        }
      }
    }
  });
  return hits;
}

// ---- Asteroid ↔ asteroid (push apart + elastic bounce) -----------------

/**
 * Find all overlapping asteroid-asteroid pairs.
 *
 * When called with the no-options shape `(asteroids)` runs the original
 * O(n²) sweep — every existing test still passes through this path.
 * When called with `(asteroids, { spatialHash })` the function uses
 * the hash as a broad-phase: each asteroid queries its 3x3 cell
 * neighborhood and deduplicates by `j > i` so the same pair is never
 * reported twice.
 *
 * @param {Array<{getPosition: () => {x:number,y:number,z:number}, getRadius: () => number}>} asteroids
 * @param {{ spatialHash?: { queryCandidates: (x:number, z:number) => Array<{ entity: any, index: number }> } | null }} [opts]
 * @returns {Array<{i:number, j:number}>}
 */
export function findAsteroidPairs(asteroids, opts = {}) {
  if (!asteroids || asteroids.length < 2) return [];
  const spatialHash = opts.spatialHash || null;
  const pairs = [];
  if (spatialHash) {
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      const ap = a.getPosition();
      const ar = a.getRadius();
      const candidates = spatialHash.queryCandidates(ap.x, ap.z);
      for (let c = 0; c < candidates.length; c++) {
        const cand = candidates[c];
        // Skip self (cand.index === i) AND already-reported pairs
        // (cand.index < i, which means we processed B→A when we
        // reached B in the outer loop). Requires `i < j` invariant.
        if (cand.index <= i) continue;
        const b = cand.entity;
        const bp = b.getPosition();
        const br = b.getRadius();
        if (spheresOverlap(
          { x: ap.x, y: ap.y, z: ap.z, r: ar },
          { x: bp.x, y: bp.y, z: bp.z, r: br },
        )) {
          pairs.push({ i, j: cand.index });
        }
      }
    }
    return pairs;
  }
  // Original O(n²) sweep — preserved for the no-options call path. The
  // broad-phase (hash) path above is preferred for >50 asteroids; this
  // path is the opt-out default for tests and any caller that hasn't
  // built a hash yet. Documented cost: ~45K Pythagorean checks for the
  // ~300-asteroid MVP field, ~0.3ms in V8.
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
 *   spatialHash?: { queryCandidates: (x:number, z:number) => Array<{ entity: any, index: number }> } | null,
 * }} opts
 * @returns {number} asteroid index, or -1
 */
export function findAsteroidPowerupIndex({ asteroids, powerup, spatialHash = null } = {}) {
  if (!asteroids || !powerup) return -1;
  const pp = powerup.getPosition();
  const pr = powerup.getRadius();
  if (spatialHash) {
    const candidates = spatialHash.queryCandidates(pp.x, pp.z);
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c];
      const a = cand.entity;
      const ap = a.getPosition();
      if (spheresOverlap(
        { x: ap.x, y: ap.y, z: ap.z, r: a.getRadius() },
        { x: pp.x, y: pp.y, z: pp.z, r: pr },
      )) {
        return cand.index;
      }
    }
    return -1;
  }
  // Original O(n²) sweep — preserved for the no-hash call path.
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
 * v0.64.x: optional `spatialHash` for the broad-phase. Cost goes
 * from O(asteroids) to O(asteroids in 3x3 cells) — for a single ship
 * query this isn't a big win in node count, but gathers the asteroid
 * array sort + comparison cost into a single Map.get × 9 sweep (~9
 * Map lookups vs ~300 array index reads).
 *
 * @param {{
 *   ship: { position: {x:number,y:number,z:number} },
 *   asteroids: Array<{ getPosition: () => {x:number,y:number,z:number}, getRadius: () => number }>,
 *   shipRadius?: number,
 *   spatialHash?: { queryCandidates: (x:number, z:number) => Array<{ entity: any, index: number }> } | null,
 * }} opts
 * @returns {number} asteroid index, or -1
 */
export function findShipHit({ ship, asteroids, shipRadius = SHIP_RADIUS, spatialHash = null } = {}) {
  if (!ship || !asteroids) return -1;
  const sp = ship.position;
  if (spatialHash) {
    const candidates = spatialHash.queryCandidates(sp.x, sp.z);
    for (let c = 0; c < candidates.length; c++) {
      const cand = candidates[c];
      const a = cand.entity;
      const ap = a.getPosition();
      if (spheresOverlap(
        { x: sp.x, y: sp.y, z: sp.z, r: shipRadius },
        { x: ap.x, y: ap.y, z: ap.z, r: a.getRadius() },
      )) {
        return cand.index;
      }
    }
    return -1;
  }
  // Original O(n²) sweep — preserved for the no-hash call path.
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

// ---- Bullet ↔ ship (v0.60.0 — pirate combat loop) ----------------------

/**
 * Find all bullet↔ship collisions in the current frame. Sister to
 * `findBulletHits` (asteroids) but the ship targets use a live
 * `.position` object instead of an asteroid-style `getPosition()`
 * method. Same swept-sphere fast-bullet defense as `findBulletHits`.
 *
 * The returned `shipIndex` indexes into the `ships` array the caller
 * passed. One bullet can hit at most one ship per frame (we break on
 * the first hit), but the same ship can be hit by multiple bullets.
 *
 * Ships with a `null` / missing / non-finite `position` are skipped
 * (the AI factory uses this to filter dead pirates out of the
 * target list).
 *
 * v0.64.x: optional `spatialHash` for the broad-phase. The hash is
 * built from the `ships` array the caller passes; each bullet
 * queries the 3x3 cell neighborhood at its position and runs
 * narrow-phase on the (typically tiny) candidate set.
 *
 * @param {{
 *   bullets: { forEachActive: (fn: (b: any, i: number) => void) => void },
 *   ships: Array<{ position: {x:number,y:number,z:number} }>,
 *   bulletRadius?: number,
 *   shipRadius?: number,
 *   dt?: number,
 *   spatialHash?: { queryCandidates: (x:number, z:number) => Array<{ entity: any, index: number }> } | null,
 * }} opts
 * @returns {Array<{ bulletIndex: number, shipIndex: number }>}
 */
export function findBulletShipHits({
  bullets,
  ships,
  bulletRadius = BULLET_RADIUS,
  shipRadius = SHIP_RADIUS,
  dt = 0,
  spatialHash = null,
} = {}) {
  if (!bullets || !ships) return [];
  const hits = [];
  bullets.forEachActive((b, bulletIndex) => {
    const bp = b.position;
    const useSwept = dt > 0 && b.velocity;
    const prevX = useSwept ? bp.x - b.velocity.x * dt : bp.x;
    const prevZ = useSwept ? bp.z - b.velocity.z * dt : bp.z;
    if (spatialHash) {
      // Broad-phase via spatial hash over the ship set.
      const candidates = spatialHash.queryCandidates(bp.x, bp.z);
      for (let c = 0; c < candidates.length; c++) {
        const cand = candidates[c];
        const s = cand.entity;
        if (!s || !s.position) continue;
        const sp = s.position;
        if (typeof sp.x !== 'number' || typeof sp.z !== 'number') continue;
        if (spheresOverlap(
          { x: bp.x, y: bp.y, z: bp.z, r: bulletRadius },
          { x: sp.x, y: sp.y, z: sp.z, r: shipRadius },
        )) {
          hits.push({ bulletIndex, shipIndex: cand.index });
          break;
        }
        if (useSwept) {
          const distSq = distSqToSegment2D(
            { x: sp.x, z: sp.z },
            { x: prevX, z: prevZ },
            { x: bp.x, z: bp.z },
          );
          const combinedR = bulletRadius + shipRadius;
          if (distSq < combinedR * combinedR) {
            hits.push({ bulletIndex, shipIndex: cand.index });
            break;
          }
        }
      }
      return;
    }
    // Original O(n²) sweep — preserved for the no-hash call path.
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s || !s.position) continue;
      const sp = s.position;
      if (typeof sp.x !== 'number' || typeof sp.z !== 'number') continue;
      // Discrete check first (handles slow/stationary bullets).
      if (spheresOverlap(
        { x: bp.x, y: bp.y, z: bp.z, r: bulletRadius },
        { x: sp.x, y: sp.y, z: sp.z, r: shipRadius },
      )) {
        hits.push({ bulletIndex, shipIndex: i });
        break;
      }
      // Swept-sphere check in XZ plane (2DOF play plane).
      if (useSwept) {
        const distSq = distSqToSegment2D(
          { x: sp.x, z: sp.z },
          { x: prevX, z: prevZ },
          { x: bp.x, z: bp.z },
        );
        const combinedR = bulletRadius + shipRadius;
        if (distSq < combinedR * combinedR) {
          hits.push({ bulletIndex, shipIndex: i });
          break;
        }
      }
    }
  });
  return hits;
}
