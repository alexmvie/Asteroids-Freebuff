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
 */

import { createEvolution } from './evolution.js';
import { createTrainingEnvironment } from './environment.js';
import { createNetwork, forward, networkFromGenome } from './network.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  populationSize: 100,
  inputSize: 11,
  hiddenSize: 12,
  outputSize: 3,
  maxDurationS: 60,
  dt: 1 / 60,
  episodesPerGenome: 1,
  onProgress: null, // ({ generation, bestFitness, avgFitness }) => void
});

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
  } = opts;

  // Genome = flat weight array
  const genomeSize =
    inputSize * hiddenSize +
    hiddenSize +
    hiddenSize * outputSize +
    outputSize;

  const evolution = createEvolution({
    populationSize,
    genomeSize,
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
      env.reset();
      let done = false;
      let steps = 0;
      const maxSteps = Math.ceil(maxDurationS / dt);

      while (!done && steps < maxSteps) {
        const state = env.getState();
        const outputs = forward(network, state);

        // Discretize outputs
        const yawRaw = outputs[0];
        const yaw = yawRaw > 0.33 ? 1 : yawRaw < -0.33 ? -1 : 0;
        const thrust = outputs[1] > 0;
        const fire = outputs[2] > 0;

        const result = env.step({ yaw, thrust, fire });
        done = result.done;
        steps++;
      }

      // Fitness: balanced (score + survival + power-ups)
      const score = env.getScore();
      const survival = env.getSurvivalTime();
      const powerups = env.getPowerupsCollected();
      const fitness = score + survival * 10 + powerups * 100;
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

  return {
    runGeneration,
    runGenerations,
    getGeneration,
    getPopulation,
    setPopulation,
    getBestGenome,
  };
}
