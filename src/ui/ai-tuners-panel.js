/**
 * AI Tuners Panel — runtime tunables for the demo AI.
 *
 * v0.46.x — Live browser-based tuning (no app reload, no 10-min
 * capture-and-compare loops).
 *
 * Architecture (modular factory, matches the project's existing
 * pattern in src/ui/hud.js, src/ui/debug-hud.js, src/ui/ai-debug-
 * overlay.js):
 *   • Pure helpers (exported for unit tests):
 *       - `formatTunable(key, value)`  — key-specific value formatter
 *       - `clampToTunableRange(key, value)` — defensive min/max clamp
 *   • Tuner specs (TUNER_SPECS) — min/max/step/format per AI_TUNABLES key
 *   • Tuner groups (TUNER_GROUPS) — UI ordering (Fire, Thrust, Evade, ...)
 *   • Composing factory: createAiTunersPanel(deps) → { mount, dispose,
 *     getValues, setValue, reset, exportSnapshot }
 *
 * Wire-up (in src/main.js): the panel's slider handlers write
 * directly to keys on `AI_TUNABLES` (mutable bag in
 * src/entities/ai-tunables.js). src/entities/ai.js reads those keys
 * every tick via `opts.X ?? AI_TUNABLES.X`, so a slider drag is
 * visible on the very next brain frame.
 *
 * Reset semantics: "RESET" calls `resetAITunables()` from
 * ai-tunables.js, which `Object.assign()`s the frozen defaults into
 * the live bag. No app reload — the AI immediately snaps back to
 * canonical behavior.
 *
 * Save semantics: "COPY JSON" writes the current values to the
 * clipboard via `navigator.clipboard.writeText` AND emits a
 * `console.log` of the same JSON. The JSON is formatted so the user
 * can paste it into a save file or send it via chat.
 *
 * Removal: delete this file + remove the `createAiTunersPanel` import
 * + the mount block + the HTML container. No other file is affected.
 *
 * Pure helpers exported for unit tests — none of these touch DOM, so
 * they can be exercised without jsdom.
 */

// ===========================================================================
// TUNER GROUPS — UI ordering
// ===========================================================================

/**
 * Each entry is `{ name, keys }` where `keys` lists AI_TUNABLES keys
 * for that group, in display order. Display-only — the panel does
 * not enforce semantic constraints at runtime (a powerup-radius
 * slider dragged to 10000u just makes the AI chase distant pickups).
 */
export const TUNER_GROUPS = Object.freeze([
  {
    name: 'Fire',
    keys: ['fireHeadingGate', 'fireMinDist', 'fireMaxDist', 'bulletSpeed'],
  },
  {
    name: 'Thrust',
    keys: ['thrustHeadingGate', 'yawDeadband'],
  },
  {
    name: 'Evade',
    keys: ['evadeDist'],
  },
  {
    name: 'Powerup',
    keys: [
      'powerupMaxChaseDist',
      'powerupThrustGate',
      'powerupStickyTime',
      'powerupCruiseSpeed',
      'powerupMinApproachSpeed',
      'powerupApproachGain',
      'powerupBrakeSafetyFactor',
      'powerupVelocityErrorThreshold',
      'powerupFinalApproachDist',
      'powerupFinalApproachSpeed',
    ],
  },
  {
    name: 'Target',
    keys: ['asteroidSizeBias', 'forwardConeHalfAngle', 'powerupNearBehindThreshold'],
  },
  {
    name: 'Laser',
    keys: ['laserFireHeadingGate'],
  },
]);

// ===========================================================================
// TUNER SPECS — min/max/step/format per AI_TUNABLES key
// ===========================================================================

/**
 * Per-tunable display metadata. `format` is a value → display-string
 * function so the panel can use domain-specific units (degrees vs.
 * radians, "u" for world units, "u/s" for speeds).
 *
 * Min/max ranges are intentionally wider than the python tuning
 * loop's discrete grid — the user wants smooth dragging, not a
 * stepped grid. Validated by `clampToTunableRange`.
 */
export const TUNER_SPECS = Object.freeze({
  // Fire ----------------------------------------------------------------
  fireHeadingGate: {
    label: 'FIRE HEADING',
    min: 0.05, max: 1.5, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Wide = loose aim. >0.5 rad = shots at any in-range target.',
  },
  fireMinDist: {
    label: 'FIRE MIN DIST',
    min: 0, max: 200, step: 1,
    format: (v) => `${Math.round(v)}u`,
    help: 'Closest distance to fire at. Avoid friendly-fire in collision range.',
  },
  fireMaxDist: {
    label: 'FIRE MAX DIST',
    min: 10, max: 500, step: 5,
    format: (v) => `${Math.round(v)}u`,
    help: 'Far-range cutoff. Beyond this, AI does not shoot.',
  },
  bulletSpeed: {
    label: 'BULLET SPEED',
    min: 50, max: 800, step: 25,
    format: (v) => `${Math.round(v)} u/s`,
    help: 'For lead prediction. Must mirror BULLET_SPEED in bullet.js.',
  },
  // Thrust --------------------------------------------------------------
  thrustHeadingGate: {
    label: 'THRUST HEADING',
    min: 0.05, max: 1.0, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Tight = stop-turn-thrust. Wide = thrust-while-turning (spirals).',
  },
  yawDeadband: {
    label: 'YAW DEADBAND',
    min: 0.0, max: 0.5, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Inside this band, no yaw command. Wide = wobble-free.',
  },
  // Evade ---------------------------------------------------------------
  evadeDist: {
    label: 'EVADE DIST',
    min: 2, max: 100, step: 1,
    format: (v) => `${Math.round(v)}u`,
    help: 'Below this distance from nearest asteroid → EVADE mode.',
  },
  // Powerup -------------------------------------------------------------
  powerupMaxChaseDist: {
    label: 'POWERUP MAX',
    min: 50, max: 500, step: 10,
    format: (v) => `${Math.round(v)}u`,
    help: 'Beyond this, AI ignores the pickup entirely.',
  },
  powerupThrustGate: {
    label: 'POWERUP THRUST',
    min: 0.02, max: 1.0, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Heading gate for thrust while chasing a powerup. Tight = clean approach.',
  },
  powerupStickyTime: {
    label: 'POWERUP STICKY',
    min: 0, max: 10, step: 0.1,
    format: (v) => `${v.toFixed(1)}s`,
    help: 'Once committed to a powerup, ignore better asteroids for this long.',
  },
  powerupCruiseSpeed: {
    label: 'PU CRUISE',
    min: 5, max: 200, step: 5,
    format: (v) => `${Math.round(v)} u/s`,
    help: 'Cap on speed while approaching a powerup.',
  },
  powerupMinApproachSpeed: {
    label: 'PU MIN APPROACH',
    min: 0, max: 50, step: 1,
    format: (v) => `${Math.round(v)} u/s`,
    help: 'Lower bound for required approach speed (used in horizon computation).',
  },
  powerupApproachGain: {
    label: 'PU APPROACH GAIN',
    min: 0.1, max: 2.0, step: 0.05,
    format: (v) => `${v.toFixed(2)} u·s/u`,
    help: 'Distance-to-speed scaling for the adaptive horizon.',
  },
  powerupBrakeSafetyFactor: {
    label: 'PU BRAKE SAFETY',
    min: 0.1, max: 1.0, step: 0.05,
    format: (v) => `${(v * 100).toFixed(0)}%`,
    help: 'Multiplier on theoretical max safe approach speed. <1 leaves a margin.',
  },
  powerupVelocityErrorThreshold: {
    label: 'PU VEL ERR',
    min: 0, max: 30, step: 0.5,
    format: (v) => `${v.toFixed(1)} u/s`,
    help: 'Below this velocity-error magnitude, AI coasts (no thrust pulses).',
  },
  powerupFinalApproachDist: {
    label: 'PU FINAL DIST',
    min: 1, max: 30, step: 1,
    format: (v) => `${Math.round(v)}u`,
    help: 'Inside this distance, controller switches to final-approach mode.',
  },
  powerupFinalApproachSpeed: {
    label: 'PU FINAL SPEED',
    min: 0, max: 20, step: 0.5,
    format: (v) => `${v.toFixed(1)} u/s`,
    help: 'Min closing speed during final approach (prevents stalling outside pickup radius).',
  },
  // Target --------------------------------------------------------------
  asteroidSizeBias: {
    label: 'SIZE BIAS',
    min: 0, max: 50, step: 1,
    format: (v) => `${Math.round(v)} u`,
    help: 'Effective distance = real_dist - (2 - size) * sizeBias. Big = prefer large.',
  },
  forwardConeHalfAngle: {
    label: 'TARGET CONE',
    min: 0.1, max: Math.PI, step: 0.05,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Half-angle of the forward cone used for target priority.',
  },
  powerupNearBehindThreshold: {
    label: 'NEAR-BEHIND',
    min: 0, max: 200, step: 5,
    format: (v) => `${Math.round(v)}u`,
    help: 'Powerups closer than this BEHIND the ship are still chased.',
  },
  // Laser ---------------------------------------------------------------
  laserFireHeadingGate: {
    label: 'LASER HEADING',
    min: 0.02, max: 1.0, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Laser cone half-angle. Tight = lock-on at center.',
  },
});

// ===========================================================================
// Pure helpers
// ===========================================================================

/**
 * Per-key value formatter. Returns the formatted display string, or
 * `${value}` if the key has no spec.
 *
 * @param {string} key
 * @param {number} value
 * @returns {string}
 */
export function formatTunable(key, value) {
  const spec = TUNER_SPECS[key];
  if (!spec || typeof spec.format !== 'function') return String(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return spec.format(value);
}

/**
 * Clamp a candidate value to the spec's [min, max] range. Uses the
 * spec default of [0, Infinity] for unknown keys (no clamp). Returns
 * `undefined` for non-numeric / non-finite inputs so callers can
 * drop bad slider writes before they hit the bag.
 *
 * @param {string} key
 * @param {number} value
 * @returns {number|undefined}
 */
export function clampToTunableRange(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const spec = TUNER_SPECS[key];
  if (!spec) return value;
  return Math.min(spec.max, Math.max(spec.min, value));
}

// ===========================================================================
// Factory
// ===========================================================================

/**
 * Build the AI Tuners Panel. Composites one sub-view per
 * TUNER_GROUPS entry (each is a <fieldset> with sliders). Exposes
 * { mount, dispose, getValues, setValue, reset, exportSnapshot } —
 * the public surface is wider than the existing UI overlays because
 * the camera + AI debug flow is observability-only; the tuner panel
 * needs programmatic setValue + reset + exportSnapshot for the
 * Save/Reset/COPY JSON buttons.
 *
 * @param {{
 *   tunables: object,                           // mutable bag (AI_TUNABLES)
 *   onChange?: (key: string, value: number) => void,   // optional per-slider hook
 *   defaults?: object,                          // optional frozen defaults override
 *   resetFn?: () => void,                       // optional reset impl
 *   exportFn?: () => object,                    // optional snapshot impl
 * }} deps
 */
export function createAiTunersPanel(deps = {}) {
  const {
    tunables,
    onChange,
    defaults,
    resetFn,
    exportFn,
  } = deps;
  if (!tunables || typeof tunables !== 'object') {
    throw new Error('createAiTunersPanel: `tunables` is required (mutable bag)');
  }

  let rootEl = null;
  let groupedFormEls = null;
  let groupContainers = null;

  function buildDom(rootElArg) {
    const sections = TUNER_GROUPS.map((group) => {
      const rows = group.keys.map((key) => {
        const spec = TUNER_SPECS[key];
        const label = (spec && spec.label) || key;
        const help = (spec && spec.help) || '';
        const current = tunables[key];
        const stepAttr = spec && typeof spec.step === 'number' ? spec.step : 0.01;
        const minAttr = spec && typeof spec.min === 'number' ? spec.min : 0;
        const maxAttr = spec && typeof spec.max === 'number' ? spec.max : 1000;
        return `
          <div class="ai-tuner__row" data-tuner-row="${key}">
            <label class="ai-tuner__label" for="ai-tuner-${key}">${label}</label>
            <input class="ai-tuner__slider" type="range"
                   id="ai-tuner-${key}"
                   data-tuner="${key}"
                   min="${minAttr}" max="${maxAttr}" step="${stepAttr}"
                   value="${current}"
                   aria-label="${label}" title="${help}">
            <span class="ai-tuner__value" data-tuner-value="${key}">${formatTunable(key, current)}</span>
          </div>
        `;
      }).join('');
      return `
        <fieldset class="ai-tuner__group" data-tuner-group="${group.name}">
          <legend class="ai-tuner__group-legend">${group.name}</legend>
          ${rows}
        </fieldset>
      `;
    }).join('');

    rootElArg.innerHTML = `
      <div class="ai-tuner__title">AI LIVE TUNERS</div>
      <div class="ai-tuner__actions">
        <button type="button" class="ai-tuner__btn" data-tuner-action="reset">RESET → DEFAULTS</button>
        <button type="button" class="ai-tuner__btn" data-tuner-action="copy">COPY JSON</button>
      </div>
      <div class="ai-tuner__groups">${sections}</div>
      <div class="ai-tuner__status" data-tuner-status></div>
    `;
    rootElArg.classList.add('ai-tuners--mounted');
  }

  function readElements() {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return null;
    const sliders = {};
    const valueCells = {};
    rootEl.querySelectorAll('[data-tuner]').forEach((el) => {
      sliders[el.dataset.tuner] = el;
    });
    rootEl.querySelectorAll('[data-tuner-value]').forEach((el) => {
      valueCells[el.dataset.tunerValue] = el;
    });
    const actionBtns = {};
    rootEl.querySelectorAll('[data-tuner-action]').forEach((el) => {
      actionBtns[el.dataset.tunerAction] = el;
    });
    return { sliders, valueCells, actionBtns };
  }

  function setValue(key, value) {
    const safe = clampToTunableRange(key, value);
    if (safe === undefined) return;
    tunables[key] = safe;
    if (groupedFormEls && groupedFormEls.sliders[key]) {
      groupedFormEls.sliders[key].value = String(safe);
    }
    if (groupedFormEls && groupedFormEls.valueCells[key]) {
      groupedFormEls.valueCells[key].textContent = formatTunable(key, safe);
    }
    if (typeof onChange === 'function') {
      try { onChange(key, safe); } catch { /* swallow — UI must not crash on hook error */ }
    }
  }

  function bindEvents() {
    if (!groupedFormEls) return;
    for (const key of Object.keys(groupedFormEls.sliders)) {
      const slider = groupedFormEls.sliders[key];
      if (!slider || typeof slider.addEventListener !== 'function') continue;
      slider.addEventListener('input', (ev) => {
        const raw = parseFloat(ev.target && ev.target.value);
        setValue(key, raw);
      });
    }
    if (groupedFormEls.actionBtns.reset) {
      groupedFormEls.actionBtns.reset.addEventListener('click', () => {
        if (typeof resetFn === 'function') {
          try {
            resetFn();
          } catch (e) {
            setStatus(`RESET failed: ${e && e.message ? e.message : e}`, true);
            return;
          }
        } else if (defaults) {
          // Fallback: copy defaults into the live bag directly.
          Object.assign(tunables, defaults);
        }
        // After a reset, refresh ALL sliders + value cells from the
        // live bag (in case the resetFn restored to values that
        // differ from the initial render).
        if (groupedFormEls) {
          for (const key of Object.keys(groupedFormEls.sliders)) {
            const v = tunables[key];
            if (typeof v === 'number' && Number.isFinite(v)) {
              groupedFormEls.sliders[key].value = String(v);
              groupedFormEls.valueCells[key].textContent = formatTunable(key, v);
            }
          }
        }
        setStatus('Reset to defaults', false);
      });
    }
    if (groupedFormEls.actionBtns.copy) {
      groupedFormEls.actionBtns.copy.addEventListener('click', () => {
        const snapshot = exportFn ? exportFn() : { ...tunables };
        const json = JSON.stringify(snapshot, null, 2);
        // 1. console.log first — clipboard write may fail in headless / non-HTTPS envs
        if (typeof console !== 'undefined') {
          // eslint-disable-next-line no-console
          console.log(`[ai-tuners] current AI_TUNABLES snapshot:\n${json}`);
        }
        // 2. try clipboard; if it fails, status bar carries the message
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          navigator.clipboard.writeText(json).then(
            () => setStatus('JSON copied to clipboard (and console)', false),
            (err) => setStatus(`Clipboard denied — JSON printed to console instead. (${err && err.message ? err.message : 'unknown error'})`, true),
          );
        } else {
          setStatus('Clipboard unavailable — JSON printed to console.', true);
        }
      });
    }
  }

  let statusTimer = null;
  function setStatus(msg, isError) {
    if (!rootEl) return;
    const el = rootEl.querySelector('[data-tuner-status]');
    if (!el) return;
    if (statusTimer != null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    el.textContent = msg;
    el.classList.toggle('ai-tuner__status--error', !!isError);
    statusTimer = setTimeout(() => {
      el.textContent = '';
      el.classList.remove('ai-tuner__status--error');
      statusTimer = null;
    }, 3500);
  }

  function mount(rootElArg) {
    if (!rootElArg) throw new Error('createAiTunersPanel.mount: rootEl is required');
    rootEl = rootElArg;
    buildDom(rootElArg);
    groupedFormEls = readElements();
    bindEvents();
  }

  function dispose() {
    if (statusTimer != null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    rootEl = null;
    groupedFormEls = null;
    groupContainers = null;
  }

  function getValues() {
    return { ...tunables };
  }

  function exportSnapshot() {
    return exportFn ? exportFn() : { ...tunables };
  }

  return { mount, dispose, getValues, setValue, reset: () => {
    if (typeof resetFn === 'function') resetFn();
    else if (defaults) Object.assign(tunables, defaults);
    // Sync the DOM to the post-reset values.
    if (groupedFormEls) {
      for (const key of Object.keys(groupedFormEls.sliders)) {
        const v = tunables[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          groupedFormEls.sliders[key].value = String(v);
          groupedFormEls.valueCells[key].textContent = formatTunable(key, v);
        }
      }
    }
  }, exportSnapshot };
}
