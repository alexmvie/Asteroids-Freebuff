function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function wrapAngle(a) {
  const tau = Math.PI * 2;
  let r = a % tau;
  if (r > Math.PI) r -= tau;
  else if (r <= -Math.PI) r += tau;
  return r;
}

function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

function stepShip({ ship, params, target, dt }) {
  const dx = target.x - ship.x;
  const dz = target.z - ship.z;
  const dist = Math.hypot(dx, dz) || 0.0001;
  const faceAngle = Math.atan2(dz, dx);
  const diff = wrapAngle(faceAngle - facingAngle(ship.yaw));
  const yaw = diff > 0.08 ? -1 : diff < -0.08 ? 1 : 0;
  const shouldThrust = Math.abs(diff) < params.thrustHeadingGate;
  const speed = Math.hypot(ship.vx, ship.vz);
  const closingSpeed = speed > 0 ? (ship.vx * dx + ship.vz * dz) / dist : 0;
  const shouldCoast = dist < params.coastDist && closingSpeed > 5;
  const thrust = shouldThrust && !shouldCoast;

  ship.yaw += yaw * 4 * dt;
  const accel = thrust ? 60 : 0;
  const forwardX = -Math.sin(ship.yaw);
  const forwardZ = -Math.cos(ship.yaw);
  ship.vx += forwardX * accel * dt;
  ship.vz += forwardZ * accel * dt;

  const drag = 0.4;
  ship.vx *= Math.exp(-drag * dt);
  ship.vz *= Math.exp(-drag * dt);
  ship.x += ship.vx * dt;
  ship.z += ship.vz * dt;

  return {
    yaw,
    thrust,
    diff,
    dist,
    speed: Math.hypot(ship.vx, ship.vz),
  };
}

export function simulateDemoAiRun({ params = {}, scenario, steps = 120, dt = 0.016 }) {
  const ship = { ...scenario.shipStart };
  const asteroids = (scenario.asteroids || []).map(a => ({ ...a }));
  const powerup = scenario.powerup ? { ...scenario.powerup } : null;
  const resolved = {
    coastDist: 40,
    powerupBiasU: 9999,
    thrustHeadingGate: 0.5,
    ...params,
  };

  const history = [];
  let score = 0;
  for (let i = 0; i < steps; i += 1) {
    const target = powerup ? powerup : asteroids[0] || null;
    const result = stepShip({ ship, params: resolved, target, dt });
    const powerupDist = powerup ? Math.hypot(powerup.x - ship.x, powerup.z - ship.z) : Infinity;
    const asteroidDist = asteroids[0] ? Math.hypot(asteroids[0].x - ship.x, asteroids[0].z - ship.z) : Infinity;
    if (powerupDist < 4) score += 1000;
    if (asteroidDist < 8) score -= 200;
    score -= powerupDist * 0.2;
    score -= Math.max(0, 14 - asteroidDist) * 2;
    history.push({ mode: powerup ? 'powerup' : 'asteroid', ...result, score });
  }
  return { score, history, finalShip: ship };
}

export function scoreRun(run) {
  return run.score;
}

export const DEFAULT_AI_PRESETS = Object.freeze({
  balanced: Object.freeze({
    coastDist: 40,
    powerupBiasU: 9999,
    thrustHeadingGate: 0.10, // v0.36.0: tight stop-turn-thrust
    evadeDist: 8,
  }),
  aggressive: Object.freeze({
    coastDist: 20,
    powerupBiasU: 9999,
    thrustHeadingGate: 0.10,
    evadeDist: 8,
  }),
  conservative: Object.freeze({
    coastDist: 60,
    powerupBiasU: 9999,
    thrustHeadingGate: 0.10,
    evadeDist: 8,
  }),
});

export function resolveAiPresetOptions({ presetName = 'balanced', rawOptions = null } = {}) {
  const base = DEFAULT_AI_PRESETS[presetName] || null;
  if (!base) return {};
  const parsed = rawOptions ? JSON.parse(rawOptions) : {};
  return { ...base, ...parsed };
}

export function tuneDemoAi({ scenario, steps = 90, dt = 0.016, paramValues = {} }) {
  const candidates = [];
  const coastValues = paramValues.coastDist || [20, 30, 40];
  const powerupValues = paramValues.powerupBiasU || [9999];
  const thrustValues = paramValues.thrustHeadingGate || [0.4, 0.5, 0.6];
  for (const coastDist of coastValues) {
    for (const powerupBiasU of powerupValues) {
      for (const thrustHeadingGate of thrustValues) {
        const result = simulateDemoAiRun({
          scenario,
          steps,
          dt,
          params: { coastDist, powerupBiasU, thrustHeadingGate },
        });
        candidates.push({ params: { coastDist, powerupBiasU, thrustHeadingGate }, score: result.score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { bestParams: candidates[0].params, score: candidates[0].score, candidates };
}

export function compareAiPresets({ scenario, steps = 90, dt = 0.016, presetNames = ['balanced', 'aggressive', 'conservative'] }) {
  const results = [];
  for (const presetName of presetNames) {
    const params = resolveAiPresetOptions({ presetName });
    const run = simulateDemoAiRun({ scenario, steps, dt, params });
    results.push({ presetName, params, score: run.score, history: run.history });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
