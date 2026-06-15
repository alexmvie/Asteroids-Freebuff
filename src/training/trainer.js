/**
 * Training loop — orchestrates neuroevolution episodes.
 *
 * For each generation:
 *   1. Every genome runs one (or more) training episodes (in parallel
 *      across `workerCount` worker threads when available).
 *   2. Fitness is computed from the episode outcome.
 *   3. The next generation is bred via the genetic algorithm.
 *
 * Public API:
 *   - `createTrainer(options)` → trainer
 *   - `trainer.runGeneration()` → Promise<{...}> (async — uses worker pool)
 *   - `trainer.runGenerations(count)` → Promise<{...}> (async)
 *   - `trainer.getGeneration()` → number
 *   - `trainer.getPopulation()` → Float32Array[]
 *   - `trainer.setPopulation(pop)` → resume from saved pop
 *   - `trainer.getBestGenome()` → { genome, fitness }
 *   - `trainer.recordEpisode(genome, opts)` → recorded episode for playback (sync)
 *   - `trainer.close()` → terminate the worker pool (async)
 *   - `trainer.getConfig()` → the current effective config (for the dashboard's Live Config)
 */

import { createEvolution } from './evolution.js';
import { createTrainingEnvironment } from './environment.js';
import { createNetwork, forward, genomeSize, networkFromGenome } from './network.js';
import { createEpisodeRecorder } from './recorder.js';
import { createWorkerPool } from './worker-pool.js';
import { evaluateGenome, discretizeYaw, deriveMode } from './evaluate-genome.js';
import { TRAINER_DEFAULTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Defaults — sourced from `./defaults.js` so the game (`src/main.js`)
// can import the architecture params (`inputSize`/`hiddenSize`/`outputSize`)
// without transitively pulling in the server-only worker pool. See the
// JSDoc in `./defaults.js` for the full rationale.
// ---------------------------------------------------------------------------

/**
 * @deprecated Import from `./defaults.js` instead. Kept as a re-export
 * for backward compatibility with any external consumer that imports
 * `DEFAULTS` from `trainer.js` directly.
 */
export const DEFAULTS = TRAINER_DEFAULTS;

// ---------------------------------------------------------------------------
// Pure helpers (deriveMode, discretizeYaw, evaluateGenome all live in
// `./evaluate-genome.js` so the sync trainer path and the worker path
// share one implementation).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trainer factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   populationSize?: number,
 *   inputSize?: number,
 *   hiddenSize?: number,
 *   outputSize?: number,
 *   maxDurationS?: number,
 *   dt?: number,
 *   episodesPerGenome?: number,
 *   onProgress?: (stats: object) => void,
 *   gaOptions?: object,
 *   envOptions?: object,
 *   seedStrategy?: 'vary' | 'fixed',
 *   movementReward?: number,
 *   workerCount?: number,
 * }} opts
 */
export function createTrainer(opts = {}) {
  const {
    populationSize = TRAINER_DEFAULTS.populationSize,
    inputSize = TRAINER_DEFAULTS.inputSize,
    hiddenSize = TRAINER_DEFAULTS.hiddenSize,
    outputSize = TRAINER_DEFAULTS.outputSize,
    maxDurationS = TRAINER_DEFAULTS.maxDurationS,
    dt = TRAINER_DEFAULTS.dt,
    episodesPerGenome = TRAINER_DEFAULTS.episodesPerGenome,
    onProgress = TRAINER_DEFAULTS.onProgress,
    gaOptions = {},
    envOptions = {},
    seedStrategy = TRAINER_DEFAULTS.seedStrategy,
    movementReward = TRAINER_DEFAULTS.movementReward,
    workerCount = TRAINER_DEFAULTS.workerCount,
  } = opts;

  // Genome = flat weight array (single source of truth: network.genomeSize)
  const totalGenomeSize = genomeSize(inputSize, hiddenSize, outputSize);

  const evolution = createEvolution({
    populationSize,
    genomeSize: totalGenomeSize,
    ...gaOptions,
  });

  let population = evolution.createInitialPopulation();
  let generation = 0;
  let bestEver = { genome: null, fitness: -Infinity };

  // The single-threaded path needs one env (reused via reset() between
  // episodes). The multi-threaded path doesn't use this env — each
  // worker creates its own — so it's fine to leave it constructed
  // even when workerCount > 0.
  const env = createTrainingEnvironment({
    maxDurationS,
    dt,
    ...envOptions,
  });

  // Optional worker pool for parallel evaluation. Created lazily so
  // the cost is only paid when workerCount > 0.
  /** @type {ReturnType<typeof createWorkerPool> | null} */
  let pool = null;
  if (workerCount > 0) {
    pool = createWorkerPool({
      workerCount,
      onWorkerError: (err) => {
        // Surface to the console so the user sees the pool is
        // having trouble. We don't kill the trainer — the respawn
        // inside the pool keeps the worker count at the target.
        // eslint-disable-next-line no-console
        console.error(`[trainer] worker error: ${err.message}`);
      },
    });
  }

  // The static config that's safe to send to every worker. Built
  // once at factory time and reused for every task — saves
  // re-allocating the object on every generation.
  const workerOptions = {
    inputSize,
    hiddenSize,
    outputSize,
    maxDurationS,
    dt,
    seedStrategy,
    movementReward,
    episodesPerGenome,
    envOptions,
  };

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Run a single episode with a given genome and return the fitness.
   * Synchronous (single-threaded path). Delegates to the shared
   * `evaluateGenome` helper so the sync and worker paths share
   * one implementation.
   * @param {Float32Array} genome
   * @returns {number}
   */
  function evaluateGenomeSync(genome) {
    const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
    return evaluateGenome({
      network: { forward: (state) => forward(network, state) },
      env,
      options: {
        dt, maxDurationS, seedStrategy, movementReward, episodesPerGenome,
      },
    });
  }

  /**
   * Evaluate the whole population. Uses the worker pool when one is
   * available (workerCount > 0); otherwise falls back to the sync
   * loop on the main thread. Always returns fitnesses in the same
   * order as the input population.
   * @param {Float32Array[]} pop
   * @returns {Promise<Float32Array>}
   */
  async function evaluateAll(pop) {
    if (pool) {
      return pool.evaluateAll(pop, workerOptions);
    }
    // Sync fallback. Wrap in a resolved promise so the call site
    // is uniform.
    const fitnesses = new Float32Array(pop.length);
    for (let i = 0; i < pop.length; i++) {
      fitnesses[i] = evaluateGenomeSync(pop[i]);
    }
    return fitnesses;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run one generation of evaluation + evolution. Async because it
   * uses the worker pool when `workerCount > 0`.
   * @returns {Promise<{ generation: number, bestFitness: number, avgFitness: number, bestGenome: Float32Array, durationMs: number }>}
   */
  async function runGeneration() {
    const startMs = Date.now();
    const fitnesses = await evaluateAll(population);

    let sum = 0;
    let bestIdx = 0;
    for (let i = 0; i < fitnesses.length; i++) {
      sum += fitnesses[i];
      if (fitnesses[i] > fitnesses[bestIdx]) bestIdx = i;
    }

    const bestFitness = fitnesses[bestIdx];
    const avgFitness = sum / fitnesses.length;
    const bestGenome = new Float32Array(population[bestIdx]);

    if (bestFitness > bestEver.fitness) {
      bestEver = { genome: bestGenome, fitness: bestFitness };
    }

    if (onProgress) {
      onProgress({
        generation,
        bestFitness,
        avgFitness,
        bestEverFitness: bestEver.fitness,
        durationMs: Date.now() - startMs,
      });
    }

    // Evolve
    population = evolution.nextGeneration(population, fitnesses);
    generation++;

    return {
      generation,
      bestFitness,
      avgFitness,
      bestGenome,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Run N generations in a loop. Yields to the event loop between
   * generations so the HTTP server (in `train-server.js`) stays
   * responsive while training is in progress.
   * @param {number} count
   * @returns {Promise<{ generation: number, bestFitness: number, avgFitness: number, bestGenome: Float32Array, durationMs: number }>}
   */
  async function runGenerations(count) {
    let result;
    for (let i = 0; i < count; i++) {
      result = await runGeneration();
      // Yield so the server can process HTTP requests between
      // generations (e.g. /status, /stop, /playback).
      await new Promise((resolve) => setImmediate(resolve));
    }
    return result;
  }

  function getGeneration() {
    return generation;
  }

  function getPopulation() {
    return population;
  }

  /**
   * Replace the current population (used when loading a saved checkpoint).
   * @param {Float32Array[]} pop
   */
  function setPopulation(pop) {
    if (!Array.isArray(pop) || pop.length === 0) {
      throw new Error('setPopulation: expected non-empty array');
    }
    population = pop;
  }

  /**
   * Set the generation counter (used when resuming from a saved checkpoint).
   * @param {number} n
   */
  function setGeneration(n) {
    if (typeof n !== 'number' || n < 0) {
      throw new Error('setGeneration: expected non-negative number');
    }
    generation = n;
  }

  function getBestGenome() {
    return bestEver;
  }

  /**
   * The current effective config. Returned as a nested object so the
   * dashboard can render it as "Live Config" chips. Includes both
   * the user-supplied overrides AND the resolved GA options so
   * the user can see every parameter that's actually in use.
   *
   * GA values are read from the actual evolution instance (not
   * hardcoded) so the dashboard can never show stale defaults if
   * `evolution.js` DEFAULTS ever change.
   *
   * Architecture params (inputSize, hiddenSize, outputSize) are
   * nested under `architecture` so they render as a logical group
   * in the Live Config grid (the dashboard's `flattenConfig` turns
   * them into `architecture.inputSize`, `architecture.hiddenSize`,
   * `architecture.outputSize` chips).
   * @returns {object}
   */
  function getConfig() {
    return {
      populationSize,
      architecture: {
        inputSize,
        hiddenSize,
        outputSize,
      },
      maxDurationS,
      dt,
      episodesPerGenome,
      seedStrategy,
      movementReward,
      workerCount: pool ? pool.workerCount : 0,
      ga: evolution.getConfig(),
    };
  }

  /**
   * Terminate the worker pool. Call this when the trainer is no
   * longer needed (e.g. on server shutdown). Safe to call when
   * workerCount was 0 (no-op).
   */
  async function close() {
    if (pool) {
      await pool.close();
      pool = null;
    }
  }

  /**
   * Run one episode with a given genome and record every frame for playback.
   * Returns a recorder whose `.toJSON()` produces a browser-friendly frame buffer.
   *
   * The trainer's env does NOT have a recorder attached during normal training
   * (no per-frame recording overhead) — `recordEpisode` creates a fresh
   * recording env. This is also the only place where `brainOut` is passed
   * to `env.step()`, so the env can record the brain's actual mode rather
   * than re-deriving it.
   *
   * @param {Float32Array} genome
   * @param {object} [opts]
   * @param {number} [opts.episodeSeed] — override the system seed for variety
   * @param {number} [opts.maxDurationS] — override episode length (default: same as training)
   * @returns {{
   *   recorder: ReturnType<typeof createEpisodeRecorder>,
   *   fitness: number,
   *   score: number,
   *   survivalTime: number,
   *   powerupsCollected: number,
   *   died: boolean,
   * }}
   */
  function recordEpisode(genome, opts = {}) {
    const recorder = createEpisodeRecorder();
    const epMaxDurationS = opts.maxDurationS ?? maxDurationS;
    const recordEnv = createTrainingEnvironment({
      maxDurationS: epMaxDurationS,
      dt,
      recorder,
      ...(opts.episodeSeed != null ? { systemSeed: opts.episodeSeed } : {}),
      ...envOptions,
    });

    const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
    recordEnv.reset();
    let done = false;
    let steps = 0;
    const maxSteps = Math.ceil(epMaxDurationS / dt);

    while (!done && steps < maxSteps) {
      const state = recordEnv.getState();
      const outputs = forward(network, state);

      // Discretize outputs (shared helper — same thresholds as the worker)
      const yaw = discretizeYaw(outputs[0]);
      const thrust = outputs[1] > 0;
      const fire = outputs[2] > 0;

      // Compute distances for mode derivation (matches aiBrain.js)
      const shipPos = recordEnv.getShipPosition();
      let nearestADist = Infinity;
      for (const a of recordEnv.getAsteroids()) {
        const d = Math.hypot(a.position.x - shipPos.x, a.position.z - shipPos.z);
        if (d < nearestADist) nearestADist = d;
      }
      const pw = recordEnv.getPowerup();
      const powerupDist = pw
        ? Math.hypot(pw.position.x - shipPos.x, pw.position.z - shipPos.z)
        : null;
      const mode = deriveMode({ nearestAsteroidDist: nearestADist, powerupDist });

      const result = recordEnv.step({ yaw, thrust, fire, brainOut: { yaw, thrust, fire, mode } });
      done = result.done;
      steps++;
    }

    const score = recordEnv.getScore();
    const survivalTime = recordEnv.getSurvivalTime();
    const powerupsCollected = recordEnv.getPowerupsCollected();
    const died = recordEnv.hasDied();
    const fitness = score + survivalTime * 10 + powerupsCollected * 100;

    return { recorder, fitness, score, survivalTime, powerupsCollected, died };
  }

  return {
    runGeneration,
    runGenerations,
    getGeneration,
    getPopulation,
    setPopulation,
    setGeneration,
    getBestGenome,
    getConfig,
    close,
    recordEpisode,
  };
}

/**
 * Free-standing helper: record one episode with a given genome, returning a
 * serializable frame buffer. Use this from the server (avoids the wasted
 * `createTrainer({ populationSize: 1 })` + `setPopulation` dance) and from
 * tests. The trainer's `recordEpisode` is a thin wrapper around this.
 *
 * @param {{
 *   genome: Float32Array,
 *   inputSize?: number,
 *   hiddenSize?: number,
 *   outputSize?: number,
 *   maxDurationS?: number,
 *   dt?: number,
 *   episodeSeed?: number,
 *   envOptions?: object,
 * }} opts
 * @returns {{
 *   recorder: ReturnType<typeof createEpisodeRecorder>,
 *   fitness: number,
 *   score: number,
 *   survivalTime: number,
 *   powerupsCollected: number,
 *   died: boolean,
 * }}
 */
export function runRecordEpisode(opts) {
  const {
    genome,
    inputSize = TRAINER_DEFAULTS.inputSize,
    hiddenSize = TRAINER_DEFAULTS.hiddenSize,
    outputSize = TRAINER_DEFAULTS.outputSize,
    maxDurationS = TRAINER_DEFAULTS.maxDurationS,
    dt = TRAINER_DEFAULTS.dt,
    episodeSeed,
    envOptions = {},
  } = opts;

  const recorder = createEpisodeRecorder();
  const recordEnv = createTrainingEnvironment({
    maxDurationS,
    dt,
    recorder,
    ...(episodeSeed != null ? { systemSeed: episodeSeed } : {}),
    ...envOptions,
  });

  const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
  recordEnv.reset();
  let done = false;
  let steps = 0;
  const maxSteps = Math.ceil(maxDurationS / dt);

  while (!done && steps < maxSteps) {
    const state = recordEnv.getState();
    const outputs = forward(network, state);

    const yaw = discretizeYaw(outputs[0]);
    const thrust = outputs[1] > 0;
    const fire = outputs[2] > 0;

    const shipPos = recordEnv.getShipPosition();
    let nearestADist = Infinity;
    for (const a of recordEnv.getAsteroids()) {
      const d = Math.hypot(a.position.x - shipPos.x, a.position.z - shipPos.z);
      if (d < nearestADist) nearestADist = d;
    }
    const pw = recordEnv.getPowerup();
    const powerupDist = pw
      ? Math.hypot(pw.position.x - shipPos.x, pw.position.z - shipPos.z)
      : null;
    const mode = deriveMode({ nearestAsteroidDist: nearestADist, powerupDist });

    const result = recordEnv.step({ yaw, thrust, fire, brainOut: { yaw, thrust, fire, mode } });
    done = result.done;
    steps++;
  }

  const score = recordEnv.getScore();
  const survivalTime = recordEnv.getSurvivalTime();
  const powerupsCollected = recordEnv.getPowerupsCollected();
  const died = recordEnv.hasDied();
  const fitness = score + survivalTime * 10 + powerupsCollected * 100;

  return { recorder, fitness, score, survivalTime, powerupsCollected, died };
}
