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

// ---- Mock DOM -----------------------------------------------------------

function makeMockEl({ text = '', classes = [] } = {}) {
  const classesSet = new Set(classes);
  return {
    textContent: text,
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
  // Default: all 3 elements exist. Pass `null` to simulate a missing one.
  const score = overrides.score !== null ? makeMockEl({ text: '000000' }) : null;
  const lives = overrides.lives !== null ? makeMockEl({ text: 'LIVES: 3' }) : null;
  const message = overrides.message !== null ? makeMockEl({ text: 'PRESS ANY KEY TO START' }) : null;

  const map = new Map();
  if (score) map.set('[data-hud="score"]', score);
  if (lives) map.set('[data-hud="lives"]', lives);
  if (message) map.set('[data-hud="message"]', message);

  return {
    querySelector(sel) {
      return map.has(sel) ? map.get(sel) : null;
    },
    score,
    lives,
    message,
  };
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

test('createHud: mount registers all 4 event listeners (verified by emit)', () => {
  // Behavioral test: emit each event and confirm the right side-effect
  // happens. This is more useful than inspecting internal bus state.
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);

  // score:changed → score element updated
  bus.emit('score:changed', { score: 99 });
  assert.equal(root.score.textContent, '000099');

  // lives:changed → lives element updated
  bus.emit('lives:changed', { lives: 1 });
  assert.equal(root.lives.textContent, 'LIVES: 1');

  // state:changed → message element updated
  bus.emit('state:changed', { to: 'GAME_OVER' });
  assert.equal(root.message.textContent, 'GAME OVER — PRESS ANY KEY TO RESTART');

  // game:over → message element updated with final score
  bus.emit('game:over', { finalScore: 12340 });
  assert.equal(root.message.textContent, 'GAME OVER — FINAL SCORE: 012340 — PRESS ANY KEY');

  hud.dispose();
});

test('createHud: dispose unsubscribes from all 4 events (no more side-effects)', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);

  // Pre-dispose: emit fires handlers
  bus.emit('score:changed', { score: 50 });
  assert.equal(root.score.textContent, '000050');
  bus.emit('lives:changed', { lives: 1 });
  assert.equal(root.lives.textContent, 'LIVES: 1');

  hud.dispose();

  // Post-dispose: emit does NOT fire handlers — textContent stays at the
  // last value set, not updated by the new emit.
  bus.emit('score:changed', { score: 999 });
  assert.equal(root.score.textContent, '000050');
  bus.emit('lives:changed', { lives: 0 });
  assert.equal(root.lives.textContent, 'LIVES: 1');
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

test('lives:changed → updates lives element with "LIVES: N"', () => {
  const bus = createEventBus();
  const root = makeMockRoot();
  const hud = createHud({ bus });
  hud.mount(root);
  bus.emit('lives:changed', { lives: 1 });
  assert.equal(root.lives.textContent, 'LIVES: 1');
  bus.emit('lives:changed', { lives: 0 });
  assert.equal(root.lives.textContent, 'LIVES: 0');
  hud.dispose();
});

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
  bus.emit('lives:changed', { lives: 2 });
  assert.equal(root.score.textContent, '000070');
  assert.equal(root.lives.textContent, 'LIVES: 2');

  // Die → GAME_OVER
  bus.emit('game:over', { finalScore: 70 });
  assert.equal(root.message.textContent, 'GAME OVER — FINAL SCORE: 000070 — PRESS ANY KEY');

  // Press any key → restart (PLAYING)
  bus.emit('score:changed', { score: 0 });
  bus.emit('lives:changed', { lives: 3 });
  bus.emit('state:changed', { to: 'PLAYING' });
  assert.equal(root.score.textContent, '000000');
  assert.equal(root.lives.textContent, 'LIVES: 3');
  assert.equal(root.message.textContent, '');

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
