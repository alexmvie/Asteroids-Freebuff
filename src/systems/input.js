/**
 * Input system — keyboard input for ship + game state.
 *
 * What it does:
 *   - Throttle (W / ArrowUp) and yaw (A/D, ArrowLeft/Right) on the ship.
 *   - "Fire" (Space) → `onFire` rising-edge callback.
 *   - "Start"      → `onStart` rising-edge callback, fired only in DEMO state
 *                    on any newly-pressed key.
 *
 * Architecture (testable; DOM wrap split out):
 *   - `createInputState()` — pure state. Tracks pressed keys, computes
 *     rising/falling edges, advances "last frame's pressed" each endFrame().
 *   - `bindKeyboard(state, opts?)` — thin DOM wrapper. Adds keydown/keyup
 *     listeners to `window` (or a passed target). Returns a `dispose`.
 *   - `tickInput(state, ship?, callbacks?, gameState?)` — pure per-frame
 *     application: pushes movement to the ship, fires callbacks on rising
 *     edges, ends the frame. No DOM, no Three.js — easy to unit test.
 *   - `createInputSystem(opts?)` — convenience: wires the three above into
 *     one `{ state, update, dispose }` object for `main.js`.
 *
 * The pure logic (`createInputState` + `tickInput`) is the part the unit
 * tests exercise. The DOM wrapper is one short function and is exercised
 * manually via the browser.
 */

// Keys that should not scroll the page when held.
const SCROLL_PREVENT_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

/**
 * Create a stateful input tracker. Captures pressed/released keys and
 * computes rising/falling edges for callbacks.
 *
 * Usage:
 *   const s = createInputState();
 *   s.onKeyDown('Space');
 *   s.isJustPressed('Space'); // → true (first frame)
 *   s.endFrame();
 *   s.isJustPressed('Space'); // → false (still held)
 *   s.onKeyUp('Space');
 *   s.endFrame();
 *   s.onKeyDown('Space');
 *   s.isJustPressed('Space'); // → true (rising edge after release)
 *
 * @returns {{
 *   keys: Set<string>,
 *   wasDown: Set<string>,
 *   onKeyDown: (code: string) => void,
 *   onKeyUp: (code: string) => void,
 *   isKeyDown: (code: string) => boolean,
 *   isJustPressed: (code: string) => boolean,
 *   isAnyJustPressed: () => boolean,
 *   endFrame: () => void,
 * }}
 */
export function createInputState() {
  const keys = new Set();
  const wasDown = new Set();

  function onKeyDown(code) {
    keys.add(code);
  }

  function onKeyUp(code) {
    keys.delete(code);
  }

  function isKeyDown(code) {
    return keys.has(code);
  }

  function isJustPressed(code) {
    return keys.has(code) && !wasDown.has(code);
  }

  function isAnyJustPressed() {
    for (const code of keys) {
      if (!wasDown.has(code)) return true;
    }
    return false;
  }

  function endFrame() {
    // Snapshot this frame's pressed set for next frame's rising-edge check.
    wasDown.clear();
    for (const code of keys) wasDown.add(code);
  }

  return {
    keys,
    wasDown,
    onKeyDown,
    onKeyUp,
    isKeyDown,
    isJustPressed,
    isAnyJustPressed,
    endFrame,
  };
}

/**
 * Bind keyboard events to an InputState. Returns a dispose function.
 *
 * No-op (dispose is a no-op) when no DOM `window` is available (e.g. in
 * Node-only test runs), so `createInputSystem` is safe to call in tests.
 *
 * @param {ReturnType<typeof createInputState>} state
 * @param {{ preventScroll?: boolean, target?: (Window & typeof globalThis) | null }} [opts]
 * @returns {() => void} dispose
 */
export function bindKeyboard(state, opts = {}) {
  const {
    preventScroll = true,
    target = typeof window !== 'undefined' ? window : null,
  } = opts;

  if (!target) return () => {};

  function handleDown(e) {
    if (preventScroll && SCROLL_PREVENT_KEYS.has(e.code)) {
      e.preventDefault();
    }
    state.onKeyDown(e.code);
  }

  function handleUp(e) {
    state.onKeyUp(e.code);
  }

  target.addEventListener('keydown', handleDown);
  target.addEventListener('keyup', handleUp);

  return () => {
    target.removeEventListener('keydown', handleDown);
    target.removeEventListener('keyup', handleUp);
  };
}

/**
 * Per-frame application of the input state to the ship + callbacks.
 *
 * Pure: takes everything by argument, no globals. Easy to unit test.
 *
 *   - Movement: held-key model. Thrust on W/ArrowUp. Yaw is (-1, 0, +1)
 *     driven by A/D and ArrowLeft/Right.
 *   - `onFire`: rising edge of Space.
 *   - `onStart`: rising edge of any key when `gameState.state === 'DEMO'`
 *                (start a new run) or `'GAME_OVER'` (restart after death).
 *                Ignored in `'PLAYING'` (mashing a key mid-game is a no-op).
 *
 * Always calls `state.endFrame()` last so the next frame's rising-edge
 * detection is correct.
 *
 * @param {ReturnType<typeof createInputState>} state
 * @param {{ setThrust: (boolean: boolean) => void, setYaw: (direction: number) => void } | null} [ship]
 * @param {{ onFire?: () => void, onStart?: () => void }} [callbacks]
 * @param {{ state: 'DEMO' | 'PLAYING' | 'GAME_OVER' }} [gameState]
 */
export function tickInput(state, ship = null, callbacks = {}, gameState = { state: 'PLAYING' }) {
  // ---- Movement (held-key model) ---------------------------------------
  if (ship) {
    const left =
      state.keys.has('ArrowLeft') || state.keys.has('KeyA') ? 1 : 0;
    const right =
      state.keys.has('ArrowRight') || state.keys.has('KeyD') ? 1 : 0;
    ship.setYaw(left - right);
    ship.setThrust(state.keys.has('ArrowUp') || state.keys.has('KeyW'));
  }

  // ---- Fire (Space rising edge) ---------------------------------------
  if (callbacks.onFire && state.isJustPressed('Space')) {
    callbacks.onFire();
  }

  // ---- Start (any-key rising edge in DEMO or GAME_OVER) ---------------
  // DEMO     → start a new run (DEMO → PLAYING)
  // GAME_OVER → restart after death (GAME_OVER → PLAYING)
  // PLAYING  → ignored (mashing a key mid-game should be a no-op)
  if (
    callbacks.onStart &&
    (gameState.state === 'DEMO' || gameState.state === 'GAME_OVER') &&
    state.isAnyJustPressed()
  ) {
    callbacks.onStart();
  }

  state.endFrame();
}

/**
 * Convenience factory — wires InputState + keyboard + tick into one
 * `{ state, update, dispose }` object suitable for `main.js`.
 *
 *   - `ship`           : the player ship (or null to skip movement wiring).
 *   - `onFire`         : rising-edge Space callback (will be wired to bullets
 *                        in a later step; log/console.log is fine for now).
 *   - `onStart`        : rising-edge any-key callback, only fired in DEMO.
 *   - `getGameState`   : returns the current game state. Defaults to PLAYING
 *                        so callbacks always fire; pass a real game-state
 *                        machine when the state machine lands.
 *
 * @param {{
 *   ship?: { setThrust: (boolean: boolean) => void, setYaw: (direction: number) => void } | null,
 *   onFire?: () => void,
 *   onStart?: () => void,
 *   getGameState?: () => { state: 'DEMO' | 'PLAYING' | 'GAME_OVER' },
 *   target?: (Window & typeof globalThis) | null,
 * }} [opts]
 * @returns {{
 *   state: ReturnType<typeof createInputState>,
 *   update: () => void,
 *   dispose: () => void,
 * }}
 */
export function createInputSystem(opts = {}) {
  const {
    ship = null,
    onFire = null,
    onStart = null,
    getGameState = () => ({ state: 'PLAYING' }),
    target = typeof window !== 'undefined' ? window : null,
  } = opts;

  const state = createInputState();
  const disposeKeyboard = bindKeyboard(state, { preventScroll: true, target });

  function update() {
    const gs = getGameState() || { state: 'PLAYING' };
    tickInput(state, ship, { onFire, onStart }, gs);
  }

  function dispose() {
    disposeKeyboard();
  }

  return { state, update, dispose };
}
