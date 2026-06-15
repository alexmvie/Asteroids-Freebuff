/**
 * Training loop — orchestrates neuroevolution episodes.
 *
 * For each generation:
 *   1. Every genome runs one (or more) training episodes.
 *   2. Fitness is computed from the episode outcome.
 *   3. The next generation is bred via the genetic algorithm.
 *
 * Public API:
 *   - `createTrainer(options)` → trainer
 *   - `trainer.runGeneration()` → { bestFitness, avgFitness, bestGenome }
 *   - `trainer.getGeneration()` → number
 *   - `trainer.getPopulation()` → Float32Array[]
 *   - `trainer.setPopulation(pop)` → resume from saved pop
 *   - `trainer.getBestGenome()` → { genome, fitness }
 *   - `trainer.recordEpisode(genome, opts)` → recorded episode for playback
 */

import { createEvolution } from './evolution.js';
import { createTrainingEnvironment } from './environment.js';
import { createNetwork, forward, genomeSize, networkFromGenome } from './network.js';
import { createEpisodeRecorder } from './recorder.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  populationSize: 100,
  // inputSize: 13 (was 11; added velocity vx/vz so the
  // brain can distinguish "flying right" from "spinning right").
  inputSize: 13,
  hiddenSize: 12,
  outputSize: 3,
  maxDurationS: 60,
  dt: 1 / 60,
  episodesPerGenome: 1,
  onProgress: null, // ({ generation, bestFitness, avgFitness }) => void
  // Per-episode seed strategy. `'vary'` picks a fresh random seed
  // for every episode so the brain can't memorize one field layout;
  // `'fixed'` uses the factory's `systemSeed` for every episode (the
  // old default, useful for reproducibility).
  seedStrategy: 'vary',
  // Movement reward coefficient. Added to the fitness for every unit
  // of distance traveled (sum of `speed * dt`). Small values (0.1–0.5)
  // discourage the "spin in place" local minimum without dominating
  // the score/survival/powerups rewards. Set to 0 to disable.
  movementReward: 0.5,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the brain's mode from the same heuristic the hand-coded AI uses.
 * Pure — used by `recordEpisode` so the recording captures what the brain
 * "thinks" it's doing even though the env is the source of truth for
 * positions. Matches `src/entities/ai.js`.
 *
 * @param {{ nearestAsteroidDist: number, powerupDist: number | null }} args
 * @returns {string}
 */
function deriveMode({ nearestAsteroidDist, powerupDist }) {
  if (nearestAsteroidDist < 14) return 'dodge';
  if (nearestAsteroidDist < 90) return 'target';
  if (powerupDist != null && powerupDist < 200) return 'hunt';
  return 'wander';
}

/**
 * Discretize a raw network output [-1, 1] to {-1, 0, 1}.
 * Matches `src/training/ai-brain.js` and `src/entities/ai.js` thresholds.
 * @param {number} raw
 * @returns {-1 | 0 | 1}
 */
function discretizeYaw(raw) {
  if (raw > 0.33) return 1;
  if (raw < -0.33) return -1;
  return 0;
}

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
 * }} opts
 */
export function createTrainer(opts = {}) {
  const {
    populationSize = DEFAULTS.populationSize,
    inputSize = DEFAULTS.inputSize,
    hiddenSize = DEFAULTS.hiddenSize,
    outputSize = DEFAULTS.outputSize,
    maxDurationS = DEFAULTS.maxDurationS,
    dt = DEFAULTS.dt,
    episodesPerGenome = DEFAULTS.episodesPerGenome,
    onProgress = DEFAULTS.onProgress,
    gaOptions = {},
    envOptions = {},
    seedStrategy = DEFAULTS.seedStrategy,
    movementReward = DEFAULTS.movementReward,
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

  // Create one reusable environment per trainer (not per episode —
  // we call `reset()` between episodes, which is cheap).
  const env = createTrainingEnvironment({
    maxDurationS,
    dt,
    ...envOptions,
  });

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Run a single episode with a given genome and return the fitness.
   * @param {Float32Array} genome
   * @returns {number}
   */
  function evaluateGenome(genome) {
    const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);
    let totalFitness = 0;

    for (let ep = 0; ep < episodesPerGenome; ep++) {
      // Vary the seed per episode so the brain generalizes. The
      // previous behavior (fixed seed) is preserved when
      // `seedStrategy === 'fixed'`. Math.random() is acceptable
      // here because training is non-deterministic by nature
      // (population init, GA selection, etc. all use Math.random).
      const resetOpts = seedStrategy === 'vary'
        ? { systemSeed: Math.floor(Math.random() * 1e9) }
        : {};
      env.reset(resetOpts);
      let done = false;
      let steps = 0;
      const maxSteps = Math.ceil(maxDurationS / dt);

      while (!done && steps < maxSteps) {
        const state = env.getState();
        const outputs = forward(network, state);

        const yaw = discretizeYaw(outputs[0]);
        const thrust = outputs[1] > 0;
        const fire = outputs[2] > 0;

        const result = env.step({ yaw, thrust, fire });
        done = result.done;
        steps++;
      }

      // Fitness: balanced (score + survival + power-ups + movement).
      // The movement reward (`+ distance * movementReward`) is the
      // key fix for the "spin in place and shoot" local minimum: a
      // brain that just spins has low distance traveled; a brain
      // that chases asteroids and power-ups has high distance. Small
      // coefficient (default 0.5) keeps movement from dominating
      // the score/survival/powerups rewards.
      const score = env.getScore();
      const survival = env.getSurvivalTime();
      const powerups = env.getPowerupsCollected();
      const distance = env.getDistanceTraveled();
      const fitness = score + survival * 10 + powerups * 100 + distance * movementReward;
      totalFitness += fitness;
    }

    return totalFitness / episodesPerGenome;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run one generation of evaluation + evolution.
   * @returns {{ generation: number, bestFitness: number, avgFitness: number, bestGenome: Float32Array }}
   */
  function runGeneration() {
    const fitnesses = new Float32Array(population.length);
    let sum = 0;
    let bestIdx = 0;

    for (let i = 0; i < population.length; i++) {
      const fit = evaluateGenome(population[i]);
      fitnesses[i] = fit;
      sum += fit;
      if (fit > fitnesses[bestIdx]) bestIdx = i;
    }

    const bestFitness = fitnesses[bestIdx];
    const avgFitness = sum / population.length;
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
    };
  }

  /**
   * Run N generations in a loop.
   * @param {number} count
   * @returns {{ generation: number, bestFitness: number, avgFitness: number, bestGenome: Float32Array }}
   */
  function runGenerations(count) {
    let result;
    for (let i = 0; i < count; i++) {
      result = runGeneration();
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

      // Discretize outputs
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
    inputSize = DEFAULTS.inputSize,
    hiddenSize = DEFAULTS.hiddenSize,
    outputSize = DEFAULTS.outputSize,
    maxDurationS = DEFAULTS.maxDurationS,
    dt = DEFAULTS.dt,
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
