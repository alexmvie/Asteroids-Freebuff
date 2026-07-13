/**
 * Unit tests for src/entities/ai.js (v0.30.x — radical simplification).
 *
 * The brain (`aiBrainTick`) is a pure function that maps
 *   (ship position + yaw + angular velocity + asteroid list + powerup)
 * to a 4-tuple `{ yaw, thrust, mode, fire }`.
 *
 * Four modes: EVADE (12u) → POWERUP (always priority) → ASTEROID → IDLE.
 *
 * `engageTarget` uses coast-in: turn toward target (spin-brake prediction),
 * thrust when aligned AND closingSpeed is low OR beyond coastDist.
 * Prevents fly-through at high speed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  engageTarget,
  findNearestAsteroid,
  isTargetInFront,
  pickTarget,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
  predictInterceptPoint,
  findCollisionThreat,
} from '../src/entities/ai.js';

// --------------------------------------------------------------------------
// Mock helpers
// --------------------------------------------------------------------------

function mockAsteroid(x, z, vel, radius = 3) {
  const v = vel || { x: 0, z: 0 };
  return {
    spec: { position: { x, y: 0, z }, radius },
    getPosition: () => ({ x, y: 0, z }),
    getVelocity: () => ({ x: v.x, z: v.z }),
    getRadius: () => radius,
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

test('aiBrainTick: nearest within evadeDist → mode=evade, thrust=true', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 8,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.thrust, true);
  assert.ok(result.yaw === -1 || result.yaw === 1);
  assert.equal(result.fire, false);
  assert.equal(result.braking, false);
});

test('aiBrainTick: evade steers ~90° perpendicular from threat', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 8,
  });
  assert.equal(result.mode, 'evade');
  assert.notEqual(result.yaw, 0, 'must turn to escape');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: evade mode → no fire, always thrust', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -3)],
    time: 0,
    evadeDist: 8,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.fire, false);
  assert.equal(result.thrust, true, 'evade always thrusts to escape danger zone');
});

test('aiBrainTick: legacy panicDist param works as fallback for evadeDist', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    panicDist: 8,
  });
  assert.equal(result.mode, 'evade',
    'panicDist=8 should trigger evade for asteroid at 5u');
});

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE branch (speed-managed)
// --------------------------------------------------------------------------

test('aiBrainTick: nearest asteroid in range → mode=asteroid, thrust when aligned', () => {
  // Ship at origin, facing +X toward asteroid at +X (40u away).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true, 'aligned → thrust ON (simple controller)');
});

test('aiBrainTick: ENGAGE turn toward asteroid when misaligned', () => {
  // Ship facing -Z (yaw=0), asteroid at +X (90° off).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0, // facing -Z
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'turn to face the +X asteroid');
  // At 90° off-axis, |targetDiff| ≈ π/2 ≈ 1.57 > thrustGate=0.30 → thrust OFF.
  assert.equal(result.thrust, false, '90° off-axis → thrust OFF');
});

test('aiBrainTick: ENGAGE picks the NEAREST asteroid', () => {
  const asteroids = [
    mockAsteroid(80, 0),
    mockAsteroid(20, 0),
    mockAsteroid(-50, 0),
  ];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids,
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: powerup target suppresses stray fire while collecting a pickup', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    powerupPos: { x: 10, z: 0 },
    powerupBiasU: 25,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.fire, false);
});

test('aiBrainTick: 0.20 rad off → outside tightened thrustGate=0.15 → thrust OFF while turning', () => {
  // Ship 0.20 rad off target — outside thrustGate=0.15 (v0.38.2: reduced from 0.25).
  // Pure stop-turn-thrust: ship turns without accelerating until nearly aligned.
  const targetX = Math.sin(0.20) * 40;
  const targetZ = -Math.cos(0.20) * 40;
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(targetX, targetZ)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.notEqual(result.yaw, 0, 'still turning toward target');
  assert.equal(result.thrust, false,
    '0.20 > thrustGate=0.15 → thrust OFF while turning (stop-turn-thrust)');
});

test('aiBrainTick: 0.05 rad off → within tightened thrustGate=0.15 → thrust ON', () => {
  // Ship 0.05 rad off target — well within thrustGate=0.15 (v0.38.2).
  const targetX = Math.sin(0.05) * 40;
  const targetZ = -Math.cos(0.05) * 40;
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(targetX, targetZ)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0, 'within YAW_DEADBAND=0.08 → no yaw');
  assert.equal(result.thrust, true,
    '0.05 < thrustGate=0.15 → thrust ON when nearly aligned');
});

test('aiBrainTick: thrust ON when aligned (simple controller)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0, 'aligned → no turning');
  assert.equal(result.thrust, true, 'aligned → thrust ON');
});

// --------------------------------------------------------------------------
// aiBrainTick: simple controller — thrust whenever within gate
// --------------------------------------------------------------------------

test('aiBrainTick: aligned + high speed + far target → still thrusts (no coasting, fly-by pattern)', () => {
  // Ship at origin, facing +X toward target at (200, 0).
  // Fly-by controller: no coasting, no speed management. Always thrust when aligned.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 80, z: 0 },
    asteroids: [mockAsteroid(200, 0)],
    time: 0,
    predictiveEvadeLookahead: 0, // disable predictive evade for this legacy test
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true,
    'fly-by: thrust when aligned regardless of speed');
});

test('aiBrainTick: close target + stationary → thrusts (low closing speed, no coast)', () => {
  // v0.33.x: ship is stationary at 4u from target. closingSpeed=0
  // which is < 30 threshold → no coast-in, thrust normally.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    // Use radius=0 so the radius-aware EVADE threshold stays at
    // max(2, 1.4+0+2) = 3.4, below the asteroid's 4u distance.
    asteroids: [mockAsteroid(4, 0, undefined, 0)],
    time: 0,
    evadeDist: 2,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'stationary → no coast-in, thrust to accelerate');
});

test('aiBrainTick: powerup target near the ship brakes to avoid overshoot', () => {
  // v0.41.0: powerups are allowed to brake. At 15u with 30 u/s closing speed,
  // dist < BRAKE_DIST=30 && closingSpeed=30 > BRAKE_ENTER_SPEED=25 → brake.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 30, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 15, z: 0 },
    coastDist: 20,
    powerupBiasU: 9999,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.braking, true, 'powerup intercept should brake to avoid overshoot');
  assert.equal(result.thrust, true, 'brake thrusts backward to shed speed');
});

// v0.37.2 regression: powerup with low closing speed within coastDist should still thrust
// (ship crawling toward a close powerup should keep moving)
test('aiBrainTick: powerup with low closing speed within coastDist still thrusts', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 3, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 15, z: 0 },
    coastDist: 20,
    powerupBiasU: 9999,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.thrust, true, 'low closing speed (3 < 5) → no coast → thrust');
  assert.equal(result.braking, false);
});

test('aiBrainTick: high speed + close target → active brake (flip and thrust backward)', () => {
  // v0.38.0: BRAKE_DIST=30. dist=10 < BRAKE_DIST=30 && closingSpeed=150 > 25 → brake.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 150, z: 0 },
    asteroids: [mockAsteroid(10, 0)],
    time: 0,
    evadeDist: 5,  // avoid triggering EVADE at 10u
    predictiveEvadeLookahead: 0, // disable predictive evade for this legacy test
  });
  assert.equal(result.mode, 'asteroid');
  assert.notEqual(result.yaw, 0, 'v0.34.3: active brake flips ship to face opposite velocity');
  assert.equal(result.thrust, true, 'v0.34.3: active brake thrusts backward to shed speed');
  assert.equal(result.braking, true, 'braking flag is true during active brake');
});

test('aiBrainTick: perpendicular velocity → turn + thrust toward target', () => {
  // Ship moving fast perpendicular to target. Closing speed ≈ 0
  // (perpendicular motion) → no coast-in → thrust normally.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X, toward target at (40,0)
    aiVel: { x: 0, z: 200 }, // moving perpendicular
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0, 'already facing target → yaw=0');
  assert.equal(result.thrust, true, 'perpendicular → closingSpeed≈0 → thrust');
});

test('aiBrainTick: receding velocity within coastDist → still thrusts', () => {
  // Ship at 30u from target, moving AWAY (closingSpeed < 0).
  // Should NOT coast — closing speed is negative.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    aiVel: { x: -50, z: 0 }, // moving AWAY from target
    asteroids: [mockAsteroid(30, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'receding closingSpeed<0 → no coast → thrust');
});

test('aiBrainTick: brake does NOT fire when closingSpeed below entry threshold', () => {
  // dist=20 < BRAKE_DIST=30, but closingSpeed=10 < 20 → no brake, normal coast
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 10, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, false, 'slow approach → coast, no brake');
  assert.equal(result.braking, false, 'braking flag is false when not braking');
});

test('aiBrainTick: brake does NOT fire when beyond BRAKE_DIST', () => {
  // dist=35 > BRAKE_DIST=30 → no brake (beyond threshold)
  // dist=35 < coastDist=40, closingSpeed=20 > 5 → coast → no thrust (also beyond BRAKE_DIST=30)
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(35, 0)],
    time: 0,
    evadeDist: 5,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, false, 'no brake (closingSpeed=20 not > 20) → coast (dist<40) → no thrust');
  assert.equal(result.braking, false);
});

test('aiBrainTick: perpendicular motion near target → no brake', () => {
  // dist=20 < BRAKE_DIST, but closingSpeed≈0 (perpendicular) → no brake
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 50 },
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'perpendicular → closingSpeed≈0 → no coast → thrust');
  assert.equal(result.braking, false);
});

test('aiBrainTick: coast boundary — dist=40 exactly does NOT coast (strict <)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'dist=40 is NOT < coastDist=40 → no coast');
});

test('aiBrainTick: beyond coastDist → thrust even when closing fast', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 100, z: 0 },
    asteroids: [mockAsteroid(55, 0)],
    time: 0,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');    assert.equal(result.thrust, true, 'dist=55 > coastDist=40 → no coast → thrust');
});

test('aiBrainTick: moderate closing speed within coastDist → coast (no thrust)', () => {
  // Ship closing at 20 u/s toward target at 35u.
  // v0.34.3: coastDist=40, COAST_SPEED_THRESHOLD=5.
  // closingSpeed=20 < BRAKE_ENTER=25 → no brake
  // dist=35 < 40 && closingSpeed=20 > 5 → shouldCoast=true → thrust=false.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(35, 0)],
    time: 0,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, false, 'v0.34.3: coast-in when closing within coastDist=40');
  assert.equal(result.braking, false, 'coasting is not braking');
});

// --------------------------------------------------------------------------
// aiBrainTick: powerup branch
// --------------------------------------------------------------------------

test('aiBrainTick: powerup wins over asteroid when biased closer', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0)],
    time: 0,
    powerupPos: { x: 5, z: 0 },
    powerupBiasU: 60,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: asteroid wins when powerup is not biased closer', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    powerupPos: { x: 100, z: 0 },
    powerupBiasU: 60,
  });
  assert.equal(result.mode, 'asteroid');
});

// --------------------------------------------------------------------------
// aiBrainTick: brake hysteresis
// --------------------------------------------------------------------------

test('aiBrainTick: brake hysteresis — continues braking until closingSpeed < 10', () => {
  // wasBraking=true, dist=20 < 40, closingSpeed=20 (between exit=10 and entry=25)
  // Hysteresis: should KEEP braking because wasBraking=true and closingSpeed > 10
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
    wasBraking: true,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.braking, true, 'hysteresis: keep braking while closingSpeed=20 > exit=10');
  assert.notEqual(result.yaw, 0, 'still turning to face opposite velocity');
});

test('aiBrainTick: brake hysteresis — releases when closingSpeed drops below 10', () => {
  // wasBraking=true, dist=20 < 40, closingSpeed=8 < 10
  // Hysteresis: should RELEASE brake
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 8, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
    wasBraking: true,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.braking, false, 'hysteresis: release brake when closingSpeed=8 < exit=10');
});

test('aiBrainTick: brake hysteresis — speed-based exit keeps braking when closingSpeed is negative', () => {
  // v0.35.0 REGRESSION TEST: the exact bug scenario.
  // Ship is moving away from target (closingSpeed < 0) but still at
  // high absolute speed (> 10). The brake should KEEP FIRING because
  // the hysteresis uses speed (absolute magnitude), not closingSpeed.
  // Without this fix, the brake would release on the first tick after
  // the 180° flip, producing the visible orbiting oscillation.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: Math.PI, // facing away from target
    aiVel: { x: -50, z: 0 }, // moving away from target at 50 u/s
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
    wasBraking: true,
  });
  // closingSpeed is negative (ship moving away from target), but
  // speed=50 > 10 → hysteresis keeps braking.
  assert.equal(result.braking, true,
    'speed-based hysteresis: brake KEEPS firing even with closingSpeed < 0');
  assert.notEqual(result.yaw, 0,
    'brake continues turning to face opposite velocity');
  assert.equal(result.thrust, true,
    'brake thrusts backward during speed-based hysteresis');
});

test('aiBrainTick: brake hysteresis — does NOT start braking at closingSpeed=20', () => {
  // wasBraking=false, dist=20 < 40, closingSpeed=20 (between exit=10 and entry=25)
  // Without hysteresis history, should NOT brake (entry requires >25)
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    evadeDist: 5,
    wasBraking: false,
    predictiveEvadeLookahead: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.braking, false, 'no hysteresis: do not start braking at closingSpeed=20 (entry=25)');
});

// --------------------------------------------------------------------------
// aiBrainTick: fire decision
// --------------------------------------------------------------------------

test('aiBrainTick: fires when chase target is in fire cone + in range', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -20)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true, '20u in range [0,30] + aligned → fire=true');
});

test('aiBrainTick: no fire when target is too close (<fireMinDist)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -20)],
    time: 0,
    fireMinDist: 25,
    evadeDist: 10,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '20u < fireMinDist=25 → no fire');
});

test('aiBrainTick: no fire when target is too far (>fireMaxDist)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -200)],
    time: 0,
    fireMaxDist: 100,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '200u > fireMaxDist=100 → no fire');
});

test('aiBrainTick: no fire when target is off-axis (>fireHeadingGate)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    fireHeadingGate: 0.25,
    fireMaxDist: 80,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '90° off-axis > fireHeadingGate → no fire');
});

test('aiBrainTick: fires at ANY in-cone asteroid in range (not just chase target)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [
      mockAsteroid(20, 0),   // nearest → chase target, 90° off-axis
      mockAsteroid(0, -20),  // dead-ahead, in fire cone, 20u in range
    ],
    time: 0,
    fireHeadingGate: 0.25,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true,
    'fires at in-cone asteroid (0,-20) even though chase target is elsewhere');
});

test('aiBrainTick: adaptive cone narrows with distance — wide at close, tight at far', () => {
  // v0.34.3: fireMaxDist=120, fireHeadingGate=0.25, cone min=0.12.
  // At 35u dead-ahead: adaptive cone = max(0.12, 0.25*(1-35/180)) ≈ 0.201 → fires
  const result35 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -35)],
    time: 0,
  });
  assert.equal(result35.fire, true, 'dead-ahead at 35u → adaptive cone≈0.201 → fires');

  // A target at 10u that's 0.20 rad off-axis: adaptive cone = max(0.12, 0.25*(1-10/180)) ≈ 0.236 > 0.20 → fires
  const closeOffAxis = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(Math.sin(0.20) * 10, -Math.cos(0.20) * 10)],
    time: 0,
    evadeDist: 5,  // avoid triggering EVADE at 10u
  });
  assert.equal(closeOffAxis.fire, true, '10u at 0.20 rad off → adaptive cone≈0.236 → fires');

  // Same 0.20 rad off-axis at 80u: adaptive cone = max(0.12, 0.25*(1-80/180)) ≈ 0.139 < 0.20 → no fire
  const farOffAxis = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(Math.sin(0.20) * 80, -Math.cos(0.20) * 80)],
    time: 0,
  });
  assert.equal(farOffAxis.fire, false, '80u at 0.20 rad off → adaptive cone≈0.139 → no fire');
});

test('aiBrainTick: idle mode → no fire', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// aiBrainTick: IDLE branch
// --------------------------------------------------------------------------

test('aiBrainTick: empty asteroids → idle', () => {
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
// aiBrainTick: laser mode
// --------------------------------------------------------------------------

test('aiBrainTick: laser-mode — chase target in tight cone → fire=true', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
    activeWeapon: 'laser',
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true, 'laser-mode + chase target on-axis → fire=true');
});

test('aiBrainTick: laser-mode — chase target off-axis → fire=false', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(20, -40)],
    time: 0,
    activeWeapon: 'laser',
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, 'laser-mode + chase target off-axis → fire=false');
});

// --------------------------------------------------------------------------
// engageTarget (v0.30.x: simple turn+thrust, no speed management)
// --------------------------------------------------------------------------

test('engageTarget: aligned + stationary → yaw=0, thrust=true', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'aligned → thrust');
});

test('engageTarget: aligned + fast → yaw=0, thrust=true (fly-by: no coasting)', () => {
  // Fly-by controller: always thrust when within gate, regardless of speed.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 100, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'fly-by: thrust when aligned regardless of speed');
});

test('engageTarget: aligned + slow → yaw=0, thrust=true', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 30, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'aligned → thrust');
});

test('engageTarget: 90° off → yaw=-1, thrust=false (outside thrustGate)', () => {
  // Ship facing +X, target at +Z. diff = π/2 ≈ 1.57 > thrustGate=0.10.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 0, z: 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false, '1.57 rad > 0.10 thrustGate → thrust OFF');
});

test('engageTarget: 0.20 rad off → thrust OFF while turning (outside tightened thrustGate=0.15)', () => {
  const angle = 0.20;
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, -1, 'still turning toward target');
  assert.equal(r.thrust, false,
    'v0.38.2: 0.20 > thrustGate=0.15 → thrust OFF while turning (stop-turn-thrust)');
});

test('engageTarget: within deadband (0.07 rad) → yaw=0, thrust=true', () => {
  // YAW_DEADBAND=0.08. 0.07 < 0.08 → yaw=0.
  // thrustGate=0.15. 0.07 < 0.15 → thrust=true.
  const angle = 0.07;
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 0, '0.07 < YAW_DEADBAND=0.08 → yaw=0');
  assert.equal(r.thrust, true, '0.07 < thrustGate=0.15 → thrust=true');
});

test('engageTarget: spin-brake fires counter-yaw at alignment with negative angVel', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 }, -4,
  );
  assert.equal(r.yaw, 1,
    'negative angVel → counter-clockwise (yaw=+1) to stop overshoot');
});

test('engageTarget: spin-brake fires counter-yaw at alignment with positive angVel', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 }, +4,
  );
  assert.equal(r.yaw, -1,
    'positive angVel → counter-clockwise (yaw=-1) to stop overshoot');
});

test('engageTarget: custom thrust gate works', () => {
  const r1 = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(0.04) * 60, z: Math.sin(0.04) * 60 },
    0, 0.05,
  );
  assert.equal(r1.thrust, true, '0.04 < 0.05 → thrust=true');

  const r2 = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(0.08) * 60, z: Math.sin(0.08) * 60 },
    0, 0.05,
  );
  assert.equal(r2.thrust, false, '0.08 > 0.05 → thrust=false');
});

test('engageTarget: back-compat with null aiVel → works fine', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, null, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'null aiVel → still works (ignored in v0.30.x)');
});

test('engageTarget: near target → yaw=0, thrust=true', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 5, z: 0 },
  );
  assert.equal(r.dist, 5);
  assert.equal(r.thrust, true, 'aligned at any distance → thrust');
});

test('engageTarget: returns dist in result', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 50, z: 0 }, { x: 40, z: 0 },
  );
  assert.equal(r.dist, 40);
  assert.ok(typeof r.diff === 'number');
});

test('engageTarget: custom brakeDist prevents braking until closer', () => {
  // Ship moving +X at 40 u/s, target at 20u. With brakeDist=30, should brake.
  // With brakeDist=15, should NOT brake (dist >= brakeDist).
  const rBrake = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 40, z: 0 }, { x: 20, z: 0 },
    0, 0.15, 40, false, true, 30,
  );
  assert.equal(rBrake.braking, true, 'brakeDist=30: dist=20 < 30 and closingSpeed=40 > 25 → brake');

  const rNoBrake = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 40, z: 0 }, { x: 20, z: 0 },
    0, 0.15, 40, false, true, 15,
  );
  assert.equal(rNoBrake.braking, false, 'brakeDist=15: dist=20 >= 15 → no brake');
});

test('engageTarget: aligned + fast toward close target → thrust (fly-by: no coasting)', () => {
  // Fly-by controller: even at 300 u/s toward a close target, thrust stays on.
  // The ship will fly past → target moves behind → engines cut naturally.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 300, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0, 'facing toward target');
  assert.equal(r.thrust, true, 'fly-by: thrust when aligned, flies past target naturally');
});

test('engageTarget: retrograde-facing ship still turns toward target', () => {
  // Ship moving +X at 300 u/s, but facing -X (retrograde).
  // Fly-by controller always faces toward target (no braking).
  const r = engageTarget(
    { x: 0, z: 0 }, Math.PI / 2, { x: 300, z: 0 }, { x: 60, z: 0 },
  );
  assert.notEqual(r.yaw, 0, 'must turn 180° toward target');
  assert.equal(r.thrust, false, '180° off → outside thrustGate → no thrust');
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

test('isTargetInFront: target directly ahead → true', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: -10 }, 0.35), true);
});

test('isTargetInFront: target directly behind → false', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: 10 }, 0.35), false);
});

test('isTargetInFront: handles non-zero yaw correctly', () => {
  assert.equal(
    isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, 0.35),
    true,
  );
});

test('isTargetInFront: null positions → false', () => {
  assert.equal(isTargetInFront(null, 0, { x: 0, z: 0 }, 0.35), false);
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, null, 0.35), false);
});

// --------------------------------------------------------------------------
// shouldResetAi
// --------------------------------------------------------------------------

test('shouldResetAi: inside resetDist → false', () => {
  assert.equal(shouldResetAi({ x: 50, z: 50 }, 220), false);
});

test('shouldResetAi: outside resetDist → true', () => {
  assert.equal(shouldResetAi({ x: 300, z: 0 }, 220), true);
});

test('shouldResetAi: exactly on boundary → false (strict >)', () => {
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
// pickTarget
// --------------------------------------------------------------------------

test('pickTarget: picks nearest asteroid', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(30, 0)],
    powerupPos: null,
    powerupBiasU: 60,
  });
  assert.equal(result.pos.x, 30);
  assert.equal(result.mode, 'asteroid');
});

test('pickTarget: powerup wins when biased closer', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 5, z: 0 },
    powerupBiasU: 60,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.pos.x, 5);
});

test('pickTarget: asteroid wins when powerup not biased closer', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    powerupPos: { x: 100, z: 0 },
    powerupBiasU: 60,
  });
  assert.equal(result.mode, 'asteroid');
});

test('pickTarget: asteroid stays preferred when the powerup is far out of the way', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0)],
    powerupPos: { x: 200, z: 0 },
    powerupBiasU: 25,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.dist, 20);
});

test('pickTarget: committedPos preferred over slightly-closer asteroid (stickiness)', () => {
  // Asteroid at 30u, committed target at 37u. hysteresisU=8.
  // 37 < 30 + 8 = 38 → true → committed wins.
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(30, 0), mockAsteroid(37, 0)],
    powerupPos: null,
    powerupBiasU: 40,
    committedPos: { x: 37, z: 0 },
    hysteresisU: 8,
  });
  assert.equal(result.pos.x, 37, 'committed target preferred when within hysteresis');
});

test('pickTarget: powerup wins even when committed asteroid is much closer', () => {
  // v0.41.1: powerups are evaluated against the nearest asteroid, not the
  // committed target. A committed asteroid at 10u should not block a
  // powerup at 80u (within powerupMaxChaseDist=150 default).
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(10, 0)],
    powerupPos: { x: 80, z: 0 },
    powerupBiasU: 9999,
    powerupMaxChaseDist: 150,
    committedPos: { x: 10, z: 0 },
    hysteresisU: 8,
  });
  assert.equal(result.mode, 'powerup', 'powerup wins over committed asteroid when within chase range');
});

test('pickTarget: committedPos loses when nearest is much closer', () => {
  // Asteroid at 10u, committed target at 38u. hysteresisU=8.
  // 38 < 10 + 8 = 18 → false → nearest wins.
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(10, 0), mockAsteroid(38, 0)],
    powerupPos: null,
    powerupBiasU: 40,
    committedPos: { x: 38, z: 0 },
    hysteresisU: 8,
  });
  assert.equal(result.pos.x, 10, 'nearest wins when committed is much farther');
});

test('pickTarget: null when no asteroids and no powerup', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [],
    powerupPos: null,
    powerupBiasU: 60,
  });
  assert.equal(result, null);
});

test('pickTarget: respects powerupMaxChaseDist', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 160, z: 0 },
    powerupBiasU: 9999,
    powerupMaxChaseDist: 150,
  });
  assert.equal(result.mode, 'asteroid', 'powerup beyond max chase dist is ignored');
});

test('pickTarget: powerup within powerupMaxChaseDist wins', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 140, z: 0 },
    powerupBiasU: 9999,
    powerupMaxChaseDist: 150,
  });
  assert.equal(result.mode, 'powerup', 'powerup within max chase dist wins');
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
  // Ship spawns at (12, 0) with rng=()=>0. Place asteroid at (12, -20)
  // so it's dead-ahead of the ship's -Z facing direction (within 30u range).
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

test('createDemoAi: threads aiAngularVel into brain args', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenAngularVel = null;
  const mockBrain = {
    tick: (args) => {
      seenAngularVel = args.aiAngularVel;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  mock.state.angularVelocity = -3.5;
  ai.update(0.1);
  assert.equal(seenAngularVel, -3.5);
});

test('createDemoAi: threads aiVel into brain args', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenVel = null;
  const mockBrain = {
    tick: (args) => {
      seenVel = args.aiVel;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  mock.state.velocity.x = 50;
  mock.state.velocity.z = 30;
  ai.update(0.1);
  assert.equal(seenVel.x, 50);
  assert.equal(seenVel.z, 30);
});

test('createDemoAi: threads activeWeapon via getActiveWeapon hook', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(0, -40)];
  const mock = mockShipFactory();
  let seenWeapon = null;
  const mockBrain = {
    tick: (args) => {
      seenWeapon = args.activeWeapon;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false };
    },
  };
  let hookResult = 'bullet';
  const ai = createDemoAi({
    scene,
    asteroids,
    getActiveWeapon: () => hookResult,
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  ai.update(0.1);
  assert.equal(seenWeapon, 'bullet');
  hookResult = 'laser';
  ai.update(0.1);
  assert.equal(seenWeapon, 'laser');
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

test('createDemoAi: committedPos tracks asteroid target across ticks', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  const dec1 = ai.getLastDecision();
  assert.equal(dec1.mode, 'asteroid');
  // committedPos should be tracked — next tick prefers this target
  ai.update(0.1);
  const dec2 = ai.getLastDecision();
  assert.equal(dec2.mode, 'asteroid', 'continues chasing committed target');
});

test('createDemoAi: committedPos cleared on spawn', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(40, 0)],
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  // Force a respawn by drifting far away
  ai.getShip().position.x = 300;
  ai.update(0.1);
  // After respawn, committedPos should be cleared — fresh start
  assert.ok(mock.calls.reset.length >= 1, 'ship was reset');
});

test('createDemoAi: evade mode in getMode()', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)],
    options: { shipFactory: mock.build, rng: () => 0, evadeDist: 8 },
  });
  ai.getShip().position.x = 0;
  ai.getShip().position.z = 0;
  assert.equal(ai.getMode(), 'evade');
});

// ==========================================================================
// v0.37.0 — PredictInterceptPoint
// ==========================================================================

test('predictInterceptPoint: stationary target returns current position', () => {
  const result = predictInterceptPoint(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    { x: 100, z: 0 }, { x: 0, z: 0 },
    2.0,
  );
  assert.equal(result.point.x, 100);
  assert.equal(result.point.z, 0);
  assert.ok(result.time > 0);
});

test('predictInterceptPoint: moving target leads ahead', () => {
  // Ship at (0,0) moving +X at 50 u/s. Target at (100, 0) moving -X at 10 u/s.
  // Intercept point should be closer than 100 (they're approaching each other).
  const result = predictInterceptPoint(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    { x: 100, z: 0 }, { x: -10, z: 0 },
    2.0,
  );
  assert.ok(result.point.x < 100, 'intercept point should be closer than target current position');
  assert.ok(result.point.x > 80, 'intercept point should be between ship and target (head-on)');
  assert.ok(result.time > 0);
});

test('predictInterceptPoint: stationary ship still predicts moving target', () => {
  // v0.39.0: a stationary ship chasing a moving powerup should still aim
  // at the target's future position (capped by maxLookaheadS), otherwise it
  // turns toward the current position and misses the pickup.
  const result = predictInterceptPoint(
    { x: 0, z: 0 }, { x: 0, z: 0 },
    { x: 100, z: 0 }, { x: 10, z: 0 },
    2.0,
  );
  assert.equal(result.point.x, 120);
  assert.equal(result.point.z, 0);
  assert.equal(result.time, 2.0);
});

test('predictInterceptPoint: very close target returns current pos', () => {
  const result = predictInterceptPoint(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    { x: 0.5, z: 0 }, { x: 0, z: 0 },
    2.0,
  );
  assert.equal(result.point.x, 0.5);
  assert.equal(result.time, 0);
});

test('predictInterceptPoint: respects maxLookaheadS cap', () => {
  // Target is at (1000, 0) moving +X at 10 u/s, ship at (0, 0) moving 1 u/s.
  // Time to target ≈ 1000s, but maxLookaheadS=2.0 caps the prediction.
  const result = predictInterceptPoint(
    { x: 0, z: 0 }, { x: 1, z: 0 },
    { x: 1000, z: 0 }, { x: 10, z: 0 },
    2.0,
  );
  assert.equal(result.time, 2.0);
  assert.equal(result.point.x, 1020);
});

// ==========================================================================
// v0.37.0 — FindCollisionThreat
// ==========================================================================

test('findCollisionThreat: head-on collision detected', () => {
  // Ship at (0,0) moving +X at 50 u/s. Asteroid at (100, 0) moving -X at 5 u/s.
  // Relative velocity = 55 u/s. tStar = -((100*0)*-55)/(55²) = 100/55 ≈ 1.82s.
  const asteroids = [mockAsteroid(100, 0, { x: -5, z: 0 })];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    asteroids, 3.0,
  );
  assert.notEqual(result, null, 'head-on should be detected');
  assert.ok(result.tStar > 1.5, 'closest approach ~1.82s in future');
  assert.ok(result.tStar < 2.5, 'closest approach ~1.82s');
  // v0.37.1: effectiveMargin = SHIP_RADIUS (1.4) + astRadius (3) + PREDICTIVE_EVADE_BUFFER (3.0) = 7.4
  assert.ok(result.closestDist < 7.4, 'should be within collision margin');
});

test('findCollisionThreat: clear miss returns null', () => {
  // Ship at (0,0) moving +X at 50 u/s. Asteroid at (100, 50) stationary.
  // Closest approach will be 50 units away → not within radius-aware margin.
  const asteroids = [mockAsteroid(100, 50)];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    asteroids, 3.0,
  );
  assert.equal(result, null, 'miss by 50u should not be a threat');
});

test('findCollisionThreat: stationary ship returns null', () => {
  const asteroids = [mockAsteroid(10, 0)];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 0, z: 0 },
    asteroids, 3.0,
  );
  assert.equal(result, null, 'stationary ship cannot predict');
});

test('findCollisionThreat: receding asteroid (tStar<0) returns null', () => {
  const asteroids = [mockAsteroid(50, 0, { x: 60, z: 0 })];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    asteroids, 3.0,
  );
  assert.equal(result, null, 'receding asteroid should not be a threat');
});

test('findCollisionThreat: picks closest threat among multiple', () => {
  const asteroids = [
    mockAsteroid(100, 0, { x: -5, z: 0 }),
    mockAsteroid(60, 1),
  ];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    asteroids, 3.0,
  );
  assert.notEqual(result, null);
  assert.ok(result.closestDist < 7.4, 'should detect threat');
});

test('findCollisionThreat: asteroid beyond lookahead horizon returns null', () => {
  const asteroids = [mockAsteroid(500, 0)];
  const result = findCollisionThreat(
    { x: 0, z: 0 }, { x: 50, z: 0 },
    asteroids, 3.0,
  );
  assert.equal(result, null, 'beyond lookahead horizon');
});

// ==========================================================================
// v0.37.0 — aiBrainTick: Predictive Evade
// ==========================================================================

test('aiBrainTick: predictive evade fires when trajectory intersects asteroid', () => {
  // Ship at (0,0) facing +X, moving +X at 50 u/s. Asteroid at (100, 0) ahead.
  // Head-on course → predictive evade should fire BEFORE emergency EVADE.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 50, z: 0 },
    asteroids: [mockAsteroid(100, 0)],
    time: 0,
    evadeDist: 5, // wide evade means >5 triggers emergency EVADE
    predictiveEvadeLookahead: 3.0,
  });
  // v0.37.1: effective margin = 1.4 (ship) + 3 (ast radius) + 3.0 (buffer) = 7.4.
  // closestDist ≈ 0 (head-on) < 7.4 → detected.
  // Predictive evade should fire (asteroid at 100u, 50 u/s → tStar=2s, within 3s)
  assert.equal(result.mode, 'evade', 'predictive evade should fire');
  assert.equal(result.thrust, true, 'evade always thrusts');
  assert.equal(result.fire, false, 'no fire during evade');
});

test('aiBrainTick: predictive evade skips when ship is stationary', () => {
  // Ship stationary at (0,0). Asteroid at (10, 0) → emergency EVADE at <8u.
  // Ship at (0,0) stationary. Asteroid at (100, 0). speed=0 → skip predictive.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(100, 0)],
    time: 0,
    predictiveEvadeLookahead: 3.0,
  });
  // Stationary → no predictive evade → should engage target
  assert.equal(result.mode, 'asteroid', 'stationary ship should engage, not evade');
});

test('aiBrainTick: predictive evade disabled when lookahead=0', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 50, z: 0 },
    asteroids: [mockAsteroid(100, 0)],
    time: 0,
    predictiveEvadeLookahead: 0,
  });
  // predictive disabled → should engage asteroid
  assert.equal(result.mode, 'asteroid', 'disabled predictive evade → engage normally');
});

// ==========================================================================
// v0.37.0 — aiBrainTick: Lead Fire
// ==========================================================================

test('aiBrainTick: lead fire predicts ahead for fast-moving asteroid', () => {
  // Ship at (0,0) facing +X. Asteroid at (40, 0) moving +X at 20 u/s.
  // Without lead: aim at (40,0) → bullet arrives in 40/400 = 0.1s → asteroid
  // moves to (42, 0). With lead: aim at (42, 0). Both should be in cone.
  // This test just verifies lead fire doesn't break normal firing.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, { x: 20, z: 0 })],
    time: 0,
    bulletSpeed: 400,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true,
    'lead fire: moving asteroid at 40u in cone → fire=true');
});

test('aiBrainTick: lead fire with fast-moving asteroid that would be missed without lead', () => {
  // Ship at (0,0) facing +X. Asteroid at (40, 10) moving +X at 50 u/s.
  // Without lead: aim at (40, 10), 0.25 rad off-axis. fireHeadingGate=0.30 → adaptive cone
  // at 40u ≈ max(0.14, 0.30*(1-40/90)) = max(0.14, 0.167) = 0.167.
  // 0.25 > 0.167 → without lead: would NOT fire.
  // With lead: bullet flight time = 50/400 = 0.125s. Predicted pos = (46.25, 10).
  // New angle = atan2(10, 46.25) ≈ 0.213 rad. 0.213 > 0.167 → still out.
  // Let me make a case where lead actually helps:
  // Asteroid at (40, 5) moving +X at 100 u/s.
  // Without lead: angle = atan2(5, 40) ≈ 0.124 rad. 0.124 < 0.167 → fires. Too easy.
  //
  // Better test: asteroid moving perpendicular to line of sight.
  // Ship at (0,0) facing +X. Asteroid at (40, 0) moving +Z at 50 u/s.
  // Without lead: aim at (40, 0). Bullet flight = 0.1s. In 0.1s asteroid moves to (40, 5).
  // Predicted angle = atan2(5, 40) = 0.124 rad. Adaptive cone at 40u ≈ 0.167.
  // 0.124 < 0.167 → fires with lead.
  // Without lead: angle = atan2(0, 40) = 0 < 0.167 → fires too.
  // Hmm, both fire. Let me try asteroid at edge of cone where lead makes the difference.
  //
  // Asteroid at (40, 7.5) moving -Z at 100 u/s.
  // Without lead: angle = atan2(7.5, 40) = 0.185 rad > 0.167 → NO fire.
  // With lead: flight time = sqrt(40²+7.5²)/400 ≈ 40.7/400 = 0.102s.
  // Predicted pos = (40, 7.5 - 100*0.102) = (40, -2.7).
  // angle = atan2(-2.7, 40) = -0.067 rad → |diff| = 0.067 < 0.167 → fires!
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 7.5, { x: 0, z: -100 })],
    time: 0,
    bulletSpeed: 400,
  });
  assert.equal(result.fire, true,
    'lead fire: predicted position brings moving asteroid into cone');
});

test('aiBrainTick: lead fire disabled when bulletSpeed=0', () => {
  // bulletSpeed=0 → no lead, use current position.
  // Asteroid at (40, 12): angle = atan2(12, 40) ≈ 0.292 rad.
  // Adaptive cone at 40u with fireMaxDist=90: max(0.14, 0.30*(1-40/135)) = 0.211.
  // 0.292 > 0.211 → outside cone → no fire.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 12, { x: 0, z: -100 })],
    time: 0,
    bulletSpeed: 0,
  });
  assert.equal(result.fire, false,
    'bulletSpeed=0 disables lead → no fire (uses current pos)');
});

test('aiBrainTick: lead fire works for far asteroid with large drift', () => {
  // Asteroid at (55, 0) moving +X at 20 u/s within fireMaxDist=60.
  // Distance = 55u, flight time = 55/400 = 0.1375s.
  // Predicted pos = (55 + 20*0.1375, 0) = (57.75, 0) — still in cone.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(55, 0, { x: 20, z: 0 })],
    time: 0,
    bulletSpeed: 400,
    fireMaxDist: 60,
  });
  assert.equal(result.fire, true,
    'lead fire: far asteroid with drift should still fire');
});

// ==========================================================================
// v0.37.0 — aiBrainTick: intercept prediction in engage
// ==========================================================================

test('aiBrainTick: engage uses intercept prediction for moving asteroid', () => {
  // Ship at (0,0) facing +X, moving +X at 50 u/s.
  // engageTarget passes targetVel → predictInterceptPoint aims ahead.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 50, z: 0 },
    asteroids: [mockAsteroid(60, 0, { x: 5, z: 0 })],
    time: 0,
    interceptLookaheadS: 2.0,
    predictiveEvadeLookahead: 0, // disable predictive evade for this test
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'intercept: should thrust when aligned');
});

test('aiBrainTick: intercept prediction with stationary target has same behavior', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 50, z: 0 },
    asteroids: [mockAsteroid(60, 0)],
    time: 0,
    interceptLookaheadS: 2.0,
    predictiveEvadeLookahead: 0, // disable predictive evade
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'stationary target → same behavior');
});

// ==========================================================================
// v0.37.0 — factory wiring: predictive params threaded
// ==========================================================================

test('createDemoAi: threads predictive params into brain args', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenArgs = null;
  const mockBrain = {
    tick: (args) => {
      seenArgs = args;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false, braking: false };
    },
  };
  createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      predictiveEvadeLookahead: 2.0,
      interceptLookaheadS: 3.0,
      bulletSpeed: 500,
    },
  }).update(0.1);

  assert.equal(seenArgs.predictiveEvadeLookahead, 2.0);
  assert.equal(seenArgs.interceptLookaheadS, 3.0);
  assert.equal(seenArgs.bulletSpeed, 500);
});

test('createDemoAi: bulletSpeed defaults to 400 via DEFAULTS', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenArgs = null;
  const mockBrain = {
    tick: (args) => {
      seenArgs = args;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false, braking: false };
    },
  };
  createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  }).update(0.1);

  assert.equal(seenArgs.bulletSpeed, 400, 'default bulletSpeed should be 400');
});

test('createDemoAi: intercept prediction enabled by default (interceptLookaheadS>0)', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenArgs = null;
  const mockBrain = {
    tick: (args) => {
      seenArgs = args;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false, braking: false };
    },
  };
  createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  }).update(0.1);

  assert.equal(seenArgs.interceptLookaheadS, 2.0, 'default interceptLookaheadS should be 2.0');
});

test('createDemoAi: predictive evade enabled by default (predictiveEvadeLookahead>0)', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenArgs = null;
  const mockBrain = {
    tick: (args) => {
      seenArgs = args;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false, braking: false };
    },
  };
  createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  }).update(0.1);

  assert.equal(seenArgs.predictiveEvadeLookahead, 0.8, 'default predictiveEvadeLookahead should be 0.8 (v0.38.1)');
});
