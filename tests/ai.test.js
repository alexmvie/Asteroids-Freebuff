/**
 * Unit tests for src/entities/ai.js (v0.28.x — speed-aware controller).
 *
 * The brain (`aiBrainTick`) is a pure function that maps
 *   (ship position + yaw + velocity + angular velocity + asteroid list + powerup)
 * to a 4-tuple `{ yaw, thrust, mode, fire }`.
 *
 * Three modes: EVADE (nearest within evadeDist) → ENGAGE (speed-managed
 * approach with active braking) → IDLE (no targets).
 *
 * `engageTarget` is now velocity-aware: it manages approach speed
 * proportionally to distance, actively brakes when going too fast,
 * and allows simultaneous turn+thrust (no yaw===0 guard).
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
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.thrust, true);
  assert.ok(result.yaw === -1 || result.yaw === 1);
  assert.equal(result.fire, false);
});

test('aiBrainTick: evade steers ~90° perpendicular from threat', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    time: 0,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.notEqual(result.yaw, 0, 'must turn to escape');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: dodge mode → no fire', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -3)],
    time: 0,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.fire, false);
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

test('aiBrainTick: nearest asteroid in range → mode=asteroid, thrust when aligned and need speed', () => {
  // Ship at origin, facing -X toward asteroid at +X (40u away).
  // dist=40 → desiredClosing = min(150, max(8, 40*1.5)) = 60 u/s.
  // aiVel=(0,0) → closingSpeed=0 < desiredClosing=60 → thrust=true when aligned.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: ENGAGE turn toward asteroid when misaligned', () => {
  // Ship facing -Z (yaw=0), asteroid at +X (90° off).
  // Still turns, but may thrust if within thrustGate (0.60).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0, // facing -Z
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'turn to face the +X asteroid');
  // At 90° off-axis, |targetDiff| ≈ π/2 ≈ 1.57 > thrustGate=0.60 → thrust OFF.
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

test('aiBrainTick: simultaneous turn+thrust when within thrustGate (no yaw===0 guard)', () => {
  // Ship facing -Z (yaw=0), target slightly off-axis at 0.3 rad (~17°).
  // 0.3 < thrustGate=0.60 → thrust while still turning.
  const targetX = Math.sin(0.3) * 40;
  const targetZ = -Math.cos(0.3) * 40;
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(targetX, targetZ)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, true, 'within thrustGate → simultaneous turn+thrust');
});

test('aiBrainTick: thrust ON when aligned + need speed (yaw===0, within thrust gate)', () => {
  // Ship facing -Z, target at -Z (aligned). dist=40 → desiredClosing=60.
  // closingSpeed=0 < 60 → thrust=true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0, 'aligned → no turning');
  assert.equal(result.thrust, true, 'aligned + need speed → thrust ON');
});

// --------------------------------------------------------------------------
// aiBrainTick: speed management (no thrust when already fast enough)
// --------------------------------------------------------------------------

test('aiBrainTick: thrust OFF when closing speed already meets desired', () => {
  // Ship at origin, facing +X toward target at (40, 0). dist=40 → desiredClosing=60.
  // Ship already moving at 80 u/s toward target → closingSpeed=80 > 60 → no thrust.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    aiVel: { x: 80, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0, 'aligned → no turning');
  assert.equal(result.thrust, false,
    'closingSpeed=80 > desiredClosing=60 → thrust OFF (drag will slow)');
});

test('aiBrainTick: thrust ON when closing speed is below desired', () => {
  // Ship at origin facing +X toward target at (40, 0). dist=40 → desiredClosing=60.
  // Ship moving at 20 u/s toward target → closingSpeed=20 < 60 → thrust.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 20, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true,
    'closingSpeed=20 < desiredClosing=60 → thrust ON');
});

test('aiBrainTick: close target → low desiredClosing → likely no thrust', () => {
  // Ship at origin facing +X toward target at (4, 0). dist=4 → desiredClosing = max(8, 4*1.5=6) = 8.
  // evadeDist=2 so we stay in ENGAGE mode.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(4, 0)],
    time: 0,
    evadeDist: 2,
  });
  assert.equal(result.mode, 'asteroid');
  // closingSpeed=0 < desiredClosing=8 → thrust=true
  assert.equal(result.thrust, true, 'closingSpeed=0 < desiredClosing=8 → thrust ON');
});

test('aiBrainTick: close target + already fast → no thrust', () => {
  // Ship facing +X toward target at (4, 0), moving at 30 u/s toward it.
  // dist=4 → desiredClosing=8. closingSpeed=30 > 8 → no thrust.
  // evadeDist=2 so we stay in ENGAGE mode.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 30, z: 0 },
    asteroids: [mockAsteroid(4, 0)],
    time: 0,
    evadeDist: 2,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.thrust, false,
    'closingSpeed=30 > desiredClosing=8 → thrust OFF (drag will slow)');
});

// --------------------------------------------------------------------------
// aiBrainTick: active braking
// --------------------------------------------------------------------------

test('aiBrainTick: active braking when total speed far exceeds desired closing', () => {
  // Ship at origin facing +X toward target at (40, 0). dist=40 → desiredClosing=60.
  // totalSpeed=200 > desiredClosing*3=180 AND closingSpeed=200 > 60 → BRAKE.
  // Ship faces retrograde (-X direction), which is opposite of facing (+X).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    aiVel: { x: 200, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  // Ship is facing +X, needs to face -X (retrograde). That's a 180° turn.
  // predictedDiff ≈ π → yaw=-1 or 1 to turn around.
  assert.notEqual(result.yaw, 0, 'must turn to face retrograde');
  assert.equal(result.thrust, false,
    '180° from retrograde (>0.60 rad) → thrust OFF during turn');
});

test('aiBrainTick: no brake when speed is below threshold', () => {
  // totalSpeed=100, desiredClosing=60, 100 < 60*3=180 → no brake.
  // Ship keeps approaching normally.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 100, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  // closingSpeed=100 > desiredClosing=60 → thrust OFF (drag slows)
  assert.equal(result.thrust, false);
});

test('aiBrainTick: no brake when closing is already slow even if total fast', () => {
  // Ship moving fast but perpendicular to target. totalSpeed=200 but closingSpeed≈0.
  // 200 > 60*3=180 but closingSpeed=0 NOT > desiredClosing=60 → no brake.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X, toward target
    aiVel: { x: 0, z: 200 }, // moving perpendicular, not closing
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  // closingSpeed=0 < desiredClosing=60 → wants thrust
  assert.equal(result.thrust, true, 'perpendicular velocity → still need closing speed');
});

test('aiBrainTick: overshoot (negative closingSpeed) → thrust toward target', () => {
  // Ship at origin, target at (10, 0). Ship moving away at 50 u/s (past the target).
  // dist=10 → desiredClosing = max(8, 10*1.5=15) = 15.
  // closingSpeed = (-10*50 + 0*0) / 10 = -50 (moving away).
  // totalSpeed=50, desiredClosing*3=45. 50>45 but closingSpeed=-50 NOT > 15 → no brake.
  // closingSpeed=-50 < desiredClosing=15 → approach branch: thrust toward target.
  // evadeDist=2 so we stay in ENGAGE mode.
  const result = aiBrainTick({
    aiPos: { x: 10, z: 0 },
    aiYaw: Math.PI / 2, // facing -X (back toward target at origin)
    aiVel: { x: 50, z: 0 }, // moving +X, away from origin target
    asteroids: [mockAsteroid(0, 0)], // target at origin
    time: 0,
    evadeDist: 2,
  });
  assert.equal(result.mode, 'asteroid');
  // Ship faces -X (toward target), which is also retrograde (moving +X, retrograde = -X).
  // yaw should be 0 (already facing the right way).
  assert.equal(result.yaw, 0, 'facing target = retrograde → yaw=0');
  assert.equal(result.thrust, true,
    'closingSpeed=-50 < desiredClosing=15 → thrust ON toward target');
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
// aiBrainTick: fire decision
// --------------------------------------------------------------------------

test('aiBrainTick: fires when chase target is in fire cone + in range', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true, '40u in range + aligned → fire=true');
});

test('aiBrainTick: no fire when target is too close (<fireMinDist)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -20)],
    time: 0,
    fireMinDist: 25,
    evadeDist: 12,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '20u < fireMinDist=25 → no fire');
});

test('aiBrainTick: no fire when target is too far (>fireMaxDist)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, -150)],
    time: 0,
    fireMaxDist: 100,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '150u > fireMaxDist=100 → no fire');
});

test('aiBrainTick: no fire when target is off-axis (>fireHeadingGate)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    fireHeadingGate: 0.20,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false, '90° off-axis > fireHeadingGate=0.20 → no fire');
});

test('aiBrainTick: fires at ANY in-cone asteroid in range (not just chase target)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [
      mockAsteroid(20, 0),   // nearest → chase target, 90° off-axis
      mockAsteroid(0, -40),  // dead-ahead, in fire cone, 40u in range
    ],
    time: 0,
    fireHeadingGate: 0.20,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true,
    'fires at in-cone asteroid (0,-40) even though chase target is elsewhere');
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
// engageTarget (velocity-aware, speed-managed)
// --------------------------------------------------------------------------

test('engageTarget: aligned + stationary → yaw=0, thrust=true (need speed)', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'closingSpeed=0 < desiredClosing → thrust');
});

test('engageTarget: aligned + fast enough → yaw=0, thrust=false', () => {
  // dist=60, desiredClosing = clamp(60*1.5, 8, 150) = 90.
  // closingSpeed=100 > 90 → no thrust.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 100, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, false, 'closingSpeed=100 > desiredClosing=90 → no thrust');
});

test('engageTarget: aligned + need more speed → yaw=0, thrust=true', () => {
  // dist=60, desiredClosing=90. closingSpeed=30 < 90 → thrust.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 30, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('engageTarget: 90° off → yaw=-1, thrust=false (outside thrustGate)', () => {
  // Ship facing +X, target at +Z. diff = π/2 ≈ 1.57 > thrustGate=0.60.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 0, z: 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false, '1.57 rad > 0.60 thrustGate → thrust OFF');
});

test('engageTarget: simultaneous turn+thrust within thrustGate', () => {
  // Ship facing +X, target at ~0.30 rad off-axis. diff ≈ 0.30 < thrustGate=0.60.
  // yaw may be ±1 (turning) BUT thrust=true because diff < thrustGate.
  const angle = 0.30;
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  // predictedDiff ≈ 0.30 > YAW_DEADBAND=0.10 → yaw=-1 (turning toward target)
  assert.equal(r.yaw, -1, '0.30 rad off → turning toward target');
  assert.equal(r.thrust, true, '0.30 < 0.60 thrustGate → simultaneous turn+thrust');
});

test('engageTarget: small diff (0.08) within deadband → yaw=0, thrust=true', () => {
  const angle = 0.08;
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 0, '0.08 < YAW_DEADBAND → yaw=0');
  assert.equal(r.thrust, true, 'aligned + need speed → thrust=true');
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

test('engageTarget: active braking — faces retrograde when too fast', () => {
  // dist=60, desiredClosing=90. totalSpeed=300 > 90*3=270 AND closingSpeed=300 > 90.
  // → isBraking=true → faceAngle = opposite of velocity.
  // Ship facing +X toward target. Velocity=(300,0). Retrograde = (-1, 0) direction.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 300, z: 0 }, { x: 60, z: 0 },
  );
  // Ship faces +X. Retrograde is -X. That's a 180° turn.
  assert.notEqual(r.yaw, 0, 'must turn 180° to face retrograde');
  assert.equal(r.thrust, false, 'not yet facing retrograde → thrust OFF');
});

test('engageTarget: active braking — thrusts when facing retrograde', () => {
  // Ship moving +X at 300 u/s. Retrograde = -X direction.
  // Ship already facing -X (aiYaw=+π/2).
  // isBraking=true, faceAngle = atan2(0, -300) = π (which is -X direction).
  // facingAngle(+π/2) = atan2(-cos(...), -sin(...))... 

  // Let me compute: ship facing -X means yaw such that forward = (+1, 0, 0) in world.
  // ship.js: forward = (-sin(yaw), 0, -cos(yaw)).
  // To face +X: -sin(yaw)=1 → sin(yaw)=-1 → yaw=-π/2. That's the facing.
  // To face -X: -sin(yaw)=-1 → sin(yaw)=1 → yaw=+π/2.

  // aiYaw=+π/2 → facing = -X. aiVel=(300, 0) → retrograde = atan2(0, -300) = π.
  // faceAngle = π. facingAngle(+π/2) = ... let me compute: -sin(π/2)=-1, -cos(π/2)=0.
  // atan2(0, -1) = π. targetDiff = wrapAngle(π - π) = 0.
  // predictedDiff ≈ 0. yaw=0, thrust=true.
  const r = engageTarget(
    { x: 0, z: 0 }, Math.PI / 2, { x: 300, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0, 'facing retrograde → yaw=0');
  assert.equal(r.thrust, true, 'facing retrograde + braking → thrust=true');
});

test('engageTarget: no brake when total speed is below threshold', () => {
  // dist=60, desiredClosing=90. totalSpeed=100 < 90*3=270 → no brake.
  // closingSpeed=100 > desiredClosing=90 → thrust OFF (drag slows).
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 100, z: 0 }, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0, 'aligned → yaw=0');
  assert.equal(r.thrust, false, '100 > 90 → thrust OFF');
});

test('engageTarget: custom thrust gate works', () => {
  // yaw may be 0 (aligned within deadband). diff=0.04 < 0.05 gate → thrust=true.
  const r1 = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(0.04) * 60, z: Math.sin(0.04) * 60 },
    0, 0.05,
  );
  assert.equal(r1.thrust, true, 'yaw===0 + 0.04 < 0.05 → thrust=true');

  // diff=0.08 > 0.05 gate → thrust=false.
  const r2 = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 },
    { x: Math.cos(0.08) * 60, z: Math.sin(0.08) * 60 },
    0, 0.05,
  );
  assert.equal(r2.thrust, false, '0.08 > 0.05 → thrust=false');
});

test('engageTarget: back-compat with null aiVel → treats as zero velocity', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, null, { x: 60, z: 0 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true, 'null aiVel → treated as (0,0) → need speed → thrust');
});

test('engageTarget: near target → low desired closing', () => {
  // dist=5, desiredClosing = max(8, 5*1.5=7.5) = 8 u/s.
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 5, z: 0 },
  );
  assert.equal(r.dist, 5);
  // closingSpeed=0 < desiredClosing=8 → thrust=true
  assert.equal(r.thrust, true);
});

test('engageTarget: returns dist and closingSpeed in result', () => {
  const r = engageTarget(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 50, z: 0 }, { x: 40, z: 0 },
  );
  assert.equal(r.dist, 40);
  assert.ok(typeof r.closingSpeed === 'number');
  // closingSpeed = (40*50 + 0*0) / 40 = 50
  assert.ok(Math.abs(r.closingSpeed - 50) < 1e-9);
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

test('pickTarget: null when no asteroids and no powerup', () => {
  const result = pickTarget({
    aiPos: { x: 0, z: 0 },
    asteroids: [],
    powerupPos: null,
    powerupBiasU: 60,
  });
  assert.equal(result, null);
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
  // Ship spawns at (12, 0) with rng=()=>0. Place asteroid at (12, -40)
  // so it's dead-ahead of the ship's -Z facing direction.
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

test('createDemoAi: evade mode in getMode()', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)],
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.getShip().position.x = 0;
  ai.getShip().position.z = 0;
  assert.equal(ai.getMode(), 'evade');
});
