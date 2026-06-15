/**
 * Tiny feedforward neural network for the AI training system.
 *
 * Architecture:
 *   - One hidden layer with tanh activation.
 *   - Output layer with tanh (so outputs are in [-1, 1]).
 *   - The caller discretizes outputs (e.g. yaw → -1/0/1, thrust → 0/1).
 *
 * The genome is a flat Float32Array of all weights and biases. This
 * makes crossover and mutation trivial (just operate on the array).
 *
 * Public API:
 *   - `createNetwork(inputSize, hiddenSize, outputSize)` → network
 *   - `forward(network, inputs)` → outputs (Float32Array)
 *   - `genomeFromNetwork(network)` → Float32Array (shallow copy)
 *   - `networkFromGenome(genome, inputSize, hiddenSize, outputSize)` → network
 *   - `serializeGenome(genome)` → number[] (for JSON)
 *   - `deserializeGenome(data)` → Float32Array
 */

/**
 * @typedef {Object} Network
 * @property {number} inputSize
 * @property {number} hiddenSize
 * @property {number} outputSize
 * @property {Float32Array} weights — flat array of all parameters
 * @property {number} _w1Start — index of first hidden weight
 * @property {number} _b1Start — index of first hidden bias
 * @property {number} _w2Start — index of first output weight
 * @property {number} _b2Start — index of first output bias
 */

/**
 * @param {number} inputSize
 * @param {number} hiddenSize
 * @param {number} outputSize
 * @returns {Network}
 */
export function createNetwork(inputSize, hiddenSize, outputSize) {
  const w1Count = inputSize * hiddenSize;
  const b1Count = hiddenSize;
  const w2Count = hiddenSize * outputSize;
  const b2Count = outputSize;
  const total = w1Count + b1Count + w2Count + b2Count;

  const weights = new Float32Array(total);
  // Xavier-ish init: scale by sqrt(2 / inputSize)
  const scale = Math.sqrt(2 / inputSize);
  for (let i = 0; i < total; i++) {
    weights[i] = (Math.random() * 2 - 1) * scale;
  }

  return {
    inputSize,
    hiddenSize,
    outputSize,
    weights,
    _w1Start: 0,
    _b1Start: w1Count,
    _w2Start: w1Count + b1Count,
    _b2Start: w1Count + b1Count + w2Count,
  };
}

/**
 * Run a forward pass.
 *
 * @param {Network} network
 * @param {Float32Array|number[]} inputs — length must equal inputSize
 * @returns {Float32Array} — length equals outputSize
 */
export function forward(network, inputs) {
  const { inputSize, hiddenSize, outputSize, weights } = network;
  const { _w1Start, _b1Start, _w2Start, _b2Start } = network;

  // Hidden layer
  const hidden = new Float32Array(hiddenSize);
  for (let h = 0; h < hiddenSize; h++) {
    let sum = weights[_b1Start + h];
    const wBase = _w1Start + h * inputSize;
    for (let i = 0; i < inputSize; i++) {
      sum += inputs[i] * weights[wBase + i];
    }
    hidden[h] = Math.tanh(sum);
  }

  // Output layer
  const outputs = new Float32Array(outputSize);
  for (let o = 0; o < outputSize; o++) {
    let sum = weights[_b2Start + o];
    const wBase = _w2Start + o * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) {
      sum += hidden[h] * weights[wBase + h];
    }
    outputs[o] = Math.tanh(sum);
  }

  return outputs;
}

/**
 * @param {Network} network
 * @returns {Float32Array} shallow copy of the weights
 */
export function genomeFromNetwork(network) {
  return new Float32Array(network.weights);
}

/**
 * Reconstruct a network from a genome (weight array).
 *
 * @param {Float32Array} genome
 * @param {number} inputSize
 * @param {number} hiddenSize
 * @param {number} outputSize
 * @returns {Network}
 */
export function networkFromGenome(genome, inputSize, hiddenSize, outputSize) {
  const w1Count = inputSize * hiddenSize;
  const b1Count = hiddenSize;
  const w2Count = hiddenSize * outputSize;
  const b2Count = outputSize;
  const total = w1Count + b1Count + w2Count + b2Count;
  if (genome.length !== total) {
    throw new Error(
      `networkFromGenome: expected ${total} weights, got ${genome.length}`
    );
  }
  return {
    inputSize,
    hiddenSize,
    outputSize,
    weights: genome,
    _w1Start: 0,
    _b1Start: w1Count,
    _w2Start: w1Count + b1Count,
    _b2Start: w1Count + b1Count + w2Count,
  };
}

/**
 * Convert a genome to a plain number array for JSON serialization.
 * @param {Float32Array} genome
 * @returns {number[]}
 */
export function serializeGenome(genome) {
  const arr = new Array(genome.length);
  for (let i = 0; i < genome.length; i++) arr[i] = genome[i];
  return arr;
}

/**
 * @param {number[]} data
 * @returns {Float32Array}
 */
export function deserializeGenome(data) {
  if (!Array.isArray(data)) throw new Error('deserializeGenome: expected array');
  return new Float32Array(data);
}
