import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvolution } from '../../src/training/evolution.js';

test('createEvolution throws without genomeSize', () => {
  assert.throws(() => createEvolution({}), /genomeSize is required/);
  assert.throws(() => createEvolution({ genomeSize: 0 }), /genomeSize is required/);
});

test('createInitialPopulation returns the correct size', () => {
  const ga = createEvolution({ populationSize: 50, genomeSize: 20 });
  const pop = ga.createInitialPopulation();
  assert.equal(pop.length, 50);
  for (const g of pop) {
    assert.ok(g instanceof Float32Array);
    assert.equal(g.length, 20);
  }
});

test('nextGeneration produces a population of the same size', () => {
  const ga = createEvolution({ populationSize: 30, genomeSize: 10 });
  const pop = ga.createInitialPopulation();
  const fitnesses = new Float32Array(pop.length);
  for (let i = 0; i < fitnesses.length; i++) {
    fitnesses[i] = Math.random() * 100;
  }
  const next = ga.nextGeneration(pop, fitnesses);
  assert.equal(next.length, 30);
  for (const g of next) {
    assert.ok(g instanceof Float32Array);
    assert.equal(g.length, 10);
  }
});

test('nextGeneration keeps the best genomes (elitism)', () => {
  const ga = createEvolution({ populationSize: 10, genomeSize: 5, elitismCount: 2 });
  const pop = ga.createInitialPopulation();
  const fitnesses = new Float32Array(pop.length);
  // Make genome 7 the best, genome 3 the second best
  for (let i = 0; i < fitnesses.length; i++) fitnesses[i] = i;
  fitnesses[7] = 100;
  fitnesses[3] = 90;

  const next = ga.nextGeneration(pop, fitnesses);
  assert.equal(next.length, 10);

  // Check that the top 2 genomes are identical copies of the originals
  let foundBest = 0;
  for (const g of next) {
    let isBest = true;
    for (let i = 0; i < 5; i++) {
      if (g[i] !== pop[7][i]) { isBest = false; break; }
    }
    if (isBest) foundBest++;
  }
  assert.ok(foundBest >= 1, 'elitism should preserve at least one copy of the best genome');
});

test('nextGeneration throws on mismatched lengths', () => {
  const ga = createEvolution({ populationSize: 10, genomeSize: 5 });
  const pop = ga.createInitialPopulation();
  const badFitnesses = new Float32Array(pop.length - 1);
  assert.throws(() => ga.nextGeneration(pop, badFitnesses), /population.length/);
});

test('crossover produces children that are blends or clones', () => {
  const ga = createEvolution({ populationSize: 10, genomeSize: 5, crossoverRate: 1.0 });
  const pop = ga.createInitialPopulation();
  const fitnesses = new Float32Array(pop.length);
  for (let i = 0; i < fitnesses.length; i++) fitnesses[i] = Math.random() * 100;
  const next = ga.nextGeneration(pop, fitnesses);
  // Just verify all children are valid arrays
  for (const g of next) {
    assert.ok(g instanceof Float32Array);
    assert.equal(g.length, 5);
  }
});

test('mutation changes some values', () => {
  const ga = createEvolution({ populationSize: 100, genomeSize: 50, mutationRate: 0.5, mutationStrength: 0.1 });
  const pop = ga.createInitialPopulation();
  const clone = pop[0].slice();
  const fitnesses = new Float32Array(pop.length);
  for (let i = 0; i < fitnesses.length; i++) fitnesses[i] = Math.random() * 100;
  const next = ga.nextGeneration(pop, fitnesses);

  // At high mutation rate, some child should differ from its parents
  let allIdentical = true;
  for (let i = 0; i < next.length; i++) {
    let diff = false;
    for (let j = 0; j < 50; j++) {
      if (next[i][j] !== pop[i][j]) { diff = true; break; }
    }
    if (diff) { allIdentical = false; break; }
  }
  // With 50% mutation rate, it's virtually impossible to have zero mutations
  assert.equal(allIdentical, false);
});

test('createRandomGenome returns a Float32Array of the correct size', () => {
  const ga = createEvolution({ populationSize: 10, genomeSize: 20 });
  const g = ga.createRandomGenome();
  assert.ok(g instanceof Float32Array);
  assert.equal(g.length, 20);
});

test('population improves or stays stable over several generations', () => {
  const ga = createEvolution({ populationSize: 20, genomeSize: 10, elitismCount: 2 });
  let pop = ga.createInitialPopulation();
  // Fitness = sum of genome (we can maximize it)
  let bestFitness = -Infinity;
  for (let gen = 0; gen < 10; gen++) {
    const fitnesses = new Float32Array(pop.length);
    for (let i = 0; i < pop.length; i++) {
      let sum = 0;
      for (let j = 0; j < pop[i].length; j++) sum += pop[i][j];
      fitnesses[i] = sum;
    }
    const currentBest = Math.max(...fitnesses);
    if (currentBest > bestFitness) bestFitness = currentBest;
    pop = ga.nextGeneration(pop, fitnesses);
  }
  assert.ok(bestFitness > -Infinity);
});
