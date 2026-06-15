/**
 * Unit tests for src/systems/input.js.
 *
 * Pure-logic tests only — no DOM. We exercise:
 *   - createInputState: pressed-set tracking, rising-edge detection,
 *     re-press after release, isAnyJustPressed.
 *   - tickInput: movement (held-key model), fire rising edge, start in DEMO.
 *   - createInputSystem: factory shape, dispose is a no-op without a DOM target.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInputState,
  tickInput,
  createInputSystem,
} from '../src/systems/input.js';

// ---- createInputState ---------------------------------------------------

test('createInputState: starts with no keys pressed', () => {
  const s = createInputState();
  assert.equal(s.keys.size, 0);
  assert.equal(s.wasDown.size, 0);
  assert.equal(s.isJustPressed('Space'), false);
  assert.equal(s.isAnyJustPressed(), false);
});

test('createInputState: onKeyDown adds to the pressed set', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  assert.equal(s.isKeyDown('Space'), true);
  assert.equal(s.keys.has('Space'), true);
});

test('createInputState: onKeyUp removes from the pressed set', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  s.onKeyUp('Space');
  assert.equal(s.isKeyDown('Space'), false);
});

test('createInputState: isJustPressed is true on the first frame after a keydown', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  assert.equal(s.isJustPressed('Space'), true);
});

test('createInputState: isJustPressed is false on subsequent frames while held', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  s.endFrame();
  assert.equal(s.isJustPressed('Space'), false);
  s.endFrame();
  assert.equal(s.isJustPressed('Space'), false);
});

test('createInputState: rising edge fires again after release + re-press', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  s.endFrame();
  assert.equal(s.isJustPressed('Space'), false);

  s.onKeyUp('Space');
  s.endFrame();
  assert.equal(s.isJustPressed('Space'), false);

  s.onKeyDown('Space');
  assert.equal(s.isJustPressed('Space'), true);
});

test('createInputState: isAnyJustPressed is true if any new key is held', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  s.onKeyDown('KeyA');
  assert.equal(s.isAnyJustPressed(), true);
  s.endFrame();
  assert.equal(s.isAnyJustPressed(), false);
});

test('createInputState: endFrame is idempotent and does not throw on empty', () => {
  const s = createInputState();
  s.endFrame();
  s.endFrame();
  assert.equal(s.keys.size, 0);
  assert.equal(s.wasDown.size, 0);
});

// ---- tickInput — movement ----------------------------------------------

function makeShipRecorder() {
  const calls = { thrust: [], yaw: [] };
  return {
    ship: {
      setThrust: (on) => calls.thrust.push(on ? 1 : 0),
      setYaw: (dir) => calls.yaw.push(dir),
    },
    calls,
  };
}

test('tickInput: W/ArrowUp → thrust on, others → thrust off', () => {
  const rec = makeShipRecorder();
  const s = createInputState();

  s.onKeyDown('KeyW');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.thrust, [1]);

  // Tick after release so setThrust(0) is actually called (the ship
  // only learns about state changes on tick boundaries).
  s.onKeyUp('KeyW');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.thrust, [1, 0]);

  s.onKeyDown('ArrowUp');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.thrust, [1, 0, 1]);

  s.onKeyUp('ArrowUp');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.thrust, [1, 0, 1, 0]);
});

test('tickInput: A/ArrowLeft → +1 yaw, D/ArrowRight → -1 yaw, both → 0', () => {
  const rec = makeShipRecorder();
  const s = createInputState();

  s.onKeyDown('KeyA');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.yaw, [1]);

  // Tick after release so setYaw(0) is called.
  s.onKeyUp('KeyA');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.yaw, [1, 0]);

  s.onKeyDown('KeyD');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.yaw, [1, 0, -1]);

  s.onKeyUp('KeyD');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.yaw, [1, 0, -1, 0]);

  s.onKeyDown('ArrowLeft');
  s.onKeyDown('ArrowRight');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.yaw, [1, 0, -1, 0, 0]);
});

test('tickInput: no ship is a no-op for movement (no throw)', () => {
  const s = createInputState();
  s.onKeyDown('KeyW');
  s.onKeyDown('KeyA');
  // No ship — should not throw.
  tickInput(s, null);
  assert.ok(true);
});

test('tickInput: thrust and yaw compose (A + W → yaw 1, thrust 1)', () => {
  const rec = makeShipRecorder();
  const s = createInputState();
  s.onKeyDown('KeyW');
  s.onKeyDown('KeyA');
  tickInput(s, rec.ship);
  assert.deepEqual(rec.calls.thrust, [1]);
  assert.deepEqual(rec.calls.yaw, [1]);
});

// ---- tickInput — fire --------------------------------------------------

test('tickInput: onFire fires on Space rising edge only', () => {
  let fireCount = 0;
  const onFire = () => { fireCount++; };
  const s = createInputState();

  s.onKeyDown('Space');
  tickInput(s, null, { onFire });
  assert.equal(fireCount, 1);

  // Held — no additional fires
  tickInput(s, null, { onFire });
  assert.equal(fireCount, 1);

  // Release and re-press → second rising edge → second fire
  s.onKeyUp('Space');
  tickInput(s, null, { onFire });
  assert.equal(fireCount, 1);

  s.onKeyDown('Space');
  tickInput(s, null, { onFire });
  assert.equal(fireCount, 2);
});

test('tickInput: onFire is a no-op when no callback provided', () => {
  const s = createInputState();
  s.onKeyDown('Space');
  // Should not throw.
  tickInput(s, null, {});
  assert.ok(true);
});

// ---- tickInput — start (DEMO only) -------------------------------------

test('tickInput: onStart fires on any-key rising edge in DEMO', () => {
  let startCount = 0;
  const onStart = () => { startCount++; };
  const s = createInputState();

  s.onKeyDown('KeyA');
  tickInput(s, null, { onStart }, { state: 'DEMO' });
  assert.equal(startCount, 1);

  // Held — no extra fires
  tickInput(s, null, { onStart }, { state: 'DEMO' });
  assert.equal(startCount, 1);
});

test('tickInput: onStart does NOT fire in PLAYING (mashing a key mid-game is a no-op)', () => {
  let startCount = 0;
  const onStart = () => { startCount++; };
  const s = createInputState();

  s.onKeyDown('KeyA');
  tickInput(s, null, { onStart }, { state: 'PLAYING' });
  assert.equal(startCount, 0);

  // Re-press after release in PLAYING — still no fire.
  s.onKeyUp('KeyA');
  s.endFrame();
  s.onKeyDown('KeyA');
  tickInput(s, null, { onStart }, { state: 'PLAYING' });
  assert.equal(startCount, 0);
});

test('tickInput: onStart DOES fire in GAME_OVER (for restart)', () => {
  let startCount = 0;
  const onStart = () => { startCount++; };
  const s = createInputState();

  s.onKeyDown('KeyA');
  tickInput(s, null, { onStart }, { state: 'GAME_OVER' });
  assert.equal(startCount, 1);

  // Re-press after release in GAME_OVER — fires again (restart can be
  // triggered multiple times if user keeps mashing keys).
  s.onKeyUp('KeyA');
  s.endFrame();
  s.onKeyDown('Enter');
  tickInput(s, null, { onStart }, { state: 'GAME_OVER' });
  assert.equal(startCount, 2);
});

test('tickInput: onStart fires again after release + re-press in DEMO', () => {
  let startCount = 0;
  const onStart = () => { startCount++; };
  const s = createInputState();

  s.onKeyDown('KeyA');
  tickInput(s, null, { onStart }, { state: 'DEMO' });
  assert.equal(startCount, 1);

  s.onKeyUp('KeyA');
  tickInput(s, null, { onStart }, { state: 'DEMO' });
  assert.equal(startCount, 1);

  s.onKeyDown('Enter');
  tickInput(s, null, { onStart }, { state: 'DEMO' });
  assert.equal(startCount, 2);
});

test('tickInput: onStart is a no-op when no callback provided', () => {
  const s = createInputState();
  s.onKeyDown('KeyA');
  // Should not throw.
  tickInput(s, null, {}, { state: 'DEMO' });
  assert.ok(true);
});

// ---- createInputSystem -------------------------------------------------

test('createInputSystem: returns state, update, dispose', () => {
  const sys = createInputSystem({
    ship: { setThrust: () => {}, setYaw: () => {} },
    // No `target` → bindKeyboard is a no-op (Node test env, no window).
  });
  assert.ok(sys.state);
  assert.equal(typeof sys.update, 'function');
  assert.equal(typeof sys.dispose, 'function');
  sys.dispose(); // safe
});

test('createInputSystem: update wires keys into ship + fires callbacks', () => {
  const rec = makeShipRecorder();
  let fireCount = 0;
  let startCount = 0;

  const sys = createInputSystem({
    ship: rec.ship,
    onFire: () => { fireCount++; },
    onStart: () => { startCount++; },
    getGameState: () => ({ state: 'DEMO' }),
  });

  // Simulate W press + Space press
  sys.state.onKeyDown('KeyW');
  sys.state.onKeyDown('Space');
  sys.update();
  assert.deepEqual(rec.calls.thrust, [1]);
  assert.deepEqual(rec.calls.yaw, [0]);
  assert.equal(fireCount, 1);
  assert.equal(startCount, 1);

  // Re-call without new input — no rising edges
  sys.update();
  assert.deepEqual(rec.calls.thrust, [1, 1]);
  assert.equal(fireCount, 1);
  assert.equal(startCount, 1);
});
