/**
 * Visual smoke test for the chunked world (ASCII).
 * Prints a density map and an asteroid-count map for a sampled region of
 * the world, plus summary stats. Useful for eyeballing the world generator
 * before wiring up Three.js.
 *
 * Run with: `node scripts/dump-field.js`
 */
import {
  CHUNK_SIZE,
  DENSITY_FLOOR,
  INITIAL_SYSTEM_SEED,
  generateChunk,
  densityAt,
} from '../src/world/index.js';

// ---- Config ---------------------------------------------------------------
const GRID_W = 60;
const GRID_H = 30;
const ORIGIN_CX = -Math.floor(GRID_W / 2);
const ORIGIN_CZ = -Math.floor(GRID_H / 2);
const SYSTEM_SEED = INITIAL_SYSTEM_SEED;

// Density ramp: void (space) → low → high.
const DENSITY_CHARS = ' .:-=+*#%@';
// Asteroid count: 0 = space, 1-9 = digits, 10+ = A-Z (up to 35).
function countChar(n) {
  if (n === 0) return ' ';
  if (n < 10) return String(n);
  if (n < 36) return String.fromCharCode(55 + n); // 10 → 'A'
  return '#';
}

const sep = '='.repeat(GRID_W + 12);
const sub = '-'.repeat(GRID_W + 12);

// ---- Header ---------------------------------------------------------------
console.log(sep);
console.log(`Chunked World — ASCII dump`);
console.log(`  systemSeed = 0x${SYSTEM_SEED.toString(16).toUpperCase()}`);
console.log(`  chunk size = ${CHUNK_SIZE}u`);
console.log(`  grid       = ${GRID_W} x ${GRID_H} chunks  (world origin at chunk (${ORIGIN_CX}, ${ORIGIN_CZ}))`);
console.log(`  density legend:  ' . : - = + * # % @'  (void → dense)`);
console.log(`  count legend:    ' ' = 0,  '1'..'9' = 1..9,  'A'..'Z' = 10..35`);
console.log(sep);

// ---- Density pass ---------------------------------------------------------
let minD = Infinity, maxD = -Infinity, sumD = 0;
let voidCount = 0, denseCount = 0;
console.log('\n[1] DENSITY (one char per chunk)');
for (let cz = 0; cz < GRID_H; cz++) {
  let row = `cz=${String(ORIGIN_CZ + cz).padStart(3)} | `;
  for (let cx = 0; cx < GRID_W; cx++) {
    const d = densityAt(ORIGIN_CX + cx, ORIGIN_CZ + cz, SYSTEM_SEED);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    sumD += d;
    if (d < DENSITY_FLOOR) voidCount++;
    if (d > 0.7) denseCount++;
    const idx = Math.min(DENSITY_CHARS.length - 1, Math.floor(d * DENSITY_CHARS.length));
    row += DENSITY_CHARS[idx];
  }
  console.log(row);
}

// ---- Asteroid-count pass --------------------------------------------------
let totalAsteroids = 0;
const histogram = new Map();
console.log('\n[2] ASTEROID COUNT (one char per chunk)');
for (let cz = 0; cz < GRID_H; cz++) {
  let row = `cz=${String(ORIGIN_CZ + cz).padStart(3)} | `;
  for (let cx = 0; cx < GRID_W; cx++) {
    const chunk = generateChunk({
      cx: ORIGIN_CX + cx,
      cz: ORIGIN_CZ + cz,
      systemSeed: SYSTEM_SEED,
    });
    const n = chunk.asteroids.length;
    totalAsteroids += n;
    histogram.set(n, (histogram.get(n) || 0) + 1);
    row += countChar(n);
  }
  console.log(row);
}

// ---- Stats ----------------------------------------------------------------
const totalChunks = GRID_W * GRID_H;
console.log('\n' + sub);
console.log('Stats:');
console.log(`  Chunks sampled     : ${totalChunks}`);
console.log(`  Density  min/avg/max: ${minD.toFixed(3)} / ${(sumD / totalChunks).toFixed(3)} / ${maxD.toFixed(3)}`);
console.log(`  Void chunks (< ${DENSITY_FLOOR}) : ${voidCount} (${(100 * voidCount / totalChunks).toFixed(1)}%)`);
console.log(`  Dense chunks (> 0.7): ${denseCount} (${(100 * denseCount / totalChunks).toFixed(1)}%)`);
console.log(`  Total asteroids    : ${totalAsteroids}  (avg ${(totalAsteroids / totalChunks).toFixed(2)} per chunk)`);
console.log('\n  Asteroid-count histogram:');
const sortedCounts = Array.from(histogram.entries()).sort((a, b) => a[0] - b[0]);
for (const [count, chunks] of sortedCounts) {
  const bar = '#'.repeat(Math.min(60, Math.floor(chunks / 2)));
  console.log(`    ${String(count).padStart(2)}: ${String(chunks).padStart(4)} chunks  ${bar}`);
}
console.log(sep);
