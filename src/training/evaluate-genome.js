/**
 * Shared per-genome evaluation loop. Used by both the sync trainer
 * (`trainer.js`) and the worker-thread path (`eval-worker.js`) so
 * the fitness formula lives in exactly one place. Any change to the
 * reward function or discretization thresholds automatically applies
 * to both code paths.
 *
 * Pure function of `(network, env, options)` — no closure state, no
 * async, no module-level state. The caller owns the env and the
 * network.
 */

/**
 * Discretize a raw network output [-1, 1] to {-1, 0, 1}.
 * Matches `src/training/ai-brain.js` and `src/entities/ai.js` thresholds.
 * @param {number} raw
 * @returns {-1 | 0 | 1}
 */
export function discretizeYaw(raw) {
  if (raw > 0.33) return 1;
  if (raw < -0.33) return -1;
  return 0;
}

/**
 * Derive the brain's mode from the same heuristic the hand-coded AI uses.
 * Pure — used by the trainer's `recordEpisode` (and the playback recorder)
 * so the recording captures what the brain "thinks" it's doing even
 * though the env is the source of truth for positions. Matches
 * `src/entities/ai.js`.
 *
 * @param {{ nearestAsteroidDist: number, powerupDist: number | null }} args
 * @returns {string}
 */
export function deriveMode({ nearestAsteroidDist, powerupDist }) {
  if (nearestAsteroidDist < 14) return 'dodge';
  if (nearestAsteroidDist < 90) return 'target';
  if (powerupDist != null && powerupDist < 200) return 'hunt';
  return 'wander';
}

/**
 * Run one episode of the env with the given network. Pure — doesn't
 * touch the env outside of `reset`/`step`/`getState`. Caller is
 * responsible for creating the env (one env per evaluation, or reuse
 * with `reset` between calls).
 *
 * @param {{
 *   network: { forward: (state: Float32Array) => Float32Array },
 *   env: {
 *     reset: (opts?: object) => void,
 *     step: (action: { yaw: number, thrust: boolean, fire: boolean }) => { done: boolean },
 *     getState: () => Float32Array,
 *   },
 *   options: {
 *     dt: number,
 *     maxDurationS: number,
 *     seedStrategy: 'vary' | 'fixed',
 *     movementReward: number,
 *     episodesPerGenome: number,
 *   },
 * }} args
 * @returns {number} fitness (averaged across episodes)
 */
export function evaluateGenome({ network, env, options }) {
  const { dt, maxDurationS, seedStrategy, movementReward, episodesPerGenome } = options;
  let totalFitness = 0;

  for (let ep = 0; ep < episodesPerGenome; ep++) {
    // Vary the per-episode seed so the brain generalizes. Math.random()
    // is acceptable here because the whole trainer is non-deterministic
    // (population init, GA selection, mutation all use Math.random).
    // When `seedStrategy === 'fixed'`, we use the env's default seed.
    const resetOpts = seedStrategy === 'vary'
      ? { systemSeed: Math.floor(Math.random() * 1e9) }
      : {};
    env.reset(resetOpts);

    let done = false;
    let steps = 0;
    const maxSteps = Math.ceil(maxDurationS / dt);

    while (!done && steps < maxSteps) {
      const state = env.getState();
      const outputs = network.forward(state);
      const yaw = discretizeYaw(outputs[0]);
      const thrust = outputs[1] > 0;
      const fire = outputs[2] > 0;
      const result = env.step({ yaw, thrust, fire });
      done = result.done;
      steps++;
    }

    // Fitness formula (single source of truth — also documented in
    // the dashboard's "Training insights" panel):
    //   score + survival*10 + powerups*100 + distance*movementReward
    // The `+ distance*movementReward` term is the v0.7.0 fix for
    // the "spin in place and shoot" local minimum.
    const score = env.getScore();
    const survival = env.getSurvivalTime();
    const powerups = env.getPowerupsCollected();
    const distance = env.getDistanceTraveled();
    const fitness = score + survival * 10 + powerups * 100 + distance * movementReward;
    totalFitness += fitness;
  }

  return totalFitness / episodesPerGenome;
}
