import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NoisyIcosphere } from '../src/geometry/noisy-icosphere.js';

test('NoisyIcosphere: non-indexed geometry (no index buffer)', () => {
  const geom = new NoisyIcosphere(1, 1, 0.3, 2.0);
  assert.equal(geom.index, null);
});

test('NoisyIcosphere: vertex count matches IcosahedronGeometry for the given detail', () => {
  for (const detail of [0, 1, 2, 3]) {
    const geom = new NoisyIcosphere(1, detail, 0.3, 2.0);
    const expected = new THREE.IcosahedronGeometry(1, detail).attributes.position.count;
    assert.equal(
      geom.attributes.position.count,
      expected,
      `detail ${detail}: got ${geom.attributes.position.count}, expected ${expected}`,
    );
  }
});

test('NoisyIcosphere: position attribute is 3D (itemSize = 3)', () => {
  const geom = new NoisyIcosphere(1, 1, 0.3, 2.0);
  assert.equal(geom.attributes.position.itemSize, 3);
});

test('NoisyIcosphere: noise displacement keeps vertices near the original radius', () => {
  const radius = 5;
  const noiseAmount = 0.5;
  const geom = new NoisyIcosphere(radius, 2, noiseAmount, 1.0);
  const positions = geom.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const dist = Math.sqrt(x * x + y * y + z * z);
    assert.ok(
      dist >= radius - noiseAmount - 0.01 && dist <= radius + noiseAmount + 0.01,
      `vertex ${i} at distance ${dist}, expected [${radius - noiseAmount}, ${radius + noiseAmount}]`,
    );
  }
});

test('NoisyIcosphere: zero noise produces a perfect sphere', () => {
  const radius = 3;
  const geom = new NoisyIcosphere(radius, 2, 0, 2.0);
  const positions = geom.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const dist = Math.sqrt(x * x + y * y + z * z);
    assert.ok(
      Math.abs(dist - radius) < 0.01,
      `vertex ${i} at distance ${dist}, expected ${radius}`,
    );
  }
});

test('NoisyIcosphere: deterministic — same params produce identical output', () => {
  const g1 = new NoisyIcosphere(1, 2, 0.3, 2.0, 0.5, 1.5, 2.5);
  const g2 = new NoisyIcosphere(1, 2, 0.3, 2.0, 0.5, 1.5, 2.5);
  const p1 = g1.attributes.position.array;
  const p2 = g2.attributes.position.array;
  assert.equal(p1.length, p2.length);
  for (let i = 0; i < p1.length; i++) {
    assert.ok(
      Math.abs(p1[i] - p2[i]) < 1e-6,
      `position ${i} differs: ${p1[i]} vs ${p2[i]}`,
    );
  }
});

test('NoisyIcosphere: different offsets produce different shapes', () => {
  const g1 = new NoisyIcosphere(1, 2, 0.3, 2.0, 0, 0, 0);
  const g2 = new NoisyIcosphere(1, 2, 0.3, 2.0, 100, 200, 300);
  const p1 = g1.attributes.position.array;
  const p2 = g2.attributes.position.array;
  let differences = 0;
  for (let i = 0; i < p1.length; i++) {
    if (Math.abs(p1[i] - p2[i]) > 1e-3) differences++;
  }
  // Most vertices should differ (different noise pattern)
  assert.ok(
    differences > p1.length * 0.5,
    `only ${differences}/${p1.length} positions differ — offsets should produce visibly different shapes`,
  );
});

test('NoisyIcosphere: faces stay connected — 3 copies of a vertex get the same displacement', () => {
  // This is the key invariant: since the noise is position-based and
  // the 3 vertex copies of each face share the same pre-noise position,
  // they must get the same displacement and end up at the same
  // post-noise position. If they don't, the faces tear (gaps appear).
  const geom = new NoisyIcosphere(1, 2, 0.5, 2.0);
  const positions = geom.attributes.position;

  // Group vertices by their original (pre-noise) position
  const baseGeom = new THREE.IcosahedronGeometry(1, 2);
  const basePositions = baseGeom.attributes.position;
  const groups = new Map();
  for (let i = 0; i < positions.count; i++) {
    const bx = basePositions.getX(i);
    const by = basePositions.getY(i);
    const bz = basePositions.getZ(i);
    const key = `${bx.toFixed(5)},${by.toFixed(5)},${bz.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      x: positions.getX(i),
      y: positions.getY(i),
      z: positions.getZ(i),
    });
  }
  // Every group with 2+ members must have all members at the same
  // post-noise position (within floating-point tolerance).
  for (const [key, verts] of groups) {
    if (verts.length < 2) continue;
    const ref = verts[0];
    for (let i = 1; i < verts.length; i++) {
      const dx = verts[i].x - ref.x;
      const dy = verts[i].y - ref.y;
      const dz = verts[i].z - ref.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assert.ok(
        dist < 1e-4,
        `group "${key}" has vertices ${dist} apart after noise (should be ~0) — faces would tear!`,
      );
    }
  }
  baseGeom.dispose();
});

test('NoisyIcosphere: all vertices are finite after construction (no NaN / Infinity)', () => {
  const geom = new NoisyIcosphere(1, 3, 0.5, 5.0, 100, 200, 300);
  for (let i = 0; i < geom.attributes.position.count; i++) {
    assert.ok(Number.isFinite(geom.attributes.position.getX(i)), `vertex ${i} x not finite`);
    assert.ok(Number.isFinite(geom.attributes.position.getY(i)), `vertex ${i} y not finite`);
    assert.ok(Number.isFinite(geom.attributes.position.getZ(i)), `vertex ${i} z not finite`);
  }
});

test('NoisyIcosphere: handles a wide range of parameter combinations without errors', () => {
  for (const detail of [0, 1, 2, 3]) {
    for (const noiseAmount of [0, 0.1, 0.5, 1.0]) {
      for (const noiseScale of [0.5, 2.0, 5.0]) {
        const g = new NoisyIcosphere(1, detail, noiseAmount, noiseScale, 0.1, 0.2, 0.3);
        assert.ok(g.attributes.position.count > 0);
        // Spot-check a few vertices are finite
        for (let i = 0; i < g.attributes.position.count; i += 13) {
          assert.ok(Number.isFinite(g.attributes.position.getX(i)));
          assert.ok(Number.isFinite(g.attributes.position.getY(i)));
          assert.ok(Number.isFinite(g.attributes.position.getZ(i)));
        }
      }
    }
  }
});
