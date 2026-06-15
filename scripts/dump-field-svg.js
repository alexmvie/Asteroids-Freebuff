/**
 * Visual smoke test for the chunked world (SVG).
 * Writes an SVG file showing density (background color) and asteroid
 * positions (colored circles) for a sampled region. Open the resulting
 * `field.svg` in a browser to see the world at a glance.
 *
 * Run with: `node scripts/dump-field-svg.js`
 * Output:   field.svg in the project root.
 */
import { writeFileSync } from 'node:fs';
import {
  CHUNK_SIZE,
  DENSITY_FLOOR,
  INITIAL_SYSTEM_SEED,
  generateChunk,
  densityAt,
  sizeRadius,
} from '../src/world/index.js';

// ---- Config ---------------------------------------------------------------
const GRID_W = 60;
const GRID_H = 30;
const ORIGIN_CX = -Math.floor(GRID_W / 2);
const ORIGIN_CZ = -Math.floor(GRID_H / 2);
const SYSTEM_SEED = INITIAL_SYSTEM_SEED;
const CELL_PX = 12;
const PAD = 40;
const LEGEND_H = 60;
const WIDTH = GRID_W * CELL_PX + PAD * 2;
const HEIGHT = GRID_H * CELL_PX + PAD * 2 + LEGEND_H;

const SIZE_COLORS = { 0: '#ff6b6b', 1: '#feca57', 2: '#48dbfb' };
const SIZE_NAMES = { 0: 'large', 1: 'medium', 2: 'small' };

/** Density → background color. Voids stay near-black; dense goes yellow. */
function densityColor(d) {
  if (d < DENSITY_FLOOR) return '#0a0a1a';
  const t = (d - DENSITY_FLOOR) / (1 - DENSITY_FLOOR);
  const hue = 220 - 170 * t;          // blue → yellow
  const sat = 60 + 20 * t;
  const light = 15 + 25 * t;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

const parts = [];
parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`);
parts.push(`<style>text { font-family: ui-monospace, monospace; fill: #eee; }</style>`);
parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#000"/>`);
parts.push(`<text x="${PAD}" y="22" font-size="14" font-weight="bold">Chunked World — systemSeed=0x${SYSTEM_SEED.toString(16).toUpperCase()}, ${CHUNK_SIZE}u chunks, grid ${GRID_W}x${GRID_H}</text>`);
parts.push(`<text x="${PAD}" y="40" font-size="11" opacity="0.7">Origin at chunk (${ORIGIN_CX}, ${ORIGIN_CZ}) — XZ plane, Y=0</text>`);

// Chunk density backgrounds
for (let cz = 0; cz < GRID_H; cz++) {
  for (let cx = 0; cx < GRID_W; cx++) {
    const d = densityAt(ORIGIN_CX + cx, ORIGIN_CZ + cz, SYSTEM_SEED);
    const x = PAD + cx * CELL_PX;
    const y = PAD + cz * CELL_PX;
    parts.push(`<rect x="${x}" y="${y}" width="${CELL_PX}" height="${CELL_PX}" fill="${densityColor(d)}" stroke="#222" stroke-width="0.5"/>`);
  }
}

// Asteroids
let asteroidCount = 0;
for (let cz = 0; cz < GRID_H; cz++) {
  for (let cx = 0; cx < GRID_W; cx++) {
    const chunk = generateChunk({
      cx: ORIGIN_CX + cx,
      cz: ORIGIN_CZ + cz,
      systemSeed: SYSTEM_SEED,
    });
    for (const a of chunk.asteroids) {
      asteroidCount++;
      const localX = (a.position.x - (ORIGIN_CX + cx) * CHUNK_SIZE) / CHUNK_SIZE;
      const localZ = (a.position.z - (ORIGIN_CZ + cz) * CHUNK_SIZE) / CHUNK_SIZE;
      const x = PAD + (cx + localX) * CELL_PX;
      const y = PAD + (cz + localZ) * CELL_PX;
      const r = Math.max(1.2, sizeRadius(a.size) * 0.25);
      parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="${SIZE_COLORS[a.size]}" stroke="#000" stroke-width="0.3" opacity="0.95"/>`);
    }
  }
}

// Legend
const legendY = PAD + GRID_H * CELL_PX + 24;
parts.push(`<text x="${PAD}" y="${legendY}" font-size="12" font-weight="bold">Asteroid sizes:</text>`);
let lx = PAD + 110;
for (const size of [0, 1, 2]) {
  parts.push(`<circle cx="${lx}" cy="${legendY - 4}" r="5" fill="${SIZE_COLORS[size]}"/>`);
  parts.push(`<text x="${lx + 10}" y="${legendY}" font-size="11">${SIZE_NAMES[size]} (r=${sizeRadius(size)}u)</text>`);
  lx += 130;
}

// Density gradient swatch
const swatchY = legendY + 20;
parts.push(`<text x="${PAD}" y="${swatchY}" font-size="12" font-weight="bold">Density:</text>`);
for (let i = 0; i <= 20; i++) {
  const d = i / 20;
  parts.push(`<rect x="${PAD + 110 + i * 14}" y="${swatchY - 8}" width="14" height="10" fill="${densityColor(d)}" stroke="#222" stroke-width="0.3"/>`);
}
parts.push(`<text x="${PAD + 110}" y="${swatchY + 16}" font-size="10" opacity="0.7">void</text>`);
parts.push(`<text x="${PAD + 110 + 280 - 30}" y="${swatchY + 16}" font-size="10" opacity="0.7">dense</text>`);

parts.push(`</svg>`);

const out = parts.join('\n');
writeFileSync('field.svg', out);
console.log(`Wrote field.svg (${WIDTH}x${HEIGHT}, ${GRID_W * GRID_H} chunks, ${asteroidCount} asteroids)`);
