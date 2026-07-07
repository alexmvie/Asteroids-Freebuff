# AI Performance Protocol — LOG.md

> **Purpose:** Single source of truth for demo AI performance history,
> tuning decisions, and iteration protocol. Read before modifying AI.
>
> **Goal:** Collect ALL powerups, destroy ALL asteroids. Zero idle, zero missed pickups.

---

## Current State: v0.34.3 — Early Aggressive Brake

**Status:** ✅ Validated — ~3.55 asteroids/sec, efficient powerup collection

### v0.34.3 Changes
- **BRAKE_DIST widened**: 30 → 40. Ship starts braking earlier, reducing fly-through.
- **BRAKE_ENTER_SPEED lowered**: 35 → 25. Brake fires at lower closing speeds.
- **BRAKE_EXIT_SPEED lowered**: 15 → 10. Ship commits to longer braking episodes.
- **coastDist tightened**: 50 → 40. More thrust = faster approach = more asteroids/min.

### v0.34.1 Changes
- **Brake hysteresis**: Entry 35 u/s, exit 15 u/s. Prevents yaw oscillation.
- **Evade distance**: 12 → 8u. Less evasion time, more attack time.
- **Factory brake state tracking**: `isBraking` tracked across ticks, reset on spawn.

### v0.34.0 Changes
- **Active brake branch**: Flip 180° + thrust backward when `dist < 30 && closingSpeed > 35`. LINEAR_DRAG=0.4 cannot decelerate 200→20 u/s alone (~450u needed).
- **Coast-in**: `coastDist` 15→50, threshold 30→5.
- **Fire range**: `fireMaxDist` 40→120.
- **Adaptive cone floor**: 0.06→0.12 rad.

### DEFAULTS
```javascript
const DEFAULTS = Object.freeze({
  resetDist: 220,
  spawnRadius: 30,
  spawnJitterY: 0,
  spawnYaw: 0,
  evadeDist: 8,            // v0.34.1: sweet spot (6 collides, 12 too passive)
  powerupBiasU: 9999,      // v0.34.0: absolute powerup priority
  thrustHeadingGate: 0.50, // wide for fast repositioning
  fireHeadingGate: 0.25,   // tight accuracy + adaptive widening at close range
  fireMinDist: 0,
  fireMaxDist: 120,
  hysteresisU: 8,          // target stickiness
  laserFireHeadingGate: 0.20,
  coastDist: 40,           // v0.34.3: tighter for more thrust
  brakeExitSpeed: 10,      // v0.34.3: longer braking
});
```

### Controller Logic (engageTarget)
```
face target → spin-brake prediction (YAW_INERTIA_TAU=0.2) → yaw command
if (wasBraking && closingSpeed > 10) || (dist < 40 && closingSpeed > 25)
  → BRAKE (flip 180°, thrust backward, braking=true)
else if dist < 40 && closingSpeed > 5 → COAST (thrust=false)
else if aligned (|diff| < 0.50) → THRUST
```

### Architecture
- **4 modes (priority):** EVADE (8u) → POWERUP → ASTEROID → IDLE
- **Coast-in:** thrust when aligned AND (dist >= 40 OR closingSpeed <= 5). Perpendicular motion doesn't trigger coast.
- **Active brake with hysteresis:** Entry 25 u/s, exit 10 u/s. Prevents oscillation.
- **Powerup always priority:** `powerupBiasU: 9999`.
- **Distance-adaptive fire cone:** `max(0.12, 0.25 * (1 - dist/180))`. Wide at close, tight at far.
- **No fire minimum:** `fireMinDist: 0` — shoots point-blank.

---

## Iteration History

### v0.34.2 — WIDER CONE (REVERTED)
- `fireHeadingGate: 0.25 → 0.35`, `evadeDist: 8 → 6`, adaptive min 0.12→0.18
- **Result:** Score DROPPED from ~2.8 to ~2.0 asteroids/sec. Wide cone caused excessive misses at medium range.
- **Lesson:** Tight cone + high fire rate beats wide cone + low accuracy.

### v0.34.1 — BRAKE HYSTERESIS
- Entry 35, exit 15. `evadeDist: 12 → 8`.
- **Result:** Reduced yaw oscillation, more attack time.

### v0.34.0 — ACTIVE BRAKE
- Flip 180° + thrust backward at high closing speed.
- **Result:** Eliminated fly-through on powerup approach.

### v0.33.x — POWERUP-PRIORITY + COAST-IN
- Absolute powerup priority, coast-in controller, adaptive fire cone.
- **Result:** Powerup collection fixed, but fly-through remained until v0.34.0 brake.

### v0.30.x–v0.32.x: Fly-by Controller
- **Problems:** No powerup collection, tight fire cone, always nearest target.

### v0.28.x–v0.29.x: Speed-Aware Controller (ABANDONED)
- Complex speed management paralyzed the ship.
- **Lesson:** Speed management must be simple.

---

## Protocol for Future Agents

1. Read this file + `src/entities/ai.js` + `tests/ai.test.js`
2. Change ONE constant at a time
3. Run `npm test` after each change
4. Test in browser for 30+ seconds of DEMO gameplay

### Success Criteria
1. **Powerup collection:** ≥90% of spawned powerups collected
2. **Asteroid clearing:** Score increases steadily, no idle periods
3. **No overshoot loops:** Doesn't repeatedly fly past targets
4. **Smooth movement:** No visible zigzag or wobble
5. **Fire discipline:** Fires when targets are in range

### Key Metrics (via AI Debug Overlay)
- **Mode:** Mostly `asteroid` or `powerup`, minimal `idle`/`evade`
- **Thrust:** >60% of time
- **Fire:** >30% when asteroids in range

### Architecture Constraints
- Brain MUST be pure + deterministic + testable
- Max 4 modes (EVADE/POWERUP/ASTEROID/IDLE)
- LINEAR_DRAG handles routine deceleration; active brake only supplements

---

## Tuning Knobs

| Parameter | Default | Effect | Tune When... |
|-----------|---------|--------|--------------|
| `evadeDist` | 8 | Evasion trigger | Ship collides → increase; too passive → decrease |
| `powerupBiasU` | 9999 | Powerup priority | Misses powerups → increase |
| `thrustHeadingGate` | 0.50 | Align threshold | Turns too slow → increase |
| `fireHeadingGate` | 0.25 | Fire cone width | Misses shots → increase; wastes ammo → decrease |
| `fireMinDist` | 0 | Min fire distance | Friendly fire → increase |
| `fireMaxDist` | 120 | Max fire distance | Wasted far shots → decrease |
| `coastDist` | 40 | Coast-in distance | Overshoots → increase; too slow → decrease |
| `BRAKE_DIST` | 40 | Brake trigger distance | Fly-through → decrease |
| `BRAKE_ENTER_SPEED` | 25 | Brake entry speed | Fly-through → decrease |
| `BRAKE_EXIT_SPEED` | 10 | Brake exit speed | Oscillation → increase |
| `laserFireHeadingGate` | 0.20 | Laser cone | Laser misses → increase |

---

*Last updated: v0.34.3 — Early Aggressive Brake*
