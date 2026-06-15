/**
 * Trainer defaults — the single source of truth for every parameter
 * the trainer's `createTrainer({...})` factory uses when no override
 * is supplied.
 *
 * Extracted to its own module (was previously a top-level `const` in
 * `src/training/trainer.js`) so the game (`src/main.js`) can import
 * the architecture params (`inputSize`, `hiddenSize`, `outputSize`)
 * WITHOUT transitively pulling in the server-only worker pool.
 *
 * Why this matters: `src/training/trainer.js` imports
 * `./worker-pool.js` at the top level, which in turn imports
 * `./eval-worker.js`, which imports `node:worker_threads` — a
 * Node-only module that Vite can't bundle for the browser. Before
 * this split, the game's `import { DEFAULTS } from './training/trainer.js'`
 * pulled the worker pool into the browser bundle and broke
 * `npm run build` with `"parentPort" is not exported by
 * "__vite-browser-external"`.
 *
 * This module has zero runtime side effects and zero dependencies,
 * so it's safe to import from any environment (browser, Node,
 * Node worker, SSR).
 *
 * Importing:
 *   import { TRAINER_DEFAULTS } from './training/defaults.js';
 *
 * The trainer factory spreads these DEFAULTS internally, so passing
 * `{ hiddenSize: 24 }` to `createTrainer({...})` still works exactly
 * as before — only the *fallback* values now live here.
 *
 * @module training/defaults
 */

export const TRAINER_DEFAULTS = Object.freeze({
  // Population + genome architecture
  populationSize: 100,
  // inputSize: 13 (was 11; added velocity vx/vz so the
  // brain can distinguish "flying right" from "spinning right").
  inputSize: 13,
  hiddenSize: 12,
  outputSize: 3,
  // Per-episode config
  maxDurationS: 60,
  dt: 1 / 60,
  episodesPerGenome: 1,
  // Progress callback (overridden by callers that want real-time stats)
  onProgress: null,
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
  // Parallelism. 0 = single-threaded (no worker pool, useful for
  // tests + debugging), 1+ = number of worker threads. The server
  // defaults to `os.cpus().length - 1` (computed inside the pool).
  workerCount: 0,
});
