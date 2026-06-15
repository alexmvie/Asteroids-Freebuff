/**
 * Training system — neuroevolution for the AI ship controller.
 *
 * Barrel export so consumers can import from the directory:
 *   import { createTrainer, createNetwork, saveGenome } from './src/training/index.js';
 */

export { createNetwork, forward, genomeFromNetwork, networkFromGenome, serializeGenome, deserializeGenome, genomeSize } from './network.js';
export { createEvolution } from './evolution.js';
export { createTrainingEnvironment } from './environment.js';
export { createWorkerPool } from './worker-pool.js';
export { createTrainer, runRecordEpisode } from './trainer.js';
export { TRAINER_DEFAULTS } from './defaults.js';
export { saveGenome, loadGenome, savePopulation, loadPopulation, trainingDataPath } from './persistence.js';
export { createTrainedAiBrain } from './ai-brain.js';
