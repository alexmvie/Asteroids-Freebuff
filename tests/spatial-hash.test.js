/**
 * Unit tests for src/systems/spatial-hash.js.
 *
 * Pure logic only — no Three.js, no DOM. The hash is exercised through
 * mock entities that satisfy the duck-typed `entity.position.x/.z` API.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpatialHash } from '../src/systems/spatial-hash.js';

// ---- Helpers ------------------------------------------------------------

/**
 * Build a mock entity at (x, z) with an optional index. Position is
 * stored on `.position` so the hash's `x = entity.position.x` walk
 * works without any adapter shim.
 * @param {number} x
 * @param {number} z
 * @param {number} [index]
 */
function fakeEntity(x, z, index = 0) {
  return { position: { x, y: 0, z }, index };
}

// ---- Constructor invariants --------------------------------------------

test('createSpatialHash: requires cellSize > 0', () => {
  assert.throws(() => createSpatialHash({ cellSize: 0 }));
  assert.throws(() => createSpatialHash({ cellSize: -1 }));
  assert.throws(() => createSpatialHash({ cellSize: NaN }));
  assert.throws(() => createSpatialHash({ cellSize: Infinity }));
  assert.throws(() => createSpatialHash({}));
});

test('createSpatialHash: accepts positive finite cellSize', () => {
  assert.doesNotThrow(() => createSpatialHash({ cellSize: 16 }));
  assert.doesNotThrow(() => createSpatialHash({ cellSize: 0.5 }));
  assert.doesNotThrow(() => createSpatialHash({ cellSize: 1e6 }));
});

test('createSpatialHash: empty on construction', () => {
  const h = createSpatialHash({ cellSize: 16 });
  const s = h.getStats();
  assert.equal(s.entities, 0);
  assert.equal(s.cells, 0);
  assert.equal(s.cellSize, 16);
});

// ---- getStats ----------------------------------------------------------

test('getStats: reflects insertions exactly', () => {
  const h = createSpatialHash({ cellSize: 16 });
  // Three entities, each at least 16u (one full cell) apart on
  // every axis, so they fall into three distinct cells.
  //   (0,0)       → cell (0,0)
  //   (24, 0)     → 24/16 = 1.5 → cell (1, 0)
  //   (-24, -24)  → -24/16 = -1.5 → floor -2 → cell (-2, -2)
  h.insert(fakeEntity(0, 0, 0));
  h.insert(fakeEntity(24, 0, 1));
  h.insert(fakeEntity(-24, -24, 2));
  const s = h.getStats();
  assert.equal(s.entities, 3);
  assert.equal(s.cells, 3);
});

test('getStats: reflects entities co-located in the same cell', () => {
  const h = createSpatialHash({ cellSize: 16 });
  // All three strictly inside cell (0,0): x and z each in [0, 15].
  // floor(0 / 16) = 0; floor(15 / 16) = 0; floor(15.999 / 16) = 0.
  h.insert(fakeEntity(0, 0, 0));
  h.insert(fakeEntity(8, 8, 1));
  h.insert(fakeEntity(5, 12, 2));
  const s = h.getStats();
  assert.equal(s.entities, 3);
  assert.equal(s.cells, 1);
});

// ---- insert ------------------------------------------------------------

test('insert: explicit -1 wins over entity.index', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(fakeEntity(0, 0, 5), -1);
  const candidates = h.queryCandidates(0, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, -1);
});

test('insert: index inferred from entity.index when no second arg', () => {
  // The `insert(entity)` overload reads the entity's `.index` field
  // when present. This is the path used by `rebuild(getIndex)` —
  // if the source array already carries stable indices, the caller
  // can let insert pick them up implicitly.
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(fakeEntity(0, 0, 42));
  const candidates = h.queryCandidates(0, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, 42);
});

test('insert: defaults to -1 when no second arg AND no entity.index', () => {
  // Pure entity (no `.index` field) gets the -1 fallback. Useful for
  // transient singletons (a powerup, a one-shot laser origin) where
  // array indexing doesn't apply.
  const h = createSpatialHash({ cellSize: 16 });
  h.insert({ position: { x: 0, y: 0, z: 0 } });
  const candidates = h.queryCandidates(0, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, -1);
  assert.deepEqual(candidates[0].entity.position, { x: 0, y: 0, z: 0 });
});

test('insert: entity with missing position is silently skipped', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(null);
  h.insert(undefined);
  h.insert({});
  h.insert({ position: null });
  h.insert({ position: undefined });
  assert.equal(h.getStats().entities, 0);
});

test('insert: entity with non-finite position is silently skipped', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.insert({ position: { x: NaN, z: 0 } });
  h.insert({ position: { x: 0, z: Infinity } });
  h.insert({ position: { x: -Infinity, z: 0 } });
  assert.equal(h.getStats().entities, 0);
});

test('insert: 300 sequential inserts in a sparse field produce 300 cells', () => {
  const h = createSpatialHash({ cellSize: 16 });
  for (let i = 0; i < 300; i++) {
    // Spread across a 1000u × 1000u area → each in its own cell.
    const x = (i % 30) * 40 + 5;
    const z = Math.floor(i / 30) * 40 + 5;
    h.insert(fakeEntity(x, z, i));
  }
  const s = h.getStats();
  assert.equal(s.entities, 300);
  assert.equal(s.cells, 300);
});

// ---- rebuild -----------------------------------------------------------

test('rebuild: empty + populated arrays', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.rebuild([]);
  assert.equal(h.getStats().entities, 0);

  const arr = [fakeEntity(0, 0, 0), fakeEntity(1, 1, 1), fakeEntity(2, 2, 2)];
  h.rebuild(arr);
  assert.equal(h.getStats().entities, 3);
});

test('rebuild: default indexer uses 0..N-1', () => {
  const h = createSpatialHash({ cellSize: 16 });
  const arr = [fakeEntity(0, 0), fakeEntity(1, 1), fakeEntity(2, 2)];
  h.rebuild(arr);
  const out = h.queryCandidates(0, 0);
  assert.equal(out.length, 3);
  // Every entry's index should be the position-in-array it had.
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].index, i);
  }
});

test('rebuild: custom indexer takes precedence over default', () => {
  const h = createSpatialHash({ cellSize: 16 });
  const arr = [fakeEntity(0, 0, 99), fakeEntity(1, 1, 42), fakeEntity(2, 2, 7)];
  // Custom indexer returns the entity's stored `.index` field,
  // not the array position. This is the pattern used by the
  // caller when the source array gets spliced mid-frame.
  h.rebuild(arr, (e) => e.index);
  const out = h.queryCandidates(0, 0);
  assert.equal(out.length, 3);
  const indices = out.map((c) => c.index).sort((a, b) => a - b);
  assert.deepEqual(indices, [7, 42, 99]);
});

test('rebuild: clears the previous hash before re-inserting', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.rebuild([fakeEntity(0, 0), fakeEntity(1, 1), fakeEntity(2, 2), fakeEntity(3, 3)]);
  assert.equal(h.getStats().entities, 4);

  // Rebuild from a smaller array. The count should be the NEW count,
  // not the cumulative sum — otherwise stale entries would spam candidates.
  h.rebuild([fakeEntity(0, 0)]);
  assert.equal(h.getStats().entities, 1);
});

test('rebuild: null/undefined arrays are a no-op (clears)', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.rebuild([fakeEntity(0, 0), fakeEntity(1, 1)]);
  assert.equal(h.getStats().entities, 2);
  h.rebuild(null);
  assert.equal(h.getStats().entities, 0);
  h.rebuild(undefined);
  assert.equal(h.getStats().entities, 0);
});

// ---- clear -------------------------------------------------------------

test('clear: empties the hash', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(fakeEntity(0, 0));
  h.insert(fakeEntity(5, 5));
  assert.equal(h.getStats().entities, 2);
  h.clear();
  assert.equal(h.getStats().entities, 0);
  assert.equal(h.getStats().cells, 0);
  // Queries on a cleared hash return [].
  assert.deepEqual(h.queryCandidates(0, 0), []);
});

// ---- queryCandidates: correctness -------------------------------------

test('queryCandidates: empty hash returns []', () => {
  const h = createSpatialHash({ cellSize: 16 });
  assert.deepEqual(h.queryCandidates(0, 0), []);
  assert.deepEqual(h.queryCandidates(100, -50), []);
});

test('queryCandidates: 3x3 neighborhood finds co-located entities', () => {
  const h = createSpatialHash({ cellSize: 16 });
  // Entities in the 3x3 neighborhood around (0, 0) cell:
  const near = [
    fakeEntity(0, 0, 0),
    fakeEntity(7, 7, 1),              // same cell (0,0)
    fakeEntity(15.5, -0.5, 2),        // cell (0,-1) → neighbor
    fakeEntity(-15.5, 0, 3),          // cell (-1,0) → neighbor
    fakeEntity(0.1, 15.5, 4),         // cell (0,1) → neighbor
  ];
  const farAway = [
    fakeEntity(40, 40, 5),            // cell (2,2) → NOT in 3x3
    fakeEntity(-50, -50, 6),          // cell (-3,-3) → NOT in 3x3
  ];
  for (const e of near) h.insert(e);
  for (const e of farAway) h.insert(e);

  const out = h.queryCandidates(0, 0);
  // Only the 5 near entities should be returned.
  assert.equal(out.length, 5);
  const indices = out.map((c) => c.index).sort((a, b) => a - b);
  assert.deepEqual(indices, [0, 1, 2, 3, 4]);
});

test('queryCandidates: 3x3 corner diagonal reaches sqrt(2) * cellSize', () => {
  // cellSize = 100. Entities in the 4 nearest-corner cells.
  // Place an entity at the FAR diagonal corner of the 3x3 (cell (1,1),
  // with center 100u away from the query cell). The query at (0,0)
  // must find it.
  const h = createSpatialHash({ cellSize: 100 });
  // Place entity in cell (1,1) → 3x3 of (0,0) finds it.
  h.insert(fakeEntity(110, 110, 7));
  const out = h.queryCandidates(0, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 7);
});

test('queryCandidates: handles negative coordinates with floor rounding', () => {
  const h = createSpatialHash({ cellSize: 16 });
  // -0.5 / 16 = -0.03125, floor(-0.03125) = -1 (correct).
  h.insert(fakeEntity(-0.5, -0.5, 0));
  // Query at origin's cell (0,0) → 3x3 covers (-1,-1) to (1,1).
  // Entity's cell is (-1,-1), which IS in the 3x3.
  const out = h.queryCandidates(0, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 0);
});

test('queryCandidates: very-large negative coordinate is still bucketed', () => {
  const h = createSpatialHash({ cellSize: 16 });
  // (-1e6, -1e6) — Math.floor(-62500) = -62500 → cell key "-62500,-62500".
  h.insert(fakeEntity(-1e6, -1e6, 0));
  // Query at same position → finds it.
  const out = h.queryCandidates(-1e6, -1e6);
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 0);
  // Query 100u away → still in 3x3.
  assert.equal(h.queryCandidates(-1e6 + 20, -1e6 + 20).length, 1);
  // Query ~50 cells away → empty.
  assert.equal(h.queryCandidates(-1e6 + 1000, -1e6 + 1000).length, 0);
});

test('queryCandidates: returns no duplicates', () => {
  // Verify by inserting the same cell-3x3-membership set twice
  // through rebuild and insuring the result of queryCandidates
  // for a single 3x3 neighborhood does not return any entity
  // twice. (This is the contract the narrow-phase relies on.)
  const h = createSpatialHash({ cellSize: 16 });
  const arr = [
    fakeEntity(0, 0, 0),
    fakeEntity(0.5, 0, 1),
    fakeEntity(0, 0.5, 2),
  ];
  h.rebuild(arr);
  const out = h.queryCandidates(0, 0);
  // All 3 should be returned exactly once.
  assert.equal(out.length, 3);
  const seen = new Set();
  for (const c of out) {
    assert.ok(!seen.has(c.index), `duplicate index ${c.index}`);
    seen.add(c.index);
  }
});

test('queryCandidates: returns candidates in cell-iteration order', () => {
  // Pinning iteration order: the 3x3 scan walks ox=-1..+1 (outer)
  // and oz=-1..+1 (inner), so it visits cells in row-major order
  // starting at (cx-1, cz-1). Empty cells are skipped; populated
  // cells emit their entries in insertion order.
  //
  // Layout: query is at (500, 500) → cell (5, 5). The 3x3 covers
  // cells (4,4) to (6,6). We place 4 entities, each in a different
  // populated cell, so the iteration order is unambiguous.
  //
  //   tl at (450, 450)  → cell (4, 4)
  //   c1 at (490, 520)  → cell (4, 5)  (NEIGHBOR cell, scanned BEFORE (5,5))
  //   c0 at (510, 510)  → cell (5, 5)
  //   br at (560, 560)  → cell (5, 5)
  //
  // Per row-major scan (ox, oz): (4,4) → (4,5) → (5,5). Cell (4,6),
  // (5,4), etc. are empty and skipped.
  const h = createSpatialHash({ cellSize: 100 });
  const tl = fakeEntity(450, 450, 1);   // cell (4, 4) → upper-LEFT in scan
  const c0 = fakeEntity(510, 510, 2);   // cell (5, 5) → center cell
  const c1 = fakeEntity(490, 520, 3);   // cell (4, 5) → upper-MID (between)
  const br = fakeEntity(560, 560, 4);   // cell (5, 5) → center cell (after c0)
  // Insert order is irrelevant — scan order is what matters.
  h.insert(tl);
  h.insert(c0);
  h.insert(c1);
  h.insert(br);
  const out = h.queryCandidates(500, 500);
  assert.equal(out.length, 4);
  // Expected scan output: tl (4,4), c1 (4,5), c0 (5,5), br (5,5).
  assert.deepEqual(out.map((c) => c.index), [1, 3, 2, 4]);
});

test('queryCandidates: query outside world bounds still works', () => {
  // Sanity: querying far from any entity returns [].
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(fakeEntity(0, 0, 0));
  assert.equal(h.queryCandidates(1e9, 1e9).length, 0);
  assert.equal(h.queryCandidates(-1e9, -1e9).length, 0);
});

test('queryCandidates: non-finite query returns []', () => {
  const h = createSpatialHash({ cellSize: 16 });
  h.insert(fakeEntity(0, 0, 0));
  assert.deepEqual(h.queryCandidates(NaN, 0), []);
  assert.deepEqual(h.queryCandidates(0, Infinity), []);
  assert.deepEqual(h.queryCandidates(-Infinity, 0), []);
});

// ---- Parity with O(N²) -------------------------------------------------

test('parity: queryCandidates → narrow-phase finds same hits as full scan', () => {
  // The whole point of the spatial hash is to FIND every collision
  // pair the O(N²) sweep would — never drop a pair. This is the
  // critical correctness contract, so it gets a dedicated test
  // with a realistic asteroid/bullet layout.
  //
  // We use fake asteroids with `.getPosition` + `.getRadius` (the
  // duck-typed API the narrow-phase expects) and fake bullets with
  // live `.position` refs (the bullet pool API). Manually run the
  // narrow-phase over both (a) the full asteroids array and
  // (b) the candidates from the spatial hash; assert the same hits.

  // --- Setup ----------------------------------------------------------
  const entities = [];
  for (let i = 0; i < 50; i++) {
    // Spread evenly across a 200u × 200u field, varying radii.
    const x = (i % 10) * 22 + 1;
    const z = Math.floor(i / 10) * 22 + 1;
    const r = 1 + (i % 3); // 1, 2, or 3
    entities.push({
      position: { x, y: 0, z },
      radius: r,
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }
  const bullets = [
    { position: { x: 1, y: 0, z: 1 }, index: 0 },       // inside position 0
    { position: { x: 100, y: 0, z: 100 }, index: 1 },   // far from everything
    { position: { x: 23, y: 0, z: 23 }, index: 2 },     // inside position 1
  ];
  const BULLET_RADIUS = 0.15;

  function spheresOverlap(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const sum = a.r + b.r;
    return dx * dx + dy * dy + dz * dz < sum * sum;
  }

  function fullSweepHits() {
    const out = [];
    for (let bi = 0; bi < bullets.length; bi++) {
      const bp = bullets[bi].position;
      let found = -1;
      for (let i = 0; i < entities.length; i++) {
        const a = entities[i];
        if (spheresOverlap(
          { x: bp.x, y: bp.y, z: bp.z, r: BULLET_RADIUS },
          { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
        )) {
          found = i;
          break;
        }
      }
      if (found >= 0) out.push({ bullet: bi, asteroid: found });
    }
    // Stable sort to dedupe the deterministic "first match wins" contract.
    out.sort((a, b) => a.bullet - b.bullet || a.asteroid - b.asteroid);
    return out;
  }

  function hashSweepHits() {
    const h = createSpatialHash({ cellSize: 16 });
    h.rebuild(entities);
    const out = [];
    for (const b of bullets) {
      const candidates = h.queryCandidates(b.position.x, b.position.z);
      let foundIdx = -1;
      for (const c of candidates) {
        const a = entities[c.index];
        if (spheresOverlap(
          { x: b.position.x, y: 0, z: b.position.z, r: BULLET_RADIUS },
          { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
        )) {
          foundIdx = c.index;
          break;
        }
      }
      if (foundIdx >= 0) out.push({ bullet: b.index, asteroid: foundIdx });
    }
    out.sort((a, b) => a.bullet - b.bullet || a.asteroid - b.asteroid);
    return out;
  }

  const full = fullSweepHits();
  const hash = hashSweepHits();
  assert.deepEqual(hash, full);
});

test('parity: 200 asteroids, 10 bullets — hash finds the same hits as O(N²)', () => {
  // A larger randomized layout. Same outcome as the previous test
  // but with density that exercises the multi-cell bucket path.
  const rng = (() => {
    let s = 0xc0ffee;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  })();

  const entities = [];
  for (let i = 0; i < 200; i++) {
    entities.push({
      position: { x: rng() * 1000 - 500, y: 0, z: rng() * 1000 - 500 },
      radius: 1 + rng() * 4, // 1u → 5u
      getPosition() { return this.position; },
      getRadius() { return this.radius; },
    });
  }
  const bullets = [];
  for (let i = 0; i < 10; i++) {
    bullets.push({
      position: { x: rng() * 1000 - 500, y: 0, z: rng() * 1000 - 500 },
      index: i,
    });
  }
  const BULLET_RADIUS = 0.15;

  function spheresOverlap(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const sum = a.r + b.r;
    return dx * dx + dy * dy + dz * dz < sum * sum;
  }

  const full = [];
  for (const b of bullets) {
    let found = -1;
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      if (spheresOverlap(
        { x: b.position.x, y: 0, z: b.position.z, r: BULLET_RADIUS },
        { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
      )) { found = i; break; }
    }
    if (found >= 0) full.push({ bullet: b.index, asteroid: found });
  }
  full.sort((a, b) => a.bullet - b.bullet || a.asteroid - b.asteroid);

  const h = createSpatialHash({ cellSize: 16 });
  h.rebuild(entities);
  const hash = [];
  for (const b of bullets) {
    const candidates = h.queryCandidates(b.position.x, b.position.z);
    let found = -1;
    for (const c of candidates) {
      const a = entities[c.index];
      if (spheresOverlap(
        { x: b.position.x, y: 0, z: b.position.z, r: BULLET_RADIUS },
        { x: a.position.x, y: a.position.y, z: a.position.z, r: a.radius },
      )) { found = c.index; break; }
    }
    if (found >= 0) hash.push({ bullet: b.index, asteroid: found });
  }
  hash.sort((a, b) => a.bullet - b.bullet || a.asteroid - b.asteroid);

  assert.deepEqual(hash, full);
});
