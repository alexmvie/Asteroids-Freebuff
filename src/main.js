import { Clock } from 'three';
import './styles.css';
import { createScene } from './scene.js';
import { createShip, loadShipModel } from './entities/ship.js';
import { createAsteroidFromSpec } from './entities/asteroid.js';
import { createBulletPool } from './entities/bullet.js';
import { createLaser } from './entities/laser.js';
import {
  densityAt,
  chunkHasNebula,
  INITIAL_SYSTEM_SEED,
  NEBULA_MAX_OPACITY,
  worldToChunk,
  getActiveChunks,
  CHUNK_SIZE,
  BUBBLE_RADIUS_CHUNKS,
} from './world/index.js';
import { createInputSystem } from './systems/input.js';
import {
  findBulletHits,
  findShipHit,
  scoreForSize,
  findAsteroidPairs,
  resolveAsteroidCollision,
  findAsteroidPowerupIndex,
  resolveAsteroidPowerupCollision,
  findBulletShipHits,
  SHIP_RADIUS,
  BULLET_RADIUS,
} from './systems/collision.js';
import { createSpatialHash } from './systems/spatial-hash.js';
import { createEventBus } from './systems/events.js';
import { createStateMachine, State } from './systems/state.js';
import { createHud } from './ui/hud.js';
import { createDebugHud } from './ui/debug-hud.js';
import { createAiDebugOverlay } from './ui/ai-debug-overlay.js';
import {
  AI_TUNABLES,
  resetAITunables,
  exportAITunables,
} from './entities/ai-tunables.js';
import { createAiTunersPanel } from './ui/ai-tuners-panel.js';
import { createColumnToggle } from './ui/column-toggle.js';
import { VERSION } from './version-constants.js';
// __BRANCH__ + __COMMIT__ are Vite-define globals, populated from git at
// config-load time in vite.config.js. See that file for the rationale
// (chicken-and-egg-free alternative to baking the SHA into a committed
// file).
import { createDemoAi } from './entities/ai.js';
import { createAsteroidField } from './systems/asteroid-field.js';
import { createPowerUpSystem } from './systems/powerup-system.js';
import { createPirateTexture, applyPirateTexture } from './systems/pirate-texture.js';
import { createParticleSystem } from './systems/particles.js';
import { createCaptureMarkers } from './systems/capture-markers.js';
import { createAiFlightDebug } from './systems/ai-flight-debug.js';
import { createShowcase } from './systems/showcase.js';
import { createSsaoPostprocess } from './systems/ssao.js';
import { SSAO_ENABLED_DEFAULT } from './scene/ssao-constants.js';

// ---- Radar radius (v0.59.0 + v0.62.0) -----------------------------------
// Multiplier on the streaming bubble radius (= CHUNK_SIZE ×
// BUBBLE_RADIUS_CHUNKS) used as the AI Debug Overlay's radar scope.
// Per the user's request ("the radar should be ~3× the ship sight"),
// 3× gives a generous outer ring beyond the streamed chunks.
//
// **v0.62.0 — now live-tunable.** The "tunable" storage is
// `AI_TUNABLES.radarBubbleMultiplier` (added in
// src/entities/ai-tunables.js). The AI Live Tuners panel hosts the
// slider; the radar's `getWorldRadius` closure re-reads the value
// every frame so a slider drag is visible on the next render loop
// tick. The literal here is kept as the FALLBACK only (used when
// the tuners bag is missing or unreachable in tests). The named
// constant stays useful for grep-discoverability —
// RADAR_BUBBLE_MULTIPLIER_DEFAULT is a "what's the canonical
// multiplier" SSOT, not a per-frame read.
const RADAR_BUBBLE_MULTIPLIER_DEFAULT = 3;

// ---- Pirate HP (v0.60.0 — pirate combat loop) ---------------------------
// Pirates need HP to die. Tracked externally rather than as a ship
// property because (a) the player ship has its own energy system and
// (b) the AI brain is generic — pirate-specific combat state would
// pollute the universal ship.js API. The map is keyed by ship
// object (live reference); dead pirates have their entry removed
// on the same frame as their dispose() call.
const PIRATE_MAX_HP = 3; // bullets to kill a pirate
const pirateHps = new Map(); // ship -> hp remaining (1..PIRATE_MAX_HP)

function killPirate(ai) {
  const s = ai.getShip();
  pirateHps.delete(s);
  // Spawn an explosion at the kill site so the death feels like
  // asteroid destruction (consistent particle effect for any
  // entity kill in the game). SHIP_RADIUS scales the puff size.
  const pos = s.position;
  particles.emitExplosion({ x: pos.x, y: pos.y, z: pos.z }, SHIP_RADIUS);
  // Hide the engine glow BEFORE dispose — ship.dispose() preserves
  // glows (so GLB-swapped ships keep their thrust glow), but a
  // destroyed pirate would otherwise leave a small floating glow.
  s.mesh.traverse((obj) => {
    if (obj.userData && obj.userData.isEngineGlow) obj.visible = false;
  });
  ai.dispose();
  bus.emit('pirate:died', { ship: s });
}

function damagePirate(ai) {
  const s = ai.getShip();
  const hp = (pirateHps.get(s) ?? PIRATE_MAX_HP) - 1;
  if (hp <= 0) {
    killPirate(ai);
  } else {
    pirateHps.set(s, hp);
    bus.emit('pirate:hit', { ship: s, hp });
  }
}

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
// **Type rotation (v0.11.x):** the type is no longer hardcoded as
// 'shield' — powerup-system.js draws from
// `POWERUP_SPAWN_WEIGHTS (in src/systems/powerup-system.js)` on every spawn. With the
// default equal weights (each type = 1.0) the player sees ~1/6
// chance per type per drop. The 6 types come from `POWERUP_SPAWN_WEIGHTS` in `src/systems/powerup-system.js`: shield (mint, instant
// energy refill), speed (orange, thrust ×2), energy (yellow,
// recharge ×2), credits (gold, score ×2), hull (red, damage
// ×0.5), weapon (purple, fire rate ×2).
//
// **Tuning history:**
//   - 2026-06-16: bumped to 1.0 (user asked for "every destroy
//     drops a powerup"; trainer has 6 powerup types now so
//     variety is the goal, not scarcity).
//   - 2026-06-13: was 0.95 (user asked for "almost every
//     destroy" — 5% chance to miss kept it from feeling 100%
//     deterministic).
//   - 2026-06-12: was 0.10 (10% per kill, "fair spawn rate").
//   - 2026-06-11: was a literal `Math.random() < 0.10` guard,
//     no constant.
//
// Adjust this single number to retune the drop rate. Range is
// 0.0–1.0; values > 1.0 are treated as 1.0 (always drop).
const POWERUP_DROP_CHANCE = 1.0;

// ---- Boot ----------------------------------------------------------------
const {
  renderer,
  scene,
  camera,
  nebula,
  nebulaDebug,
  setChaseTarget,
  updateCamera,
  updateLighting,
} = createScene();
const clock = new Clock();

// ---- v0.72.0 — Object-Viewer showcase mode ------------------------------
// A second, game-free demo mode that reuses the EXACT same rendering
// setup (same scene, camera, sun, nebula, starfield, shadow map, ACES
// tone mapping) but runs no game logic: every 3D object the game can
// produce (5 asteroid shapes × 5 textures, player ship, pirate ship,
// 6 power-ups) is shown one at a time on a turntable, navigated with
// the arrow keys — like a character-select screen. Activation: F1 at
// runtime, or `?showcase` in the URL for the screenshot/iteration
// loop. `window.__showcase` exposes the automation API. See
// src/systems/showcase.js.
// ---- v0.73.0 — SSAO postprocessing (GTAO) -------------------------------
// Screen-space ambient occlusion: darkens contact shadows where asteroid
// boulders / crater rims touch, removing the "flat matte" tell. Chain:
// RenderPass → GTAOPass (half-res) → OutputPass (re-applies ACES, which
// r152+ skips when rendering into a composer buffer). Toggle: the
// `#debug-toggle-ssao` HUD button, `window.SSAO` in devtools, or the
// SSAO_ENABLED_DEFAULT constant. When disabled, `render()` falls back
// to the plain renderer.render fast path — pixel-identical to
// pre-v0.73.0. See src/systems/ssao.js.
const ssao = createSsaoPostprocess({ renderer, scene, camera });

const showcase = createShowcase({ scene, camera, nebula, updateLighting, canvas: renderer.domElement });
if (typeof window !== 'undefined') {
  window.__showcase = showcase;
  // URL boot: `?showcase` starts the page directly in the object viewer
  // (no game). Used by the visual iteration loop to screenshot objects.
  try {
    if (new URLSearchParams(window.location.search).has('showcase')) {
      showcase.activate();
    }
  } catch { /* SSR */ }

  // v0.72.3 — view-toggle button (bottom-left): the visible clickable
  // control for the game ↔ object-viewer switch (same action as F1).
  // The label flips while the showcase is active, driven by the same
  // showcase:active / showcase:inactive events the automation loop
  // uses. The initial state is seeded explicitly because a `?showcase`
  // URL boot fires showcase:active BEFORE this listener is registered.
  const viewToggle = document.getElementById('view-toggle');
  if (viewToggle) {
    const setViewToggle = (isShowcase) => {
      viewToggle.textContent = isShowcase ? 'EXIT OBJECT VIEW' : 'OBJECT VIEW';
      viewToggle.classList.toggle('view-toggle--active', isShowcase);
      viewToggle.setAttribute('aria-pressed', String(isShowcase));
    };
    viewToggle.addEventListener('click', () => showcase.toggle());
    window.addEventListener('showcase:active', () => setViewToggle(true));
    window.addEventListener('showcase:inactive', () => setViewToggle(false));
    setViewToggle(showcase.isActive());
  }
}

// ---- SSAO runtime toggle (v0.73.0) --------------------------------------
// `window.SSAO = true/false` flips the postprocessing pass live (same
// devtools pattern as NEBULA_DEBUG / AI_FLIGHT_DEBUG). The
// `#debug-toggle-ssao` HUD button drives the same setter and stays in
// sync via `updateSsaoBtn` (declared above the setter so the closure is
// TDZ-safe — the setter may fire during boot, before the button wiring
// block below runs; `?.()` no-ops while it's still null).
let updateSsaoBtn = null;
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'SSAO', {
    configurable: true,
    enumerable: true,
    get() { return ssao.isEnabled(); },
    set(v) { ssao.setEnabled(!!v); updateSsaoBtn?.(); },
  });
}

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
}




const bus = createEventBus();
const stateMachine = createStateMachine({ initial: State.DEMO, events: bus });

// ---- Ship ---------------------------------------------------------------
const ship = createShip({ scene, events: bus });
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

// ---- Bullet pools -------------------------------------------------------
// Player and AI each get their own pool. No cooldown sharing, no score
// bleed, no ghost bullets on state transitions. Capacity is tuned per role:
// the player needs headroom for rapid fire; the AI fires at a lower rate.
const playerBullets = createBulletPool({ scene, capacity: 64 });
const aiBullets = createBulletPool({ scene, capacity: 16 });

// ---- Laser weapon -------------------------------------------------------
// The ship's "piercing beam" — fires a long sky-blue beam that cuts
// through every asteroid in its path. Active while the laser
// power-up is collected (see `createPowerUpSystem` below). The
// laser is an alternative to bullets, not a stack: while the laser
// is the active weapon, Space fires the laser instead of a bullet.
const laser = createLaser({ scene });

// ---- Asteroid field (streaming) ----------------------------------------
// Extracted to src/systems/asteroid-field.js. Public API:
//   field.update(shipPos, dt, camera)   — streaming + per-asteroid LOD
//   field.clearAll()                     — wipe on game restart
//   field.getEntities()                  — read-only entity array
//   field.getWorld()                     — world object (for powerupSystem)
const field = createAsteroidField({ scene });

// ---- Particle system ---------------------------------------------------
// Smoke puffs + stone debris on asteroid destruction. Updated every
// frame in the render loop; emits on each asteroid kill in
// processCollisions. See src/systems/particles.js.
const particles = createParticleSystem({ scene });

// ---- Collision cage debugger -------------------------------------------
// Wireframe spheres around every collision hull (ship, asteroids,
// power-up, bullets). Toggled via the left debug HUD. Useful for
// verifying that visual overlap matches the collision spheres.

// ---- Capture markers ---------------------------------------------------
// High-contrast overlays (green ship ring, red asteroid wireframes,
// yellow powerup ring) for video analysis. Toggled via the left
// debug HUD and via `window.CAPTURE_MARKERS`.
const captureMarkers = createCaptureMarkers({ scene });

// ---- AI flight debug (3D overlay) --------------------------------------
// Visualises the AI's velocity vector, desired heading, and chase
// target so bad maneuvers are obvious at a glance. Toggled via the
// left debug HUD and via `window.AI_FLIGHT_DEBUG`.
const aiFlightDebug = createAiFlightDebug({ scene });
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'AI_FLIGHT_DEBUG', {
    configurable: true,
    enumerable: true,
    get() { return aiFlightDebug.isEnabled(); },
    set(v) { aiFlightDebug.setEnabled(!!v); },
  });
}

// ---- Debug HUD: SSAO toggle button (v0.73.0) ----------------------------
// Same pattern as the CAPTURE / AI FLIGHT toggle buttons in the left
// debug column: click toggles the pass, label + --on class reflect the
// live state (also updated when `window.SSAO` is set in devtools).
const ssaoBtn = document.getElementById('debug-toggle-ssao');
if (ssaoBtn) {
  updateSsaoBtn = () => {
    const on = ssao.isEnabled();
    ssaoBtn.textContent = `SSAO: ${on ? 'ON' : 'OFF'}`;
    ssaoBtn.classList.toggle('debug-hud__toggle--on', on);
  };
  ssaoBtn.addEventListener('click', () => {
    ssao.setEnabled(!ssao.isEnabled());
    updateSsaoBtn();
  });
  updateSsaoBtn();
}

// ---- Debug HUD: Capture markers toggle button -------------------------
const captureBtn = document.getElementById('debug-toggle-capture');
if (captureBtn) {
  const updateCaptureBtn = () => {
    const on = captureMarkers.isEnabled();
    captureBtn.textContent = `CAPTURE: ${on ? 'ON' : 'OFF'}`;
    captureBtn.classList.toggle('debug-hud__toggle--on', on);
  };
  captureBtn.addEventListener('click', () => {
    captureMarkers.setEnabled(!captureMarkers.isEnabled());
    updateCaptureBtn();
  });
  const originalSetEnabled = captureMarkers.setEnabled;
  captureMarkers.setEnabled = (v) => {
    originalSetEnabled(v);
    updateCaptureBtn();
  };
  updateCaptureBtn();
}

// ---- Debug HUD: AI flight debug toggle button --------------------------
const aiFlightBtn = document.getElementById('debug-toggle-ai-flight');
if (aiFlightBtn) {
  const updateAiFlightBtn = () => {
    const on = aiFlightDebug.isEnabled();
    aiFlightBtn.textContent = `AI FLIGHT: ${on ? 'ON' : 'OFF'}`;
    aiFlightBtn.classList.toggle('debug-hud__toggle--on', on);
  };
  aiFlightBtn.addEventListener('click', () => {
    aiFlightDebug.setEnabled(!aiFlightDebug.isEnabled());
    updateAiFlightBtn();
  });
  const originalSetEnabled = aiFlightDebug.setEnabled;
  aiFlightDebug.setEnabled = (v) => {
    originalSetEnabled(v);
    updateAiFlightBtn();
  };
  updateAiFlightBtn();
}

// ---- Demo AI -----------------------------------------------------------
// NPC ship that hunts the nearest asteroid and shoots at it when the
// target is in front (a ~20° cone), in addition to the original
// wander/dodge behaviors. Same ship look as the player, infinite
// lives, never collides with the player. See src/entities/ai.js.
// The AI fires into its OWN bullet pool (aiBullets) — no cooldown
// contention with the player. The laser is still a singleton (one
// beam mesh); when the AI collects it, the AI fires the laser
// instead of bullets. Ownership is determined by comparing the
// power-up's active collector against the AI ship.
const aiWeapon = {
  fire({ origin, direction, asteroids }) {
    const aiShip = demoAi.getShip();
    if (
      powerupSystem.isLaserActive() &&
      powerupSystem.getActiveCollector() === aiShip
    ) {
      return laser.fire({ origin, direction, asteroids });
    }
    return aiBullets.fire({ origin, direction });
  },
};

const demoAi = createDemoAi({
  scene,
  asteroids: field.getEntities(),
  weapon: aiWeapon,
  // The AI chases pending power-ups as its highest-priority behavior.
  // getPendingSpawn() returns the power-up entity (with .getPosition())
  // or null when no power-up is waiting in the world.
  getPowerupPos: () => {
    const p = powerupSystem.getPendingSpawn();
    return p ? p.getPosition() : null;
  },
  // Power-ups can be pushed by asteroid collisions (pushAway). The AI
  // needs the velocity to predict where the power-up will be when the
  // ship arrives; without it the ship chases the current position and
  // misses moving pickups.
  getPowerupVel: () => {
    const p = powerupSystem.getPendingSpawn();
    return p && typeof p.getVelocity === 'function' ? p.getVelocity() : { x: 0, z: 0 };
  },
  // v0.22.x Step 4 (Laser-Awareness): tell the brain whether the
  // laser power-up is currently active. aiBrainTick branches its
  // fire-loop on this: 'bullet' → distance-gated wide-cone fire
  // (Step 3), 'laser' → tight ~3° cone lock-on the chase target
  // with no dist gate. The brain re-reads this every tick (the
  // hook is a closure), so the AI automatically switches its aim
  // style the moment the laser power-up is picked up or expires.
  getActiveWeapon: () => (powerupSystem.isLaserActive() ? 'laser' : 'bullet'),
  // No `options` override needed — the factory uses the hand-coded
  // rule-based brain by default (see createDemoAi in src/entities/ai.js).
});

// ---- v0.56.0: 2 pirate ships foundation -------------------------
// Same factory, pirate role via `options.aggroDist: 300` (the live
// `AI_TUNABLES.aggroDist` is `0` by default; the per-factory override
// turns the pirate behavior ON for these two ships only). Shared
// `aiWeapon` bullet pool. Always visible (no state-dependent toggle
// for v0.56.0 — future work for pirate-mode combat). Tinted red AND
// textured with the v0.57.0 procedural hazard pattern so the pirates
// look visibly distinct from the smooth white/cyan player + demo AI.
const PIRATE_RED = 0xff3333;

// v0.57.0: generate the shared pirate texture ONCE. Browser-only:
// `createPirateTexture` throws in Node because it uses
// `document.createElement('canvas')`. In production this only runs
// in the page-load path (the bottom of main.js after Vite has set
// up the DOM). Pixel content: charcoal base + 6 diagonal hazard
// stripes (dark-red alternating with base) + 4 amber warning
// triangles at deterministic positions (seed=1337). Tiled 2x2
// across each ship mesh via `texture.repeat`.
const pirateTexture = createPirateTexture({ size: 256, seed: 1337, repeat: 2 });

/**
 * Walk a ship's mesh tree and recolor every material to `colorHex`.
 * Applied AFTER `createDemoAi` calls `createShip` inside its factory.
 * The engine glow (tagged `isEngineGlow`) is recolored too — the
 * procedural glow's emissive is set to match the body so the pirate
 * glow looks red during thrust instead of the default cyan.
 */
function tintShipAs(ship, colorHex) {
  ship.mesh.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      obj.material.color.setHex(colorHex);
      if (obj.material.emissive) obj.material.emissive.setHex(colorHex);
    }
  });
}

// Pirate 1 — spawns at (+100, +80) facing toward origin.
// v0.60.0: getShips now includes BOTH the player AND pirate2 so the
// pirate attacks other pirates too (the foundation for pirate-mode
// combat).
//
// **Forward-reference pattern (TIMING NOTE):** the closure body
// references `pirate2`, which is declared AFTER pirate1 in source
// order. At `createDemoAi()` time, `pirate2` is in the TDZ — the
// closure is CREATED but NOT INVOKED. By the time the closure runs
// (in `update()`), pirate2 has been assigned. The
// `pirate2 && pirate2.isAlive()` guard handles both TDZ and
// disposed-pirate cases. Don't move this closure to a synchronous
// context without first reordering the declarations.
const pirate1 = createDemoAi({
  scene,
  asteroids: field.getEntities(),
  weapon: aiWeapon,
  getShips: () => [ship, pirate2 && pirate2.isAlive() ? pirate2.getShip() : null].filter(Boolean),
  options: {
    aggroDist: 300,
    spawnRadius: 0,
    spawnYaw: 0,
    rng: () => 0,
  },
});
tintShipAs(pirate1.getShip(), PIRATE_RED);
pirate1.getShip().reset({ x: 100, y: 0, z: 80 });
pirateHps.set(pirate1.getShip(), PIRATE_MAX_HP);

// v0.57.0: apply the procedural pirate texture (hazard stripes +
// warning triangles) so the pirates look visibly distinct from the
// smooth cyan-winged player/demo AI ships. The texture is generated
// ONCE and shared between both pirates (canvas paint is the
// expensive bit; the THREE.CanvasTexture wrapper is reusable).
applyPirateTexture(pirate1.getShip(), pirateTexture);

// Pirate 2 — spawns at (-100, -80) facing toward origin.
const pirate2 = createDemoAi({
  scene,
  asteroids: field.getEntities(),
  weapon: aiWeapon,
  getShips: () => [ship, pirate1 && pirate1.isAlive() ? pirate1.getShip() : null].filter(Boolean),
  options: {
    aggroDist: 300,
    spawnRadius: 0,
    spawnYaw: Math.PI,
    rng: () => 0.5,
  },
});
tintShipAs(pirate2.getShip(), PIRATE_RED);
pirate2.getShip().reset({ x: -100, y: 0, z: -80 });
pirateHps.set(pirate2.getShip(), PIRATE_MAX_HP);
applyPirateTexture(pirate2.getShip(), pirateTexture);

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
  world: field.getWorld(),
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
    // Longer lifetime in DEMO so the AI has enough time to navigate
    // the dense asteroid field and actually collect the power-up.
    // v0.41.0: raised from 12s to 20s after the AI was given stronger
    // powerup priority and braking authority.
    powerupLifetimeByState: {
      DEMO: 20,
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

// ---- Game state (score + energy) ---------------------------------------
// Owned by main.js. The HUD subscribes to 'score:changed' on the bus and
// to the ship's own 'energy:changed' events (the ship is created with
// `events: bus` above). The v0.10.x `let lives = 3` mechanic is fully
// removed: the player dies when `ship.energy <= 0` (a `takeDamage` that
// drains the last point triggers GAME_OVER via the check in
// processCollisions). The energies counter (lives in spirit) lives
// entirely on the ship now and is reflected in the HUD via the events
// bus — no player-side state mirror needed.
let score = 0;

// ---- AI tuning metrics (exposed to browser automation) ------------------
// `window._aiMetrics` is read by the hands-off capture scripts to measure
// powerup collection, score progression, and other AI behaviors without
// parsing the screen. See scripts/ai_browser_capture.py.
const aiMetrics = {
  powerupsCollected: 0,
  powerupTypes: [],
  powerupsSpawned: 0,
  asteroidsDestroyed: 0,
  score: 0,
};
if (typeof window !== 'undefined') {
  window._aiMetrics = aiMetrics;
}

// Subscribe to game events that the tuning loop cares about.
bus.on('powerup:collected', (e) => {
  aiMetrics.powerupsCollected += 1;
  aiMetrics.powerupTypes.push(e.type);
});
bus.on('powerup:spawned', () => {
  aiMetrics.powerupsSpawned += 1;
});
// score:changed is emitted on every score change; asteroidsDestroyed is
// approximated by counting score events where the score actually went up.
let lastScore = 0;
bus.on('score:changed', (e) => {
  aiMetrics.score = e.score;
  if (e.score > lastScore) {
    aiMetrics.asteroidsDestroyed += 1;
  }
  lastScore = e.score;
});
function resetRunState() {
  // Clear both bullet pools so no shots from the previous run linger.
  playerBullets.forEachActive((b, i) => playerBullets.despawn(i));
  aiBullets.forEachActive((b, i) => aiBullets.despawn(i));
  score = 0;
  ship.reset({ x: 0, y: 0, z: 0 }); // also clears energy + buffs + emits energy:changed
  // Wipe the world + entities. The next render-loop tick will
  // re-populate the bubble around the ship's reset position.
  field.clearAll();
  // Wipe the power-up state. The next PLAYING tick will spawn
  // a fresh power-up.
  powerupSystem.clearAll();
  // Clear lingering explosion particles from the previous run.
  particles.clear();
  bus.emit('score:changed', { score });
}

// ---- Player weapon ------------------------------------------------------
// Mirrors the AI weapon pattern: a duck-typed `{ fire(opts) }` object that
// derives direction from the ship's yaw and routes through the laser
// (when active) or the player's bullet pool. Gated to PLAYING state only.
const playerWeapon = {
  fire({ asteroids }) {
    if (stateMachine.getState() !== State.PLAYING) return;
    const yaw = ship.rotation.yaw;
    const direction = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    if (powerupSystem.isLaserActive()) {
      return laser.fire({ origin: ship.position, direction, asteroids });
    }
    return playerBullets.fire({ origin: ship.position, direction });
  },
};

// ---- Input --------------------------------------------------------------
const input = createInputSystem({
  ship,
  onFire: () => playerWeapon.fire({ asteroids: field.getEntities() }),
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
function processCollisions(dt) {
  const state = stateMachine.getState();
  if (state === State.GAME_OVER) return;

  // Cache the entity array reference — used many times below.
  const asteroids = field.getEntities();

  // ---- Ship roster + shipHash (v0.64.x spatial-hash broad-phase) ----
  // Built ONCE per frame because ship positions don't change within
  // processCollisions (the AI ships update once per tick, before
  // collisions; pirates don't spawn mid-frame). The roster is the
  // player + both pirates filtered for liveness + finite position.
  // cellSize=8 covers all 3x3 candidate scans for the relatively
  // small ship set (max combined radius 3u ship + 0.15u bullet).
  function aliveShip(ai) {
    return ai && ai.isAlive && ai.isAlive() ? ai.getShip() : null;
  }
  const shipTargets = [
    ship,
    aliveShip(pirate1),
    aliveShip(pirate2),
  ].filter((s) => s && s.position && typeof s.position.x === 'number');
  const shipHash = createSpatialHash({ cellSize: 8 });
  shipHash.rebuild(shipTargets);

  // ---- Asteroid ↔ asteroid (push apart + elastic bounce) ------------
  // O(n²) but cheap for ~300 asteroids (~45K checks, <0.1ms). Runs in
  // EVERY non-GAME_OVER state so the AI's demo field looks dynamic.
  // Resolved BEFORE bullet/laser checks so the new positions are
  // settled before the destruction pass.
  //
  // v0.64.x: still O(n²) for this initial pass because the
  // resolveAsteroidCollision mutates positions, so any hash built
  // before this loop would have stale buckets. The post-resolve
  // asteroidHash below is the broad-phase used by the subsequent
  // bullet + ship queries.
  {
    const pairs = findAsteroidPairs(asteroids);
    for (const { i, j } of pairs) {
      resolveAsteroidCollision(asteroids[i], asteroids[j]);
    }
  }

  // Post-bounce asteroidHash. ~0.05ms rebuild at MVP scale
  // (300 inserts ≈ 0.05ms in V8). cellSize=16 covers the
  // max-combined-radius worst case (5+5=10u asteroid↔asteroid) with
  // comfortable safety margin — sqrt(2)*16 ≈ 22.6u diagonal reach.
  const asteroidHash = createSpatialHash({ cellSize: 16 });
  asteroidHash.rebuild(asteroids);

  // ---- Asteroid ↔ powerup (push powerup out of overlapping asteroid) --
  // Keeps the pending power-up from being buried inside an asteroid.
  {
    const pending = powerupSystem.getPendingSpawn();
    if (pending) {
      const pidx = findAsteroidPowerupIndex({ asteroids, powerup: pending, spatialHash: asteroidHash });
      if (pidx >= 0) {
        resolveAsteroidPowerupCollision(asteroids[pidx], pending);
      }
    }
  }

  // ---- Bullet ↔ asteroid (state-scoped to the correct pool) ----------
  // DEMO:   only the AI shoots (its bullets go to aiBullets).
  // PLAYING: only the player shoots (their bullets go to playerBullets).
  // Each pool is independent — no cooldown sharing, no score bleed.
  // v0.60.0: BOTH pools run ship-target collision against the live
  // ship roster (player + alive pirates) so bullets from any source
  // can damage any ship target.
  // v0.64.x: spatialHash broad-phase. ~30 candidates per bullet vs
  // 300, regardless of bullet count.
  const activePool = state === State.DEMO ? aiBullets : playerBullets;
  const bulletHits = findBulletHits({ asteroids, bullets: activePool, dt, spatialHash: asteroidHash });
  const asteroidsToRemove = new Set();
  for (const hit of bulletHits) {
    activePool.despawn(hit.bulletIndex);
    if (asteroidsToRemove.has(hit.asteroidIndex)) continue;
    asteroidsToRemove.add(hit.asteroidIndex);
    const asteroidScore = scoreForSize(asteroids[hit.asteroidIndex].spec.size);
    score += asteroidScore * ship.getScoreMultiplier();
  }

  // ---- Bullet ↔ ship (v0.60.0 — pirate combat) ------------------------
  // v0.60.0: pirate combat. Bullets from BOTH pools (player +
  // AI/pirates) can hit ANY ship target — player, pirate1,
  // pirate2. The dead-pirate filter (aliveShip above) ensures we
  // don't hit a disposed pirate's stale ship object. Each pirate
  // starts with PIRATE_MAX_HP; on HP=0 the pirate is disposed.
  // v0.64.x: spatialHash (over ship positions). The hull-mounted set
  // is tiny (3-4 ships), so speedup is marginal but consistent.
  for (const bullets of [playerBullets, aiBullets]) {
    const shipHits = findBulletShipHits({
      bullets,
      ships: shipTargets,
      bulletRadius: BULLET_RADIUS,
      shipRadius: SHIP_RADIUS,
      dt,
      spatialHash: shipHash,
    });
    for (const { bulletIndex, shipIndex } of shipHits) {
      bullets.despawn(bulletIndex);
      const target = shipTargets[shipIndex];
      if (target === ship) {
        // v0.61.0 — shield absorbs the hit. Bullet despawns (clean
        // up) but no damage applied + no GAME_OVER + no ship.reset().
        // The shield buff is for the PLAYER only (pirate attacks on
        // the player are absorbed; pirate-vs-pirate damage is NOT
        // affected — there's no `isShielded` check on the pirate
        // branch below).
        if (ship.isShielded()) {
          // Skip damage; bullet already despawned above.
        } else {
          // Apply damage + game-over transition identical to the
          // asteroid-hit path.
          const dmg = 25 * ship.getDamageMultiplier();
          const remaining = ship.takeDamage(dmg);
          if (ship.isDead() || remaining <= 0) {
            stateMachine.transition(State.GAME_OVER, { finalScore: score });
            bus.emit('game:over', { finalScore: score });
            ship.reset({ x: 0, y: 0, z: 0 });
          }
        }
      } else if (pirateHps.has(target)) {
        // Pirate hit. pirateHps is the SSOT for "is this a pirate";
        // no need for 3 separate `target === pirateN.getShip()` checks.
        // Pirates don't get the shield buff (intentional design — the
        // shield is for the player's defense against pirates).
        const ai = pirate1.getShip() === target ? pirate1 : pirate2;
        damagePirate(ai);
      }
      // Bullets despawned in this loop are gone for the rest of
      // the frame. The next `findBulletShipHits` pass for the
      // OTHER pool won't see them (different pool).
    }
  }

  // ---- Laser ↔ asteroid (piercing hits, run in DEMO + PLAYING) -------
  // The laser accumulates `pendingHits` over the pulse's visible
  // duration (the beam follows the ship, so a moving ship sweeps
  // through more asteroids). We consume one asteroid per frame here;
  // the next frame's `laser.update()` re-evaluates the beam.
  if (laser.isFiring()) {
    for (const asteroid of laser.getPendingHits()) {
      const idx = asteroids.indexOf(asteroid);
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
      const asteroidScore = scoreForSize(asteroid.spec.size);
      score += asteroidScore * ship.getScoreMultiplier();
      laser.consumeHit(asteroid); // consumed this frame
    }
  }

  if (asteroidsToRemove.size > 0) {
    bus.emit('score:changed', { score });
  }

  // Apply removals + spawn children, reverse order to preserve indices.
  const indices = [...asteroidsToRemove].sort((a, b) => b - a);
  for (const idx of indices) {
    const a = asteroids[idx];
    const destroyedPos = a.getPosition();
    const asteroidRadius = a.spec ? a.spec.radius : 2;
    const childSpecs = a.split();
    a.dispose();
    asteroids.splice(idx, 1);
    // ---- Explosion particle effect ----------------------------
    particles.emitExplosion(destroyedPos, asteroidRadius);
    for (const spec of childSpecs) {
      asteroids.push(createAsteroidFromSpec({ spec, scene }));
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

  // ---- Ship ↔ asteroid (PLAYING only) --------------------------------    // v0.11.0: replaces the v0.10.x `lives -= 1` mechanic with
    // energy-based damage. The hit cost is 25 energy points (the
    // `ENERGY_DAMAGE` literal — defined inline here as the SINGLE
    // source of truth on the `refine-coded-ai` branch; no trainer
    // to lockstep with). The hull buff halves incoming damage
    // via ship.getDamageMultiplier(). v0.61.0: shield absorbs the
    // hit — asteroid is disposed (consumed by collision) but no
    // damage + no GAME_OVER + no position reset.
  if (state !== State.PLAYING) return;
  // Re-key the asteroidHash AFTER the splice. The asteroid array is
  // now shorter (destroyed entries removed), so any cached hash
  // indices from before the splice would map to shifted entries.
  // The rebuild is cheap (~0.05ms) and corrects the indices.
  asteroidHash.rebuild(asteroids);
  const shipHitIdx = findShipHit({ ship, asteroids, spatialHash: asteroidHash });
  if (shipHitIdx >= 0) {
    const a = asteroids[shipHitIdx];
    a.dispose();
    asteroids.splice(shipHitIdx, 1);
    // v0.61.0 — shield absorbs the asteroid hit. The asteroid is
    // physically consumed (a.dispose + splice), but no energy damage
    // is applied and the player is not reset. Matches the bullet-
    // vs-player gating above (consistent shield contract).
    if (ship.isShielded()) {
      // Shield is active — no damage, no reset.
    } else {
      // Apply ship damage using the player's current damage multiplier
      // (hull-buff active → 0.5x). The ship emits `energy:changed` on
      // the bus itself; the HUD's energy bar updates from that event.
      const dmg = 25 * ship.getDamageMultiplier();
      const remaining = ship.takeDamage(dmg);
      if (ship.isDead() || remaining <= 0) {
        stateMachine.transition(State.GAME_OVER, { finalScore: score });
        bus.emit('game:over', { finalScore: score });
        // Reset the ship so the GAME_OVER overlay shows the player at
        // a sensible position (the camera continues to follow the
        // ship; a dead ship at the impact point would render free-fall).
        ship.reset({ x: 0, y: 0, z: 0 });
      } else {
        // Survived with energy left — pulse the player back to spawn.
        // (v0.10.x behavior preserved.)
        ship.reset({ x: 0, y: 0, z: 0 });
      }
    }
  }
}

// ---- State-change log (dev-friendly) -----------------------------------
stateMachine.subscribe((e) => {
  if (typeof console !== 'undefined') {
    console.log(`[state] ${e.from} → ${e.to}`, e.payload || '');
  }
});

// ---- Demo AI visibility + lifecycle ------------------------------------
// The AI ship is self-gating: it enables itself on DEMO enter and
// disables on DEMO exit. This replaces the inline state check in
// tick() — the AI's `update()` is a no-op when paused, so the
// render loop can call it unconditionally.
demoAi.setEnabled(stateMachine.getState() === State.DEMO); // seed initial
stateMachine.onEnter(State.DEMO, () => demoAi.setEnabled(true));
stateMachine.onExit(State.DEMO, () => demoAi.setEnabled(false));

// AI mesh: visible only in DEMO. Player mesh: hidden in DEMO (the
// attract screen shows the NPC, not the player's idle ship at origin).
//
// Seed the initial visibility — onEnter doesn't fire for the initial
// state, so the player mesh (visible by default) would otherwise show
// on the first frame.
if (ship && ship.mesh) ship.mesh.visible = false;

stateMachine.onEnter(State.DEMO, () => {
  const aiShip = demoAi && demoAi.getShip();
  if (aiShip && aiShip.mesh) aiShip.mesh.visible = true;
  if (ship && ship.mesh) ship.mesh.visible = false;
});
stateMachine.onExit(State.DEMO, () => {
  const aiShip = demoAi && demoAi.getShip();
  if (aiShip && aiShip.mesh) aiShip.mesh.visible = false;
  if (ship && ship.mesh) ship.mesh.visible = true;
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
stateMachine.onEnter(State.PLAYING, () => setCameraForState(State.PLAYING));
stateMachine.onEnter(State.GAME_OVER, () => setCameraForState(State.GAME_OVER));
stateMachine.onEnter(State.DEMO, () => setCameraForState(State.DEMO));
// onEnter only fires on transitions — seed the initial state manually.
setCameraForState(stateMachine.getState());

// ---- Reset score on DEMO → PLAYING transition -----------------------
// The AI's demo bullets go to aiBullets (not shared), so there's no
// pool to clear. The demo score (accumulated from AI kills in the
// attract screen) lives in the `score` variable, so we reset it
// here for a clean start. Energy is reset by the same transition via
// `ship.reset` from input's `onStart` → `resetRunState`. The bus
// emits `score:changed` for the HUD; the ship's own
// `energy:changed` event covers the energy HUD update.
stateMachine.onExit(State.DEMO, () => {
  if (stateMachine.getState() === State.PLAYING) {
    score = 0;
    bus.emit('score:changed', { score });
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

// ---- Debug column collapse toggle (v0.50.x + v0.51.x) ------------------
// Small button at the top-left of the debug column that hides/shows
// the entire column body (the AI debug overlay + diagnostic HUD).
// The button itself stays visible as the "little quad" the user
// can click again to expand. State persists in localStorage so the
// user's preference survives reloads. Default is expanded. v0.51.x
// extracted the shared `createColumnToggle` helper so the AI tuners
// column (right side) can reuse the exact same pattern. No hotkey
// bound — the button is the only control surface (keep it simple).
createColumnToggle({
  column: document.getElementById('debug-column'),
  toggleBtn: document.getElementById('debug-column-toggle'),
  storageKey: 'debugColumnCollapsed',
  collapsedClass: 'debug-column--collapsed',
  expandTitle: 'Expand debug panels',
  collapseTitle: 'Collapse debug panels',
});

// ---- AI tuners column collapse toggle (v0.51.x) ------------------------
// Right-side counterpart to the debug column toggle. Same shared
// helper, different storageKey + collapsedClass + titles. The toggle
// button is the "small square to the top right" the user asked for
// — when collapsed, only the 32x32 button is visible at top: 12px,
// right: 12px. When expanded, the body hangs below the HUD top bar
// via `margin-top: var(--space-5)` so it doesn't overlap the energy
// HUD on the right side of the top bar. Default is expanded.
createColumnToggle({
  column: document.getElementById('ai-tuners-column'),
  toggleBtn: document.getElementById('ai-tuners-column-toggle'),
  storageKey: 'aiTunersColumnCollapsed',
  collapsedClass: 'ai-tuners-column--collapsed',
  expandTitle: 'Expand AI tuners panel',
  collapseTitle: 'Collapse AI tuners panel',
});

// ---- AI tuning master flag (v0.48.0) -----------------------------------
// One switch that gates the ENTIRE AI-tuning component structure
// (panel + debug overlay + the HTML containers in index.html).
// Mirrors the project's "extract when 2+ consumers need it"
// guideline — the panel, the overlay, and a dev-only console banner
// all need to know whether AI tuning is enabled.
const AI_TUNING_ENABLED_DEFAULT = true;
function isAiTuningEnabled() {
  // Override order: 1) window.AI_TUNING_ENABLED at runtime (set via
  // devtools BEFORE this module loads — sets a localStorage note),
  // 2) localStorage 'aiTuningEnabled' (persisted across sessions),
  // 3) the build-time default above.
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('aiTuningEnabled');
      if (stored != null) return stored === '1' || stored === 'true';
    }
  } catch { /* SSR / privacy mode */ }
  return AI_TUNING_ENABLED_DEFAULT;
}
const AI_TUNING_ENABLED = isAiTuningEnabled();

// Component vars are null when AI tuning is disabled so the
// per-frame `if (aiDebugOverlay) update()` no-ops cleanly.
let aiDebugOverlay = null;
let aiTunersPanel = null;

if (AI_TUNING_ENABLED) {
  // v0.23.x AI Debug Overlay (bottom-right; radar + panels).
  // Always visible. Reads game state via per-frame getter closures.
  aiDebugOverlay = createAiDebugOverlay({
    getSubject: () => stateMachine.getState() === State.DEMO
      ? (demoAi && demoAi.getShip()) || ship
      : ship,
    getAiShip: () => demoAi && demoAi.getShip(),
    getLastDecision: () => demoAi && demoAi.getLastDecision
      ? demoAi.getLastDecision()
      : null,
    getActiveWeapon: () => (powerupSystem.isLaserActive() ? 'laser' : 'bullet'),
    getAsteroids: () => field.getEntities(),
    getPowerupPos: () => {
      const p = powerupSystem.getPendingSpawn();
      return p ? p.getPosition() : null;
    },
    getScore: () => score,
    getEnergy: () => ({
      value: ship.getEnergy ? ship.getEnergy() : 0,
      max: ship.getMaxEnergy ? ship.getMaxEnergy() : 100,
    }),
    getState: () => stateMachine.getState(),
    // v0.59.0 + v0.62.0: radar radius = `radarBubbleMultiplier` ×
    // ship sight (= bubble radius, i.e. 1800u at MVP defaults × 3.
    // v0.62.0 makes the multiplier live-tunable via the AI Live
    // Tuners panel (`AI_TUNABLES.radarBubbleMultiplier`). The live
    // getter below re-reads the bag every frame so a slider drag
    // is visible on the very next render loop tick. Falls back to
    // `RADAR_BUBBLE_MULTIPLIER_DEFAULT` if the bag is missing the
    // key OR has a non-finite value (defends against NaN/Infinity
    // sneaking past via `typeof === 'number'` — NaN is also a
    // number per the typeof test, so we use `Number.isFinite`
    // instead).
    getWorldRadius: () => {
      const mult = (AI_TUNABLES && Number.isFinite(AI_TUNABLES.radarBubbleMultiplier))
        ? AI_TUNABLES.radarBubbleMultiplier
        : RADAR_BUBBLE_MULTIPLIER_DEFAULT;
      return mult * CHUNK_SIZE * BUBBLE_RADIUS_CHUNKS;
    },
  });
  {
    const root = document.querySelector('[data-ai-debug-root]');
    if (root) aiDebugOverlay.mount(root);
  }

  // v0.46.x AI Live Tuners Panel (right of the AI debug overlay, OR
  // stacked below on narrow viewports). v0.48.0 adds inline SVG
  // visual guides per slider (cone / circle / speedometer / bar /
  // clock) so the user can see what each tunable controls. Each
  // row has a `data-tuner-guide="KEY"` cell containing an SVG that
  // morphs as the slider drags. RESET restores frozen defaults
  // (see AI_TUNABLE_DEFAULTS). COPY JSON writes the current
  // snapshot to clipboard + console.
  aiTunersPanel = createAiTunersPanel({
    tunables: AI_TUNABLES,
    resetFn: () => resetAITunables(),
    exportFn: () => exportAITunables(),
  });
  {
    const root = document.querySelector('[data-ai-tuners-root]');
    if (root) aiTunersPanel.mount(root);
  }  } else {
    // AI tuning disabled — completely scrub the AI-debug-overlay +
    // AI-tuners HTML roots AND the AI-tuners-column wrapper from the
    // DOM so nobody sees an empty container or an orphaned toggle.
    // The debug column wrapper is INTENTIONALLY kept: it hosts the
    // diagnostic HUD (#debug-hud) which is NOT gated by AI tuning
    // and should remain visible regardless. Done BEFORE the render
    // loop starts so position measurements in CSS don't see
    // zero-height elements.
    const removeIfMounted = (selector) => {
      if (typeof document === 'undefined') return;
      const el = document.querySelector(selector);
      if (el && typeof el.remove === 'function') el.remove();
    };
    removeIfMounted('[data-ai-tuners-root]');
    removeIfMounted('[data-ai-debug-root]');
    removeIfMounted('#ai-tuners-column');
    if (typeof console !== 'undefined') {
      console.log('[main] AI tuning disabled (AI_TUNING_ENABLED=false) — panel + overlay + guides + AI tuners column omitted.');
    }
  }

// Runtime toggle hook — `window.AI_TUNING_ENABLED = false` then
// reload to disable; `window.AI_TUNING_ENABLED = true` then reload
// to re-enable. Once the panel/overlay are mounted, runtime
// changes are no-ops (with a console warning) because tearing
// down + re-creating the factories mid-frame would require
// re-importing all the UI modules, which is not idiomatic for
// ESM. Documented convention is "set the flag, reload the page".
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'AI_TUNING_ENABLED', {
    configurable: true,
    enumerable: true,
    get() { return AI_TUNING_ENABLED; },
    set(v) {
      const next = !!v;
      try { localStorage.setItem('aiTuningEnabled', next ? '1' : '0'); }
      catch { /* ignore */ }
      if (aiDebugOverlay || aiTunersPanel) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[main] window.AI_TUNING_ENABLED is now ${next}; saved to localStorage. ` +
            'Reload the page for the change to take effect (mid-frame teardown is not supported).',
          );
        }
      }
    },
  });
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
  // v0.72.0 — showcase mode short-circuits the entire game tick: no
  // input, no ship physics, no streaming, no collisions, no AI. Only
  // the showcase's own turntable/nebula/lighting update + render.
  if (showcase.isActive()) {
    showcase.update(dt);
    ssao.render();
    return;
  }

  input.update();
  ship.update(dt);
  playerBullets.update(dt);
  aiBullets.update(dt);

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
    playerWeapon.fire({ asteroids: field.getEntities() });
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
  laser.update(dt, laserFirer, field.getEntities());

  // ---- Asteroid streaming (delegated to the field module) ----------
  field.update(ship.position, dt, camera);
  // AI is self-gating — calls update() every frame; the AI pauses
  // itself when disabled (outside DEMO). See onEnter/onExit above.
  demoAi.update(dt);

  // v0.56.0: pirate ships tick every frame regardless of state.
  // They're persistent world fixtures, not demo-state NPCs.
  pirate1.update(dt);
  pirate2.update(dt);

  // ---- Power-up system -----------------------------------------------
  // Updates the active power-up's countdown, the pending power-up's
  // lifetime, and the respawn timer. Picks up automatically when
  // the ship overlaps the pending power-up. See
  // src/systems/powerup-system.js.
  powerupSystem.update(dt, field.getEntities());

  processCollisions(dt);
  particles.update(dt);

  updateCamera(dt);
  // v0.68.0 — sun + shadows follow the ship each frame. Reads the
  // post-ship.update position so the shadow camera frustum centres
  // on the NEW position (not the previous frame's). Defensive against
  // missing/non-finite position (early-exits inside updateLighting).
  updateLighting(dt, ship.position);

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

  ssao.render();

  // Compute scene rasterization cost once per frame (cheap).
  const sceneGeom = countSceneGeometry(scene);

  // ---- HUD per-frame update -----------------------------------------
  // The power-up HUD (label + draining bar + seconds remaining) is
  // driven by the render loop's `hud.update({...})` call, not by
  // bus events (so the bar drains smoothly without event spam).
  // Score / lives / state-message continue to be event-driven.
  //
  // v0.61.0 — when activeType === 'shield', clip `remaining` to
  // ship.getShieldRemaining() so the bar never fills with the 15s
  // active-window time after the 10s shield buff has expired
  // (visually misleading — the shield would be gone but the bar
  // would still show ~5s of "shield active"). For all other types,
  // fall through to the active-window time. Keeps the chip label
  // + color (still says 'SHIELD') intact; only the bar fill changes.
  const powerupType = powerupSystem.getActiveType();
  const isShieldActive = powerupType === 'shield';
  hud.update({
    powerup: {
      active: powerupSystem.isLaserActive(),
      type: powerupType,
      remaining: isShieldActive
        ? ship.getShieldRemaining()
        : powerupSystem.getActiveRemaining(),
      max: powerupSystem.getActiveMax(),
      hasPending: !!powerupSystem.getPendingSpawn(),
    },
  });

  // Subject for the debug HUD position rows: the AI in DEMO (camera
  // follows the AI there), the player otherwise. Mirrors
  // `setCameraForState` so the row tracks what the player is actually
  // looking at.
  const subject = stateMachine.getState() === State.DEMO
    ? (demoAi && demoAi.getShip()) || ship
    : ship;

  // ---- Capture markers -------------------------------------------------
  // High-contrast overlays for video analysis. Updated every frame so
  // the markers follow moving objects. The `window._captureState`
  // object is written by the browser automation scripts to surface
  // recording status + remaining time in the debug HUD. We cache the
  // last seen enabled state locally so we don't read the global every
  // frame.
  if (typeof window !== 'undefined') {
    const cs = window._captureState;
    const wantEnabled = cs ? !!cs.enabled : false;
    if (wantEnabled !== captureMarkers.isEnabled()) {
      captureMarkers.setEnabled(wantEnabled);
    }
    // Only update markers when they are enabled; the helper is a no-op
    // when disabled, but skipping the call avoids the entity iteration.
    if (wantEnabled) {
      captureMarkers.update({
        subject,
        asteroids: field.getEntities(),
        powerup: powerupSystem.getPendingSpawn(),
      });
    }
  }

  // ---- AI flight debug (3D overlay) ------------------------------------
  // Follow the AI demo ship in DEMO state and draw velocity + heading +
  // target vectors. Toggle via `window.AI_FLIGHT_DEBUG = false`.
  if (stateMachine.getState() === State.DEMO) {
    const aiShipForDebug = (demoAi && demoAi.getShip()) || ship;
    const aiDecision = demoAi && typeof demoAi.getLastDecision === 'function'
      ? demoAi.getLastDecision()
      : null;
    aiFlightDebug.update({
      shipPos: aiShipForDebug.position,
      shipVel: aiShipForDebug.velocity,
      shipYaw: aiShipForDebug.rotation.yaw,
      targetPos: aiDecision && aiDecision.target ? aiDecision.target.pos : null,
      predictedPos: aiDecision && aiDecision.predictedPos ? aiDecision.predictedPos : null,
      evadeDist: AI_TUNABLES.evadeDist,
    });
  }

  // Push the latest diagnostic snapshot to the debug HUD. The HUD
  // throttles its DOM writes to ~12Hz internally.
  debugHud.update({
    state: stateMachine.getState(),
    score,
    asteroidCount: field.getEntities().length,
    // `getActiveChunks` is the public read-helper for the streaming
    // layer's live-chunk count. We use its length (rather than
    // `world.active.size`) so the public API surface is exercised
    // on every frame — same numeric result, and the public function
    // gets validated. At ~49 chunks the array allocation is <0.01ms
    // and the result is short-lived.
    liveChunks: getActiveChunks(field.getWorld()).length,
    sceneVerts: sceneGeom.vertices,
    sceneTris: sceneGeom.triangles,
    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    // `ship` slot now means "subject" — the entity the camera follows.
    // See the comment above.
    ship: { x: subject.position.x, y: subject.position.y, z: subject.position.z },
    // AI brain kind + the mode the brain actually decided on this
    // frame. `getLastMode()` is a closure read (cheap); it returns
    // the cached mode from the AI's most recent update(). When the
    // AI is disabled (outside DEMO) it returns the seed 'wander'
    // from the closure initial value.
    captureState: (typeof window !== 'undefined' && window._captureState)
      ? window._captureState.recording ? 'REC' : 'OFF'
      : 'OFF',
    captureRemaining: (typeof window !== 'undefined' && window._captureState)
      ? window._captureState.remainingS
      : undefined,
    captureMode: (typeof window !== 'undefined' && window._captureState)
      ? window._captureState.mode
      : undefined,
  });

  // v0.23.x AI Debug Overlay per-frame tick. Null-safe because
  // AI_TUNING_ENABLED may have skipped both object creations at
  // boot (see the master-flag block above). When disabled, the
  // per-frame guard costs one boolean check and is faster than
  // any DOM mutation.
  if (aiDebugOverlay) aiDebugOverlay.update();
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
console.log(`State: ${stateMachine.getState()}   Energy: ${ship.getEnergy()}   Score: ${score}`);

// escapeHtml -- defense-in-depth against accidental HTML injection when
// the chip constants become user-influenced. Today the values are
// `__BRANCH__` + `VERSION` + `__COMMIT__` injected by Vite's `define`
// substitution at config-load time (see vite.config.js) -- BRANCH is
// a `git rev-parse --abbrev-ref HEAD` ref name (alphanumeric + slash +
// hyphen), VERSION is semantic-version-shaped (alphanumeric + dot),
// COMMIT is a short SHA hex string. All three are safe by construction
// today. If any of them ever becomes user-controlled (e.g. an
// HTTP-served config), the helper treats accidental HTML injection as
// an invalid-character sequence rather than an XSS bug. Comments
// drift; defense-in-depth doesn't.
function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
  })[c]);
}

{
  const v = document.getElementById('game-version');
  if (v) {
    // Three-span chip (branch + version + commit). All three values
    // come from Vite's `define` globals + the manual SSOT:
    //   - __BRANCH__ / __COMMIT__ : resolved in vite.config.js by
    //     `execSync('git ...')` at config-load time and substituted
    //     globally into the source. Fresh by construction (as honest
    //     as a `git status` taken right before the dev server boots).
    //   - VERSION : manual SSOT in src/version-constants.js.
    //
    // Compared to a post-commit-hook approach (bake the SHA into a
    // committed file + amend), this architecture has no chicken-and-egg:
    // the SHA never needs to appear in any committed file's content,
    // so no amend cycle is required to keep the chip in sync.
    //
    // The escapeHtml helper is defense-in-depth: branch + commit are
    // alphanumeric or `git-ref` shaped today (no HTML-unsafe chars),
    // but if a future iteration wires the values from HTTP-served
    // config, the helper treats accidental HTML injection as an
    // invalid-character sequence rather than an XSS bug.
    v.innerHTML =
      `<span class="game-version__branch">${escapeHtml(__BRANCH__)}</span>` +
      `<span class="game-version__sep" aria-hidden="true">·</span>` +
      `<span class="game-version__ver">${escapeHtml(VERSION)}</span>` +
      `<span class="game-version__sep" aria-hidden="true">·</span>` +
      `<span class="game-version__commit">${escapeHtml(__COMMIT__)}</span>`;
  }
}

// One extra console.log stamping version + branch + commit (matches
// the chip so DevTools and the corner chip agree). ONE log, not two:
console.log(
  `%c${VERSION}%c on %c${__BRANCH__}%c @ ${__COMMIT__}`,
  'background:#48dbfb;color:#05060c;padding:2px 6px;border-radius:2px;font-weight:bold;',
  'color:#97a3c4;',
  'color:#48dbfb;',
);
