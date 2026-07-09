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

*Last updated: v0.37.2 — Powerup Coast-In + Video Analysis Pipeline (handsoff ready)*