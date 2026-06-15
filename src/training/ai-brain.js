/**
 * Trained AI brain — drop-in replacement for the hand-coded `aiBrainTick`.
 *
 * Loads a trained genome (flat weight array) and runs it through a neural
 * network every tick to decide yaw, thrust, and fire. The signature matches
 * `aiBrainTick` so `main.js` can swap between the rule-based brain and the
 * trained brain with a one-line change.
 *
 * Public API:
 *   - `createTrainedAiBrain({ genome, inputSize, hiddenSize, outputSize })`
 *     → brain object with `brain.tick(args)` method
 *   - `brain.tick(args)` → `{ yaw, thrust, mode, fire }` (same shape as `aiBrainTick`)
 */

import { createNetwork, forward, networkFromGenome } from './network.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Input size is fixed at 13 (was 11; added velocity vx/vz so the
// brain can distinguish "flying right" from "spinning right"). Any
// trained genome from before this change is incompatible — its
// length won't match the new architecture.
const DEFAULT_INPUT = 13;
const DEFAULT_HIDDEN = 12;
const DEFAULT_OUTPUT = 3;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   genome: Float32Array,
 *   inputSize?: number,
 *   hiddenSize?: number,
 *   outputSize?: number,
 * }} opts
 */
export function createTrainedAiBrain(opts) {
  const {
    genome,
    inputSize = DEFAULT_INPUT,
    hiddenSize = DEFAULT_HIDDEN,
    outputSize = DEFAULT_OUTPUT,
  } = opts;

  if (!genome || !(genome instanceof Float32Array)) {
    throw new Error('createTrainedAiBrain: genome must be a Float32Array');
  }

  const network = networkFromGenome(genome, inputSize, hiddenSize, outputSize);

  // Normalization constants (must match the training environment)
  const NORM_VEL = 200;
  const NORM_DIST = 500;
  const NORM_RADIUS = 8;

  /**
   * Decide what the AI should do this tick.
   *
   * The argument shape is the same as `aiBrainTick` so callers can swap
   * the two brains without changing the rest of the code.
   *
   * @param {{
   *   aiPos: { x: number, z: number },
   *   aiYaw: number,
   *   aiVel?: { x: number, z: number },
   *   asteroids: Array<{ getPosition: () => {x:number,z:number}, getRadius: () => number }>,
   *   powerupPos?: { x: number, z: number } | null,
   *   isLaserActive?: boolean,
   * }} args
   * @returns {{ yaw: number, thrust: boolean, mode: string, fire: boolean }}
   */
  function tick({
    aiPos,
    aiYaw,
    aiVel = { x: 0, z: 0 },
    asteroids,
    powerupPos = null,
    isLaserActive = false,
  }) {
    const features = new Float32Array(inputSize);

    // 0: speed
    const speed = Math.hypot(aiVel.x, aiVel.z);
    features[0] = speed / NORM_VEL;

    // 1-2: yaw sin/cos
    features[1] = Math.sin(aiYaw);
    features[2] = Math.cos(aiYaw);

    // 3-6: nearest asteroid
    let nearestA = null;
    let nearestADist = Infinity;
    for (const a of asteroids) {
      const p = a.getPosition();
      const dx = p.x - aiPos.x;
      const dz = p.z - aiPos.z;
      const d = Math.hypot(dx, dz);
      if (d < nearestADist) {
        nearestADist = d;
        nearestA = a;
      }
    }
    if (nearestA) {
      const p = nearestA.getPosition();
      features[3] = (p.x - aiPos.x) / NORM_DIST;
      features[4] = (p.z - aiPos.z) / NORM_DIST;
      features[5] = nearestADist / NORM_DIST;
      features[6] = nearestA.getRadius() / NORM_RADIUS;
    } else {
      features[3] = 0;
      features[4] = 0;
      features[5] = 1;
      features[6] = 0;
    }

    // 7-9: nearest power-up
    if (powerupPos && typeof powerupPos.x === 'number') {
      const dx = powerupPos.x - aiPos.x;
      const dz = powerupPos.z - aiPos.z;
      const d = Math.hypot(dx, dz);
      features[7] = dx / NORM_DIST;
      features[8] = dz / NORM_DIST;
      features[9] = d / NORM_DIST;
    } else {
      features[7] = 0;
      features[8] = 0;
      features[9] = 1;
    }

    // 10: laser active
    features[10] = isLaserActive ? 1 : 0;

    // 11-12: velocity direction. Lets the brain distinguish "flying
    // right" from "spinning right" — without this the brain defaults
    // to the "spin in place and shoot" local minimum. The input
    // architecture is now fixed at 13; any brain created with a
    // smaller inputSize is a stale (pre-velocity) genome.
    features[11] = aiVel.x / NORM_VEL;
    features[12] = aiVel.z / NORM_VEL;

    const outputs = forward(network, features);

    const yawRaw = outputs[0];
    const yaw = yawRaw > 0.33 ? 1 : yawRaw < -0.33 ? -1 : 0;
    const thrust = outputs[1] > 0;
    const fire = outputs[2] > 0;

    // Determine mode for debug / observability
    let mode = 'wander';
    if (nearestA && nearestADist < 14) {
      mode = 'dodge';
    } else if (nearestA && nearestADist < 90) {
      mode = 'target';
    } else if (powerupPos && (!nearestA || nearestADist > 500)) {
      // If powerup is close and no nearby asteroid threat, the brain might hunt it
      mode = 'hunt';
    }

    return {
      yaw,
      thrust,
      mode,
      fire,
    };
  }

  return {
    tick,
  };
}
