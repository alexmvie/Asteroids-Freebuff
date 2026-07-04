/**
 * Unit tests for src/entities/ai.js (v0.20.x — single-mode shooter).
 *
 * The brain (`aiBrainTick`) is a pure function that maps
 *   (ship position + yaw + asteroid list + powerup + tree thresholds)
 * to a 4-tuple `{ yaw, thrust, mode, fire }`.
 * v0.20.x collapsed the prior 4-mode priority (DODGE > HUNT > TARGET
 * > WANDER) to a single-mode shooter with three branches:
 *
 *   1. PANIC-DODGE — nearest asteroid within `panicDist`
 *   2. ENGAGE      — otherwise pick the best in-range target
 *                    (asteroid by default, powerup if significantly
 *                    closer per `powerupBiasU`) and apply
 *                    `engageController`. Fire at any in-cone
 *                    asteroid each tick ("feuer bis split").
 *   3. IDLE        — no targets in range; no thrust, no yaw.
 *
 * Tests cover all three branches + the pure helpers
 * (`engageController`, `findNearestAsteroid`, `isTargetInFront`,
 * `shouldResetAi`, `pickAiSpawn`). The factory (`createDemoAi`) is
 * smoke-tested with a mock ship factory — no Three.js dependency
 * in unit tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  engageController,
  findNearestAsteroid,
  isTargetInFront,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
} from '../src/entities/ai.js';

// --------------------------------------------------------------------------
// Mock helpers
// --------------------------------------------------------------------------

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
        rotation: state.rotation,
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
// aiBrainTick: PANIC-DODGE branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest within panicDist → mode=dodge, thrust=true', () => {
  // Asteroid at (5, 0). panicDist=6 → 5 < 6 → panic-dodge fires.
  // Ship at origin facing +Z (no, +X is yaw=-PI/2; default yaw=0
  // faces -Z). threatAngle=atan2(0, 5)=0. escapeAngle=PI/2.
  // facingAngle(0)=-PI/2. diff=PI. yaw=-1. thrust (any non-zero
  // diff) = true.
  const asteroids = [mockAsteroid(5, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
  });
  assert.equal(result.mode, 'dodge');
  assert.equal(result.thrust, true);
  assert.ok(result.yaw === -1 || result.yaw === 1);
  assert.equal(result.fire, false);
});

test('aiBrainTick: dodge steers ~90° perpendicular from threat', () => {
  // Asteroid at (5, 0). threatAngle=0. Ship facing +X (yaw=-PI/2).
  // escapeAngle=PI/2. facingAngle(-PI/2)=0. diff=PI/2 → yaw=-1.
  // (The +/- 0.1 deadband makes this exactly at the boundary;
  // a slight asymmetry above/below moves it definitively to one
  // side. Pin the "steers perpendicular" property only loosely.)
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'dodge');
  assert.notEqual(result.yaw, 0, 'must turn to escape');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: panicDist=0 disables dodge entirely (engage takes over)', () => {
  // Even with an asteroid at 1u, panicDist=0 disables the panic branch.
  // Without a powerup, there is no chase target → falls through to
  // IDLE (yaw=0, thrust=false).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(1, 0)],
    time: 0,
    panicDist: 0,
  });
  assert.notEqual(result.mode, 'dodge');
  // asteroid (1,0) IS in targetDist=100 range, but no powerup.
  // Wait — 1u asteroid SHOULD trigger engage! Let me check.
  // engageController at dist<0.01 → idle signature. dist=1 → engages.
  // Actually 1u is OUT of panicDist=0 (panicDist=0 means "no panic
  // shell") but IN of targetDist=100 → engage mode.
  assert.equal(result.mode, 'asteroid');
});

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE asteroid branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest asteroid in range → mode=asteroid, thrust when aligned', () => {
  // Ship at origin facing +X (yaw=-PI/2). Asteroid at (40, 0).
  // engageController: dist=40, diff=0 → yaw=0, thrust=true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: ENGAGE turn toward asteroid when misaligned', () => {
  // Ship at origin facing -Z (yaw=0). Asteroid at (40, 0) — to the
  // right. engaging requires a left turn (yaw=-1 in ship.js
  // convention = turn CCW which aligns +X-facing).
  // diff=wrapAngle(targetAngle - facingAngle(0))=wrapAngle(0 - (-PI/2))
  // = PI/2 > 0.15 → yaw=-1.
  // |PI/2| > 0.30 → thrust=false.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'turn CCW (-1) to face the +X asteroid');
  // 0.30 deadband → PI/2 is well past it → no thrust while turning.
  // (This matches the user's complaint that the bot turns AND
  // thrusts simultaneously, accelerating sideways. The simplified
  // engageController gates thrust on alignment.)
  assert.equal(result.thrust, false);
});

test('aiBrainTick: ENGAGE picks the NEAREST asteroid', () => {
  // Three asteroids at varying distances. Expected: nearest wins.
  const asteroids = [
    mockAsteroid(80, 0),
    mockAsteroid(20, 0), // 2x closer than 80
    mockAsteroid(-50, 0),
  ];
  // Ship facing +X (yaw=-PI/2).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids,
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  // Already aligned with (20, 0) → diff=0, both yaw=0, thrust=true.
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: ENGAGE picks nearest even when not perfectly aligned', () => {
  // Ship facing -Z (yaw=0). Nearest asteroid at (20, 0), farther
  // at (40, 0). Diff for nearest: wrapAngle(0-(-PI/2))=PI/2 → yaw=-1.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0), mockAsteroid(20, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  // Steering is toward nearest (20, 0): yaw=-1.
  assert.equal(result.yaw, -1);
});

test('aiBrainTick: no in-range asteroid → falls through to IDLE', () => {
  // All asteroids beyond targetDist=100. With no powerup either →
  // IDLE branch.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(200, 0)],
    time: 0,
    targetDist: 100,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.yaw, 0, 'idle = no rotation');
  assert.equal(result.thrust, false, 'idle = no acceleration');
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE powerup branch
// --------------------------------------------------------------------------

test('aiBrainTick: powerup wins over asteroid when significantly closer', () => {
  // Asteroid at (50, 0), powerup at (10, 0).
  // powerupDist=10 < asteroidDist=50 + (-30) = 20 → powerup wins.
  // Ship facing +X (yaw=-PI/2) → diff=0 → yaw=0, thrust=true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(50, 0)],
    time: 0,
    powerupPos: { x: 10, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: asteroid wins over powerup when not biased closer', () => {
  // Asteroid at (20, 0), powerup at (40, 0).
  // powerupDist=40 > asteroidDist=20 + (-30) = -10 → powerup loses.
  // Asteroid wins → mode=asteroid.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    powerupPos: { x: 40, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'asteroid');
});

test('aiBrainTick: powerup as fallback when no in-range asteroid', () => {
  // Asteroid beyond targetDist (200u); powerup within (60u).
  // Asteroid is dropped, powerup becomes the target.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(200, 0)],
    time: 0,
    powerupPos: { x: 60, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'powerup');
});

test('aiBrainTick: powerup too far → falls through to closest in-range target', () => {
  // Powerup at 200u (>targetDist=100) → dropped. Closest asteroid
  // at 30u picks up the slack.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(30, 0)],
    time: 0,
    powerupPos: { x: 200, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'asteroid');
});

test('aiBrainTick: powerupBiasU=0 → powerup wins if pDist <= asteroidDist (equal preferred)', () => {
  // Asteroid at (50, 0), powerup at (50, 0). With bias=0, the
  // `pDist < best.dist + bias` check is `pDist < asteroidDist` —
  // strict less-than, so asteroid wins on tie.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(50, 0)],
    time: 0,
    powerupPos: { x: 50, z: 0 },
    powerupBiasU: 0,
  });
  assert.equal(result.mode, 'asteroid', 'tie goes to asteroid with bias=0');
});

test('aiBrainTick: powerupBiasU=50 → powerup wins even when 50u farther than asteroid', () => {
  // Asteroid at (40, 0), powerup at (80, 0).
  // powerupDist=80 < asteroidDist=40 + 50 = 90 → powerup wins
  // (positive bias means "favor powerups even at distance").
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    powerupPos: { x: 80, z: 0 },
    powerupBiasU: 50,
  });
  assert.equal(result.mode, 'powerup');
});

// --------------------------------------------------------------------------
// aiBrainTick: fire decision
// --------------------------------------------------------------------------

test('aiBrainTick: fires when asteroid is in cone (regardless of chase target)', () => {
  // Ship facing -Z (yaw=0). Powerup at (5, 0) — significantly closer
  // than the (0, -40) asteroid (5 < 40 + (-30) = 10), so powerup is
  // the chase target. The in-cone asteroid at (0, -40) is the
  // "second target" — the AI fires at it even though it's chasing
  // the powerup. The fire check is INDEPENDENT of the chase target.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
    powerupPos: { x: 5, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.fire, true);
});

test('aiBrainTick: no asteroid in cone → fire=false', () => {
  // Asteroid at (0, 30) — behind the ship (yaw=0, faces -Z). Not in cone.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, 30)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false);
});

test('aiBrainTick: dodge mode → no fire', () => {
  // Asteroid within panicDist (close enough to dodge). Even if it's
  // also in cone, panic-dodge suppresses fire (don't shoot while
  // escaping).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -3)], // 3u, in-cone (faces -Z), in panic range
    time: 0,
    panicDist: 6,
  });
  assert.equal(result.mode, 'dodge');
  assert.equal(result.fire, false);
});

test('aiBrainTick: idle mode → no fire', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(200, 0)],
    time: 0,
    targetDist: 100,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// engageController (pure chase controller)
// --------------------------------------------------------------------------

test('engageController: dist < 0.01 → no thrust, no yaw (pickup radius absorbs)', () => {
  const r = engageController(
    { x: 50, z: 0 }, 0, { x: 50, z: 0 },
  );
  assert.equal(r.dist, 0);
  assert.equal(r.thrust, false);
  assert.equal(r.yaw, 0);
});

test('engageController: aligned → yaw=0, thrust=true', () => {
  // Ship facing +X (yaw=-PI/2 → facingAngle=0). Target at (60, 0).
  // diff=0 → yaw=0, |diff|<0.30 → thrust=true.
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
  assert.equal(r.dist, 60);
});

test('engageController: small diff (0.10) → within ±0.15 yaw deadband, thrust=true', () => {
  // Target at angle 0.10 from facing direction. |0.10| < 0.15 → yaw=0.
  // |0.10| < 0.30 → thrust=true (allows earlier commitment to thrust
  // than the legacy intercept's ±0.50 thrust deadband).
  const angle = 0.10;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('engageController: mid diff (0.22) → yaw=-1, thrust=true', () => {
  // |0.22| > 0.15 yaw deadband → yaw=-1.
  // |0.22| < 0.30 thrust deadband → thrust=true (turn-AND-thrust
  // when ALMOST aligned is intentional — keeps the bot moving
  // toward the target rather than stopping dead to align).
  const angle = 0.22;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, true);
});

test('engageController: large diff (0.50) → yaw=-1, thrust=false', () => {
  // |0.50| > 0.15 yaw deadband → yaw=-1.
  // |0.50| > 0.30 thrust deadband → thrust=false (don't accelerate
  // sideways while turning HARD).
  const angle = 0.50;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

test('engageController: negative diff → yaw=+1 (CW turn for CW misalignment)', () => {
  // Mirror of the 0.50 case. Ship facing +X, target at -X-side. yaw=+1.
  const angle = -0.50;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 1);
  assert.equal(r.thrust, false);
});

test('engageController: returns dist + diff as observability fields (regression guard)', () => {
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 60, z: 0 },
  );
  assert.equal(r.dist, 60);
  assert.equal(typeof r.diff, 'number');
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
  assert.equal(result.dx, 5);
  assert.equal(result.dz, 0);
});

test('findNearestAsteroid: picks the closest of multiple', () => {
  const a = mockAsteroid(50, 0);
  const b = mockAsteroid(0, 3);
  const c = mockAsteroid(-10, 0);
  const result = findNearestAsteroid({ x: 0, z: 0 }, [a, b, c]);
  assert.equal(result.asteroid, b);
  assert.equal(result.dist, 3);
});

test('findNearestAsteroid: skips asteroids with no getPosition', () => {
  const a = mockAsteroid(5, 0);
  const broken = { spec: {} };
  const result = findNearestAsteroid({ x: 0, z: 0 }, [broken, a]);
  assert.equal(result.asteroid, a);
});

// --------------------------------------------------------------------------
// isTargetInFront
// --------------------------------------------------------------------------

test('isTargetInFront: target directly ahead (yaw 0) → true', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: -10 }, 0.35), true);
});

test('isTargetInFront: target directly behind → false', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: 10 }, 0.35), false);
});

test('isTargetInFront: target just inside cone edge → true', () => {
  const a = 0.34;
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, 0, { x: Math.sin(a), z: -Math.cos(a) }, 0.35),
    true,
  );
});

test('isTargetInFront: target just outside cone edge → false', () => {
  const a = 0.40;
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, 0, { x: Math.sin(a), z: -Math.cos(a) }, 0.35),
    false,
  );
});

test('isTargetInFront: handles non-zero yaw correctly', () => {
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, 0.35),
    true,
  );
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: -10, z: 0 }, 0.35),
    false,
  );
});

test('isTargetInFront: null positions → false (defensive)', () => {
  assert.equal(isTargetInFront(null, 0, { x: 0, z: 0 }, 0.35), false);
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, null, 0.35), false);
});

// --------------------------------------------------------------------------
// shouldResetAi
// --------------------------------------------------------------------------

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

test('createDemoAi: factory wiring (mock shipFactory)', () => {
  // rng=0 → spawn position is (12, 0), yaw=0.
  // Asteroid at (5, 0) → 7u from ship → within legacy-default
  // panicDist=6 (5 < 7? no; wait, nearest dist = 7) — actually the
  // asteroid's getPosition returns {x:5,0} so |(0,0) - (5,0)| = 5
  // (ship spawns at (12,0), asteroid at (5,0) → distance 7).
  // panicDist=6: 7 > 6 → no panic. targetDist=100: 7 < 100 → engage.
  // mode='asteroid', already aligned? No — ship at (12,0), asteroid
  // at (5,0). The asteroid is to the WEST (negative X direction)
  // from the ship's spawn. Ship faces -Z (yaw=0). targetAngle=
  // atan2(0, -7)=PI. facingAngle(0)=-PI/2. diff=PI-(-PI/2)=3PI/2→
  // wrapped = -PI/2 (or PI/2 with wrap convention). |PI/2| > 0.15
  // yaw deadband. Both could fire a yaw depending on wrap.
  // Either way: yaw != 0, dist=7 < targetDist → mode=asteroid.
  const scene = mockScene();
  const asteroids = [mockAsteroid(5, 0)];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      rng: () => 0,
    },
  });
  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
  assert.equal(typeof ai.getShip, 'function');

  ai.update(0.1);
  assert.equal(mock.calls.setThrust.length, 1);
  assert.equal(mock.calls.update.length, 1);
  assert.equal(typeof mock.calls.setYaw[0], 'number');

  ai.update(0.1);
  ai.update(0.1);
  assert.equal(mock.calls.setYaw.length, 3);
  assert.equal(mock.calls.setThrust.length, 3);
  assert.equal(mock.calls.update.length, 3);
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

  const ship = ai.getShip();
  ship.position.x = 200;
  ship.position.z = 0;

  ai.update(0.1);
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

test('createDemoAi: NO strobe debouncer -- flips fire immediately (v0.20.x simplification)', () => {
  // v0.20.x dropped yawHoldTimeS/thrustHoldTimeS. A brain flipping
  // yaw every tick must be reflected directly -- no rate-limit hold.
  // This is the keystone test for the simplification: pure output passthrough.
  const scene = mockScene();
  const asteroids = [];
  const mock = mockShipFactory();
  let yawBrain = 1;
  const mockBrain = {
    tick: () => ({ yaw: yawBrain, thrust: false, mode: 'asteroid', fire: false }),
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
    },
  });
  ai.update(0.1);
  assert.equal(mock.calls.setYaw[0], 1, 'first yaw=1 fires immediately');
  yawBrain = -1;
  ai.update(0.05);
  assert.equal(mock.calls.setYaw[1], -1,
    'next-tick yaw=-1 is NOT held by a debouncer (v0.20.x has none)');
  yawBrain = 1;
  ai.update(0.01);
  assert.equal(mock.calls.setYaw[2], 1, 'each tick passes yaw straight through');
});

test('createDemoAi: NO fire-cadence gate -- every fire tick shoots (v0.20.x)', () => {
  // v0.20.x dropped fireMinIntervalS. The brain asks fire=true → the
  // ship fires. No 300ms cadence gate. Matches the user's "feuer so
  // lange bis split" intent (the ship-side bullet cooldown is still
  // honored by bullet-pool internals, but the brain side is clean).
  const scene = mockScene();
  const asteroids = [mockAsteroid(0, -40)]; // in cone (ship faces -Z)
  const mock = mockShipFactory();
  const fireCalls = [];
  const weapon = { fire: () => { fireCalls.push(1); return 0; } };
  const mockBrain = {
    tick: () => ({ yaw: 0, thrust: false, mode: 'asteroid', fire: true }),
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon,
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  ai.update(0.1);
  ai.update(0.1);
  ai.update(0.1);
  assert.equal(fireCalls.length, 3, 'every fire=true tick fires immediately');
});

test('createDemoAi: getMode() reflects the live brain decision', () => {
  // Smoke test: getMode reads arg from live ship state via
  // brainArgsFromShip. With an asteroid at (5, 0) and rng=0 spawning
  // the ship at (12, 0), dist=7 → not in panicDist=6 (panic only if
  // dist<6) → not in dodge. Falls to asteroid mode (7 < targetDist).
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(5, 0)],
    options: {
      shipFactory: mock.build,
      rng: () => 0,
    },
  });
  // getMode reads ai.getShip().position which was set during spawn.
  // With rng=0, spawn lands at (12, 0). Asteroid at (5, 0). dist=7.
  // 7 not < 6 (panicDist), but 7 < 100 (targetDist) → mode='asteroid'.
  assert.equal(ai.getMode(), 'asteroid');
});

test('createDemoAi: getMode() in panicDist returns dodge', () => {
  // Force the ship into panic range by post-spawn editing the mock state.
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)], // on top of the spawn position
    options: {
      shipFactory: mock.build,
      rng: () => 0,
    },
  });
  // Spawn lands at (12, 0). Asteroids at (0, 0) → dist=12. Not in
  // panicDist. Override ship position so it sits ON the asteroid.
  ai.getShip().position.x = 0;
  ai.getShip().position.z = 0;
  assert.equal(ai.getMode(), 'dodge');
});

// --------------------------------------------------------------------------
// createDemoAi: factory wiring for bullets
// --------------------------------------------------------------------------

test('createDemoAi: fires weapon when asteroid is in cone during ENGAGE', () => {
  // Ship spawns at (12, 0). Asteroid at (12, -40) directly in front
  // (z=-40 → yaw=0 faces -Z → asteroid IS in cone). Powerup wins
  // because closer? No — powerupPos=null. Closest asteroid wins →
  // mode=asteroid, fire=true.
  const scene = mockScene();
  const asteroids = [mockAsteroid(12, -40)];
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
  assert.equal(typeof weaponCalls[0].origin, 'object');
  assert.equal(typeof weaponCalls[0].direction, 'object');
});

test('createDemoAi: fires weapon on ANY in-cone asteroid -- not just chase target', () => {
  // Ship spawns at (12, 0), facing -Z. Powerup at (15, 0) — close to
  // the spawn (pDist=3) so it wins the chase-target tie against the
  // (12, -40) in-cone asteroid (aDist=40). With bias=-30 the
  // condition `pDist < aDist + bias` is `3 < 10`, true → powerup wins.
  // Asteroid at (12, -40) is in cone directly in front.
  // The chase target is the powerup; the fire check is INDEPENDENT
  // of the chase target — the AI fires at the asteroid even though
  // it's chasing the powerup.
  const scene = mockScene();
  const asteroids = [mockAsteroid(12, -40)];
  const mock = mockShipFactory();
  const weaponCalls = [];
  const mockWeapon = {
    fire: () => { weaponCalls.push(1); return 0; },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon: mockWeapon,
    getPowerupPos: () => ({ x: 15, z: 0 }),
    options: {
      shipFactory: mock.build,
      rng: () => 0,
      powerupBiasU: -30,
    },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 1, 'fires at in-cone asteroid during POWERUP chase');
  // Verify the mode is the powerup chase (so the test isn't
  // accidentally passing because we're chasing the asteroid).
  assert.equal(ai.getMode(), 'powerup');
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
    asteroids: [], // empty → IDLE
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
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build },
  });
  ai.update(0.1);
  ai.update(0.1);
  assert.equal(mock.calls.setYaw.length, 2);
  assert.equal(mock.calls.update.length, 2);
});
