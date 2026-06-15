/**
 * Unit tests for the chunked-world data model.
 * Run with: `node --test tests/`
 *
 * These tests verify the invariants promised in SPEC.md:
 *   - Determinism: same inputs always produce the same outputs.
 *   - Ranges: density ∈ [0, 1], RNG ∈ [0, 1), hash ∈ [0, 2^32).
 *   - Generation rules: density floor, asteroid count, chunk bounds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_SIZE,
  DENSITY_FLOOR,
  INITIAL_SYSTEM_SEED,
  MIN_ASTEROIDS_PER_CHUNK,
  MAX_ASTEROIDS_PER_CHUNK,
  mulberry32,
  makeSimplex2,
  hashChunk,
  densityAt,
  generateChunk,
} from '../src/world/index.js';

// ---------------------------------------------------------------------------
// mulberry32
// ---------------------------------------------------------------------------

test('mulberry32: same seed produces identical sequence', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    assert.equal(a(), b(), `mismatch at i=${i}`);
  }
});

test('mulberry32: different seeds produce different sequences', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  let diffs = 0;
  for (let i = 0; i < 50; i++) if (a() !== b()) diffs++;
  assert.ok(diffs > 40, `expected sequences to diverge, got ${diffs}/50`);
});

test('mulberry32: output is in [0, 1)', () => {
  const rng = mulberry32(0xdeadbeef);
  for (let i = 0; i < 10_000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range at i=${i}: ${v}`);
  }
});

// ---------------------------------------------------------------------------
// makeSimplex2
// ---------------------------------------------------------------------------

test('simplex2: same seed produces identical values', () => {
  const a = makeSimplex2(123);
  const b = makeSimplex2(123);
  for (let i = 0; i < 100; i++) {
    assert.equal(a(i * 0.13, i * 0.17), b(i * 0.13, i * 0.17));
  }
});

test('simplex2: output is bounded in approximately [-1, 1]', () => {
  const n = makeSimplex2(42);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 5000; i++) {
    const v = n(Math.sin(i) * 50, Math.cos(i) * 50);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(min >= -1.1, `min out of range: ${min}`);
  assert.ok(max <= 1.1, `max out of range: ${max}`);
});

test('simplex2: different seeds produce different fields', () => {
  const a = makeSimplex2(1);
  const b = makeSimplex2(2);
  let diffs = 0;
  for (let i = 0; i < 50; i++) {
    if (a(i * 0.3, i * 0.2) !== b(i * 0.3, i * 0.2)) diffs++;
  }
  assert.ok(diffs > 40, `expected fields to differ, got ${diffs}/50`);
});

// ---------------------------------------------------------------------------
// hashChunk
// ---------------------------------------------------------------------------

test('hashChunk: same inputs produce identical output', () => {
  assert.equal(hashChunk(0, 0, INITIAL_SYSTEM_SEED), hashChunk(0, 0, INITIAL_SYSTEM_SEED));
  assert.equal(hashChunk(7, -3, 0xcafebabe), hashChunk(7, -3, 0xcafebabe));
});

test('hashChunk: output is a 32-bit unsigned int', () => {
  for (let cx = -5; cx <= 5; cx++) {
    for (let cz = -5; cz <= 5; cz++) {
      const h = hashChunk(cx, cz, INITIAL_SYSTEM_SEED);
      assert.ok(Number.isInteger(h), `not int: ${h}`);
      assert.ok(h >= 0 && h <= 0xffffffff, `out of u32: ${h}`);
    }
  }
});

test('hashChunk: changing any input changes the output', () => {
  const base = hashChunk(0, 0, INITIAL_SYSTEM_SEED);
  assert.notEqual(base, hashChunk(1, 0, INITIAL_SYSTEM_SEED));
  assert.notEqual(base, hashChunk(0, 1, INITIAL_SYSTEM_SEED));
  assert.notEqual(base, hashChunk(-1, 0, INITIAL_SYSTEM_SEED));
  assert.notEqual(base, hashChunk(0, -1, INITIAL_SYSTEM_SEED));
  assert.notEqual(base, hashChunk(0, 0, INITIAL_SYSTEM_SEED + 1));
});

// ---------------------------------------------------------------------------
// densityAt
// ---------------------------------------------------------------------------

test('densityAt: output is in [0, 1] across a grid', () => {
  for (let cx = -25; cx <= 25; cx++) {
    for (let cz = -25; cz <= 25; cz++) {
      const d = densityAt(cx, cz, INITIAL_SYSTEM_SEED);
      assert.ok(d >= 0 && d <= 1, `out of range at (${cx},${cz}): ${d}`);
    }
  }
});

test('densityAt: deterministic across calls', () => {
  for (let i = 0; i < 50; i++) {
    const cx = (i * 17) | 0;
    const cz = (i * 31) | 0;
    assert.equal(
      densityAt(cx, cz, INITIAL_SYSTEM_SEED),
      densityAt(cx, cz, INITIAL_SYSTEM_SEED),
    );
  }
});

test('densityAt: not constant (varies meaningfully across the field)', () => {
  const samples = [];
  for (let cx = -20; cx <= 20; cx += 5) {
    for (let cz = -20; cz <= 20; cz += 5) {
      samples.push(densityAt(cx, cz, INITIAL_SYSTEM_SEED));
    }
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  assert.ok(max - min > 0.3, `field too flat: min=${min}, max=${max}`);
});

// ---------------------------------------------------------------------------
// generateChunk
// ---------------------------------------------------------------------------

test('generateChunk: deterministic — same id → identical chunk', () => {
  const id = { cx: 5, cz: -3, systemSeed: INITIAL_SYSTEM_SEED };
  const a = generateChunk(id);
  const b = generateChunk(id);
  assert.deepEqual(a, b);
});

test('generateChunk: density matches densityAt for the same coord', () => {
  for (let i = 0; i < 20; i++) {
    const cx = i * 3;
    const cz = -i * 2;
    const chunk = generateChunk({ cx, cz, systemSeed: INITIAL_SYSTEM_SEED });
    const expected = densityAt(cx, cz, INITIAL_SYSTEM_SEED);
    assert.equal(chunk.densityNoise, expected);
  }
});

test('generateChunk: respects DENSITY_FLOOR (low-density chunks have 0 asteroids)', () => {
  // Find a chunk with density < DENSITY_FLOOR
  let found = null;
  for (let cx = -50; cx <= 50 && !found; cx++) {
    for (let cz = -50; cz <= 50 && !found; cz++) {
      const d = densityAt(cx, cz, INITIAL_SYSTEM_SEED);
      if (d < DENSITY_FLOOR) found = { cx, cz, d };
    }
  }
  assert.ok(found, 'expected to find at least one low-density chunk in the search range');
  const chunk = generateChunk({ cx: found.cx, cz: found.cz, systemSeed: INITIAL_SYSTEM_SEED });
  assert.equal(chunk.asteroids.length, 0);
  assert.ok(chunk.densityNoise < DENSITY_FLOOR);
});

test('generateChunk: asteroid count is in [MIN, MAX] when density >= floor', () => {
  for (let i = 0; i < 30; i++) {
    const cx = (i * 11) | 0;
    const cz = (i * 7) | 0;
    const d = densityAt(cx, cz, INITIAL_SYSTEM_SEED);
    if (d < DENSITY_FLOOR) continue;
    const chunk = generateChunk({ cx, cz, systemSeed: INITIAL_SYSTEM_SEED });
    const expected = Math.round(
      MIN_ASTEROIDS_PER_CHUNK + (MAX_ASTEROIDS_PER_CHUNK - MIN_ASTEROIDS_PER_CHUNK) * d,
    );
    assert.equal(
      chunk.asteroids.length,
      expected,
      `count mismatch at (${cx},${cz}) density=${d.toFixed(3)}: ` +
      `expected ${expected}, got ${chunk.asteroids.length}`,
    );
  }
});

test('generateChunk: asteroid positions are inside the chunk', () => {
  for (let i = 0; i < 10; i++) {
    const cx = i;
    const cz = -i;
    const chunk = generateChunk({ cx, cz, systemSeed: INITIAL_SYSTEM_SEED });
    for (const a of chunk.asteroids) {
      assert.ok(
        a.position.x >= cx * CHUNK_SIZE && a.position.x < (cx + 1) * CHUNK_SIZE,
        `x out of chunk: ${a.position.x} for chunk (${cx},${cz})`,
      );
      assert.ok(
        a.position.z >= cz * CHUNK_SIZE && a.position.z < (cz + 1) * CHUNK_SIZE,
        `z out of chunk: ${a.position.z} for chunk (${cx},${cz})`,
      );
      assert.equal(a.position.y, 0);
    }
  }
});

test('generateChunk: asteroid sizes are valid tiers', () => {
  for (let i = 0; i < 5; i++) {
    const chunk = generateChunk({ cx: i, cz: i, systemSeed: INITIAL_SYSTEM_SEED });
    for (const a of chunk.asteroids) {
      assert.ok(a.size === 0 || a.size === 1 || a.size === 2, `bad size: ${a.size}`);
      const r = a.radius;
      assert.ok(r === 8 || r === 4 || r === 2, `bad radius: ${r}`);
    }
  }
});

test('generateChunk: asteroid ids are unique within a chunk', () => {
  const chunk = generateChunk({ cx: 1, cz: 1, systemSeed: INITIAL_SYSTEM_SEED });
  const ids = new Set(chunk.asteroids.map((a) => a.id));
  assert.equal(ids.size, chunk.asteroids.length);
});

test('generateChunk: rotation axes are unit vectors (in floating point)', () => {
  const chunk = generateChunk({ cx: 2, cz: 2, systemSeed: INITIAL_SYSTEM_SEED });
  for (const a of chunk.asteroids) {
    const len = Math.hypot(a.axis.x, a.axis.y, a.axis.z);
    assert.ok(Math.abs(len - 1) < 1e-6, `axis not unit: ${len} for ${a.id}`);
  }
});

test('generateChunk: drift velocities are within MAX_ASTEROID_DRIFT', () => {
  const chunk = generateChunk({ cx: 0, cz: 0, systemSeed: INITIAL_SYSTEM_SEED });
  for (const a of chunk.asteroids) {
    const mag = Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z);
    assert.ok(mag <= 0.5 + 1e-6, `drift too fast: ${mag} for ${a.id}`);
    assert.equal(a.velocity.y, 0);
  }
});

// ---------------------------------------------------------------------------
// World streaming layer (createWorld, worldToChunk, chunkKey,
// updateStreamingBubble, evictStaleChunks, getActiveChunks)
// ---------------------------------------------------------------------------

import {
  createWorld,
  worldToChunk,
  chunkKey,
  updateStreamingBubble,
  evictStaleChunks,
  getActiveChunks,
  BUBBLE_RADIUS_CHUNKS,
  RECENTLY_EVICTED_TTL_S,
} from '../src/world/index.js';

test('createWorld: returns empty active + empty recentlyGone + systemSeed + bubbleRadius', () => {
  const w = createWorld({ systemSeed: 0xdeadbeef });
  assert.equal(w.systemSeed, 0xdeadbeef >>> 0);
  assert.equal(w.bubbleRadiusChunks, BUBBLE_RADIUS_CHUNKS);
  assert.equal(w.marginChunks, 1);
  assert.ok(w.active instanceof Map);
  assert.ok(w.recentlyGone instanceof Map);
  assert.equal(w.active.size, 0);
  assert.equal(w.recentlyGone.size, 0);
  assert.equal(w.lastUpdateS, null);
});

test('createWorld: respects bubbleRadiusChunks override', () => {
  const w = createWorld({ systemSeed: 0, bubbleRadiusChunks: 1 });
  assert.equal(w.bubbleRadiusChunks, 1);
});

test('createWorld: rejects negative or non-integer bubble radius', () => {
  assert.throws(() => createWorld({ systemSeed: 0, bubbleRadiusChunks: -1 }), /non-negative integer/);
  assert.throws(() => createWorld({ systemSeed: 0, bubbleRadiusChunks: 1.5 }), /non-negative integer/);
});

test('worldToChunk: positive coords + edge cases', () => {
  assert.deepEqual(worldToChunk({ x: 0, y: 0, z: 0 }), { cx: 0, cz: 0 });
  assert.deepEqual(worldToChunk({ x: 50, y: 0, z: 50 }), { cx: 0, cz: 0 });
  assert.deepEqual(worldToChunk({ x: 199.99, y: 0, z: 0 }), { cx: 0, cz: 0 });
  assert.deepEqual(worldToChunk({ x: 200, y: 0, z: 0 }), { cx: 1, cz: 0 });
  assert.deepEqual(worldToChunk({ x: 300, y: 0, z: 50 }), { cx: 1, cz: 0 });
});

test('worldToChunk: negative coords use Math.floor (not truncate toward 0)', () => {
  // This is the critical one: -0.1 must go to chunk -1, not chunk 0.
  // Otherwise the ship would teleport between two chunks at the origin.
  assert.deepEqual(worldToChunk({ x: -0.1, y: 0, z: 0 }), { cx: -1, cz: 0 });
  assert.deepEqual(worldToChunk({ x: -200, y: 0, z: -200 }), { cx: -1, cz: -1 });
  assert.deepEqual(worldToChunk({ x: -200.01, y: 0, z: 0 }), { cx: -2, cz: 0 });
});

test('worldToChunk: rejects missing or non-numeric x/z', () => {
  assert.throws(() => worldToChunk({ y: 0, z: 0 }), /numeric x and z/);
  assert.throws(() => worldToChunk({ x: 'a', y: 0, z: 0 }), /numeric x and z/);
  assert.throws(() => worldToChunk(null), /numeric x and z/);
});

test('chunkKey: format is "cx,cz" with no padding', () => {
  assert.equal(chunkKey(0, 0), '0,0');
  assert.equal(chunkKey(3, -2), '3,-2');
  assert.equal(chunkKey(-7, 11), '-7,11');
  assert.equal(chunkKey(3, -2), chunkKey(3, -2), 'stable across calls');
});

test('chunkKey: rejects non-integer coords', () => {
  assert.throws(() => chunkKey(1.5, 0), /must be integers/);
  assert.throws(() => chunkKey(0, -0.1), /must be integers/);
  assert.throws(() => chunkKey('x', 0), /must be integers/);
});

test('updateStreamingBubble: first call at origin populates (2R+1)² chunks for default R=3', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED });
  const delta = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(delta.totalActive, 49, `expected 49 chunks, got ${delta.totalActive}`);
  assert.equal(delta.added.length, 49);
  assert.equal(delta.reactivated.length, 0);
  assert.equal(delta.evicted.length, 0);
  assert.equal(w.active.size, 49);
  assert.equal(w.recentlyGone.size, 0);
});

test('updateStreamingBubble: respects bubbleRadiusChunks override (R=1 → 9 chunks)', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 1 });
  const delta = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(delta.totalActive, 9);
  assert.equal(w.active.size, 9);
});

test('updateStreamingBubble: moving the ship evicts old chunks to recentlyGone', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 1 });
  updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(w.active.size, 9);
  // Move one chunk away (+X). At MAX_SPEED 200 u/s, the 1-chunk move
  // is small enough to keep the bubble overlapping by 6 chunks.
  const delta = updateStreamingBubble(w, { x: CHUNK_SIZE, y: 0, z: 0 }, 0.1);
  // Ship moved from (0,0) to (1,0). Old bubble: (0,0)..(1,1) in cx
  // and (-1,0)..(0,1) in cz (R=1). New bubble: (1,0)..(2,1) × (-1,0)..(0,1).
  // Overlap: cz stays the same; cx stays the same in one column. So 6
  // chunks should remain active and 3 chunks should evict.
  assert.equal(delta.evicted.length, 3, `expected 3 evicted, got ${delta.evicted.length}`);
  assert.equal(delta.added.length, 3, `expected 3 added, got ${delta.added.length}`);
  assert.equal(w.active.size, 9);
  assert.equal(w.recentlyGone.size, 3);
});

test('updateStreamingBubble: re-entering a recently-evicted chunk reuses the cache (no re-gen)', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 1 });
  updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  // Pick a chunk on the edge of the bubble that we'll leave then return to.
  const edgeKey = chunkKey(-1, -1);
  const originalChunk = w.active.get(edgeKey);
  assert.ok(originalChunk, 'precondition: edge chunk should be live');
  // Move ship away (to chunk (5, 0)) so the edge chunk evicts.
  updateStreamingBubble(w, { x: 5 * CHUNK_SIZE, y: 0, z: 0 }, 0.1);
  assert.ok(w.recentlyGone.has(edgeKey), 'precondition: edge chunk should be evicted');
  // Now come back (chunk (0, 0) again) before the TTL expires.
  const delta = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.2);
  // The edge chunk should be in reactivated, NOT added (cache hit).
  const reactivatedKeys = delta.reactivated.map((c) => chunkKey(c.id.cx, c.id.cz));
  assert.ok(reactivatedKeys.includes(edgeKey), `expected reactivation of ${edgeKey}`);
  // The same chunk object reference should be re-attached — proves
  // we didn't call generateChunk again.
  assert.strictEqual(w.active.get(edgeKey), originalChunk, 'cache hit should preserve the same chunk object');
  assert.equal(w.recentlyGone.has(edgeKey), false, 'cache should be empty for reactivated key');
});

test('evictStaleChunks: drops entries after RECENTLY_EVICTED_TTL_S', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 0 });
  // Populate with a single chunk at origin, then move ship away to evict.
  updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  updateStreamingBubble(w, { x: CHUNK_SIZE, y: 0, z: 0 }, 0);
  assert.equal(w.recentlyGone.size, 1, 'precondition: 1 chunk evicted');
  // Call evictStaleChunks well before TTL — nothing should drop.
  let dropped = evictStaleChunks(w, RECENTLY_EVICTED_TTL_S - 0.5);
  assert.equal(dropped.length, 0);
  assert.equal(w.recentlyGone.size, 1);
  // Now jump past TTL — the chunk should drop.
  dropped = evictStaleChunks(w, RECENTLY_EVICTED_TTL_S + 1);
  assert.equal(dropped.length, 1);
  assert.equal(w.recentlyGone.size, 0);
});

test('getActiveChunks: returns all live chunks in insertion order with keys', () => {
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 0 });
  updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  const list = getActiveChunks(w);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, '0,0');
  assert.ok(list[0].chunk.asteroids !== undefined, 'chunk should have asteroids field');
});

test('updateStreamingBubble: deterministic — same (systemSeed, shipPos, nowS) → identical active keys', () => {
  const run = () => {
    const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 2 });
    updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
    return [...w.active.keys()].sort();
  };
  const keys1 = run();
  const keys2 = run();
  assert.deepEqual(keys1, keys2, 'two independent runs should produce the same bubble');
});

test('updateStreamingBubble: rejects bad inputs', () => {
  const w = createWorld({ systemSeed: 0 });
  assert.throws(() => updateStreamingBubble(null, { x: 0, y: 0, z: 0 }, 0), /not a valid World/);
  assert.throws(() => updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, NaN), /finite number/);
  assert.throws(() => updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 'oops'), /finite number/);
});

test('worldToChunk: floating-point boundary edge (a tick across origin is stable)', () => {
  // The ship at x = 0 is in chunk (0, 0). The ship at x = -0.001 is
  // in chunk (-1, 0). The ship at x = +0.001 is in chunk (0, 0).
  // This is the "no flicker at the origin" test.
  assert.deepEqual(worldToChunk({ x: 0, y: 0, z: 0 }), { cx: 0, cz: 0 });
  assert.deepEqual(worldToChunk({ x: -0.001, y: 0, z: 0 }), { cx: -1, cz: 0 });
  assert.deepEqual(worldToChunk({ x: 0.001, y: 0, z: 0 }), { cx: 0, cz: 0 });
});

test('updateStreamingBubble: chunksPerFrame cap is per-frame (not per-bubble-fill)', () => {
  // With chunksPerFrame=2 and a 9-chunk bubble, the cap applies
  // every frame: each call adds at most 2 chunks. The bubble
  // fills over 5 frames (2+2+2+2+1), with each frame respecting
  // the cap. This is the intended behavior for smoothing a
  // first-frame spike — the cap is NOT "fill the bubble in one
  // shot", it's "generate at most N per frame".
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 1, chunksPerFrame: 2 });
  // Frame 1: 2 added, 7 still missing.
  const first = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(first.added.length, 2, `frame 1: expected 2 added, got ${first.added.length}`);
  assert.equal(w.active.size, 2, `frame 1: expected 2 active, got ${w.active.size}`);
  // Frame 2: 2 more added (cap re-applies), 5 still missing.
  const second = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.1);
  assert.equal(second.added.length, 2, `frame 2: expected 2 added, got ${second.added.length}`);
  assert.equal(w.active.size, 4, `frame 2: expected 4 active, got ${w.active.size}`);
  // Frame 3: 2 more.
  const third = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.2);
  assert.equal(third.added.length, 2, `frame 3: expected 2 added, got ${third.added.length}`);
  assert.equal(w.active.size, 6, `frame 3: expected 6 active, got ${w.active.size}`);
  // Frame 4: 2 more.
  const fourth = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.3);
  assert.equal(fourth.added.length, 2, `frame 4: expected 2 added, got ${fourth.added.length}`);
  assert.equal(w.active.size, 8, `frame 4: expected 8 active, got ${w.active.size}`);
  // Frame 5: the last one (cap is a max, not a strict limit).
  const fifth = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.4);
  assert.equal(fifth.added.length, 1, `frame 5: expected 1 added, got ${fifth.added.length}`);
  assert.equal(w.active.size, 9, `frame 5: expected 9 active, got ${w.active.size}`);
});

test('createWorld: chunksPerFrame default is Infinity (no cap) and accepts 0 (reactivations only)', () => {
  // Default: no cap, generates all 49 chunks in one frame.
  const w1 = createWorld({ systemSeed: INITIAL_SYSTEM_SEED });
  assert.equal(w1.chunksPerFrame, Infinity);
  // 0 is valid: it means "no fresh generation, only reactivations"
  // (useful for tests + future cache-only pre-fetch modes).
  const w2 = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, chunksPerFrame: 0 });
  assert.equal(w2.chunksPerFrame, 0);
  // Negative / non-numeric are rejected.
  assert.throws(() => createWorld({ systemSeed: 0, chunksPerFrame: -1 }), /non-negative/);
  assert.throws(() => createWorld({ systemSeed: 0, chunksPerFrame: 'fast' }), /non-negative/);
});

test('updateStreamingBubble: chunksPerFrame cap does NOT count reactivations', () => {
  // Pre-populate the recently-evicted cache with a chunk on the
  // edge of the bubble. The cap is set AFTER setup so the
  // setup's own generation isn't blocked.
  const w = createWorld({ systemSeed: INITIAL_SYSTEM_SEED, bubbleRadiusChunks: 0 });
  // Step 1: populate + evict a chunk to put it in recentlyGone.
  updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0);
  updateStreamingBubble(w, { x: CHUNK_SIZE, y: 0, z: 0 }, 0.1);
  assert.equal(w.recentlyGone.size, 1, 'precondition: 1 chunk in cache');
  // Step 2: now tighten the cap to 0 (cache-only mode). The
  // reactivation must still go through (no generateChunk call,
  // so no cap hit).
  w.chunksPerFrame = 0;
  const delta = updateStreamingBubble(w, { x: 0, y: 0, z: 0 }, 0.2);
  assert.equal(delta.reactivated.length, 1, 'reactivation should not count against the cap');
  assert.equal(delta.added.length, 0, 'no new chunks should generate with cap=0');
  assert.equal(w.active.size, 1);
});
