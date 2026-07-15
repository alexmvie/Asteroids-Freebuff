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
  } = deps;
  let radarMode = deps.radarMode || OVERLAY_CONFIG.radarMode;
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
      let { px, py, dist } = worldToRadar(p, sx, sz, worldRadius, halfSize);
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
      if (dist > worldRadius * 1.5) continue; // far enough to skip
      const color = colorForThreatDistance(dist, worldRadius);
      if (dist > worldRadius) {
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
      let { px, py, dist } = worldToRadar(pup, sx, sz, worldRadius, halfSize);
      if (radarMode === 'north-up') {
        const cos = Math.cos(subjectYaw);
        const sin = Math.sin(subjectYaw);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx;
        py = ry;
      }
      const clipped = dist > worldRadius
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
        dec.target.pos, sx, sz, worldRadius, halfSize,
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
      const finalPos = dist > worldRadius
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
  let chipView = null;
  let panelsView = null;

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
    radarView = createRadarView({
      canvas: radarCanvas,
      getSubject, getAiShip, getAsteroids, getPowerupPos,
      getLastDecision, getActiveWeapon, worldRadius,
    });
    const modeBtn = rootEl.querySelector('[data-ai-debug="radarModeToggle"]');
    if (modeBtn && typeof modeBtn.addEventListener === 'function') {
      modeBtn.addEventListener('click', () => {
        const next = radarView && radarView.getRadarMode
          ? (radarView.getRadarMode() === 'rotate' ? 'north-up' : 'rotate')
          : 'rotate';
        if (radarView) radarView.setRadarMode(next);
        modeBtn.textContent = `RADAR: ${next === 'north-up' ? 'NORTH-UP' : 'ROTATE'}`;
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
    // Radar: cheap Canvas2D redraw. Per frame is fine (<0.3ms at
    // ~300 asteroids on a 200x200 canvas).
    if (radarView) radarView.draw();
    // Sync the radar mode button label (in case the mode was changed
    // programmatically or on first mount).
    const modeBtn = rootEl.querySelector('[data-ai-debug="radarModeToggle"]');
    if (modeBtn && radarView && radarView.getRadarMode) {
      const mode = radarView.getRadarMode();
      modeBtn.textContent = `RADAR: ${mode === 'north-up' ? 'NORTH-UP' : 'ROTATE'}`;
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
    if (chipView) chipView.dispose();
    if (panelsView) panelsView.dispose();
    rootEl = null;
    radarCanvas = null;
    radarView = null;
    chipView = null;
    panelsView = null;
  }

  return { mount, update, dispose };
}
