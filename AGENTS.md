# AGENTS.md — AI Agent Onboarding & Standing Rules

> **You are an AI agent (Claude, GPT, Gemini, or otherwise) about to work on this project.**
> This file is the single source of truth for project state, conventions, and the rules you must follow.
> **Read it in full before doing anything.**

---

## ⛔ MANDATORY RULES (read first, no exceptions)

These rules are set by the project owner and are **standing** — they apply to every agent that takes over this project, without the owner having to repeat them.

### Rule 1: Read this file, SPEC.md, and the recent diff before starting
- Read `AGENTS.md` (this file) end-to-end.
- Read `SPEC.md` to understand the chunked-world data model.
- Run `git log --oneline -20` and `git diff HEAD~5 -- src/ SPEC.md AGENTS.md` (if a git repo exists) to understand recent changes.
- If anything in those files contradicts the user's request, **ask the user** before proceeding.

### Rule 2: Update this file at the end of every working session
- Move completed items from "Next Steps" to "Current State → Done".
- Add new items to "Next Steps" with priority order.
- Update "Open Decisions" if any were resolved or added.
- This is what the next agent will read. If you skip it, the next agent will be lost.

### Rule 3: Follow the established architecture and conventions
- See **§ Architecture** and **§ Conventions** below.
- Do not introduce TypeScript, React, Vue, CSS frameworks, or test frameworks. The project is intentionally vanilla.
- Do not break determinism in the data-model layer (`src/world/`). Use the exported `mulberry32`, `makeSimplex2`, `hashChunk`, `densityAt`, `generateChunk` — never `Math.random()` in chunk generation.
- When adding a new gameplay feature, check whether there's an existing system/entity/script to extend before creating a new one.

### Rule 4: Validate before declaring done
- `npm test` — must pass (currently 21 tests, all green).
- `npm run build` — must succeed.
- If you touched anything visual, also `npm run dev` and use a browser tool to confirm the scene renders.
- If you added tests, run them.

### Rule 5: Document non-trivial decisions in SPEC.md
- Architectural changes, new constants, new data types, new public APIs → update SPEC.md in the same commit.
- Pure code-style changes (renames, refactors with no behavior change) → don't pollute SPEC.md.

### Rule 6: Don't surprise the user
- Do not modify files the user did not implicitly ask you to modify.
- Do not run effectful shell commands (push, commit, install global packages, modify production) without explicit approval.
- If you need to make a significant change beyond the user's clear ask, **ask first**.

---

## Project Overview

**3D Asteroids → Elite** is a 3D, open-space Asteroids MVP that doubles as the foundation for a future Elite-style game.

- **MVP**: a chunked asteroid field, an AI-played demo mode, keyboard-controlled ship, asteroids that split when shot, score, lives, game-over.
- **Future (Elite)**: 6DOF flight, hyperspace, stations, trading, AI ships, procedural galaxy. The MVP is architected so these slot in without refactor.

The game is set in **unbounded open space** (not the classic bounded-and-wrapped Asteroids arena). The ship flies freely through a procedurally-generated, **chunked, deterministic** asteroid field.

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| 3D rendering | Three.js `^0.160.0` | WebGL |
| Dev server / bundler | Vite `^5.0.0` | ESM, fast HMR |
| Language | Vanilla JavaScript (ESM) | No TypeScript |
| Type hints | JSDoc typedefs in `src/world/types.js` | Editor/IDE-driven |
| Tests | `node:test` (built into Node 20+) | No npm test framework |
| Linting | None yet | Add ESLint in a later step if needed |
| Audio | Web Audio API (planned for polish phase) | Defer per MVP scope |
| CSS | Plain CSS in `src/styles.css` | No framework |

## Project Structure

```
.
├── AGENTS.md                 ← you are here
├── README.md                 ← user-facing intro
├── SPEC.md                   ← data-model design spec
├── package.json
├── vite.config.js
├── index.html
├── .gitignore
│
├── src/
│   ├── main.js               ← JS entry, render loop
│   ├── scene.js              ← Three.js scene factory (renderer/camera/lights)
│   ├── styles.css            ← global styles (HUD/overlay/canvas)
│   ├── world/                ← data-model layer (PURE, no Three.js, no DOM)
│   │   ├── constants.js      ← locked constants (CHUNK_SIZE, etc.)
│   │   ├── types.js          ← JSDoc typedefs (Vec3, Chunk, AsteroidSpec, …)
│   │   ├── rng.js            ← mulberry32 PRNG factory
│   │   ├── noise.js          ← seeded 2D simplex noise
│   │   ├── chunks.js         ← hashChunk, densityAt, generateChunk
│   │   └── index.js          ← re-exports
│   ├── entities/             ← (planned) ship.js, asteroid.js, bullet.js, ai.js
│   ├── systems/              ← (planned) input.js, collision.js, spawner.js, particles.js, events.js
│   │   ├── starfield.js      ← procedural Three.js Points starfield
│   │   └── uv-tools/         ← UV editor tool factory split (see "UV editor per-tool split" in Done)
│   │       ├── index.js                  ← barrel
│   │       ├── config.js                 ← UV_EDITOR_CONFIG
│   │       ├── editor-state.js           ← createEditorState (thin getter/setter wrapper)
│   │       ├── geometry-utils.js         ← pointToSegmentDist, orient, hsvToRgb, …
│   │       ├── transforms.js             ← rotationMatrix, scaleMatrix, snapToGrid, …
│   │       ├── transform-tools.js        ← rotateSelection, scaleSelection, mirrorSelection, flipU, flipV, toggleSnap
│   │       ├── translate.js              ← applyTranslate + collectAffectedIndices
│   │       ├── clear-seams.js            ← clearSeams
│   │       ├── frame.js                  ← frameSelection (fit to selection bbox)
│   │       ├── slice.js                  ← startSlice, cancelSlice, executeSlice
│   │       ├── view-toggles.js           ← toggleHeatmap, toggleWireframe, toggleLiveUnwrap
│   │       ├── boundary-seams.js         ← markBoundarySeams
│   │       ├── re-unwrap.js              ← runReUnwrap
│   │       ├── auto-unwrap.js            ← runAutoUnwrap
│   │       ├── smart-unwrap.js           ← runSmartUnwrap
│   │       ├── seam-3d.js                ← toggleSeamFrom3D
│   │       ├── unwrap-io.js              ← saveUnwrap, loadUnwrap
│   │       ├── selection-tools.js        ← growSelection, shrinkSelection, findIslandOfFace, commitBoxSelect
│   │       ├── pick-at-pixel.js          ← pickAtPixel
│   │       ├── draw.js                   ← draw, colorForIsland, ensureTextureLoaded
│   │       └── unwrap-result.js          ← applyUnwrapResult (shared helper for 3 unwrap tools)
│   └── ui/                   ← (planned) hud.js, overlay.js
│
├── scripts/                  ← visual smoke tests (Node-only)
│   ├── dump-field.js         ← ASCII density + asteroid map
│   └── dump-field-svg.js     ← writes field.svg
│
├── tests/
│   └── world.test.js         ← node:test suite (21 tests)
│
└── field.svg                 ← generated by dump-field-svg.js (gitignored)
```

## Current State

### ✅ Done

- [x] **Data-model spec locked** — `SPEC.md` with constants table, types, seed strategy, density function, chunk generation pseudocode, streaming bubble, determinism guarantees, performance budget, Elite hooks.
- [x] **Data-model implemented** — `src/world/{constants,types,rng,noise,chunks,index}.js`. Pure functions, no side effects.
- [x] **Unit tests** — `tests/world.test.js` (21 tests) covering determinism, ranges, generation rules, axes/drift validity. All green via `npm test`.
- [x] **Visual smoke tests** — `scripts/dump-field.js` (ASCII) and `scripts/dump-field-svg.js` (SVG). Both verified end-to-end (1800 chunks, ~10K asteroids, healthy distribution).
- [x] **Vite + Three.js scaffold** — `package.json`, `vite.config.js`, `index.html`, `src/main.js`, `src/scene.js`, `src/styles.css`, `src/systems/starfield.js`. Builds clean (~120 KB gzipped) and dev server returns HTTP 200.
- [x] **Scene verified in browser** — fullscreen canvas, starfield, lights, ship renders cleanly, no console errors.
- [x] **Ship entity** — `src/entities/ship.js`: faceted 4-sided-pyramid body + cyan wings + emissive engine glow (intensity reacts to thrust). 2DOF controller (thrust + yaw), on/off throttle, framerate-independent linear drag, world-space position, speed cap. API: `setThrust`, `setYaw`, `setFlightMode('2dof' | '6dof')`. 6DOF **throws** so the seam is visible — implement it before flipping the mode. **Ship lean (roll)**: a `body` sub-group inside the outer `mesh` carries the visual roll; yaw is applied to the outer group, roll to the body group. Target roll = `yawInput * ROLL_MAX = ±0.45 rad` (~26°), damped toward target with `1 - exp(-ROLL_DAMP * dt)` where `ROLL_DAMP = 8.0` (time constant 0.125s, framerate-independent). Sign convention: positive yaw input (left turn) → positive Z rotation → left wing dips (lean into the turn). The AI ship picks up the lean automatically because `ai.js` drives `setYaw` + `update` the same way `input.js` does. `reset()` clears both yaw and roll. 9 unit tests in `tests/ship.test.js` (236/236 green total).
- [x] **Follow-the-ship camera** — `src/scene.js` `setChaseTarget(ship)` + `updateCamera(dt)`. Default view: camera sits 22 units behind the ship along its facing direction, 7 units above the play plane, looking at a point 6 units in front of the ship. Yaw-relative offset is computed from the chase source's `rotation.yaw` (matches `ship.js`'s convention: yaw 0 = facing -Z). World-space chase (offset = (0, 7, 22), no look-ahead) is the fallback for non-ship chase sources. **Boom-arm yaw damping** (`YAW_DAMP = 4.0`): the camera's *offset direction* lags the ship's actual yaw via wrap-aware exponential damping (`wrapAngle` helper, `1 - exp(-YAW_DAMP * dt)`), so the camera always stays at a constant radius from the ship on sharp turns (no more "bumping through" the ship on 180° turns). The look-ahead point still uses the ship's *actual* yaw so the player sees where they're going. **Bank-follow** (`CAMERA_ROLL_DAMP = 6.0`): after `camera.lookAt`, the camera also `camera.rotateZ(smoothedRoll)` to match the ship's `rotation.roll` (its lean). Sign convention: positive ship roll (left wing dips) = positive `camera.rotateZ` (right side of view goes up) = same "banked left" feel. Damping uses the same `1 - exp(-CAMERA_ROLL_DAMP * dt)` pattern as the yaw damp, with `smoothedRoll` seeded in `setChaseTarget` for ship sources. The roll-damp block runs unconditionally so that `setChaseTarget(null)` or a non-ship chase source fades the bank out to 0 over a few frames. The AI demo ship picks up the bank-follow for free (it uses the same `createShip` factory, so its `rotation.roll` is wired up the same way the player's is). Position damping (`CHASE_DAMP = 6.0`) handles snap-prevention on target switch / respawn. `smoothedYaw` + `smoothedRoll` are seeded in `setChaseTarget` on ship sources (and lazily in `updateCamera` on the first frame as a safety net) so the camera doesn't sweep on target switch. The previous world-space `setCameraOffset(offset)` API was removed — the follow camera is the only mode. **State-aware target** (in `src/main.js`): a `setCameraForState(state)` function and state:changed subscriber switch the chase target between the AI demo ship (DEMO) and the player ship (PLAYING + GAME_OVER), so the same single follow camera is used for both ships. The initial target is seeded at boot via `setCameraForState(stateMachine.getState())` since the state machine doesn't fire on the initial state.
- [x] **Placeholder input shim** — inline in `src/main.js` (arrow keys / WASD). Replaced by `src/systems/input.js` in the next step.
- [x] **Asteroid entity** — `src/entities/asteroid.js`: `createAsteroidFromSpec({ spec, scene })` builds a **`THREE.Group`** containing one of two body types (picked deterministically from `spec.seed & 1`, no rng consumption): **type 0 = noisy icosphere with LOD** ("irregular rock"), **type 1 = capsule** ("potato" with bumpy surface). The icosphere body (`buildNoisyIcosphereBody`) is a **`THREE.LOD` with 3 levels** sharing the same per-instance noise offsets (ox, oy, oz from rng) and noise parameters: detail 2 (162 vertices) at distance 0, detail 1 (42 vertices) at distance 30, detail 0 (12 vertices) at distance 100. Noise: fbm at 4 octaves, `amount = 0.25 × radius`, `scale = 2.0 / radius`. The capsule body (`buildCapsuleBody`) is a single `Capsule(radius, radius*1.5, 4, 8)` mesh with `geom.jitter(radius*0.15, rng)` for a visibly bumpy "potato" surface (merged-vertex topology + clean normal-direction displacement → 0 back-facing triangles at this amount, see `tests/capsule.test.js` for the regression guard + 6× tripwire). Both builders return `{ lowestY, lod }`; the LOD reference is stashed on `group.userData.lod` so the entity's `update(dt, camera)` can call `lod.update(camera)` each frame. **Both body types share a single `MeshStandardMaterial`** with a full 4-map PBR texture set, each loaded once at module scope via lazy loaders in `src/entities/asteroid.js`: `getAsteroidAlbedo()` (sRGB), `getAsteroidNormal()`, `getAsteroidRoughness()`, `getAsteroidBump()` (the latter three use `NoColorSpace` to skip sRGB decoding — critical for data textures, otherwise the lighting silently corrupts). The 4 textures are cropped from the user-provided 2048×2048 atlas `public/textures/asteroid-1.png` (a 2×2 grid of albedo/normal/roughness/bump separated by a ~10px black outline); the crops are 1px-margin from the separator and resized to exact 1024×1024 (power-of-two) with `magick … -resize 1024x1024!`. Material params: `metalness: 0.1`, `roughness: 0.9` (icosphere) / `0.85` (capsule) — becomes a multiplier when `roughnessMap` is set, `bumpScale: 0.05` (subtle relief), `flatShading: true` for the faceted rock look. The icosphere inherits its UV attribute from the underlying `IcosahedronGeometry` (built-in spherical projection); the capsule calls `geom.computeUVs()` AFTER `geom.jitter(...)` so the cylindrical UV unwrap aligns with the displaced surface. Regression tests in `tests/asteroid-textures.test.js` (file existence + PNG signature + 1024×1024 dimensions + black-separator exclusion). See `CREDITS.md` for the Nano Banana / Gemini source + the crop/resize commands. **DEBUG: adaptive square ground footprint** (PlaneGeometry, `2×spec.radius` across, semi-transparent dark `0x1a2a3a` at opacity 0.55, `side: DoubleSide`, `depthWrite: false`) — positioned at `bodyLowestY - 0.15×R`. The ground rotates with the group. `split()` returns 0–2 smaller child specs. `dispose()` iterates the group's children, disposing each child's geometry + material. A no-op `rng();` after `mulberry32(spec.seed)` preserves the original rng sequence start. Wired into `src/main.js` as a hard-coded 3x3 demo field around the origin (replaced by streaming in the next step). Render loop in main.js: `for (const a of demoAsteroids) a.update(dt, camera);` — the camera is required for the icosphere's LOD update.

- [x] **Debug HUD** — `src/ui/debug-hud.js`: `createDebugHud({ fpsSampleWindowSeconds=0.5, minUpdateIntervalMs=80 })` returns `{ mount, update, dispose }`. Bottom-left overlay showing real-time diagnostics: FPS (sampled over a 0.5s sliding window of frame times), current state-machine state (DEMO/PLAYING/GAME_OVER), score, lives, asteroid count, **total scene vertex count** (sum of `geometry.attributes.position.count` across all `Mesh` objects), **total scene triangle count** (indexed: `geometry.index.count / 3`, non-indexed: `position.count / 3`), and the live world positions of the camera and the player ship. Pure DOM (no framework, no Three.js). DOM writes are throttled to ~12Hz via a `requestAnimationFrame` scheduler to avoid layout thrash at 144Hz+ frame rates. The scene geometry is computed per-frame by `countSceneGeometry(scene)` in `src/main.js` (O(N) in mesh count, <0.1ms for ~200 meshes, safe to call every frame). `isMesh` filtering excludes the starfield (`THREE.Points`) and lights — the count is the actual rasterization work for the asteroid field + ship + bullets + debug grounds. `index.html` adds the `#debug-hud` container with `data-debug="<name>"` value cells. `src/styles.css` adds `.debug-hud-row`, `.debug-hud-label`, `.debug-hud-value`, `.debug-hud-section`, `.debug-hud-divider` styles (bottom: 12px, left: 12px, dark semi-transparent background with cyan accents). Wired into `src/main.js` render loop: `debugHud.update({ state, score, lives, asteroidCount, sceneVerts, sceneTris, camera, ship })` after `renderer.render(...)`.
- [x] **`NoisyIcosphere` geometry** — `src/geometry/noisy-icosphere.js`: custom `NoisyIcosphere` class extending `THREE.BufferGeometry`. Built on `THREE.IcosahedronGeometry` (which is non-indexed: each face has 3 vertex copies). **Position-based noise displacement**: for each vertex, fbm noise is computed from the ORIGINAL pre-noise position (with per-instance offsets `ox,oy,oz`), so the 3 copies of a vertex get the same noise value and the same displacement — the faces stay connected and the surface cannot tear. This avoids the `mergeVertices` workaround that didn't work in some environments. Noise function: deterministic GLSL-style hash3D + smoothstep + 4-octave fbm, normalized to [0, 1]. Displacement is `(noise - 0.5) * 2 * noiseAmount` along the radial direction. Parameters: `radius`, `detail` (0–4), `noiseAmount`, `noiseScale`, `offsetX/Y/Z` (per-instance). **9 unit tests in `tests/noisy-icosphere.test.js`**: non-indexed geometry, vertex count matches IcosahedronGeometry for each detail, position itemSize=3, noise keeps vertices within `[radius - amount, radius + amount]`, zero noise = perfect sphere, deterministic (same params → same output), different offsets → different shapes, **faces stay connected** (3 copies of each vertex end up at the same post-noise position — the key invariant, verified by grouping vertices by pre-noise position and checking post-noise positions match), all vertices finite, wide parameter range handled.
- [x] **Tetrahedron removed** — `src/geometry/tetrahedron.js` and `tests/tetrahedron.test.js` deleted. The tet cluster looked like "a bunch of tetras, not an asteroid" and was superseded by the noisy icosphere. The Tetrahedron class was an experimental helper that the user explicitly asked to remove.
- [x] **`Capsule` geometry** — `src/geometry/capsule.js`: custom `Capsule` class extending `THREE.BufferGeometry`. **Rewritten from scratch** with a clean merged-vertex (indexed) topology. Includes a `computeUVs()` instance method for cylindrical unwrap (`U = atan2(z, x) / (2π) + 0.5`, `V = (y - yMin) / (yMax - yMin)`) — called after `jitter()` so the UVs align with the displaced surface. Built from a cylindrical body + two hemispherical caps, all in one indexed mesh. Body = 2 rings × (radialSegments+1) vertices; each cap = (capSegments-1) intermediate rings × (radialSegments+1) + 1 pole (the first cap ring is shared with the body's end ring). For default params (`radius=1, length=1, capSegments=4, radialSegments=8`) that's 74 unique vertices and 128 triangles. CCW outward-facing winding for body and both caps (top cap and bottom cap have opposite windings because they're on opposite sides — hand-verified cross-product check). DRY ring-quad helper (`pushRingQuads(ringLoStart, ringHiStart, flipWinding)`) handles both caps with a single function. **The "local z axis" at any surface vertex is the outward surface normal** — body vertices are purely radial, cap-ring vertices have a Y component (positive at the top cap, negative at the bottom cap, growing toward the pole), poles point straight up/down. `.jitter(amount, rng)` instance method offsets each vertex **along its local z axis (the vertex normal)** by `(rng()*2-1)*amount` and re-computes vertex normals so the new surface lighting stays correct. The index buffer is never modified, so the shared-vertex topology is preserved — no holes by construction. **17 unit tests in `tests/capsule.test.js`**. The "no back-facing triangles" test asserts `backFacing === 0` out of 128 triangles at the production 15% jitter amount (empirically verified: 0 at 15–30%, 5/128 at 50%). The 6× tripwire test (90% jitter) documents the upper limit and catches regressions. The previous "no severe holes (<=15)" threshold-based test was a band-aid for an old cap-geometry vulnerability — the clean normal-direction displacement doesn't have that vulnerability, so a strict `=== 0` assertion is the right check.
- [x] **Input system** — `src/systems/input.js`: `createInputSystem({ ship, onFire, onStart, getGameState })` returns `{ state, update, dispose }`. W/A/D + Arrow keys for ship movement (held-key model). Space → `onFire` rising edge. Any key → `onStart` rising edge in DEMO only. Architecture is split for testability: `createInputState()` (pure), `bindKeyboard()` (thin DOM wrapper, no-op in Node), `tickInput()` (pure per-frame application). 20 unit tests in `tests/input.test.js` (41 tests total, all green). `onFire`/`onStart` log for now; will be wired to bullets + state machine in their respective steps.
- [x] **Bullets** — `src/entities/bullet.js`: `createBulletPool({ scene, capacity? })` returns a fixed-size object pool of pre-allocated Three.js meshes (shared `SphereGeometry` + `MeshBasicMaterial`, `toneMapped: false` for that bright pop). `fire({ origin, direction, speed? })` returns the bullet index, or `-1` on cooldown / pool exhausted / missing args / zero-length direction. Default speed 400 u/s, fire cooldown 0.18s (≈5.5 shots/sec), lifetime 1.5s. `update(dt)` integrates + despawns; `dispose()` releases geometry + material. 18 unit tests in `tests/bullet.test.js` (59 tests total, all green). Wired into `src/main.js`: `onFire` is now `fireFromShip()` that uses the ship's yaw to compute the forward direction, and `bullets.update(dt)` runs in the render loop.
- [x] **Narrow-phase collision** — `src/systems/collision.js`: pure sphere-sphere overlap (`spheresOverlap` — squared-distance compare, strict `<`). `findBulletHits` returns `{ bulletIndex, asteroidIndex }` pairs; one bullet → at most one asteroid, but multiple bullets can hit the same asteroid (caller de-dups with a `Set`). `findShipHit` returns the first asteroid index that hits the ship, or `-1`. `scoreForSize` looks up `SCORE_BY_SIZE` (frozen: large=20, medium=50, small=100). `BULLET_RADIUS=0.15`, `SHIP_RADIUS=1.4`. **27 unit tests** in `tests/collision.test.js` (86 tests total, all green). Wired into `src/main.js` `processCollisions()`: de-dupes asteroid removals, applies them in reverse order, despawns parent + spawns children for each bullet hit, scores, handles ship hits (lives--, reset ship, game over at 0). `onStart` restarts after game over. `bullets.despawn(index)` added to the pool so the collision layer can mark bullets as hit.
- [x] **Event bus + state machine** — `src/systems/events.js` (pure pub/sub: `on`/`off`/`emit`/`clear`, snapshot iteration for in-dispatch removal safety, argument validation). `src/systems/state-types.js` (frozen `State` enum: DEMO / PLAYING / GAME_OVER). `src/systems/state.js` (`createStateMachine({ initial, events? })` with allowed-transition table DEMO↔PLAYING↔GAME_OVER, illegal transitions return `false` silently, `subscribe` returns unsubscribe, `serialize`/`deserialize` round-trip the state name). **44 unit tests** across `tests/events.test.js` and `tests/state.test.js` (131 tests total, all green). Wired into `src/main.js`: real `getGameState` from the machine, `onStart` triggers DEMO→PLAYING (start) or GAME_OVER→PLAYING (restart via `resetRunState`), `processCollisions` calls `machine.transition(GAME_OVER)` on player death, emits `score:changed` / `lives:changed` / `game:over` / `state:changed` events. State-change log subscriber for dev visibility. The upcoming HUD layer will subscribe to `score:changed` + `lives:changed`. **`tickInput` in `src/systems/input.js` gates `onStart` to fire in DEMO *or* GAME_OVER** (start / restart) — the original "DEMO only" gate was a bug that swallowed the restart keypress.
- [x] **HUD** — `src/ui/hud.js`: `createHud({ bus, initialState? })` returns `{ mount(rootEl), dispose() }`. Subscribes to `score:changed`, `lives:changed`, `state:changed`, `game:over` on the event bus. The optional `initialState` seed is applied at mount time (runs the same `onStateChanged` handler with `{ from: null, to: initialState }`) — required because the state machine doesn't fire a `state:changed` event for its initial state, so without the seed the message keeps the bare `.hud-message` class (centered, no flash) until the first transition out and back. `main.js` passes `initialState: stateMachine.getState()`. State-aware messaging: DEMO → **bottom-anchored**, **arcade-blinking** cyan `PRESS ANY KEY TO START` (500ms on / 500ms off = 1Hz blink, `step-end` hard transition — like an old-school attract screen). The `.hud-message--demo` modifier overrides the centered base with `align-items: flex-end; padding-bottom: var(--space-5)` so the start prompt sits at the bottom of the screen; the GAME_OVER message, which shares the base class, stays centered via the unmodified base rule. PLAYING → hidden; GAME_OVER → centered red `GAME OVER — PRESS ANY KEY TO RESTART` (plus `game:over` event → message with final score). Pure DOM (no framework, no Three.js). `formatScore(n)` helper pads to 6 digits, handles negatives / NaN / Infinity / non-numbers safely. `index.html` adds `data-hud` elements inside the existing `#hud` and `#overlay` containers. `src/styles.css` adds `.hud-score` / `.hud-lives` (top bar, monospace uppercase), `.hud-message` (centered, 32px), `.hud-message--demo` (cyan, bottom-anchored, 1Hz blink driven by JS in `src/ui/hud.js`), `.hud-message--gameover` (red, centered, no animation), `.hud-message--hidden` (`display:none`). Wired into `src/main.js` via a combined root that `querySelector`s both `#hud` and `#overlay`. **23 unit tests in `tests/hud.test.js` (182/182 green total)**. Two test-helper bugs were found and fixed: (1) mock `querySelector` used `Object.prototype.hasOwnProperty.call(map, sel)` which is always false for `Map` (Maps don't expose entries as own properties) — replaced with `map.has(sel)`; (2) the dispose-test asserted `LIVES: 1` post-dispose but never emitted `lives:changed` before dispose (so the value stayed at the initial `LIVES: 3`) — added a pre-dispose emit to make the assertion meaningful. The 4 new `initialState` tests cover the DEMO/PLAYING/GAME_OVER seed paths + the no-seed backward-compat path.

- [x] **Demo AI** — `src/entities/ai.js`: pure `aiBrainTick({ aiPos, aiYaw, asteroids, time, ... })` returns `{ yaw, thrust, mode }` with priority dodge (asteroid within `dodgeDist=14` → thrust perpendicular to escape) → target (asteroid within `targetDist=90` → steer toward nearest) → wander (random heading, refreshed every `wanderTurnPeriod=2.5`s). Pure helpers `findNearestAsteroid`, `shouldResetAi`, `pickAiSpawn`. Factory `createDemoAi({ scene, asteroids, options })` wires the brain to `createShip` (same mesh as player) via injectable `shipFactory` + `rng` for testability. Resets to a random spawn position if the ship drifts beyond `resetDist=220` from origin. **31 unit tests in `tests/ai.test.js` (182/182 green total)**. Wired into `src/main.js` as a visible NPC **only in DEMO state** — a `state:changed` subscriber in `main.js` toggles the AI's `mesh.visible` based on `to === State.DEMO`, so the player only sees their own ship during PLAYING and GAME_OVER. The AI's `update()` loop runs every frame regardless (cheap); only the mesh is hidden. Never collides with the player (infinite lives; the collision layer only checks the player ship). One test bug found and fixed: the `getMode` test was non-deterministic because the AI could spawn up to 30 units from origin, so the (5, 0) test asteroid sometimes fell outside `dodgeDist=14` (into `target` mode); fixed by injecting a deterministic `rng: () => 0`.
- [x] **Nebula background** — `src/systems/nebula-background.js`: `createNebulaBackground({ imageUrl, radius?, widthSegments?, heightSegments? })` returns `{ mesh, mount(scene), update(camera), dispose() }`. Large inside-out `THREE.SphereGeometry` (radius 5000) textured with a bundled equirectangular skydome. **Asset paths: `/bgnebula/bgnebula-2.png` (2K, default) and `/bgnebula/bgnebula-2k.png` (1K, data-saver fallback)** — held in the `NEBULA_IMAGE_URL_2K` / `NEBULA_IMAGE_URL_1K` constants at the top of `src/scene.js`. `pickNebulaUrl()` auto-selects the 1K variant for `navigator.connection.saveData` or `prefers-reduced-data` clients. The current asset is user-generated with **Nano Banana (Google Gemini)** at 2912×1440 (essentially 2:1 equirectangular, 2.02:1). See `CREDITS.md` for the full iteration history (Wikipedia Horsehead → ESA Horsehead → Carina → v1 skydome → v2 bgnebula). `EquirectangularReflectionMapping` wraps the 2D image around the sphere. `side: BackSide`, `renderOrder: -1`, `depthWrite: false`, `fog: false` (keeps the nebula crisp through the scene fog), `frustumCulled: false` (the sphere is intentionally huge). `update(camera)` follows the camera each frame so the player always feels "inside" the nebula. Defensive try/catch around `THREE.TextureLoader` falls back to a stub `THREE.Texture` in non-browser environments (Node tests, SSR) so the rest of the module is still testable. **12 unit tests in `tests/nebula-background.test.js` (223/223 green total)**. Wired into `src/scene.js`: created in `createScene()`, `mount(scene)` adds it to the scene, `update(camera)` is called at the end of `updateCamera(dt)` so the nebula position is finalized for the frame, and the `createScene` return now exposes a `dispose()` that releases the nebula's texture + geometry + material. The starfield and nebula coexist — starfield is the "near stars" (radius 2500, points), nebula is the "distant gas" (radius 5000, sphere projection). The data-model layer also exposes a `NEBULA_RENDER_THRESHOLD = 0.3` constant + `chunkHasNebula(id)` pure function for the future per-chunk nebula-volume streaming layer (the single global skydome is unrelated; this hook is for the eventual "which chunks get their own nebula volume" decision).

- [x] **Code organization cleanup (SSOT + SOC)** — The codebase had two large monolithic files (`src/geometry/uv-unwrapping.js` at 1771 lines, `src/world/constants.js` mixing 3 domains) and no barrel exports. Refactored:
  - **4 barrel exports added**: `src/geometry/index.js`, `src/systems/index.js`, `src/entities/index.js`, `src/ui/index.js`. Consumers can now import from the directory instead of deep paths.
  - **Constants split** (SSOT): `src/world/constants.js` → 3 domain files (`chunk-constants.js`, `starfield-constants.js`, `nebula-constants.js`). The old `constants.js` is now a re-export shim. `src/world/index.js` updated.
  - **`uv-unwrapping.js` split** (SOC): 1771-line monolith → 10 focused files under `src/geometry/uv/` (one per concern: edge-keys, island-detection, tutte, lscm, abfpp, stretch, walk-edge-loop, packing, seam-detection, reunwrap) + barrel `index.js`. The old `uv-unwrapping.js` is now a re-export shim. Public API surface (12 symbols) is preserved exactly.
  - **All 327 tests pass; build succeeds.** No behavior change. Dependency graph is acyclic.

- [x] **Tunables extraction (SSOT)** — The ship and camera tunables were previously inlined as `const` declarations inside `src/entities/ship.js` and `src/scene.js`. Extracted to two dedicated constant files:
  - `src/entities/ship-constants.js` — `THRUST_ACCEL`, `MAX_SPEED`, `LINEAR_DRAG`, `YAW_SPEED`, `ROLL_MAX`, `ROLL_DAMP` (ship physics).
  - `src/scene/camera-constants.js` — `FOLLOW_DISTANCE`, `FOLLOW_HEIGHT`, `FOLLOW_LOOK_AHEAD`, `CHASE_DAMP`, `YAW_DAMP`, `CAMERA_ROLL_DAMP` (follow-camera behavior).
  - `src/scene/index.js` — barrel re-export for the scene subdirectory (consistency with the other directory barrels).
  - **SSOT fix**: `PLAY_PLANE_Y` is owned by the world data-model layer (`src/world/chunk-constants.js`). The ship imports it from there (one-way cross-layer import, no cycle). Removed the duplicate `PLAY_PLANE_Y` from `ship-constants.js`.
  - All 327 tests pass; build succeeds. No behavior change.
- [x] **Square-domain Tutte placement** — `src/geometry/uv-unwrapping.js`: replaces the legacy circle-domain Tutte boundary placement with a square-domain placement that produces a clean rectangle unwrap for 1- and 2-loop boundaries (the "theta" case: cylinder body with both ends open and one longitudinal seam). Three placement cases: **1 loop** → full unit-square perimeter (clockwise from (0,0)); **2 loops** → top loop on y=1, bottom loop on y=0, shared vertex at (0,·); **3+ loops** → fall back to per-loop circle arcs. Drops the capsule body's max stretch from ~1100× (folded mess) to ~460 (visually correct rectangle, still pinched at corners). `findAllBoundaryLoops(geometry, island, seamKeys)` uses a greedy walk to return all independent cycles in the boundary graph (1 for a simple ring, 2 for a theta graph). `walkBoundaryLoop` and the `island.boundaryLoop` field are removed (replaced by the multi-loop walker); JSDoc for `Island` updated to `{ faces, boundary }`. **Fundamental limits of Tutte-on-square** (documented in SPEC.md §12): the `< 1.0` stretch target is mathematically unreachable for the test setup due to (1) area compression from packing 3 islands into [0,1]² (min stretch ~28) and (2) Tutte corner-pinch on the unit square (~14× on faces adjacent to corners). Total: ~400-500 max stretch. Truly < 1.0 would require LSCM, ABF++, or dropping the packing. Tests updated: "boundary vertices lie on a circle" → "lie on the unit square perimeter" (uses `island.boundary`); "body island should be wider than tall" → "should fill most of its packing cell" (square placement forces 1:1 aspect); removed the misleading "isolated body" test (corner-pinch dominates, not packing compression). **15 unit tests in `tests/uv-unwrapping.test.js` (305/305 green total, build succeeds)**.
- [x] **Smart Unwrap button** — `src/geometry/uv-solvers.js` (NEW) + `src/systems/uv-unwrap-viewer.js` modifications. The `★ SMART` button (hotkey `Z`) is a one-click cascade that auto-picks the best solver. **Two modes**: Automatic (cascade: square-tutte → circle-tutte → lscm, stops when stretch ≤ budget [default 50]) and Expert (manual solver pick via dropdown). The dropdown is visually disabled (opacity 0.4) in Auto mode because the cascade ignores it. **Solver IDs**: `square-tutte` (default — best for cylinder bodies), `circle-tutte` (legacy per-loop circle arcs, for 3+ boundary loops), `lscm` (Least-Squares Conformal Mapping, cotangent-weighted, conformal — best for organic shapes), `smart-uv-project` (meta-solver: auto-detect seams + dispatch to lscm). Note: `smart-uv-project` is NOT in the cascade fallback chain because re-running lscm with auto-seams after it already failed the budget is wasted work — it's still available as an Expert option. **Quality report** in the stats line: `★ SMART: 3 islands · 34 seams (5 auto-added) · solver: lscm · max stretch: 460.2× · 12ms`. The user can see exactly what was done and how good the result is. xatlas is not available on npm (checked), so the Automatic path uses our hand-rolled solvers as the best available options. **Hotkey 'Z'** (not 'S' — would conflict with scale-up). **15 unit tests in `tests/uv-solvers.test.js` (324/324 green total, build succeeds)**.
- [x] **LSCM (Least-Squares Conformal Mapping) solver** — `src/geometry/uv-unwrapping.js`. Real conformal parameterization that eliminates the Tutte corner-pinch distortion. **Math**: cotangent-weighted Laplacian (not the uniform-weight Laplacian that Tutte uses). For each edge (i, j), the weight is `(cot(α) + cot(β)) / 2` where α, β are the angles opposite the edge in the two adjacent triangles. For boundary edges, the weight is just `cot(α)`. Cotangents are clamped to `[-100, 100]` to prevent ill-conditioning on thin triangles. **Solve**: build sparse cotangent Laplacian → set up linear system with boundary conditions → solve with Cholesky (same solver as Tutte). **Boundary placement**: same as Tutte (square for 1-2 loops, circle for 3+). **Closed-mesh handling**: when `island.boundary.length === 0` (a fully-closed surface — sphere, torus, any genus-g mesh with no user-marked seams), LSCM pins 2 vertices to (0, 0) and (1, 0) via the **geodesic-diameter heuristic** (`findDiameterPair`): a Dijkstra double-sweep finds the two vertices with the longest surface (geodesic) distance apart, then treats them as boundary. This anchors the otherwise-singular Laplacian system and gives a well-conditioned solve. For degenerate islands with < 2 vertices, `findDiameterPair` returns null, pinning is skipped, and the function falls through to the no-interior early-return path. **API**: `solveLSCM(island, geometry)` exported alongside `computeTutteEmbedding`. **Integration**: `reunwrap(geometry, seamKeys, opts)` accepts `opts.solver = 'tutte' | 'lscm' | 'abf++'`. **5 LSCM tests in `tests/uv-unwrapping.test.js`** (finite UVs, boundary on unit-square perimeter, valid result on capsule, closed-mesh pinning with stretch-boundedness, lscm option in reunwrap). **327/327 green total, build succeeds**.
- [x] **ABF++ (Angle-Based Flattening) solver** — `src/geometry/uv-unwrapping.js`. Iterative angle-distortion minimizer for meshes with sharp creases. **Energy**: `E = sum over triangles T of sum over angles alpha in T of (alpha_2D - alpha_3D)^2 / max(alpha_3D, 1e-6)`. The `/alpha_3D` normalizes by the target angle, so small angles dominate the energy (these are the hardest to preserve and the most visually noticeable when distorted). **Algorithm**: gradient descent with **NUMERICAL gradient** (central differences, `eps=1e-6`). Initializes from LSCM (good conformal starting point), then refines toward angle-preservation. Default 20 iterations, `learningRate=0.05`, convergence when energy change is below `1e-6 * energy`. **API**: `solveABFPlusPlus(island, geometry, opts)` exported alongside `solveLSCM`. **Simplified version**: this is a simplified ABF++ (no L-BFGS, no analytical gradients, no explicit cone handling). The full algorithm (Sheffer, Lévy, Mōri, Surazhsky 2005) uses L-BFGS with analytical gradients and explicit cone handling for ~10x faster convergence. For typical asteroid meshes (50-200 vertices per island), the simplified version completes in < 100ms per island. **Cascade**: ABF++ is the 4th entry in the Smart Unwrap cascade (after square-Tutte, circle-Tutte, and LSCM). It's the slowest solver but the highest-quality for meshes with sharp creases. **2 ABF++ tests in `tests/uv-unwrapping.test.js`** (finite UVs, dispatch from reunwrap with `solver: 'abf++'`). **327/327 green total, build succeeds**.

- [x] **UV editor per-tool split (19 tool factories + 1 state factory + 1 shared helper)** — The 2700+ line `src/systems/uv-unwrap-viewer.js` was a monolithic orchestrator with ~1000 lines of inline tool logic. Refactored to a thin orchestrator + 19 tool factories, each owning one tool (or a small related group) and reading/writing state through a shared `state` interface. See the **"UV editor tool factory pattern"** section in Architecture below for the factory shape, the `state`/`deps` contract, and the late-bound-DOM pattern. **Tools extracted** (one file per tool under `src/systems/uv-tools/`): `transform-tools.js` (rotate/scale/mirror/flip/toggleSnap), `translate.js`, `clear-seams.js`, `frame.js`, `slice.js`, `view-toggles.js`, `boundary-seams.js`, `re-unwrap.js`, `auto-unwrap.js`, `smart-unwrap.js`, `seam-3d.js`, `unwrap-io.js`, `selection-tools.js`, `pick-at-pixel.js`, `draw.js`, `pick-3d.js`, `panel-window.js`, `compute-layout.js`, `hotkeys.js`. **Shared helper**: `applyUnwrapResult` (`unwrap-result.js`) used by the 3 unwrap tools. **Barrel**: `src/systems/uv-tools/index.js` re-exports the state factory, all 19 tool factories, the helper, the config, the pure 2D geometry math, and the pure 2D affine transform matrix builders. **Bug found and fixed**: `toggleBackground` was calling `state.getBackgroundMode()` / `state.setBackgroundMode(...)` but the orchestrator's state bindings were missing the two methods → would have thrown `undefined is not a function` at runtime. **Dead code removed**: `const SNAP_STEP` local, the `parseKeyToVerts` function, and unused imports. **All 331 tests pass; build succeeds.** No public API change (the 2700-line refactor is behavior-preserving).

- [x] **UV editor inline-code extraction (final cleanup)** — The 15-tool split extracted the per-tool logic, but the orchestrator still owned ~800 lines of cross-cutting code in 4 areas. Extracted all 4 to dedicated tool factories: (1) **3D picking handlers** (`onCanvas3DClick` / `onCanvas3DPointerMove` / `clearHover` / `pickEntity` / `rebuildMeshMap` / `applyHover` / `pickAt3D`) → `pick-3d.js` with `createPick3DTool` (raycaster + meshToEntity cache + canvas event handlers); (2) **Panel drag/resize handlers** (`onPanelHeaderDown` / `onResizeGripDown` / `onWindowPointerMove` / `onWindowPointerUp` / `persistPanelRect` / `resizeCanvas`) → `panel-window.js` with `createPanelWindowTool` (localStorage persistence + viewport-clamp math); (3) **Layout computation** (`computeLayout` — faces, edgeToFaces, seamEdges, faceAdj, islands, uvs arrays) → `compute-layout.js` with `createComputeLayoutTool` (stateless — every call returns a fresh object); (4) **Tool dispatch + keydown** (`handleTool` + `onKeyDown`) → `hotkeys.js` with `createHotkeysTool` (the toolbar-button dispatch table + the global keydown handler with Ctrl+S / Ctrl+O save/load shortcuts). **Bug found and fixed**: the `Escape` key in slice mode previously read the orchestrator's local `let mode` variable directly; now correctly uses `state.getMode()` (so the dispatch table reads from the same source of truth as the rest of the editor). **Orchestrator shrank from 2735 lines → ~1300 lines** of orchestration + late-bound-DOM event wiring. **All 331 tests pass; build succeeds.** No public API change.

- [x] **World streaming** — `src/world/world.js`: pure streaming layer that sits one layer above `chunks.js`. Public API: `createWorld({ systemSeed, bubbleRadiusChunks?, marginChunks?, chunksPerFrame? })`, `worldToChunk(pos)` (pure coord math), `chunkKey(cx, cz)`, `updateStreamingBubble(world, shipPos, nowS)` (returns `{ added, reactivated, evicted, totalActive }`), `evictStaleChunks(world, nowS)`, `getActiveChunks(world)`. State machine per chunk: `empty → active (generateChunk) → recentlyGone { chunk, evictedAt } (on bubble exit) → active (reactivation, no re-gen) → dropped (after RECENTLY_EVICTED_TTL_S=10s)`. `chunksPerFrame` is an opt-in per-frame generation cap (default `Infinity`; the MVP ships at Infinity because the 49-chunk first-frame spike is <2ms). **All 21 new tests in `tests/world.test.js` pass (352 total); build succeeds.** Wires into `src/main.js`: replaced the hard-coded 3×3 demo field (`respawnAsteroids`) with a real streaming bubble. New module-scope state: `world`, `entityByChunkKey` (Map<chunkKey, entity[]>), `streamTimeS` (wall-clock accumulator). New helpers: `spawnChunkEntities`, `despawnChunkEntities` (reverse-order splice for index stability), `clearAllAsteroids` (full reset on `resetRunState`). The render loop's tick now calls `updateStreamingBubble` after `ship.update` and before the per-asteroid `update`/`processCollisions` pass, so newly-spawned asteroids get their first update + collision check on the same frame. The `chunkHasNebula` opacity call switched from inline `Math.floor` math to `worldToChunk(ship.position)`. Stream time pauses with gameplay (early-returns for `editScreen.isOpen()` and `gameHalted` skip the streaming block), so the TTL measures "seconds of gameplay" not wall-clock. World typedef updated in `types.js` to reflect the recentlyGone envelope shape `{ chunk, evictedAt }`. **Code-reviewer found 6 issues across two rounds, all addressed**: stale typedef → fixed; unnecessary try/catch → removed; unused `CHUNK_SIZE` import → removed; dead `deferred` field → removed (deferred chunks just stay out of `active` and get picked up next frame); missing test for cap → added (per-frame across 5 frames + reactivations); missing `chunksPerFrame` createWorld option → added with validation (rejects negative/non-numeric, allows 0 for reactivations-only mode). Browser smoke test: scene renders with ~295 asteroids in the bubble, debug HUD populates correctly, no console errors. **`getActiveChunks` is wired into the debug HUD** as a `LIVE CHUNKS` row (between `Asteroids` and `Verts`) so the public read-helper is exercised every frame and the streaming state is observable in real time.

### ⏳ Next Steps (priority order)

1. **Spatial hash** — `src/systems/collision.js` (broad-phase): uniform grid keyed by world position. The narrow-phase step is already in place; this is the O(1) candidate-selection layer above it.
2. **Occlusion culling** — skip asteroids that are hidden behind other asteroids or behind the player ship, on top of the default frustum cull. The cheapest implementation is a per-frame coarse depth-prepass (render the asteroid bounding spheres to a 1-channel target, then skip the fragments whose depth is less than the prepass depth). A more accurate option is a BVH (`three-mesh-bvh`) and an occlusion query per object. Three.js's built-in `Object3D.frustumCulled` already does the frustum half — this is the additional "hidden by another object" half. Worth it once the streaming field has hundreds of asteroids.
3. **Hyperspace stub** — `src/systems/hyperspace.js`: `requestJump(systemId)` no-op seam for Elite expansion.
4. **Particles + visual polish** — explosions, thrust glow, screen shake.
5. **Final polish** — restart flow, edge cases, manual smoke test.

### 🛠 Current Ship Tunables (extract to `src/entities/constants.js` later)

- `THRUST_ACCEL = 60` u/s²
- `MAX_SPEED = 200` u/s
- `LINEAR_DRAG = 0.4` (exp decay coefficient)
- `YAW_SPEED = 4.0` rad/s
- `PLAY_PLANE_Y = 0`
- Camera `CHASE_DAMP = 6.0` (in `src/scene.js`)

## Architecture

### Data-model layer (PURE)
Everything under `src/world/` is a pure function of its inputs. No Three.js, no DOM, no `Math.random()` in chunk generation. Determinism is a hard contract — same `(cx, cz, systemSeed)` always produces the same chunk.

### Pure functions vs. side effects
- `hashChunk`, `densityAt`, `generateChunk` → pure
- `mulberry32(seed)` → factory that returns a pure PRNG
- `makeSimplex2(seed)` → factory that returns a pure noise function
- The world layer's `updateStreamingBubble` (planned) is the **only** side-effecting function in the data-model layer; it mutates `world.active` and `world.recentlyGone`.

### 2DOF now, 6DOF later
The ship controller is designed to swap flight modes. `setFlightMode('2dof')` keeps Y locked and rotation on the Y axis. `setFlightMode('6dof')` will add pitch/roll (planned, not built).

### Streaming world
- 7×7 active chunks (~49 chunks, ~300 asteroids) follow the ship.
- Chunks are pure functions of `(cx, cz, systemSeed)` → identical on revisit.
- `world.active` for live chunks, `world.recentlyGone` for soft cache (TTL 10s).

### State machine
DEMO → PLAYING → GAME_OVER. Transitions driven by input (key press) and game events (player death). Each state will have a clear entry/update/exit contract.

### Elite-readiness hooks (designed in, not built)
- `World.systemSeed` slot ready for hyperspace
- `setFlightMode` seam on ship
- Hyperspace stub with `requestJump(systemId)`
- Event bus (planned) for economy/combat subscriptions
- Save/load `serialize`/`deserialize` stubs (planned)

### UV editor tool factory pattern
`src/systems/uv-unwrap-viewer.js` orchestrates the UV editor. The heavy lifting lives in 15 tool factories under `src/systems/uv-tools/`. Each factory follows the same shape: `createXTool(state, deps) → { publicMethod1, publicMethod2, … }`, where:
- **`state`** is a thin getter/setter interface over the orchestrator's `let` variables (returned by `createEditorState`). Reads return the current value of the orchestrator's `let`; writes update the variable in place. The state object does NOT own its own state — it just delegates to closures.
- **`deps`** is a flat object of injectable dependencies: pure helpers (`parseEdgeKey`, `reunwrap`, `autoDetectSeams`, `walkEdgeLoop`, `buildEdgeKey`, `solveWith`, `solveAutomatic`, `stretchToColor`, `detectIslands`, `segmentsCross`), geometry accessors (`getBodyGeometry`, `getLayout`, `getSelectedEntity`), DOM accessors (late-bound via `getStatsEl: () => statsEl`, `getToolsEl: () => toolsEl`, `getUvCanvas: () => uvCanvas`, `getEnabled: () => enabled`), and lifecycle hooks (`scheduleDraw`, `notifySeamChange`, `onAfterApply: () => layout = computeLayout(selectedEntity)`, `onAfterTranslate: () => layout = computeLayout(selectedEntity)`).

Why this pattern: the orchestrator's `let` variables are the single source of truth (so inline code below the factory instantiations and the factory closures see the same state without a sync layer). The factories are testable in isolation by passing a mock `state` and mock `deps`. Late-bound DOM refs are passed as getter callbacks so the factories can be instantiated at the top of the orchestrator function (before `mount()` runs). Tool files do not cross-import each other — the `auto-unwrap` tool calls `reunwrap` + `applyUnwrapResult` directly (no forward to the `reUnwrapTool` factory) to keep the dependency graph flat.

The orchestrator exposes the public API as thin one-liner forwards to factory methods (`rotateSelection(deg) { transforms.rotateSelection(deg); }`). A few wrappers also touch state + DOM: `setMode` writes `mode` via `state.setMode(m)`, updates the toolbar's active-mode button, and calls `scheduleDraw()`; `toggleSnap` calls `transforms.toggleSnap()` then updates the toolbar's active state; `toggleBackground` cycles `state.getBackgroundMode()` / `state.setBackgroundMode(...)` then updates the BG button label. This preserves the public API and documents the tool↔factory mapping. `getSnapStep` is the one state method that doesn't read a `let` variable — it returns `UV_EDITOR_CONFIG.snap.step` directly (a config constant, not mutable state).

## Conventions

### File / module conventions
- **ESM only** (`"type": "module"` in `package.json`).
- Each module exports a small set of named functions. No default exports unless wrapping a third-party.
- JSDoc for every public function: param types (in `{@type}`), return type, brief description.
- Group private helpers below the public API, prefixed or underscored to signal.

### Code style
- 2-space indent.
- Single quotes for strings.
- Semicolons required.
- Trailing newline.
- Prefer `const` over `let` where possible.
- Prefer named-function exports over anonymous default exports.

### Determinism
- No `Math.random()` in `src/world/` chunk generation, asteroid splits, or AI-vs-field targeting.
- Seeded RNG (`mulberry32`) and seeded noise (`makeSimplex2`) are mandatory.
- For the starfield (`src/systems/starfield.js`) and similar purely-decorative effects, `Math.random()` is acceptable.

### Test conventions
- `node:test` (built-in).
- `assert` from `node:assert/strict`.
- Test file co-located under `tests/`, named `<module>.test.js`.
- Each test has a single `test('description', () => { ... })` block. No shared mutable state.

### Git conventions (recommended)
- One commit per logical change (data-model spec, data-model impl, scaffold, ship, etc.).
- Imperative-mood subject lines ("Add ship entity", not "Added ship entity").

## How to Validate

| Command | Purpose |
|---|---|
| `npm test` | Unit tests for the data model (21 tests, all green). |
| `node --test tests/` | Run the full test suite (209 tests across all modules). |
| `npm run build` | Vite production build. |
| `npm run dev` | Vite dev server on http://localhost:5173/. |
| `npm run dump:field` | ASCII visualization of the world to the terminal. |
| `npm run dump:field:svg` | SVG visualization (writes `field.svg` to project root). |
| `node --test tests/` | Same as `npm test`. |

Always run `npm test` and `npm run build` after changes. Use the browser to confirm visual changes.

## Known Quirks (for the next agent)

- **The Codebuff code-reviewer subagent has a routing issue in some sessions** — it sometimes returns confused meta-text instead of a real review. If this happens, treat the green test suite + green build as the validation signal. Don't try to re-spawn it three times; move on.
- **`browser-use` can make hot-fixes** during scene verification. Always read the file after a browser-use run to check for unprompted edits (we had one in `src/main.js` that I refactored into `src/scene.js`).
- **Floating-point precision** at huge world coords (>10⁶ units) is a known concern. Not a problem at MVP scale; documented as future-work in `SPEC.md` §7.
- **Capsule jitter is 15% of radius** (production). The clean normal-direction displacement on the merged-vertex topology supports visibly bumpy surfaces without holes or twisted faces — empirically verified 0 back-facing triangles at 15–30% jitter, 5/128 at 50%. The tripwire is at 6× = 90%. If the geometry or RNG ever changes, re-probe with a similar script to recalibrate.

## Open Decisions

See `SPEC.md` §11 for the live list. Currently:
- Chunk shape: square (vs hex)
- Noise library: hand-rolled simplex (vs `simplex-noise` npm package)
- World coordinate origin: true world space (vs local space with origin shift for Elite-scale)
- Audio: Web Audio API generated tones (deferred to polish phase)

## Where to Find What (quick index)

| Need to find… | Look in… |
|---|---|
| Locked constants | `src/world/constants.js` |
| Type definitions (JSDoc) | `src/world/types.js` |
| Chunk generation logic | `src/world/chunks.js` |
| PRNG | `src/world/rng.js` |
| Simplex noise | `src/world/noise.js` |
| Three.js scene setup | `src/scene.js` |
| Render loop | `src/main.js` |
| Starfield | `src/systems/starfield.js` |
| UV editor orchestrator | `src/systems/uv-unwrap-viewer.js` |
| UV editor tool factories | `src/systems/uv-tools/` (14 factories, see "UV editor per-tool split" in Done) |
| UV editor shared state | `src/systems/uv-tools/editor-state.js` |
| UV editor config | `src/systems/uv-tools/config.js` |
| UV editor pure geometry math | `src/systems/uv-tools/geometry-utils.js` |
| Visual smoke tests | `scripts/dump-field.js`, `scripts/dump-field-svg.js` |
| Unit tests | `tests/world.test.js` |
| Data-model design | `SPEC.md` |
| Project state / rules | `AGENTS.md` (this file) |
| User-facing intro | `README.md` |
