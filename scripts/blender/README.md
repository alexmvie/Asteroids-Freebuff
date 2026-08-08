# Blender Asteroid Pipeline (`scripts/blender/`)

Branch: `blender-asteroid-pipeline`. Goal: model asteroids in Blender, bake
real PBR maps (albedo / normal / roughness / AO) with Cycles, export GLB, and
use the results in the game — replacing or augmenting the current fully
procedural `src/entities/asteroid.js` path.

## Status

| Step | State |
|---|---|
| Blender 5.2.0 LTS install (Homebrew cask) | ✅ `brew install --cask blender` (headless verified: `blender --background --python-expr "import bpy"`) |
| POC: model → displace → UV → bake → GLB | ✅ `generate_asteroid.py` (run it, see below) |
| Game wiring (GLB as showcase entry / field variant) | ✅ v0.73.2: `public/models/asteroid-42.glb` committed; showcase entry index 5 ("Asteroid · Blender Baked (Cycles)"), lazy GLTFLoader + shadow tags + turntable. Browser-verified. |
| Quality loop (render → compare vs NASA/AAA → refine) | ⏳ next (reuse `scripts/showcase-capture.mjs` + the A/B measurement pattern from SSAO) |

## Blender-MCP — honest feasibility assessment (2026-08-08)

**Can I drive Blender via `blender-mcp` (ahujasid/blender-mcp)?**

- blender-mcp needs **three pieces**: (1) Blender running **with GUI** + the
  addon's socket server (port 9876) started via the "Connect to Claude" button,
  (2) the `uvx blender-mcp` server process, (3) an **MCP client** that registers
  the server (Claude Desktop / Cursor / VS Code / OpenCode).
- This environment has **no MCP client tool** — I cannot register a server, so
  the "LLM interactively clicks in Blender through MCP" flow is not available
  from here.
- **What IS available and strictly better for assets:** Blender headless
  (`blender --background --python script.py`). Deterministic, CI-style,
  reproducible, testable — the standard production path for procedural asset
  generation + Cycles baking. The modeling/baking result is identical to what
  MCP would produce, minus the GUI.
- **Hybrid option:** if you run Blender + the MCP addon on your machine with
  Claude Desktop (or another MCP client), you can drive it interactively
  yourself. The scripts in this folder are the artifact-oriented path; they
  don't depend on any MCP setup.
- **`bpy` via pip is NOT an option on macOS** (official wheels are Windows/Linux
  only). Install = Homebrew cask (done) or official dmg.

## Pipeline (what `generate_asteroid.py` proves)

1. **Model** — icosphere at the game's radius; radial displacement by a
   deterministic hash-noise (same math family as `src/entities/asteroid.js`,
   so per-`seed` asteroids stay reproducible).
2. **Features** — deterministic crater bowls (negative carve + rim) + boulder
   mounds (positive), placed from the seed — the Bennu/Ryugu surface
   hierarchy the game already uses.
3. **UV** — smart-project unwrap with margin.
4. **Bake** (Cycles, CPU, low samples for iteration speed) —
   `DIFFUSE` (albedo), `NORMAL` (tangent), `ROUGHNESS`, `AO` at 1024².
5. **Export** — GLB via `bpy.ops.export_scene.gltf` with embedded PNG maps.
   The game's `GLTFLoader` (already used by `ship.js` / `powerup.js`) can load it.

## Run

```bash
# from repo root (Blender is on PATH via brew)
blender --background --python scripts/blender/generate_asteroid.py -- \
  --seed 42 --radius 8 --detail 4 --out artifacts/blender

ls artifacts/blender
# -> asteroid-42.glb, asteroid-42-albedo.png, asteroid-42-normal.png,
#    asteroid-42-roughness.png, asteroid-42-ao.png
```

## Next steps

1. **Done (v0.73.2)** — `asteroid-42.glb` is wired into the showcase (lazy
   GLTFLoader in `src/systems/showcase.js`, shadow-tagged, turntable, index 5).
   To swap in a re-bake: overwrite `public/models/asteroid-42.glb` (keep the
   name — the regression test checks the magic bytes) and reload.
2. **Quality loop** — bake a batch (all 5 shape archetypes × several seeds),
   capture via `showcase-capture.mjs`, compare against NASA imagery + the
   current procedural field (use `measure-ssao-ab.py` style pixel metrics),
   iterate on displacement, crater scale, and bake samples/margin.
3. **Y-flip check** — Blender bakes tangent normals in its own convention; the
   glTF exporter usually flips on export, but verify against the current
   `normalScale` handling in `createAsteroidMaterial` when wired in.
