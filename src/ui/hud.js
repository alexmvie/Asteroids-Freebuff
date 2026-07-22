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
 *     <div data-hud="energy" class="hud__lives hud__energy">
 *       <span data-hud="energyLabel">ENERGY</span>
 *       <div class="hud__energy-bar"><div data-hud="energyBar"></div></div>
 *       <span data-hud="energyTimer">100/100</span>
 *     </div>
 *     <div data-hud="buffs" class="hud__buffs"></div>
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
// SSOT: per-type color tint comes from powerup.js's powerupColorFor —
// not duplicated here. The HUD's chip border + glow color is a direct
// read from the entity's variant registry, so any color tweak in
// POWERUP_TYPE_VARIANTS propagates to both the in-world powerup mesh
// AND the HUD chip atomically.
import { powerupColorFor, powerupLabelFor } from '../entities/powerup.js';

// ===========================================================================
// v0.69.0 -- vector icon paths for each buff type. Inline SVG with
// `currentColor` so the chip-card's --buff-color CSS variable flows
// through to the stroke/fill. Each path is hand-drawn to read at 22×22
// px — the chip-card's icon cell. The set covers all 6 POWERUP_TYPE
// variants plus a generic fallback for unknown types (so a future
// 7th type added to POWERUP_TYPE_VARIANTS renders something instead
// of nothing until a dedicated icon is registered).
//
// Adding a 7th type: append an entry here. The keys must match the
// lowercase type string used by addBuff(type, ...).
const BUFF_ICON_PATHS = Object.freeze({
  shield:  '<path d="M12 3 L4 7 V11 C4 16.5 8 19.5 12 21 C16 19.5 20 16.5 20 11 V7 Z" />',
  speed:    '<path d="M13 2 L4 14 H10 L11 22 L20 10 H14 Z" />',
  energy:   '<rect x="3" y="8" width="16" height="10" rx="1.5" /><rect x="20" y="11" width="2.4" height="4" rx="0.5" /><rect x="5.5" y="10" width="2.5" height="6" fill="currentColor" stroke="none" />',
  credits:  '<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" />',
  hull:     '<polygon points="12,3 21,8 21,16 12,21 3,16 3,8" />',
  weapon:   '<circle cx="12" cy="12" r="9" /><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />',
});

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

  // ---- v0.11.0 Energy + Buff chip rendering --------------------------

  // Active chip refs (type → { el, timerEl }). Removed on
  // buff:expired (or on dispose/cleanup).
  const buffChips = new Map();

  function renderEnergy({ value, max }) {
    const root = els.energy;
    if (!root) return;
    const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    root.classList.toggle('hud__energy--low', pct < 0.2);
    if (els.energyBar) {
      els.energyBar.style.setProperty('--energy-progress', `${(pct * 100).toFixed(1)}%`);
    }
    if (els.energyTimer) {
      els.energyTimer.textContent = `${Math.round(value)}/${Math.round(max)}`;
    }
  }

  function addBuffChip({ type, duration }) {
    // v0.69.0 — `addBuffChip` is now an alias for `addBuffCard`.
    // The internal `buffChips` Map stores `{ el, timerEl, barFillEl, max }`
    // so the per-frame update can drive both the text countdown AND the
    // progress bar fill. Kept the original entry-point name so existing
    // tests + the `bus.on('buff:added', addBuffChip)` wiring continue
    // to work without churn.
    addBuffCard({ type, duration });
  }

  // v0.69.0 — add a richer "card" DOM node for the buff. The card
  // has four children:
  //   - icon (SVG with the per-type path from BUFF_ICON_PATHS)
  //   - label (uppercase, e.g. "SHIELD")
  //   - bar (background + fill div, --buff-progress CSS variable)
  //   - timer (numeric seconds remaining, monospace tabular-nums)
  //
  // The bar starts at 100% (full duration). The per-frame update
  // path refreshes --buff-progress each tick based on
  // remaining/max, so the player sees the buff draining visually
  // without a separate animation timer.
  function addBuffCard({ type, duration }) {
    const root = els.buffs;
    if (!root || buffChips.has(type)) return;
    // SSOT: per-type color via powerupColorFor. If anyone changes a
    // color in POWERUP_TYPE_VARIANTS, both the in-world powerup mesh
    // and the HUD chip pick up the new color atomically.
    const color = powerupColorFor(type);
    const colorHex = `#${color.toString(16).padStart(6, '0')}`;
    const card = document.createElement('div');
    card.className = 'hud__buff-card';
    card.dataset.buffType = type;
    card.style.setProperty('--buff-color', colorHex);
    // Icon cell: SVG with currentColor for the stroke/fill.
    const iconWrap = document.createElement('div');
    iconWrap.className = 'hud__buff-card__icon';
    // v0.69.0: BUFF_ICON_PATHS stores raw SVG path data (e.g. `<path d="..."/>`),
// not full `<svg>...</svg>` markup. Wrap in a `<svg>` so:
//   - the DOM has a real <svg> child that the test mock can find via tagName, and
//   - the CSS selector `.hud__buff-card__icon svg` matches.
// viewBox 0 0 24 24 matches the BUFF_ICON_PATHS path data (icons are 24-unit grid).
const _pathData = BUFF_ICON_PATHS[type] || BUFF_ICON_PATHS.shield;
iconWrap.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_pathData}</svg>`;
    card.appendChild(iconWrap);
    // Body: label, bar, timer stacked vertically.
    const body = document.createElement('div');
    body.className = 'hud__buff-card__body';
    const label = document.createElement('span');
    label.className = 'hud__buff-card__label';
    label.textContent = powerupLabelFor(type);
    body.appendChild(label);
    const barWrap = document.createElement('div');
    barWrap.className = 'hud__buff-card__bar';
    const barFill = document.createElement('div');
    barFill.className = 'hud__buff-card__bar-fill';
    barFill.style.setProperty('--buff-progress', '100%');
    barWrap.appendChild(barFill);
    body.appendChild(barWrap);
    const timerEl = document.createElement('span');
    timerEl.className = 'hud__buff-card__timer';
    timerEl.textContent = `${duration.toFixed(1)}s`;
    body.appendChild(timerEl);
    card.appendChild(body);
    root.appendChild(card);
    buffChips.set(type, { el: card, timerEl, barFillEl: barFill, max: duration });
  }

  function removeBuffChip(type, reason) {
    const ref = buffChips.get(type);
    if (!ref) return;
    if (ref.el && ref.el.parentNode) {
      if (reason === 'tick') {
        // Smooth fade-out so the player sees it disappear, not snap-gone.
        ref.el.style.transition = 'opacity 0.18s ease-out, transform 0.18s ease-out';
        ref.el.style.opacity = '0';
        ref.el.style.transform = 'translateY(-4px)';
        setTimeout(() => ref.el.parentNode && ref.el.parentNode.removeChild(ref.el), 200);
      } else {
        ref.el.parentNode.removeChild(ref.el);
      }
    }
    buffChips.delete(type);
  }

  // Per-frame tick for buff chip countdowns; matches the ship's
  // per-frame tick. Without this the chip timers AND bar fill would
  // only update on addBuff — the displayed count would be stale after
  // the first frame. Render-loop driven (called via `hud.update`).
  function tickBuffChips() {
    for (const [, ref] of buffChips) {
      // The chip's displayed timer is updated by the GAME's
      // per-frame chip timer (not here, because we don't have the
      // live remaining value). The `update(state)` path below
      // overwrites this for any { buffs } passed in.
    }
  }

  // ---- Event handlers -------------------------------------------------

  function onScoreChanged({ score }) {
    setText('score', formatScore(score));
  }
  // Backward-compat: the v0.10.x `lives:changed` event is harmless to
  // keep handling (the DOM slot for `data-hud="lives"` was renamed to
  // `data-hud="energy"`; this handler still tries to find it, gives up,
  // and the energy bar is driven by `energy:changed` instead). The
  // no-op is intentional: lives are gone.
  function onLivesChanged() { /* v0.11.0: lives removed */ }
  function onEnergyChanged(payload) {
    renderEnergy(payload);
  }
  function onBuffAdded(payload) {
    addBuffChip({ type: payload.type, duration: payload.duration ?? 5 });
  }
  function onBuffExpired(payload) {
    removeBuffChip(payload.type, payload.reason ?? 'tick');
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
    els.energy = findEl('energy');
    els.energyLabel = findEl('energyLabel');
    els.energyBar = findEl('energyBar');
    els.energyTimer = findEl('energyTimer');
    els.buffs = findEl('buffs');
    els.message = findEl('message');
    els.powerup = findEl('powerup');
    els.powerupLabel = findEl('powerupLabel');
    els.powerupBar = findEl('powerupBar');
    els.powerupTimer = findEl('powerupTimer');

    unsubs.push(bus.on('score:changed', onScoreChanged));
    unsubs.push(bus.on('lives:changed', onLivesChanged)); // no-op backward compat
    unsubs.push(bus.on('energy:changed', onEnergyChanged));
    unsubs.push(bus.on('buff:added', onBuffAdded));
    unsubs.push(bus.on('buff:expired', onBuffExpired));
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
   * Per-frame update for the per-tick HUD state (power-up bar / timer
   * + buff chip countdown). Other HUD state (score, energy bar, repo
   * chip add/remove, message) is event-driven and handled by the
   * `unsubs` registered in `mount`.
   *
   * @param {{
   *   powerup?: {
   *     active: boolean,
   *     type?: string | null,
   *     remaining: number,
   *     max: number,
   *     hasPending?: boolean,
   *   },
   *   buffs?: Array<{ type: string, remaining: number }>,
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
    if (state.buffs) {
      // v0.69.0 -- per-frame countdown overlay + progress bar fill.
      // Update each chip's timer text AND its --buff-progress CSS
      // variable from the live remaining value. Chips that the ship
      // already expired (between this frame and the next emit) are
      // removed via buff:expired and not present here.
      for (const b of state.buffs) {
        const ref = buffChips.get(b.type);
        if (!ref) continue;
        if (ref.timerEl) ref.timerEl.textContent = `${b.remaining.toFixed(1)}s`;
        if (ref.barFillEl && Number.isFinite(ref.max) && ref.max > 0 && Number.isFinite(b.remaining)) {
          // remaining/max → percent. Clamp to [0, 100] for defensive math.
          const pct = Math.max(0, Math.min(100, (b.remaining / ref.max) * 100));
          ref.barFillEl.style.setProperty('--buff-progress', `${pct.toFixed(1)}%`);
        }
      }
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
