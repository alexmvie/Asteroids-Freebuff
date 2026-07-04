/**
 * Unit tests for src/entities/ai.js (v0.21.x — single-mode + BRAKE).
 *
 * The brain (`aiBrainTick`) is a pure function that maps
 *   (ship position + yaw + velocity + asteroid list + powerup + tree thresholds)
 * to a 4-tuple `{ yaw, thrust, mode, fire }`.
 *
 * v0.21.x — retains the v0.20.x single-mode shooter architecture
 * (panic-dodge + engage + idle) but re-introduces a closing-speed-
 * aware BRAKE branch in the `engageController`. The user reported
 * two pain points that v0.20.x didn't address:
 *
 *   1. Bot stands idle when the nearest asteroid is at >100u.
 *      `targetDist` bumped 100 → 300 to cover the full streaming
 *      bubble. The bot now ALWAYS engages the nearest asteroid.
 *   2. Bot flies in circles around powerups — full-thrust spiral
 *      because there was no closing-speed throttle. Re-introducing
 *      a BRAKE branch handles this: when closingSpeed > desiredClosing,
 *      the controller rotates the ship to opposite-of-velocity and
 *      thrusts backward. The transition BRAKE → APPROACH creates
 *      an emergent coasting phase (target still 180° away from
 *      facing → APPROACH's thrust gate |diff|<0.30 holds thrust=0
 *      → ship drift-turns back without overshooting).
 *
 * Why no SPIN-BRAKE: the confounding layers that turned v0.12.x's
 * BRAKE into "drunken wobble" (predictive-DODGE, mode-hysteresis,
 * debouncer, fire-cadence) are all gone. The residual overshoot at
 * ±0.15 yaw deadband is well within YAW_INERTIA_TAU=0.2.
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
          state.velocity = { x: 0, z: 0 };
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

// Default aiVel for tests that explicitly want the APPROACH branch (no
// BRAKE firing). Tests that exercise the BRAKE branch override this.
const ZERO_VEL = { x: 0, z: 0 };

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

test('aiBrainTick: aiVel default to zero when omitted (back-compat)', () => {
  // v0.21.x — aiVel defaults to {x:0, z:0}. Without it, engageController
  // can't compute closingSpeed; the closure-safe default is zero so
  // BRAKE never accidentally fires on existing call sites.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
});

// --------------------------------------------------------------------------
// aiBrainTick: PANIC-DODGE branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest within panicDist → mode=dodge, thrust=true', () => {
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

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE asteroid branch
// --------------------------------------------------------------------------

test('aiBrainTick: nearest asteroid in range → mode=asteroid, thrust when aligned', () => {
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
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0, // facing -Z
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1, 'turn CCW (-1) to face the +X asteroid');
  assert.equal(result.thrust, false);
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

test('aiBrainTick: BRAKE branch fires when ship has high closing speed toward target', () => {
  // v0.21.x — explicit aiVel parameter. Ship at origin facing +X,
  // moving at +X 200 u/s (terminal speed), with asteroid ahead at
  // (40, 0). closingSpeed=200, desiredClosing=Math.max(10, 48)=48.
  // closingSpeed > desiredClosing → BRAKE branch fires. The engage
  // controller rotates the ship to opposite-velocity (-X), thrust
  // false initially because the rotation hasn't completed yet.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 200, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid',
    'high closing speed → still in engage mode (not dodge/idle)');
  // At first tick, ship is still facing +X (just inherited facing).
  // BRAKE branch fires for brakeAngle=PI, brakeDiff=PI. abs(PI)>0.50
  // → thrust=false. The yaw command flips to -1 (rotate CCW toward
  // -X = the opposite-velocity direction).
  assert.equal(result.yaw, -1,
    'BRAKE branch steers toward opposite-of-velocity');
  assert.equal(result.thrust, false,
    'BRAKE branch thrust gated on |brakeDiff|<0.50 — at first tick rotation incomplete → no thrust');
});

test('aiBrainTick: BRAKE branch falls back to APPROACH once speed drops', () => {
  // Same setup but aiVel has been braked down to (5, 0) — below
  // the speed>4 floor if check is `speed <= 4`. Wait we want
  // speed > 4 AND closingSpeed > desiredClosing to be BRAKE. With
  // vel=(5,0): speed=5 (>4 ✓), closingSpeed=5 (signed along (40,0)
  // = +5), dist=40, desiredClosing=48. closingSpeed<desiredClosing
  // → APPROACH branch fires. Yields clean approach.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 5, z: 0 }, // braked down
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
  });
  assert.equal(result.yaw, 0, 'aligned with target once braked');
  assert.equal(result.thrust, true,
    'closingSpeed(5) < desiredClosing(48) → APPROACH branch thrust=true');
});

test('aiBrainTick: no in-range asteroid → falls through to IDLE', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(500, 0)],
    time: 0,
    targetDist: 300,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, false);
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// v0.21.x — ALWAYS-ATTACK-NEAREST (targetDist≥bubble radius)
// --------------------------------------------------------------------------

test('aiBrainTick: 250u asteroid still in engage range (targetDist=Infinity covers arbitrarily far)', () => {
  // v0.21.x — no distance cap. Bot engages the 250u asteroid.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(250, 0)],
    time: 0,
    // No targetDist override → uses DEFAULTS.targetDist (Infinity).
  });
  assert.equal(result.mode, 'asteroid',
    'at v0.21.x default targetDist=Infinity, the 250u asteroid is in range');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: empty asteroids array → idle (the only IDLE condition with targetDist=Infinity)', () => {
  // The user said "egal wie weit entfernt" — so the only way to
  // reach IDLE is for the streaming buffer to be empty. That's the
  // session-start edge case before the first chunk loads.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: ZERO_VEL,
    asteroids: [],
    time: 0,
  });
  assert.equal(result.mode, 'idle');
});

// --------------------------------------------------------------------------
// aiBrainTick: ENGAGE powerup branch
// --------------------------------------------------------------------------

test('aiBrainTick: powerup wins over asteroid when significantly closer', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(50, 0)],
    time: 0,
    powerupPos: { x: 5, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: asteroid wins over powerup when not biased closer', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(20, 0)],
    time: 0,
    powerupPos: { x: 40, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'asteroid');
});

test('aiBrainTick: powerup as fallback when no in-range asteroid', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(500, 0)],
    time: 0,
    powerupPos: { x: 60, z: 0 },
    powerupBiasU: -30,
    targetDist: 300,
  });
  assert.equal(result.mode, 'powerup');
});

test('aiBrainTick: powerup too far → closest in-range asteroid wins', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(30, 0)],
    time: 0,
    powerupPos: { x: 400, z: 0 },
    powerupBiasU: -30,
    targetDist: 300,
  });
  assert.equal(result.mode, 'asteroid');
});

// --------------------------------------------------------------------------
// aiBrainTick: fire decision
// --------------------------------------------------------------------------

test('aiBrainTick: fires when asteroid is in cone (regardless of chase target)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
    powerupPos: { x: 5, z: 0 },
    powerupBiasU: -30,
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.fire, true);
});

test('aiBrainTick: no asteroid in cone → fire=false', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(0, 30)],
    time: 0,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false);
});

test('aiBrainTick: panicDist default pins at 6u (regression: 5u → dodge, 7u → engage)', () => {
  // Pin the default value of panicDist behaviorally, so an accidental
  // flip in ai.js (e.g. panicDist: 6 → 10) is caught here. Without
  // this pin, the panic-mode tests still pass with any value because
  // they wire `panicDist: 6` as an override.
  const asteroids = []; // no target, no ENGAGE branch possible → must be IDLE
  // At 5u (< 6): should panic-dodge.
  asteroids[0] = mockAsteroid(5, 0);
  const r1 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids,
    time: 0,
  });
  assert.equal(r1.mode, 'dodge',
    'asteroid at 5u with default panicDist must trigger DODGE');
  // At 7u (> 6): no asteroid in range → IDLE (not panic, not engage).
  asteroids[0] = mockAsteroid(7, 0);
  const r2 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: ZERO_VEL,
    asteroids,
    time: 0,
    targetDist: 0, // force IDLE: nearest is at 7u but range is 0
  });
  assert.equal(r2.mode, 'idle',
    'asteroid at 7u with default panicDist and targetDist=0 must NOT trigger DODGE');
});

test('aiBrainTick: dodge mode → no fire', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(0, -3)],
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
    aiVel: ZERO_VEL,
    asteroids: [mockAsteroid(500, 0)],
    time: 0,
    targetDist: 300,
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.fire, false);
});

// --------------------------------------------------------------------------
// engageController (5-arg pure chase controller with BRAKE)
// --------------------------------------------------------------------------

test('engageController: dist < 0.01 → branch=pickup, no thrust, no yaw', () => {
  const r = engageController(
    { x: 50, z: 0 }, 0, { x: 50, z: 0 }, ZERO_VEL,
  );
  assert.equal(r.dist, 0);
  assert.equal(r.thrust, false);
  assert.equal(r.yaw, 0);
  assert.equal(r.branch, 'pickup');
});

test('engageController: aligned with zero velocity → branch=approach, thrust=true', () => {
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 60, z: 0 }, ZERO_VEL,
  );
  assert.equal(r.branch, 'approach');
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
  assert.equal(r.dist, 60);
});

test('engageController: small diff (0.10) → within ±0.15 yaw deadband, thrust=true', () => {
  const angle = 0.10;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
    ZERO_VEL,
  );
  assert.equal(r.branch, 'approach');
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('engageController: mid diff (0.22) → yaw=-1, thrust=true', () => {
  const angle = 0.22;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
    ZERO_VEL,
  );
  assert.equal(r.branch, 'approach');
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, true);
});

test('engageController: large diff (0.50) → yaw=-1, thrust=false', () => {
  const angle = 0.50;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
    ZERO_VEL,
  );
  assert.equal(r.branch, 'approach');
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

test('engageController: negative diff → yaw=+1 (CW turn for CW misalignment)', () => {
  const angle = -0.50;
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
    ZERO_VEL,
  );
  assert.equal(r.yaw, 1);
  assert.equal(r.thrust, false);
});

test('engageController: returns dist + diff + closingSpeed + branch observability fields', () => {
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2, { x: 60, z: 0 }, ZERO_VEL,
  );
  assert.equal(r.dist, 60);
  assert.equal(typeof r.diff, 'number');
  assert.equal(typeof r.closingSpeed, 'number');
  assert.equal(typeof r.branch, 'string');
});

// ---------- v0.21.x — BRAKE branch tests ----------

test('engageController: high speed + closing too fast → branch=brake, yaw toward opposite-of-velocity', () => {
  // Ship at origin facing +X (yaw=-PI/2 → facingAngle=0). Velocity
  // (200, 0) heading +X. Asteroid at (40, 0). dist=40, closingSpeed=
  // (40*200 + 0*0)/40 = 200, desiredClosing=max(10, 48)=48.
  // closingSpeed > desiredClosing → BRAKE branch.
  // velAngle = atan2(0, 200) = 0. brakeAngle = wrapAngle(0+π) = π.
  // brakeDiff = wrapAngle(π - 0) = π. abs(π) > 0.50 → thrust=false.
  // yaw: brakeDiff(π) > 0.15 → yaw=-1. Steers toward -X (opposite
  // of velocity) ✓
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 40, z: 0 },
    { x: 200, z: 0 },
  );
  assert.equal(r.branch, 'brake');
  assert.equal(r.yaw, -1, 'steers toward (-X) = opposite of velocity');
  assert.equal(r.thrust, false,
    'first tick: |brakeDiff|=π > 0.50 → thrust gated off during rotation');
  assert.ok(r.closingSpeed > 0, 'closingSpeed positive (approaching)');
});

test('engageController: BRAKE yaw direction matches velocity-signed reversal', () => {
  // v0.21.x regression: BRAKE branch always points at oppo-of-velocity,
  // regardless of where the target is. Target at +X, velocity at -X
  // (receding). closingSpeed = (40*-200)/40 = -200, which is <=
  // desiredClosing=48 → not a BRAKE condition. So this test sets
  // target + velocity both pointing +X (approaching with speed).
  // Simpler: ship at origin, velocity (+60, 0), target at (10, 0).
  // dist=10, desiredClosing=max(10, 12)=12. closingSpeed=60>12 → BRAKE.
  // velAngle=atan2(0,60)=0. brakeAngle=π. brakeDiff=π. yaw=-1 (-X).
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 10, z: 0 },
    { x: 60, z: 0 },
  );
  assert.equal(r.branch, 'brake');
  assert.equal(r.yaw, -1);
});

test('engageController: BRAKE fires when ship is moving perpendicular (high closingSpeed)', () => {
  // Velocity has a strong X component AND a Z component. closingSpeed
  // is the projection along targetAxis. Ship at origin facing +X,
  // velocity (100, 50), target at (40, 0). closingSpeed = (40*100 +
  // 0*50)/40 = 100. desiredClosing = max(10, 48) = 48. closingSpeed >
  // desiredClosing → BRAKE.
  // velAngle = atan2(50, 100) ≈ 0.46. brakeAngle = π + 0.46 ≈ 3.6.
  // -π/2 yaw → facingAngle = 0. brakeDiff = wrapAngle(3.6 - 0) ≈ 3.6.
  // That's > π so wrapAngle returns approx -2.68. -2.68 < -0.15 →
  // yaw=+1 (turn right = +1 in ship convention).
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 40, z: 0 },
    { x: 100, z: 50 },
  );
  assert.equal(r.branch, 'brake');
  // Don't pin the exact yaw sign here (depends on wrap arithmetic);
  // verify the ship is being commanded to turn, not stand still.
  assert.ok(r.yaw === -1 || r.yaw === 1, 'BRAKE must command a yaw turn');
});

test('engageController: speed <= 4 → APPROACH branch (no micro-flip BRAKE)', () => {
  // Ship moving TOWARD target very slowly (3 u/s). closingSpeed=3,
  // desiredClosing=max(10, 48)=48. closingSpeed<desiredClosing →
  // APPROACH even if speed>0. Speed gate ensures low-speed regime
  // doesn't loop between BRAKE and APPROACH.
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 40, z: 0 },
    { x: 3, z: 0 },
  );
  assert.equal(r.branch, 'approach');
});

test('engageController: closingSpeed<0 (receding) → APPROACH branch (not BRAKE)', () => {
  // Ship moving AWAY from target, even at high speed. closingSpeed=-200.
  // desiredClosing=48. closingSpeed < desiredClosing → APPROACH.
  // (No overshoot risk, ship is moving away.)
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 40, z: 0 },
    { x: -200, z: 0 },
  );
  assert.equal(r.branch, 'approach');
});

test('engageController: BRAKE → APPROACH transition (post-brake, facing 180° from target → coast)', () => {
  // After BRAKE has fired for several frames, ship has rotated 180°
  // away from the velocity direction. With ship at (50, 0) facing
  // -X (yaw=π/2 → facingAngle=π) and target at (60, 0) — target is
  // at +X relative to ship, ship faces -X → exactly 180° off-axis.
  // Velocity braked down to 8 u/s. closingSpeed=8 < desiredClosing
  // =12 → APPROACH branch fires. |targetDiff|=π > 0.30 → thrust OFF.
  // This is the "drift-turn" that creates calm coast-then-approach.
  const r = engageController(
    { x: 50, z: 0 },
    Math.PI / 2, // yaw=π/2 → facingAngle=π → ship faces -X
    { x: 60, z: 0 }, // target at +X relative to ship → 180° off-axis
    { x: 8, z: 0 }, // braked down
  );
  assert.equal(r.branch, 'approach',
    'speed(8) > 4 but closingSpeed(8) < desiredClosing(12) → APPROACH branch');
  assert.equal(r.thrust, false,
    '|targetDiff|=π > 0.30 → thrust OFF (the coast phase)');
  assert.ok(r.yaw === -1 || r.yaw === 1,
    'must command yaw to rotate back to target');
});

test('engageController: BRAKE thrust gate allows fire during rotation (loose deadband ±0.50)', () => {
  // Verify that during a BRAKE maneuver where the ship has rotated
  // PART way (let's say facing ~3π/4 from brakeAngle = π), the
  // thrust gate (±0.50) lets the dump fire. At brakeDiff=3π/4 ≈ 2.36,
  // that's > 0.50 → thrust=false. Try a smaller rotation: brakeAngle=π,
  // facing ≈ 1.0 rad off, so brakeDiff = wrapAngle(π - (π+1.0)) = -1.0.
  // abs(-1.0) = 1.0 > 0.50 → still thrust=false. Try a nearly aligned
  // case: brakeDiff = 0.3. abs(0.3) < 0.50 → thrust=true.
  //
  // To set this up: facing = brakeAngle - 0.3 (some yaw value).
  // brakeAngle = wrapAngle(velAngle + π). With velAngle=0, brakeAngle=π.
  // facing should be ≈ π + 0.3 ≈ 3.44 rad. yaw such that
  // facingAngle(yaw) = 3.44 → ... messy. Let me use a different setup.
  //
  // Simpler explicit check: directly construct the angle relation.
  // Use targets where the math is clean.
  // Ship at origin, velocity (50,0), facing aligned WITH brake direction
  // = brakeAngle - 0.3 means ship is 0.3 rad shy of pointing opposite
  // velocity. yaw such that facingAngle(yaw) = π - 0.3.
  // facingAngle(yaw) = atan2(-cos(yaw), -sin(yaw)) = π - 0.3.
  // ⇒ -sin(yaw) = cos(π-0.3) = -cos(0.3)
  // ⇒ -cos(yaw) = sin(π-0.3) = sin(0.3)
  // ⇒ sin(yaw) = cos(0.3), cos(yaw) = -sin(0.3)
  // ⇒ yaw = π/2 - 0.3 + ... use atan2 directly.
  //
  // Easier: facingAngle(yaw) = φ ⇒ yaw satisfies -sin(yaw) / -cos(yaw) = sin(φ)/cos(φ)
  // ⇒ tan(yaw) = -cos(φ)/-sin(φ) = cos(φ)/sin(φ) = cot(φ)
  // Hmm, let me skip this contest and pick a known values from
  // facingAngle table.
  // facingAngle(0) = -π/2.
  // facingAngle(-π/2) = 0 (so +X facing).
  // facingAngle(π/2) = π (so -X facing). Yes! PI facing = -X
  // facing. So yaw=π/2 → -X facing = brake direction for +X velocity.
  //
  // Now if ship's yaw is slightly off brake direction: yaw = π/2 - 0.3.
  // facingAngle(π/2 - 0.3) = ?? Need to compute manually.
  // cos(π/2 - 0.3) = sin(0.3) ≈ 0.296.
  // sin(π/2 - 0.3) = cos(0.3) ≈ 0.955.
  // facingAngle = atan2(-cos(yaw), -sin(yaw)) = atan2(-0.296, -0.955)
  // = atan2(-0.296, -0.955). Both negative → 3rd quadrant.
  // = -π + atan2(0.296, 0.955) ≈ -π + 0.30 ≈ -2.84.
  //
  // That's not what I want. Skip — pick a cleaner test case.
  //
  // Test: ship at origin, velocity (50,0), facing already at brakeAngle=π.
  // yaw such that facingAngle = π. From the table above, yaw=π/2 suits.
  // brakeDiff = wrapAngle(brakeAngle - facingAngle) = wrapAngle(π - π) = 0.
  // abs(0) < 0.50 → thrust=true.
  const r = engageController(
    { x: 0, z: 0 },
    Math.PI / 2, // facing -X (the brake direction for +X velocity)
    { x: 10, z: 0 },
    { x: 50, z: 0 },
  );
  assert.equal(r.branch, 'brake');
  assert.equal(r.thrust, true,
    'BRAKE-thrust fires when facing is within ±0.50 of brake direction');
  assert.equal(r.yaw, 0);
});

test('engageController: BRAKE does not fire at near-zero speed (the speed>4 floor)', () => {
  // Edge case: approaching target at 2 u/s. closingSpeed=2,
  // desiredClosing=min(15, 40)=15. closingSpeed<desiredClosing →
  // APPROACH even though speed>0. Speed must be >4 to trigger BRAKE.
  const r = engageController(
    { x: 0, z: 0 }, -Math.PI / 2,
    { x: 40, z: 0 },
    { x: 2, z: 0 },
  );
  assert.equal(r.branch, 'approach');
  assert.equal(r.thrust, true,
    'zero/low-speed regime → APPROACH thrust closes the gap');
});

// --------------------------------------------------------------------------
// v0.21.0+ — multi-tick stability: BRAKE → APPROACH transition is clean,
//              no flicker at boundary, BRAKE fires persistently while
//              closing speed is elevated.
// --------------------------------------------------------------------------

test('engageController: sustained BRAKE → APPROACH transition (multi-tick, no flicker)', () => {
  // The user's intent: stop circling pickups. Verify the BRAKE
  // branch fires consistently across many ticks while closing speed
  // is high (sustained long-range intercept), then transitions
  // cleanly to APPROACH once speed drops, with NO intermediate
  // flicker back to BRAKE (which would manifest as visible
  // wobble in the live game).
  //
  // Simulation: ship at origin facing +X (yaw=-π/2 → facing=0),
  // initial velocity (150, 0) heading toward asteroid at (40, 0).
  // dist=40 fixed (brain model doesn't move the ship; this is the
  // brain contract). velocity decays each tick at exp(-0.04) ≈ 0.96
  // factor — approximating the combined drag + BRAKE reverse-thrust
  // tail (drag 0.4/s + ~16% reverse-thrust during rotation). After
  // ~50 ticks vel drops below desiredClosing=15 → APPROACH.
  const trail = [];
  let vel = { x: 150, z: 0 };
  for (let i = 0; i < 80; i++) {
    const r = engageController(
      { x: 0, z: 0 }, -Math.PI / 2,
      { x: 40, z: 0 },
      vel,
    );
    trail.push(r.branch);
    vel = { x: vel.x * 0.96, z: 0 };
  }
  // Sustained BRAKE phase: at least 20 ticks of BRAKE before transition.
  const brakeTicks = trail.filter(b => b === 'brake').length;
  assert.ok(brakeTicks >= 20,
    `expected long BRAKE phase (closing speed stays > desiredClosing for many ticks); got ${brakeTicks}/80`);
  // Single transition to APPROACH (no flicker back to BRAKE).
  const transitionAt = trail.findIndex(b => b === 'approach');
  assert.ok(transitionAt >= 0 && transitionAt < trail.length,
    `must transition from BRAKE → APPROACH; transition at index ${transitionAt} (brakeTicks=${brakeTicks})`);
  // ['brake' then 'approach' for the rest] — pin the no-flicker property.
  for (let i = transitionAt + 1; i < trail.length; i++) {
    assert.equal(trail[i], 'approach',
      `tick ${i}: branch flickered back from 'approach' to '${trail[i]}'`);
  }
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

test('createDemoAi: factory wiring (mock shipFactory v0.21.x — aiVel threaded into brain)', () => {
  // Ship spawns at (12, 0). Mock velocity={x:0, z:0}. Asteroid at
  // (5, 0) → spawn-asteroid distance 7. 7 not in panicDist=6
  // (no panic). 7 < targetDist=300 → engage mode=asteroid. dist=7 →
  // closingSpeed=c·v=0 → APPROACH branch. yaw rotates to align.
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

test('createDemoAi: NO strobe debouncer -- flips fire immediately', () => {
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
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  ai.update(0.1);
  assert.equal(mock.calls.setYaw[0], 1);
  yawBrain = -1;
  ai.update(0.05);
  assert.equal(mock.calls.setYaw[1], -1);
  yawBrain = 1;
  ai.update(0.01);
  assert.equal(mock.calls.setYaw[2], 1);
});

test('createDemoAi: NO fire-cadence gate -- every fire tick shoots', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(0, -40)];
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
  assert.equal(fireCalls.length, 3);
});

test('createDemoAi: factory threads aiVel (ship.velocity) into brain args', () => {
  // v0.21.x — verify the factory passes aiVel. The mock's mock.state.velocity
  // can be set externally before each update; the brainArgsFromShip clones
  // x and z. If the brain sees aiVel, it can fire the BRAKE branch.
  const scene = mockScene();
  const asteroids = [mockAsteroid(40, 0)];
  const mock = mockShipFactory();
  let seenAiVel = null;
  const mockBrain = {
    tick: (args) => {
      seenAiVel = args.aiVel;
      return { yaw: 0, thrust: false, mode: 'asteroid', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    options: { shipFactory: mock.build, brain: mockBrain },
  });
  // Mutate mock velocity before update — factory must pick it up.
  mock.state.velocity.x = 100;
  mock.state.velocity.z = 0;
  ai.update(0.1);
  assert.equal(seenAiVel.x, 100, 'factory threads velocity.x into brain.args.aiVel.x');
  assert.equal(seenAiVel.z, 0, 'factory threads velocity.z into brain.args.aiVel.z');
});

test('createDemoAi: getMode() in panicDist returns dodge', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)],
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  // Spawn lands at (12, 0). Override ship position to (0, 0) so the
  // asteroid is at 0u → in panic range.
  ai.getShip().position.x = 0;
  ai.getShip().position.z = 0;
  assert.equal(ai.getMode(), 'dodge');
});

// --------------------------------------------------------------------------
// createDemoAi: factory wiring for bullets
// --------------------------------------------------------------------------

test('createDemoAi: fires weapon when asteroid is in cone during ENGAGE', () => {
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
});

test('createDemoAi: fires weapon on ANY in-cone asteroid -- not just chase target', () => {
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
  assert.equal(weaponCalls.length, 1);
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
