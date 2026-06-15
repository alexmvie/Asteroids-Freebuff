/**
 * Tests for trainer.runRecordEpisode and trainer.recordEpisode.
 *
 * Verifies that the recording hook captures frames for an entire episode
 * and returns the same fitness breakdown as the regular training path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainer, runRecordEpisode } from '../../src/training/trainer.js';
import { createNetwork, genomeFromNetwork } from '../../src/training/network.js';

function makeGenome() {
  const net = createNetwork(11, 12, 3);
  return genomeFromNetwork(net);
}

test('runRecordEpisode records frames for a full episode', () => {
  const genome = makeGenome();
  const result = runRecordEpisode({
    genome,
    maxDurationS: 2, // 2 seconds = 120 frames at 60fps
    dt: 1 / 60,
  });
  // Should have recorded at least most of the frames (episode may end early
  // from a collision; for a random brain, usually survives ~2s on the small field)
  assert.ok(result.recorder.frames.length > 0, 'should record at least one frame');
  // Recorded frames should be in ascending time order
  const times = result.recorder.frames.map((f) => f.t);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], `frame ${i} time ${times[i]} should be >= ${times[i - 1]}`);
  }
});

test('runRecordEpisode returns the same fitness breakdown shape as evaluateGenome', () => {
  const genome = makeGenome();
  const result = runRecordEpisode({
    genome,
    maxDurationS: 2,
    dt: 1 / 60,
  });
  // Required fields
  assert.equal(typeof result.fitness, 'number');
  assert.equal(typeof result.score, 'number');
  assert.equal(typeof result.survivalTime, 'number');
  assert.equal(typeof result.powerupsCollected, 'number');
  assert.equal(typeof result.died, 'boolean');
  // Fitness = score + survivalTime * 10 + powerupsCollected * 100
  const expected = result.score + result.survivalTime * 10 + result.powerupsCollected * 100;
  assert.ok(Math.abs(result.fitness - expected) < 1e-3);
});

test('runRecordEpisode toJSON produces browser-friendly frame data', () => {
  const genome = makeGenome();
  const result = runRecordEpisode({
    genome,
    maxDurationS: 1,
    dt: 1 / 60,
  });
  const json = result.recorder.toJSON();
  assert.equal(json.version, 1);
  assert.equal(json.frameCount, result.recorder.frames.length);
  assert.ok(Array.isArray(json.frames));
  // Each frame should have the compact schema
  for (const f of json.frames) {
    assert.equal(typeof f.t, 'number');
    assert.ok(f.s && typeof f.s.x === 'number' && typeof f.s.z === 'number');
    assert.ok(Array.isArray(f.a));
    assert.ok(Array.isArray(f.b));
    assert.ok(f.p === null || (typeof f.p.x === 'number' && typeof f.p.z === 'number'));
    assert.ok([0, 1].includes(f.L));
    assert.ok([0, 1].includes(f.F));
    assert.ok([-1, 0, 1].includes(f.y));
    assert.ok([0, 1].includes(f.T));
    assert.ok([0, 1].includes(f.f));
    assert.ok([0, 1, 2, 3].includes(f.m));
    assert.equal(typeof f.S, 'number');
  }
});

test('runRecordEpisode honors episodeSeed for variety', () => {
  const genome = makeGenome();
  const a = runRecordEpisode({ genome, maxDurationS: 1, dt: 1 / 60, episodeSeed: 1 });
  const b = runRecordEpisode({ genome, maxDurationS: 1, dt: 1 / 60, episodeSeed: 2 });
  // Different seeds → different power-up spawn positions at minimum
  const aP = a.recorder.frames.find((f) => f.p != null);
  const bP = b.recorder.frames.find((f) => f.p != null);
  if (aP && bP) {
    assert.notDeepEqual(aP.p, bP.p, 'different seeds should yield different power-up positions');
  }
});

test('trainer.recordEpisode returns same shape as runRecordEpisode', () => {
  const trainer = createTrainer({
    populationSize: 4,
    hiddenSize: 12,
    maxDurationS: 1,
  });
  // Use a known genome (the first one in the initial population)
  const pop = trainer.getPopulation();
  const result = trainer.recordEpisode(pop[0], { maxDurationS: 1 });
  assert.ok(result.recorder);
  assert.equal(typeof result.fitness, 'number');
  assert.equal(typeof result.score, 'number');
  assert.equal(typeof result.survivalTime, 'number');
  assert.equal(typeof result.died, 'boolean');
  assert.ok(result.recorder.frames.length > 0);
});

test('trainer.recordEpisode respects custom maxDurationS', () => {
  const trainer = createTrainer({
    populationSize: 2,
    hiddenSize: 12,
    maxDurationS: 60,
  });
  const pop = trainer.getPopulation();
  const result = trainer.recordEpisode(pop[0], { maxDurationS: 2 });
  // Total recorded time should not exceed 2s + 1 frame
  const lastFrame = result.recorder.frames[result.recorder.frames.length - 1];
  assert.ok(lastFrame.t <= 2.1, `last frame time ${lastFrame.t} should be <= 2.1s`);
});
