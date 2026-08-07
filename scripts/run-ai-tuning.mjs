#!/usr/bin/env node
/**
 * scripts/run-ai-tuning.mjs
 *
 * CLI for tuning AI parameters using the pure simulation in
 * src/entities/ai-tuning.js. Run without arguments to see usage.
 */

import {
  simulateDemoAiRun,
  compareAiPresets,
  tuneDemoAi,
  scoreRun,
  DEFAULT_AI_PRESETS,
} from '../src/entities/ai-tuning.js';

const SCENARIO = {
  shipStart: { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
  powerup: { x: 80, z: 0 },
  asteroids: [
    { x: 60, z: 20, vx: 0, vz: 0, radius: 6 },
    { x: 70, z: -10, vx: 0, vz: 0, radius: 6 },
  ],
};

function main() {
  const mode = process.argv[2] || 'compare';

  switch (mode) {
    case 'compare': {
      console.log('\n=== COMPARING PRESETS ===\n');
      const results = compareAiPresets({ scenario: SCENARIO, steps: 120, dt: 0.016 });
      for (const r of results) {
        const last = r.history[r.history.length - 1];
        console.log(`Preset: ${r.presetName}`);
        console.log(`  Score:     ${r.score.toFixed(0)}`);
        console.log(`  Params:    coastDist=${r.params.coastDist}, thrustGate=${r.params.thrustHeadingGate}, powerupBias=${r.params.powerupBiasU}`);
        if (last) {
          console.log(`  Final:     dist=${last.dist.toFixed(1)}u, speed=${last.speed.toFixed(1)}u/s, thrust=${last.thrust}`);
        }
        console.log('');
      }
      break;
    }

    case 'tune': {
      console.log('\n=== TUNING PARAMETERS (grid search) ===\n');
      const coastValues = [20, 30, 40, 50, 60];
      const thrustValues = [0.30, 0.40, 0.50, 0.60, 0.70];
      const tuned = tuneDemoAi({
        scenario: SCENARIO,
        steps: 120,
        dt: 0.016,
        paramValues: {
          coastDist: coastValues,
          thrustHeadingGate: thrustValues,
          powerupBiasU: [9999],
        },
      });
      console.log(`Best params: coastDist=${tuned.bestParams.coastDist}, thrustHeadingGate=${tuned.bestParams.thrustHeadingGate}, score=${tuned.score.toFixed(0)}`);
      console.log('\nAll candidates (top 10):');
      tuned.candidates.sort((a, b) => b.score - a.score).slice(0, 10).forEach((c, i) => {
        console.log(`  ${i + 1}. coastDist=${c.params.coastDist}, thrust=${c.params.thrustHeadingGate} → score=${c.score.toFixed(0)}`);
      });
      break;
    }

    case 'run': {
      const presetName = process.argv[3] || 'balanced';
      const params = { ...DEFAULT_AI_PRESETS[presetName], ...DEFAULT_AI_PRESETS.balanced };
      const steps = parseInt(process.argv[4] || '120', 10);
      const result = simulateDemoAiRun({ scenario: SCENARIO, steps, dt: 0.016, params });
      console.log(`\n=== RUN: ${presetName} (${steps} steps) ===`);
      console.log(`Final score: ${result.score.toFixed(0)}`);
      const f = result.finalShip;
      console.log(`Final position: (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) speed=${Math.hypot(f.vx, f.vz).toFixed(1)}u/s`);
      // Sample history
      const sampleEvery = Math.max(1, Math.floor(steps / 10));
      console.log('\nHistory samples:');
      for (let i = 0; i < result.history.length; i += sampleEvery) {
        const h = result.history[i];
        console.log(`  step=${i} mode=${h.mode} dist=${h.dist.toFixed(1)} speed=${h.speed.toFixed(1)} thrust=${h.thrust} score=${h.score.toFixed(0)}`);
      }
      break;
    }

    default:
      console.log('Usage: node scripts/run-ai-tuning.mjs [compare|tune|run <preset> <steps>]');
      console.log('  compare  — compare all 3 presets (default)');
      console.log('  tune     — grid-search over coastDist + thrustHeadingGate');
      console.log('  run      — run a single preset (balanced|aggressive|conservative)');
  }
}

main();
