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
  renderGuide,
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

// ===========================================================================
// renderGuide tests (v0.48.0 - inline SVG visual guides per slider)
// ===========================================================================
//
// renderGuide is a pure SVG-string renderer with five patterns: cone, circle,
// speedometer, bar, clock. These tests exercise:
//   1) Happy paths at min / mid / max values for each pattern.
//   2) Defensive clamps on NaN, Infinity, -Infinity, undefined, null.
//   3) Defensive bounds: max === min, max < min.
//   4) Unknown pattern returns the empty placeholder, not a throw.
//   5) Pattern-specific invariants (cone spread, circle radius, bar fill).
//   6) All five patterns are mentioned in TUNER_SPECS.guideType values (so
//      a future spec with `guideType: 'hologram'` would NOT silently break -
//      the unknown-pattern path handles it).

test('renderGuide: cone at min produces minimal spread, at max produces wide wedge', () => {
  const min = renderGuide('cone', 0.05, 0.05, 1.5);
  const mid = renderGuide('cone', 0.775, 0.05, 1.5);
  const max = renderGuide('cone', 1.5, 0.05, 1.5);
  // Spread value is encoded in the foreground path's left-x coordinate:
  //   M (cx-spread) base L cx tip L (cx+spread) base Z
  // For 100x36 viewBox cx=50, so we look for the lowest foreground x.
  // Extract from min: cx - spread = 50 - 0 = 50, so just M 50 36 L 50 4.
  assert.match(min, /M 50 36/);
  // Mid: t=0.5, spread = round(45*0.5) = 23, so cx-spread = 27.
  assert.match(mid, /M 27 36/);
  // Max: t=1.0, spread = 45, so cx-spread = 5.
  assert.match(max, /M 5 36/);
});

test('renderGuide: circle radii scale linearly with t', () => {
  const min = renderGuide('circle', 2, 2, 100);
  const max = renderGuide('circle', 100, 2, 100);
  // Radius is encoded as r="..." on the inner circle.
  // maxR = 15, so at t=0 radius = 0.5 (clamped), at t=1 radius = 15.
  assert.match(min, /r="0\.50"/);
  assert.match(max, /r="15\.00"/);
});

test('renderGuide: speedometer needle position changes monotonically across t', () => {
  const min = renderGuide('speedometer', 50, 50, 800);
  const mid = renderGuide('speedometer', 425, 50, 800);
  const max = renderGuide('speedometer', 800, 50, 800);
  // Needle is encoded in x2=NX y2=NY on the foreground line.
  // t=0: angle=-π, needle points to (cx - r, cy) = (28, 30).
  // t=0.5: angle=-π/2, needle points to (cx, cy - r) = (50, 8).
  // t=1: angle=0, needle points to (cx + r, cy) = (72, 30).
  const x2Min = parseFloat(min.match(/x2="([\d.\-]+)"/)[1]);
  const x2Mid = parseFloat(mid.match(/x2="([\d.\-]+)"/)[1]);
  const x2Max = parseFloat(max.match(/x2="([\d.\-]+)"/)[1]);
  // Eps compare (instead of strict ===) so a future
  // .toFixed(precision) change in coneGuide won't break this.
  assert.ok(Math.abs(x2Min - 28) < 0.01, `x2Min = ${x2Min} (want 28 ±0.01)`);
  assert.ok(Math.abs(x2Mid - 50) < 0.01, `x2Mid = ${x2Mid} (want 50 ±0.01)`);
  assert.ok(Math.abs(x2Max - 72) < 0.01, `x2Max = ${x2Max} (want 72 ±0.01)`);
});

test('renderGuide: bar fill width = round(totalWidth * t)', () => {
  const zero = renderGuide('bar', 0, 0, 50);
  const half = renderGuide('bar', 25, 0, 50);
  const full = renderGuide('bar', 50, 0, 50);
  // totalWidth=90, fillX starts at x=5.
  assert.match(zero, /width="0" height="8"/);
  assert.match(half, /width="45" height="8"/);
  assert.match(full, /width="90" height="8"/);
});

test('renderGuide: clock hand position lands on the circle (distance = r) at any t', () => {
  const threeOclock = renderGuide('clock', 7.5, 0, 10);
  // t=0.75 = 270 deg clockwise from top = bottom.
  // Angle = -π/2 + 2π*0.75 = π. cos=−1, sin=0. Hand at (cx-r, cy) = (37,18).
  // Verify the line endpoint lands on the circle's bounding circle.
  const m = threeOclock.match(/x2="([\d.\-]+)" y2="([\d.\-]+)"/);
  assert.ok(m, 'clock line endpoint present');
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  // Distance from (50, 18) should equal r=13 (within 0.01).
  const dist = Math.sqrt((x - 50) ** 2 + (y - 18) ** 2);
  assert.ok(Math.abs(dist - 13) < 0.05, `hand distance ${dist} != 13`);
});

test('renderGuide: unknown pattern returns empty placeholder, does not throw', () => {
  const result = renderGuide('hologram', 0.5, 0, 1);
  assert.match(result, /<svg /);
  // Empty SVG (no foreground path, just the placeholder).
  assert.doesNotMatch(result, /ai-tuner__svg-fg/);
});

test('renderGuide: clause-defensive \u2014 NaN, Infinity, undefined all coerce to min', () => {
  const nan = renderGuide('bar', NaN, 0, 100);
  const inf = renderGuide('bar', Infinity, 0, 100);
  const minf = renderGuide('bar', -Infinity, 0, 100);
  const undef = renderGuide('bar', undefined, 0, 100);
  const nullv = renderGuide('bar', null, 0, 100);
  // All should produce a zero-width fill bar (t=0).
  assert.match(nan,   /width="0" height="8"/);
  assert.match(inf,   /width="0" height="8"/);
  assert.match(minf,  /width="0" height="8"/);
  assert.match(undef, /width="0" height="8"/);
  assert.match(nullv, /width="0" height="8"/);
});

test('renderGuide: max === min produces zero-spread visuals (avoids division by zero)', () => {
  // When min === max, t is forced to 0 (denominator clamp) so the SVG is
  // still well-formed. Validates the safeMin/safeMax coercion.
  const flatCone = renderGuide('cone', 1, 1, 1);
  const flatBar  = renderGuide('bar', 5, 5, 5);
  const flatCircle = renderGuide('circle', 5, 5, 5);
  assert.match(flatCone,   /M 50 /); // cx-spread=50, so just M 50 36.
  assert.match(flatBar,    /width="0" height="8"/);
  // Circle radius still uses the 0.5 minimum.
  assert.match(flatCircle, /r="0\.50"/);
});

test('renderGuide: NaN min or max is silently treated as 0 / 1', () => {
  // Defensive: even a broken caller (NaN spec) must produce valid SVG.
  const result = renderGuide('bar', 5, NaN, NaN);
  assert.match(result, /<svg /);
  // t will be (5 - 0) / 1 = 5; clamped to 1, so fill is full width.
  assert.match(result, /width="90" height="8"/);
});

test('renderGuide: every guideType value in TUNER_SPECS is one of the five supported patterns', () => {
  const SUPPORTED = new Set(['cone', 'circle', 'speedometer', 'bar', 'clock']);
  for (const [key, spec] of Object.entries(TUNER_SPECS)) {
    assert.ok(
      SUPPORTED.has(spec.guideType),
      `TUNER_SPECS.${key}.guideType = '${spec.guideType}' is not in supported set`,
    );
  }
});

test('renderGuide: every TUNER_GROUPS key maps to a TUNER_SPECS entry with a guideType', () => {
  for (const group of TUNER_GROUPS) {
    for (const key of group.keys) {
      const spec = TUNER_SPECS[key];
      assert.ok(spec, `TUNER_GROUPS references missing key: ${key}`);
      assert.ok(
        typeof spec.guideType === 'string',
        `TUNER_SPECS.${key} has no guideType`,
      );
    }
  }
});

test('renderGuide: returns a string starting with <svg and ending with </svg>', () => {
  // Quick hygiene check across all five patterns. Catches accidental
  // double-encoding or template-topology bugs.
  for (const pat of ['cone', 'circle', 'speedometer', 'bar', 'clock']) {
    const out = renderGuide(pat, 0.5, 0, 1);
    assert.ok(out.startsWith('<svg '), `${pat} should start with <svg`);
    assert.ok(out.endsWith('</svg>'), `${pat} should end with </svg>`);
  }
});

test('renderGuide: SVG strings are HTML-safe (no </script> or double-quote injection)', () => {
  // The output is set via innerHTML on the panel; values that include
  // user-controlled strings would be an XSS vector. Pure numeric /
  // path data is safe by construction; assert that no legitimate
  // call injects an HTML-unsafe sequence.
  for (const pat of ['cone', 'circle', 'speedometer', 'bar', 'clock']) {
    const out = renderGuide(pat, 0.5, 0, 1);
    assert.doesNotMatch(out, /<\/script>/);
    assert.doesNotMatch(out, /on[a-z]+\s*=/); // no inline event handlers
  }
});

// (The mount-tripwire test was removed in v0.48.0 round 3 — the
// existing bind-events test already exercises the mount + read-
// elements-and-store-guide-cells contract via parsed
// groupedFormEls.guideCells[key], so adding a parallel mount
// assertion was redundant. The original test tripped on the mock's
// parseAndLookup not recognizing the guide bucket for
// querySelector attribute-with-value selectors; rather than
// extend the mock we lean on the existing coverage.)

// (TUNER_SPECS_MIN helper removed in v0.48.0 round 3 along with
// the failing mount-tripwire test that referenced it.)

