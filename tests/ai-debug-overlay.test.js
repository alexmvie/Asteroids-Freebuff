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
  assert.equal(modeToBadgeClass('asteroid'), 'ai-debug__chip--asteroid');
  assert.equal(modeToBadgeClass('powerup'),  'ai-debug__chip--powerup');
  assert.equal(modeToBadgeClass('idle'),     'ai-debug__chip--idle');
});

test('modeToBadgeClass: unknown mode falls back to idle', () => {
  assert.equal(modeToBadgeClass(''),     'ai-debug__chip--idle');
  assert.equal(modeToBadgeClass('flarb'), 'ai-debug__chip--idle');
  assert.equal(modeToBadgeClass(null),   'ai-debug__chip--idle');
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
        'threats', 'lookahead', 'state', 'score', 'energyBar',
        'energyVal', 'energyMax',
      ];
      for (const n of names) elements.set(`dbg:${n}`, makeCell(`dbg:${n}`));
      elements.set('panel:decision', makePanel('panel:decision'));
      elements.set('panel:state',    makePanel('panel:state'));
    },
  };
  function makeCell(key) {
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
    const el = {
      querySelector: root.querySelector,
      _key: key,
    };
    elements.set(key, el);
    return el;
  }
  function makeCanvas() {
    return {
      width: 0, height: 0, style: {},
      getContext: () => null, // null context → radarView.draw is a no-op
    };
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
