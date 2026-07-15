/**
 * Unit tests for src/entities/ai.js (v0.46.0 — classic Asteroids AI with
 * lead fire and asteroid size priority).
 *
 * The brain (`aiBrainTick`) is a pure function that maps
 *   (ship position + yaw + asteroid list + powerup)
 * to `{ yaw, thrust, mode, fire, braking }`.
 *
 * Rules under test:
 *   - EVADE when nearest asteroid < evadeDist (thrust perpendicular).
 *   - ENGAGE otherwise: turn toward best target (size-prioritized),
 *     thrust when aligned, fire when an asteroid is in the forward
 *     cone and in range, leading the shot for asteroid drift.
 *   - Powerups are chased only if closer than the best asteroid and
 *     within powerupMaxChaseDist.
 *   - Fire is independent of chase target: asteroids are shot even
 *     while chasing a powerup.
 *   - IDLE when nothing is around.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  findNearestAsteroid,
  findBestAsteroidForChase,
  isTargetInFront,
  predictAsteroidPosition,
  pickTarget,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
  facingAngle,
  collectBehavior,
} from '../src/entities/ai.js';

// --------------------------------------------------------------------------
// Mock helpers
// --------------------------------------------------------------------------

function mockAsteroid(x, z, vel, radius = 3, size = 0) {
  const v = vel || { x: 0, z: 0 };
  return {
    getPosition: () => ({ x, y: 0, z }),
    getVelocity: () => ({ x: v.x, z: v.z }),
    getRadius: () => radius,
    getSize: () => size,
  };
}

function mockShipFactory() {
  const state = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0, roll: 0 },
    angularVelocity: 0,
  };
  const calls = { setYaw: [], setThrust: [], update: [], reset: [] };
  let scene = null;
  return {
    state,
    calls,
    build: (opts) => {
      scene = opts.scene;
      state.position = { ...opts.position };
      state.rotation.yaw = 0;
      return {
        position: state.position,
        velocity: state.velocity,
        rotation: state.rotation,
        mesh: { _inScene: true },
        setYaw: (v) => calls.setYaw.push(v),
        setThrust: (v) => calls.setThrust.push(v),
        update: (dt) => calls.update.push(dt),
        reset: (p) => {
          calls.reset.push(p);
          state.position = { ...p };
          state.velocity = { x: 0, z: 0 };
          state.angularVelocity = 0;
        },
        rotation: state.rotation,
        get angularVelocity() { return state.angularVelocity; },
      };
    },
    getScene: () => scene,
  };
}

function mockScene() {
  const children = new Set();
  return {
    children,
    add: (m) => children.add(m),
    remove: (m) => children.delete(m),
  };
}

// --------------------------------------------------------------------------
// aiBrainTick: arg validation
// --------------------------------------------------------------------------

test('aiBrainTick: throws on missing aiPos', () => {
  assert.throws(() => aiBrainTick({ aiYaw: 0, asteroids: [], time: 0 }), /aiPos/);
});

test('aiBrainTick: throws on missing aiYaw', () => {
  assert.throws(() => aiBrainTick({ aiPos: { x: 0, z: 0 }, asteroids: [], time: 0 }), /aiYaw/);
});

test('aiBrainTick: throws on non-array asteroids', () => {
  assert.throws(
    () => aiBrainTick({ aiPos: { x: 0, z: 0 }, aiYaw: 0, asteroids: 'no', time: 0 }),
    /asteroids/,
  );
});

// --------------------------------------------------------------------------
// aiBrainTick: EVADE branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest within evadeDist -> mode=evade, turns away', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  // When not yet facing away from the threat, the ship turns first
  // and only thrusts once roughly aligned. The important thing is
  // that it turns away (yaw != 0) and does not fire.
  assert.ok(result.yaw === -1 || result.yaw === 1);
  assert.equal(result.fire, false);
});

test('aiBrainTick: evade thrusts once facing away from threat', () => {
  // Ship already facing -X (yaw = PI/2), threat at +X (5,0).
  // The escape direction is -X, which the ship is already facing.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: evade steers ~90 degrees from threat', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.notEqual(result.yaw, 0, 'must turn to escape');
});

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest asteroid in range -> mode=asteroid, turn toward it', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'turn toward +X asteroid when facing -Z');
});

test('aiBrainTick: aligned asteroid -> thrust and fire', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
  assert.equal(result.fire, true);
});

test('aiBrainTick: counter-steers before angular momentum overshoot', () => {
  // Ship is perfectly aligned with target (targetDiff = 0) but has
  // positive angular velocity (turning right). The AI should command
  // a left yaw to brake the rotation before it overshoots.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiAngularVel: 2.0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    yawDeadband: 0.10,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'must counter-steer against positive angular velocity');
});

test('aiBrainTick: misaligned asteroid -> turn without thrust', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.notEqual(result.yaw, 0);
  assert.equal(result.thrust, false, 'not aligned -> no thrust');
});

test('aiBrainTick: picks nearest of multiple asteroids', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0), mockAsteroid(20, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

// --------------------------------------------------------------------------
// aiBrainTick: fire discipline
// --------------------------------------------------------------------------

test('aiBrainTick: fires when asteroid is in cone and range', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.fire, true);
});

test('aiBrainTick: does not fire when asteroid is too far', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(200, 0)],
    time: 0,
    fireMaxDist: 120,
  });
  assert.equal(result.fire, false);
});

test('aiBrainTick: does not fire when asteroid is too close', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    fireMinDist: 10,
    evadeDist: 12,
  });
  // 5u < evadeDist -> evade, no fire
  assert.equal(result.mode, 'evade');
  assert.equal(result.fire, false);
});

test('aiBrainTick: does not fire when asteroid is off-axis', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    fireHeadingGate: 0.35,
  });
  // 90 degrees off-axis, outside fire cone
  assert.equal(result.fire, false);
});

test('aiBrainTick: fires at any in-cone asteroid, not just chase target', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(20, 0), mockAsteroid(0, -30)],
    time: 0,
  });
  // Chase target is (20,0) but (0,-30) is in front -> fire
  assert.equal(result.fire, true);
});

// --------------------------------------------------------------------------
// aiBrainTick: lead fire
// --------------------------------------------------------------------------

test('aiBrainTick: lead fire aims ahead of a moving asteroid', () => {
  // Ship at origin, facing +X (yaw = -PI/2). Asteroid at (40,0) moving
  // right at 10 u/s. With bullet speed 20, flight time = 2s, so the
  // predicted point is (60, 0). Ship is facing +X, so the predicted
  // point is directly ahead -> fire.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0, { x: 10, z: 0 })],
    time: 0,
    bulletSpeed: 20,
    fireHeadingGate: 0.35,
  });
  assert.equal(result.fire, true);
});

test('aiBrainTick: lead fire does not fire if predicted point is off-axis', () => {
  // Same setup but asteroid moving up (+Z). Predicted point is
  // (40, 20). Ship faces +X, so point is off-axis -> no fire.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0, { x: 0, z: 10 })],
    time: 0,
    bulletSpeed: 20,
    fireHeadingGate: 0.35,
  });
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// aiBrainTick: powerup branch
// --------------------------------------------------------------------------

test('aiBrainTick: powerup closer than nearest asteroid -> mode=powerup', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 20, z: 0 },
    time: 0,
  });
  assert.equal(result.mode, 'powerup');
});

test('aiBrainTick: far powerup is ignored', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 200, z: 0 },
    time: 0,
    powerupMaxChaseDist: 80,
  });
  assert.equal(result.mode, 'asteroid');
});

test('aiBrainTick: keeps firing at asteroids while chasing powerup', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 20, z: 0 },
    time: 0,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.fire, true);
});

// --------------------------------------------------------------------------
// aiBrainTick: IDLE branch
// --------------------------------------------------------------------------

test('aiBrainTick: empty asteroids -> idle', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, false);
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// findNearestAsteroid
// --------------------------------------------------------------------------

test('findNearestAsteroid: empty list returns null', () => {
  assert.equal(findNearestAsteroid({ x: 0, z: 0 }, []), null);
});

test('findNearestAsteroid: single asteroid', () => {
  const a = mockAsteroid(5, 0);
  const result = findNearestAsteroid({ x: 0, z: 0 }, [a]);
  assert.equal(result.asteroid, a);
  assert.equal(result.dist, 5);
});

test('findNearestAsteroid: picks closest of multiple', () => {
  const a = mockAsteroid(50, 0);
  const b = mockAsteroid(0, 3);
  const c = mockAsteroid(-10, 0);
  const result = findNearestAsteroid({ x: 0, z: 0 }, [a, b, c]);
  assert.equal(result.asteroid, b);
  assert.equal(result.dist, 3);
});

// --------------------------------------------------------------------------
// findBestAsteroidForChase
// --------------------------------------------------------------------------

test('findBestAsteroidForChase: prefers large asteroid over closer small one', () => {
  const large = mockAsteroid(20, 0, { x: 0, z: 0 }, 6, 0);
  const small = mockAsteroid(10, 0, { x: 0, z: 0 }, 1, 2);
  const result = findBestAsteroidForChase({ x: 0, z: 0 }, [large, small], 8);
  assert.equal(result.asteroid, large);
});

test('findBestAsteroidForChase: falls back to nearest when sizes are equal', () => {
  const a = mockAsteroid(50, 0, { x: 0, z: 0 }, 3, 1);
  const b = mockAsteroid(10, 0, { x: 0, z: 0 }, 3, 1);
  const result = findBestAsteroidForChase({ x: 0, z: 0 }, [a, b], 8);
  assert.equal(result.asteroid, b);
});

test('findBestAsteroidForChase: small wins when much closer', () => {
  const large = mockAsteroid(100, 0, { x: 0, z: 0 }, 6, 0);
  const small = mockAsteroid(5, 0, { x: 0, z: 0 }, 1, 2);
  const result = findBestAsteroidForChase({ x: 0, z: 0 }, [large, small], 8);
  assert.equal(result.asteroid, small);
});

// --------------------------------------------------------------------------
// predictAsteroidPosition
// --------------------------------------------------------------------------

test('predictAsteroidPosition: stationary asteroid returns current position', () => {
  const a = mockAsteroid(40, 0);
  const p = predictAsteroidPosition(a, { x: 0, z: 0 }, 400);
  assert.equal(p.x, 40);
  assert.equal(p.z, 0);
});

test('predictAsteroidPosition: moving asteroid predicts ahead', () => {
  const a = mockAsteroid(40, 0, { x: 10, z: 0 });
  const p = predictAsteroidPosition(a, { x: 0, z: 0 }, 20);
  // flight time = 40/20 = 2s, predicted x = 40 + 10*2 = 60
  assert.equal(p.x, 60);
  assert.equal(p.z, 0);
});

test('predictAsteroidPosition: returns null for invalid asteroid', () => {
  assert.equal(predictAsteroidPosition(null, { x: 0, z: 0 }), null);
});

// --------------------------------------------------------------------------
// isTargetInFront
// --------------------------------------------------------------------------

test('isTargetInFront: target directly ahead -> true', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: -10 }, 0.35), true);
});

test('isTargetInFront: target directly behind -> false', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: 10 }, 0.35), false);
});

test('isTargetInFront: handles non-zero yaw correctly', () => {
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, 0.35),
    true,
  );
});

// --------------------------------------------------------------------------
// pickTarget
// --------------------------------------------------------------------------

test('pickTarget: picks nearest asteroid when no powerup', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(30, 0)],
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.pos.x, 30);
});

test('pickTarget: prefers large asteroid over closer small one', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0, { x: 0, z: 0 }, 6, 0), mockAsteroid(10, 0, { x: 0, z: 0 }, 1, 2)],
    asteroidSizeBias: 8,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.pos.x, 20);
});

test('pickTarget: powerup closer than best asteroid -> powerup', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 20, z: 0 },
    powerupMaxChaseDist: 80,
  });
  assert.equal(result.mode, 'powerup');
});

test('pickTarget: powerup in range wins even if asteroid is closer', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    powerupPos: { x: 80, z: 0 },
    powerupMaxChaseDist: 120,
  });
  assert.equal(result.mode, 'powerup');
});

test('pickTarget: far powerup ignored', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 200, z: 0 },
    powerupMaxChaseDist: 80,
  });
  assert.equal(result.mode, 'asteroid');
});

// --------------------------------------------------------------------------
// shouldResetAi
// --------------------------------------------------------------------------

test('shouldResetAi: inside resetDist -> false', () => {
  assert.equal(shouldResetAi({ x: 50, z: 50 }, 220), false);
});

test('shouldResetAi: outside resetDist -> true', () => {
  assert.equal(shouldResetAi({ x: 300, z: 0 }, 220), true);
});

test('shouldResetAi: default resetDist is 400', () => {
  assert.equal(shouldResetAi({ x: 350, z: 0 }), false);
  assert.equal(shouldResetAi({ x: 450, z: 0 }), true);
});

// --------------------------------------------------------------------------
// pickAiSpawn
// --------------------------------------------------------------------------

test('pickAiSpawn: returns a position within radius', () => {
  for (let i = 0; i < 100; i++) {
    const { position } = pickAiSpawn(30);
    const r = Math.hypot(position.x, position.z);
    assert.ok(r <= 30, `r=${r}`);
    assert.ok(r >= 12, `r=${r}`);
    assert.equal(position.y, 0);
  }
});

test('pickAiSpawn: deterministic with a fixed rng', () => {
  const rng = () => 0;
  const { position, yaw } = pickAiSpawn(30, rng);
  assert.ok(Math.abs(position.x - 12) < 1e-9);
  assert.ok(Math.abs(position.z) < 1e-9);
  assert.equal(yaw, 0);
});

// --------------------------------------------------------------------------
// createDemoAi: factory wiring
// --------------------------------------------------------------------------

test('createDemoAi: requires scene and asteroids', () => {
  assert.throws(() => createDemoAi({}), /scene/);
  assert.throws(() => createDemoAi({ scene: mockScene() }), /asteroids/);
});

test('createDemoAi: basic factory wiring', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
  assert.equal(typeof ai.getShip, 'function');

  ai.update(0.1);
  assert.equal(mock.calls.setThrust.length, 1);
  assert.equal(mock.calls.update.length, 1);
  assert.equal(typeof mock.calls.setYaw[0], 'number');
});

test('createDemoAi: reset when ship drifts beyond resetDist', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: { shipFactory: mock.build, resetDist: 50, spawnRadius: 10 },
  });
  ai.getShip().position.x = 200;
  ai.update(0.1);
  assert.ok(mock.calls.reset.length >= 1);
});

test('createDemoAi: dt <= 0 is a no-op', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: { shipFactory: mock.build },
  });
  ai.update(0);
  ai.update(-1);
  assert.equal(mock.calls.setYaw.length, 0);
  assert.equal(mock.calls.setThrust.length, 0);
  assert.equal(mock.calls.update.length, 0);
});

test('createDemoAi: fires weapon when chasing asteroid', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(12, -20)];
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: (opts) => { weaponCalls.push(opts); return 0; },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon: mockWeapon,
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 1);
});

test('createDemoAi: does NOT fire weapon in IDLE mode', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: () => { weaponCalls.push(1); return 0; },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    weapon: mockWeapon,
    options: { shipFactory: mock.build },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 0);
});

test('createDemoAi: getLastDecision returns a frozen snapshot', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(30, 0)];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  const dec = ai.getLastDecision();
  assert.equal(typeof dec.mode, 'string');
  assert.equal(typeof dec.yaw, 'number');
  assert.equal(typeof dec.thrust, 'boolean');
  assert.equal(typeof dec.fire, 'boolean');
  assert.equal(typeof dec.activeWeapon, 'string');
  assert.equal(typeof dec.threatsCount, 'number');
  assert.throws(() => { dec.mode = 'x'; }, /frozen|read.only/i);
});

test('createDemoAi: evade mode in getMode()', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)],
    options: { shipFactory: mock.build, rng: () => 0, evadeDist: 12 },
  });
  ai.getShip().position.x = 0;
  ai.getShip().position.z = 0;
  assert.equal(ai.getMode(), 'evade');
});

// --------------------------------------------------------------------------
// collectBehavior
// --------------------------------------------------------------------------

test('collectBehavior: returns null when target is not a powerup', () => {
  const ctx = {
    target: { mode: 'asteroid', pos: { x: 10, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
  };
  assert.equal(collectBehavior(ctx), null);
});

test('collectBehavior: turns toward powerup and thrusts when aligned', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 20, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    powerupVel: { x: 0, z: 0 },
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('collectBehavior: does not thrust when misaligned', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 20, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    powerupVel: { x: 0, z: 0 },
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  assert.notEqual(result.yaw, 0);
  assert.equal(result.thrust, false);
});

test('collectBehavior: predicts intercept point ahead of moving powerup', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 0, z: 20 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: 0, // facing -Z
    aiVel: { x: 0, z: 0 },
    powerupVel: { x: 0, z: 10 }, // powerup moving away
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  // Ship should turn to face the predicted intercept (roughly +Z).
  // When the target is directly behind, either yaw direction is valid;
  // the important thing is that the ship turns.
  assert.notEqual(result.yaw, 0);
});

test('collectBehavior: does not thrust when already closing too fast', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 200, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 65, z: 0 },
    powerupVel: { x: 0, z: 0 },
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, false, 'must not thrust when already closing faster than desired');
});

test('collectBehavior: thrusts when aligned and closing slower than desired', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 200, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 10, z: 0 },
    powerupVel: { x: 0, z: 0 },
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true, 'must thrust when aligned and closing slowly');
});

test('collectBehavior: predicts powerup velocity', () => {
  const ctx = {
    target: { mode: 'powerup', pos: { x: 20, z: 0 } },
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    powerupVel: { x: 10, z: 0 },
    powerupThrustGate: 0.10,
    yawDeadband: 0.10,
    aiAngularVel: 0,
  };
  const result = collectBehavior(ctx);
  assert.equal(result.mode, 'powerup');
  // Powerup is moving right, so the ship should still turn toward +X.
  assert.equal(result.yaw, 0);
});

// --------------------------------------------------------------------------
// facingAngle
// --------------------------------------------------------------------------

test('facingAngle: yaw=0 faces -Z', () => {
  assert.ok(Math.abs(facingAngle(0) - (-Math.PI / 2)) < 1e-9);
});

test('facingAngle: yaw=-PI/2 faces +X', () => {
  assert.ok(Math.abs(facingAngle(-Math.PI / 2)) < 1e-9);
});
