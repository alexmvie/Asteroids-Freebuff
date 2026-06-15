/**
 * HUD — head-up display overlay.
 *
 * Subscribes to the game event bus and updates DOM elements inside the
 * existing `#hud` (top bar) and `#overlay` (centered message) containers.
 *
 * Expected DOM (provided by index.html):
 *
 *   <div id="hud">
 *     <div data-hud="score">000000</div>
 *     <div data-hud="lives">LIVES: 3</div>
 *   </div>
 *   <div id="overlay">
 *     <div data-hud="message">…</div>
 *   </div>
 *
 * State-aware messaging:
 *   - DEMO       → pulsing accent-colored "PRESS ANY KEY TO START"
 *   - PLAYING    → message hidden
 *   - GAME_OVER  → red "GAME OVER — FINAL SCORE: N — PRESS ANY KEY"
 *
 * Public API:
 *   - `hud.mount(rootEl)`   bind to a root element (with the data-hud
 *                           children above) and start listening
 *   - `hud.dispose()`       unsubscribe from the bus, clear handlers
 *
 * Pure DOM — no Three.js, no framework. Testable by injecting a mock bus
 * + mock root element that implements the small surface we use
 * (querySelector, textContent, classList.add/remove).
 *
 * @param {{
 *   bus: { on: (name: string, fn: (data: any) => void) => () => void },
 *   initialState?: string,
 * }} [opts]
 */

// ===========================================================================
// HUD_MESSAGE_CONFIG
// ----------------------------------------------------------------------------
// Timing for the "PRESS ANY KEY TO START" flash animation (DEMO state).
//   - `flash.onMs`  ms the message is visible (opacity: 1)
//   - `flash.offMs` ms the message is hidden (opacity: 0)
// Total cycle: onMs + offMs. Default 500/500 = 1s cycle (1Hz blink — a
// classic arcade attract-screen cadence).
//
// Implemented with a recursive setTimeout (not setInterval) so:
//   1. The timer can be cleanly destroyed on state change / dispose.
//   2. Each tick is scheduled relative to the previous one (no drift).
// ===========================================================================
const HUD_MESSAGE_CONFIG = {
  flash: {
    onMs: 500,
    offMs: 500,
  },
};

export function createHud({ bus, initialState = null } = {}) {
  if (!bus) throw new Error('createHud: `bus` is required');

  let rootEl = null;
  const els = {}; // name → element
  const unsubs = [];
  // Flash animation state. `flashTimer` holds the active setTimeout
  // handle (or null when no flash is running). `flashOn` tracks the
  // current phase of the flash cycle (true = visible, false = hidden)
  // so `stopFlash` can leave the message in a known state.
  let flashTimer = null;
  let flashOn = false;

  // ---- Helpers ---------------------------------------------------------

  function findEl(name) {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return null;
    return rootEl.querySelector(`[data-hud="${name}"]`);
  }

  function setText(name, text) {
    const el = els[name];
    if (el && 'textContent' in el) el.textContent = text;
  }

  // ---- Power-up HUD (driven by hud.update() from the render loop) ----
  // The power-up HUD shows a label + draining bar + seconds-remaining
  // when a power-up is active. It's driven by per-frame `hud.update(...)`
  // calls from main.js (so the bar drains smoothly without event spam).
  // When no power-up is active, the HUD is hidden via
  // `.hud__powerup--inactive`.
  //
  // The bar's fill width is set via a CSS custom property
  // `--powerup-progress` (0% to 100%). The numeric timer is shown to
  // one decimal place (e.g. "12.3s"). When the bar hits ~20% we add
  // a `.hud__powerup--low` class for a subtle visual warning.
  function setPowerupState({ active, remaining, max }) {
    const root = els.powerup;
    if (!root) return;
    const fill = els.powerupBar;
    const timer = els.powerupTimer;
    if (!active) {
      root.classList.add('hud__powerup--inactive');
      root.classList.remove('hud__powerup--low');
      if (fill) fill.style.setProperty('--powerup-progress', '0%');
      if (timer) timer.textContent = '0.0s';
      return;
    }
    const pct = max > 0 ? Math.max(0, Math.min(1, remaining / max)) : 0;
    root.classList.remove('hud__powerup--inactive');
    root.classList.toggle('hud__powerup--low', pct < 0.2);
    if (fill) fill.style.setProperty('--powerup-progress', `${(pct * 100).toFixed(1)}%`);
    if (timer) timer.textContent = `${remaining.toFixed(1)}s`;
  }

  function setMessageState(kind) {
    const el = els.message;
    if (!el || !el.classList) return;
    el.classList.remove(
      'hud-message--demo',
      'hud-message--gameover',
      'hud-message--hidden',
      'hud-message--flash-off',
    );
    if (kind === 'demo') {
      el.classList.add('hud-message--demo');
      // Start the 1s-on / 2s-off flash. Idempotent: safe to call
      // multiple times (startFlash is a no-op if already running).
      startFlash();
    } else {
      // Leaving DEMO state — stop the flash so the message is
      // fully visible (the PLAYING / GAME_OVER states don't blink).
      stopFlash();
      if (kind === 'gameover') el.classList.add('hud-message--gameover');
      else if (kind === 'hidden') el.classList.add('hud-message--hidden');
    }
  }

  // ---- Flash animation (DEMO state) --------------------------------------
  // Drives the "PRESS ANY KEY TO START" message's 1s-on / 2s-off blink.
  // Visibility is toggled via the `hud-message--flash-off` CSS class
  // (opacity: 0). When the flash is stopped (leaving DEMO state or
  // disposing), the class is removed so the message shows normally.

  function startFlash() {
    if (flashTimer != null) return; // already running
    const tick = () => {
      flashOn = !flashOn;
      if (els.message && els.message.classList) {
        els.message.classList.toggle('hud-message--flash-off', !flashOn);
      }
      // Schedule the next tick: long delay when hidden, short when
      // visible (1s on, 2s off as per HUD_MESSAGE_CONFIG).
      flashTimer = setTimeout(
        tick,
        flashOn ? HUD_MESSAGE_CONFIG.flash.onMs : HUD_MESSAGE_CONFIG.flash.offMs,
      );
    };
    tick();
  }

  function stopFlash() {
    if (flashTimer != null) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
    flashOn = false;
    if (els.message && els.message.classList) {
      els.message.classList.remove('hud-message--flash-off');
    }
  }

  // ---- Event handlers -------------------------------------------------

  function onScoreChanged({ score }) {
    setText('score', formatScore(score));
  }
  function onLivesChanged({ lives }) {
    setText('lives', `LIVES: ${lives}`);
  }
  function onStateChanged({ to }) {
    if (to === 'DEMO') {
      setText('message', 'PRESS ANY KEY TO START');
      setMessageState('demo');
    } else if (to === 'PLAYING') {
      setText('message', '');
      setMessageState('hidden');
    } else if (to === 'GAME_OVER') {
      setText('message', 'GAME OVER — PRESS ANY KEY TO RESTART');
      setMessageState('gameover');
    }
  }
  function onGameOver({ finalScore }) {
    setText('message', `GAME OVER — FINAL SCORE: ${formatScore(finalScore)} — PRESS ANY KEY`);
    setMessageState('gameover');
  }

  // ---- Lifecycle -------------------------------------------------------

  function mount(rootElArg) {
    if (!rootElArg) throw new Error('createHud.mount: rootEl is required');
    rootEl = rootElArg;
    els.score = findEl('score');
    els.lives = findEl('lives');
    els.message = findEl('message');
    els.powerup = findEl('powerup');
    els.powerupLabel = findEl('powerupLabel');
    els.powerupBar = findEl('powerupBar');
    els.powerupTimer = findEl('powerupTimer');

    unsubs.push(bus.on('score:changed', onScoreChanged));
    unsubs.push(bus.on('lives:changed', onLivesChanged));
    unsubs.push(bus.on('state:changed', onStateChanged));
    unsubs.push(bus.on('game:over', onGameOver));

    // Seed the message visual state from the initial state. The state
    // machine doesn't fire a `state:changed` event for the state it's
    // already in at boot, so without this the message sits with just
    // the bare `.hud-message` class (centered, no flash) until the
    // first transition out and back. This applies the same classes
    // + flash that `onStateChanged` would.
    if (initialState != null) {
      onStateChanged({ from: null, to: initialState });
    }
  }

  /**
   * Per-frame update for the per-tick HUD state (currently just the
   * power-up bar / timer). Other HUD state (score, lives, message) is
   * event-driven and handled by the `unsubs` registered in `mount`.
   *
   * @param {{
   *   powerup?: {
   *     active: boolean,
   *     type?: string | null,
   *     remaining: number,
   *     max: number,
   *     hasPending?: boolean,
   *   },
   * }} [state]
   */
  function update(state = {}) {
    if (state.powerup) {
      setPowerupState({
        active: !!state.powerup.active,
        remaining: state.powerup.remaining || 0,
        max: state.powerup.max || 1,
      });
    }
  }

  function dispose() {
    // CRITICAL: stop the flash timer before tearing down the
    // element refs, otherwise the recursive setTimeout would
    // fire on a null `els.message` after dispose and leak.
    stopFlash();
    for (const u of unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    unsubs.length = 0;
    rootEl = null;
    for (const k of Object.keys(els)) delete els[k];
  }

  return { mount, dispose, update };
}

// ---- Pure formatting helpers (exported for tests + reuse) --------------

/** Pads a non-negative integer score to 6 digits with leading zeros. */
export function formatScore(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return '000000';
  }
  return String(Math.floor(n)).padStart(6, '0');
}
