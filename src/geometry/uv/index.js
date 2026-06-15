/**
 * Public surface of the UV-unwrapping subdirectory.
 * Consumers should import from `src/geometry/uv/index.js` rather
 * than reaching into individual files.
 *
 * @fileoverview This barrel re-exports the public API of the
 * UV unwrapping subdirectory, which is a cleaner, more
 * single-responsibility split of the historical
 * `src/geometry/uv-unwrapping.js` monolith.
 */

// Edge keys (canonical edge identifier).
export { buildEdgeKey, parseEdgeKey } from './edge-keys.js';

// Island detection (mesh → connected components + boundary loops).
// `findAllBoundaryLoops` is intentionally NOT re-exported — it's an
// internal helper used by the Tutte / LSCM solvers.
export { detectIslands } from './island-detection.js';

// Tutte embedding (uniform-weight Laplacian). `tryPlaceBoundaryOnSquare`,
// `choleskyDecompose`, and `choleskySolve` are internal helpers and
// are NOT re-exported.
export { computeTutteEmbedding } from './tutte.js';

// LSCM (cotangent-weight conformal). `computeCotangentWeights`,
// `dijkstra`, and `findDiameterPair` are internal helpers and are
// NOT re-exported.
export { solveLSCM } from './lscm.js';

// ABF++ (angle-distortion minimizer). `compute3DAngles` and
// `computeAngleEnergy` are internal helpers and are NOT re-exported.
export { solveABFPlusPlus } from './abfpp.js';

// Stretch metric + heatmap.
export { computeStretch, stretchToColor } from './stretch.js';

// Auto-seam detection.
export { autoDetectSeams, computeAllDihedrals, autoUnwrap } from './seam-detection.js';

// Edge-loop walking (selection tool).
export { walkEdgeLoop } from './walk-edge-loop.js';

// Re-unwrap orchestrator. `packIslandsIntoGrid` is an internal
// helper and is NOT re-exported.
export { reunwrap } from './reunwrap.js';
