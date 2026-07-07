# AI Performance Protocol — LOG.md

> **Purpose:** This file is the single source of truth for the demo AI's performance history,
> known issues, tuning decisions, and iteration protocol. Future agents MUST read this file
> before modifying the AI.
>
> **Goal:** The demo AI should efficiently collect ALL powerups and shoot ALL asteroids.
> "Efficiently" means: no wasted time, no missed pickups, no idle periods, clean attack runs.

---

## Current State: v0.33.x — Powerup-Priority + Coast-In Controller

**Status:** ✅ Implemented, awaiting validation

### Architecture
- **4 modes (priority order):** EVADE → POWERUP → ASTEROID → IDLE
- **Coast-in controller:** thrust when aligned AND either `dist >= coastDist` (60u) OR `closingSpeed <= 30 u/s`. Within 60u at high closing speed, engines cut and LINEAR_DRAG decelerates the ship naturally. Perpendicular or receding motion does NOT trigger coast-in. Prevents fly-through at high speed.
- **Powerup is ALWAYS priority:** `powerupBiasU: 9999` — if a powerup exists, the AI targets it unconditionally.
- **Wide fire cone:** `fireHeadingGate: 0.35` (20°) — fires during approach, not just when perfectly aligned.
- **No minimum fire distance:** `fireMinDist: 0` — shoots point-blank.
- **Wide thrust gate:** `thrustHeadingGate: 0.50` (28.6°) — thrusts during turns for faster repositioning.

### DEFAULTS
```javascript
const DEFAULTS = Object.freeze({
  resetDist: 220,
  spawnRadius: 30,
  spawnJitterY: 0,
  spawnYaw: 0,
  evadeDist: 12,           // wider evasion buffer (was 8)
  powerupBiasU: 9999,      // ALWAYS prioritize powerups (was 15)
  thrustHeadingGate: 0.50, // wider thrust gate (was 0.30)
  fireHeadingGate: 0.35,   // wider fire cone (was 0.10)
  fireMinDist: 0,          // shoot point-blank (was 8)
  fireMaxDist: 150,        // shoot further (was 120)
  fireConeHalfAngle: 0.35,
  laserFireHeadingGate: 0.20, // wider laser cone (was 0.05)
});
```

### Controller Logic (engageTarget)
```
face target → spin-brake prediction (YAW_INERTIA_TAU=0.2) → yaw command
thrust = aligned (|diff| < 0.50) AND NOT (dist < 60u AND closingSpeed > 30 u/s)
closingSpeed = dot(velocity, dirToTarget) — positive means closing, negative means receding
```
- Within 60u: engines OFF, LINEAR_DRAG decelerates naturally
- Beyond 60u: thrust when roughly aligned
- No complex speed management, no closing-speed throttle, no BRAKE branch

---

## Iteration History

### v0.30.x–v0.32.x: Fly-by Controller (PREDECESSOR)
- **Problems:**
  1. Powerup collection purely opportunistic (`powerupBiasU: 15`) — AI almost never detoured for powerups
  2. Always targeted nearest asteroid — no strategic ordering
  3. Fire cone too tight (0.10 rad = 5.7°) — missed many shots
  4. `fireMinDist: 8` — couldn't shoot point-blank targets
  5. Ship flew through pickup radius at high speed (no coast-in)
  6. IDLE mode passive — stopped when no asteroids in range
- **Root cause:** Over-simplification from v0.28.x/v0.29.x speed-management complexity

### v0.28.x–v0.29.x: Speed-Aware Controller (ABANDONED)
- **Problems:** Complex speed management (desiredClosing, isSteady, soft yaw guard) locked the ship into "turn without thrusting" — 84% of time in powerup mode, 0 collected, only 16u traveled in 45s
- **Lesson:** Speed management MUST be simple. Coast-in with fixed distance works; dynamic closing-speed targets don't.

### v0.20.x–v0.27.x: Various Rewrites (ABANDONED)
- Multiple rewrites addressing "besoffen bot" (drunk bot) symptoms
- Accumulated patches (BRAKE branch, lookahead dodge, target commitment, spin-brake prediction, distance-gated fire, tight thrust gate) paralyzed the AI
- **Lesson:** Simpler is better. Fewer modes, fewer parameters.

---

## Protocol for Future Agents

### Before Making Changes
1. Read this file in full
2. Read `src/entities/ai.js` and `tests/ai.test.js`
3. Run `npm test` to establish baseline
4. Understand the v0.28.x/v0.29.x lesson: DO NOT add complex speed management

### When Tuning Constants
- Change ONE constant at a time
- Run `npm test` after each change
- Record the change in this file's Iteration History
- Test in browser for at least 30 seconds of DEMO gameplay

### What "Efficient" Means (Success Criteria)
1. **Powerup collection:** AI picks up ≥90% of spawned powerups before they expire (12s in DEMO)
2. **Asteroid clearing:** Score increases steadily — no long idle periods
3. **No overshoot loops:** AI doesn't repeatedly fly past the same target
4. **Smooth movement:** No visible zigzag, no "drunk bot" wobble
5. **Fire discipline:** AI fires when targets are in range — not too much, not too little

### Key Metrics to Watch (via AI Debug Overlay)
- **Mode distribution:** Should be mostly `asteroid` or `powerup`, minimal `idle` or `evade`
- **Thrust percentage:** Should be >60% (ship is moving most of the time)
- **Fire percentage:** Should be >30% when asteroids are in range
- **Powerup pickup rate:** Track how many powerups spawn vs how many are collected

### Architecture Constraints
- Brain MUST be a pure function: `aiBrainTick(args) → {yaw, thrust, mode, fire}`
- Brain MUST be deterministic (no Math.random in brain logic)
- Brain MUST be testable (all helpers exported)
- DO NOT add more than 4 modes (EVADE/POWERUP/ASTEROID/IDLE)
- DO NOT add BRAKE branch, Spin-Brake sub-phase, or closing-speed throttle
- The ship's LINEAR_DRAG handles all deceleration — the brain just cuts engines

---

## Tuning Knobs (Quick Reference)

| Parameter | Default | Effect | Tune When... |
|-----------|---------|--------|--------------|
| `evadeDist` | 12 | Evasion trigger distance | Ship gets hit too often → increase |
| `powerupBiasU` | 9999 | Powerup priority over asteroids | AI misses powerups → increase (9999 = always) |
| `thrustHeadingGate` | 0.50 | How aligned before thrusting | Ship turns too slow → increase |
| `fireHeadingGate` | 0.35 | How aligned before firing | Misses shots → increase; wastes ammo → decrease |
| `fireMinDist` | 0 | Minimum fire distance | Friendly fire → increase |
| `fireMaxDist` | 150 | Maximum fire distance | Wasted far shots → decrease |
| `coastDist` | 60 | Coast-in distance | Overshoots targets → increase; too slow → decrease |
| `COAST_SPEED_THRESHOLD` | 30 | Closing speed (u/s) to trigger coast-in | Coast too often → increase; overshoots → decrease |
| `laserFireHeadingGate` | 0.20 | Laser lock-on cone | Laser misses → increase |

---

*Last updated: v0.33.x — Powerup-Priority + Coast-In Controller*
