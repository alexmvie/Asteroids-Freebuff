/**
 * Re-export shim for backward compatibility.
 *
 * The UV unwrapping code is now organized as a single-responsibility
 * split under `src/geometry/uv/`, with one file per concern
 * (edge keys, island detection, Tutte, LSCM, ABF++, stretch,
 * seam detection, walking, packing, re-unwrap orchestrator).
 * See `src/geometry/uv/index.js` for the canonical barrel.
 *
 * This file re-exports every public symbol with the SAME NAME so
 * existing `import { X } from '../geometry/uv-unwrapping.js'`
 * statements continue to work unchanged. New code should prefer
 * importing from `'../geometry/uv/index.js'` directly.
 *
 * @fileoverview Compatibility shim. See `src/geometry/uv/` for the
 * authoritative implementation.
 */

export {
  // Edge keys
  buildEdgeKey,
  parseEdgeKey,
  // Island detection
  detectIslands,
  // Tutte embedding
  computeTutteEmbedding,
  // LSCM
  solveLSCM,
  // ABF++
  solveABFPlusPlus,
  // Edge-loop walking
  walkEdgeLoop,
  // Stretch
  computeStretch,
  stretchToColor,
  // Auto-seam
  autoDetectSeams,
  computeAllDihedrals,
  autoUnwrap,
  // Re-unwrap orchestrator
  reunwrap,
} from './uv/index.js';
