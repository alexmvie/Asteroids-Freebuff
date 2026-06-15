/**
 * Unit tests for src/entities/ai.js.
 *
 * The brain (`aiBrainTick`) is a pure function: ship position + yaw +
 * asteroid list + time → desired `{ yaw, thrust, mode }`. These tests
 * exercise all three behavior modes (dodge, target, wander) plus the
 * pure helpers (`findNearestAsteroid`, `shouldResetAi`, `pickAiSpawn`).
 * The factory (`createDemoAi`) is smoke-tested with a mock ship factory
 * — no Three.js dependency in unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  findNearestAsteroid,
  isTargetInFront,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
} from '../src/entities/ai.js';

// ---- Mock helpers ------------------------------------------------------

function mockAsteroid(x, z) {
  return {
    spec: { position: { x, y: 0, z } },
    getPosition: () => ({ x, y: 0, z }),
  };
}

function mockShipFactory() {
  const state = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0, roll: 0 },
  };
  const calls = { setYaw: [], setThrust: [], update: [], reset: [] };
  let scene = null;
  return {
    state,
    calls,
    /** Build a fresh mock ship bound to a scene. */
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
        },
        rotation: state.rotation, // same reference
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

// ---- aiBrainTick: arg validation --------------------------------------

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

// ---- aiBrainTick: DODGE mode ------------------------------------------

test('aiBrainTick: returns dodge mode when an asteroid is within dodgeDist', () => {
  const asteroids = [mockAsteroid(5, 0)]; // 5 units in +X direction
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'dodge');
  assert.equal(result.thrust, true);
  assert.ok(result.yaw === -1 || result.yaw === 1);
});

test('aiBrainTick: dodge beats target when an asteroid is within both ranges', () => {
  // Asteroid is within targetDist AND within dodgeDist → dodge wins.
  const asteroids = [mockAsteroid(5, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'dodge');
});

test('aiBrainTick: dodge steers perpendicular (90°) to the threat', () => {
  // Asteroid at +X (angle 0). Escape angle = 0 + PI/2 = PI/2 (i.e. +Z).
  // Ship yaw is PI, which in the (x, z) plane means the ship is
  // ALREADY facing +Z (facingAngle(PI) = PI/2 = escape direction).
  // So the brain says yaw: 0 — the ship is already pointing the
  // right way, it just thrusts north. (The old `aiYaw`-based diff
  // was off by 90° and reported yaw: -1, but that pointed the ship
  // away from the escape direction.)
  const asteroids = [mockAsteroid(5, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: Math.PI, // facing +Z
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'dodge');
  assert.equal(result.yaw, 0);
});

// ---- aiBrainTick: TARGET mode -----------------------------------------

test('aiBrainTick: returns target mode when an asteroid is within targetDist but outside dodgeDist', () => {
  const asteroids = [mockAsteroid(40, 0)]; // outside dodgeDist (14), inside targetDist (90)
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: target steers toward the nearest asteroid (left yaw for +X target)', () => {
  // Asteroid at +X (targetAngle = atan2(0, +X) = 0). Ship yaw 0 means
  // the ship is facing -Z (facingAngle(0) = atan2(-1, 0) = -PI/2).
  // The brain compares the ACTUAL facing direction (facingAngle) to
  // the target direction. The ship needs to turn LEFT to go from
  // south to east → yaw: -1.
  //
  // (The old `aiYaw`-based diff was 0 - 0 = 0 → yaw: 0, but yaw=0
  // points the ship south, not east, so the AI never actually
  // faced the target and never fired. That's the bug we just fixed.)
  const asteroids = [mockAsteroid(40, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.yaw, -1);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: target picks the NEAREST asteroid (not the first)', () => {
  // Far asteroid at +X 80, near asteroid at -Z 30. The brain should
  // steer toward +Z (the closer one), not +X.
  const asteroids = [mockAsteroid(80, 0), mockAsteroid(0, 30)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  // Target at (0, 30) → targetAngle = atan2(30, 0) = PI/2.
  // Ship facingAngle(0) = -PI/2 (facing south).
  // diff = targetAngle - facingAngle = PI/2 - (-PI/2) = PI > 0.1
  // → yaw: -1 (turn left; from south, left turn takes the ship
  // through SE → E → NE → N, eventually facing the target).
  assert.equal(result.yaw, -1);
});

test('aiBrainTick: does not target if all asteroids are beyond targetDist', () => {
  const asteroids = [mockAsteroid(200, 0)]; // beyond targetDist (90)
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'wander');
});

// ---- aiBrainTick: WANDER mode -----------------------------------------

test('aiBrainTick: empty asteroid list → wander', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
  });
  assert.equal(result.mode, 'wander');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: wander picks a new heading on first call (wanderHeading=null)', () => {
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.5; }; // → angle 0
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: null,
    wanderHeadingExpiresAt: 0,
    rng,
  });
  assert.equal(result.mode, 'wander');
  assert.equal(rngCalls, 1);
  assert.equal(result._wanderHeading, 0); // 0.5 * 2 - 1 = 0, * PI = 0
});

test('aiBrainTick: wander keeps the same heading while still in the period', () => {
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.5; };
  const first = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: 1.0,
    wanderHeadingExpiresAt: 5.0, // not yet expired
    rng,
  });
  assert.equal(rngCalls, 0); // rng should NOT be called when heading is still valid
  assert.equal(first._wanderHeading, 1.0);
});

test('aiBrainTick: wander picks a new heading after the period expires', () => {
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.25; }; // → -PI/2
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 10.0,                // past the previous expiresAt
    wanderHeading: 1.0,
    wanderHeadingExpiresAt: 5.0,
    wanderTurnPeriod: 2.5,
    rng,
  });
  assert.equal(rngCalls, 1);
  assert.ok(Math.abs(result._wanderHeading + Math.PI / 2) < 1e-9);
  // expiresAt = time + wanderTurnPeriod = 12.5
  assert.equal(result._wanderHeadingExpiresAt, 12.5);
});

test('aiBrainTick: wander yaw steers toward the heading', () => {
  // Ship at yaw 0 faces -Z (south) in atan2 terms: facingAngle(0) = -PI/2.
  // Heading = +PI/4 (NE in atan2). diff = heading - facing = 3PI/4 > 0.1
  // → yaw: -1 (turn left, which increases the facing angle from
  // -PI/2 toward +PI/4).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: Math.PI / 4,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result.yaw, -1);
  // Heading = -PI/4 (SE). diff = -PI/4 - (-PI/2) = PI/4 > 0.1
  // → yaw: -1.
  const result2 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: -Math.PI / 4,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result2.yaw, -1);
});

test('aiBrainTick: wander yaw is 0 when heading is aligned (within deadband)', () => {
  // Ship at yaw 0 faces -Z in atan2 terms (facingAngle(0) = -PI/2).
  // For the heading to be "aligned with the ship", it has to be
  // close to -PI/2 — NOT close to 0. The old test used heading
  // ≈ 0 which was "aligned" with the BROKEN convention (where
  // the brain compared `heading` to `aiYaw` directly). Under the
  // fixed convention, heading = -PI/2 + 0.05 is within the 0.1
  // deadband of the ship's actual facing direction → no steering.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: -Math.PI / 2 + 0.05,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result.yaw, 0);
});

// ---- findNearestAsteroid ----------------------------------------------

test('findNearestAsteroid: empty list returns null', () => {
  assert.equal(findNearestAsteroid({ x: 0, z: 0 }, []), null);
});

test('findNearestAsteroid: single asteroid', () => {
  const a = mockAsteroid(5, 0);
  const result = findNearestAsteroid({ x: 0, z: 0 }, [a]);
  assert.equal(result.asteroid, a);
  assert.equal(result.dist, 5);
  assert.equal(result.dx, 5);
  assert.equal(result.dz, 0);
});

test('findNearestAsteroid: picks the closest of multiple', () => {
  const a = mockAsteroid(50, 0);
  const b = mockAsteroid(0, 3); // closer
  const c = mockAsteroid(-10, 0);
  const result = findNearestAsteroid({ x: 0, z: 0 }, [a, b, c]);
  assert.equal(result.asteroid, b);
  assert.equal(result.dist, 3);
});

test('findNearestAsteroid: skips asteroids with no getPosition', () => {
  const a = mockAsteroid(5, 0);
  const broken = { spec: {} }; // no getPosition
  const result = findNearestAsteroid({ x: 0, z: 0 }, [broken, a]);
  assert.equal(result.asteroid, a);
});

// ---- shouldResetAi ----------------------------------------------------

test('shouldResetAi: inside resetDist → false', () => {
  assert.equal(shouldResetAi({ x: 50, z: 50 }, 220), false);
  assert.equal(shouldResetAi({ x: 0, z: 0 }, 220), false);
});

test('shouldResetAi: outside resetDist → true', () => {
  assert.equal(shouldResetAi({ x: 300, z: 0 }, 220), true);
  assert.equal(shouldResetAi({ x: 0, z: -250 }, 220), true);
});

test('shouldResetAi: exactly on the boundary → false (strict >)', () => {
  assert.equal(shouldResetAi({ x: 220, z: 0 }, 220), false);
});

test('shouldResetAi: null pos → false', () => {
  assert.equal(shouldResetAi(null, 220), false);
});

// ---- pickAiSpawn ------------------------------------------------------

test('pickAiSpawn: returns a position within radius', () => {
  // 100 trials — should always be inside `radius`.
  for (let i = 0; i < 100; i++) {
    const { position } = pickAiSpawn(30);
    const r = Math.hypot(position.x, position.z);
    assert.ok(r <= 30, `r=${r}`);
    assert.ok(r >= 12, `r=${r}`); // 0.4 × 30 = 12 minimum
    assert.equal(position.y, 0);
  }
});

test('pickAiSpawn: deterministic with a fixed rng', () => {
  const rng = () => 0; // angle 0, r = 0.4
  const { position, yaw } = pickAiSpawn(30, rng);
  // cos(0) * (30 * 0.4) = 12, sin(0) * 12 = 0
  assert.ok(Math.abs(position.x - 12) < 1e-9);
  assert.ok(Math.abs(position.z) < 1e-9);
  // yaw = 0 * 2π = 0
  assert.equal(yaw, 0);
});

// ---- createDemoAi factory ---------------------------------------------

test('createDemoAi: requires scene and asteroids', () => {
  assert.throws(() => createDemoAi({}), /scene/);
  assert.throws(() => createDemoAi({ scene: mockScene() }), /asteroids/);
});

test('createDemoAi: factory wiring (mock shipFactory)', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(5, 0)];
  const mock = mockShipFactory();

  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      dodgeDist: 14,
      targetDist: 90,
    },
  });

  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
  assert.equal(typeof ai.getShip, 'function');

  // First tick: asteroid at (5,0) is within dodgeDist (14) → dodge mode.
  ai.update(0.1);
  assert.equal(mock.calls.setThrust.length, 1);
  assert.equal(mock.calls.setThrust[0], true); // thrust: true in dodge
  assert.equal(mock.calls.update.length, 1);

  // Multiple ticks: each calls setYaw, setThrust, update exactly once.
  ai.update(0.1);
  ai.update(0.1);
  assert.equal(mock.calls.setYaw.length, 3);
  assert.equal(mock.calls.setThrust.length, 3);
  assert.equal(mock.calls.update.length, 3);

  // No resets should have happened (we're not far from origin).
  assert.equal(mock.calls.reset.length, 0);
});

test('createDemoAi: reset when ship drifts beyond resetDist', () => {
  const scene = mockScene();
  const asteroids = [];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      resetDist: 50,
      spawnRadius: 10,
    },
  });

  // Manually move the mock ship far from origin.
  const ship = ai.getShip();
  ship.position.x = 200;
  ship.position.z = 0;

  ai.update(0.1);
  // Reset should have been called.
  assert.ok(mock.calls.reset.length >= 1);
});

test('createDemoAi: dt <= 0 is a no-op (no calls)', () => {
  const scene = mockScene();
  const asteroids = [];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build },
  });

  ai.update(0);
  ai.update(-1);
  assert.equal(mock.calls.setYaw.length, 0);
  assert.equal(mock.calls.setThrust.length, 0);
  assert.equal(mock.calls.update.length, 0);
});

// ---- isTargetInFront --------------------------------------------------

test('isTargetInFront: target directly ahead (yaw 0) → true', () => {
  // Ship at origin facing -Z (yaw 0 → forward = -Z). Target at (0, -10) is
  // directly ahead.
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: -10 }, 0.35), true);
});

test('isTargetInFront: target directly behind → false', () => {
  // Target at (0, +10) is behind the ship (yaw 0 → forward = -Z).
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: 10 }, 0.35), false);
});

test('isTargetInFront: target just inside cone edge → true', () => {
  // yaw 0 → forward = -Z (angle = PI in (x, z) atan2 terms). A target at
  // (sin(0.34), -cos(0.34)) is at angle PI + 0.34, which is 0.34 off
  // forward → inside a 0.35 cone → true.
  const a = 0.34;
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, 0, { x: Math.sin(a), z: -Math.cos(a) }, 0.35),
    true,
  );
});

test('isTargetInFront: target just outside cone edge → false', () => {
  // 0.40 rad off forward → outside a 0.35 cone.
  const a = 0.40;
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, 0, { x: Math.sin(a), z: -Math.cos(a) }, 0.35),
    false,
  );
});

test('isTargetInFront: handles non-zero yaw correctly', () => {
  // Ship facing +X (yaw = -PI/2 → forward = +X). Target at (10, 0) is
  // directly ahead.
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, 0.35),
    true,
  );
  // Target at (-10, 0) is directly behind.
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: -10, z: 0 }, 0.35),
    false,
  );
});

test('isTargetInFront: null positions → false (defensive)', () => {
  assert.equal(isTargetInFront(null, 0, { x: 0, z: 0 }, 0.35), false);
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, null, 0.35), false);
});

// ---- aiBrainTick: fire decision ---------------------------------------

test('aiBrainTick: target mode → fire:false when target is not in front', () => {
  // Ship at origin facing -Z (yaw 0). Target at (40, 0) is to the side →
  // not in the forward cone.
  const asteroids = [mockAsteroid(40, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, false);
});

test('aiBrainTick: target mode → fire:true when target is directly ahead', () => {
  // Ship facing -Z (yaw 0). Target at (0, -40) is directly ahead.
  const asteroids = [mockAsteroid(0, -40)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, true);
});

test('aiBrainTick: dodge mode → fire:false (no shooting while dodging)', () => {
  // Asteroid is within dodgeDist → dodge mode, must NOT fire.
  const asteroids = [mockAsteroid(5, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
  });
  assert.equal(result.mode, 'dodge');
  assert.equal(result.fire, false);
});

test('aiBrainTick: wander mode → fire:false (no shooting at nothing)', () => {
  // No asteroids in range → wander mode, must NOT fire.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(200, 0)], // out of targetDist
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
  });
  assert.equal(result.mode, 'wander');
  assert.equal(result.fire, false);
});

// ---- createDemoAi: factory wiring for bullets -------------------------

test('createDemoAi: fires weapon in TARGET mode when target is ahead', () => {
  const scene = mockScene();
  // Pin spawn via rng()=0 → ship at (12, 0, 0) facing yaw=0 (forward = -Z).
  // Asteroid at (12, -20) is on the ship's -Z axis, so the brain is in
  // target mode (distance 20 < targetDist=90) and the target is directly
  // ahead (within the 0.35-rad forward cone).
  const asteroids = [mockAsteroid(12, -20)];
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: (opts) => {
      weaponCalls.push(opts);
      return 0;
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon: mockWeapon,
    options: {
      shipFactory: mock.build,
      dodgeDist: 14,
      targetDist: 90,
      fireConeHalfAngle: 0.35,
      rng: () => 0,
    },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 1);
  assert.equal(typeof weaponCalls[0].origin, 'object');
  assert.equal(typeof weaponCalls[0].direction, 'object');
});

test('createDemoAi: does NOT fire weapon in DODGE mode', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(5, 0)]; // within dodgeDist
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: (opts) => {
      weaponCalls.push(opts);
      return 0;
    },
  };
  // Pin spawn via rng()=0 → ship at (12, 0). Asteroid at (5, 0) → distance 7
  // → within dodgeDist=14. Without this, default Math.random can spawn
  // the ship 21+ units away and the asteroid falls into targetDist=90.
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon: mockWeapon,
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 0);
});

test('createDemoAi: does NOT fire weapon in WANDER mode', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: (opts) => {
      weaponCalls.push(opts);
      return 0;
    },
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

test('createDemoAi: works without weapon option (no firing at all)', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(0, -40)];
  const mock = mockShipFactory();
  // No weapon option — should still tick without throwing.
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build },
  });
  // Should not throw, no firing to verify since no weapon.
  ai.update(0.1);
  ai.update(0.1);
  assert.equal(mock.calls.setYaw.length, 2);
  assert.equal(mock.calls.update.length, 2);
});

test('createDemoAi: getMode reflects the current behavior', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(5, 0)]; // within dodgeDist
  const mock = mockShipFactory();
  // Deterministic spawn: rng()=0 → angle 0, r = 0.4 × 30 = 12 → position (12, 0).
  // Asteroid at (5, 0) → distance 7 → within dodgeDist=14 → dodge.
  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      dodgeDist: 14,
      targetDist: 90,
      rng: () => 0,
    },
  });

  assert.equal(ai.getMode(), 'dodge');
});
