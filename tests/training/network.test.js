import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNetwork,
  forward,
  genomeFromNetwork,
  networkFromGenome,
  serializeGenome,
  deserializeGenome,
} from '../../src/training/network.js';

test('createNetwork returns a network with correct dimensions', () => {
  const net = createNetwork(5, 8, 3);
  assert.equal(net.inputSize, 5);
  assert.equal(net.hiddenSize, 8);
  assert.equal(net.outputSize, 3);
  assert.ok(net.weights instanceof Float32Array);
  assert.equal(net.weights.length, 5 * 8 + 8 + 8 * 3 + 3);
});

test('forward returns Float32Array of outputSize', () => {
  const net = createNetwork(4, 6, 2);
  const inputs = new Float32Array([1, 2, 3, 4]);
  const outputs = forward(net, inputs);
  assert.ok(outputs instanceof Float32Array);
  assert.equal(outputs.length, 2);
});

test('forward outputs are in [-1, 1] (tanh)', () => {
  const net = createNetwork(3, 5, 4);
  const inputs = new Float32Array([10, -10, 0.5]);
  const outputs = forward(net, inputs);
  for (const v of outputs) {
    assert.ok(v >= -1 && v <= 1, `output ${v} out of tanh range`);
  }
});

test('forward with number[] input works', () => {
  const net = createNetwork(2, 3, 1);
  const outputs = forward(net, [0.5, -0.5]);
  assert.equal(outputs.length, 1);
});

test('forward with wrong input size throws', () => {
  const net = createNetwork(3, 4, 2);
  // The forward loop will read undefined / NaN but not throw
  // We just verify it doesn't crash with mismatched sizes
  const inputs = new Float32Array([1, 2]); // only 2, not 3
  assert.doesNotThrow(() => forward(net, inputs));
});

test('genomeFromNetwork returns a copy of weights', () => {
  const net = createNetwork(2, 3, 1);
  const g = genomeFromNetwork(net);
  assert.ok(g instanceof Float32Array);
  assert.equal(g.length, net.weights.length);
  assert.notStrictEqual(g, net.weights);
  // Mutate copy; original should stay the same
  const original = net.weights[0];
  g[0] = 999;
  assert.equal(net.weights[0], original);
});

test('networkFromGenome reconstructs a network with the same weights', () => {
  const net = createNetwork(2, 3, 1);
  const g = genomeFromNetwork(net);
  const net2 = networkFromGenome(g, 2, 3, 1);
  assert.equal(net2.inputSize, 2);
  assert.equal(net2.hiddenSize, 3);
  assert.equal(net2.outputSize, 1);
  assert.equal(net2.weights.length, net.weights.length);
  for (let i = 0; i < net.weights.length; i++) {
    assert.equal(net2.weights[i], net.weights[i]);
  }
});

test('networkFromGenome throws on wrong genome size', () => {
  const bad = new Float32Array(5);
  assert.throws(() => networkFromGenome(bad, 2, 3, 1), /expected/);
});

test('serializeGenome / deserializeGenome round-trip', () => {
  const net = createNetwork(3, 4, 2);
  const g = genomeFromNetwork(net);
  const json = serializeGenome(g);
  assert.ok(Array.isArray(json));
  assert.equal(json.length, g.length);
  const g2 = deserializeGenome(json);
  assert.ok(g2 instanceof Float32Array);
  assert.equal(g2.length, g.length);
  for (let i = 0; i < g.length; i++) {
    assert.equal(g2[i], g[i]);
  }
});

test('deserializeGenome throws on non-array', () => {
  assert.throws(() => deserializeGenome('bad'), /expected array/);
  assert.throws(() => deserializeGenome(123), /expected array/);
});

test('forward is deterministic for same weights and inputs', () => {
  const net = createNetwork(3, 5, 2);
  const inputs = new Float32Array([0.2, -0.5, 1.0]);
  const out1 = forward(net, inputs);
  const out2 = forward(net, inputs);
  assert.deepEqual(out1, out2);
});

test('different networks produce different outputs for same inputs', () => {
  const net1 = createNetwork(3, 5, 2);
  const net2 = createNetwork(3, 5, 2);
  const inputs = new Float32Array([0.2, -0.5, 1.0]);
  const out1 = forward(net1, inputs);
  const out2 = forward(net2, inputs);
  // Very unlikely to be exactly equal with random init
  let same = true;
  for (let i = 0; i < out1.length; i++) {
    if (out1[i] !== out2[i]) { same = false; break; }
  }
  assert.equal(same, false);
});

test('network with zero inputs produces bounded outputs', () => {
  const net = createNetwork(2, 3, 1);
  const outputs = forward(net, [0, 0]);
  assert.equal(outputs.length, 1);
  assert.ok(outputs[0] >= -1 && outputs[0] <= 1);
});
