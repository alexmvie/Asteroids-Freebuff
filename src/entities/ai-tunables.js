/**
 * AI tunables — the small set of knobs the AI Tuners panel can
 * adjust at runtime.
 *
 * v0.55.0 slim down. From 22 keys (v0.46–v0.49) to 9 keys. Everything
 * per-behavior (powerup cruise speed, braking envelope, final-approach
 * guard, sticky-time, size bias, laser heading gate, per-behavior
 * overrides) was collapsed into the universal `predict + steer`
 * controller and removed.
 *
 * Two exports:
 *
 *   - `AI_TUNABLE_DEFAULTS` — frozen object. The canonical defaults.
 *     Used by `resetAITunables()`, the tuner-panel RESET button, and
 *     tests that pin the canonical numbers.
 *
 *   - `AI_TUNABLES` — plain mutable bag, mirror copy of the defaults.
 *     Read by `src/entities/ai.js` every tick; written by
 *     `src/ui/ai-tuners-panel.js` on every slider event.
 *
 * Keys present here MUST be added to BOTH the frozen defaults AND
 * the live bag — otherwise `resetAITunables()` silently loses them
 * and the tuner panel shows no slider.
 *
 * Adding a new tunable: (1) add it here, (2) reference it through
 * `aiBrainTick` default-param destructure (e.g. `foo =
 * AI_TUNABLES.foo`), (3) add a slider in ai-tuners-panel.js.
 */

export const AI_TUNABLE_DEFAULTS = Object.freeze({
  // ------- Fire discipline -------
  /** Heading gate for firing (radians). Wider → looser aim. */
  fireHeadingGate: 0.4,
  /** Minimum fire distance (world units). Closer asteroids ignored. */
  fireMinDist: 20,
  /** Maximum fire distance (world units). Far asteroids ignored. */
  fireMaxDist: 200,
  /** Bullet speed (world units / s). Horizon for lead-fire prediction. */
  bulletSpeed: 400,

  // ------- Steer -------
  /** Heading gate for thrust (radians). Aligned → thrust ON. */
  thrustHeadingGate: 0.2,
  /** Yaw deadband (radians). Inside this band, AI commands no yaw. */
  yawDeadband: 0.10,

  // ------- Range -------
  /** Emergency evade distance (world units). nearestAst.dist < evadeDist → EVADE. */
  evadeDist: 10,
  /** Powerup chase radius (world units). Beyond → ignored. */
  powerupMaxChaseDist: 350,

  /**
   * Pirate aggression distance (world units). A pirate AI chases +
   * shoots any ship within this radius. `0` = pacifist (the pirate
   * behavior never fires — the demo AI default). The factory's
   * `options.aggroDist` overrides this per-AI; pirates typically pass
   * `300`. Tunable via the AI Live Tuners panel.
   */
  aggroDist: 0,

  // ------- Ship feel (owned here for the tuner surface) -------
  /** Ship max flight speed (XZ, u/s). */
  shipMaxSpeed: 200,

  // v0.62.0 — radar scope multiplier. The AI Debug Overlay's
  // radar (and compass) draw entities within
  // `radarBubbleMultiplier × (CHUNK_SIZE × BUBBLE_RADIUS_CHUNKS)`
  // = the streaming bubble × this number. 3× gives the user a
  // generous outer ring beyond the streamed chunks. Live-tunable
  // so the user can dial down to a "tight zoom" view (0.5× — see
  // only what's around the ship) or up to a "wide map" view
  // (8× — see threats coming from far away). Consumed by the
  // overlay's getWorldRadius() callback in main.js.
  radarBubbleMultiplier: 3,
});

const LIVE_TUNABLES = { ...AI_TUNABLE_DEFAULTS };

/**
 * Plain mutable bag. Mirrors `AI_TUNABLE_DEFAULTS` keys. Direct
 * assignment (`AI_TUNABLES.fireHeadingGate = 0.5`) is the contract —
 * see the file header for rationale.
 */
export const AI_TUNABLES = LIVE_TUNABLES;

/**
 * Restore every key to its frozen default. Mutates in place so
 * observers read fresh values on next tick.
 */
export function resetAITunables() {
  Object.assign(LIVE_TUNABLES, AI_TUNABLE_DEFAULTS);
}

/**
 * Snapshot the live tunable values as a JSON-safe plain object.
 * Used by the tuner panel's "COPY JSON" button.
 */
export function exportAITunables() {
  return { ...LIVE_TUNABLES };
}

/**
 * Apply a snapshot (e.g. from JSON paste) to the live tunables.
 * Unknown keys are dropped, non-numeric values are rejected.
 */
export function applyAITunables(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const key of Object.keys(AI_TUNABLE_DEFAULTS)) {
    const v = snapshot[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      LIVE_TUNABLES[key] = v;
    }
  }
}
