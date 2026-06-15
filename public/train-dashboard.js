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
  paramPop: document.getElementById('param-pop'),
  paramHidden: document.getElementById('param-hidden'),
  paramDuration: document.getElementById('param-duration'),
  logEntries: document.getElementById('log-entries'),
  uploadArea: document.getElementById('upload-area'),
  uploadInput: document.getElementById('upload-input'),
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
      updateButtons();
      log('Training started', 'success');
    } else if (data.type === 'stopped') {
      isRunning = false;
      updateButtons();
      log('Training stopped', 'info');
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

function updateButtons() {
  els.btnStart.disabled = isRunning;
  els.btnStop.disabled = !isRunning;
  els.btnDeploy.disabled = !chartData.best.length;
  els.btnDownload.disabled = !chartData.best.length;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

els.btnStart.addEventListener('click', async () => {
  const params = {
    populationSize: parseInt(els.paramPop.value, 10) || 100,
    hiddenSize: parseInt(els.paramHidden.value, 10) || 12,
    maxDurationS: parseInt(els.paramDuration.value, 10) || 60,
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
      updateButtons();
      log('Training is already running');
    }
  })
  .catch(() => {
    log('Server not reachable — is it running? (npm run train:server)', 'error');
  });

log('Dashboard ready. Press Start to begin training.');
