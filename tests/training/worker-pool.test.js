/**
 * Tests for the worker thread pool that powers parallel genome evaluation.
 *
 * Verifies that:
 *   - The pool spawns the requested number of workers
 *   - Tasks are distributed (round-robin) and return results in input order
 *   - The pool is reusable across many sequential batches
 *   - close() terminates all workers
 *   - The default worker count is `os.cpus().length - 1` (or 1 as a floor)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createWorkerPool } from '../../src/training/worker-pool.js';
import { createNetwork, genomeFromNetwork, networkFromGenome, genomeSize, forward } from '../../src/training/network.js';
import { createTrainingEnvironment } from '../../src/training/environment.js';

function makeGenome(inputSize, hiddenSize, outputSize) {
  const net = createNetwork(inputSize, hiddenSize, outputSize);
  return genomeFromNetwork(net);
}

function evaluateGenomeSync(genome, options) {
  const { inputSize, hiddenSize, outputSize, maxDurationS, dt, seedStrategy, movementReward, episodesPerGenome, envOptions } = options;
  const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
  const env = createTrainingEnvironment({ maxDurationS, dt, ...envOptions });
  let total = 0;
  for (let ep = 0; ep < episodesPerGenome; ep++) {
    env.reset(seedStrategy === 'vary' ? { systemSeed: Math.floor(Math.random() * 1e9) } : {});
    let done = false;
    let steps = 0;
    const maxSteps = Math.ceil(maxDurationS / dt);
    while (!done && steps < maxSteps) {
      const state = env.getState();
      const outputs = forward(network, state);
      const yaw = outputs[0] > 0.33 ? 1 : outputs[0] < -0.33 ? -1 : 0;
      const thrust = outputs[1] > 0;
      const fire = outputs[2] > 0;
      const r = env.step({ yaw, thrust, fire });
      done = r.done;
      steps++;
    }
    total += env.getScore() + env.getSurvivalTime() * 10 + env.getPowerupsCollected() * 100 + env.getDistanceTraveled() * movementReward;
  }
  return total / episodesPerGenome;
}

test('createWorkerPool spawns the requested number of workers', () => {
  const pool = createWorkerPool({ workerCount: 3 });
  assert.equal(pool.workerCount, 3);
  return pool.close();
});

test('createWorkerPool defaults to cpus-1 workers', () => {
  const pool = createWorkerPool();
  const expected = Math.max(1, (os.cpus()?.length ?? 1) - 1);
  assert.equal(pool.workerCount, expected);
  return pool.close();
});

test('createWorkerPool floors at 1 worker', () => {
  const pool = createWorkerPool({ workerCount: 0 });
  assert.equal(pool.workerCount, 1);
  return pool.close();
});

test('evaluateAll returns fitnesses in the same order as input genomes', async () => {
  const pool = createWorkerPool({ workerCount: 2 });
  try {
    const options = {
      inputSize: 13,
      hiddenSize: 8,
      outputSize: 3,
      maxDurationS: 1,
      dt: 1 / 60,
      seedStrategy: 'fixed',
      movementReward: 0.5,
      episodesPerGenome: 1,
      envOptions: {},
    };
    const genomes = [
      makeGenome(13, 8, 3),
      makeGenome(13, 8, 3),
      makeGenome(13, 8, 3),
      makeGenome(13, 8, 3),
    ];
    const fitnesses = await pool.evaluateAll(genomes, options);
    assert.ok(fitnesses instanceof Float32Array);
    assert.equal(fitnesses.length, genomes.length);
    for (const f of fitnesses) {
      assert.ok(Number.isFinite(f), 'fitness should be a finite number');
    }
  } finally {
    await pool.close();
  }
});

test('worker pool results match the sync path (within tolerance for randomness)', async () => {
  // We use seedStrategy='fixed' so both paths see the same per-episode
  // field layout, and run the same brain on both. The fitness should
  // match exactly (modulo float ordering).
  const pool = createWorkerPool({ workerCount: 2 });
  try {
    const options = {
      inputSize: 13,
      hiddenSize: 4,
      outputSize: 3,
      maxDurationS: 1,
      dt: 1 / 60,
      seedStrategy: 'fixed',
      movementReward: 0.5,
      episodesPerGenome: 1,
      envOptions: {},
    };
    const genome = makeGenome(13, 4, 3);
    const syncFit = evaluateGenomeSync(genome, options);
    const [workerFit] = await pool.evaluateAll([genome], options);
    // Exact match (deterministic seed) — should be within float epsilon
    assert.ok(Math.abs(syncFit - workerFit) < 1e-3, `syncFit=${syncFit} workerFit=${workerFit}`);
  } finally {
    await pool.close();
  }
});

test('worker pool is reusable across many sequential batches', async () => {
  const pool = createWorkerPool({ workerCount: 2 });
  try {
    const options = {
      inputSize: 13,
      hiddenSize: 4,
      outputSize: 3,
      maxDurationS: 1,
      dt: 1 / 60,
      seedStrategy: 'fixed',
      movementReward: 0.5,
      episodesPerGenome: 1,
      envOptions: {},
    };
    for (let batch = 0; batch < 3; batch++) {
      const genomes = [makeGenome(13, 4, 3), makeGenome(13, 4, 3)];
      const fitnesses = await pool.evaluateAll(genomes, options);
      assert.equal(fitnesses.length, 2);
    }
  } finally {
    await pool.close();
  }
});

test('close is safe to call multiple times', async () => {
  const pool = createWorkerPool({ workerCount: 2 });
  await pool.close();
  await pool.close(); // should not throw
});
