#!/usr/bin/env node
/**
 * CLI training runner — `npm run train`.
 *
 * Loads a saved population (if one exists under `training-data/`)
 * or creates a fresh one, then runs neuroevolution for a configurable
 * number of generations. Prints a live progress table to stdout.
 * Saves the best genome and the full population every N generations.
 *
 * Usage:
 *   npm run train -- [--generations=100] [--population=100] [--hidden=12]
 *                    [--save-every=10] [--max-duration=60]
 *                    [--no-resume] [--quiet]
 *
 * Flags:
 *   --generations=N   how many generations to run (default 100)
 *   --population=N    population size (default 100)
 *   --hidden=N        hidden-layer neuron count (default 12)
 *   --save-every=N    checkpoint every N generations (default 10)
 *   --max-duration=N  episode duration in seconds (default 60)
 *   --no-resume       start from scratch even if a checkpoint exists
 *   --quiet           suppress per-generation table (just final stats)
 */

import { createTrainer } from '../src/training/trainer.js';
import {
  saveGenome,
  savePopulation,
  loadPopulation,
  trainingDataPath,
} from '../src/training/persistence.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    generations: 100,
    population: 100,
    hidden: 12,
    saveEvery: 10,
    maxDuration: 60,
    resume: true,
    quiet: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--generations=')) {
      args.generations = parseInt(arg.slice(14), 10);
    } else if (arg.startsWith('--population=')) {
      args.population = parseInt(arg.slice(13), 10);
    } else if (arg.startsWith('--hidden=')) {
      args.hidden = parseInt(arg.slice(9), 10);
    } else if (arg.startsWith('--save-every=')) {
      args.saveEvery = parseInt(arg.slice(13), 10);
    } else if (arg.startsWith('--max-duration=')) {
      args.maxDuration = parseInt(arg.slice(15), 10);
    } else if (arg === '--no-resume') {
      args.resume = false;
    } else if (arg === '--quiet') {
      args.quiet = true;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function fmt(num, digits = 1) {
  return num.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const POP_PATH = trainingDataPath('population.json');
  const BEST_PATH = trainingDataPath('best-genome.json');

  let trainer;
  let loaded = false;

  if (args.resume) {
    try {
      const { population, metadata } = loadPopulation(POP_PATH);
      // Validate hiddenSize matches CLI args so genomes have the correct size
      if (metadata.hiddenSize != null && metadata.hiddenSize !== args.hidden) {
        console.log(
          `⚠️  Saved population hiddenSize (${metadata.hiddenSize}) != CLI --hidden (${args.hidden}). Starting fresh.`
        );
        throw new Error('hiddenSize mismatch');
      }
      trainer = createTrainer({
        populationSize: args.population,
        hiddenSize: args.hidden,
        maxDurationS: args.maxDuration,
      });
      trainer.setPopulation(population);
      // Restore generation counter from saved metadata so checkpoints
      // preserve the true generation number.
      const loadedGen = typeof metadata.generation === 'number' ? metadata.generation : 0;
      trainer.setGeneration(loadedGen);
      console.log(`📦 Resumed from generation ${loadedGen} (${population.length} genomes)`);
      loaded = true;
    } catch (e) {
      if (!args.quiet) {
        console.log(`⚠️  No saved population found (${e.message}). Starting fresh.`);
      }
    }
  }

  if (!trainer) {
    trainer = createTrainer({
      populationSize: args.population,
      hiddenSize: args.hidden,
      maxDurationS: args.maxDuration,
    });
  }

  const startGen = trainer.getGeneration();
  const endGen = startGen + args.generations;

  if (!args.quiet) {
    console.log(`\n🧬 Training ${args.population} genomes × ${args.hidden} hidden neurons`);
    console.log(`   Episode duration: ${args.maxDuration}s  |  Save every: ${args.saveEvery} gens`);
    console.log(`   Generation  ${pad('Best', 10)}  ${pad('Avg', 10)}  ${pad('Best Ever', 10)}  Time`);
    console.log(`   ` + '─'.repeat(60));
  }

  let lastCheckpoint = startGen;

  for (let g = startGen; g < endGen; g++) {
    const t0 = performance.now();
    const result = trainer.runGeneration();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (!args.quiet) {
      console.log(
        `   ${pad(result.generation, 6)}  ${pad(fmt(result.bestFitness), 10)}  ${pad(fmt(result.avgFitness), 10)}  ${pad(fmt(trainer.getBestGenome().fitness), 10)}  ${elapsed}s`
      );
    }

    // Checkpoint
    if (result.generation - lastCheckpoint >= args.saveEvery || g === endGen - 1) {
      const best = trainer.getBestGenome();
      if (best.genome) {
        saveGenome(BEST_PATH, best.genome, {
          generation: result.generation,
          fitness: best.fitness,
          hiddenSize: args.hidden,
        });
      }
      savePopulation(POP_PATH, trainer.getPopulation(), {
        generation: result.generation,
        hiddenSize: args.hidden,
      });
      lastCheckpoint = result.generation;
      if (!args.quiet) {
        console.log(`   💾 Checkpoint saved at generation ${result.generation}`);
      }
    }
  }

  const best = trainer.getBestGenome();
  console.log(`\n🏆 Best fitness ever: ${fmt(best.fitness)} (gen ${trainer.getGeneration()})`);
  console.log(`   Best genome saved to ${BEST_PATH}`);
  console.log(`   Population saved to ${POP_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
