import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveGenome,
  loadGenome,
  savePopulation,
  loadPopulation,
  ensureDir,
} from '../../src/training/persistence.js';
import { serializeGenome, deserializeGenome } from '../../src/training/network.js';

// Use a temp directory for all persistence tests
const TEST_DIR = join(tmpdir(), 'asteroids-training-test-' + Date.now());

function setup() {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

test('ensureDir creates a directory recursively', () => {
  const dir = join(TEST_DIR, 'a', 'b', 'c');
  ensureDir(dir);
  assert.ok(existsSync(dir));
});

test('saveGenome + loadGenome round-trip', () => {
  setup();
  const path = join(TEST_DIR, 'genome.json');
  const genome = new Float32Array([0.1, -0.2, 0.3, 0.4, -0.5]);
  saveGenome(path, genome, { generation: 7, fitness: 42.5 });

  const loaded = loadGenome(path);
  assert.ok(loaded.genome instanceof Float32Array);
  assert.equal(loaded.genome.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(loaded.genome[i], genome[i]);
  }
  assert.equal(loaded.metadata.generation, 7);
  assert.equal(loaded.metadata.fitness, 42.5);
  teardown();
});

test('savePopulation + loadPopulation round-trip', () => {
  setup();
  const path = join(TEST_DIR, 'pop.json');
  const pop = [
    new Float32Array([1, 2, 3]),
    new Float32Array([4, 5, 6]),
    new Float32Array([7, 8, 9]),
  ];
  savePopulation(path, pop, { generation: 3, hiddenSize: 12 });

  const loaded = loadPopulation(path);
  assert.equal(loaded.population.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(loaded.population[i] instanceof Float32Array);
    assert.equal(loaded.population[i].length, 3);
    for (let j = 0; j < 3; j++) {
      assert.equal(loaded.population[i][j], pop[i][j]);
    }
  }
  assert.equal(loaded.metadata.generation, 3);
  assert.equal(loaded.metadata.hiddenSize, 12);
  teardown();
});

test('loadGenome throws on invalid file', () => {
  setup();
  const path = join(TEST_DIR, 'bad.json');
  writeFileSync(path, '{"not": "valid"}');
  assert.throws(() => loadGenome(path), /invalid file format/);
  teardown();
});

test('loadPopulation throws on invalid file', () => {
  setup();
  const path = join(TEST_DIR, 'bad-pop.json');
  writeFileSync(path, '{"version": 1, "notpopulation": []}');
  assert.throws(() => loadPopulation(path), /invalid file format/);
  teardown();
});

test('serializeGenome produces plain number array', () => {
  const g = new Float32Array([0.1, -0.2, 0.3]);
  const arr = serializeGenome(g);
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 3);
  // Float32Array stores 0.1 as ~0.10000000149011612; compare
  // against the Float32Array values, not JS double literals.
  for (let i = 0; i < g.length; i++) {
    assert.ok(Math.abs(arr[i] - g[i]) < 1e-6);
  }
});

test('deserializeGenome produces Float32Array', () => {
  const arr = [0.1, -0.2, 0.3];
  const g = deserializeGenome(arr);
  assert.ok(g instanceof Float32Array);
  assert.deepEqual(g, new Float32Array([0.1, -0.2, 0.3]));
});
