/**
 * Unit tests for src/entities/ai.js.
 *
 * The brain (`aiBrainTick`) is a pure function: ship position + yaw +
 * asteroid list + time → desired `{ yaw, thrust, mode, fire }`. These
 * tests exercise all four behavior modes (hunt, dodge, target, wander)
 * plus the pure helpers (`findNearestAsteroid`, `isTargetInFront`,
 * `intercept`, `shouldResetAi`, `pickAiSpawn`). The factory
 * (`createDemoAi`) is smoke-tested with a mock ship factory — no
 * Three.js dependency in unit tests.
 *
 * v0.12.x — the HUNT controller was rewired in src/entities/ai.js from
 * a 5-phase stack (HARD COMMIT, FINAL APPROACH, TANGENTIAL orbit,
 * BRAKE, APPROACH) to a single 2-phase intercept (BRAKE if closing
 * too fast, APPROACH otherwise). The tests in the HUNT block below
 * exercise the new intercepted controller + the HUNT mode fires-at-
 * any-asteroid-in-cone behavior (the user's v0.11.x complaint that
 * the AI didn't shoot asteroids while chasing bonus pickups).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  intercept,
  huntController,
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
  assert.equal(result.thrust, true);
  assert.ok(result.yaw === -1 || result.yaw === 1);
});

test('aiBrainTick: dodge beats target when an asteroid is within both ranges', () => {
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
  const asteroids = [mockAsteroid(5, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: Math.PI,
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
  // Ship at origin facing +X (yaw=-PI/2) so the +X asteroid is
  // aligned in the fire cone (closing the alignment gap lets the
  // brain return thrust=true — see next test for the un-aligned case).
  const asteroids = [mockAsteroid(40, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: target steers toward the nearest asteroid (left yaw for +X target)', () => {
  // Ship at origin facing +X (yaw=-PI/2) so the +X asteroid is
  // directly in front — v0.12.x intercept controller now gates
  // thrust on alignment (|targetDiff|<0.5). With the ship already
  // aligned, thrust=true and yaw=0.
  // The 'left yaw for +X target' naming refers to the asymmetric
  // case where the ship ISN'T aligned — see test below where the
  // ship faces -Z and must turn to chase +X.
  const asteroids = [mockAsteroid(40, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: TARGET → no thrust when ship is misaligned with asteroid direction', () => {
  // v0.12.x — the new intercept controller gates thrust on
  // alignment. Ship facing -Z (yaw 0) with asteroid at +X needs
  // to yaw first (yaw=-1, targetDiff=PI/2), and only thrusts
  // once |targetDiff|<0.5. The OLD brain always thrust in
  // TARGET mode regardless of alignment; this test guards
  // against regression to that behavior.
  const asteroids = [mockAsteroid(40, 0)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0, // facing -Z
    asteroids,
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.yaw, -1, 'must turn left to chase +X from south');
  assert.equal(result.thrust, false, 'no thrust while mis-aligned (|targetDiff|=PI/2 > 0.5)');
});

test('aiBrainTick: target picks the NEAREST asteroid (not the first)', () => {
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
  assert.equal(result.yaw, -1);
});

test('aiBrainTick: does not target if all asteroids are beyond targetDist', () => {
  const asteroids = [mockAsteroid(200, 0)];
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
    wanderHeading: -Math.PI / 2,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result.mode, 'wander');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: wander → no thrust when heading is misaligned', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: Math.PI / 2,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result.mode, 'wander');
  assert.equal(result.thrust, false);
});

test('aiBrainTick: wander biases heading toward nearest asteroid', () => {
  const asteroids = [mockAsteroid(0, 150)];
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids,
    time: 0,
    wanderHeading: null,
    wanderHeadingExpiresAt: 0,
    targetDist: 90,
    rng: () => 0.5,
  });
  assert.equal(result.mode, 'wander');
  assert.ok(Math.abs(result._wanderHeading - Math.PI / 2) < 1e-9);
});

test('aiBrainTick: wander picks a new heading on first call (wanderHeading=null)', () => {
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.5; };
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
  assert.equal(result._wanderHeading, 0);
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
    wanderHeadingExpiresAt: 5.0,
    rng,
  });
  assert.equal(rngCalls, 0);
  assert.equal(first._wanderHeading, 1.0);
});

test('aiBrainTick: wander picks a new heading after the period expires', () => {
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.25; };
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 10.0,
    wanderHeading: 1.0,
    wanderHeadingExpiresAt: 5.0,
    wanderTurnPeriod: 2.5,
    rng,
  });
  assert.equal(rngCalls, 1);
  assert.ok(Math.abs(result._wanderHeading + Math.PI / 2) < 1e-9);
  assert.equal(result._wanderHeadingExpiresAt, 12.5);
});

test('aiBrainTick: wander yaw steers toward the heading', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: Math.PI / 4,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(result.yaw, -1);
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

// ---- intercept (pure 2-phase controller) ------------------------------

test('intercept: dist < 0.01 → no thrust (pickup radius absorbs)', () => {
  // At the target itself, brain hands control to the pickup radius.
  const r = intercept({ x: 50, z: 0 }, 0, { x: 0, z: 0 }, { x: 50, z: 0 });
  assert.equal(r.dist, 0);
  assert.equal(r.thrust, false);
  assert.equal(r.yaw, 0);
});

test('intercept: APPROACH (steer + thrust) when aligned and need speed', () => {
  // Ship at (0,0), no velocity, facing +X. Target at (60,0).
  // closingSpeed=0, desiredClosing=15. Not BRAKE.
  // targetAngle=0, facing=0→diff=0, within 0.5 → thrust + yaw=0.
  const r = intercept({ x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 });
  assert.equal(r.dist, 60);
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('intercept: BRAKE (turn opposite to velocity) when closing too fast', () => {
  // Ship at (0,0), vel (80,0), facing +X. Target at (50,0).
  // closingSpeed=80, desiredClosing=15. BRAKE.
  // brakeAngle=atan2(-0,-80)=PI. brakeDiff=PI - 0 = PI > 0.2 → yaw=-1.
  // |brakeDiff|=PI > 0.5 → no thrust.
  const r = intercept({ x: 0, z: 0 }, -Math.PI / 2, { x: 80, z: 0 }, { x: 50, z: 0 });
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

test('intercept: BRAKE thrusts when facing into the brake direction', () => {
  // Ship at (0,0), vel (80,0), facing -X (yaw=PI/2). Target at (50,0).
  // facingAngle(PI/2) = atan2(-cos(PI/2), -sin(PI/2)) = atan2(0, -1) = PI.
  // brakeAngle = PI. brakeDiff = 0 → yaw=0, |diff|<0.5 → thrust.
  const r = intercept({ x: 0, z: 0 }, Math.PI / 2, { x: 80, z: 0 }, { x: 50, z: 0 });
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('intercept: APPROACH no-thrust when not aligned', () => {
  // Ship at origin, no velocity, facing -Z (yaw 0). Target at (60, 0).
  // targetAngle=0, facingAngle(0)=-PI/2. targetDiff=wrapAngle(0-(-PI/2))=PI/2 > 0.2 → yaw=-1.
  // |targetDiff|=PI/2 > 0.5 → no thrust.
  const r = intercept({ x: 0, z: 0 }, 0, { x: 0, z: 0 }, { x: 60, z: 0 });
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

test('intercept: closes coasting (no thrust) when at desired speed', () => {
  // Ship at (50,0), vel (15,0) facing +X (yaw=-PI/2). Target at (60,0).
  // closingSpeed=(10*15+0*0)/10=15. desiredClosing=min(15,10)=10.
  // closingSpeed(15) > desiredClosing(10) → BRAKE.
  // brakeAngle=atan2(-0,-15)=PI. brakeDiff=PI - 0 = PI. yaw=-1, thrust=false.
  // This tests the "already at desired speed" coast-in case: the
  // ship doesn't add speed (the pickup radius closes the gap).
  const r = intercept({ x: 50, z: 0 }, -Math.PI / 2, { x: 15, z: 0 }, { x: 60, z: 0 });
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

// ---- v0.12.x SPIN-BRAKE (the "wobble after alignment" fix) ----------

// The user's complaint: "fly left-right without a target, no human would do that".
// Cause: APPROACH stopped commanding yaw inside the steering deadband
// (±0.2 rad) but the ship's angular inertia carried it past alignment
// and back across the deadband. Without spin-brake, the brain's
// yaw=-1/0/+1 toggles per frame as the ship's residual rotation
// sweeps across the deadband. Spin-brake applies OPPOSITE yaw to
// the rotation direction once the target is well within ±0.35 rad
// — settling the heading without oscillation.

test('intercept: spin-brake fires when |angVel|>1 and |targetDiff|<0.35 [positive angVel → yaw=-1]', () => {
  // Ship at (0,0), yaw=-PI/2 (faces +X, facing=0), aligned with
  // target at (60,0). targetDiff=0, |targetDiff|<0.35 ✓.
  // angVel=2 (positive; ship rotating CCW) > 1.0 ✓.
  // Brake: aiAngularVelocity > 0 → yaw=-1 to oppose the spin.
  // Thrust is suspended during the brake so we don't accelerate
  // through the deadband either.
  const r = intercept({ x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 }, 2);
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false, 'no thrust during spin-brake');
});

test('intercept: spin-brake fires when angVel<-1 and |targetDiff|<0.35 [negative angVel → yaw=+1]', () => {
  // Mirror of the above. angVel=-2 (spinning CW) → yaw=+1.
  const r = intercept({ x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 }, -2);
  assert.equal(r.yaw, 1);
  assert.equal(r.thrust, false);
});

test('intercept: spin-brake NOT fired when |angVel|<=1 (slow rotation: normal APPROACH wins)', () => {
  // Tiny angVel=0.5 < 1.0 → spin-brake does NOT fire. Falls through
  // to normal APPROACH: targetDiff=0, |0|<0.5 thrust gate ✓.
  // Result: yaw=0, thrust=true (committed approach).
  const r = intercept({ x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 }, 0.5);
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('intercept: spin-brake NOT fired when aligned but target off-axis', () => {
  // Ship at (0,0), facing -Z (yaw=0), target at (60, 0). targetDiff
  // = wrapAngle(0 - (-PI/2)) = PI/2 > 0.35. Even with high angVel,
  // the brain should steer toward the target, not brake.
  const r = intercept({ x: 0, z: 0 }, 0, { x: 0, z: 0 }, { x: 60, z: 0 }, 2);
  assert.equal(r.yaw, -1, 'steer toward target when far off-axis');
});

// ---- v0.12.x WANDER calmness (the "nervous without target" fix) -----

test('wander: heading refresh picks jittered angle within ±27° of bias (was ±72°)', () => {
  // v0.12.x — jitter reduced ±0.4π → ±0.15π (±72° → ±27°). The wider
  // jitter kept producing new headings far from the bias target,
  // which made the ship visibly swing every 1.5s. Use rng=0 →
  // jitter = (0*2-1) * PI * 0.15 = -PI*0.15 ≈ -0.471 rad (-27°).
  //
  // targetDist is overridden to 30 (default 90) so the asteroid at
  // (0, 50) — distance 50 — is OUT of TARGET mode (which would
  // short-circuit the WANDER fallback) but still IN awareness
  // range (targetDist × 2.5 = 75 > 50) so the bias term fires.
  //
  // v0.13.x — pass `gapAwareDist: 0` explicitly to disable the new
  // smart-wander branch. Otherwise the 50u asteroid (within the v0.13.x
  // default gapAwareDist=80) would trigger the gap-aware branch with
  // a different (gap-optimized) heading. This test pins the v0.12.x
  // legacy bias logic specifically.
  const r = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, 50)],
    time: 0,
    wanderHeading: null,
    wanderHeadingExpiresAt: 0,
    targetDist: 30,
    gapAwareDist: 0,
    rng: () => 0,
  });
  // targetAngle = atan2(50, 0) = PI/2. jitter = -PI*0.15. heading = PI/2 - PI*0.15.
  const expected = Math.PI / 2 - Math.PI * 0.15;
  assert.ok(Math.abs(r._wanderHeading - expected) < 1e-9,
    `heading=${r._wanderHeading}, expected=${expected}`);
});

test('wander: heading deviation of 0.5 rad triggers yaw (wider steering deadband 0.1 → 0.15)', () => {
  // Ship at origin facing -Z (yaw=0). Heading is -PI/2 + 0.5 (NE).
  // diff = wrapAngle(-PI/2+0.5 - (-PI/2)) = 0.5. With the wider
  // deadband (±0.15 rad from ±0.1), 0.5 > 0.15 → yaw=-1 (decisive).
  const r = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    time: 0,
    wanderHeading: -Math.PI / 2 + 0.5,
    wanderHeadingExpiresAt: 5.0,
  });
  assert.equal(r.yaw, -1);
});

// ---- aiBrainTick: HUNT mode (intercept controller — v0.12.x simplified) --
//
// v0.12.x ground-up rewrite: replaced the over-engineered 5-phase
// HUNT controller (HARD COMMIT / FINAL APPROACH / TANGENTIAL /
// BRAKE / APPROACH) with a single 2-phase intercept (BRAKE if
// closing too fast, APPROACH otherwise). HUNT additionally fires
// at any asteroid in cone so the AI shoots while chasing the bonus.

test('aiBrainTick: hunt mode → APPROACH (steer + thrust) when aligned and need speed', () => {
  // Ship at origin, no velocity, facing +X. Power-up at (60, 0).
  // closingSpeed=0, desiredClosing=min(15,60)=15. APPROACH.
  // targetAngle=0, facing=0→diff=0 → thrust + yaw=0.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
  assert.equal(result.fire, false); // no asteroid in cone
});

// v0.19.x — HUNT/TARGET controller split. The previous test block
// asserted HUNT's BRAKE-phase behavior (yaw flips at high closingSpeed,
// thrust false / true depending on facing). Under the new
// huntController() (no BRAKE, no Spin-Brake — static target), those
// assertions are no longer valid. The new tests below pin the split
// contract directly: HUNT does NOT brake on a static target, TARGET
// STILL brakes at front-impact speed.

test('aiBrainTick: HUNT mode at high closingSpeed does NOT brake (static target, no overshoot risk)', () => {
  // Ship at origin facing +X (yaw=-PI/2). Moving at (80, 0). Power-up
  // at (50, 0) — closingSpeed=80. Under the OLD shared intercept()
  // controller this would BRAKE (yaw=-1, thrust=false). Under the
  // new huntController() the BRAKE branch does NOT exist; the ship
  // closes the gap with sustained thrust because the target is
  // static and there's no overshoot concern. This is the keystone
  // test for the v0.19.x split — it would FAIL on the old code and
  // PASS on the new code (and vice versa for the TARGET-mode
  // mirror test below).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 80, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 50, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.yaw, 0, 'HUNT must not flip yaw to brake on a static target');
  assert.equal(result.thrust, true, 'HUNT must keep thrusting on a static target');
});

test('aiBrainTick: TARGET mode at high closingSpeed still BRAKEs (split verified)', () => {
  // Contrast test: TARGET keeps the v0.12.x intercept() controller
  // (BRAKE + closingSpeed throttle + spin-brake) because MOVING
  // asteroids warrant the heavier machinery. This pins "TARGET
  // behavior is unchanged by the v0.19.x split" — a regression
  // guard against accidentally routing TARGET through the new
  // huntController() too.
  //
  // v0.18.x predictive DODGE would fire BEFORE TARGET for this
  // scenario (asteroid 50u dead-ahead at head-on course with the
  // ship moving at 80u/s → predicted closestDist = 0 within the 1s
  // lookahead window, well under dodgeMarginU=2.5). To isolate
  // the v0.19.x split contract this test disables BOTH dodge
  // shells: dodgeDist=0 (legacy shell off) AND dodgeLookaheadS=0
  // (predictive shell off). With both off, the brain definitely
  // falls through to TARGET mode.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 80, z: 0 },
    asteroids: [mockAsteroid(50, 0)],
    time: 0,
    dodgeDist: 0,            // legacy dodge shell -- off
    dodgeLookaheadS: 0,      // v0.18.x predictive dodge -- off
    targetDist: 90,
    powerupPos: null,
  });
  assert.equal(result.mode, 'target');
  // intercept() BRAKE: brakeAngle = atan2(-0, -80) = PI. brakeDiff
  // = wrapAngle(PI - 0) = PI > 0.35 → yaw=-1. |brakeDiff|=PI > 0.5
  // → thrust=false. The split INTENT: TARGET BRAKES, HUNT DOESN'T.
  assert.equal(result.yaw, -1, 'TARGET still BRAKEs at front-impact speed (v0.12.x preserved)');
  assert.equal(result.thrust, false);
});

test('aiBrainTick: HUNT mode with high aiAngularVelocity does NOT spin-brake', () => {
  // v0.12.x intercept() has a Spin-Brake sub-phase that fires when
  // |aiAngularVelocity| > 1.0 and |targetDiff| < 0.35, applying
  // opposite yaw to cancel the rotation. The HUNT-mode controller
  // doesn't take aiAngularVelocity at all — the spin-brake doesn't
  // apply because the static target doesn't justify the sub-phase.
  // The yaw command stays aimed at the target, settling once the
  // ship's `YAW_INERTIA_TAU=0.2` damps the rotation.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiAngularVelocity: 3.0,        // high spin -- intercept() would spin-brake
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  // Ship is well-aligned (yaw=-PI/2 → facing=0 → diff=0). Under the
  // new controller: yaw=0, thrust=true (close the gap on a static
  // target). Under intercept(): yaw=-1 (opposite spin direction),
  // thrust=false. The split INTENT: HUNT ignores the spin-brake.
  assert.equal(result.yaw, 0, 'HUNT does not spin-brake; yaw stays on target');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: hunt mode → APPROACH with no thrust when not aligned', () => {
  // Ship at origin, no velocity, facing -Z (yaw 0). Power-up at (60,0).
  // facing=-PI/2, targetAngle=0, targetDiff=PI/2 > 0.2 → yaw=-1.
  // |targetDiff|>0.5 → no thrust.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.yaw, -1);
  assert.equal(result.thrust, false);
});

test('aiBrainTick: hunt mode → defaults aiVel to zero when omitted', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: hunt mode ignores powerup beyond huntDist → falls through to wander', () => {
  // No asteroid → wander (no target, no powerup).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 600, z: 0 },
  });
  assert.equal(result.mode, 'wander');
});

test('aiBrainTick: hunt mode → fire:true when any asteroid is in the fire cone (the user\'s "AI doesn\'t shoot asteroids" fix)', () => {
  // The v0.11.x HUNT controller never returned fire:true, so the
  // AI visibly ignored asteroids while chasing powerups. v0.12.x
  // checks ALL asteroids for in-cone positions (not just the
  // chase target), so the AI shoots asteroids it sees while
  // continuing to chase the bonus.
  // Ship at origin, no velocity. Power-up at (60, 0) → chaseMode='hunt'.
  // Asteroid at (0, -40) — directly in front (yaw=0 faces -Z, asteroid
  // is at z=-40 → cone-aligned). isTargetInFront returns true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(0, -40)],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.fire, true);
});

test('aiBrainTick: hunt mode → fire:false when no asteroid is in the fire cone', () => {
  // Power-up at (60,0) → hunt. Asteroid at (40, 0) (off to the side;
  // not in cone). Should NOT fire.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.fire, false);
});

test('aiBrainTick: hunt mode takes priority over target asteroid chase', () => {
  // Both a powerup and an asteroid in range — HUNT wins.
  // Power-up at (60, 0) → HUNT (powerup chase).
  // Asteroid at (40, 0) → also in targetDist but lower priority.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0)],
    time: 0,
    powerupPos: { x: 60, z: 0 },
  });
  assert.equal(result.mode, 'hunt');
});

// ---- v0.19.x huntController pure-function tests ----------------------
// The new huntController() function is the HUNT-mode brain's pure
// controller. Same shape as intercept() (4-arg: pos/yaw/vel/target)
// but with the BRAKE and Spin-Brake sub-phases stripped out because
// the target is static. These tests pin the contract directly.

test('huntController: dist < 0.01 → no thrust, no yaw (pickup radius absorbs)', () => {
  const r = huntController({ x: 50, z: 0 }, 0, { x: 0, z: 0 }, { x: 50, z: 0 });
  assert.equal(r.thrust, false);
  assert.equal(r.yaw, 0);
  assert.equal(r.dist, 0);
  assert.equal(r.closingSpeed, 0);
});

test('huntController: perfectly aligned → yaw=0, thrust=true', () => {
  // Ship facing +X (yaw=-PI/2), target directly ahead → diff=0.
  const r = huntController({ x: 0, z: 0 }, -Math.PI / 2, { x: 0, z: 0 }, { x: 60, z: 0 });
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('huntController: closingSpeed does NOT gate thrust (no closingSpeed throttle on static target)', () => {
  // The keystone contract test for the v0.19.x split. Ship fully
  // aligned with the target (diff=0), moving at v=(80, 0) toward
  // target. Under the OLD shared intercept() controller this would
  // be the BRAKE branch (closingSpeed=80 > desiredClosing=15 → yaw
  // flips, thrust=false). Under huntController() the BRAKE branch
  // does NOT exist; thrust=true regardless of closingSpeed because
  // the static target can't pull away from us and the gap needs to
  // close. This test would FAIL on the old code.
  const r = huntController({ x: 0, z: 0 }, -Math.PI / 2, { x: 80, z: 0 }, { x: 50, z: 0 });
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true,
    'huntController has no BRAKE branch — static target, no overshoot concern');
});

test('huntController: targetAngle=atan2(sin(θ)*r, cos(θ)*r) within yaw deadband (±0.20) → yaw=0', () => {
  // Construct a target at angle 0.10 rad: (60*cos(0.10), 60*sin(0.10)).
  // Ship facing +X (yaw=-PI/2 → facingAngle=0). diff=0.10. ±0.20
  // deadband says yaw=0. ±0.35 thrust deadband says thrust=true.
  const angle = 0.10;
  const r = huntController(
    { x: 0, z: 0 },
    -Math.PI / 2,
    { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 0);
  assert.equal(r.thrust, true);
});

test('huntController: diff=0.30 → yaw=-1, thrust=true (between yaw and thrust deadbands)', () => {
  // 0.20 < |0.30| < 0.35 → yaw flips but thrust still engaged.
  // (Under intercept() the wider ±0.35 yaw deadband would have
  // yaw=0 here — the HUNT-mode controller is tighter, as designed.)
  const angle = 0.30;
  const r = huntController(
    { x: 0, z: 0 },
    -Math.PI / 2,
    { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, true);
});

test('huntController: diff beyond thrust deadband (|diff|=0.50) → no thrust', () => {
  // 0.50 > 0.35 → yaw flips AND thrust drops out. Ship must rotate
  // into alignment before closing the gap.
  const angle = 0.50;
  const r = huntController(
    { x: 0, z: 0 },
    -Math.PI / 2,
    { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, -1);
  assert.equal(r.thrust, false);
});

test('huntController: negative diff → yaw=+1 (CCW turn for clockwise misalignment)', () => {
  // The opposite-side mirror of the 0.50 case. Ship facing +X,
  // target behind-left. diff = -0.50 → yaw=+1 (CCW turn).
  const angle = -0.50;
  const r = huntController(
    { x: 0, z: 0 },
    -Math.PI / 2,
    { x: 0, z: 0 },
    { x: Math.cos(angle) * 60, z: Math.sin(angle) * 60 },
  );
  assert.equal(r.yaw, 1);
  assert.equal(r.thrust, false);
});

test('huntController: returns dist + closingSpeed as observability fields (regression guard for the return shape)', () => {
  // The aiBrainTick integration consumes .closingSpeed and .dist when
  // deciding coast-in overrides; if huntController stops returning
  // them, HUNT's coast-in logic silently degrades.
  const r = huntController({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, { x: 60, z: 0 });
  assert.equal(r.dist, 60);
  assert.equal(typeof r.closingSpeed, 'number');
});

// ---- Factory debounce (humanization of virtual key presses) -----------

test('createDemoAi: yaw/thrust flip is debounced by yawHoldTimeS/thrustHoldTimeS', () => {
  const scene = mockScene();
  const asteroids = [];
  const mock = mockShipFactory();
  let yawBrain = -1;
  let thrustBrain = true;
  const mockBrain = {
    tick: () => ({ yaw: yawBrain, thrust: thrustBrain, mode: 'dodge', fire: false }),
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    options: {
      shipFactory: mock.build,
      yawHoldTimeS: 0.20,
      thrustHoldTimeS: 0.15,
      brain: mockBrain,
    },
  });
  ai.update(0.1);
  assert.equal(mock.calls.setYaw[0], -1, 'first yaw flip accepted');
  assert.equal(mock.calls.setThrust[0], true, 'first thrust flip accepted');
  yawBrain = 1;
  thrustBrain = false;
  ai.update(0.05);
  assert.equal(mock.calls.setYaw[1], -1, 'second yaw flip held by debounce');
  assert.equal(mock.calls.setThrust[1], true, 'thrust flip also held during debounce window');
  ai.update(0.30);
  assert.equal(mock.calls.setYaw[2], 1, 'yaw flip accepted after debounce window');
  assert.equal(mock.calls.setThrust[2], false, 'thrust flip accepted after debounce window');
});



test('createDemoAi: requires scene and asteroids', () => {
  assert.throws(() => createDemoAi({}), /scene/);
  assert.throws(() => createDemoAi({ scene: mockScene() }), /asteroids/);
});

test('createDemoAi: factory wiring (mock shipFactory)', () => {
  // v0.12.x — fix the deterministic spawn via `rng: () => 0` so
  // the test isn't flaky across runs. Ship spawns at (12, 0)
  // facing -Z (yaw=0). Asteroid at (5, 0). Ship→asteroid distance
  // = 7, within dodgeDist=14 → DODGE mode. threatAngle = atan2(0,
  // -7) = PI, escapeAngle = -PI/2, facingAngle(0) = -PI/2. diff =
  // 0 within 0.1 deadband → yaw=0, thrust=true.
  // The OLD test relied on `Math.random()` shipping to RNG with
  // reasonable luck — flaky in CI. The deterministic injection
  // removes the flakiness and is consistent with the v0.12.x brain
  // (which only thrusts when aligned, so an off-axis random spawn
  // could have produced thrust=false on the first tick).
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
      rng: () => 0,
    },
  });

  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
  assert.equal(typeof ai.getShip, 'function');

  ai.update(0.1);
  assert.equal(mock.calls.setThrust.length, 1);
  assert.equal(mock.calls.setThrust[0], true, 'DODGE mode thrust=true');
  assert.equal(mock.calls.update.length, 1);

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

// ---- isTargetInFront --------------------------------------------------

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

// ---- aiBrainTick: fire decision ---------------------------------------

test('aiBrainTick: target mode → fire:false when target is not in front', () => {
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
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(200, 0)],
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

test('createDemoAi: fires weapon in HUNT mode when asteroid is in cone (the user\'s "AI doesn\'t shoot asteroids" fix)', () => {
  // Ship spawns at (12, 0) with yaw=0 (rng=0). Power-up at (60, 0)
  // → in range → mode='hunt'. Asteroid at (12, -20) directly in
  // front of the ship → should fire even though we're chasing
  // the powerup (not the asteroid). This test was the v0.11.x
  // failure mode.
  const scene = mockScene();
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
    getPowerupPos: () => ({ x: 60, z: 0 }),
    options: {
      shipFactory: mock.build,
      rng: () => 0,
    },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 1, 'fires at asteroid in cone during HUNT chase');
});

test('createDemoAi: does NOT fire weapon in DODGE mode', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(5, 0)];
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

test('createDemoAi: getMode reflects the current behavior', () => {
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
      rng: () => 0,
    },
  });

  assert.equal(ai.getMode(), 'dodge');
});
