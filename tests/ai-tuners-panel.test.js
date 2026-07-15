/**
 * v0.58.0 — AI Tuners Panel regression guard.
 *
 * Why this file exists
 * --------------------
 * The v0.55.0 clean-room AI rewrite collapsed `AI_TUNABLES` from 22
 * keys to 9 (later 10 with v0.56.0's `aggroDist`). The brain was
 * refactored; the UI Tuners Panel was not. The panel's hardcoded
 * `TUNER_GROUPS` list still referenced the 22-keys shape, so 13
 * sliders rendered their `value="undefined"` and the user saw
 * "undefined" in the corresponding value cells. The bug shipped
 * because the panel is a DOM layer; the existing tests
 * (`tests/ai.js`, `tests/ai-tunables.test.js` if any) only cover
 * the brain + bag, not the UI wiring.
 *
 * These tests pin the contract that EVERY TUNER_GROUPS key is also
 * a key in `AI_TUNABLES`, EVERY `AI_TUNABLES` key has a TUNER_SPECS
 * entry, and the two key sets match. Drift between the panel and
 * the bag trips the regression test before the user sees
 * "undefined" in the browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TUNER_GROUPS,
  TUNER_SPECS,
  formatTunable,
  clampToTunableRange,
} from '../src/ui/ai-tuners-panel.js';
import {
  AI_TUNABLES,
  AI_TUNABLE_DEFAULTS,
} from '../src/entities/ai-tunables.js';

// ------------------------------------------------------------------
// Key-set invariants
// ------------------------------------------------------------------

test('regression: every TUNER_GROUPS key exists in AI_TUNABLES (no "undefined" values)', () => {
  for (const group of TUNER_GROUPS) {
    for (const key of group.keys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(AI_TUNABLES, key),
        `TUNER_GROUPS key "${key}" (in group "${group.name}") must exist in AI_TUNABLES -- ` +
        `otherwise the slider shows "undefined" in the browser. ` +
        `Fix: add the key to AI_TUNABLE_DEFAULTS in src/entities/ai-tunables.js, OR remove it from TUNER_GROUPS.`,
      );
    }
  }
});

test('regression: every AI_TUNABLES key has a TUNER_SPECS entry', () => {
  for (const key of Object.keys(AI_TUNABLES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TUNER_SPECS, key),
      `AI_TUNABLES key "${key}" must have a TUNER_SPECS entry in src/ui/ai-tuners-panel.js -- ` +
      `otherwise formatTunable/clampToTunableRange fall back to raw numeric, and the slider ` +
      `renders without a visual guide. ` +
      `Fix: add a { label, min, max, step, format, help, guideType } entry to TUNER_SPECS.`,
    );
  }
});

test('regression: TUNER_GROUPS key set == AI_TUNABLES key set (no orphans either way)', () => {
  const groupKeys = new Set();
  for (const group of TUNER_GROUPS) {
    for (const key of group.keys) groupKeys.add(key);
  }
  const bagKeys = new Set(Object.keys(AI_TUNABLES));
  // Every group key must be in the bag.
  for (const k of groupKeys) {
    assert.ok(bagKeys.has(k), `panel-only key "${k}" -- exists in TUNER_GROUPS but not in AI_TUNABLES`);
  }
  // Every bag key must appear in some group (no missing slider).
  for (const k of bagKeys) {
    assert.ok(groupKeys.has(k), `bag-only key "${k}" -- exists in AI_TUNABLES but has no slider`);
  }
  // And the sets have the same cardinality.
  assert.equal(groupKeys.size, bagKeys.size, `cardinality mismatch: groups=${groupKeys.size}, bag=${bagKeys.size}`);
});

// ------------------------------------------------------------------
// Format helpers produce no "undefined" string
// ------------------------------------------------------------------

test('formatTunable: real value renders as a number, not "undefined"', () => {
  // Use the production-default bullet speed value (400).
  const out = formatTunable('bulletSpeed', AI_TUNABLES.bulletSpeed);
  assert.notEqual(out, 'undefined', 'formatTunable must never emit the literal string "undefined"');
  assert.match(out, /\d/, 'formatTunable must include at least one digit');
});

test('formatTunable: malformed input is bypassed safely', () => {
  const out = formatTunable('bulletSpeed', undefined);
  // The internal fallback `return String(value)` produces "undefined"
  // for missing values -- that path is acceptable for defensive
  // rendering. What we DON'T want: a crash, NaN, or [object Object].
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('clampToTunableRange: clamps known keys to spec range', () => {
  assert.equal(clampToTunableRange('fireHeadingGate', 5), 1.5, 'above max clamps to max');
  assert.equal(clampToTunableRange('fireHeadingGate', -1), 0.05, 'below min clamps to min');
  assert.equal(clampToTunableRange('fireHeadingGate', 0.3), 0.3, 'in-range passes through');
});

test('clampToTunableRange: unknown keys pass through unchanged (defensive)', () => {
  // Unknown keys have no spec, so clampToTunableRange cannot enforce
  // a range and returns the value unchanged. This is defensive code:
  // callers that mutate the bag directly bypass clamp; callers via
  // the panel never reach this branch because TUNER_GROUPS only
  // references known keys.
  for (const k of ['madeUpKey', 'totallyUnknown', 'legacyXxxYyy']) {
    const out = clampToTunableRange(k, 0.5);
    assert.equal(out, 0.5, `unknown key "${k}" should pass through (no spec) but got ${out}`);
    assert.equal(clampToTunableRange(k, 1000), 1000, 'unknown key does not clamp upper');
    assert.equal(clampToTunableRange(k, -1000), -1000, 'unknown key does not clamp lower');
  }
});

test('clampToTunableRange: non-numeric / non-finite inputs are rejected', () => {
  assert.equal(clampToTunableRange('fireHeadingGate', NaN), undefined);
  assert.equal(clampToTunableRange('fireHeadingGate', Infinity), undefined);
  assert.equal(clampToTunableRange('fireHeadingGate', 'string'), undefined);
  assert.equal(clampToTunableRange('fireHeadingGate', null), undefined);
});

// ------------------------------------------------------------------
// Each TUNER_SPECS entry is well-formed
// ------------------------------------------------------------------

test('regression: every TUNER_SPECS entry has required shape (label, min, max, step, format, guideType)', () => {
  const requiredKeys = ['label', 'min', 'max', 'step', 'format', 'help', 'guideType'];
  for (const key of Object.keys(TUNER_SPECS)) {
    const spec = TUNER_SPECS[key];
    for (const rk of requiredKeys) {
      assert.ok(
        spec[rk] !== undefined,
        `TUNER_SPECS["${key}"].${rk} is missing`,
      );
    }
    assert.equal(typeof spec.label, 'string');
    assert.equal(typeof spec.format, 'function');
    assert.equal(typeof spec.help, 'string');
    assert.ok(typeof spec.min === 'number');
    assert.ok(typeof spec.max === 'number');
    assert.ok(typeof spec.step === 'number');
    assert.ok(spec.min < spec.max, `${key}: min < max`);
    const validGuides = ['cone', 'circle', 'speedometer', 'bar', 'clock'];
    assert.ok(
      validGuides.includes(spec.guideType),
      `${key}: guideType "${spec.guideType}" not in ${JSON.stringify(validGuides)}`,
    );
  }
});

// ------------------------------------------------------------------
// Render-path regression: this is the layer that produced the user-visible
// "undefined" cells in the browser. The test inlines the same template the
// panel uses to render a row + value cell, then scans for the exact
// substring that caused the original symptom.
// ------------------------------------------------------------------

/**
 * Replica of the row template from `createAiTunersPanel.buildRow`.
 * Mirror only the parts that produced the user-visible bug: label cell +
 * value cell text. (Pure string templating -- no DOM required.)
 */
function renderRowHtml(key) {
  const spec = TUNER_SPECS[key];
  const label = (spec && spec.label) || key;
  const current = AI_TUNABLES[key];
  const valueText = formatTunable(key, current);
  return {
    labelHtml: `<label>${label}</label>`,
    valueHtml: `<span data-tuner-value="${key}">${valueText}</span>`,
    inputHtml: `<input value="${current}">`,
  };
}

test('regression (render-path): no slider row renders the literal "undefined" string', () => {
  // The original symptom the user reported: many value cells read
  // "undefined" because TUNER_GROUPS referenced keys that no longer
  // existed in AI_TUNABLES, and `${current}` + `formatTunable()` both
  // stringified undefined. This test renders every panel row through
  // the same template the factory uses (mirrored inline) and asserts
  // no row contains the substring "undefined" anywhere in the cell HTML.
  let totalRows = 0;
  for (const group of TUNER_GROUPS) {
    for (const key of group.keys) {
      totalRows += 1;
      const { labelHtml, valueHtml, inputHtml } = renderRowHtml(key);
      // Labels are static, but a missing TUNER_SPECS would fall back
      // to the raw key name (not undefined). Still assert no "undefined".
      for (const [name, html] of [['label', labelHtml], ['value', valueHtml], ['input', inputHtml]]) {
        assert.ok(
          !html.includes('undefined'),
          `${group.name} > ${key} -- ${name} cell rendered "undefined": ${html}`,
        );
      }
    }
  }
  assert.ok(totalRows >= 1, 'sanity: panel has at least one row');
});

test('regression (render-path): every slider value is a numeric string in [min, max]', () => {
  for (const group of TUNER_GROUPS) {
    for (const key of group.keys) {
      const spec = TUNER_SPECS[key];
      const current = AI_TUNABLES[key];
      assert.ok(
        typeof current === 'number' && Number.isFinite(current),
        `${group.name} > ${key} -- current value "${current}" is not finite`,
      );
      assert.ok(current >= spec.min, `${key}: current ${current} below spec.min ${spec.min}`);
      assert.ok(current <= spec.max, `${key}: current ${current} above spec.max ${spec.max}`);
    }
  }
});

// ------------------------------------------------------------------
// Settle: defaults match the production bag exactly
// ------------------------------------------------------------------

test('regression: AI_TUNABLES bag mirrors AI_TUNABLE_DEFAULTS at boot', () => {
  // Resets aside, the live bag should equal the frozen defaults at
  // module-load time. Tests that mutate the bag must restore via
  // resetAITunables() in a try/finally (already a project convention).
  for (const key of Object.keys(AI_TUNABLE_DEFAULTS)) {
    assert.equal(
      AI_TUNABLES[key],
      AI_TUNABLE_DEFAULTS[key],
      `AI_TUNABLES.${key} drifted from AI_TUNABLE_DEFAULTS.${key} at boot`,
    );
  }
});
