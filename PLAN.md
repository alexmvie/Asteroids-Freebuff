# Architecture Refactoring Plan

> **Goal**: Fix the deep coupling between AI and player ships so the game scales
> cleanly to multiple NPCs, co-op, and Elite-style expansion. The current
> architecture works but the shared-pool bandaids will not survive the next
> ship added.

---

## Problem Summary

| Issue | Current State | Target State |
|---|---|---|
| Bullet pools | One pool shared by player + AI | Per-ship pool (each ship owns its bullets) |
| Laser weapon | One mesh, awkward `activeCollector` routing | Per-ship laser (or properly scoped single laser) |
| Collision | Procedural in `processCollisions()` | Composable `checkBulletHits(pool, asteroids)` per pool |
| Score attribution | AI kills add to player score in DEMO, bleed into PLAYING | Each pool scored independently; DEMO score is demo-only |
| Entity abstraction | Ships are duck-typed objects | Ships are `Ship` instances with `.shoot()`, `.hasLaser()`, etc. |
| main.js | ~900 lines: render loop + collision + state + debug + HUD + camera + streaming | ~300 lines of orchestration; systems are delegates |
| State gating | Inline `if (state === ...)` checks scattered everywhere | State machine emits entry/exit events; systems subscribe |
| AI lifecycle | `demoAi.update(dt)` gated by inline state check | AI is a first-class ship with per-frame enable/disable |

---

## Phase 1: Separate Bullet Pools (low risk, high impact)

**Goal**: Each ship gets its own bullet pool. No cooldown sharing, no score bleed.

### 1a. Give the AI its own bullet pool

```js
// main.js — before
const bullets = createBulletPool({ scene, capacity: 64 });
const aiWeapon = { fire(opts) { return bullets.fire(opts); } };

// main.js — after
const playerBullets = createBulletPool({ scene, capacity: 64 });
const aiBullets = createBulletPool({ scene, capacity: 16 });

// AI weapon routes to its OWN pool
const aiWeapon = { fire(opts) { return aiBullets.fire(opts); } };

// player fires into their pool
function fireFromShip() { ... playerBullets.fire(...); }
```

### 1b. Update collision to process each pool independently

```js
function processCollisions() {
  const state = stateMachine.getState();

  // In DEMO: process AI bullets for demo score (AI score is self-contained)
  // In PLAYING: process player bullets for player score
  // Ship-vs-asteroid: PLAYING only (as before)

  if (state === State.DEMO) {
    const aiHits = findBulletHits({ asteroids: demoAsteroids, bullets: aiBullets });
    // score AI hits into a separate demoScore (not the player's score)
    processHits(aiHits, aiBullets, /* scoreTarget */ null); // null = don't emit score
  }

  if (state === State.PLAYING) {
    const playerHits = findBulletHits({ asteroids: demoAsteroids, bullets: playerBullets });
    processHits(playerHits, playerBullets, /* scoreTarget */ 'player');
    // ... ship-vs-asteroid as before
  }
}
```

### 1c. Remove the paper-over fixes

With separate pools, these are no longer needed:
- ❌ `fireFromShip()` PLAYING gate (was preventing Space-fires in DEMO)
- ❌ DEMO→PLAYING bullet pool clearing subscriber
- ❌ `demoAi.update(dt)` state gate (AI can still run; its pool is independent)
- ❌ DEMO→PLAYING score/lives reset subscriber (AI score was never in player pool)

### 1d. Tick loop with both pools

```js
function tick(dt) {
  // ...
  playerBullets.update(dt);
  aiBullets.update(dt);
  // ...
}
```

**Files touched**: `src/main.js`, `src/systems/collision.js` (optionally add a `processBulletHits` helper)
**Tests touched**: None (collision is pure; the caller changes are in main.js which is untested)
**Risk**: Low. The collision API (`findBulletHits`) takes a `bullets` parameter — works identically with any pool.

---

## Phase 2: Ship Entity Abstraction (medium risk, foundational)

**Goal**: Ships are proper entities, not bare objects. A `Ship` knows how to shoot,
has a weapon, and exposes its position/rotation. This is where the
architecture becomes Elite-ready (multiple AI ships, player switching,
squadrons).

### 2a. Define a `Ship` interface

```js
// src/entities/ship-interface.js (NEW)
/**
 * A Ship is an entity that:
 *   - has .position, .rotation (read/write)
 *   - has .shoot(asteroids) → fires current weapon
 *   - has .update(dt)
 *   - has .reset(pos)
 *   - has .mesh (Three.js Group)
 *   - can be assigned a weapon (.equipWeapon(weapon))
 *
 * The ship factory (createShip) already returns most of this;
 * we add .shoot() and .equipWeapon() and a bullet pool reference.
 */
```

### 2b. Add `.shoot()` to ships

```js
// In createShip or a wrapper
function createShipWithWeapon({ scene, bulletCapacity = 64 }) {
  const ship = createShip({ scene });
  const bullets = createBulletPool({ scene, capacity: bulletCapacity });

  ship.bullets = bullets;
  ship.shoot = function(asteroids) {
    const yaw = this.rotation.yaw;
    const direction = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    return this.bullets.fire({ origin: this.position, direction });
  };

  return ship;
}
```

This eliminates `fireFromShip()` entirely — the ship owns its weapon:

```js
// main.js — instead of fireFromShip(), just:
input.onFire = () => ship.shoot(demoAsteroids);
```

### 2c. AI uses the same interface

```js
// The AI update loop calls its ship's .shoot():
if (decision.fire) {
  ship.shoot(asteroids); // fires from the AI's pool, not the player's
}
```

The `aiWeapon` wrapper becomes unnecessary — the AI ship fires from its own pool.

**Files touched**: `src/entities/ship.js`, `src/entities/ai.js`, `src/main.js`
**Tests touched**: `tests/ship.test.js` (add shoot tests), `tests/ai.test.js` (mock ship.shoot)
**Risk**: Medium. The ship API gains a method; callers adapt.

---

## Phase 3: Laser Scope Cleanup (medium risk, pre-existing coupling)

**Goal**: The laser is the only shared resource after Phase 1-2. Decide how to scope it.

### Option A: One laser, proper ownership (simpler)

The laser is a singleton (one mesh, one beam). Only the player can fire it.
When the AI "collects" a power-up in DEMO, the AI gets a visual indicator
but the laser is strictly a player weapon.

```js
// main.js
const laser = createLaser({ scene });

// In PLAYING, laser fires when player has it
// In DEMO, laser is decorative (AI collecting power-ups is visual only)
//
// The powerup system's getCollector returns the player ship (always).
// AI collecting power-ups is a visual-only demo effect.
```

### Option B: Per-ship laser (cleaner, heavier)

Each ship that can collect a power-up gets its own laser mesh. Two laser
meshes means two beams. This is technically simple (createLaser is a
factory) but adds GPU cost for a second beam only visible in demo.

**Recommendation**: Option A for now. When the game needs AI ships that actually
use lasers (PvP, squadrons), switch to Option B.

**Files touched**: `src/main.js` (aiWeapon wrapper removed, laser routing simplified)
**Tests touched**: None
**Risk**: Low. The laser already works for the player; AI laser was broken anyway.

---

## Phase 4: main.js Decoupling (low risk, high maintainability)

**Goal**: main.js goes from ~900 lines to ~300. Systems become independent modules
wired together in `main.js` rather than embedded inline.

### 4a. Extract collision processing

```js
// src/systems/collision-processor.js (NEW)
// Takes the shared state (asteroids, ship, bullets, score/lives, bus, stateMachine)
// and runs the full collision pass: bullet hits → score → split → powerup drop.
// Still procedural, but contained in one module with a clear public API.
```

### 4b. Extract asteroid field management

```js
// src/systems/asteroid-field.js (NEW)
// Wraps: world, demoAsteroids, entityByChunkKey, streamTimeS
// Public: update(shipPos, dt), clearAll(), getEntities()
// Owns: spawnChunkEntities, despawnChunkEntities
```

### 4c. Extract debug/dev tool wiring

```js
// src/systems/dev-tools.js (NEW)
// Wraps: window.ASTEROID_UV_DEBUG, window.UV_UNWRAP_DEBUG, window.NEBULA_DEBUG
//        window.EDIT_OBJECT, debug HUD buttons, etc.
// Public: mount(), dispose()
```

### 4d. Resulting main.js structure

```js
// main.js — ~300 lines of pure orchestration
import { createScene } from './scene.js';
import { createPlayerShip } from './entities/ship-with-weapon.js';
import { createDemoAi } from './entities/ai.js';
import { createAsteroidField } from './systems/asteroid-field.js';
import { createCollisionProcessor } from './systems/collision-processor.js';
import { createDevTools } from './systems/dev-tools.js';
// ... etc

const scene = createScene();
const playerShip = createPlayerShip({ scene, bulletCapacity: 64 });
const aiShip = createDemoAi({ scene, bulletCapacity: 16 });
const field = createAsteroidField({ world, scene });
const collision = createCollisionProcessor({ playerShip, field, bus, stateMachine });
const dev = createDevTools({ scene, field, ... });

function tick(dt) {
  if (editScreen.isOpen()) return editScreen.updateMini(dt);
  if (gameHalted) return renderOnly(dt);

  input.update();
  playerShip.update(dt);
  aiShip.update(dt);
  field.update(ship.position, dt);
  collision.run(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}
```

**Files touched**: `src/main.js` (rewrite), 3-4 NEW files
**Tests touched**: None (systems are tested independently; main.js is untested glue)
**Risk**: Low. Extract without changing behavior. Run full test suite + browser smoke.

---

## Phase 5: State-Driven System Lifecycle (low risk, pattern improvement)

**Goal**: Instead of inline `if (state === ...)` checks, systems subscribe to
state transitions and enable/disable themselves.

### 5a. Add state entry/exit events to the state machine

```js
// Currently: stateMachine.subscribe(({ from, to }) => { ... })
// Add: stateMachine.onEnter(State.PLAYING, () => { ... })
//      stateMachine.onExit(State.DEMO, () => { ... })
```

This is sugar over the existing `subscribe` — no behavior change, just
makes the intent clearer.

### 5b. Systems become self-gating

```js
// ai.js — self-gating
const ai = createDemoAi({ ... });
ai.setEnabled(false); // start paused

stateMachine.onEnter(State.DEMO, () => ai.setEnabled(true));
stateMachine.onExit(State.DEMO, () => ai.setEnabled(false));

// collision.js — self-gating for ship hits
stateMachine.onEnter(State.PLAYING, () => collision.enableShipHits(true));
stateMachine.onExit(State.PLAYING, () => collision.enableShipHits(false));
```

**Files touched**: `src/systems/state.js`, `src/entities/ai.js`, `src/main.js`
**Tests touched**: `tests/state.test.js` (add onEnter/onExit tests)
**Risk**: Low. Sugar over existing subscribe pattern.

---

## Implementation Order

| Step | Phase | Description | Files | Risk |
|---|---|---|---|---|
| 1 | 1a | AI gets its own bullet pool | main.js | Low |
| 1 | 1b | Collision processes each pool | main.js | Low |
| 1 | 1c | Remove paper-over fixes | main.js | Low |
| 2 | 2b | Add ship.shoot() method | ship.js, ai.js, main.js | Med |
| 3 | 3 | Simplify laser ownership | main.js | Low |
| 4 | 4a | Extract collision processor | NEW + main.js | Low |
| 4 | 4b | Extract asteroid field | NEW + main.js | Low |
| 4 | 4c | Extract dev tools | NEW + main.js | Low |
| 4 | 4d | Final main.js cleanup | main.js | Low |
| 5 | 5a | State entry/exit events | state.js | Low |
| 5 | 5b | Systems self-gate | main.js, ai.js | Low |

### Validation after each step
```bash
npm test           # 423 tests must stay green
npm run build      # Must succeed (bundle check)
npm run dev        # Visual smoke test (render, shoot, collide, state transitions)
```

### Commit strategy
One commit per step. Push after each commit. Commit messages follow the
project convention (imperative mood, "Add separate AI bullet pool",
"Extract collision processor", etc.).

---

## What We Keep

- **Ship factory** (`createShip`) — both ships share the same mesh/physics. Good DRY.
- **Pure AI brain** (`aiBrainTick`) — already well-structured, injectable, testable.
- **Bullet pool** (`createBulletPool`) — well-designed factory. No changes needed.
- **Collision math** (`findBulletHits`, `findShipHit`) — pure, reusable, correct.
- **State machine** — clean, testable. We only add sugar (onEnter/onExit).
- **Powerup system** — well-structured. Only the collector routing simplifies.
- **World streaming** — isolated data-model layer. Untouched.
- **UV editor** — isolated system. Untouched.

---

## What We Remove

- ~~`aiWeapon` wrapper in main.js~~ (replaced by ship.shoot())
- ~~`fireFromShip()`~~ (replaced by ship.shoot())
- ~~DEMO→PLAYING bullet clearing subscriber~~ (separate pools, no bleed)
- ~~DEMO→PLAYING score/lives reset subscriber~~ (separate pools)
- ~~`demoAi.update(dt)` state gate~~ (AI self-gates, or runs independently)
- ~~Inline collision loop in main.js~~ (extracted to module)
- ~~Inline asteroid field management~~ (extracted to module)
- ~~Inline dev tool wiring~~ (extracted to module)
