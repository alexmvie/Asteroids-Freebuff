/**
 * Node `worker_threads` pool for parallel genome evaluation.
 *
 * The trainer's hot loop is `population.map(evaluateGenome)` — each
 * genome runs one (or more) full episodes of the training env. The
 * episodes are completely independent (no shared state between
 * genomes), so they're embarrassingly parallel. This pool distributes
 * the work across N workers (default: `os.cpus().length - 1` to
 * leave one core for the main thread + the HTTP server).
 *
 * The pool's public API is tiny:
 *   - `evaluateAll(genomes, options)` → Float32Array of fitnesses
 *   - `close()`                      → terminate all workers
 *   - `workerCount`                  → how many workers were spawned
 *
 * The `options` object is passed verbatim to every worker task, so
 * the static config (architecture, episode length, env options, …)
 * is only shipped once per generation, not per genome.
 *
 * Worker crash recovery: if a worker emits an `error` event, it's
 * terminated and re-spawned. Tasks that were in-flight on the dead
 * worker will hang forever — for now we just log and let the
 * surrounding training loop notice. (In practice worker crashes are
 * rare; the env is pure and the network is pure; a crash usually
 * means a bug, not a runtime issue.)
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * @param {{
 *   workerCount?: number,
 *   onWorkerError?: (err: Error, workerIdx: number) => void,
 * }} [opts]
 */
export function createWorkerPool(opts = {}) {
  const requestedCount = opts.workerCount ?? defaultWorkerCount();
  const workerCount = Math.max(1, Math.floor(requestedCount));
  const workers = new Array(workerCount);
  let nextWorkerIdx = 0;
  let nextTaskId = 0;
  let closed = false;
  /** @type {Map<number, { resolve: (n: number) => void, reject: (e: Error) => void, workerIdx: number }>} */
  const pending = new Map();

  function spawn(workerIdx) {
    const worker = new Worker(new URL('./eval-worker.js', import.meta.url));
    worker.on('message', (msg) => {
      const task = pending.get(msg.taskId);
      if (!task) return; // already cleaned up (e.g. after close)
      pending.delete(msg.taskId);
      if (msg.error) {
        task.reject(new Error(msg.error));
      } else {
        task.resolve(msg.fitness);
      }
    });
    worker.on('error', (err) => {
      if (opts.onWorkerError) {
        try { opts.onWorkerError(err, workerIdx); } catch (_) { /* ignore */ }
      }
      // Reject ONLY the tasks that were assigned to THIS worker.
      // Tasks on healthy sibling workers stay alive and resolve
      // normally. (Previously we rejected the entire pending map,
      // which discarded a whole generation's worth of work on any
      // single worker crash.)
      for (const [taskId, task] of pending) {
        if (task.workerIdx === workerIdx) {
          pending.delete(taskId);
          task.reject(err);
        }
      }
      // Respawn so the pool stays at the requested size.
      try { spawn(workerIdx); } catch (e) { /* swallow */ }
    });
    workers[workerIdx] = worker;
    return worker;
  }

  for (let i = 0; i < workerCount; i++) spawn(i);

  /**
   * Submit one genome for evaluation. Returns a promise that resolves
   * with the fitness (averaged across episodesPerGenome).
   * @param {Float32Array} genome
   * @param {object} options
   */
  function submit(genome, options) {
    return new Promise((resolve, reject) => {
      const taskId = nextTaskId++;
      // Track which worker this task was assigned to so the error
      // handler can reject only the dead worker's tasks (and leave
      // tasks on healthy workers alone). See spawn() above.
      const workerIdx = nextWorkerIdx;
      nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
      pending.set(taskId, { resolve, reject, workerIdx });
      const payload = {
        taskId,
        // postMessage's structured-clone handles Float32Array
        // natively — no need to convert to a plain array.
        genome,
        options,
      };
      workers[workerIdx].postMessage(payload);
    });
  }

  /**
   * Evaluate a whole population in parallel. Returns fitnesses in the
   * same order as the input genomes.
   * @param {Float32Array[]} genomes
   * @param {object} options
   * @returns {Promise<Float32Array>}
   */
  async function evaluateAll(genomes, options) {
    const promises = genomes.map((g) => submit(g, options));
    const results = await Promise.all(promises);
    return new Float32Array(results);
  }

  /**
   * Terminate all workers. Safe to call multiple times. Any tasks
   * still in the pending map are rejected with a `WorkerPoolClosed`
   * error so the caller's promise doesn't hang forever.
   */
  async function close() {
    if (closed) return;
    closed = true;
    const err = new Error('WorkerPoolClosed: pool was closed before this task completed');
    for (const [taskId, task] of pending) {
      pending.delete(taskId);
      task.reject(err);
    }
    await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
  }

  return { evaluateAll, close, workerCount };
}

/**
 * Default worker count: `cpus - 1` so the main thread + HTTP server
 * always have at least one core. On single-core machines, fall back
 * to 1 worker (no parallelism, but still functional). Returns 1 if
 * `os.cpus()` is unavailable (e.g. some test environments).
 */
function defaultWorkerCount() {
  try {
    const n = os.cpus()?.length ?? 1;
    return Math.max(1, n - 1);
  } catch (_) {
    return 1;
  }
}
