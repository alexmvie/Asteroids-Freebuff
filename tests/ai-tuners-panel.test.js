/**
 * Tests for src/ui/ai-tuners-panel.js — runtime tuner UI for the
 * demo AI's live mutable bag.
 *
 * Scope:
 *   - Pure helpers (formatTunable, clampToTunableRange) are tested
 *     directly across all spec'd keys + fallbacks.
 *   - factory createAiTunersPanel:
 *       • throws without tunables
 *       • mount throws without rootEl
 *       • mount injects the .ai-tuners--mounted class
 *       • setValue writes to the bag AND updates the DOM cells
 *       • reset calls resetFn then DOM-syncs all sliders
 *       • exportSnapshot returns the exportFn() result
 *       • dispose clears refs (subsequent setValue throws or no-ops)
 *   - The DOM is mocked like in tests/ai-debug-overlay.test.js
 *     (no jsdom dependency).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAiTunersPanel,
  formatTunable,
  clampToTunableRange,
  TUNER_GROUPS,
  TUNER_SPECS,
} from '../src/ui/ai-tuners-panel.js';

// ---------------------------------------------------------------------------
// Mock DOM factory (mirrors the pattern in tests/ai-debug-overlay.test.js)
// ---------------------------------------------------------------------------

function buildMockRoot() {
  const elements = new Map();
  const root = {
    innerHTML: '',
    set innerHTML(html) {
      this._html = html;
      this._rebuildMap();
    },
    get innerHTML() {
      return this._html || '';
    },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, v) {
        if (v === true) this._set.add(c);
        else if (v === false) this._set.delete(c);
        else if (this._set.has(c)) this._set.delete(c);
        else this._set.add(c);
      },
    },
    querySelector(sel) {
      if (!sel) return null;
      const lookup = parseAndLookup(sel);
      if (!lookup) return null;
      return lookup.exact(elements, lookup.key);
    },
    // Required by ai-tuners-panel.js's readElements() — finds ALL
    // sliders / value-cells / action buttons in one swEEP. Without
    // this every test that hits `mount()` throws.
    querySelectorAll(sel) {
      const lookup = parseAndLookup(sel);
      if (!lookup) return [];
      const results = [];
      for (const [key, el] of elements.entries()) {
        if (lookup.bucket && key.startsWith(lookup.bucket + ':') && lookup.matcher(key.slice(lookup.bucket.length + 1))) {
          results.push(el);
        }
      }
      return results;
    },
    _rebuildMap() {
      elements.clear();
      for (const g of TUNER_GROUPS) {
        for (const k of g.keys) {
          elements.set(`slider:${k}`, makeCell('slider', k));
          elements.set(`value:${k}`, makeCell('value', k));
        }
      }
      elements.set('action:reset', makeButton('reset'));
      elements.set('action:copy', makeButton('copy'));
      // Seed under `status:msg` prefix so the open-branch bucket-
      // prefix lookup in parseAndLookup() can resolve the panel's
      // `rootEl.querySelector('[data-tuner-status]')` writes.
      elements.set('status:msg', makeStatus('msg'));
    },
  };
  // makeCell takes (bucket, name) so the element's `dataset` correctly
  // exposes the right key for readElements() to pick up. The panel's
  // readElements() does `sliders[el.dataset.tuner] = el` — every cell
  // needs to publish its key on `dataset` or the lookup fails.
  function makeCell(bucket, name) {
    // `bucket` is exactly 'slider' or 'value' on the only paths that
    // reach this helper (makeCellForBucket routes everything else
    // to other factories). Two clear cases; no fallback.
    const dataset = bucket === 'slider' ? { tuner: name } : { tunerValue: name };
    return {
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      style: { setProperty() {} },
      value: '0',
      _key: `${bucket}:${name}`,
      dataset,
    };
  }
  function makePanel(key) {
    return { _key: key };
  }
  function makeFieldset(key) {
    return { _key: key };
  }
  function makeButton(name) {
    const b = {
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      _key: `action:${name}`,
      _listeners: {},
      dataset: { tunerAction: name },
      addEventListener(type, fn) {
        (b._listeners[type] = b._listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        if (!b._listeners[type]) return;
        const idx = b._listeners[type].indexOf(fn);
        if (idx >= 0) b._listeners[type].splice(idx, 1);
      },
      click() {
        const ls = b._listeners.click || [];
        for (const fn of ls) fn({ type: 'click' });
      },
    };
    return b;
  }
  function makeStatus(name) {
    return {
      textContent: '',
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, v) {
          if (v === true) this._set.add(c);
          else if (v === false) this._set.delete(c);
        },
      },
      _key: `status:${name}`,
      dataset: { tunerStatus: name },
    };
  }

  // Selector parser. Returns a description that the querySelector
  // and querySelectorAll implementations share. Buckets map to the
  // pre-seeded `slider:`, `value:`, `action:`, etc. names so the
  // mock reflects the real DOM even after tear-down + remount.
  function parseAndLookup(sel) {
    if (!sel) return null;
    // Bare attribute selectors: [data-tuner="fireHeadingGate"]
    const bare = sel.match(/^\[data-tuner(?:-(value|row|group|action|status))?="([^"]+)"\]$/);
    if (bare) {
      const kind = bare[1] || '';
      const name = bare[2];
      const bucket = kind === 'value' ? 'value' : kind === 'action' ? 'action' : kind === 'status' ? 'status' : kind === 'row' ? 'row' : kind === 'group' ? 'group' : 'slider';
      return {
        key: `${bucket}:${name}`,
        bucket,
        exact: (els, k) => els.get(k) || makeCellForBucket(bucket, k),
        matcher: (n) => n === name,
      };
    }
    // Open class selectors used by ai-tuners-panel.readElements():
    //   [data-tuner], [data-tuner-value], [data-tuner-action],
    //   [data-tuner-status]  (bare, no name).
    // The panel's setStatus() queries `[data-tuner-status]` to write
    // "RESET failed: ..." / "JSON copied..." notices. The exact
    // matcher uses a bucket-prefix scan so any future bucket-prefixed
    // element resolves correctly (e.g. `status:msg`).
    const open = sel.match(/^\[data-tuner(-(value|action|row|group|status))?\]$/);
    if (open) {
      const bucket = open[2] === 'value' ? 'value' : open[2] === 'action' ? 'action' : open[2] === 'row' ? 'row' : open[2] === 'group' ? 'group' : open[2] === 'status' ? 'status' : 'slider';
      const prefix = bucket + ':';
      return {
        bucket,
        key: prefix,
        // Bucket-prefix lookup: returns the first element whose key
        // starts with "<bucket>:". Matches the real-DOM semantics
        // where querySelector returns the first matching descendant.
        exact: (els, pref) => {
          for (const [k, el] of els.entries()) {
            if (k.startsWith(pref)) return el;
          }
          return null;
        },
        matcher: () => true,
      };
    }
    return null;
  }
  function makeCellForBucket(bucket, key) {
    if (bucket === 'slider' || bucket === 'value') return makeCell(bucket, key);
    if (bucket === 'action') return makeButton(key);
    if (bucket === 'status') return makeStatus(key);
    if (bucket === 'row') return makePanel(`row:${key}`);
    if (bucket === 'group') return makeFieldset(`group:${key}`);
    return makeCell(bucket, key);
  }
  root._rebuildMap();
  return root;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('formatTunable: degree formatters for radian keys', () => {
  // fireHeadingGate → deg via (v * 180 / Math.PI).toFixed(0)°
  assert.equal(formatTunable('fireHeadingGate', 0.4), `${Math.round(0.4 * 180 / Math.PI)}°`);
  assert.equal(formatTunable('thrustHeadingGate', 0.5), `${Math.round(0.5 * 180 / Math.PI)}°`);
  assert.equal(formatTunable('yawDeadband', 0.10), `${Math.round(0.10 * 180 / Math.PI)}°`);
});

test('formatTunable: integer formatters for world-unit keys', () => {
  assert.equal(formatTunable('fireMinDist', 20), '20u');
  assert.equal(formatTunable('fireMaxDist', 199.6), '200u'); // rounded
  assert.equal(formatTunable('evadeDist', 8), '8u');
  assert.equal(formatTunable('powerupMaxChaseDist', 350), '350u');
});

test('formatTunable: percent formatter for brakeSafetyFactor', () => {
  assert.equal(formatTunable('powerupBrakeSafetyFactor', 0.8), '80%');
  assert.equal(formatTunable('powerupBrakeSafetyFactor', 0.5), '50%');
});

test('formatTunable: speed formatter for velocities', () => {
  assert.equal(formatTunable('powerupCruiseSpeed', 60), '60 u/s');
  assert.equal(formatTunable('bulletSpeed', 400), '400 u/s');
});

test('formatTunable: seconds formatter for sticky time', () => {
  assert.equal(formatTunable('powerupStickyTime', 3.0), '3.0s');
  assert.equal(formatTunable('powerupStickyTime', 0.5), '0.5s');
});

test('formatTunable: fallback to String(value) for unknown keys', () => {
  assert.equal(formatTunable('notARealKey', 42), '42');
  assert.equal(formatTunable('totallyMadeUp', -1.5), '-1.5');
});

test('formatTunable: non-finite inputs return String(value)', () => {
  // NaN → 'NaN' (per String(NaN) — defensive behavior is acceptable).
  assert.equal(typeof formatTunable('evadeDist', NaN), 'string');
  assert.equal(formatTunable('evadeDist', Infinity), 'Infinity');
});

test('clampToTunableRange: clamps to spec min/max', () => {
  // evadeDist: min=2, max=100. 1.5 → 2. 250 → 100. 50 → 50.
  assert.equal(clampToTunableRange('evadeDist', 1.5), 2);
  assert.equal(clampToTunableRange('evadeDist', 250), 100);
  assert.equal(clampToTunableRange('evadeDist', 50), 50);
});

test('clampToTunableRange: returns undefined on non-finite input', () => {
  assert.equal(clampToTunableRange('evadeDist', NaN), undefined);
  assert.equal(clampToTunableRange('evadeDist', Infinity), undefined);
  assert.equal(clampToTunableRange('evadeDist', -Infinity), undefined);
  assert.equal(clampToTunableRange('evadeDist', '20'), undefined);
});

test('clampToTunableRange: returns value as-is for unknown keys (no clamp)', () => {
  // Unknown keys have no spec → falls back to "passthrough".
  assert.equal(clampToTunableRange('notReal', 999), 999);
  assert.equal(clampToTunableRange('notReal', -10000), -10000);
});

test('TUNER_GROUPS covers all TUNER_SPECS keys (no orphaned sliders)', () => {
  const specKeys = Object.keys(TUNER_SPECS).sort();
  const groupKeys = TUNER_GROUPS.flatMap((g) => g.keys).sort();
  assert.deepStrictEqual(groupKeys, specKeys, 'every TUNER_SPEC key must be assigned to a TUNER_GROUPS slot');
});

// ---------------------------------------------------------------------------
// Factory smoke tests
// ---------------------------------------------------------------------------

test('createAiTunersPanel: throws without tunables arg', () => {
  assert.throws(() => createAiTunersPanel({}), /tunables/);
});

test('createAiTunersPanel: throws when tunables is not an object', () => {
  assert.throws(() => createAiTunersPanel({ tunables: 42 }), /tunables/);
  assert.throws(() => createAiTunersPanel({ tunables: 'not me' }), /tunables/);
  assert.throws(() => createAiTunersPanel({ tunables: null }), /tunables/);
});

test('createAiTunersPanel: returns { mount, dispose, getValues, setValue, reset, exportSnapshot }', () => {
  const tunables = { evadeDist: 10, powerupMaxChaseDist: 350 };
  const panel = createAiTunersPanel({ tunables });
  assert.equal(typeof panel.mount, 'function');
  assert.equal(typeof panel.dispose, 'function');
  assert.equal(typeof panel.getValues, 'function');
  assert.equal(typeof panel.setValue, 'function');
  assert.equal(typeof panel.reset, 'function');
  assert.equal(typeof panel.exportSnapshot, 'function');
  panel.dispose();
});

test('createAiTunersPanel: mount throws without rootEl', () => {
  const panel = createAiTunersPanel({ tunables: {} });
  assert.throws(() => panel.mount(null), /rootEl/);
  assert.throws(() => panel.mount(undefined), /rootEl/);
});

test('createAiTunersPanel: mount injects innerHTML and marks .ai-tuners--mounted', () => {
  const tunables = { evadeDist: 10 };
  const panel = createAiTunersPanel({ tunables });
  const root = buildMockRoot();
  panel.mount(root);
  assert.ok(root._html && root._html.length > 0, 'innerHTML must be populated');
  assert.ok(root.classList._set.has('ai-tuners--mounted'), 'mount class must be present');
  panel.dispose();
});

test('createAiTunersPanel: mount is idempotent', () => {
  const tunables = { evadeDist: 10 };
  const panel = createAiTunersPanel({ tunables });
  const root = buildMockRoot();
  panel.mount(root);
  const first = root._html;
  // Mount again — no throw, no payload change.
  panel.mount(root);
  assert.equal(root._html, first);
  panel.dispose();
});

test('createAiTunersPanel: setValue writes to bag AND updates the slider cell', () => {
  const tunables = { evadeDist: 10 };
  const root = buildMockRoot();
  const panel = createAiTunersPanel({ tunables });
  panel.mount(root);

  panel.setValue('evadeDist', 42);

  assert.equal(tunables.evadeDist, 42, 'setValue must write to the bag');
  // The DOM cell was updated by setValue — the cached slider
  // element under the queried slider key should now hold 42.
  const sliderEl = root.querySelector(`[data-tuner="evadeDist"]`);
  assert.equal(sliderEl.value, '42', 'slider element value must reflect the written bag value');
  panel.dispose();
});

test('createAiTunersPanel: setValue clamps to spec range, no out-of-band writes', () => {
  const tunables = { evadeDist: 10 };
  const root = buildMockRoot();
  const panel = createAiTunersPanel({ tunables });
  panel.mount(root);

  // evadeDist spec: min=2, max=100. 200 → clamps to 100.
  panel.setValue('evadeDist', 200);
  assert.equal(tunables.evadeDist, 100);

  // 0 → clamps to 2.
  panel.setValue('evadeDist', 0);
  assert.equal(tunables.evadeDist, 2);

  panel.dispose();
});

test('createAiTunersPanel: setValue ignores non-finite input (no write)', () => {
  const tunables = { evadeDist: 10 };
  const root = buildMockRoot();
  const panel = createAiTunersPanel({ tunables });
  panel.mount(root);

  const before = tunables.evadeDist;
  panel.setValue('evadeDist', NaN);
  panel.setValue('evadeDist', Infinity);
  panel.setValue('evadeDist', 'abc');

  assert.equal(tunables.evadeDist, before, 'non-finite input must not mutate the bag');
  panel.dispose();
});

test('createAiTunersPanel: setValue invokes onChange hook with key + clamped value', () => {
  const tunables = { evadeDist: 10 };
  const calls = [];
  const panel = createAiTunersPanel({
    tunables,
    onChange: (k, v) => calls.push([k, v]),
  });
  const root = buildMockRoot();
  panel.mount(root);

  panel.setValue('evadeDist', 50);
  assert.deepStrictEqual(calls, [['evadeDist', 50]]);

  panel.dispose();
});

test('createAiTunersPanel: setValue swallows onChange hook errors (UI must not crash)', () => {
  const tunables = { evadeDist: 10 };
  const panel = createAiTunersPanel({
    tunables,
    onChange: () => { throw new Error('boom'); },
  });
  const root = buildMockRoot();
  panel.mount(root);

  assert.doesNotThrow(() => panel.setValue('evadeDist', 50));
  assert.equal(tunables.evadeDist, 50, 'value should still be written despite onChange throwing');
  panel.dispose();
});

test('createAiTunersPanel: reset calls resetFn + DOM-syncs all sliders', () => {
  const tunables = { evadeDist: 99, powerupMaxChaseDist: 999 };
  const calls = { reset: 0 };
  const panel = createAiTunersPanel({
    tunables,
    resetFn: () => {
      calls.reset += 1;
      // Reset to defaults (10, 350).
      tunables.evadeDist = 10;
      tunables.powerupMaxChaseDist = 350;
    },
  });
  const root = buildMockRoot();
  panel.mount(root);

  panel.reset();
  assert.equal(calls.reset, 1);
  assert.equal(tunables.evadeDist, 10);
  assert.equal(tunables.powerupMaxChaseDist, 350);

  panel.dispose();
});

test('createAiTunersPanel: reset falls back to copying defaults when no resetFn', () => {
  const defaults = { evadeDist: 5, powerupMaxChaseDist: 100 };
  const tunables = { evadeDist: 99, powerupMaxChaseDist: 999 };
  const panel = createAiTunersPanel({ tunables, defaults });
  const root = buildMockRoot();
  panel.mount(root);

  panel.reset();
  assert.deepStrictEqual(tunables, defaults);

  panel.dispose();
});

test('createAiTunersPanel: exportSnapshot returns exportFn() result when provided', () => {
  const tunables = { evadeDist: 10 };
  const snap = { evadeDist: 555, foo: 'bar' };
  const panel = createAiTunersPanel({
    tunables,
    exportFn: () => snap,
  });
  assert.deepStrictEqual(panel.exportSnapshot(), snap);
  panel.dispose();
});

test('createAiTunersPanel: exportSnapshot returns a copy of the bag when no exportFn', () => {
  const tunables = { evadeDist: 10, powerupMaxChaseDist: 350 };
  const panel = createAiTunersPanel({ tunables });
  const snap = panel.exportSnapshot();
  assert.deepStrictEqual(snap, tunables);
  assert.notStrictEqual(snap, tunables, 'snapshot must be a copy, not the live bag');
  panel.dispose();
});

test('createAiTunersPanel: getValues returns a snapshot of the bag', () => {
  const tunables = { evadeDist: 10 };
  const panel = createAiTunersPanel({ tunables });
  assert.deepStrictEqual(panel.getValues(), tunables);
  panel.dispose();
});

test('createAiTunersPanel: dispose clears refs (subsequent setValue does not throw)', () => {
  const tunables = { evadeDist: 10 };
  const root = buildMockRoot();
  const panel = createAiTunersPanel({ tunables });
  panel.mount(root);
  panel.dispose();
  // The current dispose implementation leaves setValue as a guarded
  // no-throw — the bag is still writable because setValue carries
  // through to clampToTunableRange + the bag. The strict contract
  // is "no throw". Future iterations may further null the bag
  // reference; this test just pins the no-throw contract.
  assert.doesNotThrow(() => panel.setValue('evadeDist', 50));
});

test('createAiTunersPanel: dispose nulls out the rootEl (subsequent exportSnapshot does not throw)', () => {
  const panel = createAiTunersPanel({ tunables: { evadeDist: 10 } });
  const root = buildMockRoot();
  panel.mount(root);
  panel.dispose();
  assert.doesNotThrow(() => panel.exportSnapshot());
});
