/**
 * Public surface of the geometry module.
 * Consumers should import from `src/geometry/index.js` rather than
 * reaching into individual files, so we can refactor internals freely.
 */

export { Capsule } from './capsule.js';
export { NoisyIcosphere } from './noisy-icosphere.js';

// UV unwrapping — the canonical sources are now the
// single-responsibility files under `./uv/`. The historical
// `./uv-unwrapping.js` is a re-export shim kept for backward
// compatibility. We import from the shim here so the
// historical API surface is preserved exactly.
export {
  buildEdgeKey,
  parseEdgeKey,
  detectIslands,
  computeTutteEmbedding,
  solveLSCM,
  solveABFPlusPlus,
  walkEdgeLoop,
  computeStretch,
  stretchToColor,
  autoDetectSeams,
  autoUnwrap,
  reunwrap,
} from './uv-unwrapping.js';

// UV solver registry + cascade dispatcher.
export {
  SOLVER_IDS,
  SOLVER_LABELS,
  SOLVER_DESCRIPTIONS,
  solveWith,
  solveAutomatic,
} from './uv-solvers.js';
