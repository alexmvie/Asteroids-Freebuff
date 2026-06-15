# 3D Asteroids → Elite — Design Spec

A living design document for the chunked asteroid-field foundation. This is the source of truth for the data model; code artifacts live alongside it in `src/world/`.

> **Project direction:** A 3D, open-space Asteroids MVP that doubles as the jumping-off point for an Elite-style game. The MVP flies on a 2D plane (XZ); the architecture is designed so 6DOF, hyperspace, and trading can be added without refactor.

---

## 1. Locked Constants

| Constant | Value | Notes |
|---|---|---|
| `CHUNK_SIZE` | `200` | World units per chunk side |
| `BUBBLE_RADIUS_CHUNKS` | `3` | 7×7 = 49 active chunks around ship |
| `STREAMING_MARGIN_CHUNKS` | `1` | Soft pre-load margin beyond the active bubble |
| `MIN_ASTEROIDS_PER_CHUNK` | `1` | Lower bound when density > floor |
| `MAX_ASTEROIDS_PER_CHUNK` | `12` | Upper bound in dense pockets |
| `DENSITY_FLOOR` | `0.1` | Below this, chunk spawns 0 asteroids (voids) |
| `RECENTLY_EVICTED_TTL_S` | `10` | Soft cache TTL for fast re-entry |
| `MAX_ASTEROID_DRIFT` | `0.5` | u/s, ambient drift cap |
| `PLAY_PLANE_Y` | `0` | Reserved Y; unused in 2DOF MVP |
| `INITIAL_SYSTEM_SEED` | `0xA570E210` | MVP constant; replaced on hyperspace |

Constants are exported from `src/world/constants.js` and consumed by the rest of the codebase.

---

## 2. Data Types (JSDoc)

Authoritative typedefs live in `src/world/types.js`. Quick reference:

```ts
type Vec3 = { x: number, y: number, z: number };
type AsteroidSize = 0 | 1 | 2;            // large, medium, small

type ChunkId = { cx: number, cz: number, systemSeed: number };

type AsteroidSpec = {
  id: string;          // stable within the chunk, e.g. "12-7-3"
  position: Vec3;      // world space
  radius: number;
  size: AsteroidSize;
  axis: Vec3;          // unit rotation axis
  spin: number;        // rad/s
  velocity: Vec3;      // ambient drift
  seed: number;        // for procedural mesh variation
};

type Chunk = {
  id: ChunkId;
  asteroids: AsteroidSpec[];
  densityNoise: number;  // cached [0,1] at chunk center
  generated: boolean;
};

type World = {
  active: Map<string, Chunk>;        // key = "cx,cz"
  recentlyGone: Map<string, Chunk>;  // soft cache, TTL'd
  systemSeed: number;
};
```

---

## 3. Seed Strategy

The chunk's seed is a **pure function of `(cx, cz, systemSeed)`** — no global state, no `Math.random`.

```js
// FNV-1a style 32-bit mix; fast, deterministic.
function hashChunk(cx, cz, systemSeed) {
  let h = (systemSeed ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ (cx & 0xffff), 0x01000193) >>> 0;
  h = Math.imul(h ^ (cz & 0xffff), 0x01000193) >>> 0;
  return h >>> 0;
}
```

The seed feeds a **Mulberry32** PRNG to generate the asteroid list. Same input → identical output, on every run, on every machine.

---

## 4. Density Noise

2D simplex noise sampled at the chunk center, mapped to a spawn count.

```js
// Two octaves: large pockets (~600u) + smaller detail (~120u)
function densityAt(cx, cz, systemSeed) {
  const wx = (cx + 0.5) * CHUNK_SIZE;
  const wz = (cz + 0.5) * CHUNK_SIZE;
  const n1 = simplex2(wx * 0.0015, wz * 0.0015, systemSeed);
  const n2 = simplex2(wx * 0.008,   wz * 0.008,   systemSeed);
  return clamp01(0.5 * (n1 + 1) * 0.7 + 0.3 * (n2 + 1) * 0.3);
}
```

- Density normalized to `[0, 1]`.
- Spawn count: `lerp(MIN, MAX, density)`, rounded to int.
- If `density < DENSITY_FLOOR` → spawn 0 (void zones).
- `simplex2` is hand-rolled (~80 lines, MIT-style, no npm dep).

---

## 5. Chunk Generation (pure function)

```js
function generateChunk(id) {
  const rng = mulberry32(hashChunk(id.cx, id.cz, id.systemSeed));
  const density = densityAt(id.cx, id.cz, id.systemSeed);
  const count = density < DENSITY_FLOOR
    ? 0
    : Math.round(lerp(MIN_ASTEROIDS_PER_CHUNK, MAX_ASTEROIDS_PER_CHUNK, density));

  const asteroids = [];
  for (let i = 0; i < count; i++) {
    const size = pickSize(rng);  // large biased toward low density, small toward high
    asteroids.push({
      id: `${id.cx}-${id.cz}-${i}`,
      position: { x: (id.cx + rng()) * CHUNK_SIZE, y: 0, z: (id.cz + rng()) * CHUNK_SIZE },
      radius: sizeRadius(size),
      size, axis: randomUnitVec3(rng), spin: lerp(0.1, 0.8, rng()),
      velocity: randomDriftVec3(rng, MAX_ASTEROID_DRIFT),
      seed: (rng() * 1e9) | 0,
    });
  }
  return { id, asteroids, densityNoise: density, generated: true };
}
```

---

## 6. Streaming Bubble & Lifecycle

```
ship position (x, z)
        │
        ▼
  shipChunk = (floor(x / CHUNK_SIZE), floor(z / CHUNK_SIZE))
  activeSet = all chunks with |Δcx| ≤ BUBBLE_RADIUS_CHUNKS, |Δcz| ≤ BUBBLE_RADIUS_CHUNKS
        │
        ├── for chunk in activeSet and not in world.active:
        │       create entity meshes from AsteroidSpec
        │       insert into spatial hash
        │
        └── for chunk in world.active and not in activeSet:
                remove entities, despawn meshes
                move to world.recentlyGone (TTL = RECENTLY_EVICTED_TTL_S, then drop)
```

- `updateStreamingBubble(world, shipChunk)` is the **only** side-effecting function in the world layer.
- Bubble updates each frame (or every N frames for perf), centered on `shipChunk`.
- Recently-evicted chunks stay around briefly so quick re-entry doesn't regen.

---

## 7. Determinism Guarantees

- ❌ **No `Math.random()`** anywhere in chunk generation, asteroid splits, or AI targeting against field content.
- ❌ **No frame-counter or time-based seeding** — same world coord always produces the same chunk.
- ✅ **Split asteroids are transient**: if the player flies out and back, the original parent regenerates (children are lost). This is fine for MVP and a non-issue because splits only happen inside the active bubble.
- ⚠️ **Floating-point precision** at huge world coords is a known concern; for MVP it's fine (no player reaches 10⁶ units). For Elite, we'd add a "local space" origin-shift on system jump. **Documented as future-work.**

---

## 8. Performance Budget (rough)

- 49 active chunks × 6 avg asteroids ≈ **300 asteroids** live.
- Spatial hash lookups are O(1) per query → collision broad-phase is O(asteroids in nearby cells), trivially real-time.
- Chunk regen on first entry: ~50µs. Subsequent entries from `recentlyGone`: ~0µs.
- Allocations during gameplay: zero in steady state (use object pools for entities).

---

## 9. Elite-Readiness Hooks

Designed in now, built later:

- **`World.systemSeed`** slot is already there → hyperspace just changes this and clears `active` + `recentlyGone`.
- **`hashChunk`** accepts arbitrary `systemSeed` → different "star systems" produce entirely different universes.
- **Pure functions** make this trivially unit-testable.
- **Same data model will work for 3D chunks later** (add `cy`); just upgrade `ChunkId` and `hashChunk`.
- **Event bus + serialize/deserialize stubs** are in the high-level plan, not in this data-model spec.
- **Ship controller exposes `setFlightMode('2dof' | '6dof')`** for the 6DOF migration (separate concern, in the ship spec).

---

## 10. File Map (data-model layer)

```
SPEC.md                       ← this file
src/world/
  ├── constants.js            ← locked constants (CHUNK_SIZE, etc.)
  ├── types.js                ← JSDoc typedefs (Vec3, ChunkId, Chunk, ...)
  ├── chunks.js               ← generateChunk, hashChunk, densityAt, pickSize (TODO: next step)
  ├── noise.js                ← simplex2 (TODO: next step)
  ├── rng.js                  ← mulberry32 (TODO: next step)
  ├── world.js                ← updateStreamingBubble, World factory (TODO: next step)
  └── index.js                ← re-exports
```

---

## 11. Open Decisions (kept for visibility)

| Decision | Current | Alternative |
|---|---|---|
| Chunk shape | Square (2D) | Hex (nicer blending, more code) |
| Noise library | Hand-rolled simplex (zero deps) | `simplex-noise` npm package |
| `size` sampling | Density-biased pickSize | Uniform random |
| Split asteroid persistence | Transient | Persist in chunk data (future) |
| World coordinate origin | True world space | Local space with origin shift (Elite-scale) |

---

## 12. UV Unwrapping (editor)

The UV editor lives under `src/geometry/uv/` — a single-responsibility split of the historical monolithic `src/geometry/uv-unwrapping.js` (which is now a re-export shim for backward compatibility). One file per concern:

```
src/geometry/uv/
  ├── edge-keys.js         ← buildEdgeKey, parseEdgeKey (canonical edge IDs)
  ├── island-detection.js  ← detectIslands, findAllBoundaryLoops
  ├── tutte.js             ← computeTutteEmbedding + Cholesky + square placement
  ├── lscm.js              ← solveLSCM + cotangent weights + geodesic picking
  ├── abfpp.js             ← solveABFPlusPlus + angle helpers
  ├── stretch.js           ← computeStretch, stretchToColor
  ├── walk-edge-loop.js    ← walkEdgeLoop (Alt+Click loop selection)
  ├── packing.js           ← packIslandsIntoGrid
  ├── seam-detection.js    ← autoDetectSeams, autoUnwrap
  ├── reunwrap.js          ← reunwrap orchestrator
  └── index.js             ← public barrel
```

The historical `src/geometry/uv-unwrapping.js` re-exports the same 12 public symbols so existing `import { X } from '../geometry/uv-unwrapping.js'` statements continue to work. New code should prefer importing from `src/geometry/uv/index.js` (or the parent `src/geometry/index.js` barrel) directly.

**Public API** (the 12 symbols re-exported from both `uv-unwrapping.js` and `uv/index.js`): `buildEdgeKey`, `parseEdgeKey`, `detectIslands`, `computeTutteEmbedding`, `solveLSCM`, `solveABFPlusPlus`, `walkEdgeLoop`, `computeStretch`, `stretchToColor`, `autoDetectSeams`, `autoUnwrap`, `reunwrap`. Internal helpers (`findAllBoundaryLoops`, `choleskyDecompose`, `choleskySolve`, `tryPlaceBoundaryOnSquare`, `computeCotangentWeights`, `dijkstra`, `findDiameterPair`, `compute3DAngles`, `computeAngleEnergy`, `packIslandsIntoGrid`) are exported from their source files for cross-module imports but are NOT re-exported from the public barrel.

The default solver is a **Tutte embedding** (a.k.a. "uniform weights" Laplacian) to flatten each island into 2D UV space. The boundary is placed on a target shape, and the interior vertices are solved as the Laplacian average of their neighbors (one Cholesky solve per island).

### Boundary placement (square-domain, replaces legacy circle-domain)

Three cases are handled by `tryPlaceBoundaryOnSquare` → `placeOneLoopOnSquare` / `placeTwoLoopsOnSquare`:

1. **ONE boundary loop** → placed on the FULL unit-square perimeter (going clockwise from (0,0)). The Tutte solve fills the interior.
2. **TWO boundary loops** (the "theta" case — cylinder body with both ends open and one longitudinal seam) → top loop on the top edge (y=1), bottom loop on the bottom edge (y=0), shared vertex at (0, 1) and (0, 0). The longitudinal seam forms the left edge; the Tutte solve fills the right side. This produces a clean rectangle unwrap (the natural shape for a cylinder).
3. **3+ boundary loops** → fall back to the legacy per-loop circle arcs (each cycle on a contiguous arc of the unit circle, proportional to its edge count). Rare in the asteroid field (torus boundaries, multi-holed surfaces).

The square placement replaces the legacy circle-domain placement because the latter degenerated on the theta case (max stretch ~1100× — the cylinder body's "back" collapsed to a line in UV space). The square placement drops the theta-case stretch by an order of magnitude (~460) and visually produces a clean rectangle instead of a folded mess.

### Fundamental limits of Tutte-on-square

The stretch metric `s = max(area3D/areaUV, areaUV/area3D) - 1` is bounded by two effects:

1. **Area compression** (packing): when N islands are packed into `[0, 1]²`, each island gets ~1/N of the UV area. The minimum per-face stretch is the area ratio `area3D_total / (1/N)`. For the capsule test (body 3D area ~9.42, 3 islands packed → body gets ~0.33 UV area), the minimum stretch is ~28.
2. **Tutte corner-pinch**: vertices at the unit square's corners pull interior vertices toward them, creating an additional ~14× stretch on faces adjacent to the corners. This is fundamental to the Tutte-on-a-square parameterization.

**Total for the capsule "perfect seams" test: ~400-500 max stretch.** The user's target of `< 1.0` is mathematically unreachable with the current parameterization. To achieve < 1.0 would require one of:

- **LSCM** (Least-Squares Conformal Mapping) — conformal, no corner-pinch, but more complex solve.
- **ABF++** (Angle-Based Flattening) — angle-preserving, even less distortion, but iterative and slower.
- **Per-island area preservation** in the packer — scale each island's UVs so its UV area matches its 3D area. Allows overlapping islands.
- **Drop the packing** — each island in its own separate region of UV space.

The square placement is a pragmatic middle ground: it gives a visually correct rectangle unwrap for the common cases (1- and 2-loop boundaries) at the cost of some stretch on the corners. The user can scale the island after the fact if they need a different aspect.

### Multi-loop boundary walker

`findAllBoundaryLoops(geometry, island, seamKeys)` returns all independent cycles in the boundary graph via greedy walk. For a simple ring (every boundary vertex has degree 2), it returns one cycle. For a theta graph (cylinder with two open ends and one cut), it returns two cycles — the top ring and the bottom ring, each treated independently. This is the foundation for the square placement: each cycle gets its own arc of the unit square's perimeter, so the Tutte solve can flatten the island without leaving any "strip" collapsed to a point.

### Stretch metric (per-face)

`computeStretch(geometry, uvs)` returns `Float32Array` of per-face stretch. The heatmap in the editor uses `stretchToColor(s)` to color faces from green (s=0, uniform) to yellow (s=0.5) to red (s≥1, stretched).

### Smart Unwrap (one-click solver cascade)

`src/geometry/uv-solvers.js` exposes a solver wrapper that powers the `★ SMART` button in the editor toolbar. The user can pick between two modes:

- **Automatic mode** (default): the cascade runs `square-tutte` first, then `circle-tutte`, then `lscm` if the stretch is above the budget (default 50). Returns the best result + which solver was picked + which were tried.
- **Expert mode**: the user picks the solver from a dropdown (square-tutte, circle-tutte, lscm, smart-uv-project). The dropdown is visually disabled in Auto mode because the cascade ignores it.

Solver IDs:
- `square-tutte` — the square-domain Tutte placement (default — best for cylinder bodies)
- `circle-tutte` — the legacy per-loop circle arcs (for 3+ boundary loops)
- `lscm` — Least-Squares Conformal Mapping (cotangent-weighted, conformal — best for organic shapes)
- `smart-uv-project` — auto-detect seams + dispatch to the best underlying solver (meta-solver, dispatches to `lscm`)

`smart-uv-project` is a **meta-solver**, not a cascade entry: it auto-detects seams (dihedral angle) and dispatches to `lscm` under the hood. It's available as an Expert option but not in the cascade fallback chain (because if `lscm` already failed the budget, re-running it with auto-seams won't help).

Cascade order rationale: `square-tutte` first (fast, good for cylinder bodies), then `circle-tutte` (for 3+ loops), then `lscm` (slowest but best quality, especially on organic shapes). The cascade tries the fast path first and falls back to the slow path only if the budget isn't met — the common case (asteroid body) gets the fast solver, the rare case (complex organic shape) gets the slow solver.

The `★ SMART` button (hotkey `Z`) shows a quality report in the stats line: `★ SMART: 3 islands · 34 seams (5 auto-added) · solver: lscm · max stretch: 460.2× · 12ms`. The user can see exactly what was done and how good the result is.

### LSCM (Least-Squares Conformal Mapping) solver

`src/geometry/uv-unwrapping.js` exports `solveLSCM(island, geometry)` — a real conformal parameterization that eliminates the Tutte corner-pinch distortion. The math:

- **Cotangent weights**: for each edge (i, j), the weight is `(cot(α) + cot(β)) / 2` where α, β are the angles opposite the edge in the two adjacent triangles. For boundary edges (only one adjacent triangle), the weight is just `cot(α)`. Cotangents are clamped to `[-100, 100]` to prevent ill-conditioning on thin triangles.
- **Laplacian**: `L_ii = sum_j w_ij`, `L_ij = -w_ij` for `j ≠ i`. This is the cotangent-weighted Laplacian (not the uniform-weight Laplacian that Tutte uses).
- **Linear system**: for each interior vertex v, `L_vv * u_v + sum_j L_vj * u_j = 0`. For boundary neighbors, move to RHS: `rhs += w * u_boundary`. Solve `A * x = b` with Cholesky (same solver as Tutte).

The boundary placement is the same as Tutte (square for 1- and 2-loop boundaries, circle for 3+). The LSCM difference is in the interior solve, not the boundary.

**Closed-mesh handling**: LSCM pins 2 vertices to unique UV positions (0, 0) and (1, 0) when the island has no boundary (`island.boundary.length === 0` — a fully-closed surface like a sphere, torus, or any genus-g mesh with no user-marked seams). This anchors the otherwise-singular Laplacian system and gives a unique solution. The pinned pair is chosen by the **geodesic-diameter heuristic** (`findDiameterPair`): a Dijkstra double-sweep finds the two vertices with the longest surface (geodesic) distance apart. Using well-separated vertices produces a less-distorted parameterization than picking the first two vertices (which can land on a long-thin triangle's endpoints and force ~area-ratio compression on that face). For degenerate islands with < 2 vertices, `findDiameterPair` returns null, pinning is skipped, and the function falls through to the no-interior early-return path.

Reference: Lévy et al., "Least Squares Conformal Maps for Automatic Texture Atlas Generation" (SIGGRAPH 2002).

## 13. Code Organization (SSOT / SOC)

The project follows two structural rules: **Single Source of Truth (SSOT)** — each tunable value lives in exactly one file, owned by the domain that defines it; and **Separation of Concerns (SOC)** — each file has one responsibility and a small public API.

### Barrel exports

Every top-level `src/` subdirectory exposes a barrel `index.js` for its public API:

| Barrel | Re-exports |
|---|---|
| `src/geometry/index.js` | `Capsule`, `NoisyIcosphere`, UV unwrapping, UV solvers |
| `src/systems/index.js` | collision, events, state, input, starfield, nebula, viewers |
| `src/entities/index.js` | ship, asteroid, bullet, ai |
| `src/ui/index.js` | HUD, debug HUD |
| `src/world/index.js` | constants (chunk/starfield/nebula), mulberry32, makeSimplex2, generateChunk |
| `src/geometry/uv/index.js` | UV unwrapping subdirectory public surface |

Consumers import from the directory, not deep paths, so internals can be refactored freely.

### Constants split

World tunables were previously consolidated in `src/world/constants.js`. They are now split by domain into three files (SSOT, one file per concern):

| File | Owns |
|---|---|
| `src/world/chunk-constants.js` | `CHUNK_SIZE`, `BUBBLE_RADIUS_CHUNKS`, `STREAMING_MARGIN_CHUNKS`, `MIN/MAX_ASTEROIDS_PER_CHUNK`, `DENSITY_FLOOR`, `RECENTLY_EVICTED_TTL_S`, `INITIAL_SYSTEM_SEED`, `MAX_ASTEROID_DRIFT`, `PLAY_PLANE_Y`, `NEBULA_RENDER_THRESHOLD` |
| `src/world/starfield-constants.js` | `STARFIELD_COUNT/RADIUS/SIZE/SEED` |
| `src/world/nebula-constants.js` | `NEBULA_FADE_S/MAX_OPACITY/DEBUG_DEFAULT` |

`src/world/constants.js` is now a re-export shim that re-exports every constant with the same name, preserving the historical `import { X } from './world/constants.js'` API. The `src/world/index.js` barrel imports from the shim.

### Scene / entity tunables (extracted to dedicated files)

| File | Owns |
|---|---|
| `src/entities/ship-constants.js` | `THRUST_ACCEL`, `MAX_SPEED`, `LINEAR_DRAG`, `YAW_SPEED`, `ROLL_MAX`, `ROLL_DAMP` (ship physics) |
| `src/scene/camera-constants.js` | `FOLLOW_DISTANCE`, `FOLLOW_HEIGHT`, `FOLLOW_LOOK_AHEAD`, `CHASE_DAMP`, `YAW_DAMP`, `CAMERA_ROLL_DAMP` (follow-camera behavior) |

`PLAY_PLANE_Y` is owned by the world data-model layer (`src/world/chunk-constants.js`) — the play plane is a world concept, not a ship concept. The ship imports it from the world layer (cross-layer import, one-way: entities → world, no cycle).

`src/scene/index.js` is a barrel re-export for the scene subdirectory (currently just the camera tunables). Other directory barrels follow the same pattern: `src/geometry/index.js`, `src/systems/index.js`, `src/entities/index.js`, `src/ui/index.js`, `src/world/index.js`.
