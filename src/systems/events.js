/**
 * Event bus — minimal synchronous pub/sub.
 *
 * Pure: no DOM, no Three.js, no global state. Each `createEventBus()` call
 * returns an independent bus. Subscribers are called in subscription order;
 * a subscriber that unsubscribes during a dispatch is not re-invoked (we
 * iterate a snapshot of the listener array).
 *
 * Convention for event names: `'namespace:verb'` (e.g. `'state:changed'`,
 * `'score:changed'`, `'ship:reset'`). Payloads are arbitrary; emit always
 * passes a single argument.
 *
 * Used by:
 *   - the game state machine (state:changed)
 *   - HUD layer (score:changed, lives:changed) — upcoming
 *   - particles/effects (explosion, ship:reset) — upcoming
 *
 * @returns {{
 *   on: (eventName: string, fn: (data: any) => void) => () => void,
 *   off: (eventName: string, fn: (data: any) => void) => void,
 *   emit: (eventName: string, data?: any) => void,
 *   clear: () => void,
 * }}
 */
export function createEventBus() {
  const listeners = new Map();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * Calling the returned function is equivalent to `bus.off(name, fn)`.
   * @param {string} eventName
   * @param {(data: any) => void} fn
   * @returns {() => void}
   */
  function on(eventName, fn) {
    if (typeof eventName !== 'string') throw new Error('createEventBus.on: eventName must be a string');
    if (typeof fn !== 'function') throw new Error('createEventBus.on: fn must be a function');
    if (!listeners.has(eventName)) listeners.set(eventName, []);
    listeners.get(eventName).push(fn);
    return () => off(eventName, fn);
  }

  /**
   * Unsubscribe a single listener. No-op if not subscribed.
   * @param {string} eventName
   * @param {(data: any) => void} fn
   */
  function off(eventName, fn) {
    const arr = listeners.get(eventName);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  /**
   * Dispatch an event. Synchronous. Listeners that were subscribed at the
   * start of the dispatch are invoked even if later subscribers were
   * removed during the call (we iterate a snapshot of the array).
   *
   * Each subscriber call is wrapped in try/catch so a single buggy
   * listener cannot prevent subsequent listeners from running. The
   * caught error is re-thrown synchronously after the dispatch loop
   * completes — callers (and the surrounding game loop) see the
   * failure, but no subscriber is silently starved.
   * @param {string} eventName
   * @param {any} [data]
   */
  function emit(eventName, data) {
    const arr = listeners.get(eventName);
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    let caught = null;
    for (const fn of snapshot) {
      try {
        fn(data);
      } catch (err) {
        if (!caught) caught = err;
      }
    }
    if (caught) throw caught;
  }

  /**
   * Remove all listeners. Useful for teardown.
   */
  function clear() {
    listeners.clear();
  }

  return { on, off, emit, clear };
}
