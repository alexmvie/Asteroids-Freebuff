# AI Performance Protocol — LOG.md

> **Purpose:** Single source of truth for demo AI performance history,
> tuning decisions, and iteration protocol. Read before modifying AI.
>
> **Goal:** Collect ALL powerups, destroy ALL asteroids. Zero idle, zero missed pickups.

---

## Current State: v0.38.1 — Predictive Evade Tuning (Lookahead 0.8s + Buffer 1.5u)

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

*Last updated: v0.41.x — AI Powerup Collection Fix (543 tests)*
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

