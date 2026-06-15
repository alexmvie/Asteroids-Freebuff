/**
 * Tests for the power-up system orchestrator — see
 * src/systems/powerup-system.js.
 *
 * Uses an injectable powerupFactory + a mock bus + a fake world so
 * the test doesn't touch Three.js scene state. Focus:
 *   - first PLAYING tick spawns a power-up
 *   - ship overlap activates the laser
 *   - laser expires after `activeDurationS`
 *   - respawn delay works
 *   - clearAll resets state
 *   - DEMO/GAME_OVER states gate spawning
 *   - events emitted in the right order
 *
 * Test design note on `spawnMinDist`:
 *   With a mock world (no active chunks), the fallback spawn position
 *   is always exactly `spawnMinDist` units from the ship, in a random
 *   direction determined by the rng. The pickup radius is
 *   `powerupRadius + 0.5` (= 2.0). To prevent the first `update()` call
 *   from BOTH spawning AND immediately picking up, we set
 *   `spawnMinDist: 50` (well outside the pickup radius). The test then
 *   moves the ship to the power-up's position to trigger pickup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPowerUpSystem } from '../src/systems/powerup-system.js';

// ---- Test helpers -------------------------------------------------------

function makeBus() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    off() {},
    emit(name, data) {
      const arr = listeners.get(name);
      if (!arr) return;
      // Snapshot iteration (matches the real bus semantics)
      for (const fn of arr.slice()) fn(data);
    },
  };
}

function makeShip(pos = { x: 0, y: 0, z: 0 }) {
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
  };
}

function makeWorld() {
  return {
    active: new Map(),
    recentlyGone: new Map(),
    bubbleRadiusChunks: 3,
  };
}

function makePowerUpFactory() {
  /** @type {Array<any>} */
  const created = [];
  return {
    created,
    factory(opts) {
      const entity = {
        spec: opts.spec,
        // position is a live object (mutated by update / bob)
        position: { x: opts.spec.position.x, y: opts.spec.position.y, z: opts.spec.position.z },
        age: 0,
        update(dt) { this.age += dt; },
        isExpired() { return this.age >= (this.spec.lifetime ?? 30); },
        getPosition() { return this.position; },
        getRadius() { return 1.5; },
        dispose() { /* no-op in tests */ },
      };
      created.push(entity);
      return entity;
    },
  };
}

function makeEventCollector() {
  const events = [];
  return {
    events,
    bus: {
      on() { return () => {}; },
      off() {},
      emit(name, data) { events.push({ name, data }); },
    },
  };
}

// Default options for tests that exercise the pickup flow.
// `spawnMinDist: 50` ensures the first `update()` doesn't both spawn
// AND immediately pick up the power-up (the fallback spawn is at
// distance = spawnMinDist, well outside the 2.0 pickup radius).
const PICKUP_TEST_OPTIONS = {
  powerupFactory: null, // override per-test
  rng: () => 0.5,
  getGameState: () => 'PLAYING',
  spawnMinDist: 50,
  spawnMaxDist: 100,
};

// ---- Tests --------------------------------------------------------------

test('createPowerUpSystem throws without required args', () => {
  const bus = makeBus();
  const ship = makeShip();
  const world = makeWorld();
  const scene = new THREE.Scene();
  // Error messages wrap the arg name in backticks (e.g. `scene`), so
  // match a tolerant regex that allows any chars between the keyword
  // and "required".
  assert.throws(() => createPowerUpSystem({}), /scene.*required/);
  assert.throws(() => createPowerUpSystem({ scene }), /bus.*required/);
  assert.throws(() => createPowerUpSystem({ scene, bus }), /ship.*required/);
  assert.throws(() => createPowerUpSystem({ scene, bus, ship }), /world.*required/);
});

test('initial state: no active weapon, no pending power-up', () => {
  const { factory } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: {
      powerupFactory: factory,
      rng: () => 0.5,
      getGameState: () => 'PLAYING',
    },
  });
  assert.equal(sys.isLaserActive(), false);
  assert.equal(sys.getActiveRemaining(), 0);
  assert.equal(sys.getActiveMax(), 15);
  assert.equal(sys.getPendingSpawn(), null);
  sys.dispose();
});

test('first PLAYING tick spawns one power-up', () => {
  const { factory, created } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: {
      powerupFactory: factory,
      rng: () => 0.5,
      getGameState: () => 'PLAYING',
    },
  });
  assert.equal(created.length, 0);
  sys.update(0.1, []);
  assert.equal(created.length, 1);
  assert.notEqual(sys.getPendingSpawn(), null);
  sys.dispose();
});

test('spawnAt drops a power-up at a specific world position', () => {
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: { ...PICKUP_TEST_OPTIONS, powerupFactory: factory },
  });
  // Initial spawn (firstSpawnPending) happens on the first
  // update; spawnAt should refuse because pending is already set.
  sys.update(0.1, []);
  assert.equal(sys.getPendingSpawn() !== null, true, 'first-spawn happened');
  const firstPu = sys.getPendingSpawn();
  // Try to drop another one — should be a no-op.
  const result = sys.spawnAt({ x: 100, z: 100 });
  assert.equal(result, false, 'spawnAt refused because a power-up is already pending');
  assert.equal(created.length, 1, 'no second power-up was created');
  assert.equal(sys.getPendingSpawn(), firstPu, 'the original power-up is still the pending one');
  sys.dispose();
});

test('spawnAt drops a power-up at a specific position after the first one is consumed', () => {
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: { ...PICKUP_TEST_OPTIONS, powerupFactory: factory },
  });
  // Clear the initial-spawn (we want to test spawnAt in isolation).
  sys.clearAll();
  assert.equal(sys.getPendingSpawn(), null);
  // Drop a power-up at a specific position.
  const result = sys.spawnAt({ x: 50, z: -50 });
  assert.equal(result, true, 'spawnAt succeeded');
  assert.equal(created.length, 1, 'one power-up was created');
  const pu = sys.getPendingSpawn();
  assert.notEqual(pu, null);
  assert.equal(pu.getPosition().x, 50, 'power-up is at the requested X');
  assert.equal(pu.getPosition().z, -50, 'power-up is at the requested Z');
  // Second spawnAt should refuse (pending is set).
  const result2 = sys.spawnAt({ x: 0, z: 0 });
  assert.equal(result2, false, 'second spawnAt refused');
  assert.equal(created.length, 1, 'still only one power-up');
  sys.dispose();
});

test('spawnAt allows drops while the laser is currently active', () => {
  // A kill-drop during the laser's active countdown is allowed
  // (the new power-up waits on the field for the next pickup
  // after the current laser expires). Only the `pending` slot
  // blocks spawnAt — the `activeType` does not.
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 10,
    },
  });
  // Spawn + pickup
  sys.update(0.1, []);
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), true);
  // Now drop a second power-up at a specific position. The laser
  // is active, but spawnAt should still succeed (kill-drops
  // during laser-active are allowed).
  const result = sys.spawnAt({ x: 100, z: 100 });
  assert.equal(result, true, 'spawnAt allowed during laser-active');
  assert.equal(created.length, 2, 'a second power-up was created');
  assert.equal(sys.getActiveType(), 'laser', 'previous laser is still active');
  assert.notEqual(sys.getPendingSpawn(), null, 'new power-up is pending');
  sys.dispose();
});

test('spawnAt rejects invalid positions', () => {
  const { factory, created } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: { ...PICKUP_TEST_OPTIONS, powerupFactory: factory },
  });
  sys.clearAll();
  assert.equal(sys.spawnAt(null), false, 'null position refused');
  assert.equal(sys.spawnAt({}), false, 'missing x refused');
  assert.equal(sys.spawnAt({ x: 'oops' }), false, 'non-numeric x refused');
  assert.equal(created.length, 0, 'no power-up created for any invalid input');
  sys.dispose();
});

test('spawns a power-up in DEMO that the active collector can pick up', () => {
  // New behavior: the power-up is collectible in DEMO too — the
  // collector is whichever entity the caller passes via getCollector
  // (in main.js, the AI ship in DEMO; here, the ship by default).
  // The previous "not collectible in DEMO" behavior is gone: the
  // demo plays like a real game, so the AI can collect power-ups.
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      getGameState: () => 'DEMO',
    },
  });
  sys.update(0.1, []);
  assert.equal(created.length, 1, 'power-up should spawn in DEMO');
  assert.notEqual(sys.getPendingSpawn(), null, 'power-up is visible in DEMO');
  // Move ship to overlap the power-up — should collect in DEMO now.
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), true, 'collector picks up in DEMO');
  assert.equal(sys.getPendingSpawn(), null, 'pending power-up consumed');
  assert.equal(sys.getActiveCollector(), ship, 'collector is tracked');
  sys.dispose();
});

test('getCollector controls who picks up the power-up', () => {
  // The collector is whichever entity the caller passes via the
  // getCollector option. By default it returns `ship`, but a custom
  // getter (e.g. returning the AI ship) lets the NPC collect.
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const aiShip = makeShip({ x: 0, y: 0, z: 0 });
  let collectorRef = ship; // start with ship as collector
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      getGameState: () => 'PLAYING',
      getCollector: () => collectorRef,
    },
  });
  sys.update(0.1, []); // first spawn
  // Phase 1: ship is the collector. Ship is far from power-up.
  // Move ship to overlap → picks up.
  const pu1 = sys.getPendingSpawn();
  ship.position.x = pu1.getPosition().x;
  ship.position.z = pu1.getPosition().z;
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), true);
  assert.equal(sys.getActiveCollector(), ship);
  // Reset and try with AI as collector.
  sys.clearAll();
  ship.position.x = 1000; ship.position.z = 1000; // far from origin
  collectorRef = aiShip;
  sys.update(0.1, []); // first-spawn fires
  // AI is at origin (default), power-up spawns near origin. Move AI to it.
  const pu2 = sys.getPendingSpawn();
  // The fallback spawn is at spawnMinDist=50 from ship. Move AI there.
  aiShip.position.x = pu2.getPosition().x;
  aiShip.position.z = pu2.getPosition().z;
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), true, 'AI picks up when it is the collector');
  assert.equal(sys.getActiveCollector(), aiShip, 'active collector is the AI');
  sys.dispose();
});

test('spawnDelayByState: faster respawn in DEMO than in PLAYING', () => {
  // In DEMO, power-ups cycle every spawnDelayByState.DEMO seconds
  // (default 2.5s). In PLAYING, the respawn delay is the
  // respawnDelayS default (5s). Verify both by ticking the
  // system in each state with a custom respawnDelayS and a
  // custom DEMO delay. Each phase runs in isolation (separate
  // `createPowerUpSystem` calls) so the state-change
  // immediate-spawn behavior doesn't interfere.
  // ---- Phase 1: PLAYING, respawnDelayS = 5s ----
  const { factory: f1, created: c1 } = makePowerUpFactory();
  const ship1 = makeShip();
  const playing = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: ship1,
    world: makeWorld(),
    options: {
      powerupFactory: f1,
      rng: () => 0.5,
      getGameState: () => 'PLAYING',
      respawnDelayS: 5,
    },
  });
  playing.update(0.1, []); // first spawn
  // Pick it up — this is what arms the respawnTimer.
  const pu1 = playing.getPendingSpawn();
  ship1.position.x = pu1.getPosition().x;
  ship1.position.z = pu1.getPosition().z;
  playing.update(0.1, []); // pickup
  assert.equal(c1.length, 1);
  // Wait 2s — well under the 5s PLAYING respawn delay
  playing.update(2.0, []);
  assert.equal(c1.length, 1, 'PLAYING: still just the first power-up after 2s');
  // Wait the rest of the 5s delay (3s more)
  playing.update(3.0, []);
  assert.equal(c1.length, 2, 'PLAYING: second power-up spawned after 5s');
  playing.dispose();
  // ---- Phase 2: DEMO, spawnDelayByState.DEMO = 0.5s ----
  const { factory: f2, created: c2 } = makePowerUpFactory();
  const ship2 = makeShip();
  const demo = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: ship2,
    world: makeWorld(),
    options: {
      powerupFactory: f2,
      rng: () => 0.5,
      getGameState: () => 'DEMO',
      respawnDelayS: 5, // PLAYING default (unused in DEMO)
      spawnDelayByState: { DEMO: 0.5 },
    },
  });
  demo.update(0.1, []); // first spawn
  // Pick it up
  const pu2 = demo.getPendingSpawn();
  ship2.position.x = pu2.getPosition().x;
  ship2.position.z = pu2.getPosition().z;
  demo.update(0.1, []); // pickup
  assert.equal(c2.length, 1);
  // Wait 0.7s — over the 0.5s DEMO delay, under the 5s PLAYING delay
  demo.update(0.7, []);
  assert.equal(c2.length, 2, 'DEMO: second power-up spawned after 0.5s (faster than PLAYING)');
  demo.dispose();
});

test('does not spawn outside PLAYING (GAME_OVER)', () => {
  const { factory, created } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: {
      powerupFactory: factory,
      rng: () => 0.5,
      getGameState: () => 'GAME_OVER',
    },
  });
  sys.update(0.1, []);
  assert.equal(created.length, 0);
  sys.dispose();
});

test('ship overlap activates the laser and clears the pending power-up', () => {
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: { ...PICKUP_TEST_OPTIONS, powerupFactory: factory },
  });
  sys.update(0.1, []); // spawn (far from ship — no pickup)
  const pu = sys.getPendingSpawn();
  assert.notEqual(pu, null, 'power-up was spawned');
  // Move ship to overlap the power-up
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup
  assert.equal(sys.isLaserActive(), true);
  assert.equal(sys.getPendingSpawn(), null);
  // activeRemaining is just under activeDurationS (one dt=0.1 tick has elapsed)
  const rem = sys.getActiveRemaining();
  assert.ok(rem > 14.8 && rem <= 15, `activeRemaining ≈ 15, got ${rem}`);
  sys.dispose();
});

test('laser expires after activeDurationS', () => {
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 2,
    },
  });
  sys.update(0.1, []); // first spawn (no pickup)
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup
  assert.equal(sys.isLaserActive(), true);
  const remAfterPickup = sys.getActiveRemaining();
  assert.ok(remAfterPickup > 1.8 && remAfterPickup <= 2, `activeRemaining ≈ 2, got ${remAfterPickup}`);
  sys.update(2.1, []); // wait for expiry
  assert.equal(sys.isLaserActive(), false);
  assert.equal(sys.getActiveRemaining(), 0);
  sys.dispose();
});

test('state change away from PLAYING cancels the active laser', () => {
  let state = 'PLAYING';
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 10,
      // Wire the test's `state` variable to the system so the
      // mid-test switch actually flips the system's view of the
      // game state. Without this, the system's getGameState stays
      // 'PLAYING' throughout and the test degenerates into a
      // duplicate of the "ship overlap activates" test.
      getGameState: () => state,
    },
  });
  sys.update(0.1, []);
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup → laser active
  assert.equal(sys.isLaserActive(), true);
  // Switch to GAME_OVER
  state = 'GAME_OVER';
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), false);
  // The pending power-up is also cleared
  assert.equal(sys.getPendingSpawn(), null);
  sys.dispose();
});

test('clearAll resets state and reschedules a first-spawn', () => {
  const { factory, created } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: {
      powerupFactory: factory,
      rng: () => 0.5,
      getGameState: () => 'PLAYING',
    },
  });
  sys.update(0.1, []); // spawn
  assert.notEqual(sys.getPendingSpawn(), null);
  sys.clearAll();
  assert.equal(sys.getPendingSpawn(), null);
  // The next PLAYING tick should spawn again
  sys.update(0.1, []);
  assert.notEqual(sys.getPendingSpawn(), null);
  assert.ok(created.length >= 2, 'a second power-up was spawned after clearAll');
  sys.dispose();
});

test('emits spawned, collected, activated, respawning events', () => {
  const { events, bus } = makeEventCollector();
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus,
    ship,
    world: makeWorld(),
    options: { ...PICKUP_TEST_OPTIONS, powerupFactory: factory },
  });
  sys.update(0.1, []); // spawn
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup

  const names = events.map((e) => e.name);
  assert.ok(names.includes('powerup:spawned'), 'emits powerup:spawned');
  assert.ok(names.includes('powerup:collected'), 'emits powerup:collected');
  assert.ok(names.includes('powerup:activated'), 'emits powerup:activated');
  assert.ok(names.includes('powerup:respawning'), 'emits powerup:respawning');
  sys.dispose();
});

test('emits powerup:expired when the active countdown reaches 0', () => {
  const { events, bus } = makeEventCollector();
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus,
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 1,
    },
  });
  sys.update(0.1, []);
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup
  const beforeExpire = events.length;
  sys.update(1.1, []); // expire
  const newEvents = events.slice(beforeExpire);
  const expired = newEvents.find((e) => e.name === 'powerup:expired');
  assert.ok(expired, 'emits powerup:expired');
  assert.equal(expired.data.type, 'laser');
  sys.dispose();
});

test('emits powerup:cancelled when state leaves PLAYING mid-countdown', () => {
  let state = 'PLAYING';
  const { events, bus } = makeEventCollector();
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus,
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 10,
      getGameState: () => state,
    },
  });
  sys.update(0.1, []);
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []);
  state = 'GAME_OVER';
  sys.update(0.1, []);
  const cancelled = events.find((e) => e.name === 'powerup:cancelled');
  assert.ok(cancelled, 'emits powerup:cancelled');
  sys.dispose();
});

test('state transition cancels the active laser and spawns a fresh power-up in the new state', () => {
  // Critical: when the AI is the collector in DEMO and the user
  // starts a new game (DEMO → PLAYING), the AI's laser must NOT
  // persist into PLAYING. Otherwise the laser beam flickers
  // between the (now-hidden) AI's position and the player.
  // The new state immediately rearms `firstSpawnPending` so the
  // player gets a fresh power-up without waiting for the
  // respawn timer.
  let state = 'DEMO';
  const { events, bus } = makeEventCollector();
  const { factory } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus,
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      activeDurationS: 10,
      getGameState: () => state,
    },
  });
  // DEMO tick 1: spawn + ship picks up (ship is the default collector)
  sys.update(0.1, []);
  const oldPending = sys.getPendingSpawn();
  ship.position.x = oldPending.getPosition().x;
  ship.position.z = oldPending.getPosition().z;
  sys.update(0.1, []); // pickup → laser active
  assert.equal(sys.isLaserActive(), true, 'laser active after pickup in DEMO');
  assert.equal(sys.getActiveCollector(), ship, 'ship is the active collector');
  // State transition: DEMO → PLAYING. The laser must be cancelled
  // and the active collector cleared. A new power-up is spawned
  // for the new state (firstSpawnPending is rearmed on transition).
  state = 'PLAYING';
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), false, 'laser cancelled on DEMO → PLAYING');
  assert.equal(sys.getActiveCollector(), null, 'active collector cleared');
  const cancelled = events.find((e) => e.name === 'powerup:cancelled');
  assert.ok(cancelled, 'emits powerup:cancelled on the transition');
  // The new state gets its own power-up (not the old one).
  const newPending = sys.getPendingSpawn();
  assert.notEqual(newPending, null, 'new power-up is spawned in the new state');
  assert.notEqual(newPending, oldPending, 'the new power-up is fresh (not the old one)');
  assert.equal(events.filter((e) => e.name === 'powerup:spawned').length, 2,
    'two powerup:spawned events (one per state)');
  sys.dispose();
});

test('respawn delay: no new spawn while respawnTimer > 0', () => {
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      respawnDelayS: 3,
    },
  });
  sys.update(0.1, []); // first spawn (no pickup — too far)
  assert.equal(created.length, 1);
  // Pick it up
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []);
  assert.equal(sys.isLaserActive(), true);
  // Wait 1s — well under the 3s respawn delay
  sys.update(1.0, []);
  // The respawn timer is ticking but no new power-up yet
  assert.equal(sys.getPendingSpawn(), null);
  assert.ok(sys.getRespawnRemaining() > 0, 'respawn timer is still counting down');
  sys.dispose();
});

test('respawn delay: a new power-up spawns after the delay', () => {
  const { factory, created } = makePowerUpFactory();
  const ship = makeShip();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship,
    world: makeWorld(),
    options: {
      ...PICKUP_TEST_OPTIONS,
      powerupFactory: factory,
      respawnDelayS: 0.5,
    },
  });
  sys.update(0.1, []); // first spawn (no pickup — too far)
  const pu = sys.getPendingSpawn();
  ship.position.x = pu.getPosition().x;
  ship.position.z = pu.getPosition().z;
  sys.update(0.1, []); // pickup
  assert.equal(created.length, 1);
  sys.update(0.6, []); // wait for respawn
  assert.equal(created.length, 2, 'second power-up was spawned after respawn delay');
  sys.dispose();
});

test('pending power-up that expires triggers a respawn after the delay', () => {
  const { factory, created } = makePowerUpFactory();
  const sys = createPowerUpSystem({
    scene: new THREE.Scene(),
    bus: makeBus(),
    ship: makeShip(),
    world: makeWorld(),
    options: {
      powerupFactory: factory,
      rng: () => 0.5,
      getGameState: () => 'PLAYING',
      powerupLifetimeS: 0.5, // short lifetime
      respawnDelayS: 0.5,
    },
  });
  sys.update(0.1, []); // spawn
  assert.equal(created.length, 1);
  sys.update(0.6, []); // > lifetime
  assert.equal(created.length, 1, 'no new spawn yet — respawn delay ticking');
  sys.update(0.6, []); // > delay
  assert.equal(created.length, 2, 'second power-up spawned after delay');
  sys.dispose();
});
