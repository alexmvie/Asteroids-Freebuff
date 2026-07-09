import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRun,
  simulateDemoAiRun,
  tuneDemoAi,
  resolveAiPresetOptions,
  DEFAULT_AI_PRESETS,
} from '../src/entities/ai-tuning.js';

test('scoreRun rewards closer powerup approaches and penalizes asteroid collisions', () => {
  const scenario = {
    shipStart: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    powerup: { x: 70, z: 0 },
    asteroids: [{ x: 60, z: 18, vx: 0, vz: 0, radius: 6 }],
  };

  const poor = simulateDemoAiRun({
    params: { coastDist: 40, powerupBiasU: 9999 },
    scenario,
    steps: 90,
    dt: 0.016,
  });
  const better = simulateDemoAiRun({
    params: { coastDist: 20, powerupBiasU: 9999 },
    scenario,
    steps: 90,
    dt: 0.016,
  });

  assert.ok(Number.isFinite(poor.score));
  assert.ok(Number.isFinite(better.score));
  assert.ok(better.score > poor.score);
});

test('tuneDemoAi returns a valid parameter set and a finite score', () => {
  const tuned = tuneDemoAi({
    scenario: {
      shipStart: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
      powerup: { x: 85, z: 0 },
      asteroids: [{ x: 65, z: 20, vx: 0, vz: 0, radius: 6 }],
    },
    steps: 60,
    dt: 0.016,
    paramValues: {
      coastDist: [20, 40],
      powerupBiasU: [9999],
      thrustHeadingGate: [0.5],
    },
  });

  assert.ok(Number.isFinite(tuned.score));
  assert.equal(typeof tuned.bestParams.coastDist, 'number');
  assert.equal(typeof tuned.bestParams.powerupBiasU, 'number');
});

test('scoreRun uses a stable score shape for the same scenario', () => {
  const scenario = {
    shipStart: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    powerup: { x: 60, z: 0 },
    asteroids: [{ x: 55, z: 14, vx: 0, vz: 0, radius: 6 }],
  };

  const first = simulateDemoAiRun({ params: { coastDist: 25 }, scenario, steps: 60, dt: 0.016 });
  const second = simulateDemoAiRun({ params: { coastDist: 25 }, scenario, steps: 60, dt: 0.016 });

  assert.equal(first.score, second.score);
  assert.equal(first.history.length, second.history.length);
  assert.equal(first.history[0].mode, second.history[0].mode);
});

test('resolveAiPresetOptions merges preset defaults with override values', () => {
  const resolved = resolveAiPresetOptions({ presetName: 'balanced', rawOptions: '{"coastDist":25}' });
  assert.equal(resolved.coastDist, 25);
  assert.equal(resolved.powerupBiasU, DEFAULT_AI_PRESETS.balanced.powerupBiasU);
  assert.equal(resolved.evadeDist, DEFAULT_AI_PRESETS.balanced.evadeDist);
});

test('resolveAiPresetOptions returns the base preset when the preset is unknown', () => {
  const resolved = resolveAiPresetOptions({ presetName: 'missing', rawOptions: null });
  assert.deepEqual(resolved, {});
});
