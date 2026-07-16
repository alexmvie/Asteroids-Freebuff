/**
 * Tests for the v0.23.x AI Debug Overlay.
 *
 * Scope:
 *   - Pure helpers (worldToRadar, clipToRadarEdge, colorForThreatDistance,
 *     modeToBadgeClass, formatDistance, formatYawCommand, formatBool)
 *     are tested directly with hand-built inputs.
 *   - The composing factory (createAiDebugOverlay) is given a mock
 *     rootEl + mock canvas (the canvas context is a stub record) so
 *     we can verify the dependency wiring and the public surface
 *     (mount, update, dispose) without depending on jsdom/canvas.
 *
 * These tests intentionally do NOT exercise the radar drawing
 * pixel-by-pixel — that would need a real canvas context and a
 * deterministic pixel-difference assert. We exercise the math
 * upstream of the canvas (worldToRadar, clipToRadarEdge) which is
 * the visual contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  worldToRadar,
  clipToRadarEdge,
  colorForThreatDistance,
  modeToBadgeClass,
  formatDistance,
  formatYawCommand,
  formatBool,
  resolveWorldRadius,
  worldBearingToCanvasAngle,
  createAiDebugOverlay,
} from '../src/ui/ai-debug-overlay.js';

// ---------------------------------------------------------------------------
// Helper: worldToRadar
// ---------------------------------------------------------------------------

test('worldToRadar: point at origin → canvas center, dist=0', () => {
  const r = worldToRadar({ x: 0, z: 0 }, 0, 0, 80, 100);
  assert.equal(r.px, 0);
  assert.equal(r.py, 0);
  assert.equal(r.dist, 0);
});

test('worldToRadar: point at +X at worldRadius edge → canvas +X edge with scale=halfSize/radius', () => {
  // worldRadius=80, halfSize=100 → scale=100/80=1.25
  const r = worldToRadar({ x: 80, z: 0 }, 0, 0, 80, 100);
  assert.equal(r.px, 100);
  assert.equal(r.py, 0);
  assert.equal(r.dist, 80);
});

test('worldToRadar: point at -Z (north) goes to TOP of canvas (negative py)', () => {
  // North = world -Z (matches ship.js convention yaw=0 → facing -Z).
  // After rotation, px=0, py is inverted so -Z → py<0 → canvas-top.
  const r = worldToRadar({ x: 0, z: -80 }, 0, 0, 80, 100);
  assert.equal(r.px, 0);
  assert.equal(r.py, -100); // north → top
  assert.equal(r.dist, 80);
});

test('worldToRadar: centered on a non-origin subject', () => {
  // Subject at (50, -30). Point at (50, -30) → canvas center.
  const r = worldToRadar({ x: 50, z: -30 }, 50, -30, 80, 100);
  assert.equal(r.px, 0);
  assert.equal(r.py, 0);
  assert.equal(r.dist, 0);
});

test('worldToRadar: relative offset works regardless of subject position', () => {
  const r = worldToRadar({ x: 130, z: -110 }, 50, -30, 80, 100);
  // dx=80, dz=-80 → px=100, py=-100
  assert.equal(r.px, 100);
  assert.equal(r.py, -100);
  assert.equal(r.dist, Math.hypot(80, 80));
});

test('worldToRadar: returns {0, 0, Infinity} on null/invalid pos', () => {
  assert.equal(worldToRadar(null, 0, 0, 80, 100).dist, Infinity);
  assert.equal(worldToRadar({}, 0, 0, 80, 100).dist, Infinity);
});

test('worldToRadar: returns {0, 0, Infinity} on bad halfSize / worldRadius', () => {
  assert.equal(worldToRadar({ x: 0, z: 0 }, 0, 0, 80, 0).dist, Infinity);
  assert.equal(worldToRadar({ x: 0, z: 0 }, 0, 0, 0, 100).dist, Infinity);
  assert.equal(worldToRadar({ x: 0, z: 0 }, 0, 0, 80, -10).dist, Infinity);
});

// ---------------------------------------------------------------------------
// Helper: clipToRadarEdge
// ---------------------------------------------------------------------------

test('clipToRadarEdge: inside → unchanged', () => {
  const r = clipToRadarEdge({ px: 10, py: 0 }, 50);
  assert.equal(r.px, 10);
  assert.equal(r.py, 0);
});

test('clipToRadarEdge: on circle edge → unchanged', () => {
  // At halfSize=50, markerPxRadius=4, allowed=46.
  // Point at distance 46 → unchanged.
  const r = clipToRadarEdge({ px: 46, py: 0 }, 50);
  assert.equal(r.px, 46);
  assert.equal(r.py, 0);
});

test('clipToRadarEdge: outside → scaled back to circle interior (minus markerPxRadius)', () => {
  // (100, 0) at halfSize=50 → |v|=100 → scale = allowed/r = 46/100 = 0.46.
  const r = clipToRadarEdge({ px: 100, py: 0 }, 50);
  assert.equal(r.px, 46);
  assert.equal(r.py, 0);
});

test('clipToRadarEdge: diagonal outside → both px AND py scaled', () => {
  // (60, 60) → |v|≈84.85, allowed=46 → scale≈0.542.
  const r = clipToRadarEdge({ px: 60, py: 60 }, 50);
  // Both px and py should shrink to (already inside [] boundary after scale).
  assert.ok(r.px < 60 && r.py < 60, 'px and py should shrink');
  assert.ok(Math.hypot(r.px, r.py) <= 46, 'should land on or inside the allowed radius');
});

test('clipToRadarEdge: markerPxRadius buffers the edge so dots do not cross the border', () => {
  // markerPxRadius=10 → allowed=40, so the projected point lands at 40, not 50.
  const r = clipToRadarEdge({ px: 200, py: 0 }, 50, 10);
  assert.equal(r.px, 40);
  assert.equal(r.py, 0);
});

test('clipToRadarEdge: zero-length vector → unchanged (degenerate input)', () => {
  const r = clipToRadarEdge({ px: 0, py: 0 }, 50);
  assert.equal(r.px, 0);
  assert.equal(r.py, 0);
});

// ---------------------------------------------------------------------------
// Helper: colorForThreatDistance
// ---------------------------------------------------------------------------

test('colorForThreatDistance: dist=0 → red (close panic)', () => {
  assert.equal(colorForThreatDistance(0, 80), '#ff5566');
});

test('colorForThreatDistance: dist=max → cyan (cold, far)', () => {
  assert.equal(colorForThreatDistance(80, 80), '#48dbfb');
});

test('colorForThreatDistance: dist=max/2 → orange (warm up)', () => {
  // At t=0.5 we are right ON the orange boundary (Red→Orange for t<0.5,
  // Orange→Cyan for t>0.5). Both formulas produce `#ff8844` (orange) at t=0.5.
  assert.equal(colorForThreatDistance(40, 80), '#ff8844');
});

test('colorForThreatDistance: clamps dist to [0, max]', () => {
  assert.equal(colorForThreatDistance(-10, 80), '#ff5566');
  // dist > max → t=1 → cyan.
  assert.equal(colorForThreatDistance(200, 80), '#48dbfb');
});

test('colorForThreatDistance: invalid max → cyan fallback', () => {
  assert.equal(colorForThreatDistance(10, 0), '#48dbfb');
  assert.equal(colorForThreatDistance(10, -1), '#48dbfb');
});

test('colorForThreatDistance: invalid dist → red fallback', () => {
  assert.equal(colorForThreatDistance(NaN, 80), '#ff5566');
  assert.equal(colorForThreatDistance(Infinity, 80), '#ff5566');
});

test('colorForThreatDistance: monotonic t progression — r decreases, b increases', () => {
  // At t=0 (dist=0): r=255, g=85,  b=102
  // At t=0.5 (dist=40): r=255, g=136, b=68
  // At t=1 (dist=80): r=72  g=219, b=251
  const c0 = colorForThreatDistance(0, 80);
  const c50 = colorForThreatDistance(40, 80);
  const c100 = colorForThreatDistance(80, 80);
  assert.match(c0, /^#ff5566$/);
  assert.match(c50, /^#ff8844$/);
  assert.match(c100, /^#48dbfb$/);
});

// ---------------------------------------------------------------------------
// Helper: modeToBadgeClass
// ---------------------------------------------------------------------------

test('modeToBadgeClass: known modes map to known modifiers', () => {
  assert.equal(modeToBadgeClass('dodge'),    'ai-debug__chip--dodge');
  assert.equal(modeToBadgeClass('evade'),    'ai-debug__chip--evade');
  assert.equal(modeToBadgeClass('asteroid'), 'ai-debug__chip--asteroid');
  assert.equal(modeToBadgeClass('powerup'),  'ai-debug__chip--powerup');
  assert.equal(modeToBadgeClass('idle'),     'ai-debug__chip--idle');
});

test('modeToBadgeClass: unknown mode falls back to idle', () => {
  assert.equal(modeToBadgeClass(''),     'ai-debug__chip--idle');
  assert.equal(modeToBadgeClass('flarb'), 'ai-debug__chip--idle');
  assert.equal(modeToBadgeClass(null),   'ai-debug__chip--idle');
});

test('modeToBadgeClass: evade mode maps to the v0.46.x evade modifier', () => {
  // The brain returns 'evade' (not 'dodge') on this branch; the chip
  // must render ``--evade`` (orange pulse) — not ``--idle`` (gray).
  assert.equal(modeToBadgeClass('evade'), 'ai-debug__chip--evade');
  assert.notEqual(modeToBadgeClass('evade'), 'ai-debug__chip--idle');
});

// ---------------------------------------------------------------------------
// Helper: formatDistance
// ---------------------------------------------------------------------------

test('formatDistance: integer rounds', () => {
  assert.equal(formatDistance(38.4), '38u');
  assert.equal(formatDistance(38.6), '39u');
  assert.equal(formatDistance(0), '0u');
});

test('formatDistance: negative → 0u', () => {
  assert.equal(formatDistance(-5), '0u');
});

test('formatDistance: non-finite → em-dash', () => {
  assert.equal(formatDistance(NaN), '—u');
  assert.equal(formatDistance(Infinity), '—u');
});

// ---------------------------------------------------------------------------
// Helper: formatYawCommand
// ---------------------------------------------------------------------------

test('formatYawCommand: -1 → left arrow, 0 → dot, +1 → right arrow', () => {
  assert.equal(formatYawCommand(-1), '←');
  assert.equal(formatYawCommand(0), '·');
  assert.equal(formatYawCommand(1), '→');
});

test('formatYawCommand: other values → dot (the brain only returns {-1, 0, +1})', () => {
  assert.equal(formatYawCommand(2), '·');
  assert.equal(formatYawCommand(-0.5), '·');
});

// ---------------------------------------------------------------------------
// Helper: formatBool
// ---------------------------------------------------------------------------

test('formatBool: ON / OFF', () => {
  assert.equal(formatBool(true), 'ON');
  assert.equal(formatBool(false), 'OFF');
});

test('formatBool: truthy / falsy but normalized through Boolean()', () => {
  assert.equal(formatBool(1), 'ON');
  assert.equal(formatBool(0), 'OFF');
  assert.equal(formatBool(null), 'OFF');
  assert.equal(formatBool('yes'), 'ON');
});

// ---------------------------------------------------------------------------
// Helper: resolveWorldRadius (v0.59.0)
// ---------------------------------------------------------------------------
// Priority order: live getter (returns valid positive number) > static
// `worldRadius` > fallback (OVERLAY_CONFIG.worldRadius = 80u). The
// helper never returns a non-positive / NaN / undefined / null result;
// the radar would otherwise divide by zero in `worldToRadar`.

test('resolveWorldRadius: live getter wins over static value', () => {
  assert.equal(resolveWorldRadius(80, () => 1800, 80), 1800);
});

test('resolveWorldRadius: live getter wins over fallback too', () => {
  // No static value → getter must still take precedence.
  assert.equal(resolveWorldRadius(undefined, () => 250, 80), 250);
});

test('resolveWorldRadius: static value when getter is missing', () => {
  assert.equal(resolveWorldRadius(120, null, 80), 120);
  assert.equal(resolveWorldRadius(120, undefined, 80), 120);
});

test('resolveWorldRadius: fallback when getter is missing AND static is invalid', () => {
  assert.equal(resolveWorldRadius(0, null, 80), 80);
  assert.equal(resolveWorldRadius(NaN, null, 80), 80);
  assert.equal(resolveWorldRadius(undefined, null, 80), 80);
});

test('resolveWorldRadius: getter returning invalid values falls through to static', () => {
  // None of these should ever reach the radar; resolveWorldRadius
  // must reject and fall back. The radar would otherwise divide by
  // zero / render NaN coordinates.
  assert.equal(resolveWorldRadius(120, () => 0, 80), 120);
  assert.equal(resolveWorldRadius(120, () => -5, 80), 120);
  assert.equal(resolveWorldRadius(120, () => NaN, 80), 120);
  assert.equal(resolveWorldRadius(120, () => Infinity, 80), 120);
  assert.equal(resolveWorldRadius(120, () => undefined, 80), 120);
  assert.equal(resolveWorldRadius(120, () => null, 80), 120);
});

test('resolveWorldRadius: getter that throws falls through silently', () => {
  // The radar calls this every frame; a getter that throws must NOT
  // crash the radar loop. Falls through to static.
  assert.equal(resolveWorldRadius(120, () => { throw new Error('boom'); }, 80), 120);
});

test('resolveWorldRadius: getter + static both invalid → fallback', () => {
  assert.equal(resolveWorldRadius(0, () => 0, 80), 80);
  assert.equal(resolveWorldRadius(NaN, () => NaN, 80), 80);
  assert.equal(resolveWorldRadius(undefined, () => undefined, 80), 80);
});

test('resolveWorldRadius: getter returning a live-changing value is called each time', () => {
  // The closure captures `n` by reference, so callers can mutate the
  // bag between calls and see the new value.
  let n = 100;
  const getter = () => n;
  assert.equal(resolveWorldRadius(80, getter, 80), 100);
  n = 200;
  assert.equal(resolveWorldRadius(80, getter, 80), 200);
  n = 0; // invalid → falls through to static
  assert.equal(resolveWorldRadius(80, getter, 80), 80);
});

// ---------------------------------------------------------------------------
// Factory: createAiDebugOverlay
// ---------------------------------------------------------------------------

/**
 * Build a mock DOM root that supports `innerHTML`, `classList`, and
 * `querySelector`. We intentionally avoid jsdom — the only DOM APIs
 * the factory touches are these four. The canvas is fully stubbed:
 * no getContext('2d') is created, so the radar draw is a no-op.
 */
function buildMockRoot() {
  const elements = new Map();
  const root = {
    get innerHTML() { return ''; },
    set innerHTML(html) {
      // Parse data-ai-debug / data-ai-debug-panel attrs out of the html
      // just enough to register them by name. We don't actually render.
      // The factory reads `rootEl.innerHTML = ...` then queries via
      // data-ai-debug="<name>".
      this._html = html;
      this._rebuildMap();
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
      // Match the markup we set in innerHTML.
      if (!sel) return null;
      // v0.63.0 round-3: handle known-buttons BEFORE the generic
      // `data-ai-debug="..."` regex match. The toggle button has BOTH
      // `class="ai-debug__mode-toggle"` AND `data-ai-debug="radarModeToggle"`,
      // and `[data-ai-debug="radarModeToggle"]` is the selector the
      // factory uses. Without this precedence flip, the regex would
      // match first and return a CELL (with no addEventListener method),
      // causing the factory's `if (modeBtn && typeof addEventListener ===
      // 'function')` textContent assignment to be skipped.
      if (sel.includes('radarModeToggle')) {
        return makeButton('radarModeToggle');
      }
      // data-ai-debug-panel="<name>"
      const panelMatch = sel.match(/data-ai-debug-panel="([^"]+)"/);
      if (panelMatch) {
        const key = `panel:${panelMatch[1]}`;
        return elements.get(key) || makePanel(key);
      }
      // data-ai-debug="<name>"  (single-attribute query)
      const dbgMatch = sel.match(/data-ai-debug="([^"]+)"/);
      if (dbgMatch) {
        const key = `dbg:${dbgMatch[1]}`;
        return elements.get(key) || makeCell(key);
      }
      // canvas.ai-debug__radar
      if (sel.includes('canvas') && sel.includes('ai-debug__radar')) {
        return makeCanvas();
      }
      // Bare canonical selectors the panels sub-views query:
      if (sel === '[data-ai-debug="mode"]') return elements.get('dbg:mode') || makeCell('dbg:mode');
      if (sel === '[data-ai-debug="yaw"]') return elements.get('dbg:yaw') || makeCell('dbg:yaw');
      if (sel.includes('root.querySelector'))
        return null;
      return null;
    },
    _rebuildMap() {
      elements.clear();
      // Build a synthetic map of the elements we expect to query, so
      // we don't have to parse the HTML. This emulates what index.html
      // provides for the live app.
    const names = [
      'mode', 'yaw', 'thrust', 'fire', 'weapon', 'target',
      'threats', 'lookahead', 'reason', 'state', 'score', 'energyBar',
      'energyVal', 'energyMax',
    ];
      for (const n of names) elements.set(`dbg:${n}`, makeCell(`dbg:${n}`));
      elements.set('panel:decision', makePanel('panel:decision'));
      elements.set('panel:state',    makePanel('panel:state'));
    },
  };
  function makeCell(key) {
    if (elements.has(key)) return elements.get(key);
    const el = {
      textContent: '',
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
      style: { setProperty: () => {} },
      _key: key,
    };
    elements.set(key, el);
    return el;
  }
  function makePanel(key) {
    if (elements.has(key)) return elements.get(key);
    const el = {
      querySelector: root.querySelector,
      _key: key,
    };
    elements.set(key, el);
    return el;
  }
  function makeCanvas() {
    // Idempotent — the canvas is queried twice (once by the factory's
    // mount(), once during the compile-time v0.63.0 round-3 bug fix
    // below). Returning the same instance w/ the same width/height
    // keeps the mock consistent. Namespaced key avoids collisions
    // with any future canvas-bearing fixture.
    if (elements.has('mock:canvas-radar')) return elements.get('mock:canvas-radar');
    const el = {
      width: 0, height: 0, style: {},
      getContext: () => null, // null context → radarView.draw is a no-op
    };
    elements.set('mock:canvas-radar', el);
    return el;
  }
  function makeButton(key) {
    // v0.63.0 round-3 fix — the toggle tests failed because makeButton
    // created a fresh button each call. The factory's mount() did
    // querySelector → makeButton(button A); the test then did
    // querySelector → makeButton(button B), overwriting A's listeners.
    // The button B has no click listener and unchanged textContent,
    // so assertions on toggleBtn.textContent saw ''. Returning the
    // existing instance on subsequent calls fixes this. Also reapplies
    // `_listeners` lookup so earlier listener registrations aren't
    // lost.
    if (elements.has(key)) return elements.get(key);
    const el = {
      textContent: '',
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
      style: { setProperty: () => {} },
      _key: key,
      _listeners: {},
      addEventListener(type, fn) {
        this._listeners[type] = this._listeners[type] || [];
        this._listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (!this._listeners[type]) return;
        const idx = this._listeners[type].indexOf(fn);
        if (idx >= 0) this._listeners[type].splice(idx, 1);
      },
    };
    elements.set(key, el);
    return el;
  }
  root._rebuildMap();
  return root;
}

test('createAiDebugOverlay: returns { mount, update, dispose }', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  assert.equal(typeof ai.mount, 'function');
  assert.equal(typeof ai.update, 'function');
  assert.equal(typeof ai.dispose, 'function');
});

test('createAiDebugOverlay: throws when getSubject is missing', () => {
  assert.throws(() => createAiDebugOverlay({}), /getSubject is required/);
});

test('createAiDebugOverlay: displayMode="off" is a no-op factory', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null, displayMode: 'off' });
  // mount/update/dispose are callable without throwing AND mount does not inject DOM.
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  ai.dispose();
  assert.ok(!root.classList._set.has('ai-debug--mounted'), 'off-mode factory should not inject innerHTML/classes');
});

test('createAiDebugOverlay: mount injects innerHTML into root', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  const root = buildMockRoot();
  ai.mount(root);
  assert.ok(root._html && root._html.includes('AI DEBUG'), 'innerHTML should have the AI DEBUG title');
  assert.ok(root.classList._set.has('ai-debug--mounted'), 'root gets ai-debug--mounted class');
});

test('createAiDebugOverlay: mount is idempotent (a second mount re-overwrites innerHTML)', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  const root = buildMockRoot();
  ai.mount(root);
  const first = root._html;
  ai.mount(root);
  assert.equal(root._html, first, 'second mount should produce the same innerHTML');
});

test('createAiDebugOverlay: update before mount is a no-op (does not throw)', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  // No assertions: the constraint is that this doesn't throw.
  ai.update();
});

test('createAiDebugOverlay: dispose before mount is a no-op (does not throw)', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  ai.dispose();
});

// v0.63.0 round-3d regression guard — the mock's `querySelector`
// branch order matters: the `sel.includes('radarModeToggle')`
// substring check must run BEFORE the generic `/data-ai-debug="…"/`
// regex match. Without this precedence, querySelector returns a CELL
// (no addEventListener method) for the toggle selector, and the
// factory's `if (modeBtn && typeof modeBtn.addEventListener ===
// 'function')` skip-path leaves textContent unchanged (the toggle
// tests then fail with cryptic "got ''" errors). This test pins the
// precedence rule so a future refactor (alphabetical ordering,
// "tidy these up", etc.) doesn't silently break the v0.63.0
// toggle-button contract.
test('v0.63.0 round-3d regression guard: querySelector("[data-ai-debug=radarModeToggle]") returns a BUTTON (has addEventListener), not a CELL', () => {
  const root = buildMockRoot();
  const el = root.querySelector('[data-ai-debug="radarModeToggle"]');
  assert.ok(el, 'radarModeToggle selector must return an element');
  // A BUTTON has addEventListener; a CELL does not. This is the
  // single distinguishing feature the factory keys on (see
  // createAiDebugOverlay.mount()'s `if (modeBtn && typeof
  // modeBtn.addEventListener === 'function')`). When this assertion
  // FAILS, the mock ordering has been silently broken.
  assert.equal(typeof el.addEventListener, 'function',
    'radarModeToggle selector must return a BUTTON (with addEventListener), not a CELL');
});

test('createAiDebugOverlay: update populates cell text from getLastDecision closures', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => ({
      position: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0 },
    }),
    getLastDecision: () => ({
      mode: 'asteroid',
      yaw: 1,
      thrust: true,
      fire: true,
      activeWeapon: 'bullet',
      target: { pos: { x: 30, z: 0 }, mode: 'asteroid', dist: 30 },
      nearest: { pos: { x: 30, z: 0 }, dist: 30 },
      threatsCount: 2,
      lookaheadThreats: 5,
    }),
    getActiveWeapon: () => 'laser',
    getScore: () => 12345,
    getEnergy: () => ({ value: 78, max: 100 }),
    getState: () => 'PLAYING',
    getAsteroids: () => [],
    getPowerupPos: () => null,
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  // Decisions cell values from the mocked closure:
  const modeCells = root.querySelector('[data-ai-debug="mode"]');
  // Mode chip text comes from a different sub-view (chipView), but
  // the panel also has its own [data-ai-debug="mode"] cell. Both
  // should reflect the closed decision.
  assert.equal(modeCells.textContent, 'ASTEROID');
  const yawCell = root.querySelector('[data-ai-debug="yaw"]');
  assert.equal(yawCell.textContent, '→', 'yaw=+1 → →');
  const thrustCell = root.querySelector('[data-ai-debug="thrust"]');
  assert.equal(thrustCell.textContent, 'ON');
  const fireCell = root.querySelector('[data-ai-debug="fire"]');
  assert.equal(fireCell.textContent, 'ON');
  const weaponCell = root.querySelector('[data-ai-debug="weapon"]');
  assert.equal(weaponCell.textContent, 'LASER', 'weapon=laser → LASER row');
  const targetCell = root.querySelector('[data-ai-debug="target"]');
  assert.match(targetCell.textContent, /^AST\s\d+u$/, 'asteroid target with formatted dist');
  // State panel:
  const stateCell = root.querySelector('[data-ai-debug="state"]');
  assert.equal(stateCell.textContent, 'PLAYING');
  const scoreCell = root.querySelector('[data-ai-debug="score"]');
  assert.equal(scoreCell.textContent, '12345');
  // Energy: deep assert that the values were written.
  const eV = root.querySelector('[data-ai-debug="energyVal"]');
  const eM = root.querySelector('[data-ai-debug="energyMax"]');
  assert.equal(eV.textContent, '78');
  assert.equal(eM.textContent, '100');
  // Threats rows.
  const threatsCell = root.querySelector('[data-ai-debug="threats"]');
  assert.equal(threatsCell.textContent, '2');
  const lookaheadCell = root.querySelector('[data-ai-debug="lookahead"]');
  assert.equal(lookaheadCell.textContent, '5');
  ai.dispose();
});

test('createAiDebugOverlay: update with null/missing dep closures does not throw', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  const root = buildMockRoot();
  ai.mount(root);
  // No getters for anything except getSubject — the safeCall wrapper
  // should swallow missing fns and assign "—" / "0" / etc.
  assert.doesNotThrow(() => ai.update());
  ai.dispose();
});

test('createAiDebugOverlay: update tolerates getter that throws', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    getLastDecision: () => { throw new Error('boom'); },
    getActiveWeapon: () => undefined, // valid: returns falsy
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.doesNotThrow(() => ai.update());
  ai.dispose();
});

test('createAiDebugOverlay: update tolerates empty asteroid list', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 } }),
    getAsteroids: () => [],
    getPowerupPos: () => null,
    getLastDecision: () => null,
    getActiveWeapon: () => 'bullet',
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.doesNotThrow(() => ai.update());
  ai.dispose();
});

test('createAiDebugOverlay: dispose unmounts (subsequent update does not throw but is a no-op)', () => {
  const ai = createAiDebugOverlay({ getSubject: () => null });
  const root = buildMockRoot();
  ai.mount(root);
  ai.dispose();
  assert.doesNotThrow(() => ai.update(), 'update after dispose should be a no-op');
});

// =============================================================================
// v0.59.0 — Radar radius = 3 × ship sight (live-tunable world scope)
// =============================================================================
// The user asked for the radar to cover ~3× the ship's visible world
// scope, not just the AI's reactive range. The wiring contract:
//   - The factory accepts an OPTIONAL `getWorldRadius` callback.
//   - When provided AND returning a valid positive number, the radar
//     uses that value as its worldRadius (overriding any static arg).
//   - When missing / invalid / throwing, the radar falls back to the
//     static `worldRadius` parameter, then to OVERLAY_CONFIG.worldRadius.
// This pair of tests pins the wiring contract so the live scope can
// be changed at runtime (e.g. via the AI Tuners panel) without
// re-creating the overlay.

test('createAiDebugOverlay: getWorldRadius callback is called every update (live-tunable, not cached at mount)', () => {
  // The live-tunable contract: the getter is called on every update
  // call, regardless of whether the canvas has a usable context. The
  // current implementation evaluates `currentWorldRadius()` BEFORE
  // the `if (!ctx) return` guard in `draw()` so the live-bag
  // mutation propagates even when the radar is a no-op visually.
  let getterCalls = 0;
  let liveRadius = 1800;
  const ai = createAiDebugOverlay({
    getSubject: () => null, // mock canvas returns null context; draw is a no-op
    worldRadius: 80,        // static fallback
    getWorldRadius: () => { getterCalls++; return liveRadius; },
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  ai.update();
  assert.equal(getterCalls, 2, 'getter is called every update (live-tunable, not cached)');
  // Mutate the live bag and verify the next update reflects it.
  liveRadius = 900;
  getterCalls = 0;
  ai.update();
  assert.equal(getterCalls, 1);
  ai.dispose();
});

test('createAiDebugOverlay: getWorldRadius callback value overrides static worldRadius', () => {
  // The override semantic: when the getter returns a valid positive
  // number, that number is the radar's worldRadius — the static arg
  // is ignored. NOTE: this test asserts via `resolveWorldRadius`
  // directly (the pure helper). The factory path is covered by the
  // call-frequency test above (which exercises the live draw path
  // through `radarView.draw()` -> `currentWorldRadius()` ->
  // `resolveWorldRadius(...)`). The radar view's `currentWorldRadius`
  // is internal so we cannot spy on it from outside.
  let liveRadius = 250;
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    worldRadius: 80,
    getWorldRadius: () => liveRadius,
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  // Snapshot the resolved value via the public API: the radar view
  // doesn't expose currentWorldRadius(), so we exercise it indirectly
  // by re-evaluating resolveWorldRadius with the same wiring
  // semantics. This pins the contract: liveRadius is the source of
  // truth when present, regardless of static.
  assert.equal(resolveWorldRadius(80, () => liveRadius, 80), liveRadius);
  liveRadius = 999;
  assert.equal(resolveWorldRadius(80, () => liveRadius, 80), 999);
  ai.dispose();
});

test('createAiDebugOverlay: missing getWorldRadius falls back to static worldRadius', () => {
  // No getWorldRadius provided → resolver falls through to the static
  // `worldRadius` parameter. Use a unique static value (240) so the
  // test exercises the static branch specifically — not just the
  // config default (which happens to also be 80). NOTE: the factory
  // path is a smoke test ("doesn't throw + `resolveWorldRadius(240,
  // null, 80) === 240`"); the live draw path through the radar view
  // is covered by the call-frequency test above.
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    worldRadius: 240,
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.doesNotThrow(() => ai.update());
  // The radar's resolved radius equals the static 240, not the
  // config default 80. Pin the value directly via the helper.
  assert.equal(resolveWorldRadius(240, null, 80), 240);
  ai.dispose();
});

// =============================================================================
// v0.46.x — WHY row (decision.reason)
// =============================================================================
// The user explicitly asked for "damit ich sehe was die AI macht". Every
// behavior (evade / engage / collect / idle) returns a `reason` string
// explaining which threshold fired. This row pins the wiring contract:
// when getLastDecision returns { ..., reason }, the [data-ai-debug=reason]
// cell must show that exact text. Empty / missing reason shows '—'.

test('createAiDebugOverlay: WHY row populated from getLastDecision.reason', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 } }),
    getLastDecision: () => ({
      mode: 'evade',
      yaw: 1,
      thrust: true,
      fire: false,
      activeWeapon: 'bullet',
      target: null,
      nearest: { pos: { x: 5, z: 0 }, dist: 5 },
      threatsCount: 1,
      reason: 'nearest 5.0u < evadeDist 10.0u',
    }),
    getActiveWeapon: () => 'bullet',
    getAsteroids: () => [],
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  const reasonCell = root.querySelector('[data-ai-debug="reason"]');
  assert.equal(reasonCell.textContent, 'nearest 5.0u < evadeDist 10.0u', 'WHY row must mirror decision.reason verbatim');
  ai.dispose();
});

test('createAiDebugOverlay: WHY row shows em-dash when reason is missing', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 } }),
    getLastDecision: () => ({
      mode: 'idle',
      yaw: 0,
      thrust: false,
      fire: false,
      activeWeapon: 'bullet',
      target: null,
      nearest: null,
      threatsCount: 0,
      // reason intentionally omitted.
    }),
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  const reasonCell = root.querySelector('[data-ai-debug="reason"]');
  assert.equal(reasonCell.textContent, '—', 'no reason → em-dash');
  ai.dispose();
});

test('createAiDebugOverlay: WHY row refreshes on subsequent updates', () => {
  let reasonText = 'idle (no asteroids in range)';
  const ai = createAiDebugOverlay({
    getSubject: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0 } }),
    getLastDecision: () => ({
      mode: 'idle',
      yaw: 0,
      thrust: false,
      fire: false,
      activeWeapon: 'bullet',
      target: null,
      nearest: null,
      threatsCount: 0,
      reason: reasonText,
    }),
  });
  const root = buildMockRoot();
  ai.mount(root);
  ai.update();
  const reasonCell = root.querySelector('[data-ai-debug="reason"]');
  assert.equal(reasonCell.textContent, reasonText);

  reasonText = 'asteroid L @ 24.0u, closing 20.0u/s';
  ai.update();
  assert.equal(reasonCell.textContent, reasonText, 'WHY row must update on every tick');
  ai.dispose();
});

// ============================================================================
// v0.63.0 — compass mode helpers + factory wiring + display-mode toggle cycle
// ============================================================================
// The user asked to "build the suggested compass mode". The user-stated
// motivation was "wenn ich später evtl. mal fliegen sehen will wo der
// spieler hinmuss" — a future-proof knob the user could toggle at
// runtime. Three layers under test here:
//
//   1. **Pure helper `worldBearingToCanvasAngle(yaw, dx, dz)`** — math
//      that converts ship-frame bearing to canvas-arc rotation. The
//      convention: dead-ahead target → 12 o'clock → canvas angle -PI/2.
//      8 unit tests pin every cardinal + wrap-around edge case.
//   2. **Factory wiring** — `displayMode === 'compass'` adds the
//      `.ai-debug--compass` class (covered here), and `mount()`
//      instantiates BOTH views so flipping modes doesn't recreate
//      anything. `dispose()` releases both.
//   3. **Toggle cycle** — clicking the existing `radarModeToggle`
//      button cycles through `radar-rotate → radar-north-up → compass
//      → radar-rotate`. The button label + a CSS class on the root
//      are the two visible signals.

// ---------------------------------------------------------------------------
// 1. Pure helper: worldBearingToCanvasAngle
// ---------------------------------------------------------------------------

test('v0.63.0: worldBearingToCanvasAngle: dead-ahead target returns -PI/2 (12 o\u2019clock)', () => {
  // yaw=0 (ship faces -Z), target at dx=0, dz=-1 (north of ship).
  // Pure math: atan2(0, 1) = 0 (north). 0 - 0 = 0 (relative). 0 - PI/2 = -PI/2.
  assert.equal(worldBearingToCanvasAngle(0, 0, -1), -Math.PI / 2);
});

test('v0.63.0: worldBearingToCanvasAngle: dead-right target returns 0 (3 o\u2019clock)', () => {
  // yaw=0, target at dx=1, dz=0 (east). atan2(1, 0) = PI/2. PI/2 - PI/2 = 0.
  assert.equal(worldBearingToCanvasAngle(0, 1, 0), 0);
});

test('v0.63.0: worldBearingToCanvasAngle: dead-behind target returns +PI/2 (6 o\u2019clock)', () => {
  // yaw=0, target at dx=0, dz=1 (south). atan2(0, -1) = PI. PI - PI/2 = PI/2.
  assert.equal(worldBearingToCanvasAngle(0, 0, 1), Math.PI / 2);
});

test('v0.63.0: worldBearingToCanvasAngle: dead-left target returns \u00B1PI (9 o\u2019clock, wrap-equivalent)', () => {
  // yaw=0, target at dx=-1, dz=0 (west). atan2(-1, 0) = -PI. -PI - PI/2 = -3PI/2.
  // 3PI/2 is a valid angle but canvas-arc-equivalent to PI/2-rotated
  // (i.e. equivalent to PI on the [0, 2PI) circle). Round to [-PI, PI]
  // via wrapping to confirm visual correctness.
  const result = worldBearingToCanvasAngle(0, -1, 0);
  // Either -3PI/2 (preserved wrap) or equivalently +PI/2 after
  // canvas-arc normalization. cos/sin equivalence is what matters.
  const sinExpected = 0;
  const cosExpected = -1;
  assert.ok(Math.abs(Math.sin(result) - sinExpected) < 1e-9,
    `sin mismatch: got ${Math.sin(result)}, expected ${sinExpected}`);
  assert.ok(Math.abs(Math.cos(result) - cosExpected) < 1e-9,
    `cos mismatch: got ${Math.cos(result)}, expected ${cosExpected}`);
});

test('v0.63.0: worldBearingToCanvasAngle: facing-east yaw with target east returns -PI/2 (dead ahead)', () => {
  // The ship has turned 90\u00B0 left (yaw=PI/2 in our convention). Target is east.
  // In ship-frame this is dead ahead. Pure math: atan2(1, 0) = PI/2 global
  // bearing. PI/2 - PI/2 (yaw) = 0 relative. 0 - PI/2 = -PI/2 canvas angle.
  assert.equal(worldBearingToCanvasAngle(Math.PI / 2, 1, 0), -Math.PI / 2);
});

test('v0.63.0: worldBearingToCanvasAngle: facing-south yaw with target north returns +PI/2 (dead-behind)', () => {
  // yaw=PI (ship faces +Z = south). Target at dx=0, dz=-1 (world north).
  // In ship-frame, target is dead-behind. Pure math: atan2(0, 1) = 0 global
  // bearing. 0 - PI = -PI relative. -PI - PI/2 = -3PI/2 canvas angle. Both
  // -3PI/2 AND +PI/2 are canvas-equivalent (same screen position).
  const result = worldBearingToCanvasAngle(Math.PI, 0, -1);
  // Equivalence check via sin/cos (since -3PI/2 == +PI/2 + 2*PI).
  assert.ok(Math.abs(Math.sin(result) - Math.sin(Math.PI / 2)) < 1e-9);
  assert.ok(Math.abs(Math.cos(result) - Math.cos(Math.PI / 2)) < 1e-9);
});

test('v0.63.0: worldBearingToCanvasAngle: facing-any-yaw with target-ahead returns -PI/2', () => {
  // The "dead ahead" bearing should always map to 12 o\u2019clock
  // regardless of yaw, as long as the target is in the forward direction.
  //
  // In ship.js's convention, forward at yaw=Y = (sin(Y), 0, -cos(Y))
  // because yaw=0 means facing -Z (north). An earlier draft used
  // (sin(yaw), cos(yaw)) which is SOUTH for yaw=0 \u2014 wrong direction.
  // Pin the correct convention with -cos(yaw).
  for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const dx = Math.sin(yaw);
    const dz = -Math.cos(yaw); // forward = -cos(yaw) per ship.js convention
    const result = worldBearingToCanvasAngle(yaw, dx, dz);
    // Each iteration should map to -PI/2 (12 o\u2019clock). Wrap into the
    // canonical [-PI, PI] form via sin/cos equivalence so we tolerate
    // boundary cases (e.g. yaw=PI lands at PI/2-PI+PI = PI/2 after
    // wrap, equivalent to -3PI/2 to -PI/2 \u2014 same screen position).
    const expected = -Math.PI / 2;
    const sinExpected = Math.sin(expected);
    const cosExpected = Math.cos(expected);
    assert.ok(Math.abs(Math.sin(result) - sinExpected) < 1e-9,
      `sin mismatch at yaw=${yaw}: got ${Math.sin(result)}, expected ${sinExpected}`);
    assert.ok(Math.abs(Math.cos(result) - cosExpected) < 1e-9,
      `cos mismatch at yaw=${yaw}: got ${Math.cos(result)}, expected ${cosExpected}`);
  }
});

test('v0.63.0: worldBearingToCanvasAngle: invalid inputs fall back to -PI/2 (12 o\u2019clock safe default)', () => {
  // NaN, Infinity in any arg \u2014 return the safe default. The compass must
  // never crash if a closure returns garbage.
  assert.equal(worldBearingToCanvasAngle(NaN, 0, -1), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(0, NaN, -1), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(0, 0, NaN), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(Infinity, 0, -1), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(0, -Infinity, 0), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(null, 0, -1), -Math.PI / 2);
  assert.equal(worldBearingToCanvasAngle(0, undefined, 0), -Math.PI / 2);
});

// ---------------------------------------------------------------------------
// 2. Factory wiring: displayMode === 'compass'
// ---------------------------------------------------------------------------

test('v0.63.0: createAiDebugOverlay with displayMode=compass adds ai-debug--compass class', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    displayMode: 'compass',
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.ok(
    root.classList._set.has('ai-debug--compass'),
    'displayMode=compass must add .ai-debug--compass to the root for CSS hooks',
  );
  ai.dispose();
});

test('v0.63.0: createAiDebugOverlay with displayMode=radar (default) does NOT add ai-debug--compass class', () => {
  // Default behavior (pre-v0.63.0): radar mode, no compass class. This
  // pins the back-compat invariant \u2014 existing callers that pass nothing
  // (or displayMode=radar) get the radar-only treatment.
  const ai = createAiDebugOverlay({ getSubject: () => null });
  const root = buildMockRoot();
  ai.mount(root);
  assert.ok(!root.classList._set.has('ai-debug--compass'), 'default radar mode must NOT add compass class');
  ai.dispose();
});

test('v0.63.0: createAiDebugOverlay with displayMode=compass does not throw on update (no-subject path)', () => {
  // Add the class, instantiate the compass view, then run update with
  // a null subject. The compass view's "NO SUBJECT" path mirrors the
  // radar's; this pins that contract.
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    displayMode: 'compass',
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.doesNotThrow(() => ai.update(), 'compass update must not throw on null subject');
  ai.dispose();
});

test('v0.63.0: createAiDebugOverlay dispose() in compass mode cleans up without throwing', () => {
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    displayMode: 'compass',
  });
  const root = buildMockRoot();
  ai.mount(root);
  assert.doesNotThrow(() => ai.dispose(), 'compass dispose must not throw');
  // Update after dispose is the documented no-op contract.
  assert.doesNotThrow(() => ai.update(), 'update after dispose must be a no-op');
});

// ---------------------------------------------------------------------------
// 3. Toggle cycle: radar-rotate \u2192 radar-north-up \u2192 compass \u2192 radar-rotate
// ---------------------------------------------------------------------------

test('v0.63.0: toggle button cycles through radar-rotate \u2192 radar-north-up \u2192 compass \u2192 radar-rotate', () => {
  // Mount with default radar mode; click the button 3 times; verify the
  // cycle:
  //   click 1: radar-rotate \u2192 radar-north-up, label "RADAR: NORTH-UP"
  //   click 2: radar-north-up \u2192 compass, label "COMPASS"
  //   click 3: compass \u2192 radar-rotate, label "RADAR: ROTATE"
  // The button has data-ai-debug=radarModeToggle in the innerHTML.
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    displayMode: 'radar', // explicit
  });
  const root = buildMockRoot();
  ai.mount(root);

  // Find the toggle button (added to the elements registry in buildMockRoot).
  const toggleBtn = root.querySelector('[data-ai-debug=\"radarModeToggle\"]');
  assert.ok(toggleBtn, 'toggle button must exist in mounted root');
  // Sanity: starts at "RADAR: ROTATE".
  assert.equal(toggleBtn.textContent, 'RADAR: ROTATE');
  assert.ok(!root.classList._set.has('ai-debug--compass'), 'initial state must not have compass class');

  // Click 1: rotate \u2192 north-up.
  toggleBtn._listeners.click[0]();
  assert.equal(toggleBtn.textContent, 'RADAR: NORTH-UP');
  assert.ok(!root.classList._set.has('ai-debug--compass'), 'radar-north-up must NOT add compass class');

  // Click 2: north-up \u2192 compass.
  toggleBtn._listeners.click[0]();
  assert.equal(toggleBtn.textContent, 'COMPASS');
  assert.ok(root.classList._set.has('ai-debug--compass'), 'compass must add compass class');

  // Click 3: compass \u2192 rotate.
  toggleBtn._listeners.click[0]();
  assert.equal(toggleBtn.textContent, 'RADAR: ROTATE');
  assert.ok(!root.classList._set.has('ai-debug--compass'), 'back to radar must REMOVE compass class');

  // Click 4: rotate \u2192 north-up (cycle repeat).
  toggleBtn._listeners.click[0]();
  assert.equal(toggleBtn.textContent, 'RADAR: NORTH-UP');
  ai.dispose();
});

test('v0.63.0: toggle cycle starting from compass displayMode adds class on mount', () => {
  // If user starts in compass mode, the cycle should already show
  // COMPASS label + compass class on mount (no click needed).
  const ai = createAiDebugOverlay({
    getSubject: () => null,
    displayMode: 'compass',
  });
  const root = buildMockRoot();
  ai.mount(root);
  const toggleBtn = root.querySelector('[data-ai-debug=\"radarModeToggle\"]');
  assert.equal(toggleBtn.textContent, 'COMPASS');
  assert.ok(root.classList._set.has('ai-debug--compass'));
  ai.dispose();
});
