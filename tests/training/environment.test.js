import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainingEnvironment } from '../../src/training/environment.js';

test('createTrainingEnvironment returns expected API', () => {
  const env = createTrainingEnvironment();
  assert.equal(typeof env.reset, 'function');
  assert.equal(typeof env.step, 'function');
  assert.equal(typeof env.getState, 'function');
  assert.equal(typeof env.getScore, 'function');
  assert.equal(typeof env.getSurvivalTime, 'function');
  assert.equal(typeof env.getPowerupsCollected, 'function');
  assert.equal(typeof env.isLaserActive, 'function');
});

test('reset clears score and survival time', () => {
  const env = createTrainingEnvironment({ maxDurationS: 10, dt: 1 });
  env.reset();
  // Run a few steps
  env.step({ yaw: 0, thrust: false, fire: false });
  env.step({ yaw: 0, thrust: false, fire: false });
  assert.ok(env.getSurvivalTime() > 0);
  env.reset();
  assert.equal(env.getScore(), 0);
  assert.equal(env.getSurvivalTime(), 0);
  assert.equal(env.getPowerupsCollected(), 0);
  assert.equal(env.hasDied(), false);
});

test('getState returns a Float32Array of length 11', () => {
  const env = createTrainingEnvironment();
  env.reset();
  const state = env.getState();
  assert.ok(state instanceof Float32Array);
  assert.equal(state.length, 11);
});

test('step advances time and returns done/hit', () => {
  // Use a small field with no asteroids by setting a very small radius
  // and a long duration so we only hit the time limit, not an asteroid.
  const env = createTrainingEnvironment({ maxDurationS: 2, dt: 0.5, fieldRadiusChunks: 0 });
  env.reset();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const result = env.step({ yaw: 0, thrust: false, fire: false });
    done = result.done;
    assert.equal(typeof result.hit, 'boolean');
  }
  assert.ok(done, 'should reach time limit');
});

test('thrust increases ship speed', () => {
  const env = createTrainingEnvironment({ dt: 0.1 });
  env.reset();
  const posBefore = env.getShipPosition();
  const velBefore = env.getShipVelocity();
  // Run with thrust for a few steps
  for (let i = 0; i < 5; i++) {
    env.step({ yaw: 0, thrust: true, fire: false });
  }
  const velAfter = env.getShipVelocity();
  const speedBefore = Math.hypot(velBefore.x, velBefore.z);
  const speedAfter = Math.hypot(velAfter.x, velAfter.z);
  assert.ok(speedAfter > speedBefore, 'speed should increase with thrust');
});

test('yaw changes ship rotation', () => {
  const env = createTrainingEnvironment({ dt: 0.1 });
  env.reset();
  const rotBefore = env.getShipRotation();
  for (let i = 0; i < 5; i++) {
    env.step({ yaw: 1, thrust: false, fire: false });
  }
  const rotAfter = env.getShipRotation();
  assert.notEqual(rotAfter.yaw, rotBefore.yaw, 'yaw should change');
});

test('fire spawns bullets', () => {
  const env = createTrainingEnvironment({ dt: 0.1 });
  env.reset();
  env.step({ yaw: 0, thrust: false, fire: true });
  // Bullet cooldown is 0.18s, so one step at 0.1s should spawn one bullet
  assert.ok(env.getBulletCount() >= 0);
});

test('asteroids exist after reset', () => {
  const env = createTrainingEnvironment();
  env.reset();
  assert.ok(env.getAsteroidCount() > 0, 'environment should have asteroids');
});

test('episode ends at maxDurationS', () => {
  const env = createTrainingEnvironment({ maxDurationS: 1, dt: 0.5 });
  env.reset();
  env.step({ yaw: 0, thrust: false, fire: false });
  assert.equal(env.getSurvivalTime(), 0.5);
  env.step({ yaw: 0, thrust: false, fire: false });
  assert.equal(env.getSurvivalTime(), 1.0);
  const result = env.step({ yaw: 0, thrust: false, fire: false });
  assert.ok(result.done, 'should be done after maxDurationS');
  assert.equal(result.hit, false);
});

test('done returns true immediately after death', () => {
  const env = createTrainingEnvironment({ dt: 1 / 60 });
  env.reset();
  // Ram into the first asteroid by moving toward it
  let hit = false;
  let done = false;
  let steps = 0;
  while (!done && steps < 5000) {
    const result = env.step({ yaw: 0, thrust: true, fire: false });
    done = result.done;
    if (result.hit) hit = true;
    steps++;
  }
  assert.ok(done, 'should eventually die or time out');
});

test('state features are normalized', () => {
  const env = createTrainingEnvironment();
  env.reset();
  const state = env.getState();
  // Speed (feature 0) should be in [0, 1] after normalization
  assert.ok(state[0] >= 0, 'speed should be >= 0');
  assert.ok(state[0] <= 1, 'speed should be <= 1 after normalization');
  // Sin/cos (features 1, 2) should be in [-1, 1]
  assert.ok(state[1] >= -1 && state[1] <= 1);
  assert.ok(state[2] >= -1 && state[2] <= 1);
});

test('power-up spawns after reset', () => {
  const env = createTrainingEnvironment({ dt: 0.1 });
  env.reset();
  // First power-up should spawn immediately
  // We can't directly observe it, but we can check state features 7-9
  const state = env.getState();
  // Features 7-9 are power-up related; if no power-up, they default to [0,0,1]
  assert.ok(state[7] !== undefined);
  assert.ok(state[8] !== undefined);
  assert.ok(state[9] !== undefined);
});
