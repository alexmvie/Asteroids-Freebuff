/**
 * AI Training Dashboard Server
 *
 * Serves a web GUI for training the AI brain via neuroevolution.
 * Runs on port 5174 (separate from the Vite game server on 5173).
 *
 * Endpoints:
 *   GET  /              → dashboard HTML
 *   GET  /events        → SSE stream for real-time training progress
 *   POST /start         → begin training with params
 *   POST /stop          → stop training
 *   GET  /status        → current training state
 *   GET  /download      → download best genome as JSON
 *   POST /upload        → upload a genome JSON
 *   POST /deploy        → save best genome to public/trained-genome.json
 *
 * Usage:
 *   npm run train:server
 *   # or
 *   node scripts/train-server.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createTrainer,
  saveGenome,
  loadGenome,
  trainingDataPath,
  serializeGenome,
  deserializeGenome,
} from '../src/training/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const PORT = 5174;

// ---------------------------------------------------------------------------
// Training state
// ---------------------------------------------------------------------------

let trainer = null;
let trainingState = {
  running: false,
  generation: 0,
  bestFitness: 0,
  avgFitness: 0,
  bestEverFitness: 0,
  bestGenome: null,
};
let shouldStop = false;
const sseClients = new Set();

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(message);
    } catch (e) {
      // Client disconnected; cleaned up in close handler
    }
  }
}

// ---------------------------------------------------------------------------
// Training loop
// ---------------------------------------------------------------------------

async function runTrainingLoop(params) {
  trainer = createTrainer({
    populationSize: params.populationSize || 100,
    hiddenSize: params.hiddenSize || 12,
    maxDurationS: params.maxDurationS || 60,
    dt: params.dt || 1 / 60,
    onProgress: (stats) => {
      trainingState = {
        running: true,
        generation: stats.generation,
        bestFitness: stats.bestFitness,
        avgFitness: stats.avgFitness,
        bestEverFitness: stats.bestEverFitness,
        bestGenome: stats.bestGenome,
      };
      broadcast({ type: 'progress', ...stats });
    },
  });

  trainingState.running = true;
  shouldStop = false;
  broadcast({ type: 'started' });

  while (!shouldStop) {
    const result = trainer.runGeneration();

    // Save best genome to training-data/ whenever it improves
    if (result.bestGenome && result.bestFitness >= trainingState.bestEverFitness) {
      saveGenome(trainingDataPath('best-genome.json'), result.bestGenome, {
        generation: result.generation,
        fitness: result.bestFitness,
      });
    }
  }

  trainingState.running = false;
  broadcast({ type: 'stopped' });
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function serveFile(res, filepath, contentType) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
  // Send current status immediately
  res.write(`data: ${JSON.stringify({ type: 'status', ...trainingState })}\n\n`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

async function handleStart(req, res) {
  const body = await readBody(req);
  const params = body ? JSON.parse(body) : {};

  if (trainingState.running) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Training already running' }));
    return;
  }

  // Start training in background (non-blocking)
  runTrainingLoop(params);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ started: true }));
}

function handleStop(req, res) {
  shouldStop = true;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ stopped: true }));
}

function handleStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(trainingState));
}

function handleDownload(req, res) {
  if (!trainingState.bestGenome) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No genome available' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    genome: serializeGenome(trainingState.bestGenome),
    generation: trainingState.generation,
    fitness: trainingState.bestFitness,
  }));
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  const data = JSON.parse(body);
  const genome = deserializeGenome(data.genome);
  trainingState.bestGenome = genome;
  trainingState.bestFitness = data.fitness || 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ uploaded: true }));
}

function handleDeploy(req, res) {
  if (!trainingState.bestGenome) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No genome to deploy' }));
    return;
  }
  const deployPath = path.join(PUBLIC_DIR, 'trained-genome.json');
  const payload = {
    version: 1,
    timestamp: Date.now(),
    genome: serializeGenome(trainingState.bestGenome),
    generation: trainingState.generation,
    fitness: trainingState.bestFitness,
  };
  fs.writeFileSync(deployPath, JSON.stringify(payload, null, 2));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deployed: true, path: '/trained-genome.json' }));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  switch (url.pathname) {
    case '/':
      serveFile(res, path.join(PUBLIC_DIR, 'train-dashboard.html'), 'text/html');
      break;
    case '/train-dashboard.css':
      serveFile(res, path.join(PUBLIC_DIR, 'train-dashboard.css'), 'text/css');
      break;
    case '/train-dashboard.js':
      serveFile(res, path.join(PUBLIC_DIR, 'train-dashboard.js'), 'application/javascript');
      break;
    case '/events':
      handleSSE(req, res);
      break;
    case '/start':
      if (req.method === 'POST') handleStart(req, res);
      else { res.writeHead(405); res.end('Method not allowed'); }
      break;
    case '/stop':
      if (req.method === 'POST') handleStop(req, res);
      else { res.writeHead(405); res.end('Method not allowed'); }
      break;
    case '/status':
      handleStatus(req, res);
      break;
    case '/download':
      handleDownload(req, res);
      break;
    case '/upload':
      if (req.method === 'POST') handleUpload(req, res);
      else { res.writeHead(405); res.end('Method not allowed'); }
      break;
    case '/deploy':
      if (req.method === 'POST') handleDeploy(req, res);
      else { res.writeHead(405); res.end('Method not allowed'); }
      break;
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🧠 AI Training Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Start training, then deploy the best genome to the game.`);
  console.log(`  The game (port 5173) will auto-load /trained-genome.json on boot.\n`);
});
