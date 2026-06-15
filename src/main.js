import { Clock } from 'three';
import './styles.css';
import { createScene } from './scene.js';
import { createShip, loadShipModel } from './entities/ship.js';
import { createAsteroidFromSpec, CAPSULE_UV_PLANE } from './entities/asteroid.js';
import { createBulletPool } from './entities/bullet.js';
import { createLaser } from './entities/laser.js';
import {
  densityAt,
  chunkHasNebula,
  INITIAL_SYSTEM_SEED,
  NEBULA_MAX_OPACITY,
  createWorld,
  worldToChunk,
  chunkKey,
  updateStreamingBubble,
  evictStaleChunks,
  getActiveChunks,
} from './world/index.js';
import { createInputSystem } from './systems/input.js';
import {
  findBulletHits,
  findShipHit,
  scoreForSize,
} from './systems/collision.js';
import { createEventBus } from './systems/events.js';
import { createStateMachine, State } from './systems/state.js';
import { createHud } from './ui/hud.js';
import { createDebugHud } from './ui/debug-hud.js';
import { createDemoAi } from './entities/ai.js';
import { createAsteroidUvDebugOverlay } from './systems/asteroid-uv-debug-overlay.js';
import { createUvUnwrapViewer } from './systems/uv-unwrap-viewer.js';
import { createEditObjectScreen } from './systems/edit-object-screen.js';
import { createPowerUpSystem } from './systems/powerup-system.js';

// ---- Power-up drop frequency -------------------------------------------
// Probability (0.0–1.0) that an asteroid destroy spawns a laser
// power-up. 1.0 = every destroy, 0.5 = half, 0.0 = never.
//
// **`spawnAt` is still a no-op if a power-up is already pending
// or the laser is active** — so even with `POWERUP_DROP_CHANCE =
// 1.0` the field never has more than one power-up at a time
// (kills after the first are silently absorbed until the
// existing power-up is picked up or expires). The chance only
// affects how many of the gaps between pickups actually get a
// new power-up: with 1.0 every gap does, with 0.5 half do, with
// 0.0 none do.
//
// **Tuning history:**
//   - 2026-06-13: bumped to 0.95 (user asked for "almost every
//     destroy" — 5% chance to miss keeps it from feeling 100%
//     deterministic, the user can dial this back later for
//     difficulty).
//   - 2026-06-12: was 0.10 (10% per kill, "fair spawn rate").
//   - 2026-06-11: was a literal `Math.random() < 0.10` guard,
//     no constant.
//
// Adjust this single number to retune the drop rate. Range is
// 0.0–1.0; values > 1.0 are treated as 1.0 (always drop).
const POWERUP_DROP_CHANCE = 0.95;

// ---- Boot ----------------------------------------------------------------
const {
  renderer,
  scene,
  camera,
  nebula,
  nebulaDebug,
  setChaseTarget,
  updateCamera,
} = createScene();
const clock = new Clock();

// ---- Asteroid UV debug overlay -----------------------------------------
// One shared material, one per-asteroid debug mesh (sharing the
// body's geometry). Toggled by `window.ASTEROID_UV_DEBUG`; the
// plane projection on the capsule body is toggled by
// `window.ASTEROID_UV_PLANE` (one of 'xy' | 'xz' | 'yz').
// See `src/systems/asteroid-uv-debug-overlay.js`.
const asteroidUvDebug = createAsteroidUvDebugOverlay();
asteroidUvDebug.setCapsulePlane(CAPSULE_UV_PLANE); // sync with the constant

// ---- NEBULA_DEBUG runtime toggle ---------------------------------------
// The default is the compile-time constant NEBULA_DEBUG_DEFAULT
// (false in production). The user / dev can flip it live in the
// browser devtools: `window.NEBULA_DEBUG = true` to show the
// per-chunk threshold markers, `= false` to hide. The setter wraps
// the underlying `nebulaDebug.setEnabled` so the toggle works the
// same way the dev tools sees it.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'NEBULA_DEBUG', {
    configurable: true,
    enumerable: true,
    get() { return nebulaDebug.isEnabled(); },
    set(v) { nebulaDebug.setEnabled(!!v); },
  });

  // ASTEROID_UV_DEBUG — show / hide the per-asteroid UV grid
  // overlay. Each asteroid body has a child mesh (sharing its
  // geometry) that renders a 10×10 rainbow-tinted wireframe UV
  // grid, useful for tuning the unwrap live in the browser.
  Object.defineProperty(window, 'ASTEROID_UV_DEBUG', {
    configurable: true,
    enumerable: true,
    get() { return asteroidUvDebug.isEnabled(); },
    set(v) { asteroidUvDebug.setEnabled(!!v); },
  });

  // ASTEROID_UV_PLANE — change the planar projection used by the
  // capsule body. Triggers a UV recompute on every attached capsule
  // (no rebuild). Accepts 'xy' | 'xz' | 'yz' (mirrors the
  // CAPSULE_UV_PLANE compile-time constant). Invalid values are
  // rejected with a console warning and the state is unchanged.
  Object.defineProperty(window, 'ASTEROID_UV_PLANE', {
    configurable: true,
    enumerable: true,
    get() { return asteroidUvDebug.getCapsulePlane(); },
    set(v) { asteroidUvDebug.setCapsulePlane(v); },
  });
}

// ---- UV unwrap viewer --------------------------------------------------
// 3ds-Max-style 2D editor in a side panel. Toggle with the
// `UV UNWRAP` button in the debug HUD (or via the
// `window.UV_UNWRAP_DEBUG` runtime setter). When enabled, hover
// an asteroid in the 3D view to highlight it, click to display
// its UV layout. Pan / zoom in the panel with drag / wheel. The
// panel's `BG: CHECKER` / `BG: TEXTURE` button toggles between
// the background modes; `RESET` restores the default view.
const uvUnwrapViewer = createUvUnwrapViewer({
  canvas: renderer.domElement,
  camera,
  getAsteroids: () => demoAsteroids,
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'UV_UNWRAP_DEBUG', {
    configurable: true,
    enumerable: true,
    get() { return uvUnwrapViewer.isEnabled(); },
    set(v) { uvUnwrapViewer.setEnabled(!!v); },
  });
}

// ---- Debug HUD: UV grid toggle button ---------------------------------
// The debug overlay (#debug-hud) is non-interactive by default
// (`pointer-events: none` on the container, so the canvas stays
// clickable). The toggle button is the one exception — it has
// `pointer-events: auto` in the CSS and a click handler here.
// Clicking the button flips `asteroidUvDebug.setEnabled(...)` and
// updates the label / `.debug-hud-toggle--on` class to match.
// Setting `window.ASTEROID_UV_DEBUG` from the console also
// updates the button label (the setter below listens for the
// overlay's state change via the same `updateBtn()` closure).
const uvToggleBtn = document.getElementById('debug-toggle-uv');
if (uvToggleBtn) {
  const updateUvToggleBtn = () => {
    const on = asteroidUvDebug.isEnabled();
    uvToggleBtn.textContent = `UV GRID: ${on ? 'ON' : 'OFF'}`;
    uvToggleBtn.classList.toggle('debug-hud-toggle--on', on);
  };
  uvToggleBtn.addEventListener('click', () => {
    asteroidUvDebug.setEnabled(!asteroidUvDebug.isEnabled());
    updateUvToggleBtn();
  });
  // Wrap the overlay's setEnabled so the button stays in sync
  // when the user toggles via the console (`window.ASTEROID_UV_DEBUG
  // = true` in devtools). Without this wrap, the button would only
  // update on click — out-of-band changes would be invisible.
  const originalSetEnabled = asteroidUvDebug.setEnabled;
  asteroidUvDebug.setEnabled = (v) => {
    originalSetEnabled(v);
    updateUvToggleBtn();
  };
  updateUvToggleBtn(); // initial label (OFF by default)
}

// ---- Debug HUD: UV unwrap viewer toggle button ------------------------
// Same pattern as the UV grid button: `pointer-events: auto` on the
// button overrides the container's `pointer-events: none`, the
// click handler flips the viewer's enabled state, and the
// `setEnabled` wrap on the viewer keeps the label in sync when
// the user toggles via the console setter or the panel's own
// close button. The panel's close button calls
// `uvUnwrapViewer.setEnabled(false)`, which (via the wrap below)
// also flips this button back to OFF.
const uvViewerBtn = document.getElementById('debug-toggle-uv-viewer');
if (uvViewerBtn) {
  const updateUvViewerBtn = () => {
    const on = uvUnwrapViewer.isEnabled();
    uvViewerBtn.textContent = `UV UNWRAP: ${on ? 'ON' : 'OFF'}`;
    uvViewerBtn.classList.toggle('debug-hud-toggle--on', on);
  };
  uvViewerBtn.addEventListener('click', () => {
    uvUnwrapViewer.setEnabled(!uvUnwrapViewer.isEnabled());
    updateUvViewerBtn();
  });
  // Wrap setEnabled so the button stays in sync with
  // out-of-band changes (console setter, panel close button).
  const originalViewerSetEnabled = uvUnwrapViewer.setEnabled;
  uvUnwrapViewer.setEnabled = (v) => {
    originalViewerSetEnabled(v);
    updateUvViewerBtn();
  };
  updateUvViewerBtn(); // initial label (OFF by default)
}

// ---- Game-halt flag ----------------------------------------------------
// When the edit-object screen is open OR in pick mode, the game
// entities (ship, asteroids, AI, collisions) are paused. When the
// screen is in 'edit' state, the main 3D scene stops rendering
// entirely (the modal's mini viewport is the only thing drawing).
// The edit screen calls onPause(true) on beginPick/openFor and
// onPause(false) on close/cancelPick; the render loop checks the
// resulting flags.
let gameHalted = false;
// `cameraFocused` is set to true when the user presses FOCUS
// inside the edit screen. While true, the chase camera (the
// `updateCamera` lerp that follows the player ship) is paused
// so the manually-positioned FOCUS camera isn't immediately
// reverted. Cleared on screen close.
let cameraFocused = false;


// ---- Edit-object screen -----------------------------------------------
// Full-screen modal that shows an isolated 3D viewport of the
// selected asteroid (a dedicated lightweight renderer — no full
// game scene rendered behind it), an embedded UV editor, and an
// info box. The flow is:
//
//   1. User clicks EDIT OBJECT → `beginPick()` pauses the game
//      and shows a small "EDIT MODE" hint. The main 3D view
//      stays active with a crosshair cursor.
//   2. User clicks an asteroid → `openFor(entity)` opens the
//      full screen. The main 3D scene stops rendering.
//   3. User clicks X (or Esc) → `close()` resumes the game.
//
// The modal is OPAQUE (no transparency, no backdrop-filter) so
// the GPU doesn't waste fill-rate on a see-through layer.
const editScreen = createEditObjectScreen({
  renderer,
  camera,
  scene,
  getAsteroids: () => demoAsteroids,
  onPause: (paused) => {
    gameHalted = !!paused;
    // Resuming the game clears the FOCUS hold so the chase
    // camera re-engages on the next frame.
    if (!paused) cameraFocused = false;
  },
});

// ---- Debug HUD: EDIT OBJECT toggle button -----------------------------
// Cycles the edit screen through three states:
//   closed → pick   (click 1: begin pick mode)
//   pick   → closed (click 2 in pick: cancel)
//   pick   → edit   (after user clicks an asteroid)
//   edit   → closed (click 3: close screen)
const editBtn = document.getElementById('debug-toggle-edit');
if (editBtn) {
  const updateEditBtn = () => {
    const isOpen = editScreen.isOpen();
    const isPicking = editScreen.isPicking();
    // Caption stays plain "EDIT OBJECT" — the state is conveyed
    // visually by the `.debug-hud__toggle--on` modifier (background
    // + border change), not by the text. The old "EDIT OBJECT:
    // OFF" label read as "off is off" which was confusing.
    editBtn.textContent = 'EDIT OBJECT';
    editBtn.classList.toggle('debug-hud__toggle--on', isOpen || isPicking);
  };
  editBtn.addEventListener('click', () => {
    if (editScreen.isOpen()) editScreen.close();
    else if (editScreen.isPicking()) editScreen.cancelPick();
    else editScreen.beginPick();
    updateEditBtn();
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'EDIT_OBJECT', {
      configurable: true,
      enumerable: true,
      get() { return editScreen.isOpen() || editScreen.isPicking(); },
      set(v) {
        if (v) editScreen.beginPick();
        else {
          if (editScreen.isOpen()) editScreen.close();
          else if (editScreen.isPicking()) editScreen.cancelPick();
        }
      },
    });
  }
  updateEditBtn();
}
const bus = createEventBus();
const stateMachine = createStateMachine({ initial: State.DEMO, events: bus });

// ---- Ship ---------------------------------------------------------------
const ship = createShip({ scene });
// (Initial chase target is set after demoAi is created, below.)
// Async: try to load skyfighter.glb and swap it in. If it fails,
// the procedural ship stays (loadShipModel never throws; it logs a
// warning and returns { success: false }).
// `modelRotationY: -Math.PI / 2` rotates the loaded model 270° to
// the right (equivalent to -90° around Y). The GLB's nose was
// pointing in the -X direction; +90° (which we tried first) was
// wrong, so we added another 180° to get the correct -Z forward
// orientation matching the ship physics. Flip the sign / change
// the value if the direction is wrong.
loadShipModel(ship, '/models/skyfighter.glb', { modelRotationY: -Math.PI / 2 }).then((result) => {
  if (result.success && typeof console !== 'undefined') {
    console.log(`[main] skyfighter.glb loaded (scale=${result.scale.toFixed(2)}, rotated=${result.rotated}, -90° Y)`);
  }
});

// ---- Bullet pool --------------------------------------------------------
const bullets = createBulletPool({ scene, capacity: 64 });

// ---- Laser weapon -------------------------------------------------------
// The ship's "piercing beam" — fires a long sky-blue beam that cuts
// through every asteroid in its path. Active while the laser
// power-up is collected (see `createPowerUpSystem` below). The
// laser is an alternative to bullets, not a stack: while the laser
// is the active weapon, Space fires the laser instead of a bullet.
const laser = createLaser({ scene });

// ---- Asteroid field (streaming) ----------------------------------------
// The world layer (src/world/world.js) owns the chunk streaming
// decision. Per frame, the render loop calls updateStreamingBubble()
// and we act on its delta: spawn meshes for new chunks, despawn
// meshes for evicted chunks. `entityByChunkKey` maps a chunk key
// ("cx,cz") to the array of entities it owns, so eviction is
// O(asteroids-in-chunk) — we never scan the full demoAsteroids
// array to find which asteroids belong to an evicted chunk.
//
// `streamTimeS` is the per-frame `nowS` passed to the streaming
// layer. We accumulate from `dt` so the soft-cache TTL (defined in
// src/world/chunk-constants.js) counts wall-clock seconds, not
// frame counts. The first frame starts at t=0; the bubble fills on
// tick 1.
const world = createWorld({ systemSeed: INITIAL_SYSTEM_SEED });
const demoAsteroids = [];
const entityByChunkKey = new Map();
let streamTimeS = 0;

/**
 * Spawn meshes for every asteroid spec in `chunks` and register
 * them under the chunk's Map key. Idempotent: if the chunk's key
 * is already in `entityByChunkKey` (e.g. a reactivation that
 * somehow double-fired), the new spawn is skipped.
 *
 * @param {Array<object>} chunks
 */
function spawnChunkEntities(chunks) {
  for (const chunk of chunks) {
    const key = chunkKey(chunk.id.cx, chunk.id.cz);
    if (entityByChunkKey.has(key)) continue;
    const entities = [];
    for (const spec of chunk.asteroids) {
      const entity = createAsteroidFromSpec({ spec, scene, uvDebugOverlay: asteroidUvDebug });
      demoAsteroids.push(entity);
      entities.push(entity);
    }
    entityByChunkKey.set(key, entities);
  }
}

/**
 * Despawn the meshes for every asteroid in `chunks` and unregister
 * the chunks from `entityByChunkKey`. Uses reverse-order splice
 * (the same pattern as `processCollisions`) so removing items
 * from the middle of `demoAsteroids` doesn't shift the indices
 * of the remaining removals.
 *
 * @param {Array<object>} chunks
 */
function despawnChunkEntities(chunks) {
  for (const chunk of chunks) {
    const key = chunkKey(chunk.id.cx, chunk.id.cz);
    const entities = entityByChunkKey.get(key);
    if (!entities) continue;
    // Find the indices in demoAsteroids, then splice in reverse
    // so each removal doesn't invalidate the subsequent indices.
    const indices = [];
    for (const entity of entities) {
      const idx = demoAsteroids.indexOf(entity);
      if (idx >= 0) indices.push(idx);
    }
    indices.sort((a, b) => b - a);
    for (const idx of indices) {
      demoAsteroids[idx].dispose();
      demoAsteroids.splice(idx, 1);
    }
    entityByChunkKey.delete(key);
  }
}

/**
 * Wipe the entire world and all entities. Called by
 * `resetRunState` (on game restart) and once at boot (to clear
 * any pre-streaming state if the function is reused). The next
 * frame's `updateStreamingBubble` re-populates from scratch
 * because `world.active` and `world.recentlyGone` are both empty.
 */
function clearAllAsteroids() {
  for (const entities of entityByChunkKey.values()) {
    for (const entity of entities) {
      entity.dispose();
    }
  }
  demoAsteroids.length = 0;
  entityByChunkKey.clear();
  world.active.clear();
  world.recentlyGone.clear();
  // Full reset (not a pause): the ship respawned at origin and the
  // recently-evicted cache is gone, so the TTL clock should start
  // at zero. If we preserved `streamTimeS`, an evicted chunk from
  // the next bubble exit would have an `evictedAt` way in the past
  // and drop on the very next frame.
  streamTimeS = 0;
}

// ---- Demo AI -----------------------------------------------------------
// NPC ship that hunts the nearest asteroid and shoots at it when the
// target is in front (a ~20° cone), in addition to the original
// wander/dodge behaviors. Same ship look as the player, infinite
// lives, never collides with the player. See src/entities/ai.js.
// The `weapon` is a duck-typed wrapper that routes through the laser
// (when active for the AI) or the bullet pool (otherwise). In DEMO
// mode, the AI also collects power-ups via `getCollector`, so the
// demo plays like a real game.
// The wrapper is created here (not in ai.js) because the routing
// decision depends on `powerupSystem` + `demoAi.getShip()` — neither
// is in scope when the AI factory is invoked.
const aiWeapon = {
  fire({ origin, direction, asteroids }) {
    const aiShip = demoAi.getShip();
    // Route to the laser when (a) the laser is active and (b) the
    // AI is the one who collected it. The second check is what
    // distinguishes "the AI has the laser" from "the player has
    // the laser" when both are running in different states.
    if (
      powerupSystem.isLaserActive() &&
      powerupSystem.getActiveCollector() === aiShip
    ) {
      return laser.fire({ origin, direction, asteroids });
    }
    return bullets.fire({ origin, direction });
  },
};
const demoAi = createDemoAi({ scene, asteroids: demoAsteroids, weapon: aiWeapon });
// Same GLB swap for the AI demo ship, so the player and the NPC match.
loadShipModel(demoAi.getShip(), '/models/skyfighter.glb', { modelRotationY: -Math.PI / 2 }).then((result) => {
  if (result.success && typeof console !== 'undefined') {
    console.log(`[main] skyfighter.glb loaded for AI demo ship (scale=${result.scale.toFixed(2)}, -90° Y)`);
  }
});

// ---- Power-up system ---------------------------------------------------
// Spawns laser power-ups in the streaming bubble, detects the active
// collector's pickup, and runs the 15s active countdown. While the
// laser is active, Space fires the laser (instead of a bullet). The
// collector is whichever entity the player or AI controls: in DEMO
// it's the AI ship (so the NPC plays the game like a real player),
// in PLAYING/GAME_OVER it's the player ship. In DEMO the spawn
// cadence is also faster (2.5s vs 5s) so power-ups cycle visibly.
// See src/systems/powerup-system.js for the lifecycle + events.
const powerupSystem = createPowerUpSystem({
  scene,
  bus,
  ship,
  world,
  options: {
    getGameState: () => stateMachine.getState(),
    // In DEMO, the AI ship collects the power-up. In PLAYING / GAME_OVER,
    // the player ship does. This is read each pickup, so the
    // collector flips automatically on state transitions.
    getCollector: () => {
      const s = stateMachine.getState();
      if (s === State.DEMO) {
        const aiShip = demoAi && demoAi.getShip();
        return aiShip || ship;
      }
      return ship;
    },
    // Spawn the power-up near the entity the camera follows in the
    // current state. In DEMO the camera follows the AI, so spawning
    // near the player (origin) would put the power-up outside the
    // camera's view cone. In PLAYING the camera follows the
    // player, so spawning near the player is correct. The pickup
    // distance is the same; only the spawn position moves.
    getSpawnAnchor: () => {
      const s = stateMachine.getState();
      if (s === State.DEMO) {
        const aiShip = demoAi && demoAi.getShip();
        return aiShip || ship;
      }
      return ship;
    },
    // Shorter lifetime in DEMO so an unclaimed power-up cycles
    // faster (the user sees a new one every ~15s instead of ~32s).
    // The AI can still pick one up before expiry if it's in range.
    powerupLifetimeByState: {
      DEMO: 12,
      // PLAYING / GAME_OVER: default 30s
    },
    // Faster spawn cadence in DEMO so the laser power-up cycles
    // visibly and the AI can actually pick one up. PLAYING keeps
    // the default 5s so the power-up feels earned.
    spawnDelayByState: {
      DEMO: 2.5,
      // PLAYING / GAME_OVER: fall back to default respawnDelayS
    },
    // Pass the laser so the system can force-stop the beam when the
    // active laser is cancelled (e.g. on game over) — without this
    // the beam would keep rendering for up to ~0.12s through the
    // GAME OVER overlay.
    laser,
  },
});

// ---- Game state (score + lives) -----------------------------------------
// Owned by main.js; the upcoming HUD layer will subscribe to 'score:changed'
// and 'lives:changed' on the bus.
let score = 0;
let lives = 3;
function resetRunState() {
  // Clear the bullet pool so no shots from the previous run linger.
  bullets.forEachActive((b, i) => bullets.despawn(i));
  score = 0;
  lives = 3;
  ship.reset({ x: 0, y: 0, z: 0 });
  // Wipe the world + entities. The next render-loop tick will
  // re-populate the bubble around the ship's reset position.
  clearAllAsteroids();
  // Wipe the power-up state. The next PLAYING tick will spawn
  // a fresh power-up.
  powerupSystem.clearAll();
  bus.emit('score:changed', { score });
  bus.emit('lives:changed', { lives });
}

// ---- Input --------------------------------------------------------------
/**
 * Fire the active weapon. Gated to PLAYING state only:
 *   - DEMO: Space starts the game (onStart), not fire.
 *   - GAME_OVER: the game is over; no shooting through the overlay.
 *   - PLAYING: normal weapon fire.
 *
 * While the laser power-up is active, fires the laser; otherwise fires
 * a bullet. Both weapons use the ship's current yaw to compute the
 * forward direction.
 */
function fireFromShip() {
  if (stateMachine.getState() !== State.PLAYING) return;
  const yaw = ship.rotation.yaw;
  const direction = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
  if (powerupSystem.isLaserActive()) {
    laser.fire({ origin: ship.position, direction, asteroids: demoAsteroids });
  } else {
    bullets.fire({ origin: ship.position, direction });
  }
}

const input = createInputSystem({
  ship,
  onFire: fireFromShip,
  onStart: () => {
    // any-key: DEMO → PLAYING (start) or GAME_OVER → PLAYING (restart).
    // The state machine enforces which transitions are legal.
    const s = stateMachine.getState();
    if (s === State.DEMO || s === State.GAME_OVER) {
      if (s === State.GAME_OVER) resetRunState();
      stateMachine.transition(State.PLAYING, { reason: 'user_start' });
    }
    // In PLAYING, onStart is a no-op (e.g. user mashed a key mid-game).
  },
  getGameState: () => ({ state: stateMachine.getState() }),
});

// ---- Collision ---------------------------------------------------------
/**
 * Process all collision pairs for the current frame. The bullet/laser
 * ↔ asteroid checks run in EVERY state (DEMO + PLAYING + GAME_OVER
 * skips) so the AI's shots count during the attract screen — the
 * demo plays like a real game, the AI visibly destroys asteroids,
 * and the player sees what the game looks like with score going
 * up. The ship ↔ asteroid check is gated to PLAYING only because:
 *   1. The player is the only entity with lives (the AI is
 *      decorative; it can't die in DEMO).
 *   2. The player's hit handling transitions the state machine to
 *      GAME_OVER, which only makes sense in PLAYING.
 * Without this split, the AI's bullets would silently pass through
 * asteroids in DEMO (the previous behavior).
 */
function processCollisions() {
  const state = stateMachine.getState();
  if (state === State.GAME_OVER) return;

  // ---- Bullet ↔ asteroid (run in DEMO + PLAYING) ---------------------
  const bulletHits = findBulletHits({ asteroids: demoAsteroids, bullets });
  const asteroidsToRemove = new Set();
  for (const hit of bulletHits) {
    bullets.despawn(hit.bulletIndex);
    if (asteroidsToRemove.has(hit.asteroidIndex)) continue;
    asteroidsToRemove.add(hit.asteroidIndex);
    score += scoreForSize(demoAsteroids[hit.asteroidIndex].spec.size);
  }

  // ---- Laser ↔ asteroid (piercing hits, run in DEMO + PLAYING) -------
  // The laser accumulates `pendingHits` over the pulse's visible
  // duration (the beam follows the ship, so a moving ship sweeps
  // through more asteroids). We consume one asteroid per frame here;
  // the next frame's `laser.update()` re-evaluates the beam.
  if (laser.isFiring()) {
    for (const asteroid of laser.getPendingHits()) {
      const idx = demoAsteroids.indexOf(asteroid);
      if (idx < 0) {
        // Stale entity (already removed by a bullet, or evicted
        // with its chunk). Drop it from the pending set.
        laser.consumeHit(asteroid);
        continue;
      }
      if (asteroidsToRemove.has(idx)) {
        laser.consumeHit(asteroid); // already being killed
        continue;
      }
      asteroidsToRemove.add(idx);
      score += scoreForSize(asteroid.spec.size);
      laser.consumeHit(asteroid); // consumed this frame
    }
  }

  if (asteroidsToRemove.size > 0) {
    bus.emit('score:changed', { score });
  }

  // Apply removals + spawn children, reverse order to preserve indices.
  const indices = [...asteroidsToRemove].sort((a, b) => b - a);
  for (const idx of indices) {
    const a = demoAsteroids[idx];
    const destroyedPos = a.getPosition();
    const childSpecs = a.split();
    a.dispose();
    demoAsteroids.splice(idx, 1);
    for (const spec of childSpecs) {
      demoAsteroids.push(createAsteroidFromSpec({ spec, scene, uvDebugOverlay: asteroidUvDebug }));
    }
    // ---- Power-up drop on asteroid kill -----------------------
    // Roll the per-kill chance (POWERUP_DROP_CHANCE, near the
    // top of this file). On a miss, no power-up spawns — but
    // the next destroy is a fresh roll, so a long stream of
    // kills still has independent chances. On a hit (or when
    // a power-up is already pending / laser is active),
    // `spawnAt` is a no-op, so the field never has more than
    // one power-up at a time.
    if (Math.random() < POWERUP_DROP_CHANCE) {
      powerupSystem.spawnAt({ x: destroyedPos.x, z: destroyedPos.z });
    }
  }

  // ---- Ship ↔ asteroid (PLAYING only) --------------------------------
  // The player is the only entity that can die (lives system). The
  // AI has infinite lives and the laser/bullet pool handles its own
  // cooldown — the AI is never a collision target. We also gate
  // this on PLAYING because the state transition to GAME_OVER only
  // makes sense when the player is the one being hit.
  if (state !== State.PLAYING) return;
  const shipHitIdx = findShipHit({ ship, asteroids: demoAsteroids });
  if (shipHitIdx >= 0) {
    const a = demoAsteroids[shipHitIdx];
    a.dispose();
    demoAsteroids.splice(shipHitIdx, 1);
    lives -= 1;
    bus.emit('lives:changed', { lives });
    if (lives <= 0) {
      stateMachine.transition(State.GAME_OVER, { finalScore: score });
      bus.emit('game:over', { finalScore: score });
    } else {
      ship.reset({ x: 0, y: 0, z: 0 });
    }
  }
}

// ---- State-change log (dev-friendly) -----------------------------------
stateMachine.subscribe((e) => {
  if (typeof console !== 'undefined') {
    console.log(`[state] ${e.from} → ${e.to}`, e.payload || '');
  }
});

// ---- Demo AI visibility ------------------------------------------------
// The AI ship is a decoration for the DEMO state — it shows the player
// what the game looks like with an NPC flying around. During PLAYING
// and GAME_OVER the player should only see their own ship, so we hide
// the AI's mesh on every state transition.
stateMachine.subscribe(({ to }) => {
  const aiShip = demoAi && demoAi.getShip();
  if (aiShip && aiShip.mesh) aiShip.mesh.visible = (to === State.DEMO);
});

// ---- Camera target switching ------------------------------------------
// The single follow camera should be aimed at whichever ship is the
// "subject" right now:
//   - DEMO       → the AI demo ship (so the player watches the NPC play)
//   - PLAYING    → the player ship
//   - GAME_OVER  → the player ship (they just died; the camera stays on
//                  them while the GAME OVER overlay is shown)
// The state machine doesn't fire on the initial state, so we call this
// once at boot to seed the target.
function setCameraForState(state) {
  if (state === State.DEMO) {
    setChaseTarget(demoAi.getShip());
  } else {
    setChaseTarget(ship);
  }
}
stateMachine.subscribe(({ to }) => setCameraForState(to));
setCameraForState(stateMachine.getState());

// ---- Clear bullet pool on DEMO → PLAYING transition -----------------
// When the user starts a game from the attract screen, wipe any
// bullets the AI fired during the demo. Without this, old AI bullets
// linger in the shared pool and look like "bullets coming back from
// behind" when the camera snaps to the player's viewpoint.
//
// Also reset score + lives — the AI's demo score should not bleed
// into the player's game (the demo is a self-contained attract loop,
// not the start of a run).
stateMachine.subscribe(({ from, to }) => {
  if (from === State.DEMO && to === State.PLAYING) {
    bullets.forEachActive((b, i) => bullets.despawn(i));
    score = 0;
    lives = 3;
    bus.emit('score:changed', { score });
    bus.emit('lives:changed', { lives });
  }
});

// ---- HUD ---------------------------------------------------------------
// Subscribes to the game event bus and updates the existing #hud / #overlay
// DOM elements. The `initialState` seed is required so the start prompt
// gets the `.hud-message--demo` class + 1Hz flash on the very first
// frame — the state machine doesn't fire a `state:changed` event for
// the state it's already in at boot. See src/ui/hud.js.
const hud = createHud({ bus, initialState: stateMachine.getState() });
{
  const root = document.getElementById('hud');
  const overlay = document.getElementById('overlay');
  // The overlay's data-hud child lives inside #overlay, so we hand the
  // HUD a root that can find it via the same querySelector.
  const combinedRoot = root && overlay
    ? {
        querySelector(sel) {
          return root.querySelector(sel) || overlay.querySelector(sel);
        },
      }
    : root;
  if (combinedRoot) hud.mount(combinedRoot);
}

// ---- Debug HUD ----------------------------------------------------------
// Bottom-left overlay. Pulls live state from the game each frame: FPS
// (sampled internally by the HUD over a 0.5s window), current state
// machine state, score/lives, asteroid count, and the world positions
// of the camera and the player ship. See src/ui/debug-hud.js.
const debugHud = createDebugHud();
{
  const root = document.querySelector('[data-debug-hud-root]');
  if (root) debugHud.mount(root);
}

// ---- Render loop ---------------------------------------------------------

/**
 * Walk the scene and sum the vertex + triangle counts of every `Mesh`.
 * Non-indexed meshes report `position.count / 3` triangles (each 3
 * vertices is a triangle). The result is the total "rasterization
 * work" the GPU is asked to do this frame.
 *
 * O(N) in the number of meshes, but for the demo field
 * (~80 asteroids × 1–3 meshes each ≈ 200 meshes) this is well under
 * 0.1ms — safe to call every frame.
 *
 * @param {THREE.Scene} scene
 * @returns {{ vertices: number, triangles: number }}
 */
function countSceneGeometry(scene) {
  let vertices = 0;
  let triangles = 0;
  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geom = obj.geometry;
    const vc = geom.attributes.position?.count ?? 0;
    vertices += vc;
    // Both `geom.index.count / 3` (indexed) and `vc / 3` (non-indexed)
    // can produce non-integers for malformed geometry, so floor at the
    // source rather than letting floats leak into the HUD.
    if (geom.index) {
      triangles += Math.floor(geom.index.count / 3);
    } else {
      triangles += Math.floor(vc / 3);
    }
  });
  return { vertices, triangles };
}

function tick(dt) {
  // ---- Edit screen (open) ------------------------------------------
  // The editor screen has its own lightweight 3D viewport (the
  // mini renderer inside the modal). The main 3D scene does
  // NOT render while the screen is open — the modal is opaque
  // and covers it, so rendering it would be wasted GPU work.
  if (editScreen.isOpen()) {
    editScreen.updateMini(dt);
    return;
  }
  // While the game is halted (pick mode, or edit screen open in
  // an earlier version), the gameplay ticks are skipped but the
  // chase camera + main render continue so the user can see the
  // scene. The chase camera is paused while the camera is
  // FOCUS-locked.
  if (gameHalted) {
    if (!cameraFocused) updateCamera(dt);
    renderer.render(scene, camera);
    return;
  }
  input.update();
  ship.update(dt);
  bullets.update(dt);

  // ---- Held-fire for the laser (rapid-fire while Space is held) ----
  // The input system fires `onFire` on the rising edge of Space
  // (one shot per press). The laser weapon is more fun with
  // hold-to-fire, so we add a per-frame "is Space held and the
  // laser is active and ready?" check here. The bullet uses the
  // rising-edge path; the laser uses both.
  //
  // Skip the call when the laser is already firing or on cooldown
  // — `laser.fire()` would reject anyway, so we'd just be paying
  // the cost of reading the ship state + allocating a direction
  // object for nothing. 60 calls/sec × 5 active frames per pulse
  // = ~300 wasted calls/sec avoided.
  if (
    input.state.isKeyDown('Space') &&
    powerupSystem.isLaserActive() &&
    stateMachine.getState() === State.PLAYING &&
    !laser.isFiring() &&
    !laser.isOnCooldown()
  ) {
    fireFromShip();
  }

  // ---- Laser update (follows the active firer, accumulates hits) ----
  // The laser follows whichever entity currently has it: the AI in
  // DEMO (when the AI collected the power-up) or the player in
  // PLAYING. `getActiveCollector()` returns the entity that picked
  // up the laser, or null if no laser is active. We fall back to
  // the player ship for the "no laser" case (the laser is dormant
  // in that case anyway; the ship arg is unused until firing).
  // This way the beam visually emanates from the AI's bow when the
  // AI has the laser, and from the player's bow otherwise.
  const laserFirer = powerupSystem.getActiveCollector() || ship;
  laser.update(dt, laserFirer, demoAsteroids);

  // ---- Asteroid streaming --------------------------------------------
  // The world layer (src/world/world.js) decides which chunks
  // should be live this frame. We act on its delta: spawn meshes
  // for newly-active chunks, despawn meshes for chunks that left
  // the bubble. The streaming runs in EVERY state (DEMO, PLAYING,
  // GAME_OVER) because the player sees the asteroid field in all
  // three states — only the collision layer is gated by state.
  //
  // `streamTimeS` is the wall-clock accumulator passed to
  // `updateStreamingBubble` as `nowS` and to `evictStaleChunks`
  // for the soft-cache TTL. It advances in lockstep with `dt`
  // inside the gameplay block — paused frames (gameHalted
  // early-return above) do NOT advance it, so the TTL measures
  // "seconds of gameplay" rather than wall-clock time.
  streamTimeS += dt;
  const streamDelta = updateStreamingBubble(world, ship.position, streamTimeS);
  spawnChunkEntities(streamDelta.added);
  spawnChunkEntities(streamDelta.reactivated);
  despawnChunkEntities(streamDelta.evicted);
  evictStaleChunks(world, streamTimeS);

  for (const a of demoAsteroids) a.update(dt, camera);
  // AI only runs in DEMO (attract screen). In PLAYING and
  // GAME_OVER the AI is paused — invisible, no movement, no
  // shooting — so the player has the bullet pool to themselves.
  if (stateMachine.getState() === State.DEMO) {
    demoAi.update(dt);
  }

  // ---- Power-up system -----------------------------------------------
  // Updates the active power-up's countdown, the pending power-up's
  // lifetime, and the respawn timer. Picks up automatically when
  // the ship overlaps the pending power-up. See
  // src/systems/powerup-system.js.
  powerupSystem.update(dt, demoAsteroids);

  processCollisions();
  updateCamera(dt);

  // ---- NEBULA_RENDER_THRESHOLD wiring --------------------------------
  // The single global skydome's opacity reflects the ship's current
  // chunk's `chunkHasNebula` decision. This is the only consumer of
  // NEBULA_RENDER_THRESHOLD in the render loop today (a future
  // per-chunk nebula-volume streaming layer will also read it). The
  // fade is time-smoothed inside nebula.update(camera, dt) so a slow
  // cross feels cinematic, not snappy.
  //
  // Compute the ship's current chunk, look up its density, compare
  // against the threshold. We import `chunkHasNebula` directly so
  // the predicate is the single source of truth in src/world/.
  const shipChunk = worldToChunk(ship.position);
  const inNebula = chunkHasNebula({ cx: shipChunk.cx, cz: shipChunk.cz, systemSeed: INITIAL_SYSTEM_SEED });
  nebula.setOpacityTarget(inNebula ? NEBULA_MAX_OPACITY : 0);

  // ---- Nebula debug overlay (per-chunk threshold markers) -----------
  // Only updates the per-chunk marker positions/colors when the
  // overlay is enabled. The `densityAt` function is reused so the
  // overlay shows the same per-chunk densities the threshold
  // decision is based on.
  if (nebulaDebug.isEnabled()) {
    nebulaDebug.update(ship.position, (cx, cz) => densityAt(cx, cz, INITIAL_SYSTEM_SEED));
  }

  renderer.render(scene, camera);

  // Compute scene rasterization cost once per frame (cheap).
  const sceneGeom = countSceneGeometry(scene);

  // ---- HUD per-frame update -----------------------------------------
  // The power-up HUD (label + draining bar + seconds remaining) is
  // driven by the render loop's `hud.update({...})` call, not by
  // bus events (so the bar drains smoothly without event spam).
  // Score / lives / state-message continue to be event-driven.
  hud.update({
    powerup: {
      active: powerupSystem.isLaserActive(),
      type: powerupSystem.getActiveType(),
      remaining: powerupSystem.getActiveRemaining(),
      max: powerupSystem.getActiveMax(),
      hasPending: !!powerupSystem.getPendingSpawn(),
    },
  });

  // Push the latest diagnostic snapshot to the debug HUD. The HUD
  // throttles its DOM writes to ~12Hz internally.
  debugHud.update({
    state: stateMachine.getState(),
    score,
    lives,
    asteroidCount: demoAsteroids.length,
    // `getActiveChunks` is the public read-helper for the streaming
    // layer's live-chunk count. We use its length (rather than
    // `world.active.size`) so the public API surface is exercised
    // on every frame — same numeric result, and the public function
    // gets validated. At ~49 chunks the array allocation is <0.01ms
    // and the result is short-lived.
    liveChunks: getActiveChunks(world).length,
    sceneVerts: sceneGeom.vertices,
    sceneTris: sceneGeom.triangles,
    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    ship: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
  });
}

function loop() {
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp to avoid huge jumps
  tick(dt);
  requestAnimationFrame(loop);
}
loop();

// ---- Dev-friendly console banner ----------------------------------------
console.log(
  '%c Asteroids → Elite %c scaffolded ',
  'background:#48dbfb;color:#05060c;font-weight:bold;padding:2px 6px;border-radius:2px;',
  'color:#97a3c4;',
);
console.log('Ship online. WASD/arrows to fly, Space to fire, any key to start.');
console.log(`State: ${stateMachine.getState()}   Lives: ${lives}   Score: ${score}`);
