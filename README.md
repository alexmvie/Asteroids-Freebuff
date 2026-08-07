# Asteroids → Elite

A 3D, open-space **Asteroids** MVP built with **Three.js + Vite + vanilla JS**. Designed from day one as the foundation for a future **Elite-style** game (hyperspace, stations, trading, AI ships).

The play area is **unbounded** — your ship flies through a procedurally-generated, chunked, deterministic asteroid field. There is no wrap-around, no "wave cleared." Just an endless field of asteroids and a ship.

## Quick Start

```bash
npm install
npm run dev
```

Then open http://localhost:5173/.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Production build into `dist/`. |
| `npm test` | Unit tests across all modules (539 tests). |
| `npm run dump:field` | ASCII visualization of the world to the terminal. |
| `npm run dump:field:svg` | SVG visualization of the world (writes `field.svg`).
| `python3 scripts/ai_video_loop.py --seconds 10 --fps 8` | ffmpeg screen capture → GIF + brightness/motion analysis (`artifacts/ai-video/`).
| `python3 scripts/ai_browser_capture.py --seconds 10 --fps 8` | Playwright canvas capture → GIF + frame sequence (`artifacts/ai-browser/`).
| `./scripts/run-ai-loop.sh --mode browser --seconds 15 --fps 6` | **Hands-off loop**: start Vite → capture → stop → analyze. Ein Befehl, kein manuelles Eingreifen.

## Video Analysis (hands-off)

Zwei Scripts für automatisierte Game-Analyse:

- **`scripts/ai_video_loop.py`** — ffmpeg captured den ganzen Bildschirm (benötigt macOS screen recording permission). Erzeugt GIF + `summary.json` mit Helligkeits-/Motion-Metriken.
- **`scripts/ai_browser_capture.py`** — Playwright captured das Canvas-Element direkt im headless Browser. Sauberer (nur das Game, kein Desktop-Chrome), aber erfordert `pip install playwright`.
- **`scripts/run-ai-loop.sh`** — Orchestrator: startet Vite, wartet, captured, stoppt Vite. Der `browser`-mode funktioniert vollständig ohne manuelles Eingreifen.

Typischer AI-Tuning-Loop:
```bash
./scripts/run-ai-loop.sh --mode browser --seconds 15 --fps 6
cat artifacts/ai-loop/summary.json
``` |

## Documentation

> **If you are an AI agent (or developer) taking over this project, read [`AGENTS.md`](AGENTS.md) first.** It contains the standing rules, current state, architecture, conventions, and the mandatory handoff protocol.

- **[AGENTS.md](AGENTS.md)** — AI-agent onboarding, standing rules, current state, architecture, conventions. *Read this first if you are continuing development.*
- **[SPEC.md](SPEC.md)** — Design spec for the chunked-world data model: constants, types, seed strategy, density function, chunk generation, streaming bubble, determinism guarantees, Elite hooks.

## Project Direction

- **MVP scope**: chunked asteroid field, ship, asteroids (splitting), shooting, score, lives, demo mode (AI plays with infinite lives), keyboard controls, game over.
- **Future scope**: 6DOF flight, hyperspace, stations, trading, AI ships, procedural galaxy — designed in as hooks (`World.systemSeed`, `setFlightMode`, `requestJump`, event bus) so they slot in without refactor.

## Current State

See **[AGENTS.md → Current State](AGENTS.md#-current-state)** for the live progress log and next steps.

## Tech Stack

- **Three.js** `^0.160.0`
- **Vite** `^5.0.0`
- Vanilla **ESM** JavaScript (no TypeScript)
- **JSDoc** for type hints (`src/world/types.js`)
- **node:test** for unit tests (built into Node 20+)
