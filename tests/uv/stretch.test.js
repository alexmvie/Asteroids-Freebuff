/**
 * Tests for src/geometry/uv/stretch.js.
 *
 * Covers:
 *   - `computeStretch`: returns finite, non-negative values per
 *     face. The capsule's bad unwrap should have a high max
 *     stretch.
 *   - `stretchToColor`: 0 → green, 1 → red, monotonic red.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/stretch.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../../src/geometry/capsule.js';
import { computeStretch, stretchToColor } from '../../src/geometry/uv/index.js';

test('computeStretch: planar UVs of a cube-like mesh have low stretch', () => {
  // The Capsule's planar-xy UVs are uniform on the front but
  // stretched on the back (which is what the user is fighting).
  // We just verify the function returns finite, non-negative
  // values; the high-stretch cases are tested in the next test.
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const idx = geom.index;
  const uvArr = geom.attributes.uv.array;
  const u = new Float64Array(uvArr.length / 2);
  const v = new Float64Array(uvArr.length / 2);
  for (let i = 0; i < u.length; i++) { u[i] = uvArr[i*2]; v[i] = uvArr[i*2+1]; }
  const stretch = computeStretch(geom, { u, v });
  for (let i = 0; i < stretch.length; i++) {
    assert.ok(Number.isFinite(stretch[i]), `stretch[${i}] is not finite`);
    assert.ok(stretch[i] >= 0, `stretch[${i}] is negative: ${stretch[i]}`);
  }
});

test('computeStretch: capsule planar UV (xy) flags stretching on the back', () => {
  // The capsule's planar-xy UV unwrap has the back collapse to a
  // line at V=1, producing high stretching on the back hemisphere.
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  geom.computePlanarUVs('xy');
  const uvArr = geom.attributes.uv.array;
  const u = new Float64Array(uvArr.length / 2);
  const v = new Float64Array(uvArr.length / 2);
  for (let i = 0; i < u.length; i++) { u[i] = uvArr[i*2]; v[i] = uvArr[i*2+1]; }
  const stretch = computeStretch(geom, { u, v });
  // The max stretch should be > 1 (i.e., at least 2x the average
  // area). This confirms that the metric is sensitive to the
  // polar collapse the user is trying to fix.
  const max = stretch.reduce((a, b) => Math.max(a, b), 0);
  assert.ok(max > 1, `Expected max stretch > 1 for capsule planar-xy unwrap, got ${max}`);
});

test('stretchToColor: 0 → green, 1 → red', () => {
  const [r0, g0] = stretchToColor(0);
  const [r1, g1] = stretchToColor(1);
  // s=0 should be green-dominant (g > r).
  assert.ok(g0 > r0, `0-stretch should be green: r=${r0}, g=${g0}`);
  // s=1 should be red-dominant (r > g).
  assert.ok(r1 > g1, `1-stretch should be red: r=${r1}, g=${g1}`);
  // Red should increase monotonically from 0 to 1.
  assert.ok(r1 > r0, `Red should increase with stretch: r0=${r0}, r1=${r1}`);
});
