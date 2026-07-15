/**
 * AI Tuners Panel — runtime tunables for the demo AI.
 *
 * v0.46.x — Live browser-based tuning (no app reload, no 10-min
 *           capture-and-compare loops).
 * v0.48.0   — Inline SVG visual guides per slider + master flag
 *           (see src/main.js `AI_TUNING_ENABLED`). Each of the 21
 *           tunables gets a 56×36 SVG that morphs live on slider
 *           drag: cones expand/shrink for angular gates, circles
 *           grow/shrink for radii, speedometer needles swing for
 *           speeds, bars fill for scalars, clock hands rotate for
 *           timers. The guideType per spec is the pattern picker.
 *
 * Architecture (modular factory, matches the project's existing
 * pattern in src/ui/hud.js, src/ui/debug-hud.js, src/ui/ai-debug-
 * overlay.js):
 *   • Pure helpers (exported for unit tests):
 *       - `formatTunable(key, value)`  — key-specific value formatter
 *       - `clampToTunableRange(key, value)` — defensive min/max clamp
 *       - `renderGuide(pattern, value, min, max)` — inline-SVG string
 *   • Tuner specs (TUNER_SPECS) — min/max/step/format/guideType per
 *     AI_TUNABLES key. `guideType` picks one of 'cone' | 'circle' |
 *     'speedometer' | 'bar' | 'clock' (defensive: unknown = empty).
 *   • Tuner groups (TUNER_GROUPS) — UI ordering (Fire, Thrust, Evade,
 *     Powerup, Target, Laser).
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
 * canonical behavior. After a reset, all slider values + value
 * cells + guide SVGs are re-rendered from the live bag.
 *
 * Save semantics: "COPY JSON" writes the current values to the
 * clipboard via `navigator.clipboard.writeText` AND emits a
 * `console.log` of the same JSON. The JSON is formatted so the user
 * can paste it into a save file or send it via chat.
 *
 * Removal: delete this file + remove the `createAiTunersPanel` import
 * + the mount block + the HTML container + the
 * AI_TUNING_ENABLED gate in main.js. No other file is affected.
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
/**
 * Display-ordering groups. Every key MUST be present in
 * `AI_TUNABLE_DEFAULTS` (src/entities/ai-tunables.js). The
 * `tests/ai-tuners-panel.test.js` regression guard asserts this
 * invariant -- drift between the panel and the bag produces
 * "undefined" slider values in the browser, which is what
 * motivated v0.58.0.
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
  // v0.56.0: pirate aggression distance. 0 = pacifist (the demo AI
  // default), 300 = aggressive (pirates chase + shoot ships). Tied
  // to the AI Live Tuners surface so the user can dial aggression
  // without code edits.
  {
    name: 'Aggro',
    keys: ['aggroDist'],
  },
  {
    name: 'Powerup',
    keys: ['powerupMaxChaseDist'],
  },
  {
    name: 'Ship',
    keys: ['shipMaxSpeed'],
  },
]);

// ===========================================================================
// TUNER SPECS — min/max/step/format/guideType per AI_TUNABLES key
// ===========================================================================

/**
 * Per-tunable display metadata. `format` is a value → display-string
 * function so the panel can use domain-specific units (degrees vs.
 * radians, "u" for world units, "u/s" for speeds).
 *
 * Min/max ranges are intentionally wider than the python tuning
 * loop's discrete grid — the user wants smooth dragging, not a
 * stepped grid. Validated by `clampToTunableRange`.
 *
 * `guideType` is the visual-guide pattern (v0.48.0):
 *   • 'cone'        — angular gate, value in radians (half-angle)
 *   • 'circle'      — radius, value in world units
 *   • 'speedometer' — speed, value in u/s (or any monotonic scalar)
 *   • 'bar'         — scalar slider [min, max]
 *   • 'clock'       — seconds (or any cyclic / time-like scalar)
 *   • undefined / unknown → no guide rendered
 *
 * The pattern is purely cosmetic; it just makes the value visible
 * in a form that matches its semantic meaning. The pattern picker
 * lives here (not in `renderGuide`) so a single source of truth
 * decides which guide goes with which key.
 */
export const TUNER_SPECS = Object.freeze({
  // Fire ----------------------------------------------------------------
  fireHeadingGate: {
    label: 'FIRE HEADING',
    min: 0.05, max: 1.5, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Wide = loose aim. >0.5 rad = shots at any in-range target.',
    guideType: 'cone',
  },
  fireMinDist: {
    label: 'FIRE MIN DIST',
    min: 0, max: 200, step: 1,
    format: (v) => `${Math.round(v)}u`,
    help: 'Closest distance to fire at. Avoid friendly-fire in collision range.',
    guideType: 'bar',
  },
  fireMaxDist: {
    label: 'FIRE MAX DIST',
    min: 10, max: 500, step: 5,
    format: (v) => `${Math.round(v)}u`,
    help: 'Far-range cutoff. Beyond this, AI does not shoot.',
    guideType: 'bar',
  },
  bulletSpeed: {
    label: 'BULLET SPEED',
    min: 50, max: 800, step: 25,
    format: (v) => `${Math.round(v)} u/s`,
    help: 'For lead prediction. Must mirror BULLET_SPEED in bullet.js.',
    guideType: 'speedometer',
  },
  // Thrust --------------------------------------------------------------
  thrustHeadingGate: {
    label: 'THRUST HEADING',
    min: 0.05, max: 1.0, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Tight = stop-turn-thrust. Wide = thrust-while-turning (spirals).',
    guideType: 'cone',
  },
  yawDeadband: {
    label: 'YAW DEADBAND',
    min: 0.0, max: 0.5, step: 0.01,
    format: (v) => `${(v * 180 / Math.PI).toFixed(0)}°`,
    help: 'Inside this band, no yaw command. Wide = wobble-free.',
    guideType: 'cone',
  },
  // Evade ---------------------------------------------------------------
  evadeDist: {
    label: 'EVADE DIST',
    min: 2, max: 100, step: 1,
    format: (v) => `${Math.round(v)}u`,
    help: 'Below this distance from nearest asteroid → EVADE mode.',
    guideType: 'circle',
  },
  // Ship feel (v0.49.0) ------------------------------------------------
  // Ship max-speed is owned by ship.js (which reads `AI_TUNABLES.shipMaxSpeed`
  // per tick), but the panel hosts the slider so the user can feel the
  // change in real time. Defensive: ship.js falls back to the frozen
  // `MAX_SPEED` constant if the bag is missing/invalid.
  shipMaxSpeed: {
    label: 'SHIP MAX SPEED',
    min: 50, max: 400, step: 10,
    format: (v) => `${Math.round(v)} u/s`,
    help: 'Top speed (XZ plane). Drag down to feel the ship slow down.',
    guideType: 'speedometer',
  },
  // Powerup -------------------------------------------------------------
  powerupMaxChaseDist: {
    label: 'POWERUP MAX',
    min: 50, max: 500, step: 10,
    format: (v) => `${Math.round(v)}u`,
    help: 'Beyond this, AI ignores the pickup entirely.',
    guideType: 'circle',
  },
  // v0.56.0: pirate aggression distance.
  aggroDist: {
    label: 'PIRATE AGGRO',
    min: 0, max: 500, step: 25,
    format: (v) => `${Math.round(v)}u`,
    help: 'Nearest ship within this distance triggers the pirate behavior. 0 = pacifist (demo AI). 300+ = aggressive.',
    guideType: 'circle',
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
// Visual guides — pure SVG-string renderer (v0.48.0)
// ===========================================================================
//
// Each row in the panel gets a 56×36 SVG that morphs live as the
// slider drags. The SVG string is constructed on every value change
// and re-injected into the row's `[data-tuner-guide]` container.
// Strings (not DOM nodes) so the helper has zero DOM dependency and
// tests don't need jsdom.
//
// The five patterns were chosen so EVERY one of the 21 tunables
// maps cleanly to a semantically appropriate shape:
//
//   • 'cone'        — angular gate (radians, half-angle). Used for
//                     fire / thrust / target / laser cone half-
//                     angles + yaw deadband. Shows a wedge whose
//                     spread grows with `value`.
//   • 'circle'      — radius (world units). Used for evade distance
//                     + powerup chase / final approach distances.
//                     Shows a growing centered disc inside a
//                     dashed max-radius ring.
//   • 'speedometer' — speed (u/s, or any monotonic scalar). Used
//                     for bullet speed + the three powerup approach
//                     speeds. Shows a half-arc dial with a needle
//                     rotated proportional to the slider position.
//   • 'bar'         — generic scalar slider. Used for the 6 unitless
//                     sliders + FIRE min/max (which sit inside
//                     their own context). Shows a horizontal fill
//                     bar.
//   • 'clock'       — seconds / time-like cyclic value. Used for
//                     powerup sticky time. Shows a clock face with
//                     a hand rotated full-circle as the value
//                     increases from 0 → max.
//
// All five share the same 100-unit viewBox so the panel's CSS can
// size them uniformly with `.ai-tuner__svg { width: 100%; height:
// 100%; }`. Theme colors come from `.ai-tuner__svg-bg` and
// `.ai-tuner__svg-fg` rules in styles.css.

const GUIDE_EMPTY_SVG =
  '<svg class="ai-tuner__svg" viewBox="0 0 100 36" ' +
  'xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>';

/**
 * Render the inline-SVG string for one slider row. Returns an
 * empty-string SVG (a placeholder of the same dimensions, so the
 * panel layout stays stable) when no guide applies. NaN / non-finite
 * values are coerced to `min` so the user always sees a coherent
 * shape — never a broken SVG.
 *
 * Pure function — DOM-free, safe for unit tests without jsdom.
 *
 * @param {string|undefined|null} pattern — one of the five guide
 *   types. Unknown → empty placeholder.
 * @param {number} value — current slider value (clamped internally)
 * @param {number} min — spec min
 * @param {number} max — spec max
 * @returns {string} SVG markup suitable for `innerHTML`
 */
export function renderGuide(pattern, value, min, max) {
  // Compute a safe t with all defenses layered. Any single bad
  // input produces a meaningful number, never throws.
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = (() => {
    if (!Number.isFinite(max)) return safeMin + 1;
    return Math.max(safeMin + 1e-9, max);
  })();
  const rawT = (Number.isFinite(value) ? value : safeMin) - safeMin;
  const range = safeMax - safeMin;
  const t = Math.min(1, Math.max(0, range > 0 ? rawT / range : 0));

  switch (pattern) {
    case 'cone':
      return coneGuide(t, safeMin, safeMax);
    case 'circle':
      return circleGuide(t);
    case 'speedometer':
      return speedometerGuide(t);
    case 'bar':
      return barGuide(t);
    case 'clock':
      return clockGuide(t);
    default:
      // Unknown pattern → empty placeholder so layout doesn't jump.
      return GUIDE_EMPTY_SVG;
  }
}

/**
 * Cone guide: a wedge whose half-spread is proportional to the
 * slider value. Centered axis points "forward" (up in the viewBox).
 * Background wedge shows the max-spread; foreground wedge morphs.
 */
function coneGuide(t) {
  const W = 100, H = 36;
  const cx = W / 2;
  const spread = Math.round(45 * t); // 0..45 px half-spread
  return (
    `<svg class="ai-tuner__svg ai-tuner__svg--cone" viewBox="0 0 ${W} ${H}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path class="ai-tuner__svg-bg" d="M ${cx - 45} ${H} L ${cx} 4 L ${cx + 45} ${H} Z" />` +
    `<path class="ai-tuner__svg-fg" d="M ${cx - spread} ${H} L ${cx} 4 L ${cx + spread} ${H} Z" />` +
    `<line class="ai-tuner__svg-axis" x1="${cx}" y1="${H}" x2="${cx}" y2="4" />` +
    `</svg>`
  );
}

/**
 * Circle guide: a centered disc whose radius is proportional to t.
 * Surrounding dashed ring shows the maximum radius for context.
 */
function circleGuide(t) {
  const cx = 50, cy = 18, maxR = 15;
  const r = Math.max(0.5, t * maxR);
  return (
    `<svg class="ai-tuner__svg ai-tuner__svg--circle" viewBox="0 0 100 36" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle class="ai-tuner__svg-bg" cx="${cx}" cy="${cy}" r="${maxR}" />` +
    `<circle class="ai-tuner__svg-fg" cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" />` +
    `</svg>`
  );
}

/**
 * Speedometer guide: half-arc dial with a needle rotated from
 * -90° (full left, value=0) to +90° (full right, value=max).
 *
 * The needle length stays constant so the eye tracks rotation, not
 * length; the dial arc stays constant so the "what's full" anchor
 * is stable. Only the needle moves.
 */
function speedometerGuide(t) {
  const cx = 50, cy = 30, r = 22;
  // Angle: -π at t=0 (left), 0 at t=1 (right).
  const angle = -Math.PI + Math.PI * t;
  const nx = cx + r * Math.cos(angle);
  const ny = cy + r * Math.sin(angle);
  // Background arc — half-circle from (cx-r, cy) over the top to
  // (cx+r, cy). SVG arc syntax: A rx ry rot largeArcFlag sweepFlag x y.
  return (
    `<svg class="ai-tuner__svg ai-tuner__svg--speedometer" viewBox="0 0 100 36" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path class="ai-tuner__svg-bg" d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" />` +
    `<line class="ai-tuner__svg-fg" x1="${cx}" y1="${cy}" ` +
    `x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" />` +
    `<circle class="ai-tuner__svg-axis" cx="${cx}" cy="${cy}" r="1.5" />` +
    `</svg>`
  );
}

/**
 * Bar guide: horizontal fill bar. Width = t × total. Background bar
 * shows full extent; foreground bar shows fill.
 */
function barGuide(t) {
  const W = 90, x = 5, y = 14, h = 8, fillW = Math.round(W * t);
  const fillX = x;
  return (
    `<svg class="ai-tuner__svg ai-tuner__svg--bar" viewBox="0 0 100 36" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<rect class="ai-tuner__svg-bg" x="${x}" y="${y}" width="${W}" height="${h}" rx="2" />` +
    `<rect class="ai-tuner__svg-fg" x="${fillX}" y="${y}" width="${fillW}" height="${h}" rx="2" />` +
    `</svg>`
  );
}

/**
 * Clock guide: clock face with a hand rotated full-circle as t goes
 * 0 → 1. Hand starts at 12 o'clock (angle = -π/2) — same convention
 * used by the SVG painter's algorithm. Center pivot circle marks
 * the spindle.
 */
function clockGuide(t) {
  const cx = 50, cy = 18, r = 13;
  // -π/2 → +3π/2 = full clockwise sweep as t goes 0 → 1.
  const angle = -Math.PI / 2 + 2 * Math.PI * t;
  const hx = cx + r * Math.cos(angle);
  const hy = cy + r * Math.sin(angle);
  return (
    `<svg class="ai-tuner__svg ai-tuner__svg--clock" viewBox="0 0 100 36" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle class="ai-tuner__svg-bg" cx="${cx}" cy="${cy}" r="${r}" />` +
    `<line class="ai-tuner__svg-fg" x1="${cx}" y1="${cy}" ` +
    `x2="${hx.toFixed(2)}" y2="${hy.toFixed(2)}" />` +
    `<circle class="ai-tuner__svg-axis" cx="${cx}" cy="${cy}" r="1.5" />` +
    `</svg>`
  );
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
      const rows = group.keys.map((key) => buildRow(key)).join('');
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

  /** Build a single row's HTML — extracted so setValue + reset can
   *  rebuild the guide portion of a row without re-rendering the
   *  whole panel. */
  function buildRow(key) {
    const spec = TUNER_SPECS[key];
    const label = (spec && spec.label) || key;
    const help = (spec && spec.help) || '';
    const current = tunables[key];
    const stepAttr = spec && typeof spec.step === 'number' ? spec.step : 0.01;
    const minAttr = spec && typeof spec.min === 'number' ? spec.min : 0;
    const maxAttr = spec && typeof spec.max === 'number' ? spec.max : 1000;
    const guideHtml = renderGuide(
      spec && spec.guideType,
      current,
      minAttr,
      maxAttr,
    );
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
        <div class="ai-tuner__guide" data-tuner-guide="${key}">${guideHtml}</div>
      </div>
    `;
  }

  /** Update a single row's guide cell (called on every setValue +
   *  reset, since the guide value tracks the live value). Defensive
   *  against rows whose guide cells were removed (e.g. via DOM
   *  detachment on a re-mount). */
  function refreshGuideCell(key) {
    if (!groupedFormEls || !groupedFormEls.guideCells) return;
    const cell = groupedFormEls.guideCells[key];
    if (!cell) return;
    const spec = TUNER_SPECS[key];
    if (!spec) return;
    cell.innerHTML = renderGuide(spec.guideType, tunables[key], spec.min, spec.max);
  }

  function readElements() {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return null;
    const sliders = {};
    const valueCells = {};
    const guideCells = {};
    rootEl.querySelectorAll('[data-tuner]').forEach((el) => {
      sliders[el.dataset.tuner] = el;
    });
    rootEl.querySelectorAll('[data-tuner-value]').forEach((el) => {
      valueCells[el.dataset.tunerValue] = el;
    });
    rootEl.querySelectorAll('[data-tuner-guide]').forEach((el) => {
      guideCells[el.dataset.tunerGuide] = el;
    });
    const actionBtns = {};
    rootEl.querySelectorAll('[data-tuner-action]').forEach((el) => {
      actionBtns[el.dataset.tunerAction] = el;
    });
    return { sliders, valueCells, guideCells, actionBtns };
  }

  function setValue(key, value) {
    const safe = clampToTunableRange(key, value);
    if (safe === undefined) return;
    tunables[key] = safe;
    if (groupedFormEls) {
      if (groupedFormEls.sliders[key]) {
        groupedFormEls.sliders[key].value = String(safe);
      }
      if (groupedFormEls.valueCells[key]) {
        groupedFormEls.valueCells[key].textContent = formatTunable(key, safe);
      }
      refreshGuideCell(key);
    }
    if (typeof onChange === 'function') {
      try { onChange(key, safe); } catch { /* swallow — UI must not crash on hook error */ }
    }
  }

  /** Refresh all rows from the live `tunables` bag. Called after
   *  reset (defaults-copied-into-bag) and on demand by callers
   *  importing the snapshot via COPY JSON. */
  function refreshAllRows() {
    if (!groupedFormEls) return;
    for (const key of Object.keys(groupedFormEls.sliders)) {
      const v = tunables[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      groupedFormEls.sliders[key].value = String(v);
      if (groupedFormEls.valueCells[key]) {
        groupedFormEls.valueCells[key].textContent = formatTunable(key, v);
      }
      refreshGuideCell(key);
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
        // After a reset, refresh ALL sliders + value cells + guides
        // from the live bag (in case the resetFn restored to values
        // that differ from the initial render).
        refreshAllRows();
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
    refreshAllRows();
  }, exportSnapshot };
}
