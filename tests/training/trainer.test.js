import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainer } from '../../src/training/trainer.js';

test('createTrainer returns expected API', () => {
  const trainer = createTrainer({ populationSize: 10, hiddenSize: 4 });
  assert.equal(typeof trainer.runGeneration, 'function');
  assert.equal(typeof trainer.runGenerations, 'function');
  assert.equal(typeof trainer.getGeneration, 'function');
  assert.equal(typeof trainer.getPopulation, 'function');
  assert.equal(typeof trainer.setPopulation, 'function');
  assert.equal(typeof trainer.getBestGenome, 'function');
});

test('initial generation is 0', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4 });
  assert.equal(trainer.getGeneration(), 0);
});

test('runGeneration advances generation and returns stats', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 2 });
  const result = trainer.runGeneration();
  assert.equal(result.generation, 1);
  assert.equal(typeof result.bestFitness, 'number');
  assert.equal(typeof result.avgFitness, 'number');
  assert.ok(result.bestGenome instanceof Float32Array);
  assert.ok(result.bestFitness >= result.avgFitness || result.bestFitness === result.avgFitness);
});

test('runGenerations runs multiple generations', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  const result = trainer.runGenerations(3);
  assert.equal(result.generation, 3);
  assert.ok(trainer.getBestGenome().fitness > -Infinity);
});

test('population size is preserved', () => {
  const popSize = 6;
  const trainer = createTrainer({ populationSize: popSize, hiddenSize: 4, maxDurationS: 1 });
  trainer.runGeneration();
  assert.equal(trainer.getPopulation().length, popSize);
});

test('best fitness is tracked across generations', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  let bestEver = -Infinity;
  for (let i = 0; i < 3; i++) {
    const result = trainer.runGeneration();
    if (result.bestFitness > bestEver) bestEver = result.bestFitness;
    assert.ok(trainer.getBestGenome().fitness >= bestEver);
  }
});

test('setPopulation replaces the current population', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  const pop = trainer.getPopulation();
  const newPop = pop.slice(0, 3);
  trainer.setPopulation(newPop);
  assert.equal(trainer.getPopulation().length, 3);
});

test('setPopulation throws on empty array', () => {
  const trainer = createTrainer({ populationSize: 5, hiddenSize: 4, maxDurationS: 1 });
  assert.throws(() => trainer.setPopulation([]), /expected non-empty array/);
  assert.throws(() => trainer.setPopulation('bad'), /expected non-empty array/);
});

test('onProgress callback is called', () => {
  let calls = 0;
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
    },
  });
  trainer.runGeneration();
  assert.equal(calls, 1);
  trainer.runGeneration();
  assert.equal(calls, 2);
});

test('genome size matches input+hidden+output', () => {
  const trainer = createTrainer({ populationSize: 3, hiddenSize: 6, outputSize: 3, maxDurationS: 1 });
  const pop = trainer.getPopulation();
  const expectedSize = 11 * 6 + 6 + 6 * 3 + 3; // 11 inputs, 6 hidden, 3 outputs
  for (const g of pop) {
    assert.equal(g.length, expectedSize);
  }
});
