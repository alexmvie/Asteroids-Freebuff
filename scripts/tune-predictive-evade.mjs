#!/usr/bin/env node
/**
 * scripts/tune-predictive-evade.mjs
 *
 * Tunes predictiveEvadeMargin and predictiveEvadeLookahead using the
 * real aiBrainTick brain. Simulates a head-on collision scenario and
 * measures:
 *   1. Did the AI successfully dodge? (miss distance > 7.4u = ship radius + asteroid radius)
 *   2. How early did it dodge? (time-to-collision at first evade tick)
 *   3. Did it re-engage? (thrust again after evading)
 *   4. Final score = survival bonus + engagement bonus - dodge delay penalty
 */

import { aiBrainTick } from '../src/entities/ai.js';

// --------------------------------------------------------------------------
// Mock asteroid (must match test/ai.test.js conventions)
// --------------------------------------------------------------------------

function mockAsteroid(x, z, vel) {
  const v = vel || { x: 0, z: 0 };
  return {
    spec: { position: { x, y: 0, z } },
    getPosition: () => ({ x, y: 0, z }),
    getVelocity: () => ({ x: v.x, z: v.z }),
  };
}

// --------------------------------------------------------------------------
// Simulation
// --------------------------------------------------------------------------

/**
 * Run a single simulation with given predictive evade params.
 *
 * Returns diagnostic metrics.
 */
function simulate({ margin, lookahead, headOn = true }) {
  // Scenario: ship at (0,0) moving +X at 80 u/s.
  // Asteroid dead ahead at (200, 0) stationary — head-on collision path.
  // At 80 u/s, ship reaches the asteroid in 200/80 = 2.5s.
  const aiPos = { x: 0, z: 0 };
  let aiYaw = -Math.PI / 2; // facing +X
  const aiVel = { x: 80, z: 0 };
  const asteroids = [mockAsteroid(200, 0)];
  let dist = Math.hypot(200, 0);

  let steps = 0;
  let evadeFiredAtStep = -1;
  let evadeDistAtFire = 0;
  let reengaged = false;
  let collision = false;
  let lastMode = 'idle';
  let minDist = Infinity;

  const MAX_STEPS = 300; // max 5s at 60fps
  const dt = 1 / 60;

  for (let i = 0; i < MAX_STEPS; i++) {
    const pos = { x: aiPos.x, z: aiPos.z };
    dist = Math.hypot(pos.x - asteroids[0].getPosition().x, pos.z - asteroids[0].getPosition().z);
    if (dist < minDist) minDist = dist;

    const result = aiBrainTick({
      aiPos: pos,
      aiYaw,
      aiVel,
      asteroids,
      time: i * dt,
      evadeDist: 8,
      predictiveEvadeLookahead: lookahead,
      predictiveEvadeMargin: margin,
      coastDist: 40,
    });

    lastMode = result.mode;

    // Track first evade
    if (result.mode === 'evade' && evadeFiredAtStep === -1) {
      evadeFiredAtStep = i;
      evadeDistAtFire = dist;
    }

    // Track re-engagement after evade
    if (evadeFiredAtStep !== -1 && result.mode !== 'evade' && result.thrust) {
      if (i > evadeFiredAtStep + 5) { // avoid counting immediate post-evade frame glitch
        reengaged = true;
      }
    }

    // Step ship
    const yawCmd = result.yaw;
    const thrust = result.thrust;
    aiYaw += yawCmd * 4 * dt;
    const forwardX = -Math.sin(aiYaw);
    const forwardZ = -Math.cos(aiYaw);
    aiVel.x += forwardX * (thrust ? 60 : 0) * dt;
    aiVel.z += forwardZ * (thrust ? 60 : 0) * dt;
    const drag = 0.4;
    aiVel.x *= Math.exp(-drag * dt);
    aiVel.z *= Math.exp(-drag * dt);
    aiPos.x += aiVel.x * dt;
    aiPos.z += aiVel.z * dt;

    // Check collision: ship radius ~1.4 + max asteroid radius ~6 = 7.4u
    const newDist = Math.hypot(aiPos.x - asteroids[0].getPosition().x, aiPos.z - asteroids[0].getPosition().z);
    if (newDist < 7.4) {
      collision = true;
      minDist = Math.min(minDist, newDist);
      break;
    }

    steps = i;

    // If ship has passed the asteroid's X and is moving away, consider it done
    if (aiPos.x > 210 && aiVel.x > 0 && dist > 50) break;
  }

  // Scoring
  let score = 0;

  // 1. Survival: +100 if no collision
  score += collision ? 0 : 100;

  // 2. Evade timing: +bonus for early dodge (best: 50-100 frames before collision)
  if (evadeFiredAtStep >= 0) {
    // Penalize very late dodge (< 10 frames before estimated collision)
    const estimatedImpactStep = Math.min(MAX_STEPS, Math.round(200 / 80 / dt));
    const framesEarly = estimatedImpactStep - evadeFiredAtStep;
    if (framesEarly > 100) {
      score += 20; // too early — wasted maneuver
    } else if (framesEarly > 50) {
      score += 50; // good early detection
    } else if (framesEarly > 20) {
      score += 80; // ideal timing
    } else if (framesEarly > 5) {
      score += 40; // late but effective
    } else {
      score += 10; // almost too late
    }
  }

  // 3. Re-engagement: +30 if the ship re-engages after evading
  if (reengaged) score += 30;

  // 4. Min distance penalty: closer = worse
  if (collision) {
    score -= 50; // major penalty for collision
  } else if (minDist < 10) {
    score -= 20; // close call penalty
  }

  // 5. Idle penalty: -40 if the ship ends in idle without ever engaging
  if (lastMode === 'idle' && !reengaged && evadeFiredAtStep < 0) {
    score -= 40;
  }

  return {
    score,
    collision,
    evadeFiredAtStep,
    evadeDistAtFire: Math.round(evadeDistAtFire * 10) / 10,
    minDist: Math.round(minDist * 10) / 10,
    reengaged,
    lastMode,
    steps,
  };
}

// --------------------------------------------------------------------------
// Grid search
// --------------------------------------------------------------------------

const marginValues = [6, 8, 10, 12, 14, 16, 20];
const lookaheadValues = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];

console.log('\n=== PREDICTIVE EVADE TUNING: HEAD-ON COLLISION SCENARIO ===\n');
console.log('Ship at (0,0) moving +X at 80 u/s. Stationary asteroid at (200, 0).');
console.log('Collision at t=2.5s (~150 frames at 60fps).');
console.log('');

console.log('Margin\\Lookahead\t' + lookaheadValues.map(l => `${l.toFixed(1)}s`).join('\t'));
console.log('─'.repeat(16 + lookaheadValues.length * 12));

const results = [];
for (const margin of marginValues) {
  const row = [`m=${margin}`];
  for (const lookahead of lookaheadValues) {
    const r = simulate({ margin, lookahead });
    const scoreStr = r.collision
      ? `💥${r.score}`
      : ` ✅${r.score}`;
    row.push(scoreStr);
    results.push({ margin, lookahead, ...r });
  }
  console.log(row.join('\t'));
}

console.log('\n\n=== TOP 10 COMBINATIONS ===\n');
results.sort((a, b) => b.score - a.score);
results.slice(0, 10).forEach((r, i) => {
  console.log(`${i + 1}. margin=${r.margin}, lookahead=${r.lookahead}s → score=${r.score} ${r.collision ? '💥' : '✅'} evade@step=${r.evadeFiredAtStep !== -1 ? r.evadeFiredAtStep : 'never'} dist=${r.evadeDistAtFire}u minDist=${r.minDist}u reengage=${r.reengaged}`);
});

console.log('\n--- CURRENT DEFAULTS ---');
const current = simulate({ margin: 12, lookahead: 3.0 });
console.log(`margin=12, lookahead=3.0 → score=${current.score} ${current.collision ? '💥' : '✅'} evade@step=${current.evadeFiredAtStep} dist=${current.evadeDistAtFire}u minDist=${current.minDist}u`);

console.log('\n=== OFFAXIS SCENARIO (false-positive check) ===\n');
console.log('Ship at (0,0) moving +X at 80 u/s. Asteroid at (200, 25) — 25u off path.');
console.log('Closest approach ≈ 25u. Should NOT trigger predictive evade with margin < 25.\n');

function simulateOffaxis({ margin, lookahead }) {
  let aiPos = { x: 0, z: 0 };
  let aiYaw = -Math.PI / 2;
  let aiVel = { x: 80, z: 0 };
  const asteroids = [mockAsteroid(200, 25)];
  const MAX_STEPS = 250;
  const dt = 1 / 60;
  let evaded = false;
  let evadeStep = -1;
  let minDist = Infinity;

  for (let i = 0; i < MAX_STEPS; i++) {
    const pos = { x: aiPos.x, z: aiPos.z };
    const dist = Math.hypot(pos.x - asteroids[0].getPosition().x, pos.z - asteroids[0].getPosition().z);
    if (dist < minDist) minDist = dist;

    const result = aiBrainTick({
      aiPos: pos,
      aiYaw,
      aiVel,
      asteroids,
      time: i * dt,
      evadeDist: 8,
      predictiveEvadeLookahead: lookahead,
      predictiveEvadeMargin: margin,
      coastDist: 40,
    });

    if (result.mode === 'evade' && !evaded) {
      evaded = true;
      evadeStep = i;
    }

    const yawCmd = result.yaw;
    const thrust = result.thrust;
    aiYaw += yawCmd * 4 * dt;
    const forwardX = -Math.sin(aiYaw);
    const forwardZ = -Math.cos(aiYaw);
    aiVel.x += forwardX * (thrust ? 60 : 0) * dt;
    aiVel.z += forwardZ * (thrust ? 60 : 0) * dt;
    aiVel.x *= Math.exp(-0.4 * dt);
    aiVel.z *= Math.exp(-0.4 * dt);
    aiPos.x += aiVel.x * dt;
    aiPos.z += aiVel.z * dt;

    if (aiPos.x > 220 && aiVel.x > 0) break;
  }

  // false positive: evading when closest approach is 25u (> all tested margins)
  const falsePositive = evaded;
  return {
    fp: falsePositive,
    evadeStep,
    minDist: Math.round(minDist * 10) / 10,
  };
}

console.log('Margin\\Lookahead\t' + lookaheadValues.map(l => `${l.toFixed(1)}s`).join('\t'));
console.log('─'.repeat(16 + lookaheadValues.length * 12));

for (const margin of marginValues) {
  const row = [`m=${margin}`];
  for (const lookahead of lookaheadValues) {
    const r = simulateOffaxis({ margin, lookahead });
    row.push(r.fp ? '⚠️ FP' : '  ✅');
  }
  console.log(row.join('\t'));
}

console.log('\n--- OFF-AXIS SCORING (bonus for NO false positive) ---');
for (const margin of marginValues) {
  let fps = 0;
  for (const lookahead of lookaheadValues) {
    const r = simulateOffaxis({ margin, lookahead });
    if (r.fp) fps++;
  }
  console.log(`margin=${margin}: ${fps}/${lookaheadValues.length} false positives`);
}

console.log('\n=== RECOMMENDATION ===\n');
console.log('Ideal: high head-on score + 0 false positives.');
console.log('Look for margins < 25 (to trigger on real threats) but > min expected miss.');
console.log('Off-axis asteroid at 25u — margins < 25 WILL false-positive.');
