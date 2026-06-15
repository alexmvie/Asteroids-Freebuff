/**
 * UV solver wrapper for the Smart Unwrap button.
 *
 * The editor exposes a one-click "Smart Unwrap" action that hides
 * the complexity of which solver to use. Under the hood it's a
 * small cascade: try the best hand-rolled solver, measure the
 * stretch, and fall back to a different one if the result is bad.
 *
 * Two modes:
 *   - `solveAutomatic(geometry, options)` — runs the cascade,
 *     returns the best result + which solver was picked + the
 *     quality report (seam count, island count, max stretch).
 *   - `solveWith(geometry, solverId, options)` — runs a specific
 *     solver. Used by the Expert dropdown.
 *
 * Solver IDs:
 *   - 'square-tutte' — our new square-domain Tutte placement
 *     (1 loop on perimeter, 2 loops on top+bottom, 3+ fall back
 *     to per-loop circle arcs). Best for cylinder bodies and
 *     theta-graph boundaries.
 *   - 'circle-tutte' — the legacy per-loop circle arcs. Best for
 *     meshes with 3+ boundary cycles (torus boundaries, multi-holed
 *     surfaces) where the square placement doesn't apply.
 *   - 'smart-uv-project' — auto-detect seams (dihedral angle) +
 *     best solver for the shape. The "Blender Smart UV Project"
 *     equivalent.
 *
 * Future solver IDs (planned, not implemented):
 *   - 'lscm' — Least-Squares Conformal Mapping
 *   - 'abf++' — Angle-Based Flattening
 *
 * The cascade always prefers the square-Tutte solver because it
 * produces a clean rectangle for the common cylinder-body case
 * (the theta boundary). It falls back to the circle-Tutte solver
 * when the square placement can't handle the topology (3+ loops).
 *
 * Public API:
 *   - `solveWith(geometry, solverId, options)` — run a specific solver
 *   - `solveAutomatic(geometry, options)` — run the cascade
 *   - `SOLVER_IDS` — array of available solver IDs
 *   - `SOLVER_LABELS` — map of solverId → human label
 *   - `SOLVER_DESCRIPTIONS` — map of solverId → short description
 */

import {
  autoDetectSeams,
  computeStretch,
  detectIslands,
  reunwrap,
  solveABFPlusPlus,
  solveLSCM,
} from './uv-unwrapping.js';

/**
 * @typedef {Object} SolverResult
 * @property {Float64Array} u   per-vertex U coordinate
 * @property {Float64Array} v   per-vertex V coordinate
 * @property {Array} islands     the per-island data (faces, boundary, etc.)
 * @property {Set<number>} seamKeys  the seams used (vertex-edge keys)
 * @property {number} seamCount      number of seams
 * @property {number} islandCount    number of islands
 * @property {number} maxStretch     per-face max stretch metric
 * @property {string} solverId       which solver produced this result
 */

/** Available solver IDs in cascade order. */
export const SOLVER_IDS = ['square-tutte', 'circle-tutte', 'lscm', 'abf++', 'smart-uv-project'];

/** Human-readable labels for the solver dropdown. */
export const SOLVER_LABELS = {
  'square-tutte':       'Square Tutte (default — best for cylinders)',
  'circle-tutte':       'Circle Tutte (legacy — for torus / 3+ loops)',
  'lscm':               'LSCM (conformal — best angle preservation)',
  'abf++':              'ABF++ (angle-based — best for sharp creases)',
  'smart-uv-project':   'Smart UV Project (auto-seam + best solver)',
};

/** Short descriptions for tooltips. */
export const SOLVER_DESCRIPTIONS = {
  'square-tutte':
    'Square-domain Tutte placement. Produces a clean rectangle for cylinder bodies (the most common asteroid shape). Falls back to per-loop circle arcs for 3+ boundary loops.',
  'circle-tutte':
    'Legacy circle-domain Tutte placement. Each boundary cycle on its own arc of the unit circle. Use for meshes with 3+ boundary cycles (torus boundaries, multi-holed surfaces) where the square placement can\'t help.',
  'lscm':
    'Least-Squares Conformal Mapping. Conformal (angle-preserving) parameterization weighted by cotangent Laplacian. Eliminates the Tutte corner-pinch distortion on organic shapes. Best when you want the lowest stretch on a smooth, organic asteroid.',
  'abf++':
    'Angle-Based Flattening (ABF++). Iteratively minimizes per-triangle angle distortion by gradient descent on the UV positions, initialized from LSCM. Best on meshes with sharp creases (capsule junctions, faceted rocks) where LSCM still leaves visible distortion. Slower than LSCM (O(N*F) per iteration, ~20 iterations) but produces a parameterization that preserves the local angle of every triangle as closely as possible.',
  'smart-uv-project':
    'Blender-style "Smart UV Project": auto-detect seams by dihedral angle, then run the best solver. Quick and dirty, but works for most hard-surface shapes.',
};

/**
 * Run a specific solver. The solver is responsible for:
 *   - Determining the seam set (auto-detect or use `seamKeys`).
 *   - Computing the Tutte embedding.
 *   - Packing into [0, 1]².
 *   - Measuring stretch.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {string} solverId  one of SOLVER_IDS
 * @param {{ seamKeys?: Set<number>, thresholdDeg?: number, pack?: boolean }} [options]
 * @returns {SolverResult}
 */
export function solveWith(geometry, solverId, options = {}) {
  if (!geometry) throw new Error('solveWith: `geometry` is required');
  if (!SOLVER_IDS.includes(solverId)) {
    throw new Error(`solveWith: unknown solverId '${solverId}'; valid: ${SOLVER_IDS.join(', ')}`);
  }
  // For 'smart-uv-project' we auto-detect seams and dispatch to
  // the best solver for the shape. For the other solvers, the
  // caller can pass `seamKeys` to override the auto-detection.
  let seamKeys = options.seamKeys;
  if (solverId === 'smart-uv-project' || !seamKeys) {
    const threshold = options.thresholdDeg != null ? options.thresholdDeg : 30;
    seamKeys = autoDetectSeams(geometry, threshold);
  }
  // 'smart-uv-project' picks the best solver for the shape —
  // always ABF++ (the highest-quality real solver). ABF++
  // initializes from LSCM internally, so it gets both the
  // conformal starting point AND the angle-preservation
  // refinement.
  let effectiveSolverId = solverId;
  if (solverId === 'smart-uv-project') {
    effectiveSolverId = 'abf++';
  }
  // Dispatch to the right reunwrap option. The actual solve.
  // `square-tutte` and `circle-tutte` use the same reunwrap
  // function under the hood (the distinction is in the API
  // surface, not the implementation — reunwrap already does
  // square-Tutte for 1- and 2-loop boundaries and falls back to
  // circle-Tutte for 3+). `lscm` and `abf++` use different
  // per-island solvers (the cotangent-weighted conformal solve
  // and the angle-distortion gradient-descent solve,
  // respectively) via the `solver` option to reunwrap.
  let reunwrapOpts = { pack: options.pack !== false };
  if (options.margin != null) reunwrapOpts.margin = options.margin;
  if (effectiveSolverId === 'lscm') {
    reunwrapOpts.solver = 'lscm';
  } else if (effectiveSolverId === 'abf++') {
    reunwrapOpts.solver = 'abf++';
  }
  const result = reunwrap(geometry, seamKeys, reunwrapOpts);
  // Measure stretch.
  const stretch = computeStretch(geometry, result);
  let maxStretch = 0;
  for (let i = 0; i < stretch.length; i++) {
    if (stretch[i] > maxStretch) maxStretch = stretch[i];
  }
  return {
    u: result.u,
    v: result.v,
    islands: result.islands,
    seamKeys,
    seamCount: seamKeys.size,
    islandCount: result.islands.length,
    maxStretch,
    solverId: effectiveSolverId,
  };
}

/**
 * Run the solver cascade. Tries the best solver first; if the
 * stretch is above the threshold, tries the next. Returns the
 * best result + the report.
 *
 * The cascade order is:
 *   1. square-tutte (default — best for cylinders)
 *   2. circle-tutte (for 3+ loops where square doesn't apply)
 *   3. smart-uv-project (auto-seam — for when the user has no
 *      seams and wants a quick result)
 *
 * Stretch thresholds:
 *   - `good` (< 10): result is "good", stop the cascade
 *   - `acceptable` (< 50): result is "OK", stop the cascade
 *   - `bad` (>= 50): try the next solver
 *
 * These are intentionally generous. The square-Tutte placement
 * has a fundamental ~28-460 stretch limit (area compression +
 * corner-pinch, see SPEC.md §12), so a "bad" threshold of 50
 * lets square-Tutte pass for most cases while still catching
 * genuinely broken results.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {{ seamKeys?: Set<number>, thresholdDeg?: number, stretchBudget?: number }} [options]
 * @returns {SolverResult & { tried: string[] }}
 */
export function solveAutomatic(geometry, options = {}) {
  if (!geometry) throw new Error('solveAutomatic: `geometry` is required');
  const stretchBudget = options.stretchBudget != null ? options.stretchBudget : 50;
  const cascadeOrder = ['square-tutte', 'circle-tutte', 'lscm', 'abf++'];
  const tried = [];
  let bestResult = null;
  for (const solverId of cascadeOrder) {
    tried.push(solverId);
    const result = solveWith(geometry, solverId, options);
    if (result.maxStretch <= stretchBudget) {
      // Good enough — stop the cascade.
      return { ...result, tried };
    }
    // Track the best so far (in case none of the solvers pass
    // the threshold, return the lowest-stretch one).
    if (!bestResult || result.maxStretch < bestResult.maxStretch) {
      bestResult = result;
    }
  }
  // None of the solvers passed the budget — return the best.
  return { ...bestResult, tried };
}
