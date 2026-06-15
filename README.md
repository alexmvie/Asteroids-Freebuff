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
| `npm test` | Unit tests for the data model (21 tests). |
| `npm run dump:field` | ASCII visualization of the world to the terminal. |
| `npm run dump:field:svg` | SVG visualization of the world (writes `field.svg`). |

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
