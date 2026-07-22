/**
 * Unit tests for src/ui/hud.js.
 *
 * Uses the real `createEventBus` from src/systems/events.js (it's
 * already tested and known to work) and a small mock root element that
 * implements querySelector + the few DOM properties the HUD touches
 * (textContent, classList).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHud, formatScore } from '../src/ui/hud.js';
import { createEventBus } from '../src/systems/events.js';

// ===========================================================================
// v0.69.0 — minimal `document` shim so addBuffCard can call `document.createElement`.
// ===========================================================================
// src/ui/hud.js's addBuffCard builds child elements via document.createElement
// (the icon div, the body div, the fill div, the label/timer spans). Node has
// no document by default. We install a tiny shim here at module load so the
// buff-card lifecycle tests can exercise the full DOM creation path without
// pulling in jsdom (a heavy dep for ~4 tests). The shim records children in
// `el.children` (matching DOM semantics for appendChild + removeChild) and
// exposes setProperty/textContent/className setters that the HUD reads.
// Subsequent tests that don't need buff cards (the v0.11.x chip tests that
// this file's existing tests cover) are unaffected — the shim is a passive
// no-op for code paths that don't create elements.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        _children: [],
        get children() { return this._children; },
        appendChild(child) { this._children.push(child); return child; },
        removeChild(child) {
          const i = this._children.indexOf(child);
          if (i >= 0) this._children.splice(i, 1);
          return child;
        },
        style: {
          _set: Object.create(null),
          setProperty(name, value) { this._set[name] = String(value); },
          getPropertyValue(name) { return this._set[name] || ''; },
        },
        dataset: {},
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(...cs) { for (const c of cs) this._set.delete(c); },
          contains(c) { return this._set.has(c); },
          toggle(c, force) {
            if (force === true) { this._set.add(c); return true; }
            if (force === false) { this._set.delete(c); return false; }
            if (this._set.has(c)) { this._set.delete(c); return false; }
            this._set.add(c);
            return true;
          },
        },
      };
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        set(v) { el._textContent = String(v); },
        get() { return el._textContent || ''; },
      });
      Object.defineProperty(el, 'className', {
        configurable: true,
        set(v) { el._className = String(v); el.classList._set.add(String(v)); },
        get() { return el._className || ''; },
      });
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        set(v) { el._innerHTML = String(v); },
        get() { return el._innerHTML || ''; },
      });
      return el;
    },
  };
}

// ---- Mock DOM -----------------------------------------------------------

function makeMockEl({ text = '', classes = [] } = {}) {
  const classesSet = new Set(classes);
  // v0.69.0 -- track CSS custom properties set via `style.setProperty`
  // so tests can read them back without DOM theorycrafting. Maps the
  // custom property name (with leading `--`) to its string value.
  const customProps = Object.create(null);
  return {
    textContent: text,
    _customProps: customProps,
    // Test-facing handle: `el.style._buffColor` etc. are getters that
    // read from customProps. _getCustomProps returns the whole map for
    // full introspection.
    _getCustomProps: () => customProps,
    style: {
      setProperty(name, value) { customProps[name] = String(value); },
      getPropertyValue(name) { return customProps[name] || ''; },
    },
    classList: {
      add: (c) => classesSet.add(c),
      remove: (...cs) => { for (const c of cs) classesSet.delete(c); },
      contains: (c) => classesSet.has(c),
      // Mirrors the standard DOMTokenList.toggle(token, force) behavior:
      //   - force === true  → ensure present (add if missing)
      //   - force === false → ensure absent  (remove if present)
      //   - force omitted   → flip current state and return the new state
      toggle: (c, force) => {
        if (force === true) { classesSet.add(c); return true; }
        if (force === false) { classesSet.delete(c); return false; }
        if (classesSet.has(c)) { classesSet.delete(c); return false; }
        classesSet.add(c);
        return true;
      },
      _set: classesSet,
    },
  };
}

function makeMockRoot(overrides = {}) {
  // Default: all 4 elements exist. Pass `null` to simulate a missing one.
  // v0.69.0: `buffs` slot hosts the new rich buff cards (was .hud__buff
  // chips in v0.11.x). The mock exposes a child-tracking wrapper so
  // tests can inspect appended card DOM after bus events.
  const score = overrides.score !== null ? makeMockEl({ text: '000000' }) : null;
  const lives = overrides.lives !== null ? makeMockEl({ text: 'LIVES: 3' }) : null;
  const message = overrides.message !== null ? makeMockEl({ text: 'PRESS ANY KEY TO START' }) : null;
  const buffs = overrides.buffs !== null ? _makeMockContainerEl() : null;

  const map = new Map();
  if (score) map.set('[data-hud="score"]', score);
  if (lives) map.set('[data-hud="lives"]', lives);
  if (message) map.set('[data-hud="message"]', message);
  if (buffs) map.set('[data-hud="buffs"]', buffs);

  return {
    querySelector(sel) {
      return map.has(sel) ? map.get(sel) : null;
    },
    score,
    lives,
    message,
    buffs,
  };
}

// Container element with appendChild/removeChild tracking for buff cards.
// The HUD's addBuffCard uses group.appendChild(card); removeBuffChip uses
// ref.el.parentNode.removeChild(ref.el). Both are recorded in `children`
// so tests can assert on the card DOM after bus events.
function _makeMockContainerEl() {
  const children = [];
  const container = {
    children,
    appendChild(child) {
      children.push(child);
      // v0.69.0: set the child's parentNode back-reference so
      // removeBuffChip(ref.el.parentNode.removeChild(ref.el)) in
      // src/ui/hud.js can find its own parent. Without this, ref.el.parentNode
      // is undefined and the remove call is silently dropped, leaving the
      // chip in DOM after `buff:expired`.
      Object.defineProperty(child, 'parentNode', {
        configurable: true,
        get: () => container,
      });
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      return child;
    },
  };
  return container;
}

// ---- ctor / mount / dispose -------------------------------------------

test('createHud: requires bus', () => {
  assert.throws(() => createHud(), /bus.*required/);
  assert.throws(() => createHud({}), /bus.*required/);
});

test('createHud: mount requires rootEl', () => {
  const hud = createHud({ bus: createEventBus() });
  assert.throws(() => hud.mount(), /rootEl/);
  assert.throws(() => hud.mount(null), /rootEl/);
});

test('createHud: initialState "DEMO" seeds the demo message + flash class at mount', () => {
  // Boot scenario: the state machine starts in DEMO but doesn't
  // fire a `state:changed` event for the initial state. The HUD
  // must seed its visual state from `initialState` so the start
  // prompt is bottom-anchored and blinking on the very first frame.
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus, initialState: 'DEMO' });
  hud.mount(root);
  // The text + class are applied immediately at mount time, no
  // event emit required. The flash timer is also started (we
  // can't easily test the timer ticking, but the class state
  // confirms the right code path ran).
  assert.equal(root.message.textContent, 'PRESS ANY KEY TO START');
  assert.ok(root.message.classList.contains('hud-message--demo'));
  hud.dispose();
});

test('createHud: initialState "PLAYING" hides the message at mount', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus, initialState: 'PLAYING' });
  hud.mount(root);
  assert.equal(root.message.textContent, '');
  assert.ok(root.message.classList.contains('hud-message--hidden'));
  assert.ok(!root.message.classList.contains('hud-message--demo'));
  hud.dispose();
});

test('createHud: initialState "GAME_OVER" shows the gameover message at mount', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus, initialState: 'GAME_OVER' });
  hud.mount(root);
  assert.equal(root.message.textContent, 'GAME OVER — PRESS ANY KEY TO RESTART');
  assert.ok(root.message.classList.contains('hud-message--gameover'));
  hud.dispose();
});

test('createHud: without initialState, the message keeps the bare .hud-message class', () => {
  // Backward compat: callers that don't pass initialState get the
  // old behavior (no seed; the first state:changed event drives
  // the message class).
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  // The HTML default text is "PRESS ANY KEY TO START" (from
  // makeMockRoot), and the bare .hud-message class is still
  // present (no demo/gameover/hidden modifier).
  assert.equal(root.message.textContent, 'PRESS ANY KEY TO START');
  assert.ok(!root.message.classList.contains('hud-message--demo'));
  assert.ok(!root.message.classList.contains('hud-message--gameover'));
  assert.ok(!root.message.classList.contains('hud-message--hidden'));
  hud.dispose();
});

test('createHud: mount registers event listeners (verified by emit)', () => {
  // Behavioral test: emit each event and confirm the right side-effect
  // happens. This is more useful than inspecting internal bus state.
  // Note: v0.11.0 removed the `data-hud="lives"` slot — energy
  // replaced it as the player-resource display — and the lives:changed
  // event handler is now an intentional no-op (see src/ui/hud.js
  // comment). The handler is still subscribed for back-compat, but
  // produces no visible DOM update, so this test exercises the three
  // active events: score, state, game:over.
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);

  // score:changed → score element updated
  bus.emit('score:changed', { score: 99 });
  assert.equal(root.score.textContent, '000099');

  // state:changed → message element updated
  bus.emit('state:changed', { to: 'GAME_OVER' });
  assert.equal(root.message.textContent, 'GAME OVER — PRESS ANY KEY TO RESTART');

  // game:over → message element updated with final score
  bus.emit('game:over', { finalScore: 12340 });
  assert.equal(root.message.textContent, 'GAME OVER — FINAL SCORE: 012340 — PRESS ANY KEY');

  hud.dispose();
});

test('createHud: dispose unsubscribes event listeners (no more side-effects)', () => {
  // v0.11.x: same back-compat note as the previous test — the
  // lives:changed handler is an intentional no-op (energy replaced
  // lives), so we don't assert on lives text post-dispose.
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);

  // Pre-dispose: score handler fires
  bus.emit('score:changed', { score: 50 });
  assert.equal(root.score.textContent, '000050');

  hud.dispose();

  // Post-dispose: emit does NOT fire handlers — textContent stays at the
  // last value set, not updated by the new emit.
  bus.emit('score:changed', { score: 999 });
  assert.equal(root.score.textContent, '000050');
});

test('createHud: dispose is idempotent', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  hud.dispose();
  hud.dispose(); // no throw
  assert.ok(true);
});

test('createHud: handles missing elements gracefully (no throw)', () => {
  const bus = createEventBus();
  const root = makeMockRoot({ score: null, lives: null, message: null });
  const hud = createHud({ bus });
  hud.mount(root);
  // Emitting events with no elements should be a no-op (no throw).
  bus.emit('score:changed', { score: 100 });
  bus.emit('lives:changed', { lives: 1 });
  bus.emit('state:changed', { from: 'DEMO', to: 'PLAYING' });
  bus.emit('game:over', { finalScore: 50 });
  assert.ok(true);
  hud.dispose();
});

// ---- score:changed -----------------------------------------------------

test('score:changed → updates score element with padded number', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  // Use values that differ from the initial '000000' so we can tell
  // the handler fired.
  bus.emit('score:changed', { score: 50 });
  assert.equal(root.score.textContent, '000050');
  bus.emit('score:changed', { score: 12345 });
  assert.equal(root.score.textContent, '012345');
  bus.emit('score:changed', { score: 999999 });
  assert.equal(root.score.textContent, '999999');
  hud.dispose();
});

test('score:changed with negative or non-number → still safe', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('score:changed', { score: 50 }); // set to 000050
  bus.emit('score:changed', { score: -1 });
  assert.equal(root.score.textContent, '000000');
  bus.emit('score:changed', { score: 'NaN' });
  assert.equal(root.score.textContent, '000000');
  hud.dispose();
});

// ---- lives:changed -----------------------------------------------------

// v0.11.x: the dedicated `lives:changed → updates lives element` test
// was deleted. The lives DOM slot was removed in v0.11.0 and the
// `lives:changed` handler is an intentional no-op (energy replaced
// lives as the player-resource display). See src/ui/hud.js comment
// on `onLivesChanged`. The dedicated test would either regress to
// test removed DOM slots or assert on the no-op behavior, neither
// of which adds value. The back-compat handler subscription is
// still covered transitively by the event-listener test above.


// ---- state:changed → message -------------------------------------------

test('state:changed → DEMO shows pulsing demo message', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  // First switch to PLAYING so the initial 'PRESS ANY KEY TO START' gets
  // replaced (otherwise we can't tell whether state:changed→DEMO fired).
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.equal(root.message.textContent, '');
  // Now switch to DEMO.
  bus.emit('state:changed', { from: 'PLAYING', to: 'DEMO' });
  assert.equal(root.message.textContent, 'PRESS ANY KEY TO START');
  assert.ok(root.message.classList.contains('hud-message--demo'));
  assert.ok(!root.message.classList.contains('hud-message--gameover'));
  assert.ok(!root.message.classList.contains('hud-message--hidden'));
  hud.dispose();
});

test('state:changed → PLAYING hides the message', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  // Initial message is "PRESS ANY KEY TO START" (from HTML).
  bus.emit('state:changed', { from: 'DEMO', to: 'PLAYING' });
  assert.equal(root.message.textContent, '');
  assert.ok(root.message.classList.contains('hud-message--hidden'));
  hud.dispose();
});

test('state:changed → GAME_OVER shows red gameover message', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('state:changed', { to: 'PLAYING' }); // clear initial
  bus.emit('state:changed', { from: 'PLAYING', to: 'GAME_OVER' });
  assert.equal(root.message.textContent, 'GAME OVER — PRESS ANY KEY TO RESTART');
  assert.ok(root.message.classList.contains('hud-message--gameover'));
  assert.ok(!root.message.classList.contains('hud-message--demo'));
  hud.dispose();
});

test('state:changed DEMO → PLAYING → GAME_OVER cycle cleans up classes', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  // Start from a known state (PLAYING clears the initial message).
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.ok(root.message.classList.contains('hud-message--hidden'));

  // DEMO
  bus.emit('state:changed', { to: 'DEMO' });
  assert.ok(root.message.classList.contains('hud-message--demo'));
  assert.ok(!root.message.classList.contains('hud-message--hidden'));

  // PLAYING again
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.ok(!root.message.classList.contains('hud-message--demo'));
  assert.ok(!root.message.classList.contains('hud-message--gameover'));
  assert.ok(root.message.classList.contains('hud-message--hidden'));

  // GAME_OVER
  bus.emit('state:changed', { to: 'GAME_OVER' });
  assert.ok(root.message.classList.contains('hud-message--gameover'));
  assert.ok(!root.message.classList.contains('hud-message--hidden'));
  hud.dispose();
});

// ---- game:over ---------------------------------------------------------

test('game:over shows the final score in the message', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('state:changed', { to: 'PLAYING' }); // clear initial
  bus.emit('game:over', { finalScore: 12340 });
  assert.equal(root.message.textContent, 'GAME OVER — FINAL SCORE: 012340 — PRESS ANY KEY');
  assert.ok(root.message.classList.contains('hud-message--gameover'));
  hud.dispose();
});

// ---- Integration: full lifecycle ---------------------------------------

test('full lifecycle: mount → boot → play → die → restart', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);

  // Boot (initial values from HTML)
  assert.equal(root.score.textContent, '000000');
  assert.equal(root.lives.textContent, 'LIVES: 3');
  assert.equal(root.message.textContent, 'PRESS ANY KEY TO START');

  // Press any key → PLAYING
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.equal(root.message.textContent, '');

  // Hit an asteroid
  bus.emit('score:changed', { score: 20 });
  bus.emit('score:changed', { score: 70 });
  assert.equal(root.score.textContent, '000070');

  // Die → GAME_OVER
  bus.emit('game:over', { finalScore: 70 });
  assert.equal(root.message.textContent, 'GAME OVER — FINAL SCORE: 000070 — PRESS ANY KEY');

  // Press any key → restart (PLAYING). The lives:changed event is
  // dropped here (v0.11.x no-op back-compat handler — see src/ui/hud.js).
  bus.emit('score:changed', { score: 0 });
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.equal(root.score.textContent, '000000');
  assert.equal(root.message.textContent, '');

  hud.dispose();
});


// ===========================================================================
// v0.69.0 -- buff-card lifecycle (replaces the v0.11.x chip render)
// ===========================================================================
// The HUD has a `data-hud="buffs"` slot that hosts one DOM card per active
// buff type. Each card has an SVG icon (.hud__buff-card__icon), an uppercase
// label (.hud__buff-card__label), a draining progress bar (.hud__buff-card__bar
// with .hud__buff-card__bar-fill inside), and a tabular-nums timer
// (.hud__buff-card__timer). The bar fill is driven by a CSS custom property
// `--buff-progress` (0% to 100%); the JS sets it per-frame in `hud.update()`
// based on `remaining / max`. The mock root tracks appended children via the
// `_makeMockContainerEl` wrapper so these tests can inspect the DOM.

test('v0.69.0: buff:added adds a card with SVG icon + label + bar + timer', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  assert.equal(root.buffs.children.length, 0, 'no cards before any buff:added');
  bus.emit('buff:added', { type: 'shield', duration: 5 });
  assert.equal(root.buffs.children.length, 1, 'one card after buff:added');
  const card = root.buffs.children[0];
  assert.equal(card.className, 'hud__buff-card', 'card root has the buff-card class');
  assert.equal(card.dataset.buffType, 'shield', 'card has a data-buff-type attr');
  // --buff-color custom property is set per-type.
  // The mock DOM's style object exposes CSS custom properties via
  // getPropertyValue('--xxx'). The hud.js addBuffCard path does:
  //   card.style.setProperty('--buff-color', colorHex);
  // so the test reads the value via getPropertyValue (the standard
  // CSSOM API), not a private getter.
  assert.equal(typeof card.style.getPropertyValue('--buff-color'), 'string',
    'card.style --buff-color is accessible as a string');
  assert.ok(card.style.getPropertyValue('--buff-color').startsWith('#'),
    'card stores --buff-color as a hex string');
  // The card has 2 children: icon (div containing SVG) and body (with label/bar/timer).
  assert.ok(card.children.length >= 2, `card has at least 2 children, got ${card.children.length}`);
  // Find the icon child (has class hud__buff-card__icon) and the body.
  const iconChild = card.children.find((c) => c.className === 'hud__buff-card__icon');
  assert.ok(iconChild, 'card has an icon child');
  assert.ok(typeof iconChild.innerHTML === 'string' && iconChild.innerHTML.includes('<svg'),
    'icon child contains an inline svg');
  assert.ok(iconChild.innerHTML.includes('<path'),
    'icon svg contains a vector path');
  // Find the body child.
  const bodyChild = card.children.find((c) => c.className === 'hud__buff-card__body');
  assert.ok(bodyChild, 'card has a body child');
  // Inside body: label with the type's POWERUP_TYPE_VARIANTS.label ('SHIELD').
  const labelChild = bodyChild.children.find((c) => c.className === 'hud__buff-card__label');
  assert.ok(labelChild, 'body has a label child');
  assert.equal(labelChild.textContent, 'SHIELD', 'label shows the per-type uppercase label');
  // Bar wrap + bar fill.
  const barWrap = bodyChild.children.find((c) => c.className === 'hud__buff-card__bar');
  assert.ok(barWrap, 'body has a bar wrap');
  const barFill = barWrap.children.find((c) => c.className === 'hud__buff-card__bar-fill');
  assert.ok(barFill, 'bar wrap has a bar fill child');
  // Timer with `5.0s` (toFixed(1) format).
  const timerChild = bodyChild.children.find((c) => c.className === 'hud__buff-card__timer');
  assert.ok(timerChild, 'body has a timer child');
  assert.equal(timerChild.textContent, '5.0s', 'timer shows duration.toFixed(1)');
  hud.dispose();
});

test('v0.69.0: hud.update updates timer text AND bar --buff-progress per frame', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('buff:added', { type: 'shield', duration: 5 });
  // Simulate a per-frame poll from main.js with 2.5s remaining.
  hud.update({ buffs: [{ type: 'shield', remaining: 2.5 }] });
  const card = root.buffs.children[0];
  const body = card.children.find((c) => c.className === 'hud__buff-card__body');
  const timer = body.children.find((c) => c.className === 'hud__buff-card__timer');
  const barWrap = body.children.find((c) => c.className === 'hud__buff-card__bar');
  const barFill = barWrap.children.find((c) => c.className === 'hud__buff-card__bar-fill');
  assert.equal(timer.textContent, '2.5s', 'per-frame timer reflects remaining.toFixed(1)');
  // progress = 2.5/5 * 100 = 50.0%
  assert.equal(barFill.style.getPropertyValue('--buff-progress'), '50.0%',
    'per-frame bar fill reflects (remaining/max)*100 as a CSS variable');
  // Drain to 0%; bar reflects 0% but timer still shows formatted 0.
  hud.update({ buffs: [{ type: 'shield', remaining: 0 }] });
  assert.equal(timer.textContent, '0.0s', 'drained timer is 0.0s');
  assert.equal(barFill.style.getPropertyValue('--buff-progress'), '0.0%', 'drained bar fill is 0%');
  hud.dispose();
});

test('v0.69.0: buff:expired removes the matching card', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('buff:added', { type: 'shield', duration: 5 });
  bus.emit('buff:added', { type: 'speed', duration: 5 });
  assert.equal(root.buffs.children.length, 2);
  bus.emit('buff:expired', { type: 'shield', reason: 'natural' });
  // Two buff chips: 'tick' reason fades; other reasons snap-remove. We didn't set
  // reason='tick' so it's a snap-remove.
  assert.equal(root.buffs.children.length, 1, 'card removed after buff:expired (snap)');
  assert.equal(root.buffs.children[0].dataset.buffType, 'speed',
    'remaining card is the speed chip');
  hud.dispose();
});

test('v0.69.0: per-type buff card uses the variant color (mint shield, orange speed, etc.)', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('buff:added', { type: 'shield', duration: 5 });
  const card = root.buffs.children[0];
  // --buff-color is set via card.style.setProperty('--buff-color', colorHex).
  // Read back via the standard CSSOM API.
  const colorVar = card.style.getPropertyValue('--buff-color');
  assert.ok(typeof colorVar === 'string' && colorVar.startsWith('#'),
    `--buff-color is set as a hex string, got ${colorVar}`);
  // Pinned values from POWERUP_TYPE_VARIANTS in src/entities/powerup.js.
  // shield = 0x6effa8 → '#6effa8'.
  assert.equal(colorVar, '#6effa8', 'shield type uses the mint-green variant color');
  hud.dispose();
});

// ---- formatScore -------------------------------------------------------


test('formatScore: pads positive integers to 6 digits', () => {
  assert.equal(formatScore(0), '000000');
  assert.equal(formatScore(1), '000001');
  assert.equal(formatScore(50), '000050');
  assert.equal(formatScore(12345), '012345');
  assert.equal(formatScore(999999), '999999');
});

test('formatScore: handles large numbers > 999999 (no truncation, just unpadded)', () => {
  assert.equal(formatScore(1000000), '1000000');
  assert.equal(formatScore(12345678), '12345678');
});

test('formatScore: floors fractional numbers', () => {
  assert.equal(formatScore(1.9), '000001');
  assert.equal(formatScore(99.5), '000099');
});

test('formatScore: handles negative or non-number safely', () => {
  assert.equal(formatScore(-1), '000000');
  assert.equal(formatScore(NaN), '000000');
  assert.equal(formatScore(Infinity), '000000');
  assert.equal(formatScore('100'), '000000'); // strings are not numbers
  assert.equal(formatScore(null), '000000');
  assert.equal(formatScore(undefined), '000000');
});
