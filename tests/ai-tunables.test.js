/**
 * Tests for src/entities/ai-tunables.js — the live-tunable SSOT.
 *
 * Scope:
 *   - AI_TUNABLE_DEFAULTS is frozen + has every key the brain uses.
 *   - AI_TUNABLES is a plain mutable bag with the same keys.
 *   - Initial values match the defaults (no early mutation).
 *   - Direct mutation of AI_TUNABLES.X takes effect.
 *   - resetAITunables restores frozen defaults.
 *   - exportAITunables returns a snapshot copy (not the live bag).
 *   - applyAITunables filters unknown keys + non-numeric values.
 *
 * Tests run AFTER import — the module is already evaluated, but the
 * live bag may have been mutated by earlier tests in the suite. We
 * always resetAITunables() in a `beforeEach`-equivalent (inline at
 * the top of each test) to keep the assertions independent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TUNABLES,
  AI_TUNABLE_DEFAULTS,
  resetAITunables,
  exportAITunables,
  applyAITunables,
} from '../src/entities/ai-tunables.js';

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

function reset() {
  resetAITunables();
}

// ---------------------------------------------------------------------------
// SSOT shape
// ---------------------------------------------------------------------------

test('AI_TUNABLE_DEFAULTS is frozen (Object.isFrozen returns true)', () => {
  assert.ok(Object.isFrozen(AI_TUNABLE_DEFAULTS), 'AI_TUNABLE_DEFAULTS must be frozen');
});

test('AI_TUNABLES is a plain mutable object (NOT frozen)', () => {
  assert.equal(Object.isFrozen(AI_TUNABLES), false, 'AI_TUNABLES is the live mutable bag — must not be frozen');
});

test('AI_TUNABLES has the same keys as AI_TUNABLE_DEFAULTS', () => {
  const defaultsKeys = Object.keys(AI_TUNABLE_DEFAULTS).sort();
  const liveKeys = Object.keys(AI_TUNABLES).sort();
  // Live bag should expose at least the defaults' keys (it may grow
  // future keys without the defaults catching up; but for now they
  // must match exactly).
  for (const k of defaultsKeys) {
    assert.ok(k in AI_TUNABLES, `AI_TUNABLES missing key "${k}"`);
  }
  assert.deepStrictEqual(liveKeys, defaultsKeys, 'key sets must match exactly');
});

test('all AI_TUNABLES values are finite numbers at module load', () => {
  for (const key of Object.keys(AI_TUNABLES)) {
    const v = AI_TUNABLES[key];
    assert.equal(typeof v, 'number', `${key} must be a number`);
    assert.ok(Number.isFinite(v), `${key} must be a finite number (got ${v})`);
  }
});

test('initial AI_TUNABLES values equal the frozen defaults', () => {
  reset();
  for (const key of Object.keys(AI_TUNABLE_DEFAULTS)) {
    assert.equal(
      AI_TUNABLES[key],
      AI_TUNABLE_DEFAULTS[key],
      `${key}: live=${AI_TUNABLES[key]} expected=${AI_TUNABLE_DEFAULTS[key]}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Live mutability
// ---------------------------------------------------------------------------

test('mutation of AI_TUNABLES.evadeDist takes effect on next read', () => {
  reset();
  const before = AI_TUNABLES.evadeDist;
  AI_TUNABLES.evadeDist = 99;
  assert.equal(AI_TUNABLES.evadeDist, 99);
  // cleanup so subsequent tests aren't polluted
  AI_TUNABLES.evadeDist = before;
});

test('mutation of arbitrary key evades the frozen defaults guard', () => {
  reset();
  // The frozen defaults are NOT mutated; only the live bag changes.
  AI_TUNABLES.thrustHeadingGate = 0.99;
  assert.equal(AI_TUNABLES.thrustHeadingGate, 0.99);
  // The frozen defaults remain untouched.
  assert.notEqual(AI_TUNABLES.thrustHeadingGate, AI_TUNABLE_DEFAULTS.thrustHeadingGate);
  reset();
  assert.equal(AI_TUNABLES.thrustHeadingGate, AI_TUNABLE_DEFAULTS.thrustHeadingGate);
});

// ---------------------------------------------------------------------------
// resetAITunables
// ---------------------------------------------------------------------------

test('resetAITunables restores all values to the frozen defaults', () => {
  // Pollute first.
  AI_TUNABLES.evadeDist = 1;
  AI_TUNABLES.powerupMaxChaseDist = 999;
  AI_TUNABLES.fireHeadingGate = 0.05;

  resetAITunables();

  for (const key of Object.keys(AI_TUNABLE_DEFAULTS)) {
    assert.equal(
      AI_TUNABLES[key],
      AI_TUNABLE_DEFAULTS[key],
      `reset failed for ${key}: live=${AI_TUNABLES[key]} expected=${AI_TUNABLE_DEFAULTS[key]}`,
    );
  }
});

test('resetAITunables is idempotent (running it twice has no side effects)', () => {
  resetAITunables();
  const snapshot = exportAITunables();
  resetAITunables();
  const snapshot2 = exportAITunables();
  assert.deepStrictEqual(snapshot, snapshot2);
});

// ---------------------------------------------------------------------------
// exportAITunables
// ---------------------------------------------------------------------------

test('exportAITunables returns a plain object snapshot', () => {
  reset();
  const snap = exportAITunables();
  assert.equal(typeof snap, 'object');
  assert.notStrictEqual(snap, AI_TUNABLES, 'snapshot must be a copy, not the live bag reference');
});

test('exportAITunables snapshot reflects current live values, not frozen defaults', () => {
  AI_TUNABLES.evadeDist = 42;
  const snap = exportAITunables();
  assert.equal(snap.evadeDist, 42);
  reset();
});

test('exportAITunables is a shallow copy (mutating the snapshot does not affect the live bag)', () => {
  reset();
  const snap = exportAITunables();
  snap.evadeDist = 999;
  assert.notEqual(AI_TUNABLES.evadeDist, 999, 'live bag must not pick up snapshot mutations');
});

// ---------------------------------------------------------------------------
// applyAITunables
// ---------------------------------------------------------------------------

test('applyAITunables with a valid snapshot updates matched keys', () => {
  reset();
  applyAITunables({
    evadeDist: 25,
    powerupMaxChaseDist: 300,
    fireHeadingGate: 0.5,
  });
  assert.equal(AI_TUNABLES.evadeDist, 25);
  assert.equal(AI_TUNABLES.powerupMaxChaseDist, 300);
  assert.equal(AI_TUNABLES.fireHeadingGate, 0.5);
  reset();
});

test('applyAITunables filters unknown keys (does not pollute the live bag)', () => {
  reset();
  const keyCountBefore = Object.keys(AI_TUNABLES).length;
  applyAITunables({
    evadeDist: 25,
    notARealKey: 999,
    anotherFakeKey: 'string',
  });
  assert.equal(AI_TUNABLES.evadeDist, 25);
  assert.equal(Object.keys(AI_TUNABLES).length, keyCountBefore, 'unknown keys must not be added');
  assert.equal(AI_TUNABLES.notARealKey, undefined);
  reset();
});

test('applyAITunables rejects NaN and non-number values', () => {
  reset();
  const evadeDistBefore = AI_TUNABLES.evadeDist;
  applyAITunables({
    evadeDist: NaN,
    fireHeadingGate: Infinity,
    fireMinDist: '20',
    powerupMaxChaseDist: null,
  });
  assert.equal(AI_TUNABLES.evadeDist, evadeDistBefore, 'NaN value must be ignored');
  assert.equal(AI_TUNABLES.fireHeadingGate, evadeDistBefore === undefined ? undefined : AI_TUNABLE_DEFAULTS.fireHeadingGate, 'Infinity must be ignored');
  assert.equal(AI_TUNABLES.fireMinDist, AI_TUNABLE_DEFAULTS.fireMinDist, 'string must be ignored');
  assert.equal(AI_TUNABLES.powerupMaxChaseDist, AI_TUNABLE_DEFAULTS.powerupMaxChaseDist, 'null must be ignored');
});

test('applyAITunables with null/undefined/non-object does nothing', () => {
  reset();
  applyAITunables(null);
  applyAITunables(undefined);
  applyAITunables(42);
  applyAITunables('string');
  // Nothing should have changed.
  assert.equal(AI_TUNABLES.evadeDist, AI_TUNABLE_DEFAULTS.evadeDist);
});

test('applyAITunables round-trip: export → apply → export yields equivalent snapshots', () => {
  reset();
  applyAITunables({
    evadeDist: 88,
    powerupMinApproachSpeed: 33,
  });
  const snap1 = exportAITunables();
  applyAITunables(snap1);
  const snap2 = exportAITunables();
  assert.deepStrictEqual(snap1, snap2);
  reset();
});

// ---------------------------------------------------------------------------
// v0.62.0 — adjustable radar scope
// ---------------------------------------------------------------------------

test('v0.62.0: radarBubbleMultiplier default is 3 (the "3× ship sight" baseline)', () => {
  reset();
  assert.equal(
    AI_TUNABLE_DEFAULTS.radarBubbleMultiplier,
    3,
    'radarBubbleMultiplier default must be 3 to match the v0.59.0 user-stated intent',
  );
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 3);
});

test('v0.62.0: radarBubbleMultiplier is live-mutable across the full [0.5, 8] range', () => {
  reset();
  // Tight zoom (0.5× — see only what's near the ship)
  AI_TUNABLES.radarBubbleMultiplier = 0.5;
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 0.5);
  // Default (3× — generous outer ring)
  AI_TUNABLES.radarBubbleMultiplier = 3;
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 3);
  // Wide map (8× — far threats visible)
  AI_TUNABLES.radarBubbleMultiplier = 8;
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 8);
  reset();
});

test('v0.62.0: applyAITunables accepts radarBubbleMultiplier snapshots (no special-case filtering)', () => {
  reset();
  applyAITunables({ radarBubbleMultiplier: 1.5 });
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 1.5);
  applyAITunables({ radarBubbleMultiplier: 0.5 });
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 0.5);
  applyAITunables({ radarBubbleMultiplier: 8 });
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, 8);
  // NaN must be rejected: the rejected write does NOT mutate the
  // live bag, so the prior value (8) is preserved. Critically,
  // NaN as a value would be `!== NaN` due to IEEE 754 — using 8 as
  // the sentinel works for THIS test only because the prior write
  // actually mutated. Reset to a known fixture first to make the
  // assertion independent of mutation order.
  reset();
  applyAITunables({ radarBubbleMultiplier: NaN });
  assert.equal(
    AI_TUNABLES.radarBubbleMultiplier,
    AI_TUNABLE_DEFAULTS.radarBubbleMultiplier,
    'NaN must NOT mutate radarBubbleMultiplier (must remain at the canonical default)',
  );
  reset();
});

test('v0.62.0: resetAITunables restores radarBubbleMultiplier to its frozen default', () => {
  AI_TUNABLES.radarBubbleMultiplier = 5;
  resetAITunables();
  assert.equal(AI_TUNABLES.radarBubbleMultiplier, AI_TUNABLE_DEFAULTS.radarBubbleMultiplier);
});
