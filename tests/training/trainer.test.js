/**
 * Tests for the trainer (async — runGeneration uses the worker pool when
 * `workerCount > 0`, so all generation calls return promises).
 *
 * Most tests use `workerCount: 0` (sync fallback) for speed + determinism.
 * A few tests exercise the worker pool to verify the async path works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainer, DEFAULTS } from '../../src/training/trainer.js';

test('createTrainer returns expected API', () => {
  const trainer = createTrainer({ populationSize: 10, hiddenSize: 4 });
  assert.equal(typeof trainer.runGeneration, 'function');
  assert.equal(typeof trainer.runGenerations, 'function');
  assert.equal(typeof trainer.getGeneration, 'function');
  assert.equal(typeof trainer.getPopulation, 'function');
  assert.equal(typeof trainer.setPopulation, 'function');
  assert.equal(typeof trainer.getBestGenome, 'function');
  assert.equal(typeof trainer.getConfig, 'function');
  assert.equal(typeof trainer.close, 'function');
  // close is async; no need to await it for the API-shape test
  trainer.close();
});

test('initial generation is 0', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4 });
  assert.equal(trainer.getGeneration(), 0);
  trainer.close();
});

test('runGeneration advances generation and returns stats (async)', async () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 2 });
  const result = await trainer.runGeneration();
  assert.equal(result.generation, 1);
  assert.equal(typeof result.bestFitness, 'number');
  assert.equal(typeof result.avgFitness, 'number');
  assert.ok(result.bestGenome instanceof Float32Array);
  assert.ok(result.bestFitness >= result.avgFitness || result.bestFitness === result.avgFitness);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
  await trainer.close();
});

test('runGenerations runs multiple generations (async)', async () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  const result = await trainer.runGenerations(3);
  assert.equal(result.generation, 3);
  assert.ok(trainer.getBestGenome().fitness > -Infinity);
  await trainer.close();
});

test('population size is preserved', async () => {
  const popSize = 6;
  const trainer = createTrainer({ populationSize: popSize, hiddenSize: 4, maxDurationS: 1 });
  await trainer.runGeneration();
  assert.equal(trainer.getPopulation().length, popSize);
  await trainer.close();
});

test('best fitness is tracked across generations', async () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  let bestEver = -Infinity;
  for (let i = 0; i < 3; i++) {
    const result = await trainer.runGeneration();
    if (result.bestFitness > bestEver) bestEver = result.bestFitness;
    assert.ok(trainer.getBestGenome().fitness >= bestEver);
  }
  await trainer.close();
});

test('setPopulation replaces the current population', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  const pop = trainer.getPopulation();
  const newPop = pop.slice(0, 3);
  trainer.setPopulation(newPop);
  assert.equal(trainer.getPopulation().length, 3);
  trainer.close();
});

test('setPopulation throws on empty array', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  assert.throws(() => trainer.setPopulation([]), /expected non-empty array/);
  assert.throws(() => trainer.setPopulation('bad'), /expected non-empty array/);
  trainer.close();
});

test('onProgress callback is called with durationMs', async () => {
  let calls = 0;
  let lastDuration = -1;
  const trainer = createTrainer({
    populationSize: 4,
    hiddenSize: 4,
    maxDurationS: 1,
    onProgress: (stats) => {
      calls++;
      assert.equal(typeof stats.generation, 'number');
      assert.equal(typeof stats.bestFitness, 'number');
      assert.equal(typeof stats.avgFitness, 'number');
      assert.equal(typeof stats.bestEverFitness, 'number');
      assert.equal(typeof stats.durationMs, 'number');
      lastDuration = stats.durationMs;
    },
  });
  await trainer.runGeneration();
  assert.equal(calls, 1);
  await trainer.runGeneration();
  assert.equal(calls, 2);
  assert.ok(lastDuration >= 0);
  await trainer.close();
});

test('genome size matches input+hidden+output', async () => {
  const trainer = createTrainer({ populationSize: 3, hiddenSize: 6, outputSize: 3, maxDurationS: 1 });
  const pop = trainer.getPopulation();
  // 13 inputs (was 11; velocity vx/vz added), 6 hidden, 3 outputs
  const expectedSize = 13 * 6 + 6 + 6 * 3 + 3;
  for (const g of pop) {
    assert.equal(g.length, expectedSize);
  }
  await trainer.close();
});

test('getConfig returns the effective config including GA options', () => {
  const trainer = createTrainer({
    populationSize: 20,
    hiddenSize: 8,
    maxDurationS: 15,
    movementReward: 0.7,
    seedStrategy: 'fixed',
    gaOptions: {
      mutationRate: 0.2,
      mutationStrength: 0.4,
      elitismCount: 3,
      crossoverRate: 0.6,
      tournamentSize: 5,
    },
  });
  const cfg = trainer.getConfig();
  assert.equal(cfg.populationSize, 20);
  // Architecture params are now nested under `architecture`
  assert.deepEqual(cfg.architecture, {
    inputSize: DEFAULTS.inputSize,
    hiddenSize: 8,
    outputSize: DEFAULTS.outputSize,
  });
  assert.equal(cfg.maxDurationS, 15);
  assert.equal(cfg.movementReward, 0.7);
  assert.equal(cfg.seedStrategy, 'fixed');
  assert.equal(cfg.workerCount, 0); // not enabled
  // GA config is read from the actual evolution instance (not hardcoded)
  assert.equal(cfg.ga.mutationRate, 0.2);
  assert.equal(cfg.ga.mutationStrength, 0.4);
  assert.equal(cfg.ga.elitismCount, 3);
  assert.equal(cfg.ga.crossoverRate, 0.6);
  assert.equal(cfg.ga.tournamentSize, 5);
  trainer.close();
});

test('getConfig fills in GA defaults when not supplied (from evolution DEFAULTS)', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4 });
  const cfg = trainer.getConfig();
  // These match `evolution.js` DEFAULTS exactly (read from the
  // actual evolution instance, not hardcoded in getConfig).
  assert.equal(cfg.ga.mutationRate, 0.15);
  assert.equal(cfg.ga.mutationStrength, 0.3);
  assert.equal(cfg.ga.elitismCount, 5);
  assert.equal(cfg.ga.crossoverRate, 0.7);
  assert.equal(cfg.ga.tournamentSize, 3);
  trainer.close();
});

test('getConfig.architecture groups input/hidden/output for the dashboard', () => {
  const trainer = createTrainer({
    populationSize: 4,
    inputSize: 13,
    hiddenSize: 16,
    outputSize: 3,
  });
  const cfg = trainer.getConfig();
  // The architecture sub-object is the source of truth for the
  // network shape — the dashboard's flattenConfig turns it into
  // three chips: architecture.inputSize, architecture.hiddenSize,
  // architecture.outputSize.
  assert.equal(cfg.architecture.inputSize, 13);
  assert.equal(cfg.architecture.hiddenSize, 16);
  assert.equal(cfg.architecture.outputSize, 3);
  trainer.close();
});

test('runGeneration works with the worker pool (workerCount > 0)', async () => {
  // Use 2 workers + a small population so the test stays fast.
  const trainer = createTrainer({
    populationSize: 4,
    hiddenSize: 4,
    maxDurationS: 1,
    workerCount: 2,
    seedStrategy: 'fixed', // deterministic for assertion stability
  });
  const cfg = trainer.getConfig();
  assert.equal(cfg.workerCount, 2, 'worker count should be reflected in getConfig');

  const result = await trainer.runGeneration();
  assert.equal(result.generation, 1);
  assert.equal(typeof result.bestFitness, 'number');
  assert.ok(Number.isFinite(result.bestFitness));
  await trainer.close();
});

test('close is a safe no-op when no workers were created', async () => {
  const trainer = createTrainer({ populationSize: 4, hiddenSize: 4 });
  // Should resolve cleanly with workerCount=0
  await trainer.close();
  // Calling close twice should also be safe
  await trainer.close();
});
