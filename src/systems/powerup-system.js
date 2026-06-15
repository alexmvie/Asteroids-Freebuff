/**
 * Power-up system — orchestrates the spawn / pickup / active-countdown
 * lifecycle for collectible power-ups. The first power-up type is the
 * laser (see src/entities/powerup.js + src/entities/laser.js); the
 * system is structured to admit more types in the future (the
 * `spec.type` field already discriminates).
 *
 * State machine (per PLAYING run):
 *
 *     (no power-up)
 *        │  spawnPowerUp()
 *        ▼
 *     waiting — one power-up is in the world, waiting for the ship
 *               to fly into it (or for it to expire)
 *        │  ship overlaps → collected (active = true, timer starts)
 *        │  lifetime expires → respawn after a short cooldown
 *        ▼
 *     active — laser is the ship's weapon, countdown running
 *        │  timer hits 0 → expired (active = false, respawn after cooldown)
 *        │  ship dies → cancelled (active = false, no respawn until next
 *                       PLAYING tick)
 *
 * Events emitted on the bus:
 *   - `powerup:spawned`     { type, position, lifetime }
 *   - `powerup:collected`   { type }
 *   - `powerup:activated`   { type, duration }   // when the weapon becomes active
 *   - `powerup:expired`     { type }             // timer ran out
 *   - `powerup:cancelled`   { type }             // ship died, weapon removed
 *   - `powerup:respawning`  { remaining }        // waiting to spawn a new one
 *
 * State-aware: power-ups do NOT spawn outside the PLAYING state (DEMO
 * and GAME_OVER have no power-ups, no laser). The laser also deactivates
 * on state change to GAME_OVER.
 *
 * Public API:
 *   - `update(dt, asteroids)`   per-frame update; checks ship-pickup,
 *                                advances timers, manages respawn
 *   - `isLaserActive()`         true while the ship's weapon is the laser
 *   - `getActiveType()`         'laser' | null
 *   - `getActiveRemaining()`    seconds of active time left (0 if not active)
 *   - `getActiveMax()`          max active duration (for HUD bar fill)
 *   - `getPendingSpawn()`       the current "waiting" power-up entity, or null
 *   - `spawnAt(position)`       drop a power-up at a specific world position
 *                                (used by the collision layer when an asteroid
 *                                is destroyed; no-op if a power-up is already
 *                                pending or the active state is true)
 *   - `clearAll()`              wipe everything (game reset)
 *   - `dispose()`               tear down meshes + bus subscriptions
 *
 * @param {{
 *   scene: import('three').Scene,
 *   bus: { on: Function, emit: Function, off: Function },
 *   ship: { position: {x:number,y:number,z:number}, mesh?: { visible: boolean } },
 *   world: object,                                 // from createWorld()
 *   options?: {
 *     systemSeed?: number,                         // unused, but accepted for symmetry
 *     activeDurationS?: number,                    // default POWERUP_ACTIVE_DURATION_S = 15
 *     powerupLifetimeS?: number,                   // default POWERUP_LIFETIME_S
 *     respawnDelayS?: number,                      // default POWERUP_RESPAWN_DELAY_S = 5
 *     spawnDelayByState?: {                        // per-state respawn delay overrides
 *       DEMO?: number,                             // default: 2.5s (fast — AI needs to see it)
 *       PLAYING?: number,                          // default: respawnDelayS
 *       GAME_OVER?: number,                        // default: respawnDelayS
 *     },
 *     spawnMinDist?: number,                       // default 30
 *     spawnMaxDist?: number,                       // default 200
 *     powerupFactory?: (opts: any) => any,         // injectable for tests
 *     rng?: () => number,                          // default Math.random
 *     getGameState?: () => string,                 // default PLAYING (no gating)
 *     getCollector?: () => { position: {x:number,y:number,z:number} } | null,
 *       // returns the entity (player or AI ship) that should be
 *       // checked for power-up pickup. Default: always returns `ship`.
 *       // In DEMO mode, the caller typically passes the AI ship so the
 *       // NPC collects the power-up like a real player would.
 *     getSpawnAnchor?: () => { position: {x:number,y:number,z:number} } | null,
 *       // returns the entity that the power-up should spawn AROUND.
 *       // Default: always returns `ship`. In DEMO mode, the camera
 *       // follows the AI, so the caller passes the AI ship here so
 *       // the power-up spawns near the camera target (visible) and
 *       // near the entity that's actually going to collect it.
 *       // Spawning near the player ship in DEMO would put the
 *       // power-up outside the camera's view cone.
 *     powerupLifetimeByState?: {
 *       DEMO?: number,                             // default POWERUP_LIFETIME_S
 *       PLAYING?: number,                          // default POWERUP_LIFETIME_S
 *       GAME_OVER?: number,                        // default POWERUP_LIFETIME_S
 *     },
 *   },
 * }} opts
 */

import { createPowerUp, POWERUP_LIFETIME_S } from '../entities/powerup.js';
import { chunkKey, getActiveChunks } from '../world/world.js';
import { CHUNK_SIZE } from '../world/chunk-constants.js';

const POWERUP_TYPE_LASER = 'laser';
const POWERUP_ACTIVE_DURATION_S = 15; // countdown after pickup
const POWERUP_RESPAWN_DELAY_S = 5; // seconds between (collection|expiry) and next spawn
const SPAWN_MIN_DIST = 30; // min world units from the ship
const SPAWN_MAX_DIST = 200; // max world units from the ship (inside the bubble)

// Module-scope scratch
let _nextPowerUpId = 0;

export function createPowerUpSystem({
  scene,
  bus,
  ship,
  world,
  options = {},
} = {}) {
  if (!scene) throw new Error('createPowerUpSystem: `scene` is required');
  if (!bus) throw new Error('createPowerUpSystem: `bus` is required');
  if (!ship) throw new Error('createPowerUpSystem: `ship` is required');
  if (!world) throw new Error('createPowerUpSystem: `world` is required');

  const activeDurationS = options.activeDurationS ?? POWERUP_ACTIVE_DURATION_S;
  const powerupLifetimeS = options.powerupLifetimeS ?? undefined; // falls through to entity default
  const respawnDelayS = options.respawnDelayS ?? POWERUP_RESPAWN_DELAY_S;
  const spawnDelayByState = {
    DEMO: options.spawnDelayByState?.DEMO ?? 2.5,
    PLAYING: options.spawnDelayByState?.PLAYING ?? respawnDelayS,
    GAME_OVER: options.spawnDelayByState?.GAME_OVER ?? respawnDelayS,
  };
  const spawnMinDist = options.spawnMinDist ?? SPAWN_MIN_DIST;
  const spawnMaxDist = options.spawnMaxDist ?? SPAWN_MAX_DIST;
  const powerupFactory = options.powerupFactory ?? createPowerUp;
  const rng = options.rng ?? Math.random;
  const getGameState = options.getGameState ?? (() => 'PLAYING');
  // Returns the entity (player or AI ship) that should be checked for
  // power-up pickup. Default: always returns `ship`. In DEMO mode, the
  // caller typically passes a getter that returns the AI ship so the
  // NPC collects the power-up like a real player would.
  const getCollector = options.getCollector ?? (() => ship);
  // Returns the entity that the power-up should spawn AROUND. Default:
  // always returns `ship`. In DEMO mode, the caller passes the AI
  // ship so the power-up spawns near the camera target (visible)
  // and near the entity that's actually going to collect it. The
  // pickup distance is the SAME for both — only the spawn anchor
  // changes, so the power-up always lands somewhere the camera can
  // see and the collector can reach.
  const getSpawnAnchor = options.getSpawnAnchor ?? (() => ship);
  // Per-state power-up lifetime. In DEMO, a shorter lifetime (e.g.
  // 12s) means an unclaimed power-up cycles faster — the user
  // sees a new one every ~15s instead of waiting 32.5s for the
  // default 30s lifetime + 2.5s respawn delay. Falls back to
  // `options.powerupLifetimeS` (the legacy global override) then
  // to `POWERUP_LIFETIME_S` so existing tests / callers that set
  // `powerupLifetimeS` continue to work.
  const lifetimeDefault = options.powerupLifetimeS ?? POWERUP_LIFETIME_S;
  const powerupLifetimeByState = {
    DEMO: options.powerupLifetimeByState?.DEMO ?? lifetimeDefault,
    PLAYING: options.powerupLifetimeByState?.PLAYING ?? lifetimeDefault,
    GAME_OVER: options.powerupLifetimeByState?.GAME_OVER ?? lifetimeDefault,
  };
  // Optional reference to the laser weapon. When provided, the system
  // will call `laser.stop()` on every deactivate (expired / cancelled)
  // so the beam doesn't keep rendering through state transitions. If
  // not provided, the system runs as before — the caller is
  // responsible for stopping the laser (e.g. by gating the
  // render-loop's `laser.update()` call on `isLaserActive()`).
  const laser = options.laser ?? null;

  // ---- Mutable state --------------------------------------------------
  /** @type {object | null} the power-up currently waiting in the world */
  let pending = null;
  /** @type {string | null} 'laser' while the laser is the active weapon */
  let activeType = null;
  let activeRemaining = 0; // seconds
  let respawnTimer = 0; // seconds until next spawn (after collection/expiry/cancel)
  let firstSpawnPending = true; // spawn one on the first PLAYING tick
  /**
   * Reference to the entity (player or AI ship) that collected the
   * active power-up. Used to (a) render the laser beam from the
   * correct ship's position and (b) check if a specific ship (e.g.
   * the AI) is the current firer. Null when no power-up is active.
   */
  let activeCollector = null;
  /**
   * State observed on the previous `update` tick. Used to detect
   * state transitions and cancel the active laser + pending
   * power-up on any change (not just GAME_OVER). This prevents
   * the AI's laser from persisting into PLAYING (the AI mesh is
   * hidden in PLAYING; the beam would flicker between the hidden
   * AI position and the player).
   */
  let lastState = null;

  // ---- Helpers --------------------------------------------------------

  function clearPending() {
    if (pending) {
      pending.dispose();
      pending = null;
    }
  }

  // Emit helper — calls the bus directly. Subscribers that throw will
  // propagate (no try/catch swallow). Per AGENTS.md, unnecessary
  // try/catch is anti-pattern: a buggy subscriber should surface, not
  // be hidden. The system code is robust to listener-throws: a single
  // broken subscriber cannot stop subsequent subscribers from running
  // (the bus iterates a snapshot), and the system has no per-emit
  // state that would be left inconsistent by a throw.
  function emit(name, payload) {
    bus.emit(name, payload);
  }

  /**
   * Pick a random world position for a new power-up. Tries up to N times
   * to find a spot in the active bubble at a distance in
   * [spawnMinDist, spawnMaxDist] from the spawn anchor (the entity
   * the camera follows in the current state — the AI in DEMO, the
   * player in PLAYING); falls back to a random direction at
   * `spawnMinDist` from the anchor.
   */
  function pickSpawnPosition() {
    const anchor = getSpawnAnchor() || ship;
    const anchorPos = anchor.position;
    const activeChunks = getActiveChunks(world);
    if (activeChunks.length === 0) {
      // No active chunks — fall back to spawnMinDist in a random direction.
      const angle = rng() * Math.PI * 2;
      return {
        x: anchorPos.x + Math.cos(angle) * spawnMinDist,
        y: 2,
        z: anchorPos.z + Math.sin(angle) * spawnMinDist,
      };
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const entry = activeChunks[Math.floor(rng() * activeChunks.length)];
      const { cx, cz } = entry.chunk.id;
      const x = (cx + rng()) * CHUNK_SIZE;
      const z = (cz + rng()) * CHUNK_SIZE;
      const dx = x - anchorPos.x;
      const dz = z - anchorPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= spawnMinDist && dist <= spawnMaxDist) {
        return { x, y: 2, z };
      }
    }
    // Fallback: spawnMinDist in a random direction from the anchor.
    const angle = rng() * Math.PI * 2;
    return {
      x: anchorPos.x + Math.cos(angle) * spawnMinDist,
      y: 2,
      z: anchorPos.z + Math.sin(angle) * spawnMinDist,
    };
  }

  function spawnOne() {
    if (pending) return; // already have one
    const pos = pickSpawnPosition();
    createPowerUpEntity(pos);
  }

  /**
   * Internal helper: create the power-up entity at the given
   * position, set `pending`, emit `powerup:spawned`. NO guards
   * (no `pending` check, no `activeType` check) — the caller is
   * expected to have already checked those. Used by both
   * `spawnOne` (respawn path; should always succeed) and
   * `spawnAtPosition` (kill-drop path; may refuse).
   *
   * @param {{x:number,y:number,z:number}} pos
   */
  function createPowerUpEntity(pos) {
    const currentLifetime = powerupLifetimeByState[getGameState()] ?? powerupLifetimeS;
    const spec = {
      type: POWERUP_TYPE_LASER,
      position: pos,
      lifetime: currentLifetime,
      spawnTime: performance.now() / 1000,
      id: `powerup-${_nextPowerUpId++}`,
    };
    pending = powerupFactory({ scene, spec });
    emit('powerup:spawned', { type: spec.type, position: pos, lifetime: spec.lifetime });
  }

  /**
   * Drop a power-up at a specific world position. Used by the
   * collision layer when an asteroid is destroyed (a "fair"
   * chance per kill). The power-up is added to the scene at the
   * given position. If a power-up is already pending, this is
   * a no-op (we don't want two power-ups waiting on the field
   * at once). The laser CAN be currently active — a kill-drop
   * during the laser's active countdown is allowed; the new
   * power-up waits on the field for the next pickup after the
   * current laser expires.
   *
   * The lifetime is the per-state default. The spawn position
   * is the caller-supplied position; no distance check against
   * the camera target (unlike `pickSpawnPosition`).
   *
   * @param {{x:number,y?:number,z:number}} position
   * @returns {boolean} true if a power-up was spawned, false if skipped
   */
  function spawnAtPosition(position) {
    if (pending) return false;
    if (!position || typeof position.x !== 'number') return false;
    const pos = { x: position.x, y: position.y ?? 2, z: position.z };
    createPowerUpEntity(pos);
    return true;
  }

  function activate() {
    activeType = POWERUP_TYPE_LASER;
    activeRemaining = activeDurationS;
    // Track which entity collected the power-up so the laser beam
    // can be rendered from the correct ship's position. The caller
    // decides the collector via `getCollector()` at pickup time
    // (below); we snapshot it here.
    activeCollector = getCollector();
    emit('powerup:activated', { type: activeType, duration: activeDurationS, collector: activeCollector });
  }

  function deactivate(reason /* 'expired' | 'cancelled' */) {
    if (!activeType) return;
    const type = activeType;
    const collector = activeCollector;
    activeType = null;
    activeRemaining = 0;
    activeCollector = null;
    // If the laser is currently firing, force it to stop. This
    // matters when the active laser is cancelled (e.g. the player
    // dies): the render loop's `laser.update()` runs before
    // `powerupSystem.update()`, so without an explicit stop() the
    // beam would keep drawing for up to LASER_DURATION_S (~0.12s)
    // through the GAME OVER overlay. The same applies to a held
    // Space — the held-fire loop would otherwise keep calling
    // `laser.fire()` on subsequent frames.
    if (laser && typeof laser.stop === 'function') {
      laser.stop();
    }
    emit(`powerup:${reason}`, { type, collector });
  }

  /**
   * Per-frame update. Checks the active collector↔pending power-up
   * overlap, advances the pending power-up's lifetime + the active
   * countdown.
   *
   * State gating:
   *   - GAME_OVER: clear everything. The active laser is cancelled
   *     and the pending power-up is removed; the next non-GAME_OVER
   *     tick respawns one.
   *   - DEMO: keep the pending power-up visible (the user sees what
   *     the power-up looks like before they start). The collector
   *     (typically the AI ship) CAN pick up power-ups in DEMO so the
   *     demo plays like a real game.
   *   - PLAYING: collectible as before. The collector (typically the
   *     player ship) picks up power-ups; overlap activates the laser
   *     and schedules a respawn.
   *
   * @param {number} dt
   * @param {Array<{getPosition: () => any, getRadius: () => number}>} asteroids  // unused; reserved
   */
  function update(dt, asteroids) {
    if (dt <= 0) return;
    const state = getGameState();

    // State change detection: on any transition (not just
    // GAME_OVER), cancel the active laser, clear the pending
    // power-up (if any), and rearm `firstSpawnPending` so the new
    // state gets a fresh power-up on the same tick. This is
    // critical for the DEMO → PLAYING transition: the AI is the
    // collector in DEMO, and the AI's laser must NOT persist into
    // PLAYING (the AI mesh is hidden; the beam would flicker
    // between the hidden AI position and the player). The first
    // update tick has `lastState === null`, which is not a
    // "change", so the initial spawn is unaffected.
    if (lastState !== null && lastState !== state) {
      if (activeType) deactivate('cancelled');
      if (pending) clearPending();
      // Always rearm the first-spawn flag on a state change, even
      // if there was no pending power-up (e.g. the previous state
      // picked up the power-up before transitioning). The new
      // state should get its own power-up.
      firstSpawnPending = true;
    }
    lastState = state;

    // GAME_OVER: clear everything; respawn on the next non-GAME_OVER tick.
    if (state === 'GAME_OVER') {
      // Already cleared above (on transition into GAME_OVER); this
      // branch is a no-op when `lastState === 'GAME_OVER'`, but
      // guarantees the state is clean even if `update` was somehow
      // called with GAME_OVER from boot (no prior transition).
      return;
    }

    // First-spawn: emit one on the first non-GAME_OVER tick (DEMO or PLAYING).
    if (firstSpawnPending) {
      firstSpawnPending = false;
      spawnOne();
    }

    // Per-state respawn delay: in DEMO, respawn quickly so the
    // power-up cycles visibly. In PLAYING, use the configured
    // respawnDelayS (5s by default).
    const currentRespawnDelay = spawnDelayByState[state] ?? respawnDelayS;

    // ---- Pending power-up update ------------------------------------
    if (pending) {
      pending.update(dt);
      if (pending.isExpired()) {
        // Lifetime ran out without pickup — schedule a respawn.
        clearPending();
        respawnTimer = currentRespawnDelay;
        emit('powerup:respawning', { remaining: respawnTimer });
      } else {
        // Collector overlap check. The collector is whichever
        // entity the caller passed via `getCollector()` (player in
        // PLAYING, AI in DEMO). This way the AI can collect in DEMO
        // — the demo plays like a real game.
        const collector = getCollector();
        if (collector && collector.position) {
          const sp = collector.position;
          const pp = pending.getPosition();
          const dx = sp.x - pp.x;
          const dz = sp.z - pp.z;
          const distSq = dx * dx + dz * dz;
          const r = pending.getRadius() + 0.5; // small grace for the collector's nose
          if (distSq < r * r) {
            // Picked up!
            const type = pending.spec.type;
            clearPending();
            respawnTimer = currentRespawnDelay;
            emit('powerup:collected', { type });
            activate();
            emit('powerup:respawning', { remaining: respawnTimer });
          }
        }
      }
    } else if (respawnTimer > 0) {
      respawnTimer = Math.max(0, respawnTimer - dt);
      if (respawnTimer === 0) spawnOne();
    }

    // ---- Active countdown -------------------------------------------
    if (activeType) {
      activeRemaining = Math.max(0, activeRemaining - dt);
      if (activeRemaining === 0) {
        deactivate('expired');
        // Don't set respawnTimer here — it was set on pickup. The
        // post-active state behaves the same way as post-lifetime.
      }
    }
  }

  // ---- Public read API ------------------------------------------------

  function isLaserActive() { return activeType === POWERUP_TYPE_LASER; }
  function getActiveType() { return activeType; }
  function getActiveRemaining() { return activeRemaining; }
  function getActiveMax() { return activeDurationS; }
  function getPendingSpawn() { return pending; }
  function getRespawnRemaining() { return respawnTimer; }
  /**
   * Returns the entity (player or AI ship) that collected the active
   * power-up, or null if no power-up is active. The laser beam should
   * be rendered from this entity's position when firing. The AI can
   * also use this to decide whether the laser is "mine" (i.e. should
   * I fire the laser or a bullet?).
   */
  function getActiveCollector() { return activeCollector; }

  /**
   * Wipe the entire power-up state. Used by `resetRunState` on game
   * restart. After this call, the next `update(dt)` tick in PLAYING
   * will spawn a new power-up (because `firstSpawnPending` is reset).
   */
  function clearAll() {
    clearPending();
    if (activeType) deactivate('cancelled');
    respawnTimer = 0;
    firstSpawnPending = true;
  }

  function dispose() {
    clearPending();
    if (activeType) activeType = null;
    activeRemaining = 0;
    respawnTimer = 0;
  }

  return {
    update,
    isLaserActive,
    getActiveType,
    getActiveRemaining,
    getActiveMax,
    getActiveCollector,
    getPendingSpawn,
    getRespawnRemaining,
    /**
     * Drop a power-up at a specific world position. Used by the
     * collision layer when an asteroid is destroyed (a "fair"
     * chance per kill). No-op if a power-up is already pending
     * or the laser is currently active.
     *
     * @param {{x:number,y?:number,z:number}} position
     * @returns {boolean} true if a power-up was spawned, false if skipped
     */
    spawnAt: spawnAtPosition,
    clearAll,
    dispose,
  };
}
