/**
 * AI Debug Overlay — Modular 2D radar + info panels.
 *
 * v0.23.x — Always-visible (no toggle) AI-debug HUD showing:
 *   1. RADAR       – Canvas2D mini-map centered on the camera subject
 *                     (AI in DEMO, player in PLAYING / GAME_OVER).
 *                     North = world -Z. Subject is the center dot with a
 *                     forward-facing cone overlay. Asteroids are colored
 *                     by distance from subject (red close → cyan far).
 *                     Power-up is a gold cross-hair. The current chase
 *                     target gets a SQUARE BRACKET drawn around its dot
 *                     (the user-asked-for "target quadrat drüber" visual).
 *   2. MODE CHIP   – Color-coded chip: dodge=red, asteroid=cyan,
 *                     powerup=purple, idle=dim-gray.
 *   3. DECISION    – Yaw (-1/0/+1), Thrust (on/off), Fire (yes/no),
 *                     Weapon (bullet/laser), Target dist, Threats count.
 *   4. GAME STATE  – State machine state, score, energy bar (text form).
 *
 * Architecture — modular factory matching the project's existing pattern
 * (see src/ui/hud.js, src/ui/debug-hud.js):
 *   • Pure helpers (exported for unit tests):
 *       - worldToRadar           — convert world XZ to canvas px
 *       - clipToRadarEdge        — clip a point to the radar's circular border
 *       - colorForThreatDistance — red → orange → cyan distance gradient
 *       - modeToBadgeClass       — brain mode → CSS BEM modifier
 *       - formatDistance         — raw units → compact 'N u' string
 *   • Sub-view factories:
 *       - createRadarView(deps)  — Canvas2D drawing
 *       - createPanelsView(deps) — DOM table
 *       - createChipView(deps)   — DOM badge for the brain mode
 *   • Composing factory: createAiDebugOverlay(deps) — wires them into a
 *     single DOM root, exposes { mount, update, dispose }.
 *
 * Future COMPASS mode (designed for, not built):
 *   The displayMode option is 'radar' (default) or 'compass'. The
 *   compass variant REUSES the same dep hooks (getSubject,
 *   getAsteroids, getPowerup, getLastDecision) and just swaps the
 *   radar canvas for a horizon line + bearings dial. The pure helpers
 *   + the Panels view run unchanged. The factory is the only swap
 *   point.
 *
 * Removal: delete this file + remove the import + the createAiDebugOverlay
 * block in src/main.js. No other file is affected. The HTML container
 * (#ai-debug-overlay) lives next to the other overlays and is in
 * index.html — it'll be a no-op <div> until the factory is wired.
 *
 * @example Minimal wire (in main.js):
 *   const aiDebug = createAiDebugOverlay({
 *     getSubject: () => state === DEMO ? demoAi.getShip() : ship,
 *     getAiShip: () => demoAi.getShip(),
 *     getLastDecision: () => demoAi.getLastDecision(),
 *     getAsteroids: () => field.getEntities(),
 *     getPowerupPos: () => {
 *       const p = powerupSystem.getPendingSpawn();
 *       return p ? p.getPosition() : null;
 *     },
 *     getActiveWeapon: () => powerupSystem.isLaserActive() ? 'laser' : 'bullet',
 *     getScore: () => score,
 *     getEnergy: () => ({ value: ship.getEnergy(), max: ship.getMaxEnergy() }),
 *     getState: () => stateMachine.getState(),
 *   });
 *   aiDebug.mount(document.getElementById('ai-debug-overlay'));
 *   // in render loop:
 *   aiDebug.update();
 */

// ===========================================================================
// CONFIG
// ===========================================================================

/**
 * Visual + behavioral tunables. Single source of truth for the overlay.
 * `worldRadius` is the circular scope of the radar in world units — any
 * entity beyond this radius is clipped to the radar edge (so the player
 * sees "an asteroid is just off the map" instead of it disappearing).
 */
const OVERLAY_CONFIG = Object.freeze({
  /** World-unit radius of the radar circle. Default 80 — matches the
   *  AI's targetDist for typical scenes while keeping the visible
   *  bubble reasonable for the player. Far asteroids (>80u) are
   *  clipped to the edge. */
  worldRadius: 80,
  /** Logical canvas size in CSS px (the canvas's bitmap is DPR-scaled). */
  canvasCssSize: 200,
  /** How often the DOM rows are written (the canvas redraws every call).
   *  throttled write avoids layout thrash at 144Hz+. */
  panelUpdateIntervalMs: 80,
  /** Display mode — 'radar' (default) draws the mini-map. A future
   *  'compass' mode will swap the radar canvas for a compass dial;
   *  feature is owned by this overlay's displayMode option. */
  displayMode: 'radar',
  /** Radar orientation mode.
   *   - 'rotate': ship's forward cone rotates with yaw (world north stays up).
   *   - 'north-up': ship always faces canvas-up; the world rotates around it.
   * Designed to be extensible — more radar types/views can be added here. */
  radarMode: 'rotate',
});

// ===========================================================================
// Pure helpers (exported for unit tests)
// ===========================================================================

/**
 * Convert a world-space XZ position to radar-canvas pixel coordinates
 * centered on the subject (`centerX`, `centerZ`). The radar's "north"
 * is world -Z (this matches the ship.js convention where yaw=0 means
 * facing -Z). A point at +Z is therefore drawn at the bottom of the
 * canvas, a point at -Z at the top.
 *
 * `worldRadius` is the radar's world-unit scope; `halfSize` is half
 * the canvas's logical pixel size. The mapping is linear: a point at
 * exactly the edge of the radar's world scope ends up at the edge of
 * the canvas circle (note: clipToRadarEdge handles points BEYOND the
 * scope, this helper returns the unclipped mapping).
 *
 * Pure — no DOM, no state. Tested directly.
 *
 * @param {{x:number,z:number}} pos      world position
 * @param {number} centerX                subject x
 * @param {number} centerZ                subject z
 * @param {number} worldRadius            radar scope in world units
 * @param {number} halfSize               half canvas size in logical px
 * @returns {{px:number, py:number, dist:number}}
 */
export function worldToRadar(pos, centerX, centerZ, worldRadius, halfSize) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') {
    return { px: 0, py: 0, dist: Infinity };
  }
  if (!Number.isFinite(halfSize) || halfSize <= 0) {
    return { px: 0, py: 0, dist: Infinity };
  }
  if (!Number.isFinite(worldRadius) || worldRadius <= 0) {
    return { px: 0, py: 0, dist: Infinity };
  }
  const dx = pos.x - centerX;
  const dz = pos.z - centerZ;
  const dist = Math.hypot(dx, dz);
  // Linear pixel mapping. We do NOT clip here; the caller can use
  // `dist > worldRadius` to decide whether to draw a clipped marker
  // (see clipToRadarEdge for that path).
  // Convention: north (world -Z) at top of canvas, east (world +X) at
  // right. Canvas Y grows DOWN, so for north to be at the top we map
  // world Z directly to canvas py: dz < 0 (north) → py < 0 (top of
  // canvas). East maps directly: dx > 0 → px > 0 (right).
  // We do NOT negate py: doing so would (a) put north at the bottom
  // and (b) produce -0 instead of +0 when dz === 0 (the strict-
  // equality test in node:assert/strict would fail on -0 vs 0).
  const scale = halfSize / worldRadius;
  const px = dx * scale;
  const py = dz * scale; // north (-Z) → py<0 → top; south (+Z) → py>0 → bottom
  return { px, py, dist };
}

/**
 * If a point is outside the radar circle (radius = `halfSize`), clip
 * it back to the circle's edge by projective scaling. Returns the
 * input unchanged when already inside.
 *
 * Pure. Used by the radar view to draw "edge-of-radar" markers for
 * entities beyond the world's radar scope.
 *
 * @param {{px:number, py:number}} pxPy  already projected pixel coords
 * @param {number} halfSize              half canvas size (radius of radar circle)
 * @param {number} markerPxRadius        extra px buffer so point sits ON edge, not across it
 * @returns {{px:number, py:number}}
 */
export function clipToRadarEdge({ px, py }, halfSize, markerPxRadius = 4) {
  const r = Math.hypot(px, py);
  const allowed = Math.max(0, halfSize - markerPxRadius);
  if (r <= allowed) return { px, py };
  if (r <= 0) return { px, py }; // origin: nothing to clip
  // Project back onto the circle. Scale = allowed / r shrinks the
  // vector to length `allowed` (the inside-edge offset).
  const s = allowed / r;
  return { px: px * s, py: py * s };
}

/**
 * Resolve the radar's world-unit radius from three possible sources,
 * in priority order:
 *
 *   1. `getWorldRadius()` callback result — live-tunable, evaluated
 *      per `draw()`. Caller can track the streaming bubble +
 *      multipliers without re-creating the overlay.
 *   2. Static `staticValue` (the legacy `worldRadius` parameter).
 *   3. `fallback` (defaults to `OVERLAY_CONFIG.worldRadius` = 80u).
 *
 * Defensive against: getter throws, getter returns undefined / null,
 * NaN, Infinity, negative, or zero — all fall through to `staticValue`
 * then to `fallback`. The radar never renders with a zero or NaN
 * radius (division by zero in `worldToRadar`).
 *
 * Pure (no Three.js, no DOM). Tested directly.
 *
 * @param {number|undefined} staticValue
 * @param {function|undefined|null} getterFn
 * @param {number} fallback
 * @returns {number}
 */
export function resolveWorldRadius(staticValue, getterFn, fallback) {
  if (typeof getterFn === 'function') {
    try {
      const v = getterFn();
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch {
      // swallow — getter failure is not fatal; fall through to static
    }
  }
  if (typeof staticValue === 'number' && Number.isFinite(staticValue) && staticValue > 0) {
    return staticValue;
  }
  return fallback;
}

/**
 * Map a threat distance (world units) to a hex color. Linear blend:
 *   - 0u       → red (closest, immediate panic)
 *   - maxDist/2 → orange
 *   - maxDist  → cyan (fading into the distance)
 * Closer threats are bright red; far rocks fade to the cyan accent.
 * Pure, used by the radar's asteroid dots + the target bracket.
 *
 * @param {number} dist          world units
 * @param {number} maxDist       world units (radar edge)
 * @returns {string}             '#rrggbb'
 */
export function colorForThreatDistance(dist, maxDist) {
  if (!Number.isFinite(dist) || dist < 0) return '#ff5566';
  if (!Number.isFinite(maxDist) || maxDist <= 0) return '#48dbfb';
  // Linear interpolation factor in [0, 1] (1 = far, 0 = close).
  const t = Math.max(0, Math.min(1, dist / maxDist));
  // Three-stop gradient: 0→red(255,85,102), 0.5→orange(255,136,68), 1→cyan(72,219,251).
  let r, g, b;
  if (t < 0.5) {
    // Red → orange. t in [0, 0.5].
    const k = t * 2; // 0..1
    r = 255;
    g = Math.round(85 + (136 - 85) * k); // 85 → 136
    b = Math.round(102 + (68 - 102) * k); // 102 → 68
  } else {
    // Orange → cyan. t in [0.5, 1].
    const k = (t - 0.5) * 2; // 0..1
    r = Math.round(255 + (72 - 255) * k); // 255 → 72
    g = Math.round(136 + (219 - 136) * k); // 136 → 219
    b = Math.round(68 + (251 - 68) * k); // 68 → 251
  }
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Map a world-bearing (relative to a subject's heading) to a
 * canvas-space rotation angle for the v0.63.0 compass dial.
 *
 * Convention:
 *   - yaw = 0  → subject faces world -Z (north). The radar's "north"
 *                marker is at canvas-top, matching ship.js / the world.
 *   - The COMPASS is ship-frame centered: 12 o'clock = "dead ahead of
 *                the subject's nose", regardless of the subject's
 *                absolute heading. So the bearing is RELATIVE to yaw.
 *   - Canvas arc 0 (the math baseline `ctx.rotate(0)`) points to
 *                "3 o'clock" (east). To make "dead ahead" map to
 *                canvas-top (-PI/2), we subtract PI/2 from the
 *                relative bearing.
 *
 *   Math:
 *     1. Global bearing of (dx, dz) = atan2(dx, -dz)
 *        (atan2(y, x) on the (X, -Z) plane: 0=N, +PI/2=E, ±PI=S)
 *     2. Relative bearing = global - yaw
 *     3. Canvas angle  = relative - PI/2
 *
 *   Edge case note (dead-left): Math.atan2(-1, +0) = -PI/2 in V8 /
 *   SpiderMonkey / JavaScriptCore (per ECMAScript spec; the value
 *   could be -PI on engines treating sign-of-zero differently). The
 *   offset subtracts -PI/2 → result is canvas-arc ±PI (9 o'clock).
 *   sin/cos-equivalence assertions in the tests handle both ±PI
 *   indifferently. See tests/ai-debug-overlay.test.js for the
 *   actual assertion values.
 *
 *   Boundary semantics: NaN / non-finite inputs return -PI/2 (the
 *   safe 12-o'clock default). The compass renders the safe default
 *   before any math throws.
 *
 * **Pure, exported for tests.** Does NOT touch DOM/Three.js.
 *
 * @param {number} yaw  subject heading in radians (0 = facing -Z)
 * @param {number} dx   world X offset of the target from the subject
 * @param {number} dz   world Z offset of the target from the subject
 * @returns {number}    canvas rotation angle in radians
 */
export function worldBearingToCanvasAngle(yaw, dx, dz) {
  if (!Number.isFinite(yaw) || !Number.isFinite(dx) || !Number.isFinite(dz)) {
    return -Math.PI / 2; // safe default = 12 o'clock (straight ahead)
  }
  const globalBearing = Math.atan2(dx, -dz);     // 0 = North, +PI/2 = East
  const relativeBearing = globalBearing - yaw;   // ship-frame bearing
  return relativeBearing - Math.PI / 2;          // canvas arc 0 is east → shift -PI/2 so 0 is north
}

/**
 * Map a brain mode (`'dodge'|'asteroid'|'powerup'|'idle'|other`) to a
 * CSS BEM modifier class. The chips + the radar target bracket use
 * these classes to color themselves. Unknown modes fall back to
 * `--idle` (dim). Pure.
 *
 * @param {string} mode
 * @returns {string}  CSS class (without leading dot)
 */
export function modeToBadgeClass(mode) {
  switch (mode) {
    case 'dodge':   return 'ai-debug__chip--dodge';
    case 'evade':   return 'ai-debug__chip--evade';
    case 'asteroid':return 'ai-debug__chip--asteroid';
    case 'powerup': return 'ai-debug__chip--powerup';
    case 'idle':    return 'ai-debug__chip--idle';
    default:        return 'ai-debug__chip--idle';
  }
}

/**
 * Format a world-units distance as a compact integer-string `'42u'`.
 * Negative → '0u'; non-finite → '—u'. Always one-digit-friendly at
 * MVP scale (no need to abbreviate thousands, but ready).
 *
 * @param {number} units
 * @returns {string}
 */
export function formatDistance(units) {
  if (!Number.isFinite(units)) return '—u';
  if (units < 0) return '0u';
  return `${Math.round(units)}u`;
}

/**
 * Format yaw command (-1|0|+1) as human-readable symbol. The panel
 * row shows `← / · / →` (left arrow / dot / right arrow) for instant
 * read. Pure; CSS glyph rendering is the consumer's choice.
 *
 * @param {number} yaw  -1|0|+1
 * @returns {string}
 */
export function formatYawCommand(yaw) {
  if (yaw === -1) return '←';
  if (yaw === 1)  return '→';
  return '·';
}

/**
 * Format boolean as 'ON'/'OFF'. Pure. Centralized so the panel rows
 * are consistent (we never want to mix 'YES'/'NO' and 'ON'/'OFF' in
 * the same column).
 *
 * @param {boolean} v
 * @returns {string}
 */
export function formatBool(v) {
  return v ? 'ON' : 'OFF';
}

// ===========================================================================
// Sub-view: Radar (Canvas2D drawing)
// ===========================================================================

  /**
   * Build the radar sub-view. Reads live state via the injected getter
   * hooks (per-frame closures) and redraws the canvas on each `draw()`.
   * Returns a small surface: { draw, resize, dispose, setRadarMode }. No global state —
   * each call to `draw()` reads the live state fresh.
   *
   * Future: the draw function can be swapped for a compass dial when
   * `displayMode === 'compass'`. That swap happens in the composing
   * factory, NOT here.
   *
   * @param {{
   *   canvas: HTMLCanvasElement,
   *   getSubject: () => { position?: {x:number,y:number,z:number}, rotation?: {yaw:number} } | null,
   *   getAiShip: () => any,
   *   getAsteroids: () => Array<{ getPosition: () => any }>,
   *   getPowerupPos: () => {x:number,z:number} | null,
   *   getLastDecision: () => { mode?: string, target?: {pos,mode,dist} | null, nearest?: {pos,dist} | null },
   *   getActiveWeapon: () => 'bullet' | 'laser',
   *   worldRadius?: number,
   *   radarMode?: 'rotate' | 'north-up',
   * }} deps
   */
function createRadarView(deps) {
  const {
    canvas, getSubject, getAiShip, getAsteroids, getPowerupPos,
    getLastDecision, getActiveWeapon,
    worldRadius = OVERLAY_CONFIG.worldRadius,
    getWorldRadius = null,
  } = deps;
  let radarMode = deps.radarMode || OVERLAY_CONFIG.radarMode;

  /**
   * Resolve the live radar radius each frame. Order: getter (if
   * provided, returns a valid positive number) > static `worldRadius`
   * > `OVERLAY_CONFIG.worldRadius`. Pure function call; safe to
   * invoke at 60fps.
   */
  function currentWorldRadius() {
    return resolveWorldRadius(worldRadius, getWorldRadius, OVERLAY_CONFIG.worldRadius);
  }
  const ctx = canvas && typeof canvas.getContext === 'function'
    ? canvas.getContext('2d')
    : null;
  const cssSize = OVERLAY_CONFIG.canvasCssSize;

  // Initial size. Browser will resize the canvas via the ResizeObserver
  // in the composing factory (see resize()).
  function fitCanvas() {
    if (!canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cssSize, cssSize);
  }

  /** Draw the circular border + cross-hair guides. Always centered. */
  function drawFrame() {
    if (!ctx) return;
    ctx.save();
    // Outer circle (radar scope).
    ctx.strokeStyle = 'rgba(72,219,251,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cssSize / 2, cssSize / 2, cssSize / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    // Cross-hair (faint N-S / E-W).
    ctx.strokeStyle = 'rgba(72,219,251,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, cssSize / 2);
    ctx.lineTo(cssSize, cssSize / 2);
    ctx.moveTo(cssSize / 2, 0);
    ctx.lineTo(cssSize / 2, cssSize);
    ctx.stroke();
    // N marker.
    ctx.fillStyle = 'rgba(72,219,251,0.45)';
    ctx.font = '9px Courier New, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', cssSize / 2, 1);
    ctx.restore();
  }

  /** Draw the subject (camera target) at center + a forward-cone overlay. */
  function drawSubject(subject, weapon, mode) {
    if (!ctx || !subject || !subject.position) return;
    const yaw = (subject.rotation && typeof subject.rotation.yaw === 'number')
      ? subject.rotation.yaw
      : 0;
    // In 'rotate' mode the cone rotates with the ship's yaw.
    // In 'north-up' mode the ship always faces canvas-up, so the cone
    // rotation is fixed to -PI/2 (pointing up).
    const facing = mode === 'north-up' ? -Math.PI / 2 : facingAngle(yaw);

    ctx.save();
    // Subject center dot.
    ctx.fillStyle = '#48dbfb';
    ctx.beginPath();
    ctx.arc(cssSize / 2, cssSize / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    // Forward-cone overlay:
    //   - bullet mode: wide (~14° half-angle, matches fireHeadingGate=0.25)
    //   - laser mode:  tight (~3° half-angle, matches laserFireConeHalfAngle=0.05)
    const halfAngle = weapon === 'laser' ? 0.05 : 0.20;
    const coneLength = cssSize / 2 - 6; // won't reach the outer ring
    ctx.translate(cssSize / 2, cssSize / 2);
    ctx.rotate(facing);
    ctx.fillStyle = weapon === 'laser'
      ? 'rgba(255,136,68,0.18)' // faint orange — laser
      : 'rgba(72,219,251,0.10)'; // faint cyan — bullet
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const t = Math.tan(halfAngle);
    ctx.lineTo(coneLength, coneLength * t);
    ctx.lineTo(coneLength, -coneLength * t);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Draw an entity marker (asteroid or powerup) at the projected pos. */
  function drawMarker(px, py, color, kind, opts = {}) {
    if (!ctx) return;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    ctx.save();
    ctx.translate(cssSize / 2 + px, cssSize / 2 + py);
    if (kind === 'powerup') {
      // Powerup: bright gold diamond + pulsing ring for visibility.
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() / 1000
        : 0;
      const pulse = 0.7 + 0.3 * Math.sin(now * 6);
      // Outer pulsing ring.
      ctx.strokeStyle = `rgba(250, 204, 21, ${0.5 + 0.3 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 8 + 3 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      // Inner solid diamond.
      ctx.fillStyle = color;
      ctx.beginPath();
      const s = 5;
      ctx.moveTo(0, -s);
      ctx.lineTo(s, 0);
      ctx.lineTo(0, s);
      ctx.lineTo(-s, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      // Asteroid: filled circle, size scaled by world radius.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, Math.min(4, opts.size || 3)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draw the target bracket square around (pxCenter, pyCenter). */
  function drawBracket(pxCenter, pyCenter, color) {
    if (!ctx) return;
    if (!Number.isFinite(pxCenter) || !Number.isFinite(pyCenter)) return;
    const r = 10; // bracket radius (px). Bigger than the dot so the dot sits inside.
    const cx = cssSize / 2 + pxCenter;
    const cy = cssSize / 2 + pyCenter;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    // L-shaped corners (3 of 4 corners) — the open corner is where the
    // target is "approaching from" relative to the subject's center.
    // Simplicity: draw all 4 corners as L-shapes (the visual cue is
    // the dashing + size, not the open corner).
    const corners = [
      [-1, -1],
      [ 1, -1],
      [-1,  1],
      [ 1,  1],
    ];
    for (const [sx, sy] of corners) {
      const ax = cx + sx * r;
      const ay = cy + sy * r;
      // Each L: from (ax, ay-sy*4) to (ax, ay) to (ax-sx*4, ay).
      ctx.beginPath();
      ctx.moveTo(ax, ay - sy * 4);
      ctx.lineTo(ax, ay);
      ctx.lineTo(ax - sx * 4, ay);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    // Resolve the live radar radius FIRST, before the ctx guard, so
    // the live-tunable contract holds even when the canvas context
    // is unavailable (e.g. in unit tests that mock the canvas). The
    // getter is evaluated per frame, not cached at mount — mutating
    // the live bag (or BUBBLE_RADIUS_CHUNKS) is reflected on the
    // next tick. Captured once per draw so all downstream math uses
    // the same consistent radius.
    const worldRadiusLive = currentWorldRadius();
    if (!ctx) return;
    clear();
    drawFrame();

    // Center of the radar is the subject.
    const subject = safeCall(getSubject);
    if (!subject || !subject.position) {
      // No subject → draw empty frame + a "no signal" hint.
      ctx.fillStyle = 'rgba(151,163,196,0.5)';
      ctx.font = '10px Courier New, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO SUBJECT', cssSize / 2, cssSize / 2);
      return;
    }
    const sx = subject.position.x;
    const sz = subject.position.z;
    const subjectYaw = (subject.rotation && typeof subject.rotation.yaw === 'number')
      ? subject.rotation.yaw
      : 0;

    // Asteroids.
    const asteroids = safeCall(getAsteroids) || [];
    const halfSize = cssSize / 2;
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      let { px, py, dist } = worldToRadar(p, sx, sz, worldRadiusLive, halfSize);
      // In north-up mode, rotate the world around the subject by +yaw
      // so the ship's forward vector (world -Z for yaw=0) aligns with
      // canvas-up. The forward vector in radar px/py is
      // (-sin(yaw), -cos(yaw)); rotating it by +yaw gives (0, -1),
      // i.e. canvas-top.
      if (radarMode === 'north-up') {
        const cos = Math.cos(subjectYaw);
        const sin = Math.sin(subjectYaw);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx;
        py = ry;
      }
      if (dist > worldRadiusLive * 1.5) continue; // far enough to skip
      const color = colorForThreatDistance(dist, worldRadiusLive);
      if (dist > worldRadiusLive) {
        const clipped = clipToRadarEdge({ px, py }, halfSize, 4);
        drawMarker(clipped.px, clipped.py, color, 'asteroid', { size: 2 });
      } else {
        // Slight size boost for very close threats for visibility.
        const closeBoost = dist < 10 ? 4 : 3;
        drawMarker(px, py, color, 'asteroid', { size: closeBoost });
      }
    }

    // Power-up (pending spawn). Always a gold cross-hair.
    const pup = safeCall(getPowerupPos);
    if (pup && typeof pup.x === 'number' && typeof pup.z === 'number') {
      let { px, py, dist } = worldToRadar(pup, sx, sz, worldRadiusLive, halfSize);
      if (radarMode === 'north-up') {
        const cos = Math.cos(subjectYaw);
        const sin = Math.sin(subjectYaw);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx;
        py = ry;
      }
      const clipped = dist > worldRadiusLive
        ? clipToRadarEdge({ px, py }, halfSize, 4)
        : { px, py };
      drawMarker(clipped.px, clipped.py, '#facc15', 'powerup');
    }

    // Subject + forward-cone overlay (drawn LAST so it sits on top).
    const weapon = safeCall(getActiveWeapon) || 'bullet';
    drawSubject(subject, weapon, radarMode);

    // Target bracket on top of the chase target.
    const dec = safeCall(getLastDecision);
    if (dec && dec.target && dec.target.pos) {
      let { px, py, dist } = worldToRadar(
        dec.target.pos, sx, sz, worldRadiusLive, halfSize,
      );
      if (radarMode === 'north-up') {
        const cos = Math.cos(subjectYaw);
        const sin = Math.sin(subjectYaw);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx;
        py = ry;
      }
      const bracketColor = dec.target.mode === 'powerup' ? '#c084fc' : '#48dbfb';
      const finalPos = dist > worldRadiusLive
        ? clipToRadarEdge({ px, py }, halfSize, 12)
        : { px, py };
      drawBracket(finalPos.px, finalPos.py, bracketColor);
    }
  }

  function setRadarMode(mode) {
    radarMode = mode === 'north-up' ? 'north-up' : 'rotate';
  }

  function resize() { fitCanvas(); }
  function getRadarMode() {
    return radarMode;
  }
  function dispose() {
    // No listeners of our own to remove here; the canvas element is
    // owned by the caller (the DOM root). The composing factory
    // clears the children on dispose.
  }

  return { draw, resize, setRadarMode, getRadarMode, dispose };
}

// ===========================================================================
// Sub-view: Compass (Canvas2D dial) — v0.63.0
// ===========================================================================

/**
 * v0.63.0 — Compass mode. Ship-frame bearing dial replacing the radar
 * canvas when `displayMode === 'compass'`. Same canvas, same DOM
 * hook (`.ai-debug__radar`), but the drawing pipeline is different:
 *
 *   1. Fit canvas (DPR-scaled) — mirrors radar.
 *   2. Clear (radar's `clear()` works for both: full-canvas clear).
 *   3. **Base dial** — full circle + 4 cardinal tick marks (N/E/S/W).
 *      A faint E-W cross-hair establishes the "horizon". The N tick
 *      is positioned UP at 12 o'clock.
 *   4. **Ship heading arrow** — fixed triangle pointing UP at the
 *      dial's center. Reinforces the SHIP-FRAME local-frame mental
 *      model (the arrow is always forward; the world rotates around
 *      it via the per-tick bearing math, NOT via a `ctx.rotate` of
 *      the canvas itself).
 *   5. **Fire-cone overlay** — pie-slice radiating from center, fixed
 *      UP. Brightens when the chase target is currently inside the
 *      cone (visual cue: "the brain would fire right now").
 *   6. **Threat rim ticks** — iterate asteroids within `evadeDist`
 *      and draw small OUT-bound ticks at the bearing angles, colored
 *      with `colorForThreatDistance` re-mapped to [0, evadeDist]
 *      (instead of [0, worldRadius]). Tips point outward so they
 *      don't overlap with target pointers (drawn inward).
 *   7. **Chase target pointer** — large IN-bound triangle on the
 *      inner rim at the target's bearing. Cyan for asteroid, purple
 *      for powerup. Distinct visual layer from the threat ticks.
 *   8. **Powerup tick** — gold tick on the outer rim at the
 *      pending-spawn position (skipped if the chase target IS the
 *      powerup — single visual surface, no double-marking).
 *
 * Edge cases (all handled):
 *   - No subject → "NO SUBJECT" text in the center, dial still draws.
 *   - Empty asteroid list → "CLEAR" text near the bottom (after the
 *     horizon line); the dial, ship arrow, and target pointer still
 *     render so the panel never looks broken.
 *   - Identical bearings (threat = target) → threats stick OUT,
 *     target sticks IN. They never overlap visually.
 *   - Dead-behind target → natural atan2 wrap; renders at 6 o'clock
 *     without any special-case math.
 *
 * The view is purely an output surface — no game state, no event
 * listeners of its own. Composing factory decides whether `draw()`
 * is called each frame. The compass+yaw loop runs every tick.
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   getSubject: () => any,
 *   getAsteroids?: () => Array<any>,
 *   getPowerupPos?: () => any,
 *   getLastDecision?: () => any,
 *   getActiveWeapon?: () => string,
 *   evadeDist?: number,                              // static fallback
 *   getEvadeDist?: () => number | undefined | null,  // live-tunable
 * }} deps
 */
function createCompassView(deps) {
  const {
    canvas, getSubject, getAsteroids, getPowerupPos,
    getLastDecision, getActiveWeapon,
    evadeDist = 10,           // static fallback (matches default AI_TUNABLES.evadeDist)
    getEvadeDist = null,
  } = deps;
  const ctx = canvas && typeof canvas.getContext === 'function'
    ? canvas.getContext('2d')
    : null;
  const cssSize = OVERLAY_CONFIG.canvasCssSize;
  const halfSize = cssSize / 2;

  /**
   * Resolve the live evade-distance each frame. Order: live getter
   * (valid positive finite) > static `evadeDist` > 10u default.
   * Mirrors `resolveWorldRadius` for the radar.
   */
  function currentEvadeDist() {
    if (typeof getEvadeDist === 'function') {
      try {
        const v = getEvadeDist();
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
      } catch { /* swallow */ }
    }
    return Number.isFinite(evadeDist) && evadeDist > 0 ? evadeDist : 10;
  }

  /* ---- canvas setup ---- */
  function fitCanvas() {
    if (!canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitCanvas();

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cssSize, cssSize);
  }

  /* ---- frame ---- */
  /**
   * Full-circle dial + 4 cardinal tick marks. The N tick is at the top
   * (12 o'clock) and labeled "FRONT" (ship-forward = compass-north
   * because the compass is ship-frame-centered).
   */
  function drawFrame() {
    if (!ctx) return;
    ctx.save();
    // Outer circle.
    ctx.strokeStyle = 'rgba(72,219,251,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(halfSize, halfSize, halfSize - 1, 0, Math.PI * 2);
    ctx.stroke();
    // Inner dashed ring = fire-distance ring (matches `fireMaxDist`).
    ctx.strokeStyle = 'rgba(72,219,251,0.15)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(halfSize, halfSize, halfSize * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // Cardinal ticks (N/E/S/W) on the inner edge of the outer ring.
    const tickInner = halfSize - 6;
    const tickOuter = halfSize - 2;
    for (let i = 0; i < 4; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI / 2);
      ctx.strokeStyle = 'rgba(72,219,251,0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(halfSize + Math.cos(angle) * tickInner, halfSize + Math.sin(angle) * tickInner);
      ctx.lineTo(halfSize + Math.cos(angle) * tickOuter, halfSize + Math.sin(angle) * tickOuter);
      ctx.stroke();
    }
    // Faint horizontal cross-hair (the "horizon line" the user
    // asked for in the future-compass note: a faint dashed centerline
    // so left-right asymmetry is visually obvious).
    ctx.strokeStyle = 'rgba(72,219,251,0.10)';
    ctx.beginPath();
    ctx.moveTo(4, halfSize);
    ctx.lineTo(cssSize - 4, halfSize);
    ctx.stroke();
    // FRONT label at top (12 o'clock). The compass is ship-frame-
    // centered so "FRONT" reinforces the convention that the top tick
    // = the ship's nose direction.
    ctx.fillStyle = 'rgba(72,219,251,0.50)';
    ctx.font = '9px Courier New, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('FRONT', halfSize, 1);
    ctx.restore();
  }

  /* ---- ship arrow (center, fixed pointing UP) ---- */
  function drawShipArrow() {
    if (!ctx) return;
    ctx.save();
    ctx.translate(halfSize, halfSize);
    // Triangle pointing UP (canonical nose-forward).
    ctx.fillStyle = '#48dbfb';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    // Center dot.
    ctx.fillStyle = '#48dbfb';
    ctx.beginPath();
    ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---- fire cone (pie slice, fixed UP) ---- */
  function drawFireCone(weapon, inCone, activeWeaponName) {
    if (!ctx) return;
    const halfAngle = weapon === 'laser' ? 0.05 : 0.20;
    const coneLength = halfSize - 8;
    ctx.save();
    ctx.translate(halfSize, halfSize);
    // The pie slice is drawn with no rotation (always UP = -PI/2 in
    // canvas arc space). We use moveTo/lineTo/closePath so the shape
    // is a wedge with apex at center, base at the cone radius.
    ctx.fillStyle = inCone
      ? (activeWeaponName === 'laser'
          ? 'rgba(255,136,68,0.35)'   // bright orange — laser actively on-target
          : 'rgba(72,219,251,0.30)')   // bright cyan — bullet actively on-target
      : (activeWeaponName === 'laser'
          ? 'rgba(255,136,68,0.10)'   // faint orange
          : 'rgba(72,219,251,0.08)'); // faint cyan
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const t = Math.tan(halfAngle);
    ctx.lineTo(Math.sin(halfAngle) * coneLength, -Math.cos(halfAngle) * coneLength);
    ctx.arc(0, 0, coneLength, -Math.PI / 2 - halfAngle, -Math.PI / 2 + halfAngle);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---- threat tick (outer rim, points outward) ---- */
  function drawThreatTick(angle, color) {
    if (!ctx) return;
    if (!Number.isFinite(angle)) return;
    const innerR = halfSize - 12;
    const outerR = halfSize - 2;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    // Triangle base sits on `innerR`, point at `outerR`.
    ctx.save();
    ctx.translate(halfSize, halfSize);
    ctx.fillStyle = color;
    ctx.beginPath();
    // Base left/right of the radial line at innerR.
    ctx.moveTo(cx * innerR + (-cy) * 2, cy * innerR + (cx) * 2);
    ctx.lineTo(cx * innerR - (-cy) * 2, cy * innerR - (cx) * 2);
    ctx.lineTo(cx * outerR, cy * outerR);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---- target pointer (inner rim, points inward) ---- */
  function drawTargetPointer(angle, color) {
    if (!ctx) return;
    if (!Number.isFinite(angle)) return;
    const outerR = halfSize - 14;
    const innerR = halfSize - 32;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    ctx.save();
    ctx.translate(halfSize, halfSize);
    ctx.fillStyle = color;
    ctx.beginPath();
    // Tip at `outerR` (close to outer ring), base at `innerR` (closer
    // to ship arrow). Up-vector is (-cy, cx). Triangle base sides are
    // +/- 3px offset perpendicular to the radial line.
    ctx.moveTo(cx * outerR, cy * outerR);
    ctx.lineTo(cx * innerR + (-cy) * 4, cy * innerR + (cx) * 4);
    ctx.lineTo(cx * innerR - (-cy) * 4, cy * innerR - (cx) * 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---- powerup tick (outer rim, far-side; visible as a gold cross-hair) ---- */
  function drawPowerupTick(angle) {
    if (!ctx) return;
    if (!Number.isFinite(angle)) return;
    const r = halfSize - 4;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    const x = halfSize + cx * r;
    const y = halfSize + cy * r;
    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - cy * 4, y + cx * 4);
    ctx.lineTo(x + cy * 4, y - cx * 4);
    ctx.moveTo(x + cx * 4, y + cy * 4);
    ctx.lineTo(x - cx * 4, y - cy * 4);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- main draw ---- */
  function draw() {
    const evadeDistLive = currentEvadeDist();
    if (!ctx) return;
    clear();
    drawFrame();

    const subject = safeCall(getSubject);
    if (!subject || !subject.position) {
      ctx.fillStyle = 'rgba(151,163,196,0.5)';
      ctx.font = '10px Courier New, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO SUBJECT', halfSize, halfSize);
      return;
    }
    const subjectYaw = (subject.rotation && typeof subject.rotation.yaw === 'number')
      ? subject.rotation.yaw
      : 0;
    const sx = subject.position.x;
    const sz = subject.position.z;
    const weapon = safeCall(getActiveWeapon) || 'bullet';
    const halfAngle = weapon === 'laser' ? 0.05 : 0.20;
    const coneHitsTarget = isTargetInFireCone(getLastDecision, sx, sz, halfAngle, subjectYaw);

    // ---- 1. Cone overlay under everything else ----
    drawShipArrow();
    drawFireCone(weapon, coneHitsTarget, weapon);

    // ---- 2. Threats: iterate asteroids within evadeDist ----
    // Only the closest threats make the dial visible; with ~50
    // asteroids within evadeDist at MVP scales the rim could
    // become a solid ring. Cap at the 12 closest to keep the
    // dial legible; the brain's dodge logic uses ALL of them.
    const asteroids = safeCall(getAsteroids) || [];
    const threats = [];
    for (const a of asteroids) {
      if (!a || typeof a.getPosition !== 'function') continue;
      const p = a.getPosition();
      if (!p) continue;
      const dx = p.x - sx;
      const dz = p.z - sz;
      const dist = Math.hypot(dx, dz);
      if (dist > evadeDistLive || dist < 0.01) continue; // skip center (the ship itself)
      threats.push({ dx, dz, dist, color: colorForThreatDistance(dist, evadeDistLive) });
    }
    threats.sort((a, b) => a.dist - b.dist);
    const MAX_THREATS_DRAWN = 12;
    for (let i = 0; i < Math.min(threats.length, MAX_THREATS_DRAWN); i++) {
      const t = threats[i];
      const angle = worldBearingToCanvasAngle(subjectYaw, t.dx, t.dz);
      drawThreatTick(angle, t.color);
    }

    // ---- 3. Chase target: triangular pointer on inner rim ----
    const dec = safeCall(getLastDecision);
    let targetIsPowerup = false;
    if (dec && dec.target && dec.target.pos) {
      const tp = dec.target.pos;
      const dx = tp.x - sx;
      const dz = tp.z - sz;
      const dist = Math.hypot(dx, dz);
      const angle = worldBearingToCanvasAngle(subjectYaw, dx, dz);
      const color = dec.target.mode === 'powerup' ? '#c084fc' : '#48dbfb';
      drawTargetPointer(angle, color);
      targetIsPowerup = dec.target.mode === 'powerup';
    }

    // ---- 4. Powerup tick: gold cross-hair (skip if it's the chase target) ----
    const pup = safeCall(getPowerupPos);
    if (pup && !targetIsPowerup && typeof pup.x === 'number' && typeof pup.z === 'number') {
      const dx = pup.x - sx;
      const dz = pup.z - sz;
      const angle = worldBearingToCanvasAngle(subjectYaw, dx, dz);
      drawPowerupTick(angle);
    }

    // ---- 5. Empty-field hint (after the iconography so it doesn't hide threats) ----
    if (threats.length === 0 && !dec?.target) {
      ctx.fillStyle = 'rgba(151,163,196,0.45)';
      ctx.font = '10px Courier New, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CLEAR', halfSize, cssSize - 14);
    }
  }

  /**
   * Helper: is the chase target currently inside the fire cone?
   * Pure projection math — does not touch the canvas. Used by the
   * cone's "active" coloring.
   *
   * Forward direction at yaw=Y in ship.js's convention:
   *   - yaw=0 → ship faces world -Z (north). Forward = (0, 0, -1).
   *   - Yaw rotates the ship around +Y (right-hand rule). At yaw=Y:
   *     forward in world = (sin(Y), 0, -cos(Y)).
   * The dot product of forward with the target's direction (dx, dz)
   * gives the cosine of the angle between them. cosA close to +1
   * means dead-ahead (in cone); cosA close to -1 means dead-behind.
   */
  function isTargetInFireCone(getTarget, sx, sz, halfAngle, subjectYaw) {
    const dec = safeCall(getTarget);
    if (!dec || !dec.target || !dec.target.pos) return false;
    const dx = dec.target.pos.x - sx;
    const dz = dec.target.pos.z - sz;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.01) return true; // target on top of ship
    // Forward at yaw is (sin(yaw), 0, -cos(yaw)); the -cos component
    // comes from ship.js's yaw=0=facing-Z convention (forward = -Z).
    const cosA = (Math.sin(subjectYaw) * dx + (-Math.cos(subjectYaw)) * dz) / dist;
    const clamped = Math.max(-1, Math.min(1, cosA));
    return Math.acos(clamped) <= halfAngle;
  }

  function resize() { fitCanvas(); }

  function dispose() {
    // No listeners of our own to remove.
  }

  return { draw, resize, dispose };
}

// ===========================================================================
// Sub-view: Mode chip (DOM badge)
// ===========================================================================

const MODE_CHIP_LABELS = Object.freeze({
  dodge: 'DODGE',
  evade: 'EVADE',
  asteroid: 'ASTEROID',
  powerup: 'POWERUP',
  idle: 'IDLE',
});

function createChipView(deps) {
  const { getLastDecision, rootEl } = deps;
  // rootEl is a function returning the .ai-debug__chip element.
  function chipEl() {
    const r = typeof rootEl === 'function' ? rootEl() : rootEl;
    if (!r || typeof r.querySelector !== 'function') return null;
    return r.querySelector('[data-ai-debug="mode"]');
  }
  function labelEl() {
    return chipEl();
  }

  function update() {
    const el = labelEl();
    if (!el) return;
    const dec = safeCall(getLastDecision);
    const mode = (dec && dec.mode) || 'idle';
    el.textContent = MODE_CHIP_LABELS[mode] || mode.toUpperCase();
    // Strip all chip modifier classes first so we don't pile up.
    el.classList.remove(
      'ai-debug__chip--dodge',
      'ai-debug__chip--evade',
      'ai-debug__chip--asteroid',
      'ai-debug__chip--powerup',
      'ai-debug__chip--idle',
    );
    el.classList.add(modeToBadgeClass(mode));
  }

  function dispose() { /* noop */ }
  return { update, dispose };
}

// ===========================================================================
// Sub-view: Panels (DOM rows)
// ===========================================================================

/**
 * Sparse DOM updates. Aligned cell names:
 *   - yaw, thrust, fire, weapon, mode, target, threats, lookahead,
 *     chipMode (kept consistent with the chip view)
 *   - state, score, energyVal, energyMax
 */
function createPanelsView(deps) {
  const {
    rootEl, getLastDecision, getActiveWeapon,
    getScore, getEnergy, getState,
  } = deps;

  // Cache of { name → element } — first read seeds; later reads use
  // the cache (no re-query per frame).
  let els = null;
  // Per-cell last-written string. setText() short-circuits when the
  // new value matches the cached one — this is the real throttle:
  // dropping a real change is worse than a few extra string compares
  // per frame (the brain sits in IDLE for many ticks, so we skip
  // ~95% of writes naturally; reason-mode changes that swap between
  // two strings many times per second still capture every flip).
  let lastWritten = null;

  function refreshEls() {
    const r = typeof rootEl === 'function' ? rootEl() : rootEl;
    if (!r || typeof r.querySelector !== 'function') return null;
    els = {
      decisionPanel: r.querySelector('[data-ai-debug-panel="decision"]'),
      statePanel: r.querySelector('[data-ai-debug-panel="state"]'),
      mode: r.querySelector('[data-ai-debug="mode"]'), // also used by chipView
      yaw: r.querySelector('[data-ai-debug="yaw"]'),
      thrust: r.querySelector('[data-ai-debug="thrust"]'),
      fire: r.querySelector('[data-ai-debug="fire"]'),
      weapon: r.querySelector('[data-ai-debug="weapon"]'),
      target: r.querySelector('[data-ai-debug="target"]'),
      threats: r.querySelector('[data-ai-debug="threats"]'),
      lookahead: r.querySelector('[data-ai-debug="lookahead"]'),
      reason: r.querySelector('[data-ai-debug="reason"]'),
      state: r.querySelector('[data-ai-debug="state"]'),
      score: r.querySelector('[data-ai-debug="score"]'),
      energyVal: r.querySelector('[data-ai-debug="energyVal"]'),
      energyMax: r.querySelector('[data-ai-debug="energyMax"]'),
      energyBar: r.querySelector('[data-ai-debug="energyBar"]'),
    };
    lastWritten = {};
    return els;
  }
  refreshEls();

  function setText(name, text) {
    if (!els) refreshEls();
    if (!els || !els[name]) return;
    if (typeof text !== 'string') text = String(text ?? '');
    // Per-cell skip-if-unchanged. Single string-compare per cell per
    // frame; cheaper than the global time-based throttle it replaced
    // AND guaranteed to never drop a real change.
    if (lastWritten && lastWritten[name] === text) return;
    if ('textContent' in els[name]) els[name].textContent = text;
    if (lastWritten) lastWritten[name] = text;
  }
  function setStyle(name, prop, value) {
    if (!els) refreshEls();
    if (!els || !els[name] || !els[name].style) return;
    els[name].style.setProperty(prop, value);
  }

  function updateDecision() {
    const dec = safeCall(getLastDecision);
    const weapon = safeCall(getActiveWeapon) || 'bullet';
    // Char-fill vs class-fill for mode is handled by createChipView;
    // the row in the decision panel just shows the same text.
    const mode = (dec && dec.mode) || 'idle';
    setText('mode', (MODE_CHIP_LABELS[mode] || mode.toUpperCase()));
    setText('yaw', formatYawCommand(dec ? dec.yaw || 0 : 0));
    setText('thrust', formatBool(!!(dec && dec.thrust)));
    setText('fire', formatBool(!!(dec && dec.fire)));
    setText('weapon', weapon === 'laser' ? 'LASER' : 'BULLET');
    // Target: dot when chasing, '—' when idle.
    if (dec && dec.target && typeof dec.target.dist === 'number') {
      const tag = dec.target.mode === 'powerup' ? 'PU ' : 'AST ';
      setText('target', `${tag}${formatDistance(dec.target.dist)}`);
    } else {
      setText('target', '—');
    }
    const tc = (dec && typeof dec.threatsCount === 'number') ? dec.threatsCount : 0;
    const la = (dec && typeof dec.lookaheadThreats === 'number') ? dec.lookaheadThreats : 0;
    setText('threats', String(tc));
    setText('lookahead', String(la));
    // WHY row — short text explaining which threshold fired. This
    // is the one the user explicitly asked for ("damit ich sehe, was
    // die ai logik macht"). Behaviors return `decision.reason`
    // (see src/entities/ai.js) — empty fallback so missing values
    // do not show stale text.
    setText('reason', dec && dec.reason ? String(dec.reason) : '—');
    // Highlight weapon row when laser active (cyan→orange tint).
    const weaponEl = els?.weapon;
    if (weaponEl && weaponEl.classList) {
      weaponEl.classList.toggle('ai-debug__row__value--weapon-laser', weapon === 'laser');
    }
  }

  function updateState() {
    const state = safeCall(getState);
    setText('state', state ? String(state) : '—');
    const score = safeCall(getScore);
    setText('score', typeof score === 'number' ? String(Math.floor(score)) : '0');
    const energy = safeCall(getEnergy);
    if (energy && typeof energy.value === 'number' && typeof energy.max === 'number') {
      setText('energyVal', String(Math.round(energy.value)));
      setText('energyMax', String(Math.round(energy.max)));
      const pct = energy.max > 0 ? energy.value / energy.max : 0;
      setStyle('energyBar', '--energy-bar-progress', `${(pct * 100).toFixed(1)}%`);
    } else {
      setText('energyVal', '—');
      setText('energyMax', '—');
      setStyle('energyBar', '--energy-bar-progress', '0%');
    }
  }

  function update() {
    updateDecision();
    updateState();
  }

  function dispose() {
    els = null;
    lastWritten = null;
  }

  return { update, dispose };
}

// ===========================================================================
// Sub-view helpers
// ===========================================================================

/**
 * The radar view calls `facingAngle(yaw)` directly from ai.js to
 * resolve yaw → bearing-in-atan2-space. We re-derive it here instead
 * of importing from ai.js because the overlay is a UI module and
 * ai.js is a domain module — keeping the radar's bearing math local
 * avoids a cross-layer import. The math is identical to ship.js
 * convention (yaw=0 → facing -Z).
 */
function facingAngle(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}

/** Safe getter — a hook that throws or returns garbage shouldn't crash
 *  the radar's per-frame draw. Returns null on any exception. */
function safeCall(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const r = fn();
    return r == null ? null : r;
  } catch {
    return null;
  }
}

// ===========================================================================
// Composing factory: createAiDebugOverlay(deps) → { mount, update, dispose }
// ===========================================================================

/**
 * Build the AI Debug Overlay. Composes the Radar + Chip + Panels sub-
 * views into a single DOM root. Caller passes the host element via
 * `mount(rootEl)`; the factory injects the section structure under it.
 *
 * Removal: delete this file (and the import + call in main.js). The
 * HTML container is a no-op <div> when no factory is attached.
 *
 * @param {{
 *   getSubject: () => any,
 *   getAiShip?: () => any,
 *   getLastDecision?: () => any,
 *   getActiveWeapon?: () => string,
 *   getAsteroids?: () => Array<any>,
 *   getPowerupPos?: () => any,
 *   getScore?: () => number,
 *   getEnergy?: () => { value: number, max: number },
 *   getState?: () => string,
 *   displayMode?: 'radar' | 'compass' | 'off',
 *   worldRadius?: number,
 * }} deps
 * @returns {{ mount: (rootEl: HTMLElement) => void, update: () => void, dispose: () => void }}
 */
export function createAiDebugOverlay(deps = {}) {
  const {
    getSubject, getAiShip, getLastDecision, getActiveWeapon,
    getAsteroids, getPowerupPos,
    getScore, getEnergy, getState,
    displayMode = OVERLAY_CONFIG.displayMode,
    worldRadius = OVERLAY_CONFIG.worldRadius,
    getWorldRadius = null,
  } = deps;
  if (displayMode === 'off') {
    // Off mode: factory still exists (uniform API) but is a no-op.
    return { mount: () => {}, update: () => {}, dispose: () => {} };
  }
  if (typeof getSubject !== 'function') {
    throw new Error('createAiDebugOverlay: getSubject is required');
  }

  let rootEl = null;
  let radarCanvas = null;
  let rafHandle = null;
  let radarView = null;
  let compassView = null;
  let chipView = null;
  let panelsView = null;

  /**
   * v0.63.0 — current top-level display mode. Tracked in the factory
   * closure so the radar's `setRadarMode` is independent from the
   * top-level cycle. The toggle button cycles through three states:
   *   1. `radar-rotate`    → label "RADAR: ROTATE"     (default)
   *   2. `radar-north-up`  → label "RADAR: NORTH-UP"
   *   3. `compass`         → label "COMPASS"
   * Back to (1) on the fourth click. The radar view is instantiated
   * for ALL three states so switching back to a radar mode is a
   * single method call (`radarView.setRadarMode('rotate')`) — no
   * view re-creation.
   */
  let currentMode = displayMode === 'compass' ? 'compass' : 'radar-rotate';

  /** Cyclic label for the toggle button. */
  function labelForMode(mode) {
    switch (mode) {
      case 'compass':        return 'COMPASS';
      case 'radar-north-up': return 'RADAR: NORTH-UP';
      case 'radar-rotate':
      default:               return 'RADAR: ROTATE';
    }
  }

  /** What the next click of the toggle button does. */
  function nextMode(mode) {
    switch (mode) {
      case 'compass':        return 'radar-rotate';
      case 'radar-north-up': return 'compass';
      case 'radar-rotate':
      default:               return 'radar-north-up';
    }
  }

  function buildDom(rootElArg) {
    rootElArg.innerHTML = `
      <div class="ai-debug__title">AI DEBUG</div>
      <canvas class="ai-debug__radar" data-ai-debug="radarCanvas"></canvas>
      <button class="ai-debug__mode-toggle" type="button" data-ai-debug="radarModeToggle" title="Toggle radar orientation">RADAR: ROTATE</button>
      <div class="ai-debug__chip" data-ai-debug="mode" data-ai-debug-panel="">IDLE</div>
      <div class="ai-debug__panel" data-ai-debug-panel="decision">
        <div class="ai-debug__row"><span class="ai-debug__row__key">MODE</span><span class="ai-debug__row__value" data-ai-debug="mode">IDLE</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">YAW</span><span class="ai-debug__row__value" data-ai-debug="yaw">·</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">THRUST</span><span class="ai-debug__row__value" data-ai-debug="thrust">OFF</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">FIRE</span><span class="ai-debug__row__value" data-ai-debug="fire">OFF</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">WEAPON</span><span class="ai-debug__row__value" data-ai-debug="weapon">BULLET</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">TARGET</span><span class="ai-debug__row__value" data-ai-debug="target">—</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">THREATS</span><span class="ai-debug__row__value" data-ai-debug="threats">0</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">LOOKAHEAD</span><span class="ai-debug__row__value" data-ai-debug="lookahead">0</span></div>
        <div class="ai-debug__row ai-debug__row--why"><span class="ai-debug__row__key">WHY</span><span class="ai-debug__row__value" data-ai-debug="reason">—</span></div>
      </div>
      <div class="ai-debug__divider"></div>
      <div class="ai-debug__panel" data-ai-debug-panel="state">
        <div class="ai-debug__row"><span class="ai-debug__row__key">STATE</span><span class="ai-debug__row__value" data-ai-debug="state">—</span></div>
        <div class="ai-debug__row"><span class="ai-debug__row__key">SCORE</span><span class="ai-debug__row__value" data-ai-debug="score">0</span></div>
        <div class="ai-debug__row ai-debug__row--energy">
          <span class="ai-debug__row__key">ENERGY</span>
          <span class="ai-debug__row__value ai-debug__row__energy">
            <span class="ai-debug__row__energy-bar"><span class="ai-debug__row__energy-bar-fill" data-ai-debug="energyBar" style="--energy-bar-progress: 0%"></span></span>
            <span data-ai-debug="energyVal">—</span>/<span data-ai-debug="energyMax">—</span>
          </span>
        </div>
      </div>
    `;
    rootElArg.classList.add('ai-debug--mounted');
    if (displayMode === 'compass') {
      // Future mode: same DOM, but a flag class the CSS can read to
      // swap the radar canvas for a compass dial (added when built).
      rootElArg.classList.add('ai-debug--compass');
    }
  }

  function mount(rootElArg) {
    if (!rootElArg) throw new Error('createAiDebugOverlay.mount: rootEl is required');
    rootEl = rootElArg;
    buildDom(rootEl);
    radarCanvas = rootEl.querySelector('canvas.ai-debug__radar');
    // v0.63.0: instantiate BOTH views. The unused one's `draw()` is
    // never called by `update()` (which dispatches on `currentMode`).
    // Memory cost: ~1KB for the unused view. Avoids the cost of
    // re-instantiating on every toggle click.
    radarView = createRadarView({
      canvas: radarCanvas,
      getSubject, getAiShip, getAsteroids, getPowerupPos,
      getLastDecision, getActiveWeapon, worldRadius, getWorldRadius,
    });
    compassView = createCompassView({
      canvas: radarCanvas,
      getSubject, getAsteroids, getPowerupPos,
      getLastDecision, getActiveWeapon,
    });
    const modeBtn = rootEl.querySelector('[data-ai-debug="radarModeToggle"]');
    if (modeBtn && typeof modeBtn.addEventListener === 'function') {
      // v0.63.0 — set initial button text from currentMode so the
      // label is correct IMMEDIATELY after mount (no flicker between
      // mount and first update call).
      modeBtn.textContent = labelForMode(currentMode);
      modeBtn.addEventListener('click', () => {
        const m = nextMode(currentMode);
        currentMode = m;
        // When entering the compass branch, reset the radar mode so
        // when the user cycles back, the radar re-appears in its
        // canonical 'rotate' state (matches v0.23.x default).
        if (m === 'compass') {
          if (radarView && radarView.setRadarMode) radarView.setRadarMode('rotate');
        } else if (radarView && radarView.setRadarMode) {
          radarView.setRadarMode(m === 'radar-north-up' ? 'north-up' : 'rotate');
        }
        modeBtn.textContent = labelForMode(m);
        // Sync the label AND the CSS class so the CSS can adapt the
        // toggle-button styling for compass vs radar states if it
        // wants to.
        if (rootEl && rootEl.classList && typeof rootEl.classList.toggle === 'function') {
          rootEl.classList.toggle('ai-debug--compass', m === 'compass');
        }
      });
    }
    chipView = createChipView({ rootEl: () => rootEl, getLastDecision });
    panelsView = createPanelsView({
      rootEl: () => rootEl,
      getLastDecision, getActiveWeapon, getScore, getEnergy, getState,
    });
  }

  /** Draw the radar at every call (cheap); write the panels at most
   *  once per `panelUpdateIntervalMs`. */
  function update() {
    if (!rootEl) return;
    // v0.63.0: dispatch the canvas draw to the right subview based
    // on the top-level `currentMode`. Both views are alive; only
    // the active one draws. Cost is the same as v0.23.x (one Canvas2D
    // clear + draw per frame).
    if (currentMode === 'compass' && compassView) {
      compassView.draw();
    } else if (radarView) {
      radarView.draw();
    }
    // Sync the toggle button label (in case the mode was changed
    // programmatically or on first mount).
    const modeBtn = rootEl.querySelector('[data-ai-debug="radarModeToggle"]');
    if (modeBtn) {
      modeBtn.textContent = labelForMode(currentMode);
    }
    // Panels: write on every tick. setText() does per-cell skip-if-
    // unchanged internally (one string-compare per cell) so
    // duplicate writes are essentially free, while real changes
    // (the WHY row toggling between two reasons many times per
    // second) ALWAYS land on the very next update. The previous
    // 80 ms global throttle could swallow back-to-back test updates
    // AND user-visible flips; per-cell caching is strictly better.
    if (chipView) chipView.update();
    if (panelsView) panelsView.update();
  }

  function dispose() {
    if (rafHandle != null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafHandle);
      }
      rafHandle = null;
    }
    if (radarView) radarView.dispose();
    if (compassView) compassView.dispose();
    if (chipView) chipView.dispose();
    if (panelsView) panelsView.dispose();
    rootEl = null;
    radarCanvas = null;
    radarView = null;
    compassView = null;
    chipView = null;
    panelsView = null;
  }

  return { mount, update, dispose };
}
