/**
 * Persistence layer for training genomes and populations.
 *
 * Saves to JSON files under `training-data/` (relative to project root).
 * The genome is stored as a flat number array; metadata (generation,
 * fitness, timestamp) is stored alongside it.
 *
 * Public API:
 *   - `saveGenome(filepath, genome, metadata?)`
 *   - `loadGenome(filepath)` → { genome, metadata }
 *   - `savePopulation(filepath, population, metadata?)`
 *   - `loadPopulation(filepath)` → { population, metadata }
 *   - `ensureDir(dir)`
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { serializeGenome, deserializeGenome } from './network.js';

const DEFAULT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'training-data'
);

/**
 * @param {string} dir
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * @param {string} filepath
 * @param {Float32Array} genome
 * @param {object} [metadata]
 */
export function saveGenome(filepath, genome, metadata = {}) {
  const payload = {
    version: 1,
    timestamp: Date.now(),
    metadata,
    genome: serializeGenome(genome),
  };
  ensureDir(dirname(filepath));
  writeFileSync(filepath, JSON.stringify(payload, null, 2));
}

/**
 * @param {string} filepath
 * @returns {{ genome: Float32Array, metadata: object }}
 */
export function loadGenome(filepath) {
  const raw = readFileSync(filepath, 'utf-8');
  const payload = JSON.parse(raw);
  if (!payload || !Array.isArray(payload.genome)) {
    throw new Error(`loadGenome: invalid file format at ${filepath}`);
  }
  return {
    genome: deserializeGenome(payload.genome),
    metadata: payload.metadata || {},
  };
}

/**
 * @param {string} filepath
 * @param {Float32Array[]} population
 * @param {object} [metadata]
 */
export function savePopulation(filepath, population, metadata = {}) {
  const payload = {
    version: 1,
    timestamp: Date.now(),
    metadata,
    population: population.map((g) => serializeGenome(g)),
  };
  ensureDir(dirname(filepath));
  writeFileSync(filepath, JSON.stringify(payload, null, 2));
}

/**
 * @param {string} filepath
 * @returns {{ population: Float32Array[], metadata: object }}
 */
export function loadPopulation(filepath) {
  const raw = readFileSync(filepath, 'utf-8');
  const payload = JSON.parse(raw);
  if (!payload || !Array.isArray(payload.population)) {
    throw new Error(`loadPopulation: invalid file format at ${filepath}`);
  }
  return {
    population: payload.population.map((g) => deserializeGenome(g)),
    metadata: payload.metadata || {},
  };
}

/**
 * Convenience: build a default path inside the training-data folder.
 * @param {string} filename
 * @returns {string}
 */
export function trainingDataPath(filename) {
  return resolve(DEFAULT_DIR, filename);
}
