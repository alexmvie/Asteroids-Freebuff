/**
 * v0.13.x — Demo AI humanization regression tests.
 *
 * Covers the five new features that landed in src/entities/ai.js to
 * make the NPC ship feel less robotic. Each feature has a short block
 * of tests that pins its visible behavior:
 *
 *   1. Reaction latency (factory observation buffer) -- the brain
 *      reads the world state as it was ~250ms ago, not live.
 *   2. Fire cadence (factory gating) -- trigger respects a minimum
 *      interval (~300ms) between successful fires.
 *   3. Close-range coast-in (brain) -- HUNT thrust goes to false
 *      near the pickup so the ship doesn't ram past it.
 *   4. Smart-wander gap-awareness (brain) -- when nearby asteroids
 *      exist, the new heading avoids their angular sector.
 *   5. Mode-hysteresis (factory) -- downgrade within a short window
 *      reuses the cached prior decision.
 *
 * Follows the existing tests/ai.test.js conventions:
 *   - `node:test` runner
 *   - `assert` from `node:assert/strict`
 *   - one `test('description', ...)` per assertion block
 *   - mock ship/scene helpers reused inline
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  findNearestAsteroid,
  pickWanderHeading,
  predictPosition,
  lookupAsteroidVel,
  createDemoAi,
} from '../src/entities/ai.js';

// --------------------------------------------------------------------------
// Mock helpers (reused shape from tests/ai.test.js)
// --------------------------------------------------------------------------

function mockAsteroid(x, z, velX = 0, velZ = 0) {
  return {
    spec: { position: { x, y: 0, z } },
    getPosition: () => ({ x, y: 0, z }),
    getVelocity: () => ({ x: velX, z: velZ }),
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
        get angularVelocity() { return state.angularVelocity; },
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

// ==========================================================================
// 1. REACTION LATENCY (factory observation buffer)
// ==========================================================================

test('reaction latency: brain gets CURRENT snapshot on first tick (no history yet)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  let seenPos = null;
  const mockBrain = {
    tick: (args) => {
      seenPos = { ...args.aiPos };
      return { yaw: 0, thrust: false, mode: 'wander', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      reactionLatencyS: 0.25,
    },
  });
  // The ship mock holds a reference to state.position; mutation in
  // place is what the runtime sees (the ship can't see a fresh
  // object assigned to mock.state.position because that's just a
  // closure-var swap -- the ship object's .position still points at
  // the old object).
  mock.state.position.x = 50;
  mock.state.position.z = 0;
  ai.update(0.1);
  // First tick: buffer has 1 snapshot (time=0.1). cutoff = 0.1 - 0.25 = -0.15.
  // No snapshot at or before cutoff; falls back to buffer[0] which IS
  // the current snapshot (only one we have).
  assert.deepEqual(seenPos, { x: 50, z: 0 });
});

test('reaction latency: after 6 ticks, brain sees snapshot from ~250ms ago', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const seenPositionsAtLastTick = [];
  const mockBrain = {
    tick: (args) => {
      seenPositionsAtLastTick.push({ ...args.aiPos });
      return { yaw: 0, thrust: false, mode: 'wander', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      reactionLatencyS: 0.25,
    },
  });
  // Tick 6 times, advancing ship position each tick. After 6 ticks,
  // time=0.6s, cutoff=0.35. The snapshot from time=0.3 (x=30) is the
  // LAST eligible snapshot <= 0.35.
  for (let i = 1; i <= 6; i++) {
    // Mutate position in place -- the ship mock's position ref still
    // points at this object across updates.
    mock.state.position.x = i * 10;
    mock.state.position.z = 0;
    ai.update(0.1);
  }
  assert.equal(seenPositionsAtLastTick.length, 6);
  // Last brain call saw a delayed snapshot, NOT live (which would be 60).
  assert.deepEqual(seenPositionsAtLastTick[5], { x: 30, z: 0 },
    'brain sees snapshot from time ~0.3, not the live x=60');
});

test('reaction latency: reactionLatencyS=0 disables the buffer (live brain call)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const seenPositions = [];
  const mockBrain = {
    tick: (args) => {
      seenPositions.push({ ...args.aiPos });
      return { yaw: 0, thrust: false, mode: 'wander', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      reactionLatencyS: 0, // disabled
    },
  });
  for (let i = 1; i <= 4; i++) {
    mock.state.position.x = i * 10;
    mock.state.position.z = 0;
    ai.update(0.1);
  }
  // Live mode: every call gets the current position.
  assert.deepEqual(seenPositions[0], { x: 10, z: 0 });
  assert.deepEqual(seenPositions[1], { x: 20, z: 0 });
  assert.deepEqual(seenPositions[2], { x: 30, z: 0 });
  assert.deepEqual(seenPositions[3], { x: 40, z: 0 });
});

// ==========================================================================
// 2. FIRE CADENCE (factory gating)
// ==========================================================================

test('fire cadence: first fire passes (lastFireAt = -Infinity)', () => {
  const scene = mockScene();
  const asteroids = [mockAsteroid(0, -40)];
  const mock = mockShipFactory();
  const fireCalls = [];
  const weapon = { fire: (opts) => { fireCalls.push(opts); return 0; } };
  let decision = { yaw: 0, thrust: false, mode: 'target', fire: true };
  const mockBrain = {
    tick: () => decision,
  };
  const ai = createDemoAi({
    scene,
    asteroids,
    weapon,
    options: {
      shipFactory: mock.build,
      fireMinIntervalS: 0.30,
      brain: mockBrain,
    },
  });
  // yaw=0 facing -Z. Asteroid at (0,-40) IS in cone => fire=true from brain.
  ai.update(0.1);
  assert.equal(fireCalls.length, 1);
});

test('fire cadence: second fire within fireMinIntervalS is HELD (no weapon call)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const fireCalls = [];
  const weapon = { fire: () => { fireCalls.push(true); return 0; } };
  const mockBrain = {
    tick: () => ({ yaw: 0, thrust: false, mode: 'target', fire: true }),
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    weapon,
    options: {
      shipFactory: mock.build,
      fireMinIntervalS: 0.30,
      brain: mockBrain,
    },
  });
  ai.update(0.1);                         // t=0.1, first fire, lastFireAt=0.1
  assert.equal(fireCalls.length, 1);
  ai.update(0.1);                         // t=0.2, second fire attempt HELD
  assert.equal(fireCalls.length, 1, 'second fire within window is held');
  ai.update(0.20);                        // t=0.4, 0.3s+ after first fire, allowed
  assert.equal(fireCalls.length, 2, 'fire after window passes through');
});

test('fire cadence: fireMinIntervalS=0 disables gating (each tick fires)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const fireCalls = [];
  const weapon = { fire: () => { fireCalls.push(true); return 0; } };
  const mockBrain = {
    tick: () => ({ yaw: 0, thrust: false, mode: 'target', fire: true }),
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    weapon,
    options: {
      shipFactory: mock.build,
      fireMinIntervalS: 0, // disabled
      brain: mockBrain,
    },
  });
  ai.update(0.1);
  ai.update(0.1);
  ai.update(0.1);
  assert.equal(fireCalls.length, 3, 'no gating when disabled');
});

// ==========================================================================
// 3. CLOSE-RANGE COAST-IN (brain)
// ==========================================================================

test('coast-in: HUNT mode within coastInDist → thrust=false (override)', () => {
  // Ship at origin, no velocity. Pickup at (4, 0) -- within coastDist=6.
  // APPROACH branch would normally thrust=true (target aligned).
  // Coast-in override flips it to false.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 4, z: 0 },
    coastInDist: 6,
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.thrust, false, 'thrust overridden to false inside coastInDist');
});

test('coast-in: HUNT mode BEYOND coastInDist → normal intercept thrust', () => {
  // Pickup at (15, 0) -- 15u away, well beyond coastDist=6.
  // APPROACH branch thrust=true is NOT overridden.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 15, z: 0 },
    coastInDist: 6,
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.thrust, true, 'thrust as normal beyond coastInDist');
});

test('coast-in: TARGET mode at close range does NOT coast-in (only HUNT)', () => {
  // Asteroid at (4, 0) -- within coastDist=6, but default dodgeDist=14
  // would put it in DODGE range. Set dodgeDist=0 to disable DODGE so
  // the brain falls through to TARGET. Coast-in is a HUNT-only
  // override; TARGET asteroid chase keeps thrust=true even at close
  // range.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(4, 0)],
    time: 0,
    dodgeDist: 0, // disable dodge entirely
    targetDist: 90,
    coastInDist: 6,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.thrust, true, 'TARGET mode ignores coastInDist');
});

// ==========================================================================
// 4. SMART-WANDER GAP-AWARENESS (brain)
// ==========================================================================

test('smart-wander: nearest within gapAwareDist → 8-candidate gap pick (heading NOT toward asteroid)', () => {
  // Ship at origin. Asteroid to the east at (30, 0).
  // nearest.dist=30 < gapAwareDist=80 => gap-aware branch fires.
  // nearest.dist=30 > targetDist=10 => not in target range (TARGET
  // mode would short-circuit and not return _wanderHeading).
  // With rng=0.5, offset = 0.5*2π = π. Samples 8 candidates evenly
  // spaced by π/4. The candidates within ±π/3 of the asteroid dir
  // (0, +X) score negatively; candidates outside that cone score 0.
  // The pick is the first candidate tied at 0 (i.e., offset=π).
  // Assert the property: chosen heading is > 60° from the asteroid.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(30, 0)],
    time: 0,
    wanderHeading: null,
    wanderHeadingExpiresAt: 0,
    targetDist: 10,  // 30u asteroid OUTSIDE target range so mode = 'wander'
    gapAwareDist: 80,
    rng: () => 0.5,
  });
  assert.equal(result.mode, 'wander');
  assert.ok(typeof result._wanderHeading === 'number',
    `gap-aware branch should populate _wanderHeading, got ${result._wanderHeading}`);
  const asteroidDir = Math.atan2(0, 30 - 0); // 0 (+X)
  const heading = result._wanderHeading;
  const angDiffFromAsteroid = Math.abs(((asteroidDir - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(angDiffFromAsteroid > Math.PI / 3,
    `gap-aware heading (${heading}) should be >60 deg away from asteroid dir 0`);
});

test('smart-wander: nearest BEYOND gapAwareDist → legacy bias/jitter logic (deterministic)', () => {
  // Ship at origin. Asteroid at (0, 150) -- beyond gapAwareDist=80
  // but within awarenessDist (90*2.5=225). Legacy biassed jitter:
  // heading = PI/2 + (rng()*2-1)*PI*0.15. With rng=0.5, jitter=0,
  // heading = PI/2. Same as v0.12.x.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(0, 150)],
    time: 0,
    wanderHeading: null,
    wanderHeadingExpiresAt: 0,
    targetDist: 90,
    gapAwareDist: 80,
    rng: () => 0.5,
  });
  // Verify the legacy jitter formula (zero jitter with rng=0.5).
  assert.ok(Math.abs(result._wanderHeading - Math.PI / 2) < 1e-9,
    'far asteroid uses v0.12.x bias logic');
});

test('smart-wander: consumes exactly 1 rng() call per refresh (preserves v0.12.x rng budget)', () => {
  // Tests/ai.test.js's "wander picks a new heading on first call
  // (wanderHeading=null)" asserts exactly 1 rng call. This test
  // confirms the v0.13.x pickWanderHeading helper preserves
  // that contract regardless of which branch fires.
  let rngCalls = 0;
  const rng = () => { rngCalls++; return 0.25; };
  pickWanderHeading({
    aiPos: { x: 0, z: 0 },
    nearest: findNearestAsteroid({ x: 0, z: 0 }, []), // null
    asteroids: [],
    gapAwareDist: 80,
    awarenessDist: 1000,
    rng,
  });
  assert.equal(rngCalls, 1);
  // And again in the gap-aware branch
  rngCalls = 0;
  pickWanderHeading({
    aiPos: { x: 0, z: 0 },
    nearest: findNearestAsteroid({ x: 0, z: 0 }, [mockAsteroid(30, 0)]),
    asteroids: [mockAsteroid(30, 0)],
    gapAwareDist: 80,
    awarenessDist: 1000,
    rng,
  });
  assert.equal(rngCalls, 1, 'gap-aware branch uses exactly 1 rng()');
});

// ==========================================================================
// 5. MODE-HYSTERESIS (factory)
// ==========================================================================

test('mode-hysteresis: downgrade within window reuses cached decision', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  // Brain sequence: mode 'target' (1st tick), then 'wander' (2nd tick).
  // 2nd tick is within modeHysteresisS=0.30, and 'wander' < 'target'
  // priority → cached 'target' decision is REUSED.
  const decisionLog = [];
  let sequence = [
    { yaw: 0, thrust: true, mode: 'target', fire: false },
    { yaw: 0, thrust: false, mode: 'wander', fire: false },
  ];
  const mockBrain = {
    tick: () => {
      const d = sequence.shift() || { yaw: 0, thrust: false, mode: 'wander', fire: false };
      decisionLog.push(d);
      return d;
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      modeHysteresisS: 0.30,
      // Disable yawHoldTimeS so the raw decision's yaw is what we see.
      yawHoldTimeS: 0,
      thrustHoldTimeS: 0,
    },
  });
  ai.update(0.1); // t=0.1, decision=target, thrust=true.
  assert.equal(mock.calls.setThrust[0], true);
  ai.update(0.1); // t=0.2, decision=wander, but within 0.30s of mode change.
  // Cached 'target' decision reused → thrust still true.
  assert.equal(mock.calls.setThrust[1], true,
    'downgrade within hysteresis window reuses cached thrust=true');
});

test('mode-hysteresis: downgrade AFTER window applies new decision', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const sequence = [
    { yaw: 0, thrust: true, mode: 'target', fire: false },
    { yaw: 0, thrust: false, mode: 'wander', fire: false },
  ];
  const mockBrain = {
    tick: () => sequence.shift() || { yaw: 0, thrust: false, mode: 'wander', fire: false },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      modeHysteresisS: 0.10,
      yawHoldTimeS: 0,
      thrustHoldTimeS: 0,
    },
  });
  ai.update(0.1); // t=0.1, target, lastModeChangeAt=0.1
  ai.update(0.50); // t=0.6, 0.5s after mode change, DOWNGRADE applies.
  assert.equal(mock.calls.setThrust[1], false,
    'downgrade past hysteresis window applies new decision');
});

test('mode-hysteresis: UPGRADE bypasses window (DODGE applied immediately even mid-wander)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const sequence = [
    { yaw: 0, thrust: false, mode: 'wander', fire: false },
    { yaw: -1, thrust: true, mode: 'dodge', fire: false },
  ];
  const mockBrain = {
    tick: () => sequence.shift() || { yaw: 0, thrust: false, mode: 'wander', fire: false },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      modeHysteresisS: 0.30,
      // Keep the debounce off so we can isolate hysteresis behavior.
      yawHoldTimeS: 0,
      thrustHoldTimeS: 0,
    },
  });
  ai.update(0.1); // t=0.1, wander
  assert.equal(mock.calls.setThrust[0], false);
  ai.update(0.1); // t=0.2, dodge upgrade → applies immediately.
  assert.equal(mock.calls.setYaw[1], -1, 'dodge yaw applied immediately');
  assert.equal(mock.calls.setThrust[1], true, 'dodge thrust applied immediately');
});

// ==========================================================================
// 6. v0.14.x -- LOOK-AHEAD PREDICTION (target-leading)
// ==========================================================================
// Models the real-pilot reflex of leading the target by aiming at where
// the moving asteroid WILL BE in `interceptLookaheadS` seconds. With the
// current MVP's ambient asteroid drift (<0.5 u/s) the effect is small for
// the production field, but the API is forward-compatible with Elite
// expansions (faster enemies, motion-capable objects).

test('predictPosition: pos + vel * t when both provided', () => {
  assert.deepEqual(
    predictPosition({ x: 0, z: 0 }, { x: 10, z: -5 }, 0.5),
    { x: 5, z: -2.5 },
  );
});

test('predictPosition: returns pos unchanged when vel is null', () => {
  const pos = { x: 3, z: 7 };
  assert.strictEqual(predictPosition(pos, null, 0.5), pos,
    'no velocity → fall through to current position (no allocation)');
});

test('predictPosition: returns pos unchanged when lookAheadS=0 (disabled)', () => {
  const pos = { x: 3, z: 7 };
  assert.strictEqual(predictPosition(pos, { x: 100, z: 100 }, 0), pos);
});

test('predictPosition: returns null when pos is null (defensive)', () => {
  assert.equal(predictPosition(null, { x: 1, z: 1 }, 1), null);
});

test('lookupAsteroidVel: reads getVelocity() and validates xz fields', () => {
  assert.deepEqual(lookupAsteroidVel({ getVelocity: () => ({ x: 5, z: -2 }) }),
    { x: 5, z: -2 });
  assert.equal(lookupAsteroidVel({ getVelocity: () => ({ x: 1 }) }), null,
    'missing z → null (malformed velocity)');
  assert.equal(lookupAsteroidVel({}), null, 'no getVelocity method → null');
  assert.equal(lookupAsteroidVel(null), null, 'null asteroid → null');
});

test('brain: TARGET mode with velocity aims at predicted future position', () => {
  // Ship at origin, facing +X. Asteroid ahead at (40, 0) drifting at
  // (100, 0) u/s (10x the MVP ambient drift, but the API doesn't care).
  // With interceptLookaheadS=0.5, the brain predicts the asteroid at
  // (40 + 50, 0 + 0) = (90, 0). The brain's yaw/sterring should
  // converge on that predicted position, NOT on (40, 0). To test this,
  // verify the brain produces a yaw=0, thrust=true command (which is
  // what intercept returns when ship is aligned with the target +
  // closing speed below desired): with the predicted position at (90, 0)
  // ship facing (yaw=-PI/2 → facing=0), target aligns.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, 100, 0)],
    time: 0,
    dodgeDist: 0, // disable DODGE so TARGET mode fires
    targetDist: 90,
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.yaw, 0, 'aligned with predicted (90, 0)');
  assert.equal(result.thrust, true);
});

test('brain: HUNT mode (power-up) is NOT subject to look-ahead (power-up is static)', () => {
  // Ship at origin, power-up at (60, 0). No `getVelocity` is needed
  // because power-ups aren't entities in the asteroids list; HUNT
  // skips the predict step entirely (only TARGET applies the leader).
  // Same brain call should produce identical output regardless of
  // interceptLookaheadS value.
  const r1 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
    interceptLookaheadS: 0.5,
  });
  const r2 = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    time: 0,
    powerupPos: { x: 60, z: 0 },
    interceptLookaheadS: 0,
  });
  assert.equal(r1.mode, 'hunt');
  assert.equal(r2.mode, 'hunt');
  assert.equal(r1.yaw, r2.yaw);
  assert.equal(r1.thrust, r2.thrust);
});

// ---- v0.15.x LEAD-FIRE CONTRACTS --------------------------------------
// Pins "lead when the lead aligns": both steer (intercept) and fire
// (isTargetInFront) use the SAME predicted point. The contract means
// the bullet's direction (which inherits the ship's yaw via main.js)
// matches the bullet's expected impact point (where the asteroid
// will be when the bullet arrives).

test('lead-fire TARGET: predicted point in cone → fire=true (lead matches steer)', () => {
  // Ship at origin facing +X (yaw=-PI/2). Asteroid ahead at (40, 0)
  // drifting parallel to ship facing (+X). Current and predicted are
  // both at angle 0 (atan2(0, 40) = 0 = facing). Both in cone.
  // Lead-fire aligned with steer → fire=true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, 100, 0)],
    time: 0,
    dodgeDist: 0,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, true,
    'predicted point in cone → fire (lead when the lead aligns)');
});

test('lead-fire TARGET: predicted point OUT of cone → fire=false (current-only check would fire)', () => {
  // Ship at origin facing +X. Asteroid at (40, 0) drifting strongly
  // perpendicular to facing (+Z) at v=(0, 200).
  //
  // v0.15.x contract: predicted for uniform lookahead=0.5s =
  // (40, 100) at angle atan2(100, 40) ≈ 1.19 rad ≈ 68° — OUT of cone.
  //
  // v0.16.x contract: bullet-flight-time lead = 40 / 400 = 0.1s →
  // predicted (40, 20) at angle atan2(20, 40) ≈ 0.46 rad ≈ 26°
  // (still OUT of cone, half-angle 0.35 ~ 20°). The test fixture's
  // velocity was raised v0.15.x(0, 100) → v0.16.x(0, 200) so the
  // asteroid's drift over the dynamic lead window still exceeds
  // the cone half-angle. Without the bump, the new dynamic lead
  // would put the predicted point IN cone (pred (40,10), ~14°)
  // and fire would flip to true.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, 0, 200)],
    time: 0,
    dodgeDist: 0,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, false,
    'predicted out of cone → no fire (lead-when-aligned contract)');
});

test('lead-fire HUNT: per-asteroid predicted point in cone → fire=true', () => {
  // HUNT mode (chasing power-up): brain fires on any asteroid in cone.
  // Lead-fire applies per-asteroid in the HUNT loop too: the in-cone
  // check uses predictPosition(asteroidPos, asteroidVel, lookAheadS).
  // Setup: powerup at (60, 0). Ship facing +X (heading toward powerup).
  // Asteroid at (40, 0) drifting +X with v=100. Predicted (90, 0) at
  // angle 0 = facing → in cone. Old fire logic also in cone (current
  // atan2(0, 40)=0), so this is a regression guard for the LEAD-fire
  // machinery being wired in. Distinct from the TARGET test above.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, 100, 0)],
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    powerupPos: { x: 60, z: 0 },
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.fire, true,
    'HUNT lead-fire returns true when an asteroid predicted point is in cone');
});

test('lead-fire HUNT: predicted point OUT of cone (current in cone) → fire=false (strict lead-fire contract)', () => {
  // STRICT differentiation test: with v0.15.x lead-fire, the HUNT
  // loop checks each asteroid's PREDICTED (not current) position.
  // This fixture is hand-picked so current is IN cone but predicted
  // is OUT -- the OLD (current-only) check would have returned
  // fire=true. With lead-fire, fire=false. FAIL-on-old / PASS-on-new
  // -- this is the genuine contract pin for HUNT.
  //
  // Setup: powerup at (60, 0). Ship at origin facing +X
  // (yaw=-PI/2 → facingAngle=0). coneHalf=0.35.
  // Asteroid at (40, 0). Strong perpendicular drift v=(0, 200) →
  // predicted (40, 100). Current angle atan2(0, 40)=0 (in cone).
  // Predicted angle atan2(100, 40) ≈ atan2(2.5) ≈ 1.19 rad ≈ 68°
  // (OUT of cone, half-angle is 0.35 rad ≈ 20°).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(40, 0, 0, 200)],
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    powerupPos: { x: 60, z: 0 },
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.fire, false,
    'predicted point OUT of cone → no fire (strict lead-fire contract, fails on old current-only logic)');
});

test('brain: asteroid without getVelocity() falls through to current position (no crash)', () => {
  // Mock that satisfies the duck-typed `getPosition` API but DOESN'T
  // expose `getVelocity`. The brain should still produce a valid
  // decision -- the prediction gracefully degrades to current pos.
  const legacyAsteroid = {
    getPosition: () => ({ x: 40, y: 0, z: 0 }),
  };
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [legacyAsteroid],
    time: 0,
    dodgeDist: 0,
    targetDist: 90,
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'target');
  assert.equal(typeof result.yaw, 'number');
});

test('factory: passes interceptLookaheadS + bulletSpeed from opts into brain args (smoke)', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  let seenArgs = null;
  const mockBrain = {
    tick: (args) => {
      seenArgs = args;
      return { yaw: 0, thrust: false, mode: 'wander', fire: false };
    },
  };
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: {
      shipFactory: mock.build,
      brain: mockBrain,
      reactionLatencyS: 0,  // disable latency for deterministic args
      interceptLookaheadS: 0.75,  // custom cap, ~median between 0 and 1
      bulletSpeed: 250,            // custom speed for dynamic-lead math
    },
  });
  ai.update(0.05); // small tick to keep observation buffer minimal
  assert.equal(seenArgs.interceptLookaheadS, 0.75,
    'factory forwards interceptLookaheadS into brain call args');
  assert.equal(seenArgs.bulletSpeed, 250,
    'factory forwards bulletSpeed into brain call args (v0.16.x contract)');
});

// ==========================================================================
// 7. v0.16.x -- DYNAMIC BULLET-FLIGHT-TIME LEAD
// ==========================================================================
// The v0.14.x/v0.15.x lead used a uniform `interceptLookaheadS` = 0.5s for
// ALL asteroids regardless of distance. Close rocks were over-shot (the
// bullet arrived in ~12ms but the brain aimed at where it'd be in 500ms);
// far ones were under-shot (the bullet needed 225ms+ but was fired as if
// 500ms were enough lead). v0.16.x applies per-target bullet flight time:
// `leadS = Math.min(dist / bulletSpeed, interceptLookaheadS)`. The cap
// remains as the cognitive ceiling (a pilot won't commit beyond ~0.5s of
// forward-prediction horizon regardless of physics).

test('v0.16.x TARGET: close fast-drifting rock -- dynamic lead puts it in cone where fixed lead would miss', () => {
  // Ship at origin facing +X (yaw=-PI/2 → facingAngle=0). Asteroid at
  // (20, 0) drifting strongly perpendicular at v=(0, 80). Without the
  // dynamic lead (i.e. the v0.14.x/15.x fixed cap=0.5s), predicted
  // point = (20, 80*0.5) = (20, 40) at angle atan2(40, 20) ≈ 63° OUT
  // of the 20° cone (0.35 rad) → fire=false. With v0.16.x dynamic
  // lead = bulletSpeed=400 u/s × flightTime = 20/400 = 0.05s:
  // predicted = (20, 4) at angle atan2(4, 20) ≈ 11° IN cone → fire=true.
  //
  // This pins the direction-of-improvement: the brain now FIRES on a
  // close fast-drifting target it would have missed under the old
  // uniform-cap contract. Eye-visible in live play on the production
  // 5u/s asteroid drift at close range, and forward-compatible with
  // Elite-class 5+u/s enemy drift.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0, 0, 80)],
    time: 0,
    dodgeDist: 0,  // disable DODGE so TARGET fires
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    // bulletSpeed + interceptLookaheadS use DEFAULTS (400, 0.5).
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, true,
    'dynamic lead recovers the close fast-drift shot the fixed cap missed');
});

test('v0.16.x TARGET: long-range target with flightTime == cap -- cap and physics agree', () => {
  // Edge-case: an asteroid whose flightTime equals the cap (200u away
  // at 400 u/s = 0.5s, exactly the default cap). The bullet and the
  // cognitive cap give the SAME lead, so the brain shouldn't over- or
  // under-aim compared to the fixed-lookahead branch at the same
  // distance. Asteroid at (200, 0) drifting at v=(0, 100). Predicted =
  // (200, 50) at angle atan2(50, 200) ≈ 14° IN cone (0.35) → fire=true.
  // Regression guard against the min() branch going the wrong direction.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(200, 0, 0, 100)],
    time: 0,
    dodgeDist: 0,
    targetDist: 250,                      // override to include 200u
    fireConeHalfAngle: 0.35,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, true,
    'long-range shot at cap == flightTime: dynamic + fixed give same lead');
});

test('v0.16.x: bulletSpeed=0 disables dynamic lead, falls back to fixed interceptLookaheadS', () => {
  // Same close-asteroid fixture as the first test but bulletSpeed=0.
  // The dynamic branch is short-circuited (false because bulletSpeed
  // is not > 0), so we fall through to fixed interceptLookaheadS=0.5.
  // With velocity (0, 1000) the fixed cap puts predicted = (20, 500)
  // at angle ~88° -- OUT of the 0.35 cone → fire=false. This pins:
  // (1) the bulletSpeed>0 guard is honored, and (2) disabling the
  // dynamic lead produces the v0.14.x/15.x-same fixed-cap contract
  // (a "legacy mode" for tests / debugging / Elite expansions where
  // bullet speed stops being meaningful, e.g. hitscan weapons).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0, 0, 1000)],
    time: 0,
    dodgeDist: 0,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    bulletSpeed: 0,                       // disabled
    interceptLookaheadS: 0.5,
  });
  assert.equal(result.mode, 'target');
  assert.equal(result.fire, false,
    'bulletSpeed=0 disables dynamic lead; fixed cap predicts out-of-cone');
});

test('v0.16.x HUNT: per-asteroid dynamic lead applies in the HUNT loop (close shot recovered)', () => {
  // HUNT-mode lead-fire is per-asteroid, NOT just for the chased
  // power-up. v0.16.x extends the per-asteroid branch with the same
  // dynamic lead as TARGET. Setup: powerup at (60, 0), ship at origin
  // facing +X (yaw=-PI/2 → facingAngle=0). Asteroid at (20, 0) drifting
  // strongly perpendicular at v=(0, 80).
  //
  // Without dynamic lead (fixed cap=0.5s): predicted = (20, 40) at
  // angle ~63° OUT of cone. The OLD v0.15.x HUNT loop would reject
  // this asteroid (fire=false). With v0.16.x dynamic lead (0.05s):
  // predicted = (20, 4) at angle ~11° IN cone. The NEW loop fires.
  //
  // Pins: the HUNT branch is no worse (in fact, better) than the
  // TARGET branch on the same distant asteroid; the brain fires on
  // close fast-drifting rocks during a power-up chase too.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    aiVel: { x: 0, z: 0 },
    asteroids: [mockAsteroid(20, 0, 0, 80)],
    time: 0,
    dodgeDist: 14,
    targetDist: 90,
    fireConeHalfAngle: 0.35,
    powerupPos: { x: 60, z: 0 },           // powerup closer = HUNT mode
  });
  assert.equal(result.mode, 'hunt');
  assert.equal(result.fire, true,
    'HUNT per-asteroid dynamic lead fires on close fast-drift shot the fixed lead missed');
});
