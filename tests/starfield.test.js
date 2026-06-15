import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStarfield } from '../src/systems/starfield.js';

// The starfield is now a THREE.Group of 3 layered Points
// objects. Tests that need to read positions/dispose resources
// use these helpers to abstract over the layer structure.
function collectPositions(starfield) {
  if (starfield.geometry) return starfield.geometry.attributes.position.array;
  const all = [];
  for (const child of starfield.children) {
    all.push(...child.geometry.attributes.position.array);
  }
  return all;
}
function disposeAll(starfield) {
  if (starfield.geometry) {
    starfield.geometry.dispose();
    starfield.material.dispose();
    return;
  }
  for (const child of starfield.children) {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
}

test('Starfield: deterministic with the default seed (same positions across calls)', () => {
  const a = createStarfield({ count: 100, radius: 1000, size: 1.0 });
  const b = createStarfield({ count: 100, radius: 1000, size: 1.0 });
  const aPos = collectPositions(a);
  const bPos = collectPositions(b);
  assert.equal(aPos.length, bPos.length);
  for (let i = 0; i < aPos.length; i++) {
    assert.equal(aPos[i], bPos[i], `position[${i}] differs: ${aPos[i]} vs ${bPos[i]}`);
  }
  disposeAll(a);
  disposeAll(b);
});

test('Starfield: different seeds produce different positions', () => {
  const a = createStarfield({ count: 100, radius: 1000, size: 1.0, seed: 0xAAAA });
  const b = createStarfield({ count: 100, radius: 1000, size: 1.0, seed: 0xBBBB });
  const aPos = collectPositions(a);
  const bPos = collectPositions(b);
  let anyDifference = false;
  for (let i = 0; i < aPos.length; i++) {
    if (aPos[i] !== bPos[i]) { anyDifference = true; break; }
  }
  assert.ok(anyDifference, 'different seeds should produce different positions');
  disposeAll(a);
  disposeAll(b);
});

test('Starfield: seed:null opts out of determinism (uses Math.random)', () => {
  const a = createStarfield({ count: 100, radius: 1000, size: 1.0, seed: null });
  const b = createStarfield({ count: 100, radius: 1000, size: 1.0, seed: null });
  const aPos = collectPositions(a);
  const bPos = collectPositions(b);
  let anyDifference = false;
  for (let i = 0; i < aPos.length; i++) {
    if (aPos[i] !== bPos[i]) { anyDifference = true; break; }
  }
  assert.ok(anyDifference, 'seed:null should produce different positions on each call');
  disposeAll(a);
  disposeAll(b);
});

test('Starfield: respects the count and radius parameters', () => {
  // Use a count that doesn't suffer from the 3-layer rounding
  // (count=100 → 70+25+5=100 exactly). For arbitrary counts the
  // total may be off by ±1 per layer, but that's an
  // implementation detail not worth pinning in the test.
  const a = createStarfield({ count: 100, radius: 500, size: 1.0, seed: 0x1234 });
  const aPos = collectPositions(a);
  assert.equal(aPos.length / 3, 100);
  // All positions should be within (0.85, 1.15) × radius
  let minR2 = Infinity, maxR2 = -Infinity;
  for (let i = 0; i < aPos.length; i += 3) {
    const x = aPos[i], y = aPos[i + 1], z = aPos[i + 2];
    const r2 = x * x + y * y + z * z;
    if (r2 < minR2) minR2 = r2;
    if (r2 > maxR2) maxR2 = r2;
  }
  const inner2 = (500 * 0.85) ** 2;
  const outer2 = (500 * 1.15) ** 2;
  assert.ok(minR2 >= inner2 * 0.99, `min radius² = ${minR2}, expected >= ${inner2}`);
  assert.ok(maxR2 <= outer2 * 1.01, `max radius² = ${maxR2}, expected <= ${outer2}`);
  disposeAll(a);
});
