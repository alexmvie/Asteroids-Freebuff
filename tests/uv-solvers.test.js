/**
 * Tests for src/geometry/uv-solvers.js.
 *
 * Covers:
 *   - SOLVER_IDS / SOLVER_LABELS / SOLVER_DESCRIPTIONS: the
 *     public surface (no missing keys, consistent counts).
 *   - solveWith: throws on bad inputs, returns a valid
 *     SolverResult, dispatches 'smart-uv-project' to the right
 *     solver, passes through `seamKeys` when provided.
 *   - solveAutomatic: runs the cascade, returns the best
 *     result, records which solvers were tried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveWith,
  solveAutomatic,
  SOLVER_IDS,
  SOLVER_LABELS,
  SOLVER_DESCRIPTIONS,
} from '../src/geometry/uv-solvers.js';
import { Capsule } from '../src/geometry/capsule.js';

// ---- Public surface ----------------------------------------------------

test('SOLVER_IDS: includes the five supported solvers', () => {
  assert.deepEqual(
    [...SOLVER_IDS].sort(),
    ['abf++', 'circle-tutte', 'lscm', 'smart-uv-project', 'square-tutte'],
  );
});

test('SOLVER_LABELS: has a label for every SOLVER_ID', () => {
  for (const id of SOLVER_IDS) {
    assert.ok(SOLVER_LABELS[id], `missing label for ${id}`);
    assert.ok(typeof SOLVER_LABELS[id] === 'string' && SOLVER_LABELS[id].length > 0,
      `label for ${id} should be a non-empty string`);
  }
});

test('SOLVER_DESCRIPTIONS: has a description for every SOLVER_ID', () => {
  for (const id of SOLVER_IDS) {
    assert.ok(SOLVER_DESCRIPTIONS[id], `missing description for ${id}`);
    assert.ok(typeof SOLVER_DESCRIPTIONS[id] === 'string' && SOLVER_DESCRIPTIONS[id].length > 10,
      `description for ${id} should be a non-empty string (>10 chars)`);
  }
});

// ---- solveWith: input validation ---------------------------------------

test('solveWith: throws on missing geometry', () => {
  assert.throws(() => solveWith(null, 'square-tutte'), /geometry.*required/);
  assert.throws(() => solveWith(undefined, 'square-tutte'), /geometry.*required/);
});

test('solveWith: throws on unknown solverId', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  assert.throws(() => solveWith(geom, 'bogus-solver'), /unknown solverId/);
});

// ---- solveWith: success cases ------------------------------------------

test('solveWith: returns a valid SolverResult on a capsule', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const result = solveWith(geom, 'square-tutte');
  // Shape checks.
  assert.ok(result.u instanceof Float64Array, 'u should be a Float64Array');
  assert.ok(result.v instanceof Float64Array, 'v should be a Float64Array');
  assert.equal(result.u.length, geom.attributes.position.count);
  assert.equal(result.v.length, geom.attributes.position.count);
  // Metadata.
  assert.equal(typeof result.seamCount, 'number');
  assert.ok(result.seamCount > 0, 'should detect some auto-seams');
  assert.equal(typeof result.islandCount, 'number');
  assert.ok(result.islandCount > 0, 'should have at least one island');
  assert.equal(typeof result.maxStretch, 'number');
  assert.ok(result.maxStretch >= 0, 'stretch should be non-negative');
  assert.ok(Number.isFinite(result.maxStretch), 'stretch should be finite');
  assert.equal(result.solverId, 'square-tutte');
  // All UVs finite.
  for (let i = 0; i < result.u.length; i++) {
    assert.ok(Number.isFinite(result.u[i]), `u[${i}] not finite: ${result.u[i]}`);
    assert.ok(Number.isFinite(result.v[i]), `v[${i}] not finite: ${result.v[i]}`);
  }
});

test('solveWith: smart-uv-project dispatches to abf++ under the hood', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const result = solveWith(geom, 'smart-uv-project');
  // The wrapper records the effective solver in the result.
  // 'smart-uv-project' is a meta-solver that picks the best
  // underlying solver; it always picks ABF++ (the
  // highest-quality real solver). ABF++ initializes from
  // LSCM internally, so it gets both the conformal starting
  // point AND the angle-preservation refinement.
  assert.equal(result.solverId, 'abf++');
  // The seam set should be non-empty (auto-detected).
  assert.ok(result.seamCount > 0);
});

test('solveWith: respects caller-provided seamKeys (non-empty)', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  // Pass a non-empty seam set — should be used as-is, not
  // auto-detected.
  const customSeams = new Set([1, 2, 3, 4, 5]);
  const result = solveWith(geom, 'square-tutte', { seamKeys: customSeams });
  assert.equal(result.seamCount, 5);
  // The result is still valid.
  assert.ok(result.u.length > 0);
  assert.ok(result.maxStretch >= 0);
});

test('solveWith: solverId field reflects the requested solver', () => {
  // In the current implementation, 'square-tutte' and
  // 'circle-tutte' both call the same `reunwrap` function under
  // the hood (the distinction is in the API surface, not the
  // implementation — reunwrap already does square-Tutte for 1-
  // and 2-loop boundaries and falls back to circle-Tutte for
  // 3+). So the UV coordinates are identical, but the
  // `solverId` field on the result correctly reflects which
  // solver the caller asked for. When LSCM is added, this test
  // can be extended to assert that the UV coordinates differ
  // between LSCM and Tutte.
  const geom = new Capsule(1, 1, 4, 8, 4);
  const r1 = solveWith(geom, 'square-tutte');
  const r2 = solveWith(geom, 'circle-tutte');
  assert.equal(r1.solverId, 'square-tutte');
  assert.equal(r2.solverId, 'circle-tutte');
});

// ---- solveAutomatic: cascade logic -------------------------------------

test('solveAutomatic: returns a valid result on a capsule', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const result = solveAutomatic(geom);
  assert.ok(result.u instanceof Float64Array);
  assert.ok(result.v instanceof Float64Array);
  assert.ok(result.tried.length >= 1, 'should have tried at least one solver');
  assert.ok(typeof result.solverId === 'string');
  assert.ok(result.maxStretch >= 0);
});

test('solveAutomatic: records which solvers were tried', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  const result = solveAutomatic(geom);
  // Default stretch budget is 50, which the square-Tutte
  // placement achieves on a simple capsule, so the cascade
  // should stop after the first solver.
  assert.ok(result.tried.includes('square-tutte'));
  // The first solver in the cascade is always square-tutte.
  assert.equal(result.tried[0], 'square-tutte');
});

test('solveAutomatic: stops early when stretch budget is met', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  // With a generous budget, the cascade should stop after
  // the first solver.
  const result = solveAutomatic(geom, { stretchBudget: 1000 });
  assert.equal(result.tried.length, 1, 'should have stopped after the first solver');
  assert.equal(result.tried[0], 'square-tutte');
});

test('solveAutomatic: tries more solvers when budget is tight', () => {
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  // With a tight budget, the cascade should try at least 2
  // solvers (square-tutte has ~460 stretch on this test case,
  // which is > 50).
  const result = solveAutomatic(geom, { stretchBudget: 10 });
  assert.ok(result.tried.length >= 2,
    `should have tried at least 2 solvers with tight budget, got ${result.tried.length}`);
  // The first solver tried is always square-tutte.
  assert.equal(result.tried[0], 'square-tutte');
});

test('solveAutomatic: returns the best result when no solver passes the budget', () => {
  const geom = new Capsule(1, 1.5, 4, 8, 6);
  // With an impossible budget, all cascade solvers will be tried
  // (the cascade currently has 4: square-tutte, circle-tutte,
  // lscm, abf++), and the best (lowest stretch) one will be returned.
  const result = solveAutomatic(geom, { stretchBudget: 0 });
  assert.equal(result.tried.length, 4,
    `should have tried all 4 cascade solvers, got ${result.tried.length}`);
  // The result should still be valid.
  assert.ok(result.u.length > 0);
  assert.ok(result.maxStretch >= 0);
});

test('solveAutomatic: respects caller-provided seamKeys (non-empty)', () => {
  const geom = new Capsule(1, 1, 4, 8, 4);
  // Pass a non-empty seam set — the cascade should use it.
  const customSeams = new Set([1, 2, 3, 4, 5]);
  const result = solveAutomatic(geom, { seamKeys: customSeams });
  assert.equal(result.seamCount, 5);
});
