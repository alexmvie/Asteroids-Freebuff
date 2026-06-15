/**
 * Streaming layer for the chunked asteroid-field world.
 * See SPEC.md for the full design rationale.
 *
 * @fileoverview Sits one layer above `chunks.js`. While `chunks.js`
 *   is the *pure generation* layer (one call to `generateChunk(id)`
 *   gives you a chunk's full data), `world.js` is the *pure streaming*
 *   layer — it manages the per-frame decision of which chunks should
 *   be live, which should be evicted to a soft cache, and which should
 *   be dropped. No Three.js, no DOM, no `Math.random`. The `nowS`
 *   argument is passed in by the caller (not read from a clock) so
 *   tests can drive time without fake timers.
 *
 * Public API:
 *   - `createWorld({ systemSeed, bubbleRadiusChunks? }) → World`
 *   - `worldToChunk(worldPos) → { cx, cz }`     (pure coord math)
 *   - `chunkKey(cx, cz) → string`               (Map key, e.g. "3,-2")
 *   - `updateStreamingBubble(world, shipPos, nowS) → Delta`
 *   - `evictStaleChunks(world, nowS) → string[]`  (returns the dropped keys)
 *   - `getActiveChunks(world) → Array<{ key, chunk }>`  (for entity spawn)
 *
 * State machine for a chunk (per call to `updateStreamingBubble`):
 *
 *     (empty)
 *        │ bubble includes it
 *        ▼
 *     active  ←──────────────────────────┐
 *        │                                │ bubble includes it again
 *        │ bubble no longer includes it   │
 *        ▼                                │
 *     recentlyGone { chunk, evictedAt }  │
 *        │                                │
 *        │ nowS - evictedAt > TTL         │
 *        ▼                                │
 *     (dropped, forgotten)  ──────────────┘
 *
 *   - `added` chunks: newly generated (not seen before, not in cache).
 *   - `reactivated` chunks: pulled from `recentlyGone` without regenerating.
 *   - `evicted` chunks: moved from `active` to `recentlyGone`.
 *
 * Determinism: `updateStreamingBubble(world, shipPos, nowS)` is a pure
 * function of its inputs. Two calls with the same `(shipPos, nowS)` on
 * the same world state produce identical deltas. This is what makes
 * the streaming layer testable and reproducible.
 */
import {
  CHUNK_SIZE,
  BUBBLE_RADIUS_CHUNKS,
  RECENTLY_EVICTED_TTL_S,
  STREAMING_MARGIN_CHUNKS,
} from './chunk-constants.js';
import { generateChunk } from './chunks.js';

// ---------------------------------------------------------------------------
// Coord math (pure)
// ---------------------------------------------------------------------------

/**
 * Convert a world-space position to integer chunk coordinates. Negative
 * coords use the standard `Math.floor` rounding so `(-0.1)` maps to `-1`,
 * not `0` — the latter would put the ship in the "wrong" chunk when it
 * crosses the origin in the negative direction.
 *
 * @param {{x:number,y:number,z:number}} worldPos
 * @returns {{cx:number,cz:number}}
 */
export function worldToChunk(worldPos) {
  if (!worldPos || typeof worldPos.x !== 'number' || typeof worldPos.z !== 'number') {
    throw new Error('worldToChunk: worldPos must have numeric x and z');
  }
  return {
    cx: Math.floor(worldPos.x / CHUNK_SIZE),
    cz: Math.floor(worldPos.z / CHUNK_SIZE),
  };
}

/**
 * Canonical string key for a chunk's Map storage. Format is "cx,cz"
 * with no padding — the keys are stable for a given (cx, cz) pair
 * regardless of leading zeros, and they're human-readable in the
 * browser console (which makes debugging a lot easier than the
 * alternative `cx * 10000 + cz` encoding).
 *
 * @param {number} cx
 * @param {number} cz
 * @returns {string}
 */
export function chunkKey(cx, cz) {
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) {
    throw new Error(`chunkKey: cx and cz must be integers, got (${cx}, ${cz})`);
  }
  return `${cx},${cz}`;
}

// ---------------------------------------------------------------------------
// World factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh streaming world. Initial state has no active chunks
 * and no recently-evicted chunks; the first call to
 * `updateStreamingBubble` populates the bubble.
 *
 * @param {object} [opts]
 * @param {number} [opts.systemSeed=0]      The system seed (Elite hook).
 *   Same seed + same ship path → identical world. MVP uses
 *   `INITIAL_SYSTEM_SEED` from `chunk-constants.js`.
 * @param {number} [opts.bubbleRadiusChunks=BUBBLE_RADIUS_CHUNKS=3]
 *   The active region is a square of (2R+1)² chunks centered on the
 *   ship's chunk. The default gives a 7×7 = 49-chunk bubble.
 * @param {number} [opts.marginChunks=STREAMING_MARGIN_CHUNKS=1]
 *   Reserved for future pre-fetch optimization. Not used in MVP
 *   (the soft cache is the equivalent mechanism, but it kicks in
 *   on chunk EXIT, not on a fixed outer ring). Stored on the
 *   world object so a future pre-fetcher can read it.
 * @param {number} [opts.chunksPerFrame=Infinity]
 *   Per-frame generation cap. The MVP ships with `Infinity`
 *   (no cap) because the 49-chunk first-frame spike is <2ms.
 *   Set to e.g. 16 to smooth a first-frame generation over ~3
 *   frames; cache hits (reactivations) don't count against it.
 * @returns {{
 *   systemSeed: number,
 *   bubbleRadiusChunks: number,
 *   marginChunks: number,
 *   chunksPerFrame: number,
 *   active: Map<string, object>,
 *   recentlyGone: Map<string, { chunk: object, evictedAt: number }>,
 *   lastUpdateS: number|null
 * }}
 */
export function createWorld(opts = {}) {
  const {
    systemSeed = 0,
    bubbleRadiusChunks = BUBBLE_RADIUS_CHUNKS,
    marginChunks = STREAMING_MARGIN_CHUNKS,
    chunksPerFrame = Infinity,
  } = opts;
  if (!Number.isInteger(bubbleRadiusChunks) || bubbleRadiusChunks < 0) {
    throw new Error(`createWorld: bubbleRadiusChunks must be a non-negative integer, got ${bubbleRadiusChunks}`);
  }
  if (!Number.isInteger(marginChunks) || marginChunks < 0) {
    throw new Error(`createWorld: marginChunks must be a non-negative integer, got ${marginChunks}`);
  }
  if (typeof chunksPerFrame !== 'number' || chunksPerFrame < 0) {
    throw new Error(`createWorld: chunksPerFrame must be a non-negative number, got ${chunksPerFrame}`);
  }
  return {
    systemSeed,
    bubbleRadiusChunks,
    marginChunks,
    chunksPerFrame,
    active: new Map(),
    recentlyGone: new Map(),
    lastUpdateS: null,
  };
}

// ---------------------------------------------------------------------------
// Per-frame update (the headline pure function)
// ---------------------------------------------------------------------------

/**
 * Update the streaming bubble so the chunks within
 * `bubbleRadiusChunks` of the ship's chunk are live, and everything
 * outside is evicted to the soft cache.
 *
 * The delta tells the caller what changed so the entity layer can
 * spawn / despawn meshes without re-scanning the active Map.
 *
 * The first call (when `world.active` is empty) generates up to
 * (2R+1)² chunks in one shot. At the default R=3, that's 49 chunks
 * in the first frame — fine for the MVP demo (each chunk is small
 * and deterministic). If profiling shows a first-frame spike, the
 * follow-up is a per-frame generation cap.
 *
 * @param {object} world — from `createWorld()`
 * @param {{x:number,y:number,z:number}} shipPos
 * @param {number} nowS — current game time in seconds (caller-supplied)
 * @returns {{
 *   added: Array<object>,         // newly generated chunks
 *   reactivated: Array<object>,   // pulled from recentlyGone cache
 *   evicted: Array<object>,       // moved from active to recentlyGone
 *   totalActive: number
 *   // Chunks that hit the `chunksPerFrame` cap are NOT reported
 *   // back — they stay out of `active` and will be generated on
 *   // the next call. The return shape only carries chunks that
 *   // materially entered or left the bubble.
 * }}
 */
export function updateStreamingBubble(world, shipPos, nowS) {
  if (!world || !world.active || !world.recentlyGone) {
    throw new Error('updateStreamingBubble: world is not a valid World object');
  }
  if (typeof nowS !== 'number' || !Number.isFinite(nowS)) {
    throw new Error(`updateStreamingBubble: nowS must be a finite number, got ${nowS}`);
  }
  const shipChunk = worldToChunk(shipPos);
  const R = world.bubbleRadiusChunks;
  // Per-frame generation cap (set via `createWorld({ chunksPerFrame })`,
  // default Infinity). When set, only the first N chunks in the
  // "desired but missing" set are generated this frame; the rest
  // stay out of `active` and are picked up on the next call (since
  // they're still in `desiredKeys`). Cache hits (reactivations)
  // don't count against the cap.
  const chunksPerFrame = world.chunksPerFrame;
  let generatedThisFrame = 0;

  // 1. Compute the set of keys that SHOULD be in the bubble.
  const desiredKeys = new Set();
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      desiredKeys.add(chunkKey(shipChunk.cx + dx, shipChunk.cz + dz));
    }
  }

  // 2. Add chunks that should be live but aren't.
  const added = [];
  const reactivated = [];
  for (const key of desiredKeys) {
    if (world.active.has(key)) continue;
    const cached = world.recentlyGone.get(key);
    if (cached) {
      // Cache hit: skip generateChunk. The chunk is bit-identical
      // to the one we evicted (generateChunk is pure), so we can
      // safely re-attach the same data.
      world.recentlyGone.delete(key);
      world.active.set(key, cached.chunk);
      reactivated.push(cached.chunk);
    } else {
      // Cache miss: generate from scratch, subject to the cap.
      // Chunks that hit the cap stay out of `active` and will be
      // generated on the next call (since they're still in
      // `desiredKeys`). This keeps the return shape tight — the
      // caller only sees chunks that actually entered the bubble.
      if (generatedThisFrame >= chunksPerFrame) continue;
      const [cxStr, czStr] = key.split(',');
      const cx = Number(cxStr);
      const cz = Number(czStr);
      const chunk = generateChunk({ cx, cz, systemSeed: world.systemSeed });
      world.active.set(key, chunk);
      added.push(chunk);
      generatedThisFrame++;
    }
  }

  // 3. Evict chunks that are in active but no longer desired.
  const evicted = [];
  for (const [key, chunk] of world.active) {
    if (desiredKeys.has(key)) continue;
    world.active.delete(key);
    world.recentlyGone.set(key, { chunk, evictedAt: nowS });
    evicted.push(chunk);
  }

  world.lastUpdateS = nowS;
  return { added, reactivated, evicted, totalActive: world.active.size };
}

// ---------------------------------------------------------------------------
// TTL cleanup
// ---------------------------------------------------------------------------

/**
 * Drop chunks from `recentlyGone` whose eviction timestamp is older
 * than `RECENTLY_EVICTED_TTL_S`. The caller should run this every
 * frame (it's a single map iteration and drops at most a few entries
 * per call at typical player speeds).
 *
 * The default TTL is 10 seconds (defined in `chunk-constants.js`).
 * At `MAX_SPEED = 200 u/s` the ship can travel ~10 chunks in 10s,
 * so the soft cache stays bounded at ~100 entries worst case.
 *
 * @param {object} world
 * @param {number} nowS
 * @returns {string[]} the keys that were dropped
 */
export function evictStaleChunks(world, nowS) {
  if (!world || !world.recentlyGone) {
    throw new Error('evictStaleChunks: world is not a valid World object');
  }
  if (typeof nowS !== 'number' || !Number.isFinite(nowS)) {
    throw new Error(`evictStaleChunks: nowS must be a finite number, got ${nowS}`);
  }
  const dropped = [];
  for (const [key, entry] of world.recentlyGone) {
    if (nowS - entry.evictedAt > RECENTLY_EVICTED_TTL_S) {
      world.recentlyGone.delete(key);
      dropped.push(key);
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Read helpers (for the entity layer)
// ---------------------------------------------------------------------------

/**
 * Return all live chunks in a stable order (insertion order, which
 * matches the order the bubble was populated). Each entry has
 * `{ key, chunk }` so the caller can spawn entities per chunk and
 * track the key for fast eviction lookup later.
 *
 * @param {object} world
 * @returns {Array<{ key: string, chunk: object }>}
 */
export function getActiveChunks(world) {
  if (!world || !world.active) {
    throw new Error('getActiveChunks: world is not a valid World object');
  }
  const out = [];
  for (const [key, chunk] of world.active) {
    out.push({ key, chunk });
  }
  return out;
}

