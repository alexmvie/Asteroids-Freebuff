/**
 * Unit tests for src/systems/events.js.
 *
 * No DOM, no Three.js. Pure-logic tests for the pub/sub primitives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/systems/events.js';

// ---- Basic subscribe/emit -----------------------------------------------

test('event bus: emit with no listeners is a no-op (no throw)', () => {
  const bus = createEventBus();
  bus.emit('nothing-listening');
  bus.emit('still-nothing');
  assert.ok(true);
});

test('event bus: on + emit invokes the listener', () => {
  const bus = createEventBus();
  let count = 0;
  bus.on('test', () => count++);
  bus.emit('test');
  assert.equal(count, 1);
});

test('event bus: on + emit passes the data', () => {
  const bus = createEventBus();
  let received = null;
  bus.on('test', (d) => { received = d; });
  bus.emit('test', { x: 1, y: 2 });
  assert.deepEqual(received, { x: 1, y: 2 });
});

test('event bus: emit with no data passes undefined', () => {
  const bus = createEventBus();
  let received = 'sentinel';
  bus.on('test', (d) => { received = d; });
  bus.emit('test');
  assert.equal(received, undefined);
});

// ---- Multiple subscribers ----------------------------------------------

test('event bus: multiple subscribers to the same event', () => {
  const bus = createEventBus();
  let a = 0, b = 0;
  bus.on('test', () => a++);
  bus.on('test', () => b++);
  bus.emit('test');
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('event bus: subscribers invoked in subscription order', () => {
  const bus = createEventBus();
  const order = [];
  bus.on('test', () => order.push(1));
  bus.on('test', () => order.push(2));
  bus.on('test', () => order.push(3));
  bus.emit('test');
  assert.deepEqual(order, [1, 2, 3]);
});

test('event bus: events on different channels are isolated', () => {
  const bus = createEventBus();
  let a = 0, b = 0;
  bus.on('a', () => a++);
  bus.on('b', () => b++);
  bus.emit('a');
  assert.equal(a, 1);
  assert.equal(b, 0);
  bus.emit('b');
  assert.equal(a, 1);
  assert.equal(b, 1);
});

// ---- Unsubscribe --------------------------------------------------------

test('event bus: off removes a single subscriber', () => {
  const bus = createEventBus();
  let count = 0;
  const fn = () => count++;
  bus.on('test', fn);
  bus.off('test', fn);
  bus.emit('test');
  assert.equal(count, 0);
});

test('event bus: on returns an unsubscribe function', () => {
  const bus = createEventBus();
  let count = 0;
  const unsub = bus.on('test', () => count++);
  bus.emit('test');
  assert.equal(count, 1);
  unsub();
  bus.emit('test');
  assert.equal(count, 1);
});

test('event bus: off is a no-op if the listener was never subscribed', () => {
  const bus = createEventBus();
  const fn = () => {};
  bus.off('test', fn); // no throw
  assert.ok(true);
});

test('event bus: off is a no-op if the event was never emitted', () => {
  const bus = createEventBus();
  bus.off('nothing', () => {});
  assert.ok(true);
});

test('event bus: subscriber that unsubscribes itself during dispatch is not called on the next emit', () => {
  const bus = createEventBus();
  let calls = 0;
  let firstRun = true;
  const selfRemoving = () => {
    calls++;
    if (firstRun) {
      firstRun = false;
      bus.off('test', selfRemoving);
    }
  };
  bus.on('test', selfRemoving);
  bus.emit('test'); // first emit: called once, then self-removes
  assert.equal(calls, 1);
  bus.emit('test'); // second emit: no longer subscribed, no new call
  assert.equal(calls, 1);
});

test('event bus: subscriber that unsubscribes a sibling during dispatch does not break the rest of the dispatch', () => {
  // Sibling-removal is a common pattern: one listener reacts by unhooking
  // another. Because emit() iterates a snapshot, the rest of the dispatch
  // still runs.
  const bus = createEventBus();
  const order = [];
  const a = () => { order.push('a'); bus.off('test', b); };
  const b = () => { order.push('b'); };
  const c = () => { order.push('c'); };
  bus.on('test', a);
  bus.on('test', b);
  bus.on('test', c);
  bus.emit('test');
  // a ran first and removed b. The dispatch continues with the snapshot,
  // so b and c still run.
  assert.deepEqual(order, ['a', 'b', 'c']);
  // Next emit: b is gone for real.
  bus.emit('test');
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'c']);
});

// ---- clear --------------------------------------------------------------

test('event bus: clear removes all listeners on all events', () => {
  const bus = createEventBus();
  let count = 0;
  bus.on('a', () => count++);
  bus.on('b', () => count++);
  bus.on('c', () => count++);
  bus.clear();
  bus.emit('a');
  bus.emit('b');
  bus.emit('c');
  assert.equal(count, 0);
});

test('event bus: clear is safe to call on an empty bus', () => {
  const bus = createEventBus();
  bus.clear();
  assert.ok(true);
});

// ---- Multiple independent buses ----------------------------------------

test('event bus: two buses do not share subscribers', () => {
  const a = createEventBus();
  const b = createEventBus();
  let countA = 0, countB = 0;
  a.on('test', () => countA++);
  b.on('test', () => countB++);
  a.emit('test');
  assert.equal(countA, 1);
  assert.equal(countB, 0);
});

// ---- Argument validation -----------------------------------------------

test('event bus: on throws if eventName is not a string', () => {
  const bus = createEventBus();
  assert.throws(() => bus.on(42, () => {}), /eventName/);
  assert.throws(() => bus.on(null, () => {}), /eventName/);
  assert.throws(() => bus.on(undefined, () => {}), /eventName/);
});

test('event bus: on throws if fn is not a function', () => {
  const bus = createEventBus();
  assert.throws(() => bus.on('test', null), /fn/);
  assert.throws(() => bus.on('test', 42), /fn/);
  assert.throws(() => bus.on('test', 'oops'), /fn/);
});
