/**
 * Debug HUD — bottom-left overlay for development-time diagnostics.
 *
 * Shows real-time FPS (sampled over a 0.5s sliding window), the current
 * state-machine state, score, lives, asteroid count, live-chunk count
 * (from the streaming layer's `getActiveChunks` size), scene vertex +
 * triangle counts, and the live world positions of the camera and the
 * player ship.
 *
 * The DOM is provided by index.html. Each value cell has a
 * `data-debug="<name>"` attribute and a value `<span>`. We cache them
 * on first update so the per-frame work is just `el.textContent = ...`.
 *
 * Public API:
 *   - `hud.mount(rootEl)`   bind to a root element
 *   - `hud.update(snapshot)` call every frame (or at any rate) with a
 *                           snapshot of the current state
 *   - `hud.dispose()`       release the root reference
 *
 * Pure DOM — no Three.js, no framework. The snapshot is an arbitrary
 * object with the fields this HUD reads. Callers (typically the render
 * loop in `src/main.js`) are responsible for building it.
 *
 * @example
 *   const debugHud = createDebugHud();
 *   debugHud.mount(document.getElementById('debug-hud'));
 *   // ... in render loop:
 *   debugHud.update({
 *     fps: 60.0,
 *     state: 'PLAYING',
 *     score: 1234,
 *     lives: 3,
 *     asteroidCount: 27,
 *     liveChunks: 49,
 *     camera: { x: 0, y: 7, z: 22 },
 *     ship:   { x: 0, y: 0, z: 0 },
 *   });
 *
 * @param {object} [opts]
 * @param {number} [opts.fpsSampleWindowSeconds=0.5] sliding window for FPS
 * @param {number} [opts.minUpdateIntervalMs=80] throttle DOM writes (~12Hz)
 */
export function createDebugHud({
  fpsSampleWindowSeconds = 0.5,
  minUpdateIntervalMs = 80,
} = {}) {
  let rootEl = null;
  const els = {}; // name → element
  const sampleWindowMs = fpsSampleWindowSeconds * 1000;

  // ---- FPS sampling -----------------------------------------------------
  // We can't get a reliable FPS from `performance.now()` directly without
  // a sliding window, because the first frame is a long time after page
  // load. Track recent frame timestamps and count how many fall within
  // the last `sampleWindowMs` ms.
  const frameTimes = []; // sorted ascending; oldest first
  function pushFrame(nowMs) {
    frameTimes.push(nowMs);
    // Drop anything older than the window
    const cutoff = nowMs - sampleWindowMs;
    while (frameTimes.length > 0 && frameTimes[0] < cutoff) {
      frameTimes.shift();
    }
  }
  function computeFps() {
    if (frameTimes.length < 2) return 0;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    if (span <= 0) return 0;
    return ((frameTimes.length - 1) * 1000) / span;
  }

  // ---- Throttling -------------------------------------------------------
  // Throttle DOM writes to avoid layout thrash when the render loop runs
  // at 144Hz+. The throttling is per-cell, so high-frequency fields
  // (camera/ship positions) get updated as often as the throttle allows,
  // and low-frequency fields (state, score, lives) get updated whenever
  // they change OR the throttle fires — whichever is later.
  let lastWriteAt = 0;
  let pendingSnapshot = null;
  let rafHandle = null;

  // ---- Helpers ----------------------------------------------------------

  function findEl(name) {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return null;
    return rootEl.querySelector(`[data-debug="${name}"]`);
  }

  function fmtNum(n, digits = 2) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
    return n.toFixed(digits);
  }

  function setText(name, text) {
    const el = els[name];
    if (el && 'textContent' in el) el.textContent = text;
  }

  function writeSnapshot(s) {
    if (!s) return;
    if (typeof s.fps === 'number') {
      setText('fps', s.fps > 0 ? s.fps.toFixed(0) : '--');
    }
    if (typeof s.state === 'string') {
      setText('state', s.state);
    }
    if (typeof s.score === 'number') {
      setText('score', String(Math.floor(s.score)));
    }
    if (typeof s.lives === 'number') {
      setText('lives', String(Math.floor(s.lives)));
    }
    if (typeof s.asteroidCount === 'number') {
      setText('asteroids', String(Math.floor(s.asteroidCount)));
    }
    if (typeof s.liveChunks === 'number') {
      setText('liveChunks', String(Math.floor(s.liveChunks)));
    }
    if (typeof s.sceneVerts === 'number') {
      setText('sceneVerts', String(Math.floor(s.sceneVerts)));
    }
    if (typeof s.sceneTris === 'number') {
      setText('sceneTris', String(Math.floor(s.sceneTris)));
    }
    if (s.camera) {
      setText('camX', fmtNum(s.camera.x));
      setText('camY', fmtNum(s.camera.y));
      setText('camZ', fmtNum(s.camera.z));
    }
    if (s.ship) {
      setText('shipX', fmtNum(s.ship.x));
      setText('shipY', fmtNum(s.ship.y));
      setText('shipZ', fmtNum(s.ship.z));
    }
  }

  function scheduleWrite() {
    if (rafHandle != null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      const snap = pendingSnapshot;
      pendingSnapshot = null;
      if (snap) writeSnapshot(snap);
    });
  }

  // ---- Public API -------------------------------------------------------

  function mount(rootElArg) {
    if (!rootElArg) throw new Error('createDebugHud.mount: rootEl is required');
    rootEl = rootElArg;
    // Cache the value cells
    const names = [
      'fps', 'state', 'score', 'lives', 'asteroids',
      'liveChunks',
      'sceneVerts', 'sceneTris',
      'camX', 'camY', 'camZ',
      'shipX', 'shipY', 'shipZ',
    ];
    for (const n of names) els[n] = findEl(n);
  }

  /**
   * Submit a snapshot. The frame-time is always appended (FPS is a
   * running metric), but the DOM write is throttled.
   * @param {{
   *   fps?: number,
   *   state?: string,
   *   score?: number,
   *   lives?: number,
   *   asteroidCount?: number,
   *   liveChunks?: number,
   *   sceneVerts?: number,
   *   sceneTris?: number,
   *   camera?: { x: number, y: number, z: number },
   *   ship?: { x: number, y: number, z: number },
   * }} snapshot
   */
  function update(snapshot) {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    pushFrame(now);
    // Replace pending with the freshest snapshot (last writer wins)
    pendingSnapshot = {
      ...(pendingSnapshot || {}),
      ...(snapshot || {}),
      fps: computeFps(),
    };
    // Throttle DOM writes
    if (now - lastWriteAt >= minUpdateIntervalMs) {
      lastWriteAt = now;
      writeSnapshot(pendingSnapshot);
      pendingSnapshot = null;
    } else {
      scheduleWrite();
    }
  }

  function dispose() {
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    rootEl = null;
    for (const k of Object.keys(els)) delete els[k];
    frameTimes.length = 0;
    pendingSnapshot = null;
  }

  return { mount, update, dispose };
}
