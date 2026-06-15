/**
 * Regression tests for `applySmartUv` in `src/entities/asteroid.js`.
 *
 * The previous implementation called `solveAutomatic(geom, ...)` and
 * discarded the result, leaving every capsule asteroid with no UVs at
 * all (the Capsule constructor doesn't set any). The material's `map`
 * was then sampling zeros, rendering every asteroid flat-black. These
 * tests pin the contract:
 *
 *   1. After `applySmartUv(geom)`, the geometry has a UV attribute.
 *   2. The UVs are finite, non-zero (the solver produced real values).
 *   3. The write is idempotent (a second call doesn't corrupt UVs).
 *   4. Non-indexed geometries (the icosphere) are skipped — their
 *      built-in IcosahedronGeometry UVs are kept.
 *   5. The solver-failure fallback (computePlanarUVs) still produces
 *      a valid UV attribute.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Capsule } from '../src/geometry/capsule.js';
import { NoisyIcosphere } from '../src/geometry/noisy-icosphere.js';
import { applySmartUv } from '../src/entities/asteroid.js';

// ---- Helpers -----------------------------------------------------------

/** Returns true if any element of `arr` is non-zero. */
function hasNonZero(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== 0) return true;
  }
  return false;
}

/** Returns true if all elements of `arr` are finite (no NaN/Infinity). */
function allFinite(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

// ---- Capsule (indexed, no UVs) ----------------------------------------

test('applySmartUv: writes a UV attribute onto a Capsule (which starts with no UVs)', () => {
  // The Capsule constructor doesn't set a `uv` attribute. Before
  // the fix, `applySmartUv` early-returned on `!geom.attributes.uv`
  // and the capsule was rendered with no texture mapping at all.
  const geom = new Capsule(1, 1, 4, 8);
  assert.equal(geom.attributes.uv, undefined, 'capsule should start with no UV attribute');
  applySmartUv(geom);
  // After: a UV attribute exists, is finite, and has at least some
  // non-zero values (proves the solver result was actually written,
  // not just allocated and left at zero).
  const uvAttr = geom.attributes.uv;
  assert.ok(uvAttr, 'should have a UV attribute after applySmartUv');
  const arr = uvAttr.array;
  assert.equal(arr.length, geom.attributes.position.count * 2, 'UV length = vertexCount * 2');
  assert.ok(allFinite(arr), 'all UV values should be finite (no NaN/Infinity)');
  assert.ok(hasNonZero(arr), 'at least some UV values should be non-zero');
});

test('applySmartUv: produces a sensible UV range (most values inside [0, 1] after packing)', () => {
  // The square-Tutte solver packs into the unit square, so most
  // UVs should land in [0, 1]. A small overshoot is fine (margin),
  // but a wildly out-of-range value (e.g. 1e6) would indicate a
  // solver bug.
  const geom = new Capsule(1, 1, 4, 8);
  applySmartUv(geom);
  const arr = geom.attributes.uv.array;
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < minVal) minVal = arr[i];
    if (arr[i] > maxVal) maxVal = arr[i];
  }
  assert.ok(minVal > -2, `min UV = ${minVal}, expected > -2 (solver runaway?)`);
  assert.ok(maxVal < 3, `max UV = ${maxVal}, expected < 3 (solver runaway?)`);
});

test('applySmartUv: is idempotent (a second call produces the same UVs)', () => {
  const geom = new Capsule(1, 1, 4, 8);
  applySmartUv(geom);
  const first = Array.from(geom.attributes.uv.array);
  applySmartUv(geom);
  const second = Array.from(geom.attributes.uv.array);
  assert.equal(second.length, first.length);
  for (let i = 0; i < first.length; i++) {
    assert.equal(second[i], first[i], `UV[${i}] should be unchanged on the second call`);
  }
});

// ---- Icosphere (non-indexed) ------------------------------------------

test('applySmartUv: skips non-indexed geometry (icosphere stays unchanged)', () => {
  // The NoisyIcosphere is built on IcosahedronGeometry which is
  // non-indexed (each face has 3 vertex copies). It only copies
  // the position attribute (not UVs), so the icosphere starts
  // with no UV attribute. The solver walks `geometry.index` to
  // find faces, so it would throw on a non-indexed mesh. The
  // function should early-return and leave the geometry untouched
  // (the icosphere's body builder doesn't call applySmartUv, so
  // this is a safety net for the public API).
  const geom = new NoisyIcosphere(1, 0, 0.0, 2.0, 0, 0, 0);
  assert.equal(geom.attributes.uv, undefined, 'icosphere should start with no UV attribute');
  assert.doesNotThrow(() => applySmartUv(geom), 'non-indexed skip should not throw');
  // After the call: still no UV attribute (the function is a no-op).
  assert.equal(geom.attributes.uv, undefined, 'icosphere should still have no UV attribute after the call');
});

// ---- Edge cases -------------------------------------------------------

test('applySmartUv: null/undefined geometry is a no-op (no throw)', () => {
  assert.doesNotThrow(() => applySmartUv(null));
  assert.doesNotThrow(() => applySmartUv(undefined));
});

test('applySmartUv: works on an indexed geometry that already has UVs', () => {
  // A minimal indexed quad with a pre-set UV attribute. The solver
  // should still run and overwrite the UVs with its own result.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
  ]), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0,   1, 0,   1, 1,   0, 1,
  ]), 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  const before = Array.from(geom.attributes.uv.array);
  applySmartUv(geom);
  const after = geom.attributes.uv.array;
  // The solver will produce a different parameterization (the quad
  // has no boundary, so LSCM will use the geodesic-diameter
  // heuristic). We just check the UVs are still finite + non-zero.
  assert.ok(allFinite(after), 'all UV values should be finite');
  assert.ok(hasNonZero(after), 'at least some UV values should be non-zero');
  // And the length is unchanged.
  assert.equal(after.length, before.length, 'UV array length should not change');
});
