/**
 * Training system — neuroevolution for the AI ship controller.
 *
 * Barrel export so consumers can import from the directory:
 *   import { createTrainer, createNetwork, saveGenome } from './src/training/index.js';
 */

export { createNetwork, forward, genomeFromNetwork, networkFromGenome, serializeGenome, deserializeGenome } from './network.js';
export { createEvolution } from './evolution.js';
export { createTrainingEnvironment } from './environment.js';
export { createTrainer } from './trainer.js';
export { saveGenome, loadGenome, savePopulation, loadPopulation, trainingDataPath } from './persistence.js';
export { createTrainedAiBrain } from './ai-brain.js';
