/**
 * AI Training Dashboard — frontend logic
 *
 * Connects to the training server via SSE for real-time updates,
 * renders a live fitness chart, and provides controls for the user.
 */

const API_BASE = 'http://localhost:5174';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const els = {
  generation: document.querySelector('[data-stat="generation"] .stat-value'),
  bestFitness: document.querySelector('[data-stat="bestFitness"] .stat-value'),
  avgFitness: document.querySelector('[data-stat="avgFitness"] .stat-value'),
  bestEver: document.querySelector('[data-stat="bestEver"] .stat-value'),
  chart: document.getElementById('fitness-chart'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnDeploy: document.getElementById('btn-deploy'),
  btnDownload: document.getElementById('btn-download'),
  btnPlayback: document.getElementById('btn-playback'),
  paramPop: document.getElementById('param-pop'),
  paramHidden: document.getElementById('param-hidden'),
  paramDuration: document.getElementById('param-duration'),
  paramMovementReward: document.getElementById('param-movement-reward'),
  paramSeedStrategy: document.getElementById('param-seed-strategy'),
  paramMutationRate: document.getElementById('param-mutation-rate'),
  paramMutationStrength: document.getElementById('param-mutation-strength'),
  paramElitism: document.getElementById('param-elitism'),
  paramEpisodes: document.getElementById('param-episodes'),
  paramDt: document.getElementById('param-dt'),
  paramPreset: document.getElementById('param-preset'),
  paramWorkerCount: document.getElementById('param-worker-count'),
  paramCrossoverRate: document.getElementById('param-crossover-rate'),
  paramTournamentSize: document.getElementById('param-tournament-size'),
  hintMovementReward: document.getElementById('hint-movement-reward'),
  hintMutationRate: document.getElementById('hint-mutation-rate'),
  hintMutationStrength: document.getElementById('hint-mutation-strength'),
  hintElitism: document.getElementById('hint-elitism'),
  hintCrossoverRate: document.getElementById('hint-crossover-rate'),
  hintTournamentSize: document.getElementById('hint-tournament-size'),
  hintArchHidden: document.getElementById('hint-arch-hidden'),
  hintPreset: document.getElementById('hint-preset'),
  // New stat cards
  workers: document.querySelector('[data-stat="workers"] .stat-value'),
  genTime: document.querySelector('[data-stat="genTime"] .stat-value'),
  // Live Config
  liveConfigGrid: document.getElementById('live-config-grid'),
  liveConfigStatus: document.getElementById('live-config-status'),
  logEntries: document.getElementById('log-entries'),
  uploadArea: document.getElementById('upload-area'),
  uploadInput: document.getElementById('upload-input'),
  statusPill: document.getElementById('status-pill'),
  statusText: document.querySelector('#status-pill .status-text'),
  // Playback modal
  pbModal: document.getElementById('playback-modal'),
  pbClose: document.getElementById('playback-close'),
  pbStatus: document.getElementById('pb-status'),
  pbFrameInfo: document.getElementById('pb-frame-info'),
  pbScore: document.getElementById('pb-score'),
  pbDied: document.getElementById('pb-died'),
  pbCanvas: document.getElementById('playback-canvas'),
  pbHudTime: document.getElementById('hud-time'),
  pbHudMode: document.getElementById('hud-mode'),
  pbHudAction: document.getElementById('hud-action'),
  pbHudSpeed: document.getElementById('hud-speed'),
  pbRestart: document.getElementById('pb-restart'),
  pbStepBack: document.getElementById('pb-step-back'),
  pbPlay: document.getElementById('pb-play'),
  pbStepForward: document.getElementById('pb-step-forward'),
  pbSpeedSelect: document.getElementById('pb-speed-select'),
  pbFollowShip: document.getElementById('pb-follow-ship'),
};

// ---------------------------------------------------------------------------
// Chart state
// ---------------------------------------------------------------------------

const chartCtx = els.chart.getContext('2d');
const chartData = {
  generations: [],
  best: [],
  avg: [],
};
const MAX_POINTS = 200;

function resizeChart() {
  const rect = els.chart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.chart.width = rect.width * dpr;
  els.chart.height = rect.height * dpr;
  chartCtx.scale(dpr, dpr);
}
resizeChart();
window.addEventListener('resize', () => {
  resizeChart();
  drawChart();
});

function drawChart() {
  const width = els.chart.width / (window.devicePixelRatio || 1);
  const height = els.chart.height / (window.devicePixelRatio || 1);

  chartCtx.clearRect(0, 0, width, height);

  // Background grid
  chartCtx.strokeStyle = '#1f2937';
  chartCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (height / 4) * i;
    chartCtx.beginPath();
    chartCtx.moveTo(0, y);
    chartCtx.lineTo(width, y);
    chartCtx.stroke();
  }

  if (chartData.generations.length === 0) return;

  const maxVal = Math.max(...chartData.best, ...chartData.avg, 1);
  const padLeft = 40;
  const padRight = 10;
  const padTop = 10;
  const padBottom = 24;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  function xFor(i) {
    return padLeft + (i / (chartData.generations.length - 1)) * chartW;
  }
  function yFor(v) {
    return padTop + chartH - (v / maxVal) * chartH;
  }

  // Draw average line
  chartCtx.strokeStyle = '#3b82f6';
  chartCtx.lineWidth = 2;
  chartCtx.beginPath();
  for (let i = 0; i < chartData.avg.length; i++) {
    const x = xFor(i);
    const y = yFor(chartData.avg[i]);
    if (i === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  }
  chartCtx.stroke();

  // Draw best line
  chartCtx.strokeStyle = '#48dbfb';
  chartCtx.lineWidth = 2;
  chartCtx.beginPath();
  for (let i = 0; i < chartData.best.length; i++) {
    const x = xFor(i);
    const y = yFor(chartData.best[i]);
    if (i === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  }
  chartCtx.stroke();

  // Labels
  chartCtx.fillStyle = '#9ca3af';
  chartCtx.font = '11px "SF Mono", Consolas, monospace';
  chartCtx.textAlign = 'right';
  chartCtx.fillText(Math.round(maxVal).toString(), padLeft - 6, padTop + 4);
  chartCtx.fillText('0', padLeft - 6, padTop + chartH + 4);

  chartCtx.textAlign = 'center';
  const firstGen = chartData.generations[0];
  const lastGen = chartData.generations[chartData.generations.length - 1];
  chartCtx.fillText(`Gen ${firstGen}`, padLeft, height - 4);
  chartCtx.fillText(`Gen ${lastGen}`, width - padRight, height - 4);
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  els.logEntries.appendChild(entry);
  els.logEntries.scrollTop = els.logEntries.scrollHeight;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

let evtSource = null;
let isRunning = false;

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`${API_BASE}/events`);

  evtSource.addEventListener('open', () => {
    log('Connected to training server');
  });

  evtSource.addEventListener('message', (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      return;
    }

    if (data.type === 'status') {
      updateStats(data);
    } else if (data.type === 'progress') {
      updateStats(data);
      pushChartData(data.generation, data.bestFitness, data.avgFitness);
      log(`Gen ${data.generation}: best=${data.bestFitness.toFixed(1)} avg=${data.avgFitness.toFixed(1)}`, 'info');
    } else if (data.type === 'started') {
      isRunning = true;
      setStatus('running');
      updateButtons();
      log('Training started — watch the Generation count climb', 'success');
    } else if (data.type === 'stopped') {
      isRunning = false;
      setStatus('idle');
      updateButtons();
      log('Training stopped. Best brain preserved — click Deploy to use it in the game.', 'info');
    }
  });

  evtSource.addEventListener('error', () => {
    log('SSE connection lost — reconnecting in 3s…', 'error');
    setTimeout(connectSSE, 3000);
  });
}

// ---------------------------------------------------------------------------
// Stats + chart
// ---------------------------------------------------------------------------

function updateStats(data) {
  if (data.generation != null) els.generation.textContent = data.generation;
  if (data.bestFitness != null) els.bestFitness.textContent = data.bestFitness.toFixed(1);
  if (data.avgFitness != null) els.avgFitness.textContent = data.avgFitness.toFixed(1);
  if (data.bestEverFitness != null) els.bestEver.textContent = data.bestEverFitness.toFixed(1);
  if (data.durationMs != null && els.genTime) {
    els.genTime.textContent = (data.durationMs / 1000).toFixed(2) + 's';
  }
  updateButtons();
}

function pushChartData(gen, best, avg) {
  chartData.generations.push(gen);
  chartData.best.push(best);
  chartData.avg.push(avg);
  if (chartData.generations.length > MAX_POINTS) {
    chartData.generations.shift();
    chartData.best.shift();
    chartData.avg.shift();
  }
  drawChart();
}

const STATUS_LABELS = {
  running: 'Running',
  idle: 'Idle',
  error: 'Server offline',
};

function setStatus(state) {
  els.statusPill.dataset.state = state;
  els.statusText.textContent = STATUS_LABELS[state] || state;
}

function updateButtons() {
  els.btnStart.disabled = isRunning;
  els.btnStop.disabled = !isRunning;
  els.btnDeploy.disabled = !chartData.best.length;
  els.btnDownload.disabled = !chartData.best.length;
  updatePlaybackButton();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

// Live hint updaters for the slider controls — keep the hint text in
// sync with the slider's current value so users see exactly what they
// just set. All values are fractions; the server converts elitismFraction
// to an absolute elitismCount.
function updateMovementRewardHint() {
  const v = parseFloat(els.paramMovementReward.value) || 0;
  els.hintMovementReward.textContent = v === 0
    ? '0 = movement ignored (spin in place is free)'
    : `+${v.toFixed(2)} per world unit traveled`;
}
function updateMutationRateHint() {
  const v = parseFloat(els.paramMutationRate.value) || 0;
  els.hintMutationRate.textContent = `${Math.round(v * 100)}% chance per weight, per child`;
}
function updateMutationStrengthHint() {
  const v = parseFloat(els.paramMutationStrength.value) || 0;
  els.hintMutationStrength.textContent = v === 0
    ? '0 = no mutation (children = exact blends)'
    : `\u00b1${v.toFixed(2)} typical per-weight change`;
}
function updateElitismHint() {
  const v = parseFloat(els.paramElitism.value) || 0;
  const pop = parseInt(els.paramPop.value, 10) || 100;
  const count = Math.max(0, Math.round(v * pop));
  els.hintElitism.textContent = v === 0
    ? '0 = no elitism (every brain is bred)'
    : `Top ${count} brains preserved (${Math.round(v * 100)}% of ${pop})`;
}
function updateArchHiddenHint() {
  const h = parseInt(els.paramHidden.value, 10) || 12;
  if (els.hintArchHidden) els.hintArchHidden.textContent = h;
}

function updateCrossoverRateHint() {
  const v = parseFloat(els.paramCrossoverRate.value) || 0;
  const blends = Math.round(v * 100);
  els.hintCrossoverRate.textContent = `${blends}% blends, ${100 - blends}% clones`;
}

function updateTournamentSizeHint() {
  const v = parseInt(els.paramTournamentSize.value, 10) || 3;
  els.hintTournamentSize.textContent = v === 1
    ? 'Pick 1 random brain (no selection pressure)'
    : `Pick best of ${v} random brains`;
}

// -----------------------------------------------------------------------
// Training presets — one-click configurations that override every slider
// below. The single source of truth is PRESETS (each preset is a flat
// object matching the form input ids).
// -----------------------------------------------------------------------

const PRESETS = Object.freeze({
  balanced: {
    populationSize: 100,
    hiddenSize: 12,
    maxDurationS: 60,
    movementReward: 0.5,
    seedStrategy: 'vary',
    mutationRate: 0.15,
    mutationStrength: 0.3,
    elitismFraction: 0.05,
    crossoverRate: 0.7,
    tournamentSize: 3,
    episodesPerGenome: 1,
    dt: 0.016666,
    workerCount: -1,
    label: '⚖ Balanced — 100 pop, 12 hidden, 60s, 0.5 movement',
  },
  fast: {
    populationSize: 50,
    hiddenSize: 12,
    maxDurationS: 30,
    movementReward: 0,
    seedStrategy: 'vary',
    mutationRate: 0.15,
    mutationStrength: 0.3,
    elitismFraction: 0.05,
    crossoverRate: 0.7,
    tournamentSize: 3,
    episodesPerGenome: 1,
    dt: 0.016666,
    workerCount: -1,
    label: '⚡ Fast — 50 pop, 12 hidden, 30s, no movement reward',
  },
  powerup: {
    populationSize: 200,
    hiddenSize: 24,
    maxDurationS: 60,
    movementReward: 1.0,
    seedStrategy: 'vary',
    mutationRate: 0.15,
    mutationStrength: 0.3,
    elitismFraction: 0.05,
    crossoverRate: 0.7,
    tournamentSize: 3,
    episodesPerGenome: 1,
    dt: 0.016666,
    workerCount: -1,
    label: '🎯 Power-up hunter — 200 pop, 24 hidden, 60s, 1.0 movement, vary seeds',
  },
  plateau: {
    populationSize: 100,
    hiddenSize: 12,
    maxDurationS: 60,
    movementReward: 0.5,
    seedStrategy: 'vary',
    mutationRate: 0.25,
    mutationStrength: 0.5,
    elitismFraction: 0.05,
    crossoverRate: 0.7,
    tournamentSize: 3,
    episodesPerGenome: 1,
    dt: 0.016666,
    workerCount: -1,
    label: '💥 Plateau buster — 100 pop, 12 hidden, 60s, 0.25 mutation, 0.5 strength',
  },
});

// Map form input ids → els refs (cached once for speed)
const PRESET_INPUT_MAP = {
  populationSize: 'paramPop',
  hiddenSize: 'paramHidden',
  maxDurationS: 'paramDuration',
  movementReward: 'paramMovementReward',
  seedStrategy: 'paramSeedStrategy',
  mutationRate: 'paramMutationRate',
  mutationStrength: 'paramMutationStrength',
  elitismFraction: 'paramElitism',
  crossoverRate: 'paramCrossoverRate',
  tournamentSize: 'paramTournamentSize',
  episodesPerGenome: 'paramEpisodes',
  dt: 'paramDt',
  workerCount: 'paramWorkerCount',
};

/**
 * Apply a preset by name (or the string 'custom' to leave values alone).
 * Sets every relevant input's value, then re-paints all hints.
 */
function applyPreset(name) {
  if (name === 'custom') {
    els.hintPreset.textContent = "You're on custom — tweak the sliders below";
    return;
  }
  const preset = PRESETS[name];
  if (!preset) return;
  for (const [key, inputId] of Object.entries(PRESET_INPUT_MAP)) {
    const el = els[inputId];
    if (el && preset[key] != null) {
      el.value = String(preset[key]);
    }
  }
  // Re-paint every hint so the labels reflect the new values
  updateMovementRewardHint();
  updateMutationRateHint();
  updateMutationStrengthHint();
  updateElitismHint();
  updateCrossoverRateHint();
  updateTournamentSizeHint();
  updateArchHiddenHint();
  els.hintPreset.textContent = `Preset applied: ${preset.label}`;
}

els.paramPreset.addEventListener('change', (e) => applyPreset(e.target.value));

// If the user manually changes any slider after selecting a preset,
// flip the preset dropdown back to 'custom' so the label doesn't lie.
function markCustom() {
  if (els.paramPreset.value !== 'custom') {
    els.paramPreset.value = 'custom';
    els.hintPreset.textContent = "Switched to custom — tweak the sliders below";
  }
}
for (const inputId of Object.values(PRESET_INPUT_MAP)) {
  els[inputId].addEventListener('input', markCustom);
  els[inputId].addEventListener('change', markCustom);
}

els.paramMovementReward.addEventListener('input', updateMovementRewardHint);
els.paramMutationRate.addEventListener('input', updateMutationRateHint);
els.paramMutationStrength.addEventListener('input', updateMutationStrengthHint);
els.paramElitism.addEventListener('input', updateElitismHint);
els.paramCrossoverRate.addEventListener('input', updateCrossoverRateHint);
els.paramTournamentSize.addEventListener('input', updateTournamentSizeHint);
els.paramPop.addEventListener('input', updateElitismHint);
els.paramHidden.addEventListener('input', updateArchHiddenHint);

// Initial hint paint
updateMovementRewardHint();
updateMutationRateHint();
updateMutationStrengthHint();
updateElitismHint();
updateCrossoverRateHint();
updateTournamentSizeHint();
updateArchHiddenHint();

els.btnStart.addEventListener('click', async () => {
  const popSize = parseInt(els.paramPop.value, 10) || 100;
  const params = {
    // Core
    populationSize: popSize,
    hiddenSize: parseInt(els.paramHidden.value, 10) || 12,
    maxDurationS: parseInt(els.paramDuration.value, 10) || 60,
    // Fitness
    movementReward: parseFloat(els.paramMovementReward.value) || 0,
    seedStrategy: els.paramSeedStrategy.value || 'vary',
    // GA (fractions; server converts elitismFraction to elitismCount)
    mutationRate: parseFloat(els.paramMutationRate.value) || 0.15,
    mutationStrength: parseFloat(els.paramMutationStrength.value) || 0.3,
    elitismFraction: parseFloat(els.paramElitism.value) || 0.05,
    crossoverRate: parseFloat(els.paramCrossoverRate.value) || 0.7,
    tournamentSize: parseInt(els.paramTournamentSize.value, 10) || 3,
    // Advanced
    episodesPerGenome: parseInt(els.paramEpisodes.value, 10) || 1,
    dt: parseFloat(els.paramDt.value) || 1 / 60,
    workerCount: parseInt(els.paramWorkerCount.value, 10) ?? -1, // -1 = auto
  };
  try {
    const res = await fetch(`${API_BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.error) {
      log(data.error, 'error');
    } else {
      log('Start command sent', 'success');
      // The trainer is created asynchronously inside the server's
      // training loop — poll /config a few times to catch the moment
      // it transitions from "preview" to the real live config.
      pollLiveConfigUntilLive();
    }
  } catch (err) {
    log('Failed to start: ' + err.message, 'error');
  }
});

els.btnStop.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.stopped) log('Stop command sent', 'success');
  } catch (err) {
    log('Failed to stop: ' + err.message, 'error');
  }
});

els.btnDeploy.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/deploy`, { method: 'POST' });
    const data = await res.json();
    if (data.deployed) {
      log(`Deployed to ${data.path} — reload the game to use the trained brain!`, 'success');
    } else if (data.error) {
      log(data.error, 'error');
    }
  } catch (err) {
    log('Failed to deploy: ' + err.message, 'error');
  }
});

function updatePlaybackButton() {
  if (els.btnPlayback) {
    els.btnPlayback.disabled = !chartData.best.length;
  }
}

els.btnDownload.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/download`);
    if (!res.ok) {
      const data = await res.json();
      log(data.error || 'Download failed', 'error');
      return;
    }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `genome-gen${data.generation}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log('Genome downloaded', 'success');
  } catch (err) {
    log('Failed to download: ' + err.message, 'error');
  }
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

els.uploadArea.addEventListener('click', () => els.uploadInput.click());

els.uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.uploadArea.classList.add('drag-over');
});

els.uploadArea.addEventListener('dragleave', () => {
  els.uploadArea.classList.remove('drag-over');
});

els.uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  els.uploadArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleUpload(file);
});

els.uploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleUpload(file);
});

async function handleUpload(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.uploaded) {
      log('Genome uploaded successfully', 'success');
      if (data.generation != null && data.fitness != null) {
        updateStats({
          generation: data.generation,
          bestFitness: data.fitness,
          bestEverFitness: data.fitness,
        });
        pushChartData(data.generation, data.fitness, data.fitness);
      }
    }
  } catch (err) {
    log('Upload failed: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Champion Playback (2D viewer)
// ---------------------------------------------------------------------------

const MODE_NAMES = ['wander', 'dodge', 'target', 'hunt'];

/**
 * Resize the playback canvas to its CSS size × devicePixelRatio, then
 * schedule a redraw so the current frame repaints crisply.
 */
function resizePlaybackCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.pbCanvas.getBoundingClientRect();
  els.pbCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  els.pbCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  requestPlaybackFrame();
}

const playback = {
  frames: [],      // decoded frames from /playback
  decoded: null,   // { ship, asteroids, bullets, powerup, laser, brain, score, time }
  time: 0,         // current playback time (seconds)
  playing: false,
  speed: 1,
  followShip: true,
  lastTickMs: 0,
  rafId: 0,
  camera: { x: 0, z: 0 },
  worldScale: 1,   // pixels per world unit, computed per frame
  // Ship trail — ring buffer of recent ship positions, drawn as a
  // fading line behind the ship so the brain's movement is visible
  // even with follow-camera (where the ship icon stays at the center
  // of the canvas and the user might otherwise think it's not moving).
  trail: [],
  trailMax: 60,    // ~1 second of frames at 60fps playback
};

/**
 * Decode a recorded frame into plain JS objects the renderer can consume.
 * @param {object} f — server frame {t, s, a, b, p, L, F, y, T, f, m, S}
 */
function decodeFrame(f) {
  // Asteroids: packed [x,z,r,size]×N
  const asteroids = [];
  for (let i = 0; i < f.a.length; i += 4) {
    asteroids.push({
      x: f.a[i],
      z: f.a[i + 1],
      r: f.a[i + 2],
      size: f.a[i + 3],
    });
  }
  // Bullets: packed [x,z]×N
  const bullets = [];
  for (let i = 0; i < f.b.length; i += 2) {
    bullets.push({ x: f.b[i], z: f.b[i + 1] });
  }
  return {
    time: f.t,
    ship: { x: f.s.x, z: f.s.z, vx: f.s.vx, vz: f.s.vz, yaw: f.s.yaw, roll: f.s.roll },
    asteroids,
    bullets,
    powerup: f.p ? { x: f.p.x, z: f.p.z } : null,
    laserActive: f.L === 1,
    laserFiring: f.F === 1,
    brain: { yaw: f.y, thrust: f.T === 1, fire: f.f === 1, mode: MODE_NAMES[f.m] || 'wander' },
    score: f.S,
  };
}

/**
 * Linearly interpolate two decoded frames.
 * @param {object} a
 * @param {object} b
 * @param {number} t — 0..1
 */
function lerpFrame(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    time: a.time + (b.time - a.time) * t,
    ship: {
      x: a.ship.x + (b.ship.x - a.ship.x) * t,
      z: a.ship.z + (b.ship.z - a.ship.z) * t,
      vx: a.ship.vx + (b.ship.vx - a.ship.vx) * t,
      vz: a.ship.vz + (b.ship.vz - a.ship.vz) * t,
      yaw: a.ship.yaw + (b.ship.yaw - a.ship.yaw) * t,
      roll: a.ship.roll + (b.ship.roll - a.ship.roll) * t,
    },
    asteroids: b.asteroids,   // discrete — use the later frame's
    bullets: b.bullets,
    powerup: b.powerup,
    laserActive: t < 0.5 ? a.laserActive : b.laserActive,
    laserFiring: t < 0.5 ? a.laserFiring : b.laserFiring,
    brain: t < 0.5 ? a.brain : b.brain,
    score: t < 0.5 ? a.score : b.score,
  };
}

/**
 * Find the two frames that bracket the given time and return the lerped frame.
 */
function sampleAt(time) {
  const f = playback.frames;
  if (f.length === 0) return null;
  if (f.length === 1 || time <= f[0].time) return f[0];
  if (time >= f[f.length - 1].time) return f[f.length - 1];
  for (let i = 0; i < f.length - 1; i++) {
    if (time >= f[i].time && time < f[i + 1].time) {
      const span = f[i + 1].time - f[i].time;
      const t = span > 0 ? (time - f[i].time) / span : 0;
      return lerpFrame(f[i], f[i + 1], t);
    }
  }
  return f[f.length - 1];
}

/**
 * Render the current playback frame to the canvas.
 */
function renderPlayback() {
  const ctx = els.pbCanvas.getContext('2d');
  const W = els.pbCanvas.width;
  const H = els.pbCanvas.height;
  const dpr = window.devicePixelRatio || 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Background (starfield-style gradient)
  const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H));
  bgGrad.addColorStop(0, '#0a1224');
  bgGrad.addColorStop(1, '#050810');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  if (!playback.decoded) return;
  const frame = playback.decoded;

  // Camera: follow the ship, or world origin
  const camX = playback.followShip ? frame.ship.x : 0;
  const camZ = playback.followShip ? frame.ship.z : 0;

  // World scale: fit ~200 world units across the canvas (with dpr)
  const worldUnitsAcross = 200;
  playback.worldScale = (W / worldUnitsAcross);
  const cx = W / 2;
  const cy = H / 2;
  const s = playback.worldScale;
  const tx = (wx) => cx + (wx - camX) * s;
  const ty = (wz) => cy + (wz - camZ) * s;

  // Origin crosshair (faint) so the world coords are anchored even when off-ship
  ctx.strokeStyle = 'rgba(75, 85, 99, 0.4)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(tx(0), 0);
  ctx.lineTo(tx(0), H);
  ctx.moveTo(0, ty(0));
  ctx.lineTo(W, ty(0));
  ctx.stroke();

  // Asteroids
  for (const a of frame.asteroids) {
    const r = Math.max(2, a.r * s);
    let fill = '#6b7280';
    if (a.size === 0) fill = '#4b5563';
    else if (a.size === 2) fill = '#9ca3af';
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(tx(a.x), ty(a.z), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  }

  // Powerup
  if (frame.powerup) {
    const p = frame.powerup;
    const r = 6 * dpr;
    // Pulsing ring
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
    ctx.strokeStyle = `rgba(16, 185, 129, ${0.4 + pulse * 0.5})`;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(tx(p.x), ty(p.z), r + 3 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();
    // Filled center
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(tx(p.x), ty(p.z), r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Laser
  if (frame.laserFiring) {
    const yaw = frame.ship.yaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3 * dpr;
    ctx.shadowColor = '#facc15';
    ctx.shadowBlur = 8 * dpr;
    ctx.beginPath();
    ctx.moveTo(tx(frame.ship.x), ty(frame.ship.z));
    ctx.lineTo(tx(frame.ship.x + dx * 200), ty(frame.ship.z + dz * 200));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Ship trail (drawn before the ship so the ship sits on top).
  // Each trail point is a small fading circle. With follow-camera the
  // ship icon stays at the canvas center, so the trail is the only
  // visual cue that the brain is actually moving.
  if (playback.trail.length > 1) {
    for (let i = 0; i < playback.trail.length; i++) {
      const t = playback.trail[i];
      // Fade: oldest point is dim, newest is bright
      const alpha = 0.15 + 0.55 * (i / playback.trail.length);
      ctx.fillStyle = `rgba(72, 219, 251, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(tx(t.x), ty(t.z), 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Bullets
  for (const b of frame.bullets) {
    ctx.fillStyle = '#fef3c7';
    ctx.beginPath();
    ctx.arc(tx(b.x), ty(b.z), 2 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ship (cyan triangle pointing along yaw)
  const sx = tx(frame.ship.x);
  const sy = ty(frame.ship.z);
  const yaw = frame.ship.yaw;
  // Forward direction in canvas space: -sin(yaw) is world-X, -cos(yaw) is world-Z
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const fwdX = fx * s;
  const fwdY = fz * s;
  // Side vector (perpendicular, for wing tips)
  const sideX = -fz * s * 0.6;
  const sideY = fx * s * 0.6;
  // Engine glow size scales with thrust + speed
  const speed = Math.hypot(frame.ship.vx, frame.ship.vz);
  const thrustGlow = frame.brain.thrust ? Math.min(1, speed / 100) : 0;

  // Engine glow
  if (thrustGlow > 0) {
    ctx.fillStyle = `rgba(72, 219, 251, ${0.3 + thrustGlow * 0.5})`;
    ctx.beginPath();
    ctx.arc(sx - fwdX * 0.5, sy - fwdY * 0.5, 8 * dpr * (0.4 + thrustGlow * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  // Ship body (triangle)
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(Math.atan2(fwdY, fwdX));
  ctx.fillStyle = '#48dbfb';
  ctx.strokeStyle = '#7ae5ff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(12 * dpr, 0);          // nose
  ctx.lineTo(-8 * dpr, 7 * dpr);    // right wing
  ctx.lineTo(-5 * dpr, 0);          // tail indent
  ctx.lineTo(-8 * dpr, -7 * dpr);   // left wing
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // HUD update
  els.pbHudTime.textContent = `${frame.time.toFixed(2)}s`;
  els.pbHudMode.textContent = frame.brain.mode;
  els.pbHudMode.className = `mode-badge ${frame.brain.mode}`;
  const actionStr =
    (frame.brain.yaw === 1 ? '↻' : frame.brain.yaw === -1 ? '↺' : '↑') +
    (frame.brain.thrust ? ' ⬆' : '') +
    (frame.brain.fire ? ' 🔥' : '');
  els.pbHudAction.textContent = actionStr || '—';
  els.pbHudSpeed.textContent = `${speed.toFixed(0)} u/s`;
}

/**
 * Main playback loop driven by requestAnimationFrame.
 */
function playbackTick() {
  if (playback.frames.length === 0) return;
  const now = performance.now();
  const dt = playback.lastTickMs ? (now - playback.lastTickMs) / 1000 : 0;
  playback.lastTickMs = now;

  if (playback.playing) {
    playback.time += dt * playback.speed;
    const last = playback.frames[playback.frames.length - 1];
    if (playback.time >= last.time) {
      playback.time = last.time;
      playback.playing = false;
      els.pbPlay.textContent = '▶ Play';
    }
  }

  playback.decoded = sampleAt(playback.time);
  // Record ship position in the trail ring buffer. Only push when
  // the ship has actually moved a meaningful distance to avoid
  // flooding the buffer with duplicate points when the ship is idle.
  if (playback.decoded) {
    const last = playback.trail[playback.trail.length - 1];
    const ship = playback.decoded.ship;
    if (!last || Math.hypot(ship.x - last.x, ship.z - last.z) > 1) {
      playback.trail.push({ x: ship.x, z: ship.z });
      if (playback.trail.length > playback.trailMax) {
        playback.trail.shift();
      }
    }
  }
  renderPlayback();

  if (playback.playing) {
    playback.rafId = requestAnimationFrame(playbackTick);
  }
}

function requestPlaybackFrame() {
  if (!playback.rafId) {
    playback.lastTickMs = 0;
    playback.rafId = requestAnimationFrame(() => {
      playback.rafId = 0;
      playbackTick();
    });
  }
}

function openPlaybackModal() {
  els.pbModal.hidden = false;
  resizePlaybackCanvas();
}

function closePlaybackModal() {
  els.pbModal.hidden = true;
  playback.playing = false;
  els.pbPlay.textContent = '▶ Play';
  if (playback.rafId) {
    cancelAnimationFrame(playback.rafId);
    playback.rafId = 0;
  }
}

async function loadAndPlay() {
  closePlaybackModal();
  openPlaybackModal();
  els.pbStatus.textContent = 'Recording best genome…';
  els.pbFrameInfo.textContent = '—';
  els.pbScore.textContent = '—';
  els.pbDied.textContent = '—';
  els.pbCanvas.getContext('2d').clearRect(0, 0, els.pbCanvas.width, els.pbCanvas.height);

  try {
    const res = await fetch(`${API_BASE}/playback`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      els.pbStatus.textContent = `Error: ${err.error || res.statusText}`;
      return;
    }
    const data = await res.json();
    // Decode frames once
    playback.frames = data.frames.map(decodeFrame);
    playback.time = 0;
    playback.trail.length = 0;
    playback.playing = true;
    els.pbPlay.textContent = '⏸ Pause';

    els.pbStatus.textContent = 'Playing';
    els.pbFrameInfo.textContent = `${data.frameCount} @ ${data.durationS.toFixed(1)}s`;
    els.pbScore.textContent = data.summary?.score ?? '—';
    els.pbDied.textContent = data.summary?.died ? 'yes' : 'no';

    resizePlaybackCanvas();
    playbackTick();
    log(`Playback loaded: ${data.frameCount} frames (${data.durationS.toFixed(1)}s)`, 'success');
  } catch (err) {
    els.pbStatus.textContent = `Error: ${err.message}`;
    log('Playback failed: ' + err.message, 'error');
  }
}

// Playback controls
els.btnPlayback.addEventListener('click', loadAndPlay);
els.pbClose.addEventListener('click', closePlaybackModal);
els.pbModal.addEventListener('click', (e) => {
  if (e.target === els.pbModal) closePlaybackModal();
});
document.addEventListener('keydown', (e) => {
  if (els.pbModal.hidden) return;
  if (e.key === 'Escape') closePlaybackModal();
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

els.pbPlay.addEventListener('click', togglePlay);

function togglePlay() {
  if (playback.frames.length === 0) return;
  playback.playing = !playback.playing;
  els.pbPlay.textContent = playback.playing ? '⏸ Pause' : '▶ Play';
  if (playback.playing) {
    // If at end, restart
    const last = playback.frames[playback.frames.length - 1];
    if (playback.time >= last.time) {
      playback.time = 0;
      playback.trail.length = 0;
    }
    requestPlaybackFrame();
  }
}

els.pbRestart.addEventListener('click', () => {
  playback.time = 0;
  playback.trail.length = 0;
  playback.decoded = sampleAt(0);
  renderPlayback();
});

els.pbStepBack.addEventListener('click', () => {
  playback.playing = false;
  els.pbPlay.textContent = '▶ Play';
  // Step back ~1 second
  playback.time = Math.max(0, playback.time - 1.0);
  playback.decoded = sampleAt(playback.time);
  renderPlayback();
});

els.pbStepForward.addEventListener('click', () => {
  playback.playing = false;
  els.pbPlay.textContent = '▶ Play';
  const last = playback.frames[playback.frames.length - 1];
  if (!last) return;
  playback.time = Math.min(last.time, playback.time + 1.0);
  playback.decoded = sampleAt(playback.time);
  renderPlayback();
});

els.pbSpeedSelect.addEventListener('change', (e) => {
  playback.speed = parseFloat(e.target.value) || 1;
});

els.pbFollowShip.addEventListener('change', (e) => {
  playback.followShip = e.target.checked;
  renderPlayback();
});

window.addEventListener('resize', () => {
  if (!els.pbModal.hidden) resizePlaybackCanvas();
});

// -----------------------------------------------------------------------
// Live Config — every param the trainer is actually using
// -----------------------------------------------------------------------

const CONFIG_HINTS = {
  populationSize: 'Brains per generation',
  'architecture.inputSize': 'Brain inputs (velocity vx/vz + 11 others)',
  'architecture.hiddenSize': 'Brain thinking layer size',
  'architecture.outputSize': 'Brain outputs (yaw, thrust, fire)',
  maxDurationS: 'Seconds per brain per episode',
  episodesPerGenome: 'Episodes averaged per brain (reduces noise)',
  dt: 'Brain step interval (s) \u2014 lower = more reactive',
  seedStrategy: 'Field layout: vary (generalize) or fixed (reproducible)',
  movementReward: 'Fitness bonus per unit traveled (discourages spin-in-place)',
  workerCount: 'CPU cores used for parallel evaluation (0 = single-threaded)',
  'ga.mutationRate': 'Chance each weight mutates per child',
  'ga.mutationStrength': 'Magnitude of each mutation',
  'ga.elitismCount': 'Top brains copied verbatim (no breeding)',
  'ga.crossoverRate': 'Chance parents are blended vs cloned',
  'ga.tournamentSize': 'Brains competing for each parent slot',
};

function renderLiveConfig(config) {
  if (!config || !els.liveConfigGrid) return;
  const flat = flattenConfig(config);
  els.liveConfigGrid.innerHTML = '';
  for (const [key, value] of Object.entries(flat)) {
    const chip = document.createElement('div');
    chip.className = 'live-config-chip';
    const label = document.createElement('div');
    label.className = 'chip-label';
    label.textContent = formatChipLabel(key);
    const val = document.createElement('div');
    val.className = 'chip-value';
    val.textContent = formatConfigValue(value);
    chip.appendChild(label);
    chip.appendChild(val);
    const hint = CONFIG_HINTS[key];
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'chip-hint';
      hintEl.textContent = hint;
      chip.appendChild(hintEl);
    }
    els.liveConfigGrid.appendChild(chip);
  }
  if (els.liveConfigStatus) {
    els.liveConfigStatus.textContent = `${Object.keys(flat).length} parameters \u2014 click any control to change`;
  }
}

function formatChipLabel(key) {
  return key
    .split('.')
    .map((segment) =>
      segment
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase())
    )
    .join(' \u00b7 ');
}

function flattenConfig(obj, prefix = '') {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(out, flattenConfig(val, fullKey));
    } else {
      out[fullKey] = val;
    }
  }
  return out;
}

function formatConfigValue(v) {
  if (v === null || v === undefined) return '\u2014';
  if (typeof v === 'number') {
    if (v > 0 && v < 1 && Math.abs(v * 100 - Math.round(v * 100)) < 0.001) {
      return `${Math.round(v * 100)}%`;
    }
    if (v < 1 && v > 0) {
      const inv = 1 / v;
      if (Math.abs(inv - Math.round(inv)) < 0.01) {
        return `1/${Math.round(inv)}s`;
      }
    }
    return String(v);
  }
  return String(v);
}

async function refreshLiveConfig() {
  try {
    const res = await fetch(`${API_BASE}/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.config) return;
    renderLiveConfig(data.config);
    // Update the Workers stat card. The server sends a preview
    // (with a resolved worker count from `os.cpus().length - 1`)
    // even when no trainer is running, so the card populates from
    // page load instead of staying at "—" until the user clicks Start.
    if (data.config.workerCount != null && els.workers) {
      els.workers.textContent = data.config.workerCount === 0
        ? 'single-threaded'
        : String(data.config.workerCount);
    }
    // Differentiate the Live Config header so the user knows
    // whether the chips reflect a running trainer or a preview.
    if (els.liveConfigStatus) {
      const status = data.running
        ? `${Object.keys(flattenConfig(data.config)).length} live parameters \u2014 click any control to change`
        : `${Object.keys(flattenConfig(data.config)).length} preview parameters \u2014 start training to lock in`;
      els.liveConfigStatus.textContent = status;
    }
  } catch (_) {
    // Server offline — keep the current state
  }
}

/**
 * After clicking Start, the trainer is created asynchronously inside
 * `runTrainingLoop`. There's a brief window (a few ms) where
 * `/config` still returns the preview instead of the real config.
 * Poll a few times to catch the transition, then stop.
 */
function pollLiveConfigUntilLive(retries = 10, intervalMs = 200) {
  let attempt = 0;
  const tick = async () => {
    attempt++;
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (res.ok) {
        const data = await res.json();
        if (data.running && data.config) {
          await refreshLiveConfig();
          return;
        }
      }
    } catch (_) { /* keep trying */ }
    if (attempt < retries) {
      setTimeout(tick, intervalMs);
    } else {
      // Last try even if not running — at least we have the latest state
      refreshLiveConfig();
    }
  };
  setTimeout(tick, intervalMs);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

connectSSE();

// Fetch initial status
fetch(`${API_BASE}/status`)
  .then((r) => r.json())
  .then((data) => {
    updateStats(data);
    if (data.running) {
      isRunning = true;
      setStatus('running');
      updateButtons();
      log('Training is already running — connected mid-stream');
    } else {
      setStatus('idle');
    }
  })
  .catch(() => {
    setStatus('error');
    log('Server not reachable. Start it with: npm run train:server', 'error');
  });

// Fetch the current config so the Live Config section populates immediately
// when the dashboard loads (in case training was started before the page
// was opened). refreshLiveConfig() handles server-down gracefully.
refreshLiveConfig();

// First-time-use guidance
log('Welcome! Read the green "What is happening here?" panel above for a 30-second tour.');
log('Click ▶ Start to begin training. The first generation takes ~10s, then they run every 5–10s.');
// Refresh Live Config periodically (every 5s) so changes mid-run are visible
setInterval(refreshLiveConfig, 5000);
