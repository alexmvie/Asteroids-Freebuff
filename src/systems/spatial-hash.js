/**
 * @fileoverview Spatial hash (a.k.a. uniform spatial grid) — the broad-phase
 *   layer above the sphere/sphere narrow-phase in `src/systems/collision.js`.
 *   Pure module: no Three.js, no DOM, no `Math.random()`. Used by main.js
 *   to skip the ~21,000 per-frame narrow-phase pairs that an O(n²) asteroid
 *   scan would otherwise do against the streamed bubble field.
 *
 * ## Concept
 *
 * World positions are bucketed into a uniform 2D grid of square cells on
 * the XZ play plane (Y is unused — the game is 2DOF on XZ). Insertion is
 * O(1); querying the candidate set near a query point is O(cells per
 * neighborhood × entities per cell), typically O(1) for a sparse field.
 *
 * ## Pure object-pool friendly
 *
 * The hash is a pure data structure: it stores `Array<{entity, index}>`
 * per cell in a `Map<string, Array>`. The caller controls hashing +
 *   narrow-phase; this module only returns candidate sets.
 *
 * ## Cell size
 *
 * The caller chooses `cellSize`. Standard values for the MVP are 16u
 * (asteroids) and 8u (ships). Cells are large enough that NO entity in
 * the game spans multiple cells (max asteroid diameter is 10u, max ship
 * diameter is 6u) — single-cell insertion is correct without spanning.
 *
 * ## Query radius
 *
 * `queryCandidates(x, z)` is a 3x3 cell neighborhood scan centered on the
 * query point's cell. The diagonal corner of the 3x3 neighborhood is
 * at distance `sqrt(2) * cellSize` from the query center. For a 16u cell,
 * that's ~22.6u — sufficient to catch any pair whose combined radius is
 * ≤ cellSize (the asteroid↔asteroid worst case is 10u; covered comfortably
 * with safety margin).
 *
 * For queries that need to scan further than `sqrt(2) * cellSize`, build
 * a hash with a larger `cellSize` — the 3x3 scan pattern is fixed.
 *
 * ## Coordinate sign convention
 *
 * `Math.floor(x / cellSize)` correctly rounds negative coordinates
 * downward (e.g. `-0.1 / 16 = -0.00625 → -1`), so the hash works for
 * negative world positions out of the box. Tested explicitly.
 *
 * @module spatial-hash
 */

// ---- Cell-key encoding (private) --------------------------------------

/**
 * Encode (cx, cz) integer cell coordinates into a stable string key.
 * No padding — keys are short and stable for a given (cx, cz) pair
 * regardless of leading sign.
 *
 * String keys (not BigInt or packed bits) keep Map insertion cheap
 * and make browser DevTools dumps human-readable.
 *
 * @param {number} cx cell X
 * @param {number} cz cell Z
 * @returns {string}
 */
function encodeCellKey(cx, cz) {
  return cx + ',' + cz;
}

/**
 * Create a spatial hash backed by a uniform square grid of side
 * `cellSize` world units. The hash is empty on construction — call
 * `rebuild(entities)` or `insert(entity, index)` to populate it.
 *
 * Returned methods are pure (no closures over the world, no timers).
 * The caller drives the rebuild cadence (per render-loop tick, per
 * "spawn sweep", etc.).
 *
 * @param {{ cellSize: number }} opts
 * @returns {{
 *   insert: (entity: any, index?: number) => void,
 *   rebuild: (entities: Array<any>, getIndex?: (e:any,i:number)=>number) => void,
 *   clear: () => void,
 *   queryCandidates: (x: number, z: number) => Array<{ entity: any, index: number }>,
 *   getStats: () => { cellSize: number, cells: number, entities: number },
 * }}
 */
export function createSpatialHash({ cellSize } = {}) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error(`createSpatialHash: cellSize must be a positive finite number, got ${cellSize}`);
  }
  const cellInv = 1 / cellSize;

  /** @type {Map<string, Array<{ entity: any, index: number }>>} */
  const cells = new Map();
  let totalEntities = 0;

  function clear() {
    // Drop cell arrays to release their contents. Map.clear() alone
    // would orphan the inner arrays; while that's fine for GC, we
    // also reset the count so getStats() is honest.
    cells.clear();
    totalEntities = 0;
  }

  /**
   * Insert one entity into the hash. The caller can supply an `index`
   * — typically the entity's index in the source array — so the
   * query result carries enough information for callers to avoid
   * O(N) `indexOf` lookups during the narrow phase.
   *
   * `index` resolution order: explicit second arg wins; otherwise the
   * function reads `entity.index`; otherwise `-1` (unindexed). The
   * `-1` fallback lets callers insert transient entities without
   * bookkeeping; callers that need array-aligned indices pass them
   * explicitly (cheaper than the O(N) `indexOf` lookup they replace).
   *
   * Position is read once via `entity.position.x`/`.z` — if the entity
   * uses a getter method (asteroids), the caller should pass a
   * `getPosition` adapter by wrapping before inserting. The simplest
   * pattern is to rebuild every frame from the current array, where
   * positions are already valid.
   *
   * @param {any} entity
   * @param {number} [index]
   */
  function insert(entity, index) {
    if (typeof index !== 'number' && entity && typeof entity.index === 'number') {
      index = entity.index;
    }
    if (typeof index !== 'number') index = -1;
    if (!entity || !entity.position || typeof entity.position !== 'object') return;
    const x = entity.position.x;
    const z = entity.position.z;
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) {
      // Silently skip non-finite positions to keep a bug from
      // crashing the broad-phase. The narrow-phase will still test
      // these entities if they're reached via another path.
      return;
    }
    const cx = Math.floor(x * cellInv);
    const cz = Math.floor(z * cellInv);
    const key = encodeCellKey(cx, cz);
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push({ entity, index });
    totalEntities++;
  }

  /**
   * Bulk insert every entity in the array. The default `getIndex`
   * returns the entity's array position — the common case for a
   * freshly-read asteroids/ships array. Pass a custom getter to
   * survive array mutations (splice/pop) during the frame.
   *
   * The previous hash is cleared before re-inserting, so this is a
   * "full rebuild" — O(N) cell-membership clears + O(N) inserts.
   * At ~300 asteroids this is <0.1ms in V8's Map.clear + keyed set.
   *
   * @param {Array<any>} entities
   * @param {(entity: any, defaultIndex: number) => number} [getIndex]
   */
  function rebuild(entities, getIndex) {
    clear();
    if (!entities || entities.length === 0) return;
    const indexer = typeof getIndex === 'function' ? getIndex : (_e, i) => i;
    for (let i = 0; i < entities.length; i++) {
      insert(entities[i], indexer(entities[i], i));
    }
  }

  /**
   * Scan the 3x3 cell neighborhood centered on `(x, z)` and return
   * a flat array of cell entries (`{entity, index}`).
   *
   * NO duplicate removal, NO narrow-phase test — the caller does
   * that. The 3x3 scan is fast (~9 Map lookups) and `queryCandidates`
   * returns first-seen-wins semantics consistent with the original
   * O(N²) iteration order for short query domains.
   *
   * Empty/missing cells are skipped (no allocation).
   *
   * @param {number} x
   * @param {number} z
   * @returns {Array<{ entity: any, index: number }>}
   */
  function queryCandidates(x, z) {
    if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) {
      return [];
    }
    const cx = Math.floor(x * cellInv);
    const cz = Math.floor(z * cellInv);
    /** @type {Array<{ entity: any, index: number }>} */
    const out = [];
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bucket = cells.get(encodeCellKey(cx + ox, cz + oz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          out.push(bucket[i]);
        }
      }
    }
    return out;
  }

  /**
   * Lightweight introspection — total entities, total populated cells,
   * and the configured cellSize. Used by tests and by the per-frame
   * timing log in main.js (when `AI_DEBUG` is on).
   *
   * @returns {{ cellSize: number, cells: number, entities: number }}
   */
  function getStats() {
    return { cellSize, cells: cells.size, entities: totalEntities };
  }

  return { insert, rebuild, clear, queryCandidates, getStats };
}
