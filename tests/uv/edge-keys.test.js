/**
 * Tests for src/geometry/uv/edge-keys.js.
 *
 * Covers:
 *   - `buildEdgeKey` / `parseEdgeKey`: canonical vertex-pair keys.
 *
 * @fileoverview Co-located 1:1 with `src/geometry/uv/edge-keys.js`.
 * Split out of the monolithic `tests/uv-unwrapping.test.js` so the
 * test surface tracks the source surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdgeKey, parseEdgeKey } from '../../src/geometry/uv/index.js';

test('buildEdgeKey is canonical (order-independent)', () => {
  assert.equal(buildEdgeKey(5, 10), buildEdgeKey(10, 5));
  assert.notEqual(buildEdgeKey(5, 10), buildEdgeKey(5, 11));
});

test('parseEdgeKey round-trips with buildEdgeKey', () => {
  for (const [a, b] of [[0, 1], [42, 17], [100, 200], [65535, 0]]) {
    const k = buildEdgeKey(a, b);
    const [lo, hi] = parseEdgeKey(k);
    assert.equal(lo, Math.min(a, b));
    assert.equal(hi, Math.max(a, b));
  }
});
