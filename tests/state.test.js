/**
 * Unit tests for src/systems/state.js.
 *
 * No DOM, no Three.js. Pure-logic tests for the state machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStateMachine, State } from '../src/systems/state.js';
import { createEventBus } from '../src/systems/events.js';

// ---- Initial state ------------------------------------------------------

test('state machine: starts in DEMO by default', () => {
  const sm = createStateMachine();
  assert.equal(sm.getState(), State.DEMO);
});

test('state machine: starts in the provided initial state', () => {
  const sm = createStateMachine({ initial: State.PLAYING });
  assert.equal(sm.getState(), State.PLAYING);
  const sm2 = createStateMachine({ initial: State.GAME_OVER });
  assert.equal(sm2.getState(), State.GAME_OVER);
});

test('state machine: throws on invalid initial state', () => {
  assert.throws(() => createStateMachine({ initial: 'INVALID' }), /invalid initial/);
  assert.throws(() => createStateMachine({ initial: 'PAUSED' }), /invalid initial/);
});

// ---- canTransition ------------------------------------------------------

test('state machine: canTransition returns true for allowed next', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.canTransition(State.PLAYING), true);
});

test('state machine: canTransition returns false for disallowed next', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.canTransition(State.GAME_OVER), false);
  const sm2 = createStateMachine({ initial: State.PLAYING });
  assert.equal(sm2.canTransition(State.DEMO), false);
});

test('state machine: canTransition returns false for unknown state names', () => {
  const sm = createStateMachine();
  assert.equal(sm.canTransition('PAUSED'), false);
  assert.equal(sm.canTransition('FOO'), false);
  assert.equal(sm.canTransition(''), false);
});

test('state machine: canTransition is a pure read (does not change state)', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  sm.canTransition(State.PLAYING);
  sm.canTransition(State.GAME_OVER);
  assert.equal(sm.getState(), State.DEMO);
});

// ---- transition --------------------------------------------------------

test('state machine: transition succeeds for allowed', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.transition(State.PLAYING), true);
  assert.equal(sm.getState(), State.PLAYING);
});

test('state machine: transition fails (and does not change state) for disallowed', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.transition(State.GAME_OVER), false);
  assert.equal(sm.getState(), State.DEMO);
});

test('state machine: full cycle DEMO → PLAYING → GAME_OVER → PLAYING', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.transition(State.PLAYING), true);
  assert.equal(sm.transition(State.GAME_OVER), true);
  assert.equal(sm.transition(State.PLAYING), true); // restart
  assert.equal(sm.getState(), State.PLAYING);
});

test('state machine: transition passes through payload to subscribers', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let received = null;
  sm.subscribe((e) => { received = e; });
  sm.transition(State.PLAYING, { finalScore: 1234 });
  assert.deepEqual(received, { from: 'DEMO', to: 'PLAYING', payload: { finalScore: 1234 } });
});

test('state machine: transition payload defaults to null', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let received = 'sentinel';
  sm.subscribe((e) => { received = e; });
  sm.transition(State.PLAYING);
  assert.equal(received.payload, null);
});

// ---- subscribe / unsubscribe -------------------------------------------

test('state machine: subscribe is called on every transition', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  const events = [];
  sm.subscribe((e) => events.push(e));
  sm.transition(State.PLAYING);
  sm.transition(State.GAME_OVER);
  sm.transition(State.PLAYING);
  assert.equal(events.length, 3);
  assert.equal(events[0].from, 'DEMO');
  assert.equal(events[0].to, 'PLAYING');
  assert.equal(events[1].from, 'PLAYING');
  assert.equal(events[1].to, 'GAME_OVER');
  assert.equal(events[2].from, 'GAME_OVER');
  assert.equal(events[2].to, 'PLAYING');
});

test('state machine: subscribe is NOT called on failed transitions', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let count = 0;
  sm.subscribe(() => count++);
  sm.transition(State.GAME_OVER); // disallowed
  assert.equal(count, 0);
  assert.equal(sm.getState(), 'DEMO');
});

test('state machine: subscribe returns an unsubscribe function', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let count = 0;
  const unsub = sm.subscribe(() => count++);
  sm.transition(State.PLAYING);
  assert.equal(count, 1);
  unsub();
  sm.transition(State.GAME_OVER);
  assert.equal(count, 1);
});

test('state machine: multiple subscribers are all called', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let a = 0, b = 0;
  sm.subscribe(() => a++);
  sm.subscribe(() => b++);
  sm.transition(State.PLAYING);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('state machine: subscribing the same fn twice is idempotent (fires once per transition)', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  let count = 0;
  const fn = () => count++;
  sm.subscribe(fn);
  sm.subscribe(fn); // duplicate — should be ignored
  sm.subscribe(fn); // duplicate — should be ignored
  sm.transition(State.PLAYING);
  assert.equal(count, 1);
});

test('state machine: subscribe throws on non-function', () => {
  const sm = createStateMachine();
  assert.throws(() => sm.subscribe(null), /fn/);
  assert.throws(() => sm.subscribe(42), /fn/);
});

// ---- event bus integration ---------------------------------------------

test('state machine: emits state:changed on the event bus', () => {
  const bus = createEventBus();
  const received = [];
  bus.on('state:changed', (e) => received.push(e));
  const sm = createStateMachine({ initial: State.DEMO, events: bus });
  sm.transition(State.PLAYING);
  sm.transition(State.GAME_OVER);
  assert.equal(received.length, 2);
  assert.equal(received[0].from, 'DEMO');
  assert.equal(received[0].to, 'PLAYING');
  assert.equal(received[1].from, 'PLAYING');
  assert.equal(received[1].to, 'GAME_OVER');
});

test('state machine: does NOT emit state:changed on a failed transition', () => {
  const bus = createEventBus();
  let count = 0;
  bus.on('state:changed', () => count++);
  const sm = createStateMachine({ initial: State.DEMO, events: bus });
  sm.transition(State.GAME_OVER); // disallowed
  assert.equal(count, 0);
});

test('state machine: state:changed payload is included in the bus event', () => {
  const bus = createEventBus();
  let received = null;
  bus.on('state:changed', (e) => { received = e; });
  const sm = createStateMachine({ initial: State.DEMO, events: bus });
  sm.transition(State.PLAYING, { reason: 'user_start' });
  assert.equal(received.from, 'DEMO');
  assert.equal(received.to, 'PLAYING');
  assert.deepEqual(received.payload, { reason: 'user_start' });
});

// ---- serialize / deserialize --------------------------------------------

test('state machine: serialize returns the current state', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.deepEqual(sm.serialize(), { state: 'DEMO' });
  sm.transition(State.PLAYING);
  assert.deepEqual(sm.serialize(), { state: 'PLAYING' });
});

test('state machine: deserialize restores a state', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  const ok = sm.deserialize({ state: 'GAME_OVER' });
  assert.equal(ok, true);
  assert.equal(sm.getState(), 'GAME_OVER');
});

test('state machine: deserialize rejects malformed data', () => {
  const sm = createStateMachine({ initial: State.DEMO });
  assert.equal(sm.deserialize(null), false);
  assert.equal(sm.deserialize(undefined), false);
  assert.equal(sm.deserialize(42), false);
  assert.equal(sm.deserialize('PLAYING'), false);
  assert.equal(sm.deserialize({}), false);
  assert.equal(sm.deserialize({ state: 'INVALID' }), false);
  assert.equal(sm.deserialize({ state: null }), false);
  // State unchanged after all failures
  assert.equal(sm.getState(), 'DEMO');
});

test('state machine: deserialize does NOT emit state:changed', () => {
  const bus = createEventBus();
  let count = 0;
  bus.on('state:changed', () => count++);
  const sm = createStateMachine({ initial: State.DEMO, events: bus });
  sm.deserialize({ state: 'GAME_OVER' });
  assert.equal(count, 0);
});

test('state machine: serialize + deserialize round-trips', () => {
  const sm = createStateMachine({ initial: State.PLAYING });
  const data = sm.serialize();
  const sm2 = createStateMachine({ initial: State.GAME_OVER });
  assert.equal(sm2.deserialize(data), true);
  assert.equal(sm2.getState(), sm.getState());
});

// ---- State enum --------------------------------------------------------

test('State: frozen and has exactly DEMO, PLAYING, GAME_OVER', () => {
  assert.ok(Object.isFrozen(State));
  assert.deepEqual(
    Object.keys(State).sort(),
    ['DEMO', 'GAME_OVER', 'PLAYING'],
  );
  assert.equal(State.DEMO, 'DEMO');
  assert.equal(State.PLAYING, 'PLAYING');
  assert.equal(State.GAME_OVER, 'GAME_OVER');
});
