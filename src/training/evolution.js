/**
 * Genetic algorithm for neuroevolution.
 *
 * Each genome is a flat Float32Array of neural-network weights. The GA
 * maintains a population, evaluates fitness per genome, and produces the
 * next generation via tournament selection, crossover, and Gaussian
 * mutation.
 *
 * Public API:
 *   - `createEvolution({ populationSize, genomeSize, options })`
 *   - `createInitialPopulation()` → Array<Float32Array>
 *   - `nextGeneration(population, fitnesses, options)` → Array<Float32Array>
 *
 * @module evolution
 */

const DEFAULTS = Object.freeze({
  populationSize: 100,
  elitismCount: 5,
  tournamentSize: 3,
  mutationRate: 0.15,
  mutationStrength: 0.3,
  crossoverRate: 0.7,
});

/**
 * @param {{
 *   populationSize?: number,
 *   genomeSize: number,
 *   elitismCount?: number,
 *   tournamentSize?: number,
 *   mutationRate?: number,
 *   mutationStrength?: number,
 *   crossoverRate?: number,
 * }} opts
 */
export function createEvolution(opts) {
  const {
    populationSize = DEFAULTS.populationSize,
    genomeSize,
    elitismCount = DEFAULTS.elitismCount,
    tournamentSize = DEFAULTS.tournamentSize,
    mutationRate = DEFAULTS.mutationRate,
    mutationStrength = DEFAULTS.mutationStrength,
    crossoverRate = DEFAULTS.crossoverRate,
  } = opts;

  if (!genomeSize || genomeSize <= 0) {
    throw new Error('createEvolution: genomeSize is required');
  }
  // Clamp to population size so small test populations don't crash.
  const effectiveElitismCount = Math.min(elitismCount, populationSize);

  /**
   * Create a random genome. Uses Xavier-ish init scale.
   * @returns {Float32Array}
   */
  function createRandomGenome() {
    const g = new Float32Array(genomeSize);
    for (let i = 0; i < genomeSize; i++) {
      g[i] = Math.random() * 2 - 1;
    }
    return g;
  }

  /**
   * Create the initial population.
   * @returns {Float32Array[]}
   */
  function createInitialPopulation() {
    const pop = new Array(populationSize);
    for (let i = 0; i < populationSize; i++) {
      pop[i] = createRandomGenome();
    }
    return pop;
  }

  /**
   * Pick the best genome from a random tournament.
   * @param {Float32Array[]} population
   * @param {Float32Array} fitnesses
   * @returns {Float32Array}
   */
  function tournamentSelect(population, fitnesses) {
    let bestIdx = Math.floor(Math.random() * population.length);
    let bestFitness = fitnesses[bestIdx];
    for (let i = 1; i < tournamentSize; i++) {
      const idx = Math.floor(Math.random() * population.length);
      if (fitnesses[idx] > bestFitness) {
        bestFitness = fitnesses[idx];
        bestIdx = idx;
      }
    }
    return population[bestIdx];
  }

  /**
   * Blend two parent genomes into a child.
   * @param {Float32Array} parentA
   * @param {Float32Array} parentB
   * @returns {Float32Array}
   */
  function crossover(parentA, parentB) {
    const child = new Float32Array(genomeSize);
    if (Math.random() < crossoverRate) {
      // Blend crossover (average)
      for (let i = 0; i < genomeSize; i++) {
        child[i] = (parentA[i] + parentB[i]) * 0.5;
      }
    } else {
      // Clone one parent
      const parent = Math.random() < 0.5 ? parentA : parentB;
      for (let i = 0; i < genomeSize; i++) {
        child[i] = parent[i];
      }
    }
    return child;
  }

  /**
   * Apply Gaussian mutation to a genome (in-place).
   * @param {Float32Array} genome
   */
  function mutate(genome) {
    for (let i = 0; i < genomeSize; i++) {
      if (Math.random() < mutationRate) {
        genome[i] += (Math.random() * 2 - 1) * mutationStrength;
      }
    }
  }

  /**
   * Build the next generation from a scored population.
   *
   * @param {Float32Array[]} population
   * @param {Float32Array} fitnesses — same length as population
   * @returns {Float32Array[]}
   */
  function nextGeneration(population, fitnesses) {
    if (population.length !== fitnesses.length) {
      throw new Error(
        `nextGeneration: population.length (${population.length}) !== fitnesses.length (${fitnesses.length})`
      );
    }

    // Sort indices by fitness descending
    const indices = population.map((_, i) => i);
    indices.sort((a, b) => fitnesses[b] - fitnesses[a]);

    const next = new Array(populationSize);

    // Elitism: keep the top N genomes unchanged
    for (let i = 0; i < effectiveElitismCount; i++) {
      next[i] = new Float32Array(population[indices[i]]);
    }

    // Fill the rest with crossover + mutation
    for (let i = effectiveElitismCount; i < populationSize; i++) {
      const parentA = tournamentSelect(population, fitnesses);
      const parentB = tournamentSelect(population, fitnesses);
      const child = crossover(parentA, parentB);
      mutate(child);
      next[i] = child;
    }

    return next;
  }

  return {
    createInitialPopulation,
    nextGeneration,
    createRandomGenome,
  };
}
