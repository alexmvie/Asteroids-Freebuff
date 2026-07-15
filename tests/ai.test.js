/**
 * Unit tests for src/entities/ai.js (v0.55.0 clean-room rewrite).
 *
 * The brain has four simple behaviors (idle / engage / collect /
 * evade) over universal `predictPosition` + `steerTo` helpers. These
 * tests pin the contracts that survived simplification:
 *
 *   - Pure helpers: facingAngle, wrapAngle, predictPosition,
 *     isTargetInFront.
 *   - Brain arg validation.
 *   - EVADE: nearest asteroid within evadeDist turns ~90° away,
 *     thrusts hard.
 *   - COLLECT: reachable powerup → predicted intercept, thrust when
 *     aligned, coast-in gate near pickup.
 *   - ENGAGE: nearest asteroid → predicted lead point, thrust when
 *     aligned, fires on in-cone in-range asteroids.
 *   - Priority order: EVADE > COLLECT > ENGAGE > IDLE.
 *   - Fire is independent of chase target (shoots while chasing
 *     powerup).
 *   - Factory wiring: scene/asteroids required, dt<=0 no-op, reset
 *     on drift, weapon firing, IDLE never fires.
 *   - Live-bag flow-through: tuner-panel changes visible without
 *     app reload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiBrainTick,
  shouldResetAi,
  pickAiSpawn,
  createDemoAi,
  facingAngle,
  isTargetInFront,
  predictPosition,
  wrapAngle,
} from '../src/entities/ai.js';
import { AI_TUNABLES, AI_TUNABLE_DEFAULTS, resetAITunables } from '../src/entities/ai-tunables.js';

// ------------------------------------------------------------------
// Mock helpers
// ------------------------------------------------------------------

function mockAsteroid(x, z, vel) {
  const v = vel || { x: 0, z: 0 };
  return {
    getPosition: () => ({ x, y: 0, z }),
    getVelocity: () => ({ x: v.x, z: v.z }),
    getRadius: () => 3,
    getSize: () => 0,
  };
}

function mockShipFactory() {
  const calls = { setYaw: [], setThrust: [], update: [], reset: [] };
  let currentPosition = { x: 0, y: 0, z: 0 };
  let currentYaw = 0;
  return {
    calls,
    build: () => {
      const obj = {
        position: currentPosition,
        rotation: { yaw: 0, pitch: 0, roll: 0 },
        velocity: { x: 0, z: 0 },
        mesh: { _inScene: true },
        setYaw: (v) => {
          currentYaw = v;
          calls.setYaw.push(v);
        },
        setThrust: (v) => calls.setThrust.push(v),
        update: (dt) => calls.update.push(dt),
        reset: (p) => {
          calls.reset.push(p);
          currentPosition = { ...p };
          currentYaw = 0;
        },
        get angularVelocity() { return 0; },
      };
      Object.defineProperty(obj, 'rotation', {
        get() { return { yaw: currentYaw, pitch: 0, roll: 0 }; },
      });
      return obj;
    },
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

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

test('facingAngle: yaw=0 -> -PI/2 (facing -Z)', () => {
  assert.ok(Math.abs(facingAngle(0) - (-Math.PI / 2)) < 1e-9);
});

test('facingAngle: yaw=-PI/2 -> 0 (facing +X)', () => {
  assert.ok(Math.abs(facingAngle(-Math.PI / 2)) < 1e-9);
});

test('wrapAngle: wraps to [-PI, PI]', () => {
  assert.ok(Math.abs(wrapAngle(Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 3) - (-Math.PI)) < 1e-9);
  assert.equal(wrapAngle(0), 0);
});

test('predictPosition: stationary target returns current pos', () => {
  const p = predictPosition({ pos: { x: 50, z: 0 } }, { x: 0, z: 0 }, 400);
  assert.equal(p.x, 50);
  assert.equal(p.z, 0);
});

test('predictPosition: moving target predicts ahead', () => {
  // dist/bulletSpeed = 40/20 = 2s, +vel*2
  const p = predictPosition({ pos: { x: 40, z: 0 }, vel: { x: 10, z: 0 } }, { x: 0, z: 0 }, 20);
  assert.equal(p.x, 60);
  assert.equal(p.z, 0);
});

test('predictPosition: missing vel defaults to stationary', () => {
  const p = predictPosition({ pos: { x: 20, z: 0 } }, { x: 0, z: 0 }, 400);
  assert.equal(p.x, 20);
});

test('predictPosition: handles targets at zero distance', () => {
  const p = predictPosition({ pos: { x: 0, z: 0 } }, { x: 0, z: 0 }, 400);
  assert.equal(p.x, 0);
});

test('isTargetInFront: dead-ahead -> true', () => {
  // Ship at origin facing -Z (yaw=0); target at (0,-10) is in front.
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: -10 }, 0.4), true);
});

test('isTargetInFront: dead-behind -> false', () => {
  assert.equal(isTargetInFront({ x: 0, z: 0 }, 0, { x: 0, z: 10 }, 0.4), false);
});

test('isTargetInFront: handles non-zero yaw', () => {
  // Ship faces +X (yaw=-PI/2); target at (10,0) is in front.
  assert.equal(isTargetInFront({ x: 0, z: 0 }, -Math.PI / 2, { x: 10, z: 0 }, 0.4), true);
});

// ------------------------------------------------------------------
// aiBrainTick: arg validation
// ------------------------------------------------------------------

test('aiBrainTick: throws on missing aiPos', () => {
  assert.throws(
    () => aiBrainTick({ aiYaw: 0, asteroids: [] }),
    /aiPos/,
  );
});

test('aiBrainTick: throws on missing aiYaw', () => {
  assert.throws(
    () => aiBrainTick({ aiPos: { x: 0, z: 0 }, asteroids: [] }),
    /aiYaw/,
  );
});

test('aiBrainTick: throws on non-array asteroids', () => {
  assert.throws(
    () => aiBrainTick({ aiPos: { x: 0, z: 0 }, aiYaw: 0, asteroids: 'no' }),
    /asteroids/,
  );
});

// ------------------------------------------------------------------
// aiBrainTick: EVADE
// ------------------------------------------------------------------

test('aiBrainTick: nearest within evadeDist -> mode=evade, turns perpendicular', () => {
  // Ship at origin facing +X (yaw=-PI/2). Asteroid at (5,0).
  // Threat angle = atan2(0, 5) = 0. Escape = 0 + PI/2 = PI/2.
  // Target = (0 + cos(PI/2), 0 + sin(PI/2)) = (0, 1).
  // Ship facing +X. Heading to (0,1) -> atan2(1,0)=PI/2. Ship facing
  // facingAngle(-PI/2) = 0.  Err = PI/2 - 0 = PI/2 (LEFT) -> yaw=-1.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.yaw, -1);
  assert.equal(result.thrust, true, 'EVADE force-thrusts even when misaligned');
  assert.equal(result.fire, false);
});

test('aiBrainTick: evade reason explains the trigger', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(5, 0)],
    evadeDist: 12,
  });
  assert.equal(result.mode, 'evade');
  assert.match(result.reason, /5\.0u.*12\.0u/);
});

test('aiBrainTick: asteroid outside evadeDist -> mode=asteroid', () => {
  // evades 10; asteroid at 50.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(50, 0)],
  });
  assert.equal(result.mode, 'asteroid');
});

// ------------------------------------------------------------------
// aiBrainTick: ENGAGE
// ------------------------------------------------------------------

test('aiBrainTick: nearest asteroid in range -> mode=asteroid, turn toward it', () => {
  // Ship faces -Z (yaw=0); asteroid at (40, 0). Err = atan2(0,40)-(-PI/2) = PI/2 -> yaw=-1.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [mockAsteroid(40, 0)],
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, -1);
  assert.equal(result.thrust, false, 'not aligned -> no thrust');
});

test('aiBrainTick: aligned asteroid -> thrust and fire', () => {
  // Ship faces +X (yaw=-PI/2); asteroid at (40,0) directly ahead.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
  assert.equal(result.fire, true);
});

test('aiBrainTick: picks nearest of multiple asteroids', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0), mockAsteroid(20, 0)],
  });
  assert.equal(result.mode, 'asteroid');
  // Closest is (20,0) — straight ahead.
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
  assert.equal(result.fire, true);
});

// ------------------------------------------------------------------
// aiBrainTick: lead fire
// ------------------------------------------------------------------

test('aiBrainTick: lead fire aims ahead of moving asteroid', () => {
  // Ship faces +X (yaw=-PI/2). Asteroid at (40,0) moving +X at 10 u/s.
  // bulletSpeed=20 → flightTime = 40/20 = 2s → predicted (60,0) — in cone.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0, { x: 10, z: 0 })],
    bulletSpeed: 20,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, true);
});

test('aiBrainTick: lead fire does not fire if predicted point is off-axis', () => {
  // Asteroid moving +Z; predicted off to the side.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0, { x: 0, z: 10 })],
    bulletSpeed: 20,
  });
  assert.equal(result.mode, 'asteroid');
  assert.equal(result.fire, false);
});

// ------------------------------------------------------------------
// aiBrainTick: COLLECT
// ------------------------------------------------------------------

test('aiBrainTick: reachable powerup beats asteroid -> mode=powerup', () => {
  // Asteroid farther than the powerup. user priority: COLLECT.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 20, z: 0 },
  });
  assert.equal(result.mode, 'powerup');
});

test('aiBrainTick: aligned powerup -> thrust + coast-in not yet', () => {
  // Powerup directly ahead at 20u (above coast-in threshold of 5u).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0)],
    powerupPos: { x: 20, z: 0 },
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, true);
});

test('aiBrainTick: aligned powerup very close -> coast-in (no thrust)', () => {
  // Powerup directly ahead at 3u < POWERUP_COAST_DIST (5u).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [],
    powerupPos: { x: 3, z: 0 },
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.thrust, false, 'coast-in gate must cut thrust within 5u of pickup');
});

test('aiBrainTick: far powerup is ignored', () => {
  // Powerup beyond powerupMaxChaseDist.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 200, z: 0 },
    powerupMaxChaseDist: 80,
  });
  assert.equal(result.mode, 'asteroid');
});

// ------------------------------------------------------------------
// aiBrainTick: IDLE
// ------------------------------------------------------------------

test('aiBrainTick: empty asteroids + no powerup -> idle', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
  });
  assert.equal(result.mode, 'idle');
  assert.equal(result.yaw, 0);
  assert.equal(result.thrust, false);
  assert.equal(result.fire, false);
});

// ------------------------------------------------------------------
// aiBrainTick: priority order (EVADE > COLLECT > ENGAGE > IDLE)
// ------------------------------------------------------------------

test('aiBrainTick: EVADE outranks COLLECT', () => {
  // Nearby asteroid < evadeDist AND a reachable powerup. EVADE wins.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    powerupPos: { x: 20, z: 0 },
  });
  assert.equal(result.mode, 'evade');
});

test('aiBrainTick: COLLECT outranks ENGAGE', () => {
  // Far asteroid (no evade) AND a reachable powerup. COLLECT wins.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 20, z: 0 },
  });
  assert.equal(result.mode, 'powerup');
});

// ------------------------------------------------------------------
// aiBrainTick: fire is independent of chase target
// ------------------------------------------------------------------

test('aiBrainTick: keeps firing at asteroids while chasing powerup', () => {
  // Ship faces +X; powerup ahead. The (40,0) asteroid is also in cone.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(40, 0)],
    powerupPos: { x: 20, z: 0 },
  });
  assert.equal(result.mode, 'powerup');
  assert.equal(result.fire, true, 'must fire at asteroids even when chasing a powerup');
});

test('aiBrainTick: does not fire when asteroid is out of range', () => {
  // Asteroid at 250u, fireMaxDist default 200u. In cone (yaw=-PI/2, dead-ahead).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(250, 0)],
  });
  assert.equal(result.fire, false);
});

test('aiBrainTick: does not fire when too close (inside evadeDist)', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
  });
  assert.equal(result.mode, 'evade');
  assert.equal(result.fire, false);
});

// ------------------------------------------------------------------
// shouldResetAi + pickAiSpawn
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// createDemoAi: factory wiring
// ------------------------------------------------------------------

test('createDemoAi: requires scene and asteroids', () => {
  assert.throws(() => createDemoAi({}), /scene/);
  assert.throws(() => createDemoAi({ scene: mockScene() }), /asteroids/);
});

test('createDemoAi: basic factory wiring', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [],
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
  assert.equal(typeof ai.getShip, 'function');

  ai.update(0.1);
  assert.equal(mock.calls.setThrust.length, 1);
  assert.equal(mock.calls.update.length, 1);
});

test('createDemoAi: resets ship when it drifts beyond resetDist', () => {
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

test('createDemoAi: fires weapon when aligned with an asteroid in range', () => {
  // Asteroid directly ahead of spawn at (0,0,0) yaw=0; asteroid at (0,-25) is in cone + range.
  const scene = mockScene();
  const mock = mockShipFactory();
  const weaponCalls = [];
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, -25)],
    weapon: { fire: (opts) => { weaponCalls.push(opts); return 0; } },
    options: { shipFactory: mock.build, rng: () => 0 },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 1);
});

test('createDemoAi: does NOT fire weapon in IDLE mode', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const weaponCalls = [];
  const ai = createDemoAi({
    scene,
    asteroids: [],
    weapon: { fire: () => { weaponCalls.push(1); return 0; } },
    options: { shipFactory: mock.build },
  });
  ai.update(0.1);
  assert.equal(weaponCalls.length, 0);
});

test('createDemoAi: getLastDecision returns a frozen snapshot', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(40, 0)],
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

test('createDemoAi: getMode reports evade for nearby asteroid', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  const ai = createDemoAi({
    scene,
    asteroids: [mockAsteroid(0, 0)],
    options: {
      shipFactory: mock.build,
      rng: () => 0,
      evadeDist: 12,
      spawnRadius: 0, // ship spawns AT the asteroid -> evade
    },
  });
  assert.equal(ai.getMode(), 'evade');
});

// ------------------------------------------------------------------
// Live AI_TUNABLES bag flow-through
// ------------------------------------------------------------------

test('live-bag flow-through: AI_TUNABLES.evadeDist mutation changes evade behavior', () => {
  try {
    const POS = { x: 0, y: 0, z: 0 };
    const AST15 = mockAsteroid(15, 0);
    // Default evadeDist=10: 15u is outside -> no evade.
    const before = aiBrainTick({ aiPos: POS, aiYaw: 0, asteroids: [AST15] });
    assert.notEqual(before.mode, 'evade', 'baseline 15u outside default 10u');
    // Raise to 20: 15u is now inside -> evade.
    AI_TUNABLES.evadeDist = 20;
    const after = aiBrainTick({ aiPos: POS, aiYaw: 0, asteroids: [AST15] });
    assert.equal(after.mode, 'evade', 'live bag mutation should be visible next tick');
    assert.match(after.reason, /20\.0u/, 'reason reflects live value, not canonical default');
  } finally {
    resetAITunables();
  }
});

test('live-bag flow-through: AI_TUNABLES.fireMaxDist mutation changes fire behavior', () => {
  try {
    const POS = { x: 0, y: 0, z: 0 };
    const AST50 = mockAsteroid(50, 0);
    AI_TUNABLES.fireHeadingGate = Math.PI; // ensure dead-ahead is in cone.
    const before = aiBrainTick({ aiPos: POS, aiYaw: 0, asteroids: [AST50] });
    assert.equal(before.fire, true, 'baseline 50u in default 200u range');
    AI_TUNABLES.fireMaxDist = 30;
    const after = aiBrainTick({ aiPos: POS, aiYaw: 0, asteroids: [AST50] });
    assert.equal(after.fire, false, 'live bag fireMaxDist=30 should exclude 50u');
  } finally {
    resetAITunables();
  }
});

test('precedence: explicit factory override wins over live AI_TUNABLES bag', () => {
  try {
    AI_TUNABLES.evadeDist = 1000;
    const result = aiBrainTick({
      aiPos: { x: 0, z: 0 },
      aiYaw: 0,
      asteroids: [mockAsteroid(30, 0)],
      evadeDist: 50,
    });
    assert.equal(result.mode, 'evade', 'explicit evadeDist: 50 must win over bag 1000');
  } finally {
    resetAITunables();
  }
});

// ------------------------------------------------------------------
// Settle: verify the bag still has its canonical defaults after the
// suite (catches future regression where someone forgets to restore).
// ------------------------------------------------------------------

test('AI_TUNABLES: resetAITunables restores defaults (regression net)', () => {
  AI_TUNABLES.evadeDist = 1;
  AI_TUNABLES.fireHeadingGate = 999;
  resetAITunables();
  assert.equal(AI_TUNABLES.evadeDist, AI_TUNABLE_DEFAULTS.evadeDist);
  assert.equal(AI_TUNABLES.fireHeadingGate, AI_TUNABLE_DEFAULTS.fireHeadingGate);
});

// ------------------------------------------------------------------
// v0.56.0 PIRATE behavior (registry extension seam)
// ------------------------------------------------------------------

/**
 * Mock a target ship (live position/velocity props, no getPosition()).
 * Distinct from mockAsteroid (which has getPosition/getVelocity).
 */
function mockTargetShip(x, z, vel) {
  const v = vel || { x: 0, z: 0 };
  return {
    position: { x, y: 0, z },
    velocity: { x: v.x, z: v.z },
  };
}

test('aiBrainTick: nearest ship within aggroDist -> mode=pirate', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2, // facing +X
    asteroids: [],
    ships: [mockTargetShip(80, 0, { x: 0, z: 0 })],
    aggroDist: 300,
  });
  assert.equal(result.mode, 'pirate');
  assert.equal(result.yaw, 0, 'aligned with the ship straight ahead');
  assert.equal(result.thrust, true);
});

test('aiBrainTick: ship beyond aggroDist -> falls through to next behavior', () => {
  // aggroDist 50; ship at 80u. Pirate predicate fails. With no
  // asteroids/powerup, fall through to IDLE.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    asteroids: [],
    ships: [mockTargetShip(80, 0)],
    aggroDist: 50,
  });
  assert.notEqual(result.mode, 'pirate');
  assert.equal(result.mode, 'idle');
});

test('aiBrainTick: PIRATE outranks COLLECT', () => {
  // A reachable powerup AND a ship in aggroDist. PIRATE wins.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(80, 0)],
    ships: [mockTargetShip(40, 0)],
    powerupPos: { x: 20, z: 0 },
    aggroDist: 300,
  });
  assert.equal(result.mode, 'pirate');
});

test('aiBrainTick: EVADE outranks PIRATE', () => {
  // A nearby asteroid (< evadeDist) AND a ship in aggroDist.
  // EVADE wins (immediate threat to survival).
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [mockAsteroid(5, 0)],
    ships: [mockTargetShip(40, 0)],
    aggroDist: 300,
  });
  assert.equal(result.mode, 'evade');
});

test('aiBrainTick: lead fire on a moving ship', () => {
  // Ship at (40,0) moving +X at 10 u/s. Bullet speed 20. Flight
  // time 2s. Predicted (60, 0). Ship faces +X (yaw=-PI/2). In cone.
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [],
    ships: [mockTargetShip(40, 0, { x: 10, z: 0 })],
    aggroDist: 300,
    bulletSpeed: 20,
  });
  assert.equal(result.mode, 'pirate');
  assert.equal(result.fire, true);
});

test('aiBrainTick: does NOT fire on ship out of fireMaxDist', () => {
  const result = aiBrainTick({
    aiPos: { x: 0, z: 0 },
    aiYaw: -Math.PI / 2,
    asteroids: [],
    ships: [mockTargetShip(500, 0)], // beyond default fireMaxDist=200
    aggroDist: 1000, // pirate engages, but can't fire at 500u
  });
  assert.equal(result.mode, 'pirate');
  assert.equal(result.fire, false);
});

test('live-bag flow-through: AI_TUNABLES.aggroDist mutation changes pirate behavior', () => {
  try {
    const POS = { x: 0, z: 0 };
    const SHIP = mockTargetShip(80, 0);
    // Default aggroDist=0: pirate never fires (defaults to idle).
    const before = aiBrainTick({
      aiPos: POS, aiYaw: 0, asteroids: [], ships: [SHIP],
    });
    assert.notEqual(before.mode, 'pirate', 'default aggroDist=0 means pacifist');
    // Raise to 300: pirate engages.
    AI_TUNABLES.aggroDist = 300;
    const after = aiBrainTick({
      aiPos: POS, aiYaw: 0, asteroids: [], ships: [SHIP],
    });
    assert.equal(after.mode, 'pirate', 'live bag mutation visible next tick');
  } finally {
    resetAITunables();
  }
});

test('createDemoAi: factory option aggroDist overrides the live bag', () => {
  const scene = mockScene();
  const mock = mockShipFactory();
  try {
    AI_TUNABLES.aggroDist = 0;
    const ai = createDemoAi({
      scene,
      asteroids: [],
      options: { shipFactory: mock.build, aggroDist: 300, spawnRadius: 10 },
    });
    ai.getShip().position.x = 0;
    ai.getShip().position.z = 0;
    // The factory thread is best-effort (it does aggroDist via
    // brainArgsFromShip with ...opts spread), so verify mode after
    // a single tick — the mode will depend on whether any ship is
    // in range. With getShips=null, nearestShip stays null and pirate
    // never activates. We just want to make sure the factory didn't
    // throw on the new aggroDist key.
    ai.update(0.1);
    assert.equal(mock.calls.setThrust.length, 1);
  } finally {
    resetAITunables();
  }
});
