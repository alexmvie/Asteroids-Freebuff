/**
 * Worker thread script — runs one or more episodes for a single genome
 * and posts back the fitness. Mirrors the trainer's sync
 * `evaluateGenome` so the parallel path produces identical results to
 * the single-threaded path (modulo the Math.random() per-episode
 * seed, which is intentional — both paths use the same RNG call when
 * `seedStrategy === 'vary'`).
 *
 * Protocol (main → worker):
 *   { taskId: number, genome: number[], options: object }
 *
 * Protocol (worker → main):
 *   { taskId: number, fitness: number }  on success
 *   { taskId: number, error: string }    on exception
 *
 * This script is *only* meant to be spawned by `worker-pool.js` via
 * `new Worker(new URL('./eval-worker.js', import.meta.url))`. It
 * requires `parentPort` to be defined and throws otherwise.
 */

import { parentPort } from 'node:worker_threads';
import { createTrainingEnvironment } from './environment.js';
import { networkFromGenome, forward } from './network.js';
import { evaluateGenome } from './evaluate-genome.js';

if (!parentPort) {
  throw new Error('eval-worker.js must be run as a worker thread (spawned via worker_threads)');
}

/**
 * Adapter: build a network from a (possibly typed) genome array and
 * wrap `forward` in an object that the shared `evaluateGenome` helper
 * can call. One env per task (env state is per-evaluation, not shared
 * across the worker).
 */
function buildEvaluator(genomeArr, options) {
  const {
    inputSize, hiddenSize, outputSize,
    maxDurationS, dt, envOptions,
  } = options;

  const genome = genomeArr instanceof Float32Array
    ? genomeArr
    : new Float32Array(genomeArr);
  const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
  const env = createTrainingEnvironment({ maxDurationS, dt, ...envOptions });
  return { network, env, options };
}

parentPort.on('message', (msg) => {
  const { taskId, genome, options } = msg;
  try {
    const { network, env, options: opts } = buildEvaluator(genome, options);
    // Wrap the raw network + forward in a callable object so the
    // shared evaluate-genome.js helper can use it.
    const wrapped = { forward: (state) => forward(network, state) };
    const fitness = evaluateGenome({ network: wrapped, env, options: opts });
    parentPort.postMessage({ taskId, fitness });
  } catch (err) {
    // Send the error string back; the main thread will reject the
    // promise. Stack traces are omitted to keep the postMessage
    // payload small (structured-clone can't transfer Error objects).
    parentPort.postMessage({ taskId, error: String(err && err.message || err) });
  }
});
