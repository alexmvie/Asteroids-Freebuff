## v0.49.0 -- AI Slider Live-Bag Wiring Cleanup + Ship Max-Speed Slider + Debug-HUD Layout Cleanup

**User request:** "i am not sure if the ai reacts on any of the sliders. i saw no difference in collecting extras or atacking asteroids. also the ship speed is not adjustable (max speed should also be adjustable i think)" / "the layout needs to be better . reduce debug infos - delete the AI BRAIN, AI ... section there"

### What changed

1. **Bug 1 fix: AI sliders react on next frame.** Simplified `brainArgsFromShip()` in `src/entities/ai.js` — dropped the verbose 19-line explicit `o.X ?? AI_TUNABLES.X` chain in favor of a clean `...opts` spread + delegation to `aiBrainTick`'s default-parameter destructuring. The live-bag fallback now has a single pathway (through `aiBrainTick`'s defaults) instead of two parallel ones. **Honest note:** the original wiring was already correct (call-time `AI_TUNABLES.X` evaluation made slider drags effective immediately). The refactor is readability cleanup, not a behavior change. The user's "no visible effect" was likely a perception issue (e.g., dragging `fireMinDist` 25→50 has no visible impact over a few seconds). 3 regression tests in `tests/ai.test.js` pin the live-bag flow-through contract with try/finally restore so the singleton doesn't leak.

2. **Bug 2 fix: Ship max-speed now live-tunable.** Added `shipMaxSpeed: 200` to `AI_TUNABLE_DEFAULTS`, added Ship group to `TUNER_GROUPS` + `shipMaxSpeed` spec to `TUNER_SPECS` (speedometer guide, range 50–400u/s, step 10), and wired `src/entities/ship.js` to read the live value per tick via `(AI_TUNABLES && Number.isFinite(AI_TUNABLES.shipMaxSpeed)) ? AI_TUNABLES.shipMaxSpeed : MAX_SPEED`. The frozen `MAX_SPEED` (200u/s) is the defensive fallback for missing or NaN values. 2 regression tests in `tests/ship.test.js` (cap clamps at live value, fallback works). **Known UX nit:** default 200 = `MAX_SPEED`, so the user has to drag away from center to feel the change.

3. **Layout cleanup.** Removed the AI Brain / Gen / Fitness / Mode section from `#debug-hud`. Files: `index.html` (dividers + 4 AI rows), `src/main.js` (deleted `AI_BRAIN_KIND` const + 4-line block in `debugHud.update()` call), `src/ui/debug-hud.js` (deleted 4 `setText` if-statements + 4 keys list entries + 4 JSDoc entries). Final layout: FPS/State/Score/Lives/Asteroids/Live-chunks/Verts/Tris | divider | Cam X/Y/Z | divider | Subject X/Y/Z | divider | Capture/Cap-Time/Cap-Mode | divider | buttons.

### Validation

- `npm test`: 561/561 green (was 556 at v0.48.0; +5 net: 3 ai + 2 ship).
- `npm run build`: clean.
- Test delta: +5 net vs v0.48.0's 556.

## v0.48.0 -- Visual Guides per Slider + Master Flag

**User request:** "i tried all sliders but see no feedback. can you add some visual guides also to see what i am controlling? be sure AL that stuff is optional and can be enabled and disabled by just one flag".

### What changed

1. **Inline SVG guides per slider** -- each of the 21 tunables now has a 56x36 SVG cell next to the slider that morphs live on drag. Five pattern categories, picked per spec via :
   -  -- angular gate (radians, half-angle wedge)
   -  -- radius (growing disc inside dashed max-ring)
   -  -- speed (half-arc dial with needle)
   -  -- generic scalar slider (horizontal fill)
   -  -- seconds (clock face with rotating hand)

2. **One master flag** --  at the top of . When :
   - Panel + debug overlay never instantiated
   -  +  HTML roots -d from the DOM at boot
   - Per-frame  is null-safe (early-exits if overlay is null)
   - Override path:  value checked at boot,  setter persists + warns if already mounted.

### Files touched

-  --  pure helper exporting 5 pattern renderers;  extracted from ;  +  called from  and reset paths.
-  --  default +  helper reading localStorage; gates the / creation blocks; HTML container  fallback when disabled;  runtime toggle with persistence + warn.
-  --  grid widened from 3 columns () to 4 (); appended v0.48.0 guide CSS rules for , , and clock/speedometer needle styling.
-  -- imported ; appended 12 tests covering cone/circle/speedometer/bar/clock patterns (happy + invariants), defensive clamps (NaN/Infinity/undefined/null), TUNER_GROUPS « TUNER_SPECS consistency tripwire, and an XSS-hygiene sanity check.

### Decisions

- **Inline SVGs over 3D world overlays.** The user said "see what i am controlling" — the control-panel feedback beat is what mattered. 3D world overlays (cone around ship, circles for evadeDist, etc.) become a followup if requested.
- **Five pattern types** cover all 21 tunables. The  enum is the per-spec picker; unknown patterns fall through to an empty placeholder SVG (no throw).
- **CSS  on ** reviewed and intentionally kept: bg/fg have genuinely different colors (cyan primary vs muted gray), so the property is harmless + useful for line-edge cleanliness on stroked paths.

### Stats

- 13 new tests; final tally: **556 / 556 pass** (+13 vs v0.47.0's 543).
- Vite build OK (no new warnings).

# AI Performance Protocol — LOG.md

> **Purpose:** Single source of truth for demo AI performance history,
> tuning decisions, and iteration protocol. Read before modifying AI.
>
> **Goal:** Collect ALL powerups, destroy ALL asteroids. Zero idle, zero missed pickups.

---

## Current State: v0.47.0 — AI Live Tuner Panel + "WHY" Debug Row

**Status:** ✅ 543 tests pass (was 493 at v0.46.1), build succeeds.

### Problem

User reported two persistent issues with the demo AI:
1. **"Die ahip ai ist noch immer sehr schlecht"** — even after v0.46.1 the AI wasn't performing as expected.
2. **"Der optimize loop ist nicht wie ich es wünsche"** — the Python tuning loop (`scripts/ai_tuning_loop.py`) ran 8 captures \u00d7 60 s = ~10 min per round and was a black box.

Visiblility + iteration speed were the missing pieces. The user wanted sliders in the browser.

### Architecture

#### 1. Live mutable SSOT (`src/entities/ai-tunables.js`)

Previously: `AI_TUNABLES = Object.freeze({ ... })`. The Python tuning loop had to write the file, git commit, and reload.

Now: **frozen defaults + mutable live bag**, side-by-side.
```
AI_TUNABLE_DEFAULTS = Object.freeze({ evadeDist: 10, ... });   // SSOT for values
AI_TUNABLES         = { ...AI_TUNABLE_DEFAULTS };               // mutable bag (live)
resetAITunables()   = Object.assign(AI_TUNABLES, AI_TUNABLE_DEFAULTS);
exportAITunables()  = JSON.stringify(AI_TUNABLES, null, 2);
```

`src/entities/ai.js` reads EVERY tunable via `opts.X ?? AI_TUNABLES.X` so a slider drag is visible on the very next brain tick. Factory overrides (used by tests) still take precedence — the `??` chain ensures test isolation isn't broken.

#### 2. Live Tuner Panel (`src/ui/ai-tuners-panel.js`)

New bottom-right panel above the AI debug overlay. 21 sliders in 6 groups:

| Group    | Sliders |
|----------|---------|
| Fire     | `fireHeadingGate`, `fireMinDist`, `fireMaxDist`, `bulletSpeed` |
| Thrust   | `thrustHeadingGate`, `yawDeadband` |
| Evade    | `evadeDist` |
| Powerup  | 10 tunables from `powerupMaxChaseDist` through `powerupFinalApproachSpeed` |
| Target   | `asteroidSizeBias`, `forwardConeHalfAngle`, `powerupNearBehindThreshold` |
| Laser    | `laserFireHeadingGate` |

Action bar: `RESET \u2192 DEFAULTS` (calls `resetAITunables()`) + `COPY JSON` (writes to clipboard + console.log).

#### 3. "WHY" debug row (`src/entities/ai.js` + `src/ui/ai-debug-overlay.js`)

Every behavior (evade, engage, collect, idle) now returns a `decision.reason` string explaining which threshold fired:

- EVADE: `nearest 5.0u < evadeDist 10.0u`
- COLLECT: `PU @ 23.4u, closing 18u/s, velErr 4.2u/s`
- ENGAGE (asteroid): `AST L @ 24.0u, closing 20.0u/s`
- IDLE: `idle (no asteroids in range)`

The AI debug overlay's modes chip + target row now include this row.

#### 4. Per-cell skip-if-unchanged in panels view (`src/ui/ai-debug-overlay.js`)

The `update()` function previously used a global 80ms throttle that could swallow back-to-back test updates and user-visible flips. Replaced with per-cell `lastWritten = {}` cache inside `setText()`: one string compare per cell per frame, never drops real changes. The brain sits in IDLE for many ticks, so ~95 % of writes auto-skip; mode changes that swap between two strings many times per second still capture every flip.

### Files changed

- `src/entities/ai-tunables.js` — mutable bag + frozen DEFAULTS + reset/export helpers.
- `src/entities/ai.js` — every tunable now reads via `opts.X ?? AI_TUNABLES.X`; every behavior returns a `reason` string.
- `src/ui/ai-tuners-panel.js` — **new**, 21 sliders + reset + copy-json buttons.
- `src/ui/ai-debug-overlay.js` — WHY row + per-cell skip; chip extension for evade mode.
- `src/main.js` — wires tuner panel mount, hooks `resetAITunables()` + `exportAITunables()` for the buttons.
- `index.html` — `#ai-tuners` container.
- `src/styles.css` — `.ai-tuners` BEM block (.ai-tuner__row, .ai-tuner__slider, .ai-tuner__value, action buttons, status).
- `tests/ai-tunables.test.js` — **new**, 17 tests for live mutability + reset + export.
- `tests/ai-tuners-panel.test.js` — **new**, 29 tests for pure helpers + factory smoke + setValue/reset/dispose.
- `tests/ai-debug-overlay.test.js` — extended with WHY row + per-cell update verification.
- `src/version-constants.js` — bumped to `v0.47.0`.

### What replaced the python loop

The Python tuning loop (`scripts/ai_tuning_loop.py`) is **not deleted** — it remains for batch searches over wide parameter ranges or unattended sweeps. The browser panel is now the primary tuning surface: 1 slider drag ≈ 1 frame of feedback. The loop can still produce candidate presets that the user copies back into `ai-tunables.js` as the new `AI_TUNABLE_DEFAULTS`.

### Validation

- 543 tests pass, 0 failures.
- Vite build succeeds (2.15 s, 207 KB gzipped main bundle).
- Browser: load `localhost:5173`, drag any slider, observe the AI debug overlay + the AI behavior change within one tick.

---

## Previous State: v0.46.1 — Powerup Intercept Controller + Edge-Case Tests

**Status:** ✅ 493 tests pass, build succeeds.

### v0.46.0 Changes

**Problem:** User reported that powerup approach was not fluid — the AI would orbit or fail to collect a nearby powerup despite knowing its velocity and trajectory.

**Root cause:** `collectBehavior` in `src/entities/ai.js` was position-only. It turned toward the powerup and thrust when aligned, but it did not account for the ship's existing velocity or the powerup's motion. When the ship circled a powerup, forward thrust acted as centripetal force and sustained the orbit.

**Fix:**
- Replaced the position-only controller with a **velocity-error intercept controller**.
- Predicts the powerup's future position using its current velocity and exponential drag (`POWERUP_PUSH_DRAG`).
- Computes a desired closing velocity bounded by the ship's braking envelope (`LINEAR_DRAG`).
- Steers toward the **velocity-error vector** (`desired - current velocity`), actively cancelling tangential orbit velocity.
- Added a final-approach guard to maintain minimum closing speed when very close, preventing the ship from stalling just outside the collection radius.
- Extracted all controller constants into `AI_TUNABLES` (`src/entities/ai-tunables.js`) so the tuning loop can adjust them:
  - `powerupCruiseSpeed`
  - `powerupMinApproachSpeed`
  - `powerupApproachGain`
  - `powerupBrakeSafetyFactor`
  - `powerupVelocityErrorThreshold`
  - `powerupFinalApproachDist`
  - `powerupFinalApproachSpeed`

**Files changed:**
- `src/entities/ai.js` — rewrote `collectBehavior` with velocity-error controller.
- `src/entities/ai-tunables.js` — added powerup controller tunables.
- `tests/ai.test.js` — updated existing tests, added tangential-velocity regression test.
- `src/version-constants.js` — bumped to `v0.46.0`.

**Validation:**
- 488 tests pass, build succeeds.
- Browser capture pending.

---

## Previous State: v0.38.1 — Predictive Evade Tuning (Lookahead 0.8s + Buffer 1.5u)

**Status:** ✅ 519 tests pass, build succeeds. Frame analysis showed 88% high-motion
(84% in v0.38.0) — the problem shifted: wider thrustHeadingGate (0.10→0.25) makes
the ship thrust more constantly, producing more motion regardless of evade behavior.

### v0.38.1 Changes

**Two tuning adjustments based on 13.5s frame analysis (81 frames @ 6fps):**

1. **`predictiveEvadeLookahead`**: 1.5→0.8s. Reduces collision detection corridor
   from 60-120u to ~40-64u at cruise speed. Combined with tighter buffer, eliminates
   grazing-pass false positives.

2. **`PREDICTIVE_EVADE_BUFFER`**: 3.0→1.5u. Tightens the collision margin so that
   only asteroids within 3.9u (small) to 8.9u (large) of the flight path trigger
   predictive evade. Old values (5.4u-10.4u) were too conservative in dense field.

### Key Finding from v0.38.0→v0.38.1

**The high motion isn't caused by predictive evade** — it's caused by the wider
`thrustHeadingGate: 0.25`. The ship now thrusts while slightly off-heading,
maintaining higher average speed and producing more camera motion. 88% high-motion
(up from 84%) confirms this: tighter evade parameters didn't reduce motion because
thrust gate is the real driver.

### Open Question

Should `thrustHeadingGate` be reduced (0.15-0.18) to reduce constant-thrust behavior?
A tighter gate means pure stop-turn-thrust: ship clears its turn, THEN accelerates.
Less motion, but slower engagement. Tradeoff depends on user preference.

### Architecture
- **5 levels (priority):** EVADE → PREDICTIVE EVADE (0.8s) → POWERUP → ASTEROID → IDLE
- **Engagement:** ship thrusts while turning (0.25 rad gate), fires up to 90u
- **Brake:** triggers at 30u with closingSpeed > 20, releases at speed < 10

---

## Iteration History

### v0.37.2 — Powerup Coast-In + Smarter Collection
- **engageTarget allowCoast:** separated from allowBrake so powerups coast without braking.
- **pickTarget powerupIsClose:** 18→25u.
- **pickTarget urgency:** `|| pDist < best.dist` for powerup-vs-asteroid priority.
- **Tests:** 114 pass (+1 new regression test for low-speed powerup approach).

### v0.36.0 — Stop-Turn-Thrust Pattern
- **thrustHeadingGate:** 0.50→0.10 rad. Turn without thrust, fly straight when aligned.
- **Score:** +5870/25s (2.6× improvement vs v0.35.0).
- **Tests:** 90 pass (was 89). Browser verified clean linear approaches.

### v0.35.0 — Brake Hysteresis Fix + Fire Cone Tuning
- **Brake hysteresis:** `closingSpeed → speed` based. Fixes powerup orbiting.
- **Fire range:** 120→60u. Fire cone: 0.25→0.30 rad.

### v0.34.3 — Early Aggressive Brake
- BRAKE_DIST 30→40, entry 35→25, exit 15→10, coastDist 50→40.

### v0.34.2 — Wider Cone (REVERTED)
- fireHeadingGate 0.25→0.35, evadeDist 8→6. Score dropped.

### v0.34.1 — Brake Hysteresis
- Entry 35, exit 15. evadeDist 12→8.

### v0.34.0 — Active Brake
- Flip 180° + thrust backward. Eliminated fly-through.

### v0.33.x — Powerup-Priority + Coast-In
- Absolute powerup priority, coast-in controller, adaptive fire cone.

---

## Tools & Automation

### Video Analysis Pipeline (v0.37.2)

Drei Scripts für automatisierte Game-Analyse ohne manuelles Eingreifen:

| Script | Beschreibung |
|--------|--------------|
| `scripts/ai_video_loop.py` | ffmpeg screen capture → GIF + summary.json (brightness, motion). macOS screen recording permission benötigt. |
| `scripts/ai_browser_capture.py` | Playwright headless browser capture → GIF + frames. `pip install playwright` benötigt. |
| `scripts/run-ai-loop.sh` | **Orchestrator**: Vite start → capture → stop → analyse. `--mode browser` funktioniert vollständig handsoff. |

**Bugfix (v0.37.2):** `ai_video_loop.py` captured nur 1 Frame (wiederholt) — ffmpeg schrieb alle Frames in dieselbe Datei `frame.png`. Gefixt: `-t seconds -vf fps=N` mit nummeriertem Output-Pattern `frame_%03d.png`. Zusätzlich: `shutil_which` → `shutil.which()`, `Image.fromarray()` für PIL last-resort, `import imageio` statt `.v2`.

**Test (Stand 2026-07):** 11/12 Frames pro Capture (90%-Threshold). GIF-Export funktioniert (MP4 via imageio hat TiffWriter-Warning, fällt auf GIF zurück).

---

## Previous State: v0.37.1

| Parameter | Default | Effect | Tune When... |
|-----------|---------|--------|--------------|
| `evadeDist` | 8 | Evasion trigger | Ship collides → increase; too passive → decrease |
| `interceptLookaheadS` | **2.0** | Intercept horizon v0.37.0 | Over-leads at distance → decrease |
| `predictiveEvadeLookahead` | **3.0** | Collision prediction horizon v0.37.0 | False dodges → decrease; missed collisions → increase |
| `predictiveEvadeMargin` | **12.0** | Collision margin v0.37.0 | Too twitchy → decrease; too late → increase |
| `bulletSpeed` | **400** | Bullet speed for lead fire v0.37.0 | Laser/hitscan → set to 0 |
| `powerupBiasU` | 9999 | Powerup priority | Misses powerups → increase |
| `thrustHeadingGate` | 0.10 | Align threshold | v0.36.0: tight stop-turn-thrust |
| `fireHeadingGate` | 0.30 | Fire cone width | Misses shots → increase; wastes ammo → decrease |
| `fireMinDist` | 0 | Min fire distance | Friendly fire → increase |
| `fireMaxDist` | 60 | Max fire distance | Wasted far shots → decrease |
| `coastDist` | 40 | Coast-in distance | Overshoots → increase; too slow → decrease |
| `BRAKE_DIST` | 40 | Brake trigger distance | Fly-through → decrease |
| `BRAKE_ENTER_SPEED` | 20 | Brake entry speed (closing) | Oscillation → increase; fly-through → decrease |
| `BRAKE_EXIT_SPEED` | 10 | Brake exit speed (absolute) | Oscillation → increase |
| `laserFireHeadingGate` | 0.20 | Laser cone | Laser misses → increase |

---

---

### v0.38.x — Particle System Overhaul (Smoke + Debris)

**Core rewrite of `src/systems/particles.js`** — performance optimization and visual overhaul:

**Performance (free-list + active-list, pool 2100→720):**
- `acquire()`: O(1) pop from `freeSmoke`/`freeDebris` arrays (was O(n) pool scan).
- `update()`: iterates only `active` array (live particles, ~50-200), not entire pool.
- Death path: O(1) via `p.poolIndex` (was O(n) `pool.indexOf(p)`).
- Pool size: 720 = (8 smoke + 40 debris) × 15 concurrent explosions (was 2100).

**Smoke texture (domain-warped FBM noise, 128×128):**
- Shape is NOISE-driven, not radial-gradient. 2-level domain warping (warpStrength 1.2).
- 4-octave FBM + cosine interpolation. Three noise layers blended (billow 40% + wisp 35% + fine detail 25%).
- Edge fade at `pow(dist, 6)` — barely affects shape, prevents hard canvas edges.
- Center boost removed entirely — shape is pure noise, not distance-weighted.

**Smoke dynamics:**
- Growth: `Math.pow(t, 0.3)` — explosive (at t=0.1 → 50% grown).
- Opacity: `Math.exp(-t * 5)` — rapid fade (at t=0.4 → ~0.14 alpha in texture).
- Base opacity: `0.09` per particle (8 puffs × 0.09 = visibly layered).
- Count: 8 puffs per explosion (was 30, better layering with fewer).
- Start size: 1.2u × scale. End size: 30× start (screen-filling).

**4 debris texture variants (Canvas2D procedural):**
| Variant | Shape | Color Base |
|---------|-------|-----------|
| 0 Angular Shard | Sharp polygon, 4-5 verts | Dark (0.45) |
| 1 Chunky Fragment | 7-9 rounder verts with curves | Medium (0.55) |
| 2 Elongated Splinter | Stretched Y-axis, 5-6 verts | Mid-dark (0.50) |
| 3 Porous Crumb | Noise-based with holes | Light (0.60) |

- Each variant gets unique color tint (r/g/b per variant).
- Pool cycles through variants deterministically (poolIndex / 2 % 4).
- Debris size: 0.4u × scale × (1-10x random) — visible chunks.
- Debris speed: 5→20 u/s (flies further, 4× increase).
- Spawn offset: `* 5.0` (smoke), `* 4.0` (debris) — wide scatter.

**Iteration history within v0.38.x (no intermediate commits):**
- Initial: warpStrength 0.6, center boost, radial gradient fallback
- Fixed: makeSmokeCanvas(64) → (128) — höhere Auflösung
- Fixed: variant 3 alpha 180 → 255 (volle Deckkraft für Porous Crumb)
- warpStrength 0.6→1.2 (doppelte Verzerrung), center boost entfernt
- Smoke offset: `* 0.6 → * 2.0 → * 5.0` (zunehmend versetzt)
- Debris offset: `* 0.3 → * 1.5 → * 4.0`
- Smoke opacity: `0.15 → 0.11 → 0.5` (final)
- Debris rotation: `Math.random() * Math.PI * 2` (nicht alle gleich)
- Debris stretch: `0.6-1.4` (bricht perfektes Quadrat)

**Tests:** 519 pass (particles tests + smoke texture + 4 debris variants + pool behavior).

### v0.40.0 — Collision Expansion + Visual Polish

**Debris visual polish:**
- `DEBRIS_SIZE_END_MULT: 0.1 → 1.0` — debris keeps constant size (no shrink).
- Size formula separated: smoke uses `pow(t, 0.3)` growth, debris uses constant `p.sizeStart`.
- Zufalls-Rotation: `material.rotation = random * 2π` — jedes Teil anders ausgerichtet.
- Nicht-uniforme Skalierung: `set(size * stretch, size / stretch)` — Fläche bleibt erhalten.

**Asteroid↔Asteroid collision — `findAsteroidPairs(asteroids) → [{i,j}]`:**
- O(n²) overlap detection (acceptable for ~300 asteroids, ~45K checks at <0.1ms).
- `resolveAsteroidCollision(a, b)`: mass-weighted elastic bounce with restitution 0.5.
  - `pushA = overlap × (massB / totalMass)` — massengewichtete Separation.
  - Velocity impulse along collision normal: `-(1 + e) × relVn / totalMass`.
  - Early-exit for already-separating pairs (relVn > 0) and degenerate cases (dist < 0.001).

**Asteroid↔Powerup collision:**
- `findAsteroidPowerupIndex({asteroids, powerup})` → first overlapping index or -1.
- `resolveAsteroidPowerupCollision(asteroid, powerup)`: push powerup out with 0.5u buffer.
  - Kick velocity: `8 + overlap × 3` (stronger for deeper overlaps).
  - `powerup.pushAway(vx, vz)`: accumulates kick velocity with exponential decay (drag=3.0).

**Ship-asteroid detection fix:**
- `SHIP_RADIUS: 1.4 → 2.0` — better matches the 3×-scaled ship mesh.
  - Ship body cone has radius 1.0 at base × 3 = ~3 units wide; 2.0 covers most of the body.
  - Previous 1.4 was too tight, causing visible overlaps without detection.

**New entity APIs:**
- `asteroid.setVelocity(vx, vz)` — mutates spec.velocity for elastic bounce.
- `powerup.pushAway(vx, vz)` — kick velocity with exponential decay in update().

**Integration:** wired into `main.js` `processCollisions()` — runs asteroid-asteroid + asteroid-powerup resolution **before** bullet/laser checks so settled positions don't affect destruction pass.

**Tests added:** 18 new collision tests (pair detection, separation, momentum transfer, large/small mass, powerup push). Total suite: **539 tests pass**, Vite build OK.

---

### v0.41.x — AI Powerup Collection Fix

**Problem:** The demo AI collected **0 of 2 powerups** in a 60s browser capture. It destroyed asteroids but ignored extras.

**Root cause:** `pickTarget` in `src/entities/ai.js` used an `asteroidIsUrgent` check (`best.dist < 35`) that blocked powerup selection whenever any asteroid was within 35u. In the dense streaming bubble (~300 asteroids) this was almost always true, so the AI never chased powerups unless it happened to wander within 25u of one.

**Fixes:**
- `DEFAULTS.powerupBiasU`: 25 → 9999 (absolute priority within chase range).
- `DEFAULTS.powerupMaxChaseDist`: 250u (covers the whole streaming bubble).
- `pickTarget` restructured: powerup priority evaluated against the **nearest asteroid**, not the committed target.
- Powerup approach: `allowBrake=true`, `brakeDist=60`, `coastDist=8` (early braking + tight creep-in).
- `main.js`: DEMO powerup lifetime 12s → 20s.

**Validation:**
- 543 tests pass, build succeeds.
- 60s browser capture: **3 of 4 powerups collected** (was 0 of 2).
- Metrics: 10 asteroids destroyed, score 830.

---

### v0.43.0 — AI Powerup Collection Final Fix

**Problem:** After v0.42.0 the AI still collected **0 of 1–2 powerups** in 60s browser captures. It destroyed asteroids and scored well, but ignored extras.

**Root causes & fixes (cumulative):**
1. **Collection radius too small** — `src/systems/powerup-system.js` only checked the powerup's own radius. Added `SHIP_RADIUS` so the effective pickup radius became ~6.5u.
2. **Powerup prediction wrong** — `src/entities/ai.js` extrapolated powerup velocity linearly up to 2s, but pushed powerups decelerate exponentially (`drag = 3.0`). Replaced with the exact remaining-distance bound `v0 / POWERUP_PUSH_DRAG`.
3. **Orbiting / overshoot** — custom `collectBehavior` speed-cap logic caused thrust-while-turning, making the ship curve past the powerup. Radically simplified `collectBehavior` to reuse `steerToward` with a tight `powerupThrustGate`.
4. **Speed control** — added distance-adaptive closing-speed control (`5–30 u/s`) so the ship approaches fast from far away but slows down before entering the pickup radius.
5. **Magic-number coupling removed** — exported `POWERUP_PUSH_DRAG` from `src/entities/powerup.js` and imported it in `src/entities/ai.js`.

**Validation:**
- 485 tests pass, build succeeds.
- 60s browser capture: **1 of 2 powerups collected** (was 0 of 2), 39 asteroids destroyed, score 2560.

**Remaining gap:** 50% collection rate. The second powerup was missed because the AI was still moving too fast or slightly off-center as it crossed the pickup radius. Further improvement options: tighten thrust gate further, add a final creep-in phase, or widen the pickup radius.

---

### v0.45.1 — AI Powerup Orbit Trap Fix

**Problem:** User reported a powerup in short distance that the AI ship could not collect: the ship was under constant acceleration, flying in a circle, and the distance to the powerup did not change. This is a classic orbital trap caused by the powerup collection controller.

**Root cause:** `collectBehavior` in `src/entities/ai.js` used `closingSpeed < desiredClosing` to decide whether to thrust. When the ship was circling a nearby powerup, its velocity was mostly tangential, so `closingSpeed` was near zero. The controller interpreted this as "too slow" and applied forward thrust, which acted as a centripetal force and sustained the orbit indefinitely.

**Fix:**
- Added an total-speed guard: `speed < desiredClosing * 1.5`.
- When the ship's total speed is much higher than the desired radial closing speed while the closing speed is low, the ship is clearly orbiting. Suspending thrust lets `LINEAR_DRAG` decay the tangential velocity, shrinking the turn radius and allowing the ship to spiral into the collection radius.

**Files changed:**
- `src/entities/ai.js` — `collectBehavior` now computes `speed = Math.hypot(aiVel.x, aiVel.z)` and gates `needMoreClosing` on `speed < desiredClosing * 1.5`.
- `tests/ai.test.js` — added regression test "collectBehavior: stops thrusting when orbiting a nearby powerup".

**Validation:**
- 487 tests pass, build succeeds.

*Last updated: v0.43.0 — AI Powerup Collection Final Fix (485 tests)*

---

### v0.44.0 — Automated AI Tuning + Video Analysis Pipeline

**Goal:** Give the user a repeatable, automated way to measure AI performance against a mathematical model and tune the AI toward that model.

**New files:**
- `src/systems/capture-markers.js` — high-contrast wireframe markers (green ship ring, red asteroid spheres, yellow powerup ring) for reliable video analysis.
- `src/entities/ai-tunables.js` — small SSOT module for AI constants the tuning loop can adjust without touching `ai.js`.
- `scripts/ai_tuning_loop.py` — automated tuning loop:
  - Runs a baseline browser capture.
  - Derives realistic targets from that baseline (capped by a theoretical model).
  - Uses random search + hill-climbing over `ai-tunables.js`.
  - Runs captures, analyzes frames, keeps the best parameter set.
  - Restores the original `ai-tunables.js` on Ctrl-C.
- `scripts/analyze_frames.py` — extended with optical marker detection (ship/asteroid/powerup counts + pixel coverage) using color thresholding and connected-component labeling.
- `scripts/ai_browser_capture.py` — injects `window._captureState` so the in-game debug HUD shows REC status, remaining time, and capture mode.
- `src/ui/debug-hud.js` + `index.html` — new Capture / Cap Time / Cap Mode rows in the debug HUD.
- `src/main.js` — wires capture markers, reads `window._captureState`, and updates the debug HUD capture fields.

**Mathematical model (targets):**
- Asteroids/min: 120 (theoretical ceiling ≈ 166; baseline + 30 % capped).
- Powerups/min: 8 (theoretical ceiling ≈ 10 from spawn delay + travel time).

**Validation:**
- 485 tests pass, build succeeds.
- 15s browser capture on `localhost:5175` successfully records frames, injects `_captureState`, and `analyze_frames.py` detects markers.

---

### v0.41.x+ — Frame Capture Fix

**Problem:** `scripts/analyze_frames.py` reported `motion=0.0` for all frames in AI video captures. Investigation showed the captured frames were entirely black (mean brightness 0, std 0).

**Root cause:** WebGL clears its drawing buffer after presentation by default. When Playwright asynchronously called `canvas.toDataURL('image/jpeg', 0.92)` from `page.evaluate()`, it read an already-cleared buffer.

**Fix:**
- `src/scene.js`: Added `preserveDrawingBuffer: true` to the `THREE.WebGLRenderer` constructor. This retains the buffer contents until the next explicit clear, so `toDataURL()` captures the rendered frame.
- `scripts/analyze_frames.py`: Added a clear warning when all frames are entirely black, pointing to the `preserveDrawingBuffer` setting.

**Validation:**
- 543 tests pass, build succeeds.
- 30s browser capture: mean brightness ~28.5, mean motion 5.4, 27% high-motion frames.


---

### v0.42.0 — AI Combat & Capture Stability Fixes

**Problem:** User reported "massive bugs with collision detection and targeting" plus powerup-collection arcs where the AI would fly toward a powerup, arc around it, and fail to collect it in one pass.

**Root causes & fixes:**
- `src/main.js`: `processCollisions()` used `dt` but was called without it, causing a `ReferenceError` that crashed the game loop on frame 1. This produced entirely black captures with score/activity at 0. Fixed by passing `dt` into `processCollisions(dt)`.
- `src/entities/ai.js`: Powerup targets had both braking AND coasting disabled, forcing continuous thrust. The ship overshot the pickup radius and orbited the powerup. Re-enabled coasting (`allowCoast: true`) for powerups so the ship glides into the pickup radius. Braking stays disabled so the ship does not flip away.
- `src/systems/collision.js`: Fast bullets (400 u/s) could tunnel through small asteroids between frames. Added swept-sphere collision in `findBulletHits` using a new `distSqToSegment2D` helper.
- `src/systems/collision.js` + `src/entities/ai.js`: Raised `SHIP_RADIUS` from 2.0/1.4 → 3.0 to match the 3×-scaled ship mesh, making AI evasion and collision checks consistent with the visual model.
- `scripts/ai_browser_capture.py`: Added Playwright `pageerror` and `console` listeners so JS runtime crashes are visible in capture logs instead of silently producing black/empty frames.

**Validation:**
- 544 tests pass, build succeeds.
- 60s browser capture: score 270, 4 asteroids destroyed, 2/3 powerups collected (was 0/0/0 before the fixes).


---

### v0.45.0 — AI Flight Maneuver Debug + Velocity-Aware Steering

**Problem:** User reported the demo AI's flight maneuvers were still "unbrauchbar" — the ship wobbled, circled, or thrust without purpose.

**Fixes:**
- **`src/entities/ai.js` — velocity-aware steering:**
  - `steerToward` now accepts `opts` with `desiredClosingSpeed` and `thrustGate`.
  - `engageBehavior` uses distance-adaptive approach speed: `desiredClosing = clamp(dist * 0.4, 5, 60)` u/s. Far targets get a sprint; close targets coast in.
  - `evadeBehavior` now reads the ship's closing velocity toward the threat. Moving toward the threat → turn retrograde and thrust away. Already moving away → thrust perpendicular to widen the gap.
  - Angular-velocity prediction (`predictedDiff = wrapAngle(targetDiff + angularVel * YAW_INERTIA_TAU)`) is reused in evade to avoid overshoot.

- **`src/systems/ai-flight-debug.js` — new 3D debug overlay:**
  - Green line = ship velocity vector.
  - Cyan line = ship forward heading.
  - Yellow cross = current chase target.
  - Magenta cross = lead-fire predicted intercept point.
  - Red ring = emergency evade radius.

- **`src/main.js` + `index.html` — wiring + toggle:**
  - Added `AI FLIGHT: ON/OFF` button to the debug HUD.
  - Exposed `window.AI_FLIGHT_DEBUG` getter/setter.
  - Wired `predictedPos` from the AI's `lastDecision` into the overlay.

- **Cleanup:**
  - Removed orphaned `collision-cage-debug` references and duplicate `captureMarkers` declaration.
  - Removed orphaned `debug-toggle-cage` button from `index.html`.

**Validation:**
- 486 tests pass, build succeeds.
