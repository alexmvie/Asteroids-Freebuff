/**
 * Game state machine — DEMO / PLAYING / GAME_OVER.
 *
 * MVP transition graph (allowed only):
 *
 *     DEMO ──(any key)──▶ PLAYING ──(player death)──▶ GAME_OVER
 *       ▲                                                 │
 *       └─────────────────(any key)───────────────────────┘
 *
 * Illegal transitions (e.g. DEMO → GAME_OVER) are rejected silently and
 * `canTransition` returns false. This keeps callers from accidentally
 * skipping states.
 *
 * The machine can be wired to an event bus to publish `state:changed`
 * events on every transition. Subscribers can also be added directly via
 * `subscribe(fn)`, which returns an unsubscribe function.
 *
 * `serialize` / `deserialize` are MVP stubs — they round-trip the current
 * state name through a plain object. They will be extended when a
 * save/load system lands.
 *
 * @module state
 */

import { State } from './state-types.js';

/**
 * Allowed-transitions table. Keys are current states; values are arrays
 * of states reachable in one step.
 */
const ALLOWED = Object.freeze({
  [State.DEMO]: [State.PLAYING],
  [State.PLAYING]: [State.GAME_OVER],
  [State.GAME_OVER]: [State.PLAYING],
});

/**
 * @typedef {{
 *   from: string,
 *   to: string,
 *   payload: any,
 * }} TransitionEvent
 */

/**
 * Create a game state machine.
 *
 * @param {{
 *   initial?: string,            // Default: State.DEMO
 *   events?: { emit: (name: string, data: any) => void } | null,
 * }} [opts]
 * @returns {{
 *   getState: () => string,
 *   canTransition: (to: string) => boolean,
 *   transition: (to: string, payload?: any) => boolean,
 *   subscribe: (fn: (e: TransitionEvent) => void) => () => void,
 *   serialize: () => { state: string },
 *   deserialize: (data: any) => boolean,
 * }}
 */
export function createStateMachine({ initial = State.DEMO, events = null } = {}) {
  if (!Object.values(State).includes(initial)) {
    throw new Error(`createStateMachine: invalid initial state "${initial}"`);
  }

  let current = initial;
  const subscribers = [];

  function getState() {
    return current;
  }

  function canTransition(to) {
    if (!Object.values(State).includes(to)) return false;
    return ALLOWED[current].includes(to);
  }

  /**
   * Attempt a transition. Returns true on success, false if disallowed.
   * On success, emits `state:changed` on the event bus (if provided) and
   * invokes all subscribers in subscription order.
   *
   * @param {string} to
   * @param {any} [payload]
   * @returns {boolean}
   */
  function transition(to, payload = null) {
    if (!canTransition(to)) return false;
    const from = current;
    current = to;
    const evt = { from, to, payload };
    if (events) events.emit('state:changed', evt);
    for (const fn of subscribers.slice()) fn(evt);
    return true;
  }

  /**
   * Subscribe to state transitions. Returns an unsubscribe function.
   * Idempotent: subscribing the same `fn` twice is a no-op (the subscriber
   * is not added a second time, so it won't fire twice on each transition).
   * @param {(e: TransitionEvent) => void} fn
   * @returns {() => void}
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('createStateMachine.subscribe: fn must be a function');
    if (subscribers.indexOf(fn) < 0) subscribers.push(fn);
    return () => {
      const idx = subscribers.indexOf(fn);
      if (idx >= 0) subscribers.splice(idx, 1);
    };
  }

  /**
   * Serialize the current state. MVP stub — only the state name.
   * @returns {{ state: string }}
   */
  function serialize() {
    return { state: current };
  }

  /**
   * Restore a previously-serialized state. Returns true on success, false
   * if the data is malformed. Does NOT emit `state:changed` — the caller
   * is expected to drive any side effects themselves. (This keeps load
   * deterministic and avoids spurious events during boot.)
   *
   * @param {any} data
   * @returns {boolean}
   */
  function deserialize(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Object.values(State).includes(data.state)) return false;
    current = data.state;
    return true;
  }

  return {
    getState,
    canTransition,
    transition,
    subscribe,
    serialize,
    deserialize,
  };
}

// Re-export State enum from a side file so consumers can import everything
// from a single module path.
export { State } from './state-types.js';
